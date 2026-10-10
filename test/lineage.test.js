// 1.7.0 W6: links a Main declares between its tasks, and scope "mine". A new
// run or task_prompt may name parentTaskId (the task it follows up) and
// inputTaskIds (tasks whose results went into its prompt); the Gateway checks
// the declaring Main can see them (since 1.8.0 that is its own tasks and those
// on sessions nobody is recorded for), records them durably and never infers any.
// task_list filters on links and callers, and session list / task_list take an
// opt-in scope "mine". Several Mains share one root here, including an old
// Codex front door that sends no thread id. Every case drives an in-process fake
// worker on an injected clock.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isSameCaller, isTaskCreator } from "../src/attention.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { statePaths } from "../src/state-store.js";
import { requireTaskLinks, TaskStore } from "../src/task-store.js";
import { startDaemon, writeMockProviders } from "./helpers/daemon-harness.js";
import { EPOCH, finish, harness, start } from "./helpers/fake-worker.js";
import { writeFreshBase } from "./helpers/state-files.js";

const ROOT = "main-root";
const claudeCaller = { provider: "claude", sessionId: "claude-session-a", pid: 4242, instanceId: "mcp-a" };
const codexCaller = { provider: "codex", sessionId: "codex-thread-b", pid: 5151, instanceId: "mcp-b" };
// A Codex front door from before per-call thread ids: the process is all it can name.
const oldCodexCaller = { provider: "codex", sessionId: null, pid: 6161, instanceId: "mcp-c" };
const A = { rootId: ROOT, caller: claudeCaller };
const B = { rootId: ROOT, caller: codexCaller };
const C = { rootId: ROOT, caller: oldCodexCaller };
const LEGACY = { rootId: ROOT };
const OBSERVER = { rootId: ROOT, access: "observer" };
const OTHER_ROOT = { rootId: "main-other", caller: claudeCaller };
// The 1.7 publicTask shape of a task with a caller and no links.
const TASK_KEYS = [
  "caller", "createdAt", "lastUpdatedAt", "origin", "pollInterval", "sessionId", "status", "statusMessage", "taskId", "ttl", "turnId"
];

async function open(service, context = A) {
  const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, context);
  const session = service.requireSession(opened.sessionId);
  return { session, worker: session.client };
}

async function finished(service, { session, worker }, context, extra = {}) {
  const taskId = await start(service, session, context, extra);
  await finish(service, worker, taskId);
  return taskId;
}

async function rejectsWith(promise, code, check = () => {}) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    check(error);
    return true;
  });
}

const listIds = async (service, context, args) => (await service.call("task_list", args, context)).tasks.map((task) => task.taskId);
const sessionIds = async (service, context, args = {}) =>
  (await service.call("session", { action: "list", ...args }, context)).sessions.map((session) => session.sessionId);

test("the scope rule: the creator rule without the pass for unattributed records", () => {
  assert.equal(isSameCaller(claudeCaller, claudeCaller), true);
  assert.equal(isSameCaller(claudeCaller, codexCaller), false);
  assert.equal(isSameCaller(codexCaller, { ...codexCaller, sessionId: "codex-thread-c" }), false, "another thread");
  assert.equal(isSameCaller(oldCodexCaller, { ...oldCodexCaller, sessionId: "codex-thread-x" }), true, "instance fallback");
  assert.equal(isSameCaller(null, claudeCaller), false, "nobody's record is not mine");
  assert.equal(isTaskCreator(null, claudeCaller), true, "while anyone may still take it");
  assert.equal(isSameCaller(claudeCaller, null), false);
});

