// 1.9.0: a Main sleeps in agent_acp_wait instead of polling, and the Gateway
// wakes it by answering as soon as something needs it: a task it started
// finished, a Worker asks it something, or nothing is left to wait for; else a
// heartbeat after timeoutMs. While a wait of a front door blocks, management
// sees that Main as waiting_tasks (main_list, main_status). The first cases
// drive an in-process fake worker on an injected clock; the last ones a real
// daemon and the Control front door over stdio, as a host drives it.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, CreateTaskResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { isReadOnlyCall } from "../src/access.js";
import { withoutSessionMarkers } from "../src/caller.js";
import { WAIT_PROGRESS_MS, waitLimits, waitProgressMs } from "../src/front-door.js";
import { MAIN_STATUSES } from "../src/main-status.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { EPOCH, finish, harness, permission, start, until } from "./helpers/fake-worker.js";
import { startDaemon, writeMockProviders } from "./helpers/daemon-harness.js";

const FRONT_DOOR = fileURLToPath(new URL("../src/index.js", import.meta.url));
const ROOT = "main-root";
const iso = (ms) => new Date(ms).toISOString();
// Two Mains on one machine: same root, different callers.
const claudeCaller = { provider: "claude", sessionId: "claude-session-a", pid: 4242, instanceId: "mcp-a" };
const codexCaller = { provider: "codex", sessionId: "codex-thread-b", pid: 5151, instanceId: "mcp-b" };
const A = { rootId: ROOT, caller: claudeCaller };
const B = { rootId: ROOT, caller: codexCaller };
const MANAGEMENT = { rootId: ROOT };
const OBSERVER = { rootId: ROOT, access: "observer" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(service, context = A) {
  const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, context);
  const session = service.requireSession(opened.sessionId);
  return { session, worker: session.client };
}

const wait = (service, context, args = {}) => service.call("wait", args, context);
const seenAt = (service, taskId) => service.taskStore.find(taskId)?.seenAt ?? null;
const mainsOf = async (service, context) => (await service.call("main_list", {}, context)).mains;
// The Main this context speaks for, as main_list reads it.
const mainOf = async (service, context) => (await mainsOf(service, MANAGEMENT))
  .find((main) => main.caller.instanceId === context.caller.instanceId) ?? null;

