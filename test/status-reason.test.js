// 1.7.0 W3: why a session is in its status, when its worker last spoke, and
// whether a running turn has gone quiet. Every case drives an in-process fake
// worker on an injected clock, so a timestamp in an assertion is exact rather
// than "recent enough".
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DURABLE_EVENT_TYPES, GatewayService, STATUS_REASONS } from "../src/gateway-service.js";
import { SETTING_DEFINITIONS, validateSetting } from "../src/settings.js";

const MAIN = { rootId: "main-a" };
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const READ_MODEL_KEYS = ["statusReason", "statusChangedAt", "lastWorkerActivityAt", "stallSuspected"];
const iso = (ms) => new Date(ms).toISOString();

// The smallest worker the service accepts. Turns resolve only when the test
// says so, and a pending permission/elicitation is whatever the test sets.
class FakeWorker {
  constructor(options, factory) {
    this.options = options;
    this.factory = factory;
    this.config = { modelScope: "session" };
    this.alive = false;
    this.initResult = null;
    this.stderr = "";
    this.handlers = new Map();
    this.turns = [];
    this.pending = { permissions: 0, elicitations: 0 };
  }

  async start() {
    this.alive = true;
    this.initResult = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } };
    return this.initResult;
  }

  async sessionNew() {
    this.factory.opened += 1;
    return { sessionId: `fake-${this.factory.opened}`, configOptions: configOptions() };
  }

  async sessionRestore({ sessionId }) {
    await this.factory.restoreGate;
    if (this.factory.restoreError) throw this.factory.restoreError;
    return { sessionId, configOptions: configOptions() };
  }

  onSessionUpdate(sessionId, handler) { this.handlers.set(sessionId, handler); }
  clearSession(sessionId) { this.handlers.delete(sessionId); }
  emit(sessionId, update) { this.handlers.get(sessionId)?.(update); }

  sessionPrompt() {
    return new Promise((resolve, reject) => this.turns.push({ resolve, reject }));
  }

  cancelSession() {}
  pendingSessionInput() { return { ...this.pending }; }
  async respondPermission() { this.pending.permissions = 0; }
  respondElicitation() { this.pending.elicitations = 0; }

  // What a real adapter does: the answer to a config call arrives with a
  // config_option_update notification alongside it.
  async setSessionConfigOption({ sessionId }) {
    this.emit(sessionId, { sessionUpdate: "config_option_update", configOptions: configOptions() });
    return { configOptions: configOptions() };
  }

  async request() { return {}; }
  async stop() { this.alive = false; }

  crash() {
    this.alive = false;
    this.options.onExit?.(new Error("worker crashed"));
  }
}

function configOptions() {
  return [{
    type: "select", id: "thought_level", name: "Thought level", category: "thought_level", currentValue: "low",
    options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }]
  }];
}

function harness(options = {}) {
  const clock = { now: EPOCH };
  const factory = { opened: 0, workers: [], restoreGate: null, restoreError: null };
  const service = new GatewayService({
    gcIntervalMs: 0,
    now: () => clock.now,
    createClient: (_provider, clientOptions) => {
      const worker = new FakeWorker(clientOptions, factory);
      factory.workers.push(worker);
      return worker;
    },
    ...options
  });
  return { service, clock, factory };
}

async function open(service, context = MAIN) {
  const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, context);
  const session = service.requireSession(opened.sessionId);
  return { opened, session, worker: session.client };
}

async function until(predicate, description) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function reasonOf(session) {
  return [session.status, session.statusReason, session.statusChangedAt];
}

// Idle unload keys off the last turn's completedAt, which is on the injected
// clock; a session that never ran a turn falls back to a wall-clock updatedAt.
async function finishTurn(service, session, worker) {
  await service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN);
  worker.turns.at(-1).resolve({ stopReason: "end_turn" });
  await until(() => session.status === "idle", "turn end");
}

async function get(service, sessionId, context = MAIN) {
  return service.call("session", { action: "get", sessionId }, context);
}