test("requireTaskLinks checks shape only and returns just the keys given", () => {
  assert.deepEqual(requireTaskLinks({}), {});
  assert.deepEqual(requireTaskLinks({ parentTaskId: null, inputTaskIds: undefined }), {});
  assert.deepEqual(requireTaskLinks({ parentTaskId: "task-1", inputTaskIds: ["task-2", "task-1"] }),
    { parentTaskId: "task-1", inputTaskIds: ["task-2", "task-1"] });
  const invalid = [
    { parentTaskId: "" }, { parentTaskId: "  " }, { parentTaskId: 7 }, { parentTaskId: "x".repeat(257) },
    { inputTaskIds: [] }, { inputTaskIds: "task-1" }, { inputTaskIds: [""] }, { inputTaskIds: [1] },
    { inputTaskIds: ["task-1", "task-1"] }, { inputTaskIds: Array.from({ length: 17 }, (_, index) => `task-${index}`) }
  ];
  for (const links of invalid) {
    assert.throws(() => requireTaskLinks(links), (error) => error.code === "INVALID_ARGUMENT", JSON.stringify(links));
  }
  assert.equal(requireTaskLinks({ inputTaskIds: Array.from({ length: 16 }, (_, index) => `task-${index}`) }).inputTaskIds.length, 16);
});