test("nothing to wait for answers at once, and a finished task already delivered is nothing new", async () => {
  const { service } = harness();
  try {
    assert.deepEqual(await wait(service, A, { timeoutMs: 600_000 }), {
      ok: true, reason: "nothing_pending", tasks: [], counts: { finished: 0, needsInput: 0, working: 0 }, next: {}
    });
    const { session, worker } = await open(service);
    const taskId = await start(service, session, A);
    await finish(service, worker, taskId);
    await service.call("run", { taskId }, A);
    assert.ok(seenAt(service, taskId), "collected with run");
    assert.equal((await wait(service, A)).reason, "nothing_pending", "a delivered task is not watched");
    // Named, it is listed as it stands, and nothing is delivered again.
    const named = await wait(service, A, { taskIds: [taskId] });
    assert.equal(named.reason, "nothing_pending");
    assert.deepEqual(named.tasks, [{
      taskId, sessionId: session.id, provider: "claude", status: "completed", statusMessage: "end_turn"
    }]);
    assert.deepEqual(named.next, {});
    assert.equal(service.mains.list(ROOT).length, 0, "a wait that never blocked makes no Main waiting");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a finished task whose result never reached its Main answers at once, carries that result and is marked seen", async () => {
  const { service, clock } = harness();
  try {
    const { session, worker } = await open(service);
    const taskId = await start(service, session, A);
    await finish(service, worker, taskId);
    // Management reads deliver nothing to the Main, so this is the envelope
    // agent_acp_run {taskId} would hand A.
    const envelope = await service.call("task_result", { taskId }, MANAGEMENT);
    assert.equal(seenAt(service, taskId), null);
    clock.now += 1_000;
    const answer = await wait(service, A);
    assert.equal(answer.reason, "task_finished");
    assert.deepEqual(answer.tasks, [{
      taskId, sessionId: session.id, provider: "claude", status: "completed", statusMessage: "end_turn", outcome: envelope
    }]);
    assert.deepEqual(answer.counts, { finished: 1, needsInput: 0, working: 0 });
    assert.deepEqual(answer.next, {}, "nothing left: no collect, no answer, no wait");
    assert.equal(seenAt(service, taskId), iso(EPOCH + 1_000));
    assert.equal((await service.call("inbox", { action: "attention" }, A)).counts.updates, 0);
    assert.equal((await wait(service, A)).reason, "nothing_pending", "delivered once");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a blocked wait wakes when a watched task finishes, and its Main is waiting_tasks meanwhile", async () => {
  const { service, clock } = harness();
  try {
    const { session, worker } = await open(service);
    const taskId = await start(service, session, A);
    const events = [];
    service.subscribe({}, MANAGEMENT, (event) => events.push(event));
    clock.now += 1_000;
    const waiting = wait(service, A, { timeoutMs: 600_000 });
    await until(() => service.mains.list(ROOT).length === 1, "the Main to be waiting");
    assert.deepEqual(await mainOf(service, A), {
      caller: claudeCaller, status: "waiting_tasks", since: iso(EPOCH + 1_000), taskIds: [taskId], count: 1, revision: 1
    });
    clock.now += 1_000;
    await finish(service, worker, taskId);
    const answer = await waiting;
    assert.equal(answer.reason, "task_finished");
    assert.equal(answer.tasks[0].taskId, taskId);
    assert.equal(answer.tasks[0].outcome.status, "idle");
    assert.ok(seenAt(service, taskId));
    // Nothing else holds this Main (an embedded service has no connections).
    assert.deepEqual(events.filter((event) => event.type === "main_status").map((event) => [event.status, event.revision]), [
      ["waiting_tasks", 1], ["gone", 2]
    ]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a permission request or a question for the Main wakes it with the request and how to answer it", async () => {
  const { service } = harness();
  try {
    const { session, worker } = await open(service);
    const taskId = await start(service, session, A);
    const asked = wait(service, A);
    await until(() => service.mains.list(ROOT).length === 1, "the wait to block");
    permission(worker, session, 7);
    const answer = await asked;
    assert.equal(answer.reason, "needs_input");
    const [row] = answer.tasks;
    assert.equal(row.status, "input_required");
    assert.equal(row.pending.type, "permission_request");
    assert.equal(row.pending.requestId, 7);
    assert.deepEqual(answer.next, {
      answer: [{ tool: "agent_acp_permission", arguments: { sessionId: session.id, requestId: 7 } }],
      wait: { tool: "agent_acp_wait", arguments: {} }
    });
    // Still pending: the next wait answers at once.
    assert.equal((await wait(service, A)).reason, "needs_input");
    await service.call("permission", { sessionId: session.id, requestId: 7, optionId: "allow-once" }, A);

    const questioned = wait(service, A);
    await until(() => service.mains.list(ROOT).length === 1, "the wait to block again");
    worker.emit(session.acpSessionId, {
      sessionUpdate: "elicitation_request", requestId: "q-1", mode: "form", message: "Which?", requestedSchema: { type: "object" }
    });
    const question = await questioned;
    assert.equal(question.reason, "needs_input");
    assert.equal(question.tasks[0].pending.type, "worker_question");
    assert.deepEqual(question.next.answer, [{ tool: "agent_acp_answer", arguments: { sessionId: session.id, requestId: "q-1" } }]);
    assert.equal(seenAt(service, taskId), null, "nothing was delivered");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a heartbeat after timeoutMs lists what still runs and delivers nothing", async () => {
  const { service } = harness();
  try {
    const { session } = await open(service);
    const taskId = await start(service, session, A);
    const startedAt = performance.now();
    const answer = await wait(service, A, { timeoutMs: 80 });
    assert.ok(performance.now() - startedAt >= 75, "it slept for timeoutMs");
    assert.deepEqual(answer, {
      ok: true,
      reason: "heartbeat",
      tasks: [{ taskId, sessionId: session.id, provider: "claude", status: "working", statusMessage: "Prompt running" }],
      counts: { finished: 0, needsInput: 0, working: 1 },
      next: { wait: { tool: "agent_acp_wait", arguments: {} } }
    });
    // timeoutMs 0 looks and answers.
    assert.equal((await wait(service, A, { timeoutMs: 0 })).reason, "heartbeat");
    for (const timeoutMs of [-1, 1.5, "soon"]) {
      await assert.rejects(wait(service, A, { timeoutMs }), { code: "INVALID_ARGUMENT" });
    }
    assert.equal(service.mains.list(ROOT).length, 0, "the Main left waiting_tasks with the wait");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("taskIds narrows the wait to those tasks, each one checked as task_get checks it", async () => {
  const { service } = harness();
  try {
    const first = await open(service);
    const second = await open(service);
    const one = await start(service, first.session, A);
    const two = await start(service, second.session, A);
    const named = wait(service, A, { taskIds: [two] });
    await until(() => service.mains.list(ROOT).length === 1, "the named wait to block");
    assert.deepEqual((await mainOf(service, A)).taskIds, [two]);
    // The first task's turn is the older of the two on the one fake worker.
    first.worker.turns[0].resolve({ stopReason: "end_turn" });
    await until(() => service.taskStore.find(one)?.status === "completed", "the unwatched task to finish");
    await pause(20);
    assert.equal((await mainOf(service, A))?.status, "waiting_tasks", "an unwatched task does not wake it");
    second.worker.turns[1].resolve({ stopReason: "end_turn" });
    const answer = await named;
    assert.equal(answer.reason, "task_finished");
    assert.deepEqual(answer.tasks.map((row) => row.taskId), [two]);
    assert.ok(seenAt(service, two));
    assert.equal(seenAt(service, one), null, "only what it watched was delivered");
    // The default wait still has the other one to deliver.
    assert.deepEqual((await wait(service, A)).tasks.map((row) => row.taskId), [one]);

    // A named wait points the next wait at the tasks still running.
    const third = await start(service, first.session, A);
    const fourth = await start(service, second.session, A);
    const heartbeat = await wait(service, A, { taskIds: [third, fourth, two], timeoutMs: 10 });
    assert.deepEqual(heartbeat.tasks.map((row) => [row.taskId, row.status]), [
      [third, "working"], [fourth, "working"], [two, "completed"]
    ]);
    assert.deepEqual(heartbeat.next.wait, { tool: "agent_acp_wait", arguments: { taskIds: [third, fourth] } });

    for (const taskIds of [[], "task", [1], [""], Array.from({ length: 101 }, (_, index) => `task-${index}`)]) {
      await assert.rejects(wait(service, A, { taskIds }), { code: "INVALID_ARGUMENT" });
    }
    await assert.rejects(wait(service, A, { taskIds: ["task-missing"] }), { code: "UNKNOWN_TASK" });
    await assert.rejects(wait(service, B, { taskIds: [third] }), { code: "NOT_TASK_OWNER" });
    await assert.rejects(wait(service, { ...A, rootId: "main-other" }, { taskIds: [third] }), { code: "NOT_TASK_OWNER" });
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("another Main's tasks are never watched or reported", async () => {
  const { service } = harness();
  try {
    const mineA = await open(service, A);
    const mineB = await open(service, B);
    const taskA = await start(service, mineA.session, A);
    const taskB = await start(service, mineB.session, B);
    const waitingB = wait(service, B, { timeoutMs: 600_000 });
    await until(() => service.mains.list(ROOT).length === 1, "B's wait to block");
    assert.deepEqual((await mainOf(service, B)).taskIds, [taskB]);
    mineA.worker.turns[0].resolve({ stopReason: "end_turn" });
    await until(() => service.taskStore.find(taskA)?.status === "completed", "A's task to finish");
    await pause(20);
    assert.equal((await mainOf(service, B))?.status, "waiting_tasks", "A's task does not wake B");
    // A hears about its own task only.
    const answerA = await wait(service, A);
    assert.deepEqual(answerA.tasks.map((row) => row.taskId), [taskA]);
    mineB.worker.turns[1].resolve({ stopReason: "end_turn" });
    const answerB = await waitingB;
    assert.deepEqual(answerB.tasks.map((row) => row.taskId), [taskB]);
    assert.equal(JSON.stringify(answerB).includes(taskA), false);
    assert.equal(JSON.stringify(answerA).includes(taskB), false);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("management and observers wait on the whole root and deliver nothing; a result past the budget is pointed at", async () => {
  const { service, clock } = harness();
  try {
    const mineA = await open(service, A);
    const mineB = await open(service, B);
    const taskA = await start(service, mineA.session, A);
    // Oldest first, by creation.
    clock.now += 1;
    const taskB = await start(service, mineB.session, B);
    assert.equal(isReadOnlyCall("wait", {}), true);
    assert.equal(isReadOnlyCall("main_list", {}), true);
    const watching = wait(service, MANAGEMENT);
    const observing = wait(service, OBSERVER, { timeoutMs: 30 });
    const observed = await observing;
    assert.equal(observed.reason, "heartbeat");
    assert.deepEqual(observed.tasks.map((row) => row.taskId), [taskA, taskB]);
    mineB.worker.turns[1].resolve({ stopReason: "end_turn" });
    const answer = await watching;
    assert.equal(answer.reason, "task_finished", "a task that finished during the wait is news to anyone");
    assert.deepEqual(answer.tasks.map((row) => [row.taskId, row.status]), [[taskB, "completed"], [taskA, "working"]]);
    assert.ok(answer.tasks[0].outcome);
    assert.equal(seenAt(service, taskB), null, "never a delivery to the Main");
    assert.equal(service.mains.list(ROOT).length, 0, "management is no Main");
    // Unseen results are B's to receive, not management's to be woken by.
    assert.equal((await wait(service, MANAGEMENT, { timeoutMs: 10 })).reason, "heartbeat");

    // Three finished results, the second too big for what the first left of
    // the budget: it is pointed at and stays unseen, and the third, which
    // fits, still comes whole.
    mineA.worker.turns[0].resolve({ stopReason: "end_turn" });
    await until(() => service.taskStore.find(taskA)?.status === "completed", "A's first task to finish");
    clock.now += 1;
    const big = await start(service, mineA.session, A);
    mineA.worker.emit(mineA.session.acpSessionId, {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(70_000) }
    });
    await finish(service, mineA.worker, big);
    clock.now += 1;
    const small = await start(service, mineA.session, A);
    await finish(service, mineA.worker, small);
    const many = await wait(service, A);
    assert.equal(many.reason, "task_finished");
    assert.deepEqual(many.tasks.map((row) => [row.taskId, Object.hasOwn(row, "outcome")]), [
      [taskA, true], [big, false], [small, true]
    ]);
    assert.deepEqual(many.next, {
      collect: [{ tool: "agent_acp_run", arguments: { taskId: big } }],
      wait: { tool: "agent_acp_wait", arguments: {} }
    });
    assert.ok(seenAt(service, taskA));
    assert.ok(seenAt(service, small));
    assert.equal(seenAt(service, big), null);
    // The first finished task always comes whole, so waiting again delivers it.
    const next = await wait(service, A);
    assert.deepEqual(next.tasks.map((row) => [row.taskId, Object.hasOwn(row, "outcome")]), [[big, true]]);
    assert.ok(Buffer.byteLength(JSON.stringify(next.tasks[0].outcome)) > 65_536);
    assert.deepEqual(next.next, {});
    assert.ok(seenAt(service, big));
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("cancelling a wait ends the wait alone: its waiter goes at once and the task runs on", async () => {
  const { service } = harness();
  try {
    const { session, worker } = await open(service);
    const taskId = await start(service, session, A);
    const controller = new AbortController();
    const waiting = wait(service, { ...A, signal: controller.signal }, { timeoutMs: 600_000 });
    await until(() => service.mains.list(ROOT).length === 1, "the wait to block");
    // One task holds 16 waiters at most. The wait is one of them; fill the rest.
    const attaches = Array.from({ length: 15 }, () => service.call("run", { taskId, waitMs: 600_000 }, A));
    await pause(10);
    await assert.rejects(service.call("run", { taskId, waitMs: 600_000 }, A), { code: "TASK_WAITER_LIMIT" });
    controller.abort();
    await assert.rejects(waiting, { code: "WAIT_ABORTED" });
    assert.equal(service.taskStore.find(taskId).status, "working", "the task runs on");
    assert.equal(service.mains.list(ROOT).length, 0, "the Main is no longer waiting");
    // The wait's slot is free again, without anything else having moved.
    const last = service.call("run", { taskId, waitMs: 600_000 }, A);
    await finish(service, worker, taskId);
    for (const ran of await Promise.all([...attaches, last])) assert.equal(ran.status, "idle");
    // An already aborted request does not wait at all.
    const aborted = new AbortController();
    aborted.abort();
    const again = await start(service, session, A);
    await assert.rejects(wait(service, { ...A, signal: aborted.signal }), { code: "WAIT_ABORTED" });
    assert.equal(service.taskStore.find(again).status, "working");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("main_list and main_status: active while connected, waiting_tasks while a wait blocks, gone when it leaves", async () => {
  const { service, clock } = harness();
  try {
    assert.deepEqual([...MAIN_STATUSES], ["active", "waiting_tasks"]);
    const setup = await service.call("setup", {}, MANAGEMENT);
    assert.equal(setup.capabilities.taskWait, true, "declared, never probed");
    assert.equal(setup.capabilities.mainStatus, true);
    const seen = { management: [], observer: [], A: [], B: [] };
    service.subscribe({}, MANAGEMENT, (event) => seen.management.push(event));
    service.subscribe({}, OBSERVER, (event) => seen.observer.push(event));
    service.subscribe({}, A, (event) => seen.A.push(event));
    service.subscribe({}, B, (event) => seen.B.push(event));
    // A session subscription follows its sessions, not the Mains.
    const { session, worker } = await open(service, A);
    const sessionOnly = [];
    service.subscribe({ sessionIds: [session.id] }, A, (event) => sessionOnly.push(event));

    // What the daemon reports for its connections. A Codex front door names a
    // caller per thread; a second connection naming the same one changes nothing.
    const connectionA = {};
    const connectionB = {};
    service.attachCaller(connectionA, ROOT, { ...claudeCaller, turnId: "turn-x" });
    service.attachCaller(connectionB, ROOT, codexCaller);
    service.attachCaller(connectionB, ROOT, codexCaller);
    const secondB = {};
    service.attachCaller(secondB, ROOT, codexCaller);
    service.attachCaller({}, ROOT, { instanceId: "bad id" });
    const active = (caller, revision) => ({ caller, status: "active", since: iso(EPOCH), revision });
    assert.deepEqual(await mainsOf(service, MANAGEMENT), [active(claudeCaller, 1), active(codexCaller, 2)]);
    assert.deepEqual(await mainsOf(service, OBSERVER), await mainsOf(service, MANAGEMENT));
    assert.deepEqual(await mainsOf(service, A), [active(claudeCaller, 1)], "a front door lists its own");
    assert.deepEqual(await mainsOf(service, B), [active(codexCaller, 2)]);
    assert.deepEqual(await mainsOf(service, { ...A, rootId: "main-other" }), []);

    const taskId = await start(service, session, A);
    clock.now += 1_000;
    const waiting = wait(service, A, { timeoutMs: 600_000 });
    await until(() => seen.management.some((event) => event.status === "waiting_tasks"), "waiting_tasks");
    clock.now += 1_000;
    await finish(service, worker, taskId);
    assert.equal((await waiting).reason, "task_finished");
    await until(() => seen.management.filter((event) => event.type === "main_status").length === 4, "back to active");
    service.detachCaller(connectionA);
    service.detachCaller(connectionB);
    assert.deepEqual(await mainsOf(service, MANAGEMENT), [active(codexCaller, 2)], "B still has a connection");
    service.detachCaller(secondB);
    service.detachCaller(connectionB);
    assert.deepEqual(await mainsOf(service, MANAGEMENT), []);

    const statuses = (events) => events.filter((event) => event.type === "main_status")
      .map(({ type: _type, ...main }) => main);
    const expected = [
      active(claudeCaller, 1),
      active(codexCaller, 2),
      { caller: claudeCaller, status: "waiting_tasks", since: iso(EPOCH + 1_000), taskIds: [taskId], count: 1, revision: 3 },
      { caller: claudeCaller, status: "active", since: iso(EPOCH + 2_000), revision: 4 },
      { caller: claudeCaller, status: "gone", since: iso(EPOCH + 2_000), revision: 5 },
      { caller: codexCaller, status: "gone", since: iso(EPOCH + 2_000), revision: 6 }
    ];
    assert.deepEqual(statuses(seen.management), expected);
    assert.deepEqual(statuses(seen.observer), expected);
    assert.deepEqual(statuses(seen.A), expected.filter((main) => main.caller === claudeCaller), "a front door hears its own");
    assert.deepEqual(statuses(seen.B), expected.filter((main) => main.caller === codexCaller));
    assert.deepEqual(statuses(sessionOnly), []);
    // An observer names no Main, and no wait of its makes one.
    service.attachCaller({}, ROOT, null);
    assert.deepEqual(await mainsOf(service, MANAGEMENT), []);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("the heartbeat and its ceiling follow the host the front door serves, and ACP_GATEWAY_WAIT_LIMIT_MS replaces both", () => {
  // Measured: Codex 0.162.0 gives up on a tool call at 300s, Claude Code
  // 2.1.287 waited 300s; anything else gets the usual 60s.
  assert.deepEqual(waitLimits("codex-mcp-client", {}), { defaultMs: 270_000, limitMs: 280_000 });
  assert.deepEqual(waitLimits("claude-code", {}), { defaultMs: 540_000, limitMs: 600_000 });
  for (const name of ["grok-cli", "Codex-MCP-Client", "", undefined, null, "constructor", "__proto__"]) {
    assert.deepEqual(waitLimits(name, {}), { defaultMs: 55_000, limitMs: 600_000 }, String(name));
  }
  assert.deepEqual(waitLimits("codex-mcp-client", { ACP_GATEWAY_WAIT_LIMIT_MS: "900000" }), { defaultMs: 600_000, limitMs: 600_000 });
  assert.deepEqual(waitLimits("claude-code", { ACP_GATEWAY_WAIT_LIMIT_MS: "120000" }), { defaultMs: 120_000, limitMs: 120_000 });
  assert.deepEqual(waitLimits("other", { ACP_GATEWAY_WAIT_LIMIT_MS: "1000" }), { defaultMs: 1_000, limitMs: 1_000 });
  for (const ignored of ["999", "0", "-5", "1.5", "soon", ""]) {
    assert.deepEqual(waitLimits("codex-mcp-client", { ACP_GATEWAY_WAIT_LIMIT_MS: ignored }), { defaultMs: 270_000, limitMs: 280_000 }, ignored);
  }
  assert.equal(waitProgressMs({}), WAIT_PROGRESS_MS);
  assert.equal(waitProgressMs({ ACP_GATEWAY_WAIT_PROGRESS_MS: "100" }), 100);
  assert.equal(waitProgressMs({ ACP_GATEWAY_WAIT_PROGRESS_MS: "99" }), WAIT_PROGRESS_MS);
  assert.equal(waitProgressMs({ ACP_GATEWAY_WAIT_PROGRESS_MS: "900000" }), 300_000);
});

test("front door: agent_acp_wait sleeps through a Worker's turn with progress, and management sees its Main waiting_tasks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-wt-"));
  const clients = [];
  let daemon = null;
  try {
    const providers = await writeMockProviders(directory);
    daemon = await startDaemon({ directory, env: providers });
    const management = rpcClient(clients, daemon);
    assert.equal((await management.call("setup", {})).capabilities.mainStatus, true);
    const events = [];
    await management.subscribe({}, (event) => events.push(event));
    const host = await frontDoor(clients, daemon, directory, providers);

    const { tools } = await host.listTools();
    const tool = tools.find((item) => item.name === "agent_acp_wait");
    assert.ok(tool, "agent_acp_wait is in the live tool list");
    assert.equal(tool.execution, undefined, "a wait is no Task");
    await assert.rejects(
      host.request(
        { method: "tools/call", params: { name: "agent_acp_wait", arguments: {} } },
        CreateTaskResultSchema,
        { task: { ttl: 60_000 } }
      ),
      (error) => error instanceof McpError && error.code === ErrorCode.MethodNotFound
    );

    const sessionId = await openSession(host, directory);
    const started = await callTool(host, "agent_acp_run", { sessionId, prompt: "sleep:1500", waitMs: 0 });
    assert.equal(started.status, "working");
    const progress = [];
    const answer = await callTool(host, "agent_acp_wait", {}, { onprogress: (params) => progress.push(params) });
    assert.equal(answer.reason, "task_finished");
    assert.deepEqual(answer.tasks.map((row) => [row.taskId, row.status]), [[started.taskId, "completed"]]);
    assert.equal(answer.tasks[0].outcome.result.text, "SLEPT");
    assert.equal(answer.tasks[0].outcome.taskId, started.taskId);
    assert.deepEqual(answer.next, {});
    // Every 100ms of a ~1.5s sleep, growing, toward the default heartbeat of
    // a host the Gateway does not know.
    assert.ok(progress.length >= 3, `progress notifications: ${progress.length}`);
    assert.ok(progress.every((params, index) => index === 0 || params.progress > progress[index - 1].progress));
    assert.ok(progress.every((params) => params.total === 55_000 && /still waiting/.test(params.message)));

    // The run's own result reached the Main through the wait: nothing is left.
    assert.equal((await callTool(host, "agent_acp_inbox", { action: "attention" })).counts.updates, 0);
    assert.equal((await callTool(host, "agent_acp_wait", {})).reason, "nothing_pending");

    const statuses = events.filter((event) => event.type === "main_status").map((event) => event.status);
    assert.deepEqual(statuses, ["active", "waiting_tasks", "active"], "the host connected, slept, woke");
    const [main] = (await management.call("main_list", {})).mains;
    assert.equal(main.status, "active");
    assert.equal(main.caller.sessionId, null, "a host with no session id: its front door instance is the Main");
    const sleeping = events.find((event) => event.status === "waiting_tasks");
    assert.deepEqual([sleeping.taskIds, sleeping.count], [[started.taskId], 1]);
    assert.deepEqual(sleeping.caller, main.caller);
  } finally {
    await closeAll(clients);
    await daemon?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("front door: cancelling agent_acp_wait ends the wait alone, and a connection that closes takes its wait with it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-wt-"));
  const clients = [];
  let daemon = null;
  try {
    const providers = await writeMockProviders(directory);
    daemon = await startDaemon({ directory, env: providers });
    const management = rpcClient(clients, daemon);
    const events = [];
    await management.subscribe({}, (event) => events.push(event));
    // A session management opened is no Main's, so every Main's wait watches
    // its task.
    const { sessionId } = await management.call("session_open", { provider: "mock", cwd: directory, permissionPolicy: "read_only" });
    // Long enough to outlast both waits below, short enough for the attaches
    // at the end to see it finish.
    const { taskId } = await management.call("run", { sessionId, prompt: "sleep:4000", waitMs: 0 });
    const mains = async () => (await management.call("main_list", {})).mains;
    const statusOf = async (instanceId) => (await mains()).find((main) => main.caller.instanceId === instanceId)?.status ?? null;

    const host = await frontDoor(clients, daemon, directory, providers);
    const cancel = new AbortController();
    const cancelled = callTool(host, "agent_acp_wait", {}, { signal: cancel.signal });
    const hostMain = await eventually(async () => (await mains()).find((main) => main.status === "waiting_tasks"), "the host asleep");
    assert.deepEqual(hostMain.taskIds, [taskId]);
    cancel.abort();
    await assert.rejects(cancelled);
    await eventually(async () => (await statusOf(hostMain.caller.instanceId)) === "active", "the host awake");
    assert.equal((await management.call("task_get", { taskId })).status, "working", "the task runs on");

    // A raw control connection: when it closes, the daemon aborts its wait.
    const caller = { provider: "claude", sessionId: "wait-x", instanceId: "mcp-x" };
    const sleeper = rpcClient(clients, daemon, { caller });
    // A front door lists its own Main only; management lists both.
    assert.deepEqual((await sleeper.call("main_list", {})).mains.map((main) => [main.caller, main.status]), [
      [{ ...caller, pid: null }, "active"]
    ]);
    assert.equal((await mains()).length, 2);
    const sleeping = sleeper.call("wait", { timeoutMs: 60_000 }, 70_000).catch((error) => error);
    await eventually(async () => (await statusOf("mcp-x")) === "waiting_tasks", "the raw caller asleep");
    sleeper.close();
    assert.match((await sleeping).message, /closed/);
    await eventually(async () => (await statusOf("mcp-x")) === null, "the raw caller gone");
    const gone = events.filter((event) => event.type === "main_status" && event.caller.instanceId === "mcp-x");
    assert.deepEqual(gone.map((event) => event.status), ["active", "waiting_tasks", "gone"]);

    // Neither wait kept its waiter: the task's whole budget of 16 is free.
    const attaches = await Promise.all(Array.from({ length: 16 }, () => management.call("run", { taskId, waitMs: 20_000 }, 25_000)));
    assert.ok(attaches.every((ran) => ran.status === "idle" && ran.result.text === "SLEPT"));
  } finally {
    await closeAll(clients);
    await daemon?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("front door: the host's clientInfo picks the wait's default and ceiling, and ACP_GATEWAY_WAIT_LIMIT_MS replaces them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-wt-"));
  const clients = [];
  let daemon = null;
  try {
    const providers = await writeMockProviders(directory);
    daemon = await startDaemon({ directory, env: providers });
    const management = rpcClient(clients, daemon);
    const { sessionId } = await management.call("session_open", { provider: "mock", cwd: directory, permissionPolicy: "read_only" });
    const { taskId } = await management.call("run", { sessionId, prompt: "sleep:60000", waitMs: 0 });
    // The total of the first progress notification is the timeoutMs the front
    // door gave this wait; the wait itself is then cancelled.
    const heartbeatOf = async (host, args = {}) => {
      const cancel = new AbortController();
      let total = null;
      const waiting = callTool(host, "agent_acp_wait", args, {
        signal: cancel.signal,
        onprogress: (params) => {
          total ??= params.total;
          cancel.abort();
        }
      });
      await assert.rejects(waiting);
      return total;
    };
    const codex = await frontDoor(clients, daemon, directory, providers, { name: "codex-mcp-client" });
    assert.equal(await heartbeatOf(codex), 270_000);
    assert.equal(await heartbeatOf(codex, { timeoutMs: 600_000 }), 280_000, "a Codex call cut at 300s loses its answer");
    assert.equal(await heartbeatOf(codex, { timeoutMs: 30_000 }), 30_000);
    const claude = await frontDoor(clients, daemon, directory, providers, { name: "claude-code" });
    assert.equal(await heartbeatOf(claude), 540_000);
    assert.equal(await heartbeatOf(claude, { timeoutMs: 600_000 }), 600_000);
    assert.equal(await heartbeatOf(await frontDoor(clients, daemon, directory, providers, { name: "grok-cli" })), 55_000);

    // The limit a user raised (or lowered) in the entry's env: here 1s, so the
    // heartbeat answers after a second whatever was asked.
    const limited = await frontDoor(clients, daemon, directory, providers, {
      name: "codex-mcp-client", env: { ACP_GATEWAY_WAIT_LIMIT_MS: "1000" }
    });
    const startedAt = performance.now();
    const heartbeat = await callTool(limited, "agent_acp_wait", { timeoutMs: 600_000 });
    const sleptMs = performance.now() - startedAt;
    assert.ok(sleptMs >= 950 && sleptMs < 10_000, `slept ${sleptMs}ms`);
    assert.equal(heartbeat.reason, "heartbeat");
    assert.deepEqual(heartbeat.tasks.map((row) => [row.taskId, row.status]), [[taskId, "working"]]);
    assert.deepEqual(heartbeat.next, { wait: { tool: "agent_acp_wait", arguments: {} } });
  } finally {
    await closeAll(clients);
    await daemon?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

// A management client (no caller) or a front door's raw control connection,
// kept in clients for the test to close.
function rpcClient(clients, daemon, options = {}) {
  const client = new GatewayRpcClient({
    socketPath: daemon.socketPath, token: daemon.token, rootId: daemon.rootId, statePath: daemon.statePath,
    autoStart: false, ...options
  });
  clients.push(client);
  return client;
}

// The Control front door as a host runs it, named as that host names itself at
// initialize. Without the suite runner's own session markers, each one is a
// Main of its own (its front door instance), and no inherited wait limit.
async function frontDoor(clients, daemon, directory, providers, { name = "wait-test", env = {} } = {}) {
  const { ACP_GATEWAY_WAIT_LIMIT_MS: _inherited, ...inherited } = withoutSessionMarkers(process.env);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [FRONT_DOOR],
    stderr: "pipe",
    env: {
      ...inherited,
      ACP_GATEWAY_SOCKET: daemon.socketPath,
      ACP_GATEWAY_CONTROL_TOKEN: daemon.token,
      ACP_GATEWAY_ROOT_ID: daemon.rootId,
      // The daemon's own isolation, so a daemon this front door started (it
      // starts one whenever a call finds none) could never touch the
      // developer's state.
      ACP_GATEWAY_STATE: daemon.statePath,
      ACP_GATEWAY_REGISTRY_CACHE: join(directory, "registry.json"),
      ACP_GATEWAY_INSTALL_STATE: join(directory, "install.json"),
      ACP_GATEWAY_AGENT_AUTO_UPDATE: "0",
      ACP_GATEWAY_AGENT_UPDATE_NOTIFICATIONS: "0",
      ACP_GATEWAY_WAIT_PROGRESS_MS: "100",
      ...providers,
      ...env
    }
  });
  const client = new Client({ name, version: "1.0.0" });
  clients.push(client);
  await client.connect(transport);
  return client;
}

// Front doors first: one left running would start a new daemon at its next call.
async function closeAll(clients) {
  await Promise.all(clients.map((client) => Promise.resolve(client.close()).catch(() => {})));
}

async function openSession(host, cwd) {
  return (await callTool(host, "agent_acp_session_open", { provider: "mock", cwd, permissionPolicy: "read_only" })).sessionId;
}

async function callTool(host, name, args, options = {}) {
  const result = await host.callTool({ name, arguments: args }, CallToolResultSchema, options);
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  return result.structuredContent;
}

async function eventually(read, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
