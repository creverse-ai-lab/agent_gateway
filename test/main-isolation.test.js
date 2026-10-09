// 1.8.0 W6: per-Main isolation. Every Main on a machine shares one rootId, so
// the root alone kept no Main out of another's work. A control request that
// names its caller comes from a front-door Main and reaches only that Main's
// sessions, the tasks and inbox rows that follow them, and whatever no Main is
// recorded for. Management (no caller: AgenLynk, the admin CLI, pre-1.6 front
// doors) and observers keep the whole root. A Main that comes back under another
// identity takes its sessions back only by an explicit session_restore, once the
// Main holding them is gone (the adopt rule). Most cases drive an in-process
// fake worker on an injected clock; the socket cases run the real daemon.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CallerPresence, isVisibleTo, requesterOf } from "../src/access.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { statePaths } from "../src/state-store.js";
import { startDaemon, writeMockProviders } from "./helpers/daemon-harness.js";
import { FakeWorker, finish, harness, permission, start, TERMINAL, until } from "./helpers/fake-worker.js";

const permissionAgent = fileURLToPath(new URL("./mock-permission-agent.js", import.meta.url));
const ROOT = "main-root";
const claudeCaller = { provider: "claude", sessionId: "claude-session-a", pid: 4242, instanceId: "mcp-a" };
// One Codex app process hosting two threads. Its front door names the thread
// per call (callerForCall), so each thread is a Main of its own.
const codexThreadB = { provider: "codex", sessionId: "codex-thread-b", pid: 5151, instanceId: "mcp-codex" };
const codexThreadC = { ...codexThreadB, sessionId: "codex-thread-c" };
const A = { rootId: ROOT, caller: claudeCaller };
const B = { rootId: ROOT, caller: codexThreadB };
const C = { rootId: ROOT, caller: codexThreadC };
const MANAGEMENT = { rootId: ROOT };
const OBSERVER = { rootId: ROOT, access: "observer" };

async function open(service, context) {
  const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, context);
  const session = service.requireSession(opened.sessionId);
  return { session, worker: session.client };
}