test("run, task_prompt and task_run record declared links; a task without them keeps its shape", async () => {
  const { service, clock } = harness();
  try {
    const main = await open(service, A);
    const first = await finished(service, main, A);
    clock.now += 1_000;
    const second = await finished(service, main, A);
    assert.deepEqual(Object.keys(await service.call("task_get", { taskId: second }, A)).sort(), TASK_KEYS);
    clock.now += 1_000;

    const followUp = await finished(service, main, A, { parentTaskId: first, inputTaskIds: [second, first] });
    const got = await service.call("task_get", { taskId: followUp }, A);
    assert.equal(got.parentTaskId, first);
    assert.deepEqual(got.inputTaskIds, [second, first], "as declared, order kept");
    assert.deepEqual(Object.keys(got).sort(), [...TASK_KEYS, "inputTaskIds", "parentTaskId"].sort());
    // Management reads the same links. Since 1.8.0 another Main reads nothing of A's.
    assert.equal((await service.call("task_get", { taskId: followUp }, LEGACY)).parentTaskId, first);
    await rejectsWith(service.call("task_get", { taskId: followUp }, B), "NOT_TASK_OWNER");
    clock.now += 1_000;

    // The Task-mode paths hand back the handle itself, links included.
    const prompted = await service.call("task_prompt", { sessionId: main.session.id, prompt: "go", parentTaskId: followUp }, A);
    assert.equal(prompted.origin, "prompt");
    assert.equal(prompted.parentTaskId, followUp);
    assert.equal(Object.hasOwn(prompted, "inputTaskIds"), false, "only the keys that were declared");
    await finish(service, main.worker, prompted.taskId);
    clock.now += 1_000;
    const taskRun = await service.call("task_run", { sessionId: main.session.id, prompt: "go", inputTaskIds: [prompted.taskId] }, A);
    assert.equal(taskRun.origin, "run");
    assert.deepEqual(taskRun.inputTaskIds, [prompted.taskId]);
    assert.equal(Object.hasOwn(taskRun, "parentTaskId"), false);
    await finish(service, main.worker, taskRun.taskId);

    // The terminal envelope a run delivers is not the task record: unchanged.
    const envelope = await service.call("run", { taskId: followUp }, A);
    assert.equal(Object.hasOwn(envelope, "parentTaskId"), false);
    assert.equal(Object.hasOwn(envelope, "inputTaskIds"), false);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("links must name tasks this root can see; a refused link starts nothing", async () => {
  const { service, clock } = harness();
  try {
    const main = await open(service, A);
    const mine = await finished(service, main, A);
    const other = await open(service, OTHER_ROOT);
    const foreign = await finished(service, other, OTHER_ROOT);
    clock.now += 1_000;
    const tasksBefore = service.taskStore.toPersistedRecords().length;
    const turnsBefore = main.worker.turns.length;

    await rejectsWith(start(service, main.session, A, { parentTaskId: "task-missing" }), "INVALID_ARGUMENT", (error) => {
      assert.deepEqual(error.details, { unknownTaskIds: ["task-missing"] });
      assert.match(error.message, /task-missing/);
    });
    // Every unknown id at once, another root's task among them, each named once.
    await rejectsWith(
      start(service, main.session, A, { parentTaskId: foreign, inputTaskIds: [mine, foreign, "task-missing"] }),
      "INVALID_ARGUMENT",
      (error) => assert.deepEqual(error.details, { unknownTaskIds: [foreign, "task-missing"] })
    );
    await rejectsWith(service.call("task_prompt", { sessionId: main.session.id, prompt: "go", inputTaskIds: [foreign] }, A),
      "INVALID_ARGUMENT", (error) => assert.deepEqual(error.details, { unknownTaskIds: [foreign] }));
    await rejectsWith(service.call("task_run", { sessionId: main.session.id, prompt: "go", parentTaskId: "task-missing" }, A),
      "INVALID_ARGUMENT");
    // Shape errors: too many, duplicates, empty, wrong type.
    const seventeen = Array.from({ length: 17 }, () => mine).map((id, index) => `${id}-${index}`);
    for (const links of [{ inputTaskIds: seventeen }, { inputTaskIds: [mine, mine] }, { inputTaskIds: [] }, { parentTaskId: 42 }]) {
      await rejectsWith(start(service, main.session, A, links), "INVALID_ARGUMENT");
    }
    // A plain prompt mints no task to carry links, and an attach starts nothing.
    await rejectsWith(service.call("prompt", { sessionId: main.session.id, prompt: "go", parentTaskId: mine }, A), "INVALID_ARGUMENT",
      (error) => assert.match(error.message, /agent_acp_run/));
    await rejectsWith(service.call("run", { taskId: mine, inputTaskIds: [mine] }, A), "INVALID_ARGUMENT");

    assert.equal(service.taskStore.toPersistedRecords().length, tasksBefore, "no handle was minted");
    assert.equal(main.worker.turns.length, turnsBefore, "the worker heard nothing");
    // Nothing stayed reserved: the session takes the next valid run.
    const valid = await finished(service, main, A, { parentTaskId: mine });
    assert.equal((await service.call("task_get", { taskId: valid }, A)).parentTaskId, mine);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("through the real front door, an explicit attach is refused start-only arguments instead of dropping them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-lin-fd-"));
  let daemon = null;
  let mcpClient = null;
  let rpc = null;
  try {
    const providers = await writeMockProviders(directory, { permissionPolicy: "read_only" });
    daemon = await startDaemon({ directory, env: providers });
    mcpClient = new Client({ name: "w16-lineage", version: "1.0.0" });
    await mcpClient.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
      stderr: "pipe",
      env: {
        ...process.env,
        ACP_GATEWAY_SOCKET: daemon.socketPath,
        ACP_GATEWAY_CONTROL_TOKEN: daemon.token,
        ACP_GATEWAY_ROOT_ID: daemon.rootId,
        ...providers
      }
    }));
    rpc = new GatewayRpcClient({
      socketPath: daemon.socketPath, token: daemon.token, rootId: daemon.rootId, statePath: daemon.statePath, autoStart: false
    });
    const run = (args) => mcpClient.callTool({ name: "agent_acp_run", arguments: args });
    const taskCount = async () => (await rpc.call("task_list", {}, 30_000)).tasks.length;

    const opened = await mcpClient.callTool({
      name: "agent_acp_session_open",
      arguments: { provider: "mock", cwd: directory, permissionPolicy: "read_only" }
    });
    const sessionId = opened.structuredContent.sessionId;
    const first = await run({ sessionId, prompt: "narrated-result", waitMs: 20_000 });
    assert.equal(first.isError, false);
    const firstId = first.structuredContent.taskId;

    // A linked start still records its links.
    const linked = await run({ sessionId, prompt: "narrated-result", parentTaskId: firstId, inputTaskIds: [firstId], waitMs: 20_000 });
    assert.equal(linked.isError, false);
    assert.equal(linked.structuredContent.result.text, "FINAL ANSWER");
    const linkedId = linked.structuredContent.taskId;
    const recorded = await rpc.call("task_get", { taskId: linkedId }, 30_000);
    assert.deepEqual([recorded.parentTaskId, recorded.inputTaskIds], [firstId, [firstId]]);

    // Links (and a prompt) on an attach reach the gateway, which refuses them
    // as it does over the socket. Nothing is started or relinked.
    const tasksBefore = await taskCount();
    for (const extra of [{ parentTaskId: firstId }, { inputTaskIds: [firstId] }, { prompt: "narrated-result" }]) {
      const refused = await run({ taskId: linkedId, ...extra });
      assert.equal(refused.isError, true, JSON.stringify(extra));
      assert.equal(refused.structuredContent.ok, false);
      assert.equal(refused.structuredContent.errorCode, "INVALID_ARGUMENT", JSON.stringify(extra));
      await assert.rejects(rpc.call("run", { taskId: linkedId, ...extra }, 30_000),
        (error) => error.code === "INVALID_ARGUMENT" && error.message === refused.structuredContent.error,
        "the same refusal the socket gives");
    }
    assert.equal(await taskCount(), tasksBefore, "nothing was started");
    assert.deepEqual(await rpc.call("task_get", { taskId: linkedId }, 30_000), recorded);

    // A plain attach is unchanged: the terminal envelope, as delivered by the start.
    const attached = await run({ taskId: linkedId });
    assert.equal(attached.isError, false);
    assert.deepEqual(attached.structuredContent, linked.structuredContent);
    assert.deepEqual((await run({ taskId: linkedId, waitMs: 0 })).structuredContent, linked.structuredContent);
  } finally {
    rpc?.close();
    await mcpClient?.close().catch(() => {});
    await daemon?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("an idempotent retry attaches only with the same links, in any input order", async () => {
  const { service, clock } = harness();
  try {
    const main = await open(service, A);
    const first = await finished(service, main, A);
    clock.now += 1_000;
    const second = await finished(service, main, A);
    clock.now += 1_000;
    const links = { parentTaskId: first, inputTaskIds: [first, second] };
    const run = await start(service, main.session, A, { idempotencyKey: "k-linked", ...links });
    const turns = main.worker.turns.length;

    const retried = await service.call("run", {
      sessionId: main.session.id, prompt: "go", waitMs: 0, idempotencyKey: "k-linked",
      parentTaskId: first, inputTaskIds: [second, first]
    }, A);
    assert.equal(retried.taskId, run, "same links attach");
    assert.equal(main.worker.turns.length, turns, "and prompt nothing");

    const conflicts = [{}, { parentTaskId: second, inputTaskIds: [first, second] }, { parentTaskId: first, inputTaskIds: [first] }];
    for (const other of conflicts) {
      await rejectsWith(start(service, main.session, A, { idempotencyKey: "k-linked", ...other }), "IDEMPOTENCY_CONFLICT",
        (error) => assert.equal(error.details.taskId, run));
    }
    // Naming the run its key already started is a self-reference, not an attach.
    await rejectsWith(start(service, main.session, A, { idempotencyKey: "k-linked", ...links, parentTaskId: run }),
      "INVALID_ARGUMENT", (error) => assert.match(error.message, /cannot reference itself/));
    assert.equal(main.worker.turns.length, turns);
    await finish(service, main.worker, run);
    clock.now += 1_000;

    // A run without links hashes exactly as before links existed (digests are durable)
    // and conflicts with a retry that adds some.
    const plain = await start(service, main.session, A, { idempotencyKey: "k-plain" });
    assert.equal(service.taskStore.find(plain).requestDigest,
      createHash("sha256").update(JSON.stringify({ prompt: "go", model: null })).digest("hex"));
    assert.equal((await start(service, main.session, A, { idempotencyKey: "k-plain" })), plain);
    await rejectsWith(start(service, main.session, A, { idempotencyKey: "k-plain", parentTaskId: first }), "IDEMPOTENCY_CONFLICT");
    await finish(service, main.worker, plain);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("task_list filters by parentTaskId, callerSessionId and callerInstanceId, combined and paged", async () => {
  const { service, clock } = harness();
  try {
    const a = await open(service, A);
    const b = await open(service, B);
    const c = await open(service, C);
    // Since 1.8.0 a Main links only tasks it can see, so the task every Main
    // follows up runs on a session nobody is recorded for (every Main's).
    const shared = await open(service, LEGACY);
    const tick = () => { clock.now += 1_000; };
    const a1 = await finished(service, shared, A); tick();
    const a2 = await finished(service, a, A, { parentTaskId: a1 }); tick();
    const b1 = await finished(service, b, B, { parentTaskId: a1 }); tick();
    const c1 = await finished(service, c, C, { inputTaskIds: [a1] }); tick();
    const l1 = await finished(service, a, LEGACY, { parentTaskId: a1 }); tick();

    // No arguments: the unpaged root-wide array, exactly as before, for
    // management; a front-door Main gets its own and nobody's, in the same shape.
    const all = await service.call("task_list", {}, LEGACY);
    assert.deepEqual(all.tasks.map((task) => task.taskId), [a1, a2, b1, c1, l1]);
    assert.equal(Object.hasOwn(all, "nextCursor"), false);
    const own = await service.call("task_list", {}, A);
    assert.deepEqual(own.tasks.map((task) => task.taskId), [a1, a2, l1]);
    assert.equal(Object.hasOwn(own, "nextCursor"), false, "isolation is not a filter: still unpaged");

    const byParent = await service.call("task_list", { parentTaskId: a1 }, LEGACY);
    assert.deepEqual(byParent.tasks.map((task) => task.taskId), [a2, b1, l1], "inputs are not children");
    assert.equal(byParent.nextCursor, null, "a filter answers paged");
    assert.deepEqual(await listIds(service, A, { parentTaskId: a1 }), [a2, l1], "B's child is B's");
    assert.deepEqual(await listIds(service, A, { callerSessionId: claudeCaller.sessionId }), [a1, a2]);
    assert.deepEqual(await listIds(service, LEGACY, { callerInstanceId: "mcp-c" }), [c1]);
    assert.deepEqual(await listIds(service, A, { callerInstanceId: "mcp-c" }), []);
    assert.deepEqual(await listIds(service, LEGACY, { callerInstanceId: "mcp-b", parentTaskId: a1 }), [b1]);
    assert.deepEqual(await listIds(service, LEGACY, { callerSessionId: claudeCaller.sessionId, callerInstanceId: "mcp-b" }), []);
    // An observer may filter by caller: it just cannot say "mine".
    assert.deepEqual(await listIds(service, OBSERVER, { callerSessionId: codexCaller.sessionId }), [b1]);
    assert.deepEqual(await listIds(service, OTHER_ROOT, { parentTaskId: a1 }), [], "root scoping still applies");

    // With status and the keyset cursor.
    const page1 = await service.call("task_list", { parentTaskId: a1, status: "completed", limit: 2 }, LEGACY);
    assert.deepEqual(page1.tasks.map((task) => task.taskId), [a2, b1]);
    const page2 = await service.call("task_list", { parentTaskId: a1, status: "completed", limit: 2, cursor: page1.nextCursor }, LEGACY);
    assert.deepEqual(page2.tasks.map((task) => task.taskId), [l1]);
    assert.equal(page2.nextCursor, null);
    // The same pages for a front-door Main skip what it may not see, and the
    // cursor stays exact.
    const ownPage = await service.call("task_list", { parentTaskId: a1, status: "completed", limit: 1 }, A);
    assert.deepEqual(ownPage.tasks.map((task) => task.taskId), [a2]);
    assert.deepEqual(await listIds(service, A, { parentTaskId: a1, status: "completed", limit: 1, cursor: ownPage.nextCursor }), [l1]);

    for (const bad of [{ parentTaskId: "" }, { callerSessionId: 7 }, { callerInstanceId: " " }]) {
      await rejectsWith(service.call("task_list", bad, A), "INVALID_ARGUMENT");
    }
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("scope mine lists the sessions and tasks the requester started, by session id or else instance id", async () => {
  const { service, clock } = harness();
  try {
    const a = await open(service, A);
    const b = await open(service, B);
    const c = await open(service, C);
    const legacy = await open(service, LEGACY);
    const tick = () => { clock.now += 1_000; };
    const a1 = await finished(service, a, A); tick();
    // A different Main may prompt in a session nobody is recorded for (since
    // 1.8.0 not in A's); the task is still B's.
    const b1 = await finished(service, legacy, B); tick();
    const c1 = await finished(service, c, C); tick();
    const l1 = await finished(service, legacy, LEGACY); tick();
    const b2 = await finished(service, b, B); tick();

    const everything = [a.session.id, b.session.id, c.session.id, legacy.session.id];
    assert.deepEqual(await sessionIds(service, LEGACY), everything, "the default list is unchanged for management");
    assert.deepEqual(await sessionIds(service, OBSERVER), everything);
    assert.deepEqual(await sessionIds(service, A), [a.session.id, legacy.session.id], "a Main's own and nobody's");
    assert.deepEqual(await sessionIds(service, A, { scope: "mine" }), [a.session.id]);
    assert.deepEqual(await sessionIds(service, B, { scope: "mine" }), [b.session.id]);
    assert.deepEqual(await sessionIds(service, C, { scope: "mine" }), [c.session.id]);
    // One Claude front door whose CLI switched sessions: the session id decides.
    const cleared = { rootId: ROOT, caller: { ...claudeCaller, sessionId: "claude-session-z" } };
    assert.deepEqual(await sessionIds(service, cleared, { scope: "mine" }), []);
    // A thread of the old Codex process: its records carry no thread, so the process decides.
    const thread = { rootId: ROOT, caller: { ...oldCodexCaller, sessionId: "codex-thread-x" } };
    assert.deepEqual(await sessionIds(service, thread, { scope: "mine" }), [c.session.id]);
    assert.deepEqual(await listIds(service, thread, { scope: "mine" }), [c1]);

    assert.deepEqual(await listIds(service, A, { scope: "mine" }), [a1], "never the unattributed task");
    assert.deepEqual(await listIds(service, B, { scope: "mine" }), [b1, b2]);
    assert.deepEqual(await listIds(service, B, { scope: "mine", status: "completed", limit: 1 }), [b1]);
    assert.deepEqual(await listIds(service, B, { scope: "mine", callerInstanceId: "mcp-a" }), []);
    assert.deepEqual((await service.call("task_list", {}, LEGACY)).tasks.map((task) => task.taskId), [a1, b1, c1, l1, b2]);
    // Without scope a Main also sees what runs on sessions nobody is recorded
    // for, B's task there included; scope mine is still only its own.
    assert.deepEqual((await service.call("task_list", {}, A)).tasks.map((task) => task.taskId), [a1, b1, l1]);

    // Nobody to match: refused, never an empty list that reads as "you have nothing".
    for (const context of [LEGACY, OBSERVER]) {
      await rejectsWith(service.call("session", { action: "list", scope: "mine" }, context), "INVALID_ARGUMENT",
        (error) => assert.match(error.message, /caller identity/));
      await rejectsWith(service.call("task_list", { scope: "mine" }, context), "INVALID_ARGUMENT");
    }
    await rejectsWith(service.call("session", { action: "list", scope: "all" }, A), "INVALID_ARGUMENT");
    await rejectsWith(service.call("task_list", { scope: "root" }, A), "INVALID_ARGUMENT");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("links, callers and scope mine survive a restart, from the snapshot and from the WAL alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-lineage-"));
  const statePath = join(directory, "state.json");
  const artifactRoot = join(directory, "artifacts");
  const paths = statePaths(statePath);
  let ids = null;
  let sessions = null;
  let wal = null;
  try {
    const before = harness({ statePath, artifactRoot });
    try {
      await before.service.init();
      const a = await open(before.service, A);
      const b = await open(before.service, B);
      // Nobody's session: B's task there is one A may see and link (1.8.0).
      const shared = await open(before.service, LEGACY);
      const root = await finished(before.service, a, A);
      before.clock.now += 1_000;
      const input = await finished(before.service, shared, B);
      before.clock.now += 1_000;
      const child = await finished(before.service, a, A, { parentTaskId: root, inputTaskIds: [input, root] });
      before.clock.now += 1_000;
      // Still running at the restart: comes back failed, links intact.
      const cut = await start(before.service, b.session, B, { parentTaskId: input });
      ids = { root, input, child, cut };
      sessions = { a: a.session.id, b: b.session.id };
      await before.service.flushPersist();
      wal = await readFile(paths.wal);
    } finally {
      await before.service.shutdown();
    }

    // The WAL alone: on the empty snapshot it goes on from.
    for (const source of ["snapshot", "wal"]) {
      if (source === "wal") {
        await writeFile(paths.wal, wal, { mode: 0o600 });
        await writeFreshBase(statePath, wal);
      }
      const after = harness({ statePath, artifactRoot });
      after.clock.now = EPOCH + 10_000;
      try {
        await after.service.init();
        const child = await after.service.call("task_get", { taskId: ids.child }, A);
        assert.equal(child.parentTaskId, ids.root, source);
        assert.deepEqual(child.inputTaskIds, [ids.input, ids.root], source);
        const cut = await after.service.call("task_get", { taskId: ids.cut }, B);
        assert.equal(cut.status, "failed", source);
        assert.equal(cut.parentTaskId, ids.input, source);
        const root = await after.service.call("task_get", { taskId: ids.root }, A);
        assert.equal(Object.hasOwn(root, "parentTaskId") || Object.hasOwn(root, "inputTaskIds"), false, source);
        assert.deepEqual(await listIds(after.service, A, { parentTaskId: ids.root }), [ids.child], source);
        assert.deepEqual(await listIds(after.service, B, { parentTaskId: ids.input }), [ids.cut], source);
        // Isolation comes back with the records: each Main's stay its own.
        assert.deepEqual(await listIds(after.service, A, { parentTaskId: ids.input }), [], source);
        await rejectsWith(after.service.call("task_get", { taskId: ids.child }, B), "NOT_TASK_OWNER");
        assert.deepEqual(await listIds(after.service, B, { scope: "mine" }), [ids.input, ids.cut], source);
        assert.deepEqual(await sessionIds(after.service, A, { scope: "mine" }), [sessions.a], source);
        assert.deepEqual(await sessionIds(after.service, B, { scope: "mine" }), [sessions.b], source);
      } finally {
        await after.service.shutdown();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a bad link read back from disk is dropped, never the handle", () => {
  const store = new TaskStore({ now: () => EPOCH });
  const createdAt = new Date(EPOCH).toISOString();
  const base = { sessionId: "s", ownerRootId: ROOT, status: "completed", createdAt, ttl: null };
  const summary = store.recover([
    { ...base, taskId: "task-a", parentTaskId: 42, inputTaskIds: ["task-x", "task-x", "", 3, "task-y"] },
    { ...base, taskId: "task-b", parentTaskId: "task-a", inputTaskIds: "task-a" }
  ]);
  assert.deepEqual(summary, { loaded: 2, restarted: 0, dropped: 0 });
  const [first, second] = store.toPersistedRecords();
  assert.equal(Object.hasOwn(first, "parentTaskId"), false);
  assert.deepEqual(first.inputTaskIds, ["task-x", "task-y"]);
  assert.equal(second.parentTaskId, "task-a");
  assert.equal(Object.hasOwn(second, "inputTaskIds"), false);
  // create() takes the same shapes the gateway checked, and nothing else.
  assert.throws(() => store.create({ sessionId: "s", ownerRootId: ROOT, links: { inputTaskIds: [] } }),
    (error) => error.code === "INVALID_ARGUMENT");
});
