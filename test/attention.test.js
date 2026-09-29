// 1.7.0 W5: the attention view. What waits on a Main (pending worker requests,
// with how long and whether that is stale) and what finished without reaching
// the Main that started it (unseen terminal tasks). Every Main on a machine
// shares one rootId, so "seen" belongs to the creating caller: two Mains on one
// root never clear each other's updates. Every case drives an in-process fake
// worker on an injected clock.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isReadOnlyCall } from "../src/access.js";
import { ACK_SKIP_REASONS, isTaskCreator } from "../src/attention.js";
import { GatewayService } from "../src/gateway-service.js";
import { SETTING_DEFINITIONS, validateSetting } from "../src/settings.js";
import { decodeRecord, statePaths, WAL_TYPES } from "../src/state-store.js";

const ROOT = "main-root";
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const TERMINAL = ["completed", "failed", "cancelled"];
// Two Mains on one machine: same root, different callers.
const claudeCaller = { provider: "claude", sessionId: "claude-session-a", pid: 4242, instanceId: "mcp-a" };
const codexCaller = { provider: "codex", sessionId: "codex-thread-b", pid: 5151, instanceId: "mcp-b" };
const A = { rootId: ROOT, caller: claudeCaller };
const B = { rootId: ROOT, caller: codexCaller };
const LEGACY = { rootId: ROOT };
const OBSERVER = { rootId: ROOT, access: "observer" };
const OTHER_ROOT = { rootId: "main-other", caller: claudeCaller };
// The 1.6 publicTask shape, which a task with no caller keeps exactly.
const LEGACY_TASK_KEYS = [
  "createdAt", "lastUpdatedAt", "origin", "pollInterval", "sessionId", "status", "statusMessage", "taskId", "ttl", "turnId"
];
const UPDATE_KEYS = ["taskId", "sessionId", "provider", "status", "statusMessage", "lastUpdatedAt"];
const RESTART_MESSAGE = "Gateway restarted before this task completed";

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

async function open(service, context = A) {
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

// Starts a run and returns at once (waitMs 0 is a handoff, never a delivery).
async function start(service, session, context) {
  const ack = await service.call("run", { sessionId: session.id, prompt: "go", waitMs: 0 }, context);
  assert.equal(ack.status, "working");
  return ack.taskId;
}

async function finish(service, worker, taskId) {
  worker.turns.at(-1).resolve({ stopReason: "end_turn" });
  await until(() => TERMINAL.includes(service.taskStore.find(taskId)?.status), `task ${taskId} terminal`);
}

// A finished task nobody has collected yet.
async function finished(service, session, worker, context) {
  const taskId = await start(service, session, context);
  await finish(service, worker, taskId);
  return taskId;
}

const seenAt = (service, taskId) => service.taskStore.find(taskId)?.seenAt ?? null;
const attention = (service, context, args = {}) => service.call("inbox", { action: "attention", ...args }, context);
const updateIds = async (service, context) => (await attention(service, context)).updates.map((row) => row.taskId);

function permission(worker, session, requestId) {
  worker.emit(session.acpSessionId, {
    sessionUpdate: "permission_request", requestId,
    toolCall: { toolCallId: `t${requestId}`, title: "Edit", kind: "edit" },
    options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]
  });
}

test("the creator rule: session ids decide when both sides have one, else the front door instance", () => {
  assert.equal(isTaskCreator(claudeCaller, claudeCaller), true);
  assert.equal(isTaskCreator(claudeCaller, codexCaller), false);
  // One Codex process, two threads: the thread decides, not the process.
  assert.equal(isTaskCreator(codexCaller, { ...codexCaller, sessionId: "codex-thread-c" }), false);
  // A thread id on one side only falls back to the process that sent it.
  const processOnly = { ...codexCaller, sessionId: null };
  assert.equal(isTaskCreator(processOnly, codexCaller), true);
  assert.equal(isTaskCreator(codexCaller, processOnly), true);
  assert.equal(isTaskCreator(processOnly, { ...processOnly, instanceId: "mcp-z" }), false);
  // A task no Main is recorded for is anyone's; a requester with no caller
  // proves nothing and takes only those.
  assert.equal(isTaskCreator(null, claudeCaller), true);
  assert.equal(isTaskCreator(null, null), true);
  assert.equal(isTaskCreator(claudeCaller, null), false);
  assert.deepEqual([...ACK_SKIP_REASONS], ["unknown_task", "not_task_owner", "not_terminal", "not_creator"]);
});