// For what crosses a real socket: polls on the timer, not on the event loop.
async function eventually(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function finished(service, { session, worker }, context, extra = {}) {
  const taskId = await start(service, session, context, extra);
  await finish(service, worker, taskId);
  return taskId;
}

const sessionIds = async (service, context, args = {}) =>
  (await service.call("session", { action: "list", ...args }, context)).sessions.map((item) => item.sessionId).sort();
const taskIds = async (service, context, args = {}) =>
  (await service.call("task_list", args, context)).tasks.map((task) => task.taskId).sort();
const inboxIds = async (service, context, args = {}) =>
  (await service.call("inbox", { action: "list", ...args }, context)).items.map((item) => item.inboxId);
const sorted = (...ids) => [...ids].sort();

test("the rule: a front-door Main reaches its own records and nobody's; management and observers reach the root", () => {
  assert.deepEqual(requesterOf(A), claudeCaller);
  assert.equal(requesterOf(MANAGEMENT), null, "no caller: management keeps the root");
  assert.equal(requesterOf(OBSERVER), null);
  assert.equal(requesterOf({ ...OBSERVER, caller: claudeCaller }), null, "an observer's claim makes it no Main");
  const a = requesterOf(A);
  assert.equal(isVisibleTo(claudeCaller, a), true);
  assert.equal(isVisibleTo({ ...claudeCaller, pid: 4343, instanceId: "mcp-a-restarted" }, a), true,
    "a restarted front door in the same CLI session is the same Main");
  assert.equal(isVisibleTo({ ...claudeCaller, sessionId: "claude-session-z" }, a), false, "another CLI session is not");
  assert.equal(isVisibleTo(codexThreadB, a), false);
  assert.equal(isVisibleTo(codexThreadB, requesterOf(C)), false, "two threads of one Codex process are two Mains");
  assert.equal(isVisibleTo(codexThreadB, { ...codexThreadB, sessionId: null }), true,
    "a call that names no thread is its whole process, as scope mine already says");
  assert.equal(isVisibleTo(undefined, a), true, "a record no Main is recorded for is every Main's");
  assert.equal(isVisibleTo(codexThreadB, null), true);
});

test("another Main's session answers NOT_SESSION_OWNER to every call that names it, and nothing moves", async () => {
  const { service, clock } = harness();
  try {
    const a = await open(service, A);
    const b = await open(service, B);
    const id = a.session.id;
    const refuse = (method, args, context = B) =>
      assert.rejects(service.call(method, args, context), { code: "NOT_SESSION_OWNER" }, `${method} ${args.action ?? ""}`);
    clock.now += 60_000;
    const activity = a.session.lastOwnerActivityAt;
    const turns = a.worker.turns.length;

    for (const action of ["get", "check", "workspace_diff"]) await refuse("session", { action, sessionId: id });
    await refuse("config", { action: "list", sessionId: id });
    await refuse("poll", { sessionId: id, cursor: 0 });
    await refuse("prompt", { sessionId: id, prompt: "go" });
    await refuse("run", { sessionId: id, prompt: "go", waitMs: 0 });
    await refuse("task_prompt", { sessionId: id, prompt: "go" });
    await refuse("task_run", { sessionId: id, prompt: "go" });
    await refuse("config", { action: "set", sessionId: id, configId: "mode", value: "read-only" });
    await refuse("permission", { sessionId: id, requestId: 1, optionId: "allow-once" });
    await refuse("answer", { sessionId: id, requestId: 1, action: "cancel" });
    await refuse("cancel", { sessionId: id });
    for (const action of ["close", "pin", "unpin", "clean"]) await refuse("session", { action, sessionId: id });
    // Restoring it in place would take it over.
    await refuse("session_restore", { provider: "claude", acpSessionId: a.session.acpSessionId, cwd: process.cwd() });
    // Another thread of B's own Codex process is another Main too.
    await refuse("poll", { sessionId: b.session.id, cursor: 0 }, C);

    assert.equal(a.worker.turns.length, turns, "the worker heard nothing");
    assert.equal(service.taskStore.toPersistedRecords().length, 0, "no handle was minted");
    assert.deepEqual([a.session.status, a.session.pinned, a.session._reserved ?? null], ["idle", false, null]);
    assert.equal(a.session.lastOwnerActivityAt, activity, "naming it does not keep it alive either");
    assert.deepEqual(await sessionIds(service, B), [b.session.id], "and B's list does not have it");

    // Its own Main still holds it, through a restarted front door as well.
    const restarted = { rootId: ROOT, caller: { ...claudeCaller, pid: 4343, instanceId: "mcp-a-restarted" } };
    assert.equal((await service.call("session", { action: "get", sessionId: id }, A)).sessionId, id);
    assert.notEqual(a.session.lastOwnerActivityAt, activity);
    const ran = await finished(service, a, restarted);
    assert.equal((await service.call("run", { taskId: ran }, restarted)).status, "idle");
    assert.equal((await service.call("session", { action: "pin", sessionId: id }, restarted)).pinned, true);
    // A front door in a new CLI session (a new conversation) is another Main.
    await refuse("poll", { sessionId: id, cursor: 0 }, { rootId: ROOT, caller: { ...claudeCaller, sessionId: "claude-session-z" } });
    // Management and observers are unchanged.
    assert.equal((await service.call("poll", { sessionId: id, cursor: 0 }, OBSERVER)).sessionId, id);
    assert.equal((await service.call("session", { action: "unpin", sessionId: id }, MANAGEMENT)).pinned, false);
    assert.equal((await service.call("session", { action: "close", sessionId: b.session.id }, MANAGEMENT)).closed, b.session.id);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("another Main's tasks are unknown to it: get, result, attach, cancel, list, links and ack", async () => {
  const { service, clock } = harness();
  try {
    const a = await open(service, A);
    const b = await open(service, B);
    const done = await finished(service, a, A);
    const running = await start(service, a.session, A);
    // Both sessions share one fake worker process, so keep this turn's handle.
    const runningTurn = a.worker.turns.at(-1);
    const own = await finished(service, b, B);
    const refuse = (method, args, context = B) =>
      assert.rejects(service.call(method, args, context), { code: "NOT_TASK_OWNER" }, `${method} ${args.taskId}`);

    for (const taskId of [done, running]) {
      await refuse("task_get", { taskId });
      // Refused before any wait: a running task must not keep B waiting either.
      await refuse("task_result", { taskId, waitMs: 60_000 });
      await refuse("run", { taskId, waitMs: 60_000 });
    }
    await refuse("task_cancel", { taskId: running });
    assert.equal(service.taskStore.find(running).status, "working", "the refused cancel cancelled nothing");
    assert.equal(a.session.status, "running");
    // setup's stall hint names only sessions the asking Main can act on.
    clock.now += 10 * 60_000;
    const stalled = async (context) => (await service.call("setup", { mode: "summary" }, context)).alerts
      .find((item) => item.code === "sessions_stall_suspected")?.sessionIds ?? [];
    assert.deepEqual(await stalled(A), [a.session.id]);
    assert.deepEqual(await stalled(B), []);
    assert.deepEqual(await stalled(MANAGEMENT), [a.session.id]);

    // Lists drop it; their shapes stay.
    const unpaged = await service.call("task_list", {}, B);
    assert.deepEqual(Object.keys(unpaged), ["tasks"]);
    assert.deepEqual(unpaged.tasks.map((task) => task.taskId), [own]);
    assert.deepEqual(await taskIds(service, B, { limit: 50 }), [own]);
    assert.deepEqual(await taskIds(service, A), sorted(done, running));
    assert.deepEqual(await taskIds(service, MANAGEMENT), sorted(done, running, own));
    assert.deepEqual(await taskIds(service, OBSERVER), sorted(done, running, own));
    // A link to it names a task B cannot see, as another root's would.
    await assert.rejects(service.call("run", { sessionId: b.session.id, prompt: "go", waitMs: 0, parentTaskId: done }, B),
      (error) => error.code === "INVALID_ARGUMENT" && error.details.unknownTaskIds.join() === done);
    const acked = await service.call("inbox", { action: "ack", taskIds: [done, own] }, B);
    assert.deepEqual(acked, { ok: true, acked: [own], skipped: [{ taskId: done, reason: "not_task_owner" }] });
    assert.equal(service.taskStore.find(done).seenAt ?? null, null);
    assert.deepEqual((await service.call("inbox", { action: "attention" }, B)).updates, []);
    assert.deepEqual((await service.call("inbox", { action: "attention" }, A)).updates.map((row) => row.taskId), [done]);

    // Once its session is gone a task answers to the Main that created it.
    runningTurn.resolve({ stopReason: "end_turn" });
    await until(() => TERMINAL.includes(service.taskStore.find(running)?.status), "running task end");
    await service.call("session", { action: "close", sessionId: a.session.id }, A);
    await refuse("task_get", { taskId: done });
    assert.equal((await service.call("task_get", { taskId: done }, A)).taskId, done);
    assert.equal((await service.call("task_result", { taskId: running }, A)).taskId, running);
    assert.equal((await service.call("task_result", { taskId: done }, MANAGEMENT)).taskId, done);
    assert.equal(service.taskStore.find(done).seenAt ?? null, null, "management collecting it is no delivery");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("another Main's worker requests are not its to see or answer, before and after the session closes", async () => {
  const { service, clock } = harness({ attentionStaleMs: 60_000 });
  const alert = async (context) =>
    (await service.call("setup", { mode: "summary" }, context)).alerts.find((item) => item.code === "attention_stale_requests") ?? null;
  try {
    const a = await open(service, A);
    await open(service, B);
    const taskId = await start(service, a.session, A);
    permission(a.worker, a.session, 1);
    await until(() => service.inbox.size === 1, "permission row");
    const [row] = service.inbox.values();
    clock.now += 60_000;

    assert.deepEqual(await inboxIds(service, B), []);
    assert.deepEqual(await inboxIds(service, B, { sessionId: a.session.id, limit: 10 }), []);
    await assert.rejects(service.call("inbox", { action: "get", inboxId: row.inboxId }, B), { code: "NOT_INBOX_OWNER" });
    const attentionB = await service.call("inbox", { action: "attention" }, B);
    assert.deepEqual([attentionB.needsMain, attentionB.counts], [[], { needsMain: 0, stale: 0, updates: 0 }]);
    assert.equal(await alert(B), null, "B is not asked for what it cannot answer");
    await assert.rejects(service.call("permission", { sessionId: a.session.id, requestId: 1, optionId: "allow-once" }, B),
      { code: "NOT_SESSION_OWNER" });
    assert.equal(row.status, "pending");

    assert.deepEqual(await inboxIds(service, A), [row.inboxId]);
    assert.equal((await service.call("inbox", { action: "get", inboxId: row.inboxId }, A)).item.inboxId, row.inboxId);
    assert.deepEqual((await service.call("inbox", { action: "attention" }, A)).needsMain.map((item) => item.inboxId), [row.inboxId]);
    assert.equal((await alert(A)).count, 1);
    assert.equal((await alert(MANAGEMENT)).count, 1);
    assert.deepEqual(await inboxIds(service, MANAGEMENT), [row.inboxId]);
    assert.equal((await service.call("inbox", { action: "get", inboxId: row.inboxId }, OBSERVER)).item.inboxId, row.inboxId);

    // Answered and closed, the row stays as A's history: it kept its owner.
    await service.call("permission", { sessionId: a.session.id, requestId: 1, optionId: "allow-once" }, A);
    await until(() => a.session.status === "running", "answered");
    await finish(service, a.worker, taskId);
    await service.call("session", { action: "close", sessionId: a.session.id }, A);
    assert.deepEqual(row.sessionOpenedBy, claudeCaller);
    assert.deepEqual(await inboxIds(service, A), [row.inboxId]);
    assert.deepEqual(await inboxIds(service, B), []);
    await assert.rejects(service.call("inbox", { action: "get", inboxId: row.inboxId }, B), { code: "NOT_INBOX_OWNER" });
    const got = await service.call("inbox", { action: "get", inboxId: row.inboxId }, A);
    assert.equal(Object.hasOwn(got.item, "sessionOpenedBy"), false, "internal: the row's public shape is unchanged");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a session no Main is recorded for, and its tasks and requests, stay every Main's", async () => {
  const { service } = harness();
  try {
    const a = await open(service, A);
    const b = await open(service, B);
    const shared = await open(service, MANAGEMENT);
    assert.deepEqual(await sessionIds(service, A), sorted(a.session.id, shared.session.id));
    assert.deepEqual(await sessionIds(service, B), sorted(b.session.id, shared.session.id));
    assert.deepEqual(await sessionIds(service, MANAGEMENT), sorted(a.session.id, b.session.id, shared.session.id));
    // scope mine keeps its meaning: one's own only, never nobody's.
    assert.deepEqual(await sessionIds(service, A, { scope: "mine" }), [a.session.id]);

    // B runs on it; A sees that task as well, while the session is nobody's.
    const bTask = await finished(service, shared, B);
    assert.equal((await service.call("task_get", { taskId: bTask }, A)).taskId, bTask);
    assert.deepEqual(await taskIds(service, A), [bTask]);
    assert.deepEqual(await taskIds(service, A, { scope: "mine" }), []);
    // Its result is still B's to be delivered: A reading it marks nothing seen.
    await service.call("task_result", { taskId: bTask }, A);
    assert.equal(service.taskStore.find(bTask).seenAt ?? null, null);

    // Its worker's requests are anyone's to read and to answer.
    const taskId = await start(service, shared.session, A);
    permission(shared.worker, shared.session, 7);
    await until(() => service.inbox.size === 1, "permission row");
    const [row] = service.inbox.values();
    assert.equal(Object.hasOwn(row, "sessionOpenedBy"), false, "nobody's row records nobody");
    assert.deepEqual(await inboxIds(service, A), [row.inboxId]);
    assert.deepEqual(await inboxIds(service, B), [row.inboxId]);
    assert.equal((await service.call("inbox", { action: "attention" }, B)).counts.needsMain, 1);
    await service.call("permission", { sessionId: shared.session.id, requestId: 7, optionId: "allow-once" }, B);
    await until(() => shared.session.status === "running", "answered");
    await finish(service, shared.worker, taskId);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("clean closes only the caller's own sessions; management cleans the root", async () => {
  const { service } = harness();
  try {
    const a = await open(service, A);
    const b = await open(service, B);
    const shared = await open(service, MANAGEMENT);
    // clean skips idle and active sessions, so each one ends a turn in error.
    for (const [opened, context] of [[a, A], [b, B], [shared, MANAGEMENT]]) {
      await service.call("prompt", { sessionId: opened.session.id, prompt: "go" }, context);
      opened.worker.turns.at(-1).reject(new Error("worker failed"));
      await until(() => opened.session.status === "error", "turn failed");
    }
    // clean has always named one session of the caller's (it is checked first).
    assert.deepEqual((await service.call("session", { action: "clean", sessionId: b.session.id }, B)).closed, [b.session.id]);
    assert.deepEqual((await service.call("session", { action: "clean", sessionId: a.session.id }, A)).closed, [a.session.id]);
    assert.equal(service.store.get(shared.session.id)?.status, "error", "nobody's session is not a front door's to clean");
    assert.deepEqual((await service.call("session", { action: "clean", sessionId: shared.session.id }, MANAGEMENT)).closed,
      [shared.session.id]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("watch-all subscriptions carry the Main's own and nobody's sessions, including ones opened later", async () => {
  const { service } = harness();
  try {
    const a = await open(service, A);
    const b = await open(service, B);
    const shared = await open(service, MANAGEMENT);
    const seen = { A: [], management: [] };
    const subscribed = service.subscribe({}, A, (event) => seen.A.push(event));
    assert.deepEqual(subscribed.sessions.map((item) => item.sessionId).sort(), sorted(a.session.id, shared.session.id));
    assert.deepEqual(Object.keys(subscribed.replay).sort(), sorted(a.session.id, shared.session.id));
    const everything = service.subscribe({}, MANAGEMENT, (event) => seen.management.push(event));
    assert.equal(everything.sessions.length, 3);
    // Explicit ids must all be visible.
    assert.throws(() => service.subscribe({ sessionIds: [a.session.id, b.session.id] }, A, () => {}), { code: "NOT_SESSION_OWNER" });
    assert.equal(service.subscribe({ sessionIds: [a.session.id, shared.session.id] }, A, () => {}).sessions.length, 2);

    // Live: B's work, and a session B opens later, never reach A's subscription.
    const bTask = await finished(service, b, B);
    const later = await open(service, B);
    const laterShared = await open(service, MANAGEMENT);
    const sessionsIn = (events) => new Set(events.map((event) => event.sessionId));
    assert.equal(sessionsIn(seen.A).has(b.session.id), false);
    assert.equal(sessionsIn(seen.A).has(later.session.id), false);
    assert.equal(sessionsIn(seen.A).has(laterShared.session.id), true, "a session nobody is recorded for still streams");
    assert.ok(seen.management.some((event) => event.type === "task_status" && event.taskId === bTask));
    assert.equal(sessionsIn(seen.management).has(later.session.id), true);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("an inbox row keeps its Main across restarts, and a row written before 1.8.0 learns it from its session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-isolation-restart-"));
  const statePath = join(directory, "state.json");
  let inboxId = null;
  let sessionId = null;
  try {
    const first = harness({ statePath });
    try {
      await first.service.init();
      const a = await open(first.service, A);
      sessionId = a.session.id;
      await start(first.service, a.session, A);
      permission(a.worker, a.session, 1);
      await until(() => first.service.inbox.size === 1, "permission row");
      const [row] = first.service.inbox.values();
      inboxId = row.inboxId;
      // As a 1.7 Gateway would have written it.
      delete row.sessionOpenedBy;
    } finally {
      await first.service.shutdown();
    }

    const second = harness({ statePath });
    try {
      await second.service.init();
      assert.deepEqual(second.service.inbox.get(inboxId).sessionOpenedBy, claudeCaller, "learned from its session");
      assert.equal(second.service.inbox.get(inboxId).status, "interrupted");
      await second.service.call("session", { action: "close", sessionId }, A);
      assert.deepEqual(await inboxIds(second.service, A), [inboxId]);
      assert.deepEqual(await inboxIds(second.service, B), []);
    } finally {
      await second.service.shutdown();
    }

    // The session is gone for good now: only the row says whose it is.
    const third = harness({ statePath });
    try {
      await third.service.init();
      assert.equal(third.service.store.get(sessionId), undefined);
      assert.deepEqual(await inboxIds(third.service, A), [inboxId]);
      assert.deepEqual(await inboxIds(third.service, B), []);
      await assert.rejects(third.service.call("inbox", { action: "get", inboxId }, B), { code: "NOT_INBOX_OWNER" });
      assert.deepEqual(await inboxIds(third.service, MANAGEMENT), [inboxId]);
    } finally {
      await third.service.shutdown();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A real daemon whose one provider is the permission mock, which mints a
// distinct ACP session id per session/new, and connect(): a client of it, kept
// in clients for the test to close.
async function mockpermDaemon(directory, clients) {
  const daemon = await startDaemon({
    directory,
    env: await writeMockProviders(directory, { provider: "mockperm", agent: permissionAgent })
  });
  const connect = (options = {}) => {
    const client = new GatewayRpcClient({
      socketPath: daemon.socketPath, token: daemon.token, rootId: daemon.rootId, statePath: daemon.statePath,
      autoStart: false, ...options
    });
    clients.push(client);
    return client;
  };
  return { daemon, connect };
}

test("over the control socket each front door's caller confines its calls and its subscriptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-isolation-daemon-"));
  let daemon = null;
  const clients = [];
  try {
    let connect;
    ({ daemon, connect } = await mockpermDaemon(directory, clients));
    // No pid: the Worker ancestry check is not what this is about.
    const mainA = connect({ caller: { provider: "claude", sessionId: "claude-session-a", instanceId: "mcp-a" } });
    const mainB = connect({ caller: { provider: "codex", sessionId: "codex-thread-b", instanceId: "mcp-b" } });
    const management = connect();
    const observer = connect({ access: "observer" });
    const openArgs = { provider: "mockperm", cwd: directory, permissionPolicy: "read_only" };
    const sa = (await mainA.call("session_open", openArgs)).sessionId;
    const sb = (await mainB.call("session_open", openArgs)).sessionId;
    const listed = async (client) => (await client.call("session", { action: "list" })).sessions.map((item) => item.sessionId).sort();
    assert.deepEqual(await listed(mainA), [sa]);
    assert.deepEqual(await listed(mainB), [sb]);
    assert.deepEqual(await listed(management), sorted(sa, sb));
    assert.deepEqual(await listed(observer), sorted(sa, sb));
    await assert.rejects(mainB.call("session", { action: "get", sessionId: sa }), { code: "NOT_SESSION_OWNER" });
    await assert.rejects(mainB.call("poll", { sessionId: sa, cursor: 0 }), { code: "NOT_SESSION_OWNER" });
    assert.equal((await management.call("session", { action: "get", sessionId: sa })).sessionId, sa);

    const events = { A: [], management: [] };
    const subA = await mainA.subscribe({}, (event) => events.A.push(event));
    assert.deepEqual(subA.sessions.map((item) => item.sessionId), [sa]);
    const subM = await management.subscribe({}, (event) => events.management.push(event));
    assert.deepEqual(subM.sessions.map((item) => item.sessionId).sort(), sorted(sa, sb));
    await assert.rejects(mainA.subscribe({ sessionIds: [sb] }, () => {}), { code: "NOT_SESSION_OWNER" });
    // A session B opens later reaches management, never A. A's own new session
    // reaches A, on the same connection after anything sent to A before it.
    const sb2 = (await mainB.call("session_open", openArgs)).sessionId;
    await eventually(() => events.management.some((event) => event.sessionId === sb2), "management saw B's new session");
    const sa2 = (await mainA.call("session_open", openArgs)).sessionId;
    await eventually(() => events.A.some((event) => event.sessionId === sa2), "A saw its own new session");
    assert.equal(events.A.some((event) => event.sessionId === sb || event.sessionId === sb2), false);
  } finally {
    for (const client of clients) client.close();
    await daemon?.stop?.();
    await rm(directory, { recursive: true, force: true });
  }
});

// The adopt rule. A Main that comes back under another identity (a new
// conversation, or a restarted front door that sends no session id) is another
// Main. It takes its earlier sessions back by naming them exactly in
// session_restore, once no control connection or subscription speaks for the
// Main that holds them, and in no other way.

// A new conversation of the same user: another CLI session, so another Main.
const claudeCallerNew = { provider: "claude", sessionId: "claude-session-a2", pid: 4343, instanceId: "mcp-a2" };
const A2 = { rootId: ROOT, caller: claudeCallerNew };
// A's front door restarted inside its CLI session: still A.
const A_RESTARTED = { rootId: ROOT, caller: { ...claudeCaller, pid: 4444, instanceId: "mcp-a-restarted" } };

const restoreArgs = (session, cwd = session.cwd) => ({ provider: session.provider, acpSessionId: session.acpSessionId, cwd });

// Refused exactly as before the rule existed: the code and the message, and
// nothing that names the session or its owner.
async function refusedAsBefore(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "NOT_SESSION_OWNER");
    assert.equal(error.message, "Session belongs to another Main");
    assert.equal(Object.hasOwn(error, "details"), false);
    return true;
  });
}

// A restore of a record the caller may act on whose worker is still connected
// answers that it is already registered, under its sessionId.
async function restoresInPlace(service, session, context) {
  await assert.rejects(service.call("session_restore", restoreArgs(session), context), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT", error.message);
    assert.deepEqual(error.details, { sessionId: session.id, acpSessionId: session.acpSessionId });
    return true;
  });
}

test("presence: a control connection speaks for each Main it named until it closes", () => {
  const presence = new CallerPresence();
  const [a, codex, busy] = [{}, {}, {}];
  presence.bind(a, claudeCaller);
  assert.equal(presence.isLive(claudeCaller), true);
  assert.equal(presence.isLive(A_RESTARTED.caller), true, "the same CLI session through another front door");
  assert.equal(presence.isLive(claudeCallerNew), false, "a new conversation is another Main");
  presence.bind(codex, codexThreadB);
  assert.equal(presence.isLive(codexThreadB), true);
  assert.equal(presence.isLive(codexThreadC), false, "another thread of the same process");
  // A call that names no thread speaks for the whole process, as scope mine reads it.
  presence.bind(codex, { ...codexThreadB, sessionId: null });
  assert.equal(presence.isLive(codexThreadC), true);
  presence.bind(a, { instanceId: "not an id!" });
  presence.release(a);
  assert.equal(presence.isLive(claudeCaller), false, "closed: whoever it spoke for is gone");
  presence.release(codex);
  assert.equal(presence.isLive(codexThreadB), false);
  // Past its bound a connection speaks for anyone, which can only refuse.
  for (let index = 0; index <= 1_024; index += 1) {
    presence.bind(busy, { provider: "codex", sessionId: `thread-${index}`, instanceId: "mcp-busy" });
  }
  assert.equal(presence.isLive(claudeCallerNew), true);
  presence.release(busy);
  assert.equal(presence.isLive(claudeCallerNew), false);
});

test("a Main back under a new identity adopts its session by an explicit restore once the old Main is gone", async () => {
  const presence = new CallerPresence();
  const { service } = harness({ isOwnerLive: (owner) => presence.isLive(owner) });
  try {
    presence.bind("connection-a", claudeCaller);
    const a = await open(service, A);
    const id = a.session.id;
    const done = await finished(service, a, A);
    const running = await start(service, a.session, A);
    permission(a.worker, a.session, 1);
    await until(() => service.inbox.size === 1, "permission row");
    const [row] = service.inbox.values();

    // While A's front door is connected, its session is not A2's to take.
    await refusedAsBefore(service.call("session_restore", restoreArgs(a.session), A2));
    presence.release("connection-a");
    // A is gone, but the restore has to name the record exactly, its cwd too.
    await refusedAsBefore(service.call("session_restore", restoreArgs(a.session, tmpdir()), A2));
    assert.deepEqual(a.session.openedBy, claudeCaller, "nothing moved");

    // The worker is still connected, so the restore that adopted the record
    // answers as it would answer its owner.
    await restoresInPlace(service, a.session, A2);
    assert.deepEqual([a.session.openedBy, a.session.adoptedFrom], [claudeCallerNew, claudeCaller]);
    assert.deepEqual(row.sessionOpenedBy, claudeCallerNew);
    for (const taskId of [done, running]) assert.deepEqual(service.taskStore.find(taskId).boundOwner, claudeCallerNew);
    // Idempotent: the same call finds A2's own record and moves nothing.
    await restoresInPlace(service, a.session, A2);
    assert.deepEqual(a.session.adoptedFrom, claudeCaller);

    // A2 reads it, answers its worker, collects, and prompts it again.
    const got = await service.call("session", { action: "get", sessionId: id }, A2);
    assert.deepEqual([got.openedBy, got.adoptedFrom], [claudeCallerNew, claudeCaller]);
    const polled = await service.call("poll", { sessionId: id, cursor: 0 }, A2);
    assert.equal(Object.hasOwn(polled, "adoptedFrom"), false, "a poll does not grow");
    assert.deepEqual(await inboxIds(service, A2), [row.inboxId]);
    assert.equal((await service.call("inbox", { action: "get", inboxId: row.inboxId }, A2)).item.inboxId, row.inboxId);
    await service.call("permission", { sessionId: id, requestId: 1, optionId: "allow-once" }, A2);
    await until(() => a.session.status === "running", "answered");
    await finish(service, a.worker, running);
    assert.deepEqual(await taskIds(service, A2), sorted(done, running));
    // Results the old Main never received are A2's to receive now.
    const updates = (await service.call("inbox", { action: "attention" }, A2)).updates.map((item) => item.taskId);
    assert.deepEqual(updates.sort(), sorted(done, running));
    assert.equal((await service.call("task_result", { taskId: done }, A2)).taskId, done);
    assert.ok(service.taskStore.find(done).seenAt, "delivered to the Main that took it over");
    assert.deepEqual(await service.call("inbox", { action: "ack", taskIds: [running] }, A2), { ok: true, acked: [running], skipped: [] });
    const again = await finished(service, a, A2);

    // The old identity cannot, not through its restarted front door either, and
    // cannot take it back while A2 is connected.
    presence.bind("connection-a2", claudeCallerNew);
    await refusedAsBefore(service.call("poll", { sessionId: id, cursor: 0 }, A_RESTARTED));
    await refusedAsBefore(service.call("session_restore", restoreArgs(a.session), A_RESTARTED));
    await assert.rejects(service.call("task_get", { taskId: done }, A), { code: "NOT_TASK_OWNER" });
    await assert.rejects(service.call("inbox", { action: "get", inboxId: row.inboxId }, A), { code: "NOT_INBOX_OWNER" });
    assert.deepEqual(await sessionIds(service, A), []);
    assert.deepEqual((await service.call("session", { action: "get", sessionId: id }, MANAGEMENT)).openedBy, claudeCallerNew);

    // Closed, its tasks and its row stay A2's: bound to it, not back to their creator.
    await service.call("session", { action: "close", sessionId: id }, A2);
    assert.deepEqual(await taskIds(service, A2), sorted(done, running, again));
    assert.deepEqual(await taskIds(service, A), []);
    assert.deepEqual(await inboxIds(service, A2), [row.inboxId]);
    assert.deepEqual(await inboxIds(service, A), []);
    const read = await service.call("task_get", { taskId: done }, A2);
    assert.deepEqual(read.caller, claudeCaller, "the record still says who created it");
    assert.equal(Object.hasOwn(read, "boundOwner"), false, "internal: the task's public shape is unchanged");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("an adoption waits for the old Main's subscriptions too, and only session_restore adopts", async () => {
  const presence = new CallerPresence();
  const { service } = harness({ isOwnerLive: (owner) => presence.isLive(owner) });
  try {
    const a = await open(service, A);
    const id = a.session.id;
    const watching = service.subscribe({ sessionIds: [id] }, A, () => {});
    // An observer claiming to be A keeps nothing alive: an observer is nobody's Main.
    service.subscribe({}, { ...OBSERVER, caller: claudeCaller }, () => {});
    await refusedAsBefore(service.call("session_restore", restoreArgs(a.session), A2));
    service.unsubscribe(watching.subscriptionId, A);

    // A is gone now, and nothing but an explicit restore hands its session over.
    assert.deepEqual(await sessionIds(service, A2), []);
    for (const action of ["get", "check", "pin", "close"]) await refusedAsBefore(service.call("session", { action, sessionId: id }, A2));
    await refusedAsBefore(service.call("poll", { sessionId: id, cursor: 0 }, A2));
    await refusedAsBefore(service.call("run", { sessionId: id, prompt: "go", waitMs: 0 }, A2));
    assert.throws(() => service.subscribe({ sessionIds: [id] }, A2, () => {}), { code: "NOT_SESSION_OWNER" });
    assert.equal(service.subscribe({}, A2, () => {}).sessions.length, 0);
    assert.deepEqual(a.session.openedBy, claudeCaller);
    assert.equal(Object.hasOwn(a.session, "adoptedFrom"), false);
    await restoresInPlace(service, a.session, A2);
    assert.deepEqual(a.session.openedBy, claudeCallerNew);

    // A session no Main is recorded for stays every Main's: restoring it adopts nothing.
    const shared = await open(service, MANAGEMENT);
    const sharedTask = await finished(service, shared, B);
    await restoresInPlace(service, shared.session, A2);
    assert.equal(Object.hasOwn(shared.session, "openedBy"), false);
    assert.equal(Object.hasOwn(shared.session, "adoptedFrom"), false);
    assert.equal(Object.hasOwn(service.taskStore.find(sharedTask), "boundOwner"), false);
    assert.equal((await service.call("task_get", { taskId: sharedTask }, A)).taskId, sharedTask);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("without a daemon to tell whether a Main is gone, no restore adopts another Main's session", async () => {
  const { service } = harness();
  try {
    const a = await open(service, A);
    await refusedAsBefore(service.call("session_restore", restoreArgs(a.session), A2));
    assert.deepEqual(a.session.openedBy, claudeCaller);
    assert.equal(Object.hasOwn(a.session, "adoptedFrom"), false);
    // Its own Main and management restore it in place, as before.
    await restoresInPlace(service, a.session, A_RESTARTED);
    await restoresInPlace(service, a.session, MANAGEMENT);
    assert.deepEqual(a.session.openedBy, claudeCaller);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("an adoption survives a restart through the snapshot; one a crash took back is taken again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-isolation-adopt-"));
  const statePath = join(directory, "state.json");
  const paths = statePaths(statePath);
  // Nobody is connected here, so every owner is gone. The long snapshot interval
  // keeps the debounced writer quiet between the adoption and the copy of the
  // files taken below: that gap is the crash window.
  const options = { statePath, isOwnerLive: () => false, snapshotIntervalMs: 60_000 };
  let ids = null;
  let crashed = null;
  try {
    const first = harness(options);
    try {
      await first.service.init();
      const a = await open(first.service, A);
      const done = await finished(first.service, a, A);
      const answered = await start(first.service, a.session, A);
      permission(a.worker, a.session, 1);
      await until(() => first.service.inbox.size === 1, "permission row");
      const [row] = first.service.inbox.values();
      await first.service.call("permission", { sessionId: a.session.id, requestId: 1, optionId: "allow-once" }, A);
      await until(() => a.session.status === "running", "answered");
      await finish(first.service, a.worker, answered);
      await first.service.flushPersist();
      ids = { session: a.session.id, done, answered, row: row.inboxId };
      await restoresInPlace(first.service, a.session, A2);
      assert.deepEqual(a.session.openedBy, claudeCallerNew);
      // What a crash right now would leave: no trace of the adoption.
      crashed = { snapshot: await readFile(paths.snapshot), wal: await readFile(paths.wal) };
    } finally {
      await first.service.shutdown();
    }

    const second = harness(options);
    try {
      await second.service.init();
      const session = second.service.store.get(ids.session);
      assert.deepEqual([session.openedBy, session.adoptedFrom], [claudeCallerNew, claudeCaller]);
      assert.equal((await second.service.call("task_get", { taskId: ids.done }, A2)).taskId, ids.done);
      await assert.rejects(second.service.call("task_get", { taskId: ids.done }, A), { code: "NOT_TASK_OWNER" });
      assert.deepEqual(await inboxIds(second.service, A2), [ids.row]);
      assert.deepEqual(await inboxIds(second.service, A), []);
      await second.service.call("session", { action: "close", sessionId: ids.session }, A2);
    } finally {
      await second.service.shutdown();
    }
    // The session is gone for good: only the bindings say whose its tasks and row are.
    const third = harness(options);
    try {
      await third.service.init();
      assert.equal(third.service.store.get(ids.session), undefined);
      assert.deepEqual(await taskIds(third.service, A2), sorted(ids.done, ids.answered));
      assert.deepEqual(await taskIds(third.service, A), []);
      assert.deepEqual(await inboxIds(third.service, A2), [ids.row]);
      assert.deepEqual(await inboxIds(third.service, A), []);
    } finally {
      await third.service.shutdown();
    }

    // The crash instead: the files as they were before the adoption reached a
    // snapshot. A is the owner again, which is accepted: the restore that
    // adopted it is idempotent, and A2 makes it again.
    await writeFile(paths.snapshot, crashed.snapshot, { mode: 0o600 });
    await writeFile(paths.wal, crashed.wal, { mode: 0o600 });
    await rm(paths.rotating, { force: true });
    const fourth = harness(options);
    try {
      await fourth.service.init();
      const session = fourth.service.store.get(ids.session);
      assert.deepEqual(session.openedBy, claudeCaller, "the adoption was lost with the crash");
      assert.equal(Object.hasOwn(session, "adoptedFrom"), false);
      await assert.rejects(fourth.service.call("task_get", { taskId: ids.done }, A2), { code: "NOT_TASK_OWNER" });
      const restored = await fourth.service.call("session_restore", restoreArgs(session), A2);
      assert.deepEqual([restored.sessionId, restored.status], [ids.session, "idle"]);
      assert.deepEqual([restored.openedBy, restored.adoptedFrom], [claudeCallerNew, claudeCaller]);
      assert.equal((await fourth.service.call("task_get", { taskId: ids.done }, A2)).taskId, ids.done);
    } finally {
      await fourth.service.shutdown();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A close is in the log at once, and no log record says who owns what: the
// startup re-binding works from the session row, which the close took away.
// So closing an adopted session, by Main or by session retention, first puts
// the adoption in a snapshot. Without that, a crash before the next one hands
// the session's tasks and inbox rows back to the Main it was taken from.
test("an adopted session closed or retired just before a crash leaves its tasks and inbox with the adopter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-isolation-adopt-close-"));
  try {
    for (const ending of ["close", "retention"]) {
      const statePath = join(directory, ending, "state.json");
      const paths = statePaths(statePath);
      // The long snapshot interval keeps the debounced writer quiet from the
      // adoption to the copy of the files below: that gap is the crash window.
      // Retention takes the session after a minute, its tasks after a day.
      const options = { statePath, isOwnerLive: () => false, snapshotIntervalMs: 60_000, sessionRetentionMs: 60_000 };
      let ids = null;
      let crashed = null;
      const first = harness(options);
      try {
        await first.service.init();
        const a = await open(first.service, A);
        const done = await finished(first.service, a, A);
        const answered = await start(first.service, a.session, A);
        permission(a.worker, a.session, 1);
        await until(() => first.service.inbox.size === 1, "permission row");
        const [row] = first.service.inbox.values();
        await first.service.call("permission", { sessionId: a.session.id, requestId: 1, optionId: "allow-once" }, A);
        await until(() => a.session.status === "running", "answered");
        await finish(first.service, a.worker, answered);
        // On disk from here: the session, its tasks and its row, all A's.
        await first.service.flushPersist();
        ids = { session: a.session.id, done, answered, row: row.inboxId };
        await restoresInPlace(first.service, a.session, A2);
        assert.deepEqual(a.session.openedBy, claudeCallerNew);
        if (ending === "close") {
          await first.service.call("session", { action: "close", sessionId: ids.session }, A2);
        } else {
          first.clock.now += 2 * 60_000;
          await first.service.runMaintenance();
        }
        assert.equal(first.service.store.get(ids.session), undefined, `${ending}: the session is gone`);
        // What a crash right now would leave: no snapshot written after this point.
        crashed = { snapshot: await readFile(paths.snapshot), wal: await readFile(paths.wal) };
      } finally {
        await first.service.shutdown();
      }
      await writeFile(paths.snapshot, crashed.snapshot, { mode: 0o600 });
      await writeFile(paths.wal, crashed.wal, { mode: 0o600 });
      await rm(paths.rotating, { force: true });

      const recovered = harness(options);
      try {
        await recovered.service.init();
        assert.equal(recovered.service.store.get(ids.session), undefined, `${ending}: the session stays gone`);
        assert.deepEqual(await taskIds(recovered.service, A2), sorted(ids.done, ids.answered), `${ending}: the adopter keeps the tasks`);
        assert.deepEqual(await taskIds(recovered.service, A), [], `${ending}: nothing went back to A`);
        // Retention takes a session's inbox rows with it; a close keeps them.
        assert.deepEqual(await inboxIds(recovered.service, A2), ending === "close" ? [ids.row] : [], `${ending}: the adopter's rows`);
        assert.deepEqual(await inboxIds(recovered.service, A), [], `${ending}: no row went back to A`);
      } finally {
        await recovered.service.shutdown();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// N4 (release-gate review): the synced snapshot that saves an adoption ahead of
// its close can fail, as when the state directory stops taking new files while
// the open log still takes appends. The close used to go on and log
// SESSION_CLOSED anyway, so a crash then removed the session row the adopter's
// tasks and inbox rows hung on, with nothing left to adopt again. Now the
// record stays, closed, with no SESSION_CLOSED behind it, persistence health
// says why, and the next drop tries again: maintenance, another close, a clean.

// A state directory that takes no new snapshot, and the same one healed.
function failSnapshots(service) {
  service.stateStore.writeSnapshot = () => {
    throw Object.assign(new Error("EACCES: permission denied, open 'state.snapshot.json.tmp'"), { code: "EACCES" });
  };
}

function healSnapshots(service) {
  delete service.stateStore.writeSnapshot;
}

async function closedInLog(paths, sessionId) {
  return (await readFile(paths.wal, "utf8")).split("\n").filter(Boolean)
    .map((line) => JSON.parse(line))
    .some((record) => record.type === "session.closed" && record.key === sessionId);
}

test("a close whose adoption cannot be saved keeps the record, closed and not live, until a later drop saves it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-isolation-adopt-unsaved-"));
  const statePath = join(directory, "state.json");
  const paths = statePaths(statePath);
  const { service } = harness({ statePath, isOwnerLive: () => false, snapshotIntervalMs: 60_000 });
  try {
    await service.init();
    const a = await open(service, A);
    const id = a.session.id;
    const done = await finished(service, a, A);
    const b = await open(service, B);
    await service.flushPersist();
    await restoresInPlace(service, a.session, A2);
    const asked = [];
    a.worker.request = async (method, params) => {
      asked.push([method, params?.sessionId]);
      return {};
    };
    failSnapshots(service);

    // A session nobody adopted closes as before: no snapshot needed, gone, logged.
    assert.deepEqual(await service.call("session", { action: "close", sessionId: b.session.id }, B), { ok: true, closed: b.session.id });
    assert.equal(service.store.get(b.session.id), undefined);
    assert.equal(await closedInLog(paths, b.session.id), true);
    assert.equal(service.persistError, null);

    // The adopted one answers as a close does and ends its worker session...
    assert.deepEqual(await service.call("session", { action: "close", sessionId: id }, A2), { ok: true, closed: id });
    assert.deepEqual(asked, [["session/close", b.session.acpSessionId], ["session/close", a.session.acpSessionId]]);
    // ...but its record stays, closed, with no SESSION_CLOSED behind it, and
    // persistence health says why.
    assert.equal(service.store.get(id), a.session);
    assert.deepEqual([a.session.status, a.session.client], ["closed", null]);
    assert.equal(await closedInLog(paths, id), false);
    assert.match(service.persistError, /EACCES/);

    // It reads as closed, and nothing acts on it as a session.
    assert.equal((await service.call("session", { action: "get", sessionId: id }, A2)).status, "closed");
    assert.deepEqual((await service.call("session", { action: "check", sessionId: id }, A2)).caveats, ["session_closed"]);
    await assert.rejects(service.call("run", { sessionId: id, prompt: "go", waitMs: 0 }, A2), { code: "SESSION_CLOSED" });
    await assert.rejects(service.call("cancel", { sessionId: id }, A2), { code: "SESSION_CLOSED" });
    for (const action of ["pin", "unpin", "workspace_diff"]) {
      await assert.rejects(service.call("session", { action, sessionId: id }, A2), { code: "SESSION_CLOSED" }, action);
    }
    // Its task stays the adopter's meanwhile.
    assert.deepEqual(await taskIds(service, A2), [done]);
    assert.deepEqual(await taskIds(service, A), []);

    // Another close, a clean and maintenance each try again, and keep it while
    // the snapshot still fails; the close still answers as a close.
    assert.deepEqual(await service.call("session", { action: "close", sessionId: id }, A2), { ok: true, closed: id });
    assert.deepEqual((await service.call("session", { action: "clean", sessionId: id }, A2)).closed, []);
    await service.runMaintenance();
    assert.equal(service.store.get(id), a.session);
    assert.equal(await closedInLog(paths, id), false);
    assert.equal(asked.length, 2, "the worker session was closed once");

    // Once the directory takes the snapshot again, maintenance saves the
    // adoption, drops the record and logs its close.
    healSnapshots(service);
    await service.runMaintenance();
    assert.equal(service.store.get(id), undefined);
    assert.equal(await closedInLog(paths, id), true);
    assert.equal(service.persistError, null);
    assert.deepEqual(await taskIds(service, A2), [done]);
    assert.deepEqual(await taskIds(service, A), []);
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention that cannot save an adoption keeps the record closed, and a clean that can drops it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-isolation-adopt-unsaved-retention-"));
  const statePath = join(directory, "state.json");
  const paths = statePaths(statePath);
  const { service, clock } = harness({ statePath, isOwnerLive: () => false, snapshotIntervalMs: 60_000, sessionRetentionMs: 60_000 });
  try {
    await service.init();
    const a = await open(service, A);
    const id = a.session.id;
    const done = await finished(service, a, A);
    await service.flushPersist();
    await restoresInPlace(service, a.session, A2);
    failSnapshots(service);
    clock.now += 2 * 60_000;
    await service.runMaintenance();
    assert.equal(service.store.get(id), a.session, "retention let it go, and had to keep it");
    assert.deepEqual([a.session.status, a.session.client], ["closed", null]);
    assert.equal(await closedInLog(paths, id), false);
    assert.match(service.persistError, /EACCES/);
    await assert.rejects(service.call("run", { sessionId: id, prompt: "go", waitMs: 0 }, A2), { code: "SESSION_CLOSED" });

    healSnapshots(service);
    // Not closed a second time: only the drop was owed.
    assert.deepEqual((await service.call("session", { action: "clean", sessionId: id }, A2)).closed, []);
    assert.equal(service.store.get(id), undefined);
    assert.equal(await closedInLog(paths, id), true);
    assert.deepEqual(await taskIds(service, A2), [done]);
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("a crash while the record is kept brings the session back for the adopter to take again, tasks and rows included", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-isolation-adopt-unsaved-crash-"));
  const statePath = join(directory, "state.json");
  const paths = statePaths(statePath);
  const options = { statePath, isOwnerLive: () => false, snapshotIntervalMs: 60_000 };
  let ids = null;
  let crashed = null;
  try {
    const first = harness(options);
    try {
      await first.service.init();
      const a = await open(first.service, A);
      const done = await finished(first.service, a, A);
      const answered = await start(first.service, a.session, A);
      permission(a.worker, a.session, 1);
      await until(() => first.service.inbox.size === 1, "permission row");
      const [row] = first.service.inbox.values();
      await first.service.call("permission", { sessionId: a.session.id, requestId: 1, optionId: "allow-once" }, A);
      await until(() => a.session.status === "running", "answered");
      await finish(first.service, a.worker, answered);
      await first.service.flushPersist();
      ids = { session: a.session.id, done, answered, row: row.inboxId };
      await restoresInPlace(first.service, a.session, A2);
      failSnapshots(first.service);
      await first.service.call("session", { action: "close", sessionId: ids.session }, A2);
      assert.equal(first.service.store.get(ids.session)?.status, "closed");
      // What a crash right now would leave: the log holds no close of it.
      crashed = { snapshot: await readFile(paths.snapshot), wal: await readFile(paths.wal) };
    } finally {
      healSnapshots(first.service);
      await first.service.shutdown();
    }
    await writeFile(paths.snapshot, crashed.snapshot, { mode: 0o600 });
    await writeFile(paths.wal, crashed.wal, { mode: 0o600 });
    await rm(paths.rotating, { force: true });

    const recovered = harness(options);
    try {
      await recovered.service.init();
      // The adoption never reached a snapshot, so A holds the session again,
      // and it is there to take: before, its close was logged and it was gone.
      const session = recovered.service.store.get(ids.session);
      assert.ok(session, "the session survived the crash");
      assert.deepEqual([session.status, session.openedBy], ["disconnected", claudeCaller]);
      const restored = await recovered.service.call("session_restore", restoreArgs(session), A2);
      assert.deepEqual([restored.openedBy, restored.adoptedFrom], [claudeCallerNew, claudeCaller]);
      assert.deepEqual(await taskIds(recovered.service, A2), sorted(ids.done, ids.answered));
      assert.deepEqual(await taskIds(recovered.service, A), []);
      assert.deepEqual(await inboxIds(recovered.service, A2), [ids.row]);
      assert.deepEqual(await inboxIds(recovered.service, A), []);
      // And the close goes through now.
      await recovered.service.call("session", { action: "close", sessionId: ids.session }, A2);
      assert.equal(recovered.service.store.get(ids.session), undefined);
      assert.deepEqual(await taskIds(recovered.service, A2), sorted(ids.done, ids.answered));
    } finally {
      await recovered.service.shutdown();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a kept record a later snapshot holds is dropped by the first maintenance after a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-isolation-adopt-unsaved-restart-"));
  const statePath = join(directory, "state.json");
  const paths = statePaths(statePath);
  const options = { statePath, isOwnerLive: () => false, snapshotIntervalMs: 60_000 };
  let ids = null;
  let crashed = null;
  try {
    const first = harness(options);
    try {
      await first.service.init();
      const a = await open(first.service, A);
      ids = { session: a.session.id, done: await finished(first.service, a, A) };
      await first.service.flushPersist();
      await restoresInPlace(first.service, a.session, A2);
      failSnapshots(first.service);
      await first.service.call("session", { action: "close", sessionId: ids.session }, A2);
      // The directory takes snapshots again, and the debounced writer gets there
      // before any drop does: its snapshot holds the record, closed and adopted.
      healSnapshots(first.service);
      await first.service.flushPersist();
      assert.equal(first.service.persistError, null);
      assert.equal(await closedInLog(paths, ids.session), false);
      crashed = { snapshot: await readFile(paths.snapshot), wal: await readFile(paths.wal) };
    } finally {
      healSnapshots(first.service);
      await first.service.shutdown();
    }
    await writeFile(paths.snapshot, crashed.snapshot, { mode: 0o600 });
    await writeFile(paths.wal, crashed.wal, { mode: 0o600 });
    await rm(paths.rotating, { force: true });

    const recovered = harness(options);
    try {
      await recovered.service.init();
      assert.equal(recovered.service.store.get(ids.session), undefined, "the startup maintenance owed it the drop");
      assert.equal(await closedInLog(paths, ids.session), true);
      assert.deepEqual(await taskIds(recovered.service, A2), [ids.done]);
      assert.deepEqual(await taskIds(recovered.service, A), []);
    } finally {
      await recovered.service.shutdown();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a session the log brings back newer than its tasks' snapshot still takes them along", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-isolation-adopt-wal-"));
  const statePath = join(directory, "state.json");
  const paths = statePaths(statePath);
  const options = { statePath, isOwnerLive: () => false, snapshotIntervalMs: 60_000 };
  let ids = null;
  try {
    const first = harness(options);
    try {
      await first.service.init();
      const a = await open(first.service, A);
      const answered = await start(first.service, a.session, A);
      permission(a.worker, a.session, 1);
      await until(() => first.service.inbox.size === 1, "permission row");
      const [row] = first.service.inbox.values();
      await first.service.call("permission", { sessionId: a.session.id, requestId: 1, optionId: "allow-once" }, A);
      await until(() => a.session.status === "running", "answered");
      await finish(first.service, a.worker, answered);
      ids = { session: a.session.id, acpSessionId: a.session.acpSessionId, cwd: a.session.cwd, answered, row: row.inboxId };
    } finally {
      await first.service.shutdown();
    }

    // After a restart the session needs its worker back, and this worker fails
    // to come: the failed restore journals the whole session checkpoint, new
    // owner included, while the tasks' and row's bindings wait for a snapshot.
    let crashed = null;
    const failing = harness({
      ...options,
      createClient: (_provider, clientOptions) => Object.assign(new FakeWorker(clientOptions), {
        sessionRestore: async () => { throw new Error("worker would not resume"); }
      })
    });
    try {
      await failing.service.init();
      await assert.rejects(
        failing.service.call("session_restore", { provider: "claude", acpSessionId: ids.acpSessionId, cwd: ids.cwd }, A2),
        /worker would not resume/
      );
      assert.deepEqual(failing.service.store.get(ids.session).openedBy, claudeCallerNew, "adopted, then the restore failed");
      crashed = { snapshot: await readFile(paths.snapshot), wal: await readFile(paths.wal) };
    } finally {
      await failing.service.shutdown();
    }
    await writeFile(paths.snapshot, crashed.snapshot, { mode: 0o600 });
    await writeFile(paths.wal, crashed.wal, { mode: 0o600 });
    await rm(paths.rotating, { force: true });

    const recovered = harness(options);
    try {
      await recovered.service.init();
      const session = recovered.service.store.get(ids.session);
      assert.deepEqual([session.openedBy, session.adoptedFrom], [claudeCallerNew, claudeCaller], "replayed from the log");
      assert.deepEqual(recovered.service.taskStore.find(ids.answered).boundOwner, claudeCallerNew);
      assert.deepEqual(recovered.service.inbox.get(ids.row).sessionOpenedBy, claudeCallerNew);
      await recovered.service.call("session", { action: "close", sessionId: ids.session }, A2);
      assert.deepEqual(await taskIds(recovered.service, A2), [ids.answered]);
      assert.deepEqual(await taskIds(recovered.service, A), []);
      assert.deepEqual(await inboxIds(recovered.service, A2), [ids.row]);
      assert.deepEqual(await inboxIds(recovered.service, A), []);
    } finally {
      await recovered.service.shutdown();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a task every Main can read names only the linked tasks its reader can see", async () => {
  const { service } = harness();
  try {
    const a = await open(service, A);
    const shared = await open(service, MANAGEMENT);
    const privateA = await finished(service, a, A);
    const sharedInput = await finished(service, shared, B);
    // On the shared session, so B reads it; it links a task of A's own.
    const linked = await finished(service, shared, A, { parentTaskId: privateA, inputTaskIds: [sharedInput, privateA] });
    const onlyPrivate = await finished(service, shared, A, { inputTaskIds: [privateA] });
    const links = (task) => [task.parentTaskId ?? null, task.inputTaskIds ?? null];
    const read = async (context, taskId = linked) => links(await service.call("task_get", { taskId }, context));

    assert.deepEqual(await read(A), [privateA, [sharedInput, privateA]]);
    assert.deepEqual(await read(B), [null, [sharedInput]], "A's own task is not B's to learn of");
    assert.deepEqual(await read(B, onlyPrivate), [null, null], "nothing left to name: the key is absent");
    assert.deepEqual(await read(MANAGEMENT), [privateA, [sharedInput, privateA]]);
    assert.deepEqual(await read(OBSERVER), [privateA, [sharedInput, privateA]]);
    for (const args of [{}, { limit: 50 }]) {
      const listed = (await service.call("task_list", args, B)).tasks.find((task) => task.taskId === linked);
      assert.deepEqual(links(listed), [null, [sharedInput]], JSON.stringify(args));
    }
    // A link to a task that is gone stays readable to the Main that declared it only.
    service.taskStore.remove(privateA);
    assert.deepEqual(await read(A), [privateA, [sharedInput, privateA]]);
    assert.deepEqual(await read(B), [null, [sharedInput]]);
    assert.deepEqual(await read(MANAGEMENT), [privateA, [sharedInput, privateA]]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

// Retries a call until its outcome is no longer the one that says "not yet".
async function settled(call, done, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = await call().then((value) => ({ value }), (error) => ({ error }));
    if (done(outcome)) return outcome;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("over the control socket a Main's connections and subscriptions keep its sessions; then a new Main adopts them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-isolation-adopt-daemon-"));
  let daemon = null;
  const clients = [];
  try {
    let connect;
    ({ daemon, connect } = await mockpermDaemon(directory, clients));
    // No pid: the Worker ancestry check is not what this is about.
    const callerA = { provider: "claude", sessionId: "claude-session-a", instanceId: "mcp-a" };
    const callerA2 = { provider: "claude", sessionId: "claude-session-a2", instanceId: "mcp-a2" };
    const recorded = (caller) => ({ ...caller, pid: null });
    const mainA = connect({ caller: callerA });
    const watchA = connect({ caller: callerA });
    const observerA = connect({ access: "observer", caller: callerA });
    const mainA2 = connect({ caller: callerA2 });
    const management = connect();
    const opened = await mainA.call("session_open", { provider: "mockperm", cwd: directory, permissionPolicy: "read_only" });
    const restore = { provider: "mockperm", acpSessionId: opened.acpSessionId, cwd: directory };
    const refused = (promise) => assert.rejects(promise, (error) => {
      assert.equal(error.code, "NOT_SESSION_OWNER");
      assert.equal(Object.hasOwn(error, "details"), false);
      return true;
    });

    // A's connection alone keeps its session A's.
    await refused(mainA2.call("session_restore", restore));
    await watchA.subscribe({ sessionIds: [opened.sessionId] }, () => {});
    await observerA.call("session", { action: "list" });
    // A's other connection, the one holding its subscription, still speaks for it.
    mainA.close();
    await refused(mainA2.call("session_restore", restore));
    // Then only an observer claiming to be A is left, and that is nobody's Main.
    watchA.close();
    const { error: adopted } = await settled(
      () => mainA2.call("session_restore", restore),
      ({ error }) => error?.code !== "NOT_SESSION_OWNER",
      "A2 to adopt A's session"
    );
    assert.equal(adopted?.code, "INVALID_ARGUMENT", "its worker is still connected: already registered");
    assert.deepEqual(adopted.details, { sessionId: opened.sessionId, acpSessionId: opened.acpSessionId });
    const got = await mainA2.call("session", { action: "get", sessionId: opened.sessionId });
    assert.deepEqual([got.openedBy, got.adoptedFrom], [recorded(callerA2), recorded(callerA)]);
    assert.equal((await mainA2.call("poll", { sessionId: opened.sessionId, cursor: 0 })).sessionId, opened.sessionId);

    // A, back on a new connection, has lost it, and cannot take it back while A2 is here.
    const backA = connect({ caller: callerA });
    await refused(backA.call("session", { action: "get", sessionId: opened.sessionId }));
    await refused(backA.call("session_restore", restore));
    assert.deepEqual((await management.call("session", { action: "get", sessionId: opened.sessionId })).openedBy, recorded(callerA2));
  } finally {
    for (const client of clients) client.close();
    await daemon?.stop?.();
    await rm(directory, { recursive: true, force: true });
  }
});