test("every #setStatus call site passes a listed reason, and every listed reason is spoken somewhere", async () => {
  const source = await readFile(new URL("../src/gateway-service.js", import.meta.url), "utf8");
  const calls = source.match(/this\.#setStatus\(/g) ?? [];
  const literal = [...source.matchAll(/this\.#setStatus\(\s*[^,()]+,[^,]+,\s*"([a-z_]+)"\s*\)/g)].map((match) => match[1]);
  assert.equal(literal.length, calls.length, "a call site passes a computed or missing reason");
  // The two paths that set a status without #setStatus: registration and init.
  const direct = [...source.matchAll(/statusReason: [^\n]*?"([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set([...literal, ...direct])].sort(), [...STATUS_REASONS].sort());
  assert.ok(Object.isFrozen(STATUS_REASONS));
});

test("a turn records turn_start then turn_end, and a same-status call refreshes neither field", async () => {
  const { service, clock } = harness();
  try {
    const { opened, session, worker } = await open(service);
    assert.deepEqual(reasonOf(session), ["idle", "session_created", iso(EPOCH)]);
    assert.equal(opened.statusReason, "session_created");

    clock.now += 1_000;
    await service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN);
    assert.deepEqual(reasonOf(session), ["running", "turn_start", iso(EPOCH + 1_000)]);

    // Mirroring "running" onto a running session is a no-op, not a new status.
    clock.now += 1_000;
    service.syncSessionInputState(session);
    assert.deepEqual(reasonOf(session), ["running", "turn_start", iso(EPOCH + 1_000)]);

    clock.now += 1_000;
    worker.turns[0].resolve({ stopReason: "end_turn" });
    await until(() => session.status === "idle", "turn end");
    assert.deepEqual(reasonOf(session), ["idle", "turn_end", iso(EPOCH + 3_000)]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a failed turn records turn_failed", async () => {
  const { service, clock } = harness();
  try {
    const { session, worker } = await open(service);
    await service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN);
    clock.now += 500;
    worker.turns[0].reject(new Error("model refused"));
    await until(() => session.status === "error", "turn failure");
    assert.deepEqual(reasonOf(session), ["error", "turn_failed", iso(EPOCH + 500)]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("worker requests record their own type; Main's answer records input_state_sync", async () => {
  const { service, clock } = harness();
  try {
    const { session, worker } = await open(service);
    await service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN);

    clock.now += 1_000;
    worker.pending.permissions = 1;
    worker.emit(session.acpSessionId, {
      sessionUpdate: "permission_request", requestId: 1,
      toolCall: { toolCallId: "t1", title: "Edit", kind: "edit" },
      options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]
    });
    await until(() => session.status === "waiting_permission", "permission wait");
    assert.deepEqual(reasonOf(session), ["waiting_permission", "permission_request", iso(EPOCH + 1_000)]);

    // A second request while already waiting keeps the first wait's time.
    clock.now += 1_000;
    worker.emit(session.acpSessionId, {
      sessionUpdate: "permission_request", requestId: 2,
      toolCall: { toolCallId: "t2", title: "Edit", kind: "edit" },
      options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]
    });
    await until(() => session.events.filter((event) => event.type === "permission_request").length === 2, "second request");
    assert.deepEqual(reasonOf(session), ["waiting_permission", "permission_request", iso(EPOCH + 1_000)]);

    clock.now += 1_000;
    await service.call("permission", { sessionId: session.id, requestId: 1, optionId: "allow-once" }, MAIN);
    assert.deepEqual(reasonOf(session), ["running", "input_state_sync", iso(EPOCH + 3_000)]);

    clock.now += 1_000;
    worker.pending.elicitations = 1;
    worker.emit(session.acpSessionId, {
      sessionUpdate: "elicitation_request", requestId: 3, mode: "form", message: "Which?", requestedSchema: { type: "object" }
    });
    await until(() => session.status === "waiting_input", "input wait");
    assert.deepEqual(reasonOf(session), ["waiting_input", "elicitation_request", iso(EPOCH + 4_000)]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("cancel records cancel_requested, and the turn it ends records turn_end on cancelled", async () => {
  const { service, clock } = harness();
  try {
    const { session, worker } = await open(service);
    await service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN);
    clock.now += 1_000;
    const cancelled = await service.call("cancel", { sessionId: session.id }, MAIN);
    assert.deepEqual([cancelled.status, cancelled.statusReason, cancelled.statusChangedAt],
      ["cancelling", "cancel_requested", iso(EPOCH + 1_000)]);
    clock.now += 1_000;
    worker.turns[0].resolve({ stopReason: "cancelled" });
    await until(() => session.status === "cancelled", "cancelled turn");
    assert.deepEqual(reasonOf(session), ["cancelled", "turn_end", iso(EPOCH + 2_000)]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("an orphaned turn cancelled by the Gateway records orphan_cancelled", async () => {
  const { service, clock } = harness({ orphanGraceMs: 10 });
  try {
    service.attachRoot(MAIN.rootId);
    const { session } = await open(service);
    await service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN);
    service.detachRoot(MAIN.rootId);
    clock.now += 11;
    await service.runMaintenance();
    assert.deepEqual(reasonOf(session), ["cancelled", "orphan_cancelled", iso(EPOCH + 11)]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("idle unload and a provider crash both end disconnected, and statusReason tells them apart", async () => {
  const { service, clock } = harness({ idleUnloadMs: 60_000 });
  try {
    const idle = await open(service);
    await service.call("prompt", { sessionId: idle.session.id, prompt: "go" }, MAIN);
    idle.worker.turns[0].resolve({ stopReason: "end_turn" });
    await until(() => idle.session.status === "idle", "first turn end");

    clock.now += 60_000;
    await service.runMaintenance();
    assert.deepEqual(reasonOf(idle.session), ["disconnected", "session_unloaded", iso(EPOCH + 60_000)]);
    // The unload leaves evidence for an inspection read, but it is not an
    // obligation: not durable, and not on a default poll.
    assert.equal(DURABLE_EVENT_TYPES.has("session_unloaded"), false);
    assert.equal(idle.session.events.at(-1).type, "session_unloaded");
    const quiet = await service.call("poll", { sessionId: idle.session.id, cursor: 0 }, MAIN);
    assert.deepEqual(quiet.events.map((event) => event.type), []);
    const asked = await service.call("poll", { sessionId: idle.session.id, cursor: 0, eventTypes: ["session_unloaded"] }, MAIN);
    assert.deepEqual(asked.events.map((event) => event.type), ["session_unloaded"]);

    const crashed = await open(service);
    await service.call("prompt", { sessionId: crashed.session.id, prompt: "go" }, MAIN);
    clock.now += 1_000;
    crashed.worker.crash();
    await until(() => crashed.session.status === "disconnected", "provider exit");
    assert.deepEqual(reasonOf(crashed.session), ["disconnected", "provider_disconnected", iso(EPOCH + 61_000)]);
    // The failed turn that follows a crash is the same status, so it does not
    // overwrite the reason that explains it.
    crashed.worker.turns[0].reject(new Error("ACP client stopped"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(crashed.session.statusReason, "provider_disconnected");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("an idle unload leaves its event without moving a never-run session's retention start", async () => {
  const { service } = harness();
  try {
    const { session } = await open(service);
    const before = session.updatedAt;
    assert.equal(session.completedAt ?? null, null, "idle and retention clocks fall back on updatedAt");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await service.unloadSession(session), true);
    assert.deepEqual([session.status, session.statusReason], ["disconnected", "session_unloaded"]);
    assert.equal(session.events.at(-1).type, "session_unloaded");
    assert.equal(session.updatedAt, before);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a restore records session_restore_start, then session_restored or session_restore_failed", async () => {
  const { service, clock, factory } = harness({ idleUnloadMs: 1 });
  try {
    const { session, worker } = await open(service);
    await finishTurn(service, session, worker);
    clock.now += 10;
    await service.runMaintenance();
    assert.equal(session.statusReason, "session_unloaded");

    let release;
    factory.restoreGate = new Promise((resolve) => { release = resolve; });
    clock.now += 10;
    const listed = service.call("config", { sessionId: session.id, action: "list" }, MAIN);
    await until(() => session.status === "restoring", "restore start");
    assert.deepEqual(reasonOf(session), ["restoring", "session_restore_start", iso(EPOCH + 20)]);
    clock.now += 10;
    release();
    await listed;
    assert.deepEqual(reasonOf(session), ["idle", "session_restored", iso(EPOCH + 30)]);

    await finishTurn(service, session, factory.workers.at(-1));
    clock.now += 10;
    await service.runMaintenance();
    assert.equal(session.statusReason, "session_unloaded");
    factory.restoreGate = null;
    factory.restoreError = new Error("resume refused");
    clock.now += 10;
    await assert.rejects(service.call("config", { sessionId: session.id, action: "list" }, MAIN), /resume refused/);
    assert.deepEqual(reasonOf(session), ["unavailable", "session_restore_failed", iso(EPOCH + 50)]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a refused transition records nothing", async () => {
  const { service, clock, factory } = harness();
  try {
    const { session } = await open(service);
    clock.now += 1_000;
    // idle -> waiting_permission is not a legal move: a request with no turn.
    factory.workers[0].emit(session.acpSessionId, {
      sessionUpdate: "permission_request", requestId: 9, toolCall: { toolCallId: "t9" }, options: []
    });
    await until(() => session._illegalTransitions === 1, "refused transition");
    assert.deepEqual(reasonOf(session), ["idle", "session_created", iso(EPOCH)]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("reason, its time and worker activity survive a restart; live records read daemon_restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-status-reason-"));
  const statePath = join(directory, "state.json");
  let unloadedAt;
  let first;
  let unloaded;
  try {
    const before = harness({ statePath, idleUnloadMs: 60_000, artifactRoot: join(directory, "artifacts") });
    try {
      await before.service.init();
      const idle = await open(before.service);
      unloaded = idle.session.id;
      await finishTurn(before.service, idle.session, idle.worker);
      before.clock.now += 60_000;
      await before.service.runMaintenance();
      unloadedAt = iso(before.clock.now);

      const live = await open(before.service);
      first = live.session.id;
      await before.service.call("prompt", { sessionId: first, prompt: "go" }, MAIN);
      before.clock.now += 1_000;
      live.worker.emit(live.session.acpSessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
      live.worker.turns[0].resolve({ stopReason: "end_turn" });
      await until(() => live.session.status === "idle", "turn end");
      await before.service.flushPersist();

      const saved = JSON.parse(await readFile(statePath, "utf8"));
      const record = saved.sessions.find((item) => item.id === first);
      assert.equal(record.statusReason, "turn_end");
      assert.equal(record.statusChangedAt, iso(EPOCH + 61_000));
      assert.equal(record.lastWorkerActivityAt, iso(EPOCH + 61_000));
    } finally {
      await before.service.shutdown().catch(() => {});
    }

    const after = harness({ statePath, artifactRoot: join(directory, "artifacts") });
    after.clock.now = EPOCH + 90_000;
    try {
      await after.service.init();
      const [restarted, kept] = [after.service.requireSession(first), after.service.requireSession(unloaded)];
      assert.deepEqual(reasonOf(restarted), ["disconnected", "daemon_restart", iso(EPOCH + 90_000)]);
      assert.equal(restarted.lastWorkerActivityAt, iso(EPOCH + 61_000));
      // Already disconnected before the restart: the same-status rule keeps the
      // reason that says it was an unload, not a crash.
      assert.deepEqual(reasonOf(kept), ["disconnected", "session_unloaded", unloadedAt]);
      const listed = (await after.service.call("session", { action: "list" }, MAIN)).sessions;
      assert.deepEqual(listed.map((item) => item.statusReason).sort(), ["daemon_restart", "session_unloaded"]);
    } finally {
      await after.service.shutdown().catch(() => {});
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lastWorkerActivityAt moves only on worker updates, never on poll, subscribe, get or config", async () => {
  const { service, clock } = harness();
  try {
    const { session, worker } = await open(service);
    const touchEverything = async () => {
      clock.now += 1_000;
      await service.call("poll", { sessionId: session.id, cursor: 0 }, MAIN);
      await service.call("poll", { sessionId: session.id, cursor: 0, responseProfile: "diagnostic" }, MAIN);
      await get(service, session.id);
      await service.call("session", { action: "list" }, MAIN);
      service.subscribe({ sessionIds: [session.id] }, MAIN, () => {});
      await service.call("config", { sessionId: session.id, action: "list" }, MAIN);
      if (session.status === "idle") {
        await service.call("config", { sessionId: session.id, action: "set", configId: "thought_level", value: "high" }, MAIN);
      }
    };

    await touchEverything();
    assert.equal(session.lastWorkerActivityAt, null, "a config call's own notification is not worker activity");

    await service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN);
    await touchEverything();
    assert.equal(session.lastWorkerActivityAt, null, "starting a turn is Gateway bookkeeping");
    // Echoes, advertisements, config/mode answers, accounting and metadata are
    // not the worker working: a stuck worker can keep streaming usage.
    for (const sessionUpdate of [
      "user_message_chunk", "available_commands_update", "current_mode_update", "config_option_update",
      "usage_update", "session_info_update"
    ]) {
      worker.emit(session.acpSessionId, { sessionUpdate, content: { type: "text", text: "x" } });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.lastWorkerActivityAt, null);

    for (const sessionUpdate of [
      "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan", "plan_update",
      "permission_request", "elicitation_request"
    ]) {
      clock.now += 1_000;
      // Worker requests count on arrival, before the mailbox admits them.
      worker.emit(session.acpSessionId, {
        sessionUpdate, toolCallId: "t1", requestId: 7, mode: "form",
        content: { type: "text", text: "x" }, toolCall: { toolCallId: "t1" }, options: []
      });
      assert.equal(session.lastWorkerActivityAt, iso(clock.now), sessionUpdate);
    }
    const spoke = session.lastWorkerActivityAt;
    await touchEverything();
    assert.equal(session.lastWorkerActivityAt, spoke);
    assert.equal((await get(service, session.id)).lastWorkerActivityAt, spoke);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("stallSuspected flips exactly at stallHintMs, only while running, and only on read models", async () => {
  const { service, clock } = harness({ stallHintMs: 60_000 });
  try {
    const { session, worker } = await open(service);
    await service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN);
    clock.now += 1_000;
    worker.emit(session.acpSessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
    const spokeAt = clock.now;

    clock.now = spokeAt + 59_999;
    assert.equal((await get(service, session.id)).stallSuspected, false);
    clock.now = spokeAt + 60_000;
    const read = await get(service, session.id);
    assert.equal(read.stallSuspected, true);
    assert.equal(read.status, "running", "a hint never changes the status");
    assert.equal((await service.call("session", { action: "list" }, MAIN)).sessions[0].stallSuspected, true);

    const diagnostic = await service.call("poll", { sessionId: session.id, cursor: 0, responseProfile: "diagnostic" }, MAIN);
    assert.equal(diagnostic.stallSuspected, true);
    assert.equal(diagnostic.silentForMs, 60_000);
    assert.equal(diagnostic.statusReason, "turn_start");
    assert.equal(diagnostic.lastWorkerActivityAt, iso(spokeAt));
    assert.equal(diagnostic.statusChangedAt, iso(EPOCH));
    for (const responseProfile of [undefined, "compact"]) {
      const poll = await service.call("poll", { sessionId: session.id, cursor: 0, ...(responseProfile ? { responseProfile } : {}) }, MAIN);
      for (const key of [...READ_MODEL_KEYS, "silentForMs"]) {
        assert.equal(Object.hasOwn(poll, key), false, `${responseProfile ?? "current"} poll must not carry ${key}`);
      }
    }

    // Waiting on Main is not a stall, however long it lasts.
    worker.pending.permissions = 1;
    worker.emit(session.acpSessionId, {
      sessionUpdate: "permission_request", requestId: 1, toolCall: { toolCallId: "t1" },
      options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]
    });
    await until(() => session.status === "waiting_permission", "permission wait");
    clock.now += 10 * 60_000;
    assert.equal((await get(service, session.id)).stallSuspected, false);
    const waiting = await service.call("poll", { sessionId: session.id, cursor: 0, responseProfile: "diagnostic" }, MAIN);
    assert.deepEqual([waiting.stallSuspected, waiting.silentForMs], [false, null]);

    // The silence clock restarts when Main answers, not at the turn start.
    await service.call("permission", { sessionId: session.id, requestId: 1, optionId: "allow-once" }, MAIN);
    const answeredAt = clock.now;
    clock.now = answeredAt + 59_999;
    assert.equal((await get(service, session.id)).stallSuspected, false);
    clock.now = answeredAt + 60_000;
    assert.equal((await get(service, session.id)).stallSuspected, true);

    worker.pending.elicitations = 1;
    worker.emit(session.acpSessionId, {
      sessionUpdate: "elicitation_request", requestId: 2, mode: "form", message: "Which?", requestedSchema: { type: "object" }
    });
    await until(() => session.status === "waiting_input", "input wait");
    clock.now += 10 * 60_000;
    assert.equal((await get(service, session.id)).stallSuspected, false, "waiting_input is never a stall");
    await service.call("answer", { sessionId: session.id, requestId: 2, action: "decline" }, MAIN);
    assert.equal(session.status, "running");

    await service.call("cancel", { sessionId: session.id }, MAIN);
    clock.now += 10 * 60_000;
    assert.equal((await get(service, session.id)).stallSuspected, false, "cancelling is never a stall");
    assert.equal(session.status, "cancelling");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("setup raises sessions_stall_suspected for this Main's stalled sessions, and only while there are any", async () => {
  const { service, clock } = harness({ stallHintMs: 60_000 });
  const codes = (setup) => setup.alerts.map((alert) => alert.code);
  try {
    const quiet = await open(service);
    const busy = await open(service);
    await open(service, { rootId: "main-b" });
    await service.call("prompt", { sessionId: quiet.session.id, prompt: "go" }, MAIN);
    await service.call("prompt", { sessionId: busy.session.id, prompt: "go" }, MAIN);
    assert.equal(codes(await service.call("setup", {}, MAIN)).includes("sessions_stall_suspected"), false);

    clock.now += 60_000;
    busy.worker.emit(busy.session.acpSessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run", kind: "execute" });
    for (const mode of ["full", "summary"]) {
      const alert = (await service.call("setup", { mode }, MAIN)).alerts.find((item) => item.code === "sessions_stall_suspected");
      assert.equal(alert.level, "info");
      assert.equal(alert.count, 1);
      assert.deepEqual(alert.sessionIds, [quiet.session.id]);
      assert.match(alert.message, /does not cancel/);
    }
    assert.equal(codes(await service.call("setup", {}, { rootId: "main-b" })).includes("sessions_stall_suspected"), false,
      "another Main's sessions are not this Main's to act on");

    quiet.worker.emit(quiet.session.acpSessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "." } });
    assert.equal(codes(await service.call("setup", {}, MAIN)).includes("sessions_stall_suspected"), false,
      "the alert goes away once the worker speaks");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("stallHintMs is a documented setting with a five-minute default and a sane floor", () => {
  const definition = SETTING_DEFINITIONS.find((item) => item.id === "stallHintMs");
  assert.equal(definition.defaultValue, 300_000);
  assert.equal(definition.environment, "ACP_GATEWAY_STALL_HINT_MS");
  assert.equal(definition.group, "observability");
  assert.equal(validateSetting("stallHintMs", 10_000), 10_000);
  assert.throws(() => validateSetting("stallHintMs", 9_999), { code: "CONFIG_INVALID" });
  assert.equal(new GatewayService({ gcIntervalMs: 0 }).observability.stallHintMs, 300_000);
});
