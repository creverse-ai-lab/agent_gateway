// 1.8.0 W6: per-Main isolation. Every Main on a machine shares one rootId, so
// the root alone kept no Main out of another's work. A control request that
// names its caller comes from a front-door Main and reaches only that Main's
// sessions, the tasks and inbox rows that follow them, and whatever no Main is
// recorded for. Management (no caller: AgenLynk, the admin CLI, pre-1.6 front
// doors) and observers keep the whole root. Most cases drive an in-process fake
// worker on an injected clock; the last one runs the real daemon.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isVisibleTo, requesterOf } from "../src/access.js";
import { GatewayService } from "../src/gateway-service.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { startDaemon } from "./helpers/daemon-harness.js";

const permissionAgent = fileURLToPath(new URL("./mock-permission-agent.js", import.meta.url));
const ROOT = "main-root";
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const TERMINAL = ["completed", "failed", "cancelled"];
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

// The smallest worker the service accepts. Turns resolve only when told to.
class FakeWorker {
  constructor(options) {
    this.options = options;
    this.config = { modelScope: "session" };
    this.alive = false;
    this.initResult = null;
    this.stderr = "";
    this.handlers = new Map();
    this.turns = [];
  }

  async start() {
    this.alive = true;
    this.initResult = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } };
    return this.initResult;
  }

  async sessionNew() {
    FakeWorker.opened += 1;
    return { sessionId: `fake-${FakeWorker.opened}`, configOptions: [] };
  }

  async sessionRestore({ sessionId }) { return { sessionId, configOptions: [] }; }
  onSessionUpdate(sessionId, handler) { this.handlers.set(sessionId, handler); }
  clearSession(sessionId) { this.handlers.delete(sessionId); }
  emit(sessionId, update) { this.handlers.get(sessionId)?.(update); }
  sessionPrompt() { return new Promise((resolve, reject) => this.turns.push({ resolve, reject })); }
  cancelSession() {}
  pendingSessionInput() { return { permissions: 0, elicitations: 0 }; }
  async respondPermission() {}
  respondElicitation() {}
  async setSessionConfigOption() { return { configOptions: [] }; }
  async request() { return {}; }
  async stop() { this.alive = false; }
}
FakeWorker.opened = 0;

function harness(options = {}) {
  const clock = { now: EPOCH };
  const service = new GatewayService({
    gcIntervalMs: 0,
    now: () => clock.now,
    createClient: (_provider, clientOptions) => new FakeWorker(clientOptions),
    ...options
  });
  return { service, clock };
}

async function open(service, context) {
  const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, context);
  const session = service.requireSession(opened.sessionId);
  return { session, worker: session.client };
}

async function until(predicate, description) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

// For what crosses a real socket: polls on the timer, not on the event loop.
async function eventually(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function start(service, session, context) {
  const ack = await service.call("run", { sessionId: session.id, prompt: "go", waitMs: 0 }, context);
  assert.equal(ack.status, "working");
  return ack.taskId;
}

async function finish(service, worker, taskId) {
  worker.turns.at(-1).resolve({ stopReason: "end_turn" });
  await until(() => TERMINAL.includes(service.taskStore.find(taskId)?.status), `task ${taskId} terminal`);
}

async function finished(service, { session, worker }, context) {
  const taskId = await start(service, session, context);
  await finish(service, worker, taskId);
  return taskId;
}

function permission(worker, session, requestId) {
  worker.emit(session.acpSessionId, {
    sessionUpdate: "permission_request", requestId,
    toolCall: { toolCallId: `t${requestId}`, title: "Edit", kind: "edit" },
    options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]
  });
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

test("over the control socket each front door's caller confines its calls and its subscriptions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-isolation-daemon-"));
  let daemon = null;
  const clients = [];
  try {
    // The permission mock mints a distinct ACP session id per session/new.
    const providersPath = join(directory, "providers.json");
    await writeFile(providersPath, JSON.stringify({
      version: 1,
      providers: { mockperm: { command: process.execPath, args: [permissionAgent], permissionPolicy: "read_only" } }
    }));
    daemon = await startDaemon({ directory, env: { ACP_GATEWAY_PROVIDERS: providersPath } });
    const connect = (options = {}) => {
      const client = new GatewayRpcClient({
        socketPath: daemon.socketPath, token: daemon.token, rootId: daemon.rootId, statePath: daemon.statePath,
        autoStart: false, ...options
      });
      clients.push(client);
      return client;
    };
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