test("a task records the Main that created it; a task with no caller keeps the 1.6 shape", async () => {
  const { service } = harness();
  try {
    const { session, worker } = await open(service);
    const mine = await finished(service, session, worker, A);
    const got = await service.call("task_get", { taskId: mine }, LEGACY);
    assert.deepEqual(got.caller, claudeCaller, "normalized, as the session records it");
    assert.deepEqual((await service.call("task_list", {}, LEGACY)).tasks[0].caller, claudeCaller);

    const legacy = await finished(service, session, worker, LEGACY);
    const bare = await service.call("task_get", { taskId: legacy }, LEGACY);
    assert.deepEqual(Object.keys(bare).sort(), LEGACY_TASK_KEYS);
    // seenAt is bookkeeping: no task read carries it, even once it is set.
    await service.call("task_result", { taskId: legacy }, LEGACY);
    assert.ok(seenAt(service, legacy));
    assert.deepEqual(Object.keys(await service.call("task_get", { taskId: legacy }, LEGACY)).sort(), LEGACY_TASK_KEYS);
    assert.equal(Object.hasOwn(await service.call("task_get", { taskId: mine }, A), "seenAt"), false);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("run, task_result and a terminal poll mark seen for the creator only, and deliver the same bytes either way", async () => {
  const { service, clock } = harness();
  try {
    const { session, worker } = await open(service);
    const events = [];
    service.subscribe({}, A, (event) => events.push(event));

    // agent_acp_run attach.
    const attached = await finished(service, session, worker, A);
    const toOther = await service.call("run", { taskId: attached }, B);
    const toObserver = await service.call("task_result", { taskId: attached }, OBSERVER);
    // None of the reads deliver the result to its Main.
    await service.call("task_get", { taskId: attached }, A);
    await service.call("task_list", {}, A);
    await service.call("task_list", { status: "completed", limit: 5 }, A);
    await service.call("session", { action: "get", sessionId: session.id }, A);
    await service.call("session", { action: "list" }, A);
    await service.call("inbox", { action: "list" }, A);
    await service.call("inbox", { action: "list", limit: 5 }, A);
    await attention(service, A);
    await service.call("poll", { sessionId: session.id, cursor: 0 }, OBSERVER);
    assert.ok(events.length > 0, "the subscription saw the turn");
    assert.equal(seenAt(service, attached), null, "another Main, an observer, reads and subscriptions never mark seen");
    clock.now += 1_000;
    const toCreator = await service.call("run", { taskId: attached }, A);
    assert.equal(seenAt(service, attached), iso(EPOCH + 1_000));
    assert.deepEqual(toCreator, toOther, "marking seen does not touch the delivered envelope");
    assert.deepEqual(toCreator, toObserver);
    clock.now += 1_000;
    assert.deepEqual(await service.call("run", { taskId: attached }, A), toCreator);
    assert.equal(seenAt(service, attached), iso(EPOCH + 1_000), "the first delivery is the one recorded");

    // agent_acp_run start mode, waiting through to the terminal envelope.
    const waiting = service.call("run", { sessionId: session.id, prompt: "go", waitMs: 5_000 }, A);
    await until(() => session.status === "running", "run started");
    worker.turns.at(-1).resolve({ stopReason: "end_turn" });
    const ran = await waiting;
    assert.equal(ran.status, "idle");
    assert.equal(seenAt(service, ran.taskId), iso(EPOCH + 2_000));

    // tasks/result.
    const viaResult = (await service.call("task_prompt", { sessionId: session.id, prompt: "go" }, A)).taskId;
    await finish(service, worker, viaResult);
    const first = await service.call("task_result", { taskId: viaResult }, B);
    assert.equal(seenAt(service, viaResult), null);
    const second = await service.call("task_result", { taskId: viaResult }, A);
    assert.ok(seenAt(service, viaResult));
    assert.deepEqual(second, first);

    // A poll that carries the terminal result of the session's last task.
    const viaPoll = await finished(service, session, worker, A);
    const otherPoll = await service.call("poll", { sessionId: session.id, cursor: 0 }, B);
    await service.call("poll", { sessionId: session.id, cursor: 0, includeResult: false }, A);
    assert.equal(seenAt(service, viaPoll), null, "no result, no delivery");
    const creatorPoll = await service.call("poll", { sessionId: session.id, cursor: 0 }, A);
    assert.ok(seenAt(service, viaPoll));
    assert.deepEqual(creatorPoll, otherPoll);

    // A later direct prompt owns the session result: polling it does not
    // deliver the earlier task.
    const earlier = await finished(service, session, worker, A);
    await service.call("prompt", { sessionId: session.id, prompt: "go" }, A);
    worker.turns.at(-1).resolve({ stopReason: "end_turn" });
    await until(() => session.status === "idle", "direct prompt end");
    await service.call("poll", { sessionId: session.id, cursor: 0 }, A);
    assert.equal(seenAt(service, earlier), null);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("two Mains on one root keep their own updates", async () => {
  const { service, clock } = harness();
  try {
    const first = await open(service, A);
    const second = await open(service, B);
    const aTask = await finished(service, first.session, first.worker, A);
    clock.now += 1_000;
    const bTask = await finished(service, second.session, second.worker, B);

    assert.deepEqual(await updateIds(service, A), [aTask]);
    assert.deepEqual(await updateIds(service, B), [bTask]);
    // Nobody to scope to: an observer or a caller-less front door sees the root.
    assert.deepEqual(await updateIds(service, OBSERVER), [aTask, bTask]);
    assert.deepEqual(await updateIds(service, LEGACY), [aTask, bTask]);
    assert.deepEqual((await attention(service, OTHER_ROOT)).updates, [], "another root sees none of them");

    // B collecting A's task (it may: same root) does not clear it for A.
    await service.call("task_result", { taskId: aTask }, B);
    assert.deepEqual(await updateIds(service, A), [aTask]);
    await service.call("run", { taskId: aTask }, A);
    assert.deepEqual(await updateIds(service, A), []);
    assert.deepEqual(await updateIds(service, B), [bTask], "A's delivery is not B's");
    assert.deepEqual(await updateIds(service, OBSERVER), [bTask]);

    // Another thread of B's own Codex process is a different Main.
    const otherThread = { rootId: ROOT, caller: { ...codexCaller, sessionId: "codex-thread-c" } };
    assert.deepEqual(await updateIds(service, otherThread), []);
    await service.call("task_result", { taskId: bTask }, otherThread);
    assert.deepEqual(await updateIds(service, B), [bTask]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a task no Main is recorded for is everyone's update, and any control delivery clears it", async () => {
  const { service, clock } = harness();
  try {
    const { session, worker } = await open(service, LEGACY);
    const legacy = await finished(service, session, worker, LEGACY);
    assert.deepEqual(await updateIds(service, A), [legacy]);
    assert.deepEqual(await updateIds(service, B), [legacy]);
    await service.call("task_result", { taskId: legacy }, OBSERVER);
    assert.equal(seenAt(service, legacy), null, "an observer is never a delivery");
    clock.now += 1_000;
    await service.call("task_result", { taskId: legacy }, B);
    assert.equal(seenAt(service, legacy), iso(EPOCH + 1_000));
    assert.deepEqual(await updateIds(service, A), []);

    // A caller-less requester delivers a caller-less task too, but never one
    // that names its Main.
    const another = await finished(service, session, worker, LEGACY);
    const aTask = await finished(service, session, worker, A);
    await service.call("task_result", { taskId: another }, LEGACY);
    await service.call("task_result", { taskId: aTask }, LEGACY);
    assert.ok(seenAt(service, another));
    assert.equal(seenAt(service, aTask), null);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("attention pages both lists oldest first under one cursor, caps the page and counts the full sets", async () => {
  const { service, clock } = harness({ attentionStaleMs: 60_000 });
  try {
    const { session } = await open(service);
    // Fabricated through the live maps, as the characterization tests do: a
    // hundred-plus real worker requests would only test the fake worker.
    const row = (index, overrides = {}) => ({
      inboxId: `inbox-${String(index).padStart(3, "0")}`,
      ownerRootId: ROOT,
      sessionId: session.id,
      turnId: "turn-x",
      type: "permission_request",
      status: "pending",
      createdAt: iso(EPOCH + index * 1_000),
      resolvedAt: null,
      resolution: null,
      requestId: index,
      toolCall: { toolCallId: `t${index}`, title: "Edit", kind: "edit", rawInput: "x".repeat(64) },
      options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
      ...overrides
    });
    for (let index = 0; index < 105; index += 1) service.inbox.set(row(index).inboxId, row(index));
    service.inbox.set("inbox-answered", row(200, { inboxId: "inbox-answered", status: "answered" }));
    service.inbox.set("inbox-foreign", row(201, { inboxId: "inbox-foreign", ownerRootId: "main-other" }));
    const task = (index, overrides = {}) => ({
      taskId: `task-${index}`, sessionId: session.id, ownerRootId: ROOT, turnId: null, status: "completed",
      ttl: null, pollInterval: 1_000, createdAt: iso(EPOCH), lastUpdatedAt: iso(EPOCH + index * 1_000),
      statusMessage: "end_turn", origin: "run", caller: claudeCaller, result: { ok: true }, ...overrides
    });
    for (const index of [3, 1, 2]) service.tasks.set(`task-${index}`, task(index));
    service.tasks.set("task-seen", task(4, { taskId: "task-seen", seenAt: iso(EPOCH) }));
    service.tasks.set("task-working", task(5, { taskId: "task-working", status: "working" }));
    service.tasks.set("task-b", task(6, { taskId: "task-b", caller: codexCaller }));
    service.tasks.set("task-cut", task(7, {
      taskId: "task-cut", status: "failed", statusMessage: RESTART_MESSAGE,
      interruption: { reason: "gateway_restarted", executionOutcome: "unknown", at: iso(EPOCH) }
    }));
    clock.now = EPOCH + 100_000;

    const one = await attention(service, A);
    assert.deepEqual(Object.keys(one), ["ok", "needsMain", "updates", "counts", "nextCursor"]);
    assert.equal(one.needsMain.length, 50, "default page");
    assert.equal(one.needsMain[0].inboxId, "inbox-000");
    // Rows at EPOCH + 0..40s are at least 60s old at EPOCH + 100s.
    assert.deepEqual(one.counts, { needsMain: 105, stale: 41, updates: 4 });
    // Summary projection plus ageMs and stale: no options, message or schema.
    const [oldest] = one.needsMain;
    assert.deepEqual(oldest.toolCall, { toolCallId: "t0", title: "Edit", kind: "edit" });
    assert.equal(Object.hasOwn(oldest, "options"), false);
    assert.equal(oldest.ageMs, 100_000);
    assert.equal(oldest.stale, true);
    assert.equal(one.needsMain[41].stale, false);
    assert.deepEqual(one.updates.map((item) => item.taskId), ["task-1", "task-2", "task-3", "task-cut"]);
    assert.deepEqual(Object.keys(one.updates[0]), UPDATE_KEYS);
    assert.deepEqual(one.updates[0], {
      taskId: "task-1", sessionId: session.id, provider: "claude", status: "completed",
      statusMessage: "end_turn", lastUpdatedAt: iso(EPOCH + 1_000)
    });
    assert.deepEqual(one.updates[3].interruption, { reason: "gateway_restarted", executionOutcome: "unknown", at: iso(EPOCH) });
    assert.equal(JSON.stringify(one.updates).includes("\"result\""), false, "no result bodies");

    assert.equal((await attention(service, A, { limit: 1_000 })).needsMain.length, 100, "hard cap");
    assert.equal((await attention(service, A, { limit: 0 })).needsMain.length, 1);

    // Walk: each list keeps its own place, an exhausted list stays exhausted,
    // and something new behind the cursor shows up on the next page.
    const seen = { needsMain: [], updates: [] };
    let page = await attention(service, A, { limit: 40 });
    const pages = [];
    for (;;) {
      pages.push(page);
      seen.needsMain.push(...page.needsMain.map((item) => item.inboxId));
      seen.updates.push(...page.updates.map((item) => item.taskId));
      assert.deepEqual(page.counts.needsMain, 105);
      if (pages.length === 1) service.tasks.set("task-late", task(8, { taskId: "task-late" }));
      if (page.nextCursor == null) break;
      page = await attention(service, A, { limit: 40, cursor: page.nextCursor });
    }
    assert.deepEqual(pages.map((item) => [item.needsMain.length, item.updates.length]), [[40, 4], [40, 1], [25, 0]]);
    assert.deepEqual(seen.needsMain, [...Array(105).keys()].map((index) => `inbox-${String(index).padStart(3, "0")}`));
    assert.deepEqual(seen.updates, ["task-1", "task-2", "task-3", "task-cut", "task-late"]);

    const listCursor = (await service.call("inbox", { action: "list", limit: 1 }, A)).nextCursor;
    await assert.rejects(attention(service, A, { cursor: listCursor }), { code: "INVALID_ARGUMENT" });
    await assert.rejects(attention(service, A, { cursor: "not-a-cursor" }), { code: "INVALID_ARGUMENT" });
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("stale flips exactly at attentionStaleMs; setup raises both counts only when non-zero, for the asking Main", async () => {
  const { service, clock } = harness({ attentionStaleMs: 60_000 });
  const alert = (setup, code) => setup.alerts.find((item) => item.code === code) ?? null;
  try {
    const { session, worker } = await open(service);
    for (const mode of ["full", "summary"]) {
      const setup = await service.call("setup", { mode }, A);
      assert.equal(alert(setup, "attention_stale_requests"), null);
      assert.equal(alert(setup, "attention_unseen_updates"), null);
    }
    const taskId = await start(service, session, A);
    permission(worker, session, 1);
    await until(() => service.inbox.size === 1, "permission row");

    clock.now = EPOCH + 59_999;
    let view = await attention(service, A);
    assert.deepEqual([view.needsMain[0].ageMs, view.needsMain[0].stale, view.counts.stale], [59_999, false, 0]);
    assert.equal(alert(await service.call("setup", {}, A), "attention_stale_requests"), null);

    clock.now = EPOCH + 60_000;
    view = await attention(service, A);
    assert.deepEqual([view.needsMain[0].ageMs, view.needsMain[0].stale, view.counts.stale], [60_000, true, 1]);
    for (const mode of ["full", "summary"]) {
      const stale = alert(await service.call("setup", { mode }, A), "attention_stale_requests");
      assert.deepEqual([stale.level, stale.count], ["warning", 1]);
      assert.match(stale.message, /agent_acp_inbox/);
    }
    // A request belongs to the root: every Main on it is asked. Another root is not.
    assert.equal(alert(await service.call("setup", {}, B), "attention_stale_requests").count, 1);
    assert.equal(alert(await service.call("setup", {}, OTHER_ROOT), "attention_stale_requests"), null);

    await service.call("permission", { sessionId: session.id, requestId: 1, optionId: "allow-once" }, A);
    await until(() => session.status === "running", "answered");
    await finish(service, worker, taskId);
    for (const mode of ["full", "summary"]) {
      const setup = await service.call("setup", { mode }, A);
      assert.equal(alert(setup, "attention_stale_requests"), null);
      assert.deepEqual(
        [alert(setup, "attention_unseen_updates").level, alert(setup, "attention_unseen_updates").count], ["info", 1]
      );
    }
    assert.equal(alert(await service.call("setup", {}, B), "attention_unseen_updates"), null, "not B's task");
    await service.call("run", { taskId }, A);
    assert.equal(alert(await service.call("setup", {}, A), "attention_unseen_updates"), null);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("attentionStaleMs is a documented setting with a ten-minute default", () => {
  const definition = SETTING_DEFINITIONS.find((item) => item.id === "attentionStaleMs");
  assert.equal(definition.defaultValue, 600_000);
  assert.equal(definition.environment, "ACP_GATEWAY_ATTENTION_STALE_MS");
  assert.equal(definition.group, "observability");
  assert.throws(() => validateSetting("attentionStaleMs", 9_999), { code: "CONFIG_INVALID" });
  assert.equal(new GatewayService({ gcIntervalMs: 0 }).observability.attentionStaleMs, 600_000);
});

test("ack marks only what the requester may take, says why it skipped the rest, and is idempotent", async () => {
  const { service, clock } = harness();
  try {
    const first = await open(service, A);
    const second = await open(service, B);
    const legacySession = await open(service, LEGACY);
    const foreign = await open(service, OTHER_ROOT);
    const aTask = await finished(service, first.session, first.worker, A);
    const bTask = await finished(service, second.session, second.worker, B);
    const legacy = await finished(service, legacySession.session, legacySession.worker, LEGACY);
    const theirs = await finished(service, foreign.session, foreign.worker, OTHER_ROOT);
    const working = await start(service, first.session, A);

    assert.equal(isReadOnlyCall("inbox", { action: "attention" }), true);
    assert.equal(isReadOnlyCall("inbox", { action: "ack", taskIds: [aTask] }), false);
    await assert.rejects(service.call("inbox", { action: "ack", taskIds: [aTask] }, OBSERVER), { code: "OBSERVER_ACCESS_DENIED" });
    for (const taskIds of [undefined, [], "task-x", [""], Array.from({ length: 101 }, (_, index) => `task-${index}`)]) {
      await assert.rejects(service.call("inbox", { action: "ack", taskIds }, A), { code: "INVALID_ARGUMENT" });
    }

    clock.now += 1_000;
    const acked = await service.call("inbox", {
      action: "ack", taskIds: [aTask, bTask, legacy, working, theirs, "task-missing", aTask]
    }, A);
    assert.deepEqual(acked, {
      ok: true,
      acked: [aTask, legacy],
      skipped: [
        { taskId: bTask, reason: "not_creator" },
        { taskId: working, reason: "not_terminal" },
        { taskId: theirs, reason: "not_task_owner" },
        { taskId: "task-missing", reason: "unknown_task" }
      ]
    });
    assert.equal(seenAt(service, aTask), iso(EPOCH + 1_000));
    assert.equal(seenAt(service, bTask), null);
    assert.deepEqual(await updateIds(service, B), [bTask]);

    clock.now += 1_000;
    assert.deepEqual((await service.call("inbox", { action: "ack", taskIds: [aTask] }, A)).acked, [aTask]);
    assert.equal(seenAt(service, aTask), iso(EPOCH + 1_000), "a second ack changes nothing");
    // A caller-less requester cannot clear a task that names its Main.
    assert.deepEqual((await service.call("inbox", { action: "ack", taskIds: [bTask] }, LEGACY)).skipped,
      [{ taskId: bTask, reason: "not_creator" }]);
    assert.deepEqual((await service.call("inbox", { action: "ack", taskIds: [bTask] }, B)).acked, [bTask]);
    first.worker.turns.at(-1).resolve({ stopReason: "end_turn" });
    await until(() => TERMINAL.includes(service.taskStore.find(working)?.status), "working task end");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("list and get keep their shapes; attention and ack leave inbox rows untouched", async () => {
  const { service } = harness();
  try {
    const { session, worker } = await open(service);
    const taskId = await start(service, session, A);
    permission(worker, session, 1);
    await until(() => service.inbox.size === 1, "permission row");
    const read = async () => {
      const unpaged = await service.call("inbox", { action: "list" }, A);
      const paged = await service.call("inbox", { action: "list", limit: 10 }, A);
      const summary = await service.call("inbox", { action: "list", detail: "summary" }, A);
      const got = await service.call("inbox", { action: "get", inboxId: unpaged.items[0].inboxId }, A);
      return { unpaged, paged, summary, got };
    };
    const before = await read();
    assert.deepEqual(Object.keys(before.unpaged), ["ok", "items"]);
    assert.deepEqual(Object.keys(before.paged), ["ok", "items", "nextCursor"]);
    assert.equal(Object.hasOwn(before.unpaged.items[0], "ageMs"), false);
    assert.equal(Object.hasOwn(before.unpaged.items[0], "stale"), false);
    await attention(service, A);
    await service.call("inbox", { action: "ack", taskIds: [taskId] }, A);
    assert.deepEqual(await read(), before);
    await service.call("permission", { sessionId: session.id, requestId: 1, optionId: "allow-once" }, A);
    await until(() => session.status === "running", "answered");
    await finish(service, worker, taskId);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("caller and seenAt survive a restart; an interrupted task comes back as an update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-attention-"));
  const statePath = join(directory, "state.json");
  const artifactRoot = join(directory, "artifacts");
  const paths = statePaths(statePath);
  let ids = null;
  let sessionId = null;
  let wal = null;
  try {
    const before = harness({ statePath, artifactRoot });
    try {
      await before.service.init();
      const { session, worker } = await open(before.service);
      sessionId = session.id;
      const collected = await finished(before.service, session, worker, A);
      before.clock.now += 1_000;
      await before.service.call("task_result", { taskId: collected }, A);
      before.clock.now += 1_000;
      const unread = await finished(before.service, session, worker, A);
      before.clock.now += 1_000;
      const cut = await start(before.service, session, A);
      ids = { collected, unread, cut };
      await before.service.flushPersist();
      // The log as a killed daemon would leave it, seen record included.
      wal = await readFile(paths.wal);
      const seen = readFileSync(paths.wal, "utf8").split("\n").filter(Boolean)
        .map((line) => decodeRecord(Buffer.from(line, "utf8")))
        .filter((record) => record.type === WAL_TYPES.TASK_SEEN);
      assert.deepEqual(seen.map((record) => [record.key, record.payload]), [[collected, { seenAt: iso(EPOCH + 1_000) }]]);
    } finally {
      await before.service.shutdown();
    }

    // Twice: from the snapshot a clean shutdown wrote, then from the WAL alone.
    for (const source of ["snapshot", "wal"]) {
      if (source === "wal") {
        await writeFile(paths.wal, wal, { mode: 0o600 });
        await rm(paths.snapshot, { force: true });
      }
      const after = harness({ statePath, artifactRoot });
      after.clock.now = EPOCH + 10_000;
      try {
        await after.service.init();
        assert.equal(seenAt(after.service, ids.collected), iso(EPOCH + 1_000), source);
        assert.deepEqual((await after.service.call("task_get", { taskId: ids.unread }, A)).caller, claudeCaller, source);
        const view = await attention(after.service, A);
        assert.deepEqual(view.updates.map((row) => row.taskId), [ids.unread, ids.cut], source);
        assert.deepEqual(view.updates[1].interruption?.reason, "gateway_restarted", source);
        assert.equal(view.updates[1].statusMessage, RESTART_MESSAGE, source);
        assert.deepEqual(await updateIds(after.service, B), [], `${source}: still A's, not the root's`);
        // A poll after a restart carries an empty session result, not the
        // interruption, so it delivers nothing.
        await after.service.call("poll", { sessionId, cursor: 0 }, A);
        assert.equal(seenAt(after.service, ids.cut), null, source);
        if (source === "snapshot") {
          await after.service.call("task_result", { taskId: ids.cut }, A);
          assert.equal(seenAt(after.service, ids.cut), iso(EPOCH + 10_000));
        }
      } finally {
        await after.service.shutdown();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
