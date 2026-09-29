// 1.7.0 W7: a session whose worker keeps failing to come back is not restored
// over and over behind Main's back. After maxConsecutiveRestoreFailures failed
// restores in a row the Gateway stops (SESSION_QUARANTINED, with Main's
// options) and does nothing else; Main's explicit restore is still allowed. A
// provider that keeps failing to start is only reported (provider_degraded).
// Every case drives an in-process fake worker on an injected clock.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ERROR_CODES, GatewayError } from "../src/errors.js";
import { CHECK_CAVEATS, GatewayService } from "../src/gateway-service.js";
import { POLL_OMITTED_SESSION_KEYS } from "../src/sessions.js";
import { SETTING_DEFINITIONS, validateSetting } from "../src/settings.js";

const MAIN = { rootId: "main-a" };
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const RESUME = { sessionCapabilities: { resume: {}, close: {} } };
const iso = (ms) => new Date(ms).toISOString();
const refused = () => new GatewayError(ERROR_CODES.ACP_ERROR, "Resource not found");

// The smallest worker the service accepts, with every contact counted so a
// test can prove a refused call made none. Turns resolve only when told to.
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
  }

  async start() {
    this.factory.starts += 1;
    if (this.factory.startError) throw this.factory.startError;
    this.alive = true;
    this.initResult = { protocolVersion: 1, agentCapabilities: structuredClone(this.factory.capabilities) };
    return this.initResult;
  }

  async sessionNew() {
    this.factory.opened += 1;
    return { sessionId: `fake-${this.factory.opened}`, configOptions: [] };
  }

  async sessionRestore({ method, sessionId }) {
    this.factory.restores.push(method);
    if (this.factory.restoreError) throw this.factory.restoreError;
    return { sessionId, configOptions: [] };
  }

  onSessionUpdate(sessionId, handler) { this.handlers.set(sessionId, handler); }
  clearSession(sessionId) { this.handlers.delete(sessionId); }

  sessionPrompt() {
    this.factory.prompts += 1;
    return new Promise((resolve, reject) => this.turns.push({ resolve, reject }));
  }

  cancelSession() { this.factory.cancels += 1; }
  pendingSessionInput() { return { permissions: 0, elicitations: 0 }; }
  async setSessionConfigOption() {
    this.factory.configCalls += 1;
    return { configOptions: [] };
  }

  async request() { return {}; }
  async stop() { this.alive = false; }

  crash() {
    this.alive = false;
    this.options.onExit?.(new Error("worker crashed"));
  }
}

function harness(options = {}) {
  const clock = { now: EPOCH };
  const factory = {
    opened: 0, starts: 0, restores: [], workers: [], prompts: 0, cancels: 0, configCalls: 0,
    capabilities: RESUME, restoreError: null, startError: null
  };
  const service = new GatewayService({
    gcIntervalMs: 0,
    now: () => clock.now,
    createClient: (_provider, clientOptions) => {
      const worker = new FakeWorker(clientOptions, factory);
      factory.workers.push(worker);
      return worker;
    },
    providerDetector: async () => [{ id: "claude", agentInstalled: true, adapterInstalled: true }],
    ...options
  });
  return { service, clock, factory };
}

async function open(service, args = {}) {
  const opened = await service.call(
    "session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask", ...args }, MAIN
  );
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

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "acp-quarantine-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Every way a provider can be contacted, so a refusal can prove it used none.
function contacts(factory) {
  return {
    workers: factory.workers.length, starts: factory.starts, opened: factory.opened,
    restores: factory.restores.length, prompts: factory.prompts, configCalls: factory.configCalls
  };
}

function get(service, sessionId) {
  return service.call("session", { action: "get", sessionId }, MAIN);
}

// A transparent restore through config list, expected to fail with the worker's own error.
async function failRestore(service, clock, session, how = "config") {
  clock.now += 1_000;
  const call = {
    config: () => service.call("config", { sessionId: session.id, action: "list" }, MAIN),
    prompt: () => service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN),
    task_prompt: () => service.call("task_prompt", { sessionId: session.id, prompt: "go" }, MAIN),
    run: () => service.call("run", { sessionId: session.id, prompt: "go", waitMs: 0 }, MAIN)
  }[how];
  await assert.rejects(call(), /Resource not found/);
}

// Unload, then fail `count` transparent restores in a row.
async function quarantine(service, clock, factory, session, count = 3) {
  assert.equal(await service.unloadSession(session), true);
  factory.restoreError = refused();
  for (let index = 0; index < count; index += 1) await failRestore(service, clock, session);
}

function explicitRestore(service, session, extra = {}) {
  return service.call("session_restore", {
    provider: session.provider, acpSessionId: session.acpSessionId, cwd: session.cwd, ...extra
  }, MAIN);
}

function expectedQuarantineError(session) {
  return (error) => {
    assert.equal(error.code, ERROR_CODES.SESSION_QUARANTINED);
    assert.match(error.message, /quarantined/);
    assert.deepEqual(error.details, {
      sessionId: session.id,
      failures: session.quarantined.failures,
      lastErrorCode: session.quarantined.lastErrorCode,
      next: [
        { action: "session_check", sessionId: session.id },
        {
          action: "session_restore", sessionId: session.id,
          provider: session.provider, acpSessionId: session.acpSessionId, cwd: session.cwd
        },
        { action: "session_open" }
      ]
    });
    return true;
  };
}

test("the stop has a stable code, a check caveat, a documented setting, and stays out of the default poll", () => {
  assert.equal(ERROR_CODES.SESSION_QUARANTINED, "SESSION_QUARANTINED");
  assert.ok(CHECK_CAVEATS.includes("session_quarantined"));
  for (const key of ["restoreFailures", "quarantined"]) assert.ok(POLL_OMITTED_SESSION_KEYS.includes(key), key);
  const definition = SETTING_DEFINITIONS.find((item) => item.id === "maxConsecutiveRestoreFailures");
  assert.equal(definition.defaultValue, 3);
  assert.equal(definition.minimum, 1);
  assert.equal(definition.environment, "ACP_GATEWAY_MAX_CONSECUTIVE_RESTORE_FAILURES");
  assert.equal(definition.group, "lifecycle");
  assert.equal(validateSetting("maxConsecutiveRestoreFailures", 1), 1);
  assert.throws(() => validateSetting("maxConsecutiveRestoreFailures", 0), { code: "CONFIG_INVALID" });
  assert.equal(new GatewayService({ gcIntervalMs: 0 }).recovery.maxConsecutiveRestoreFailures, 3);
  assert.equal(new GatewayService({ gcIntervalMs: 0, maxConsecutiveRestoreFailures: 0 }).recovery.maxConsecutiveRestoreFailures, 3);
});

test("every failed transparent restore counts, from prompt, run, task_prompt and config; a success resets it", async () => {
  const { service, clock, factory } = harness({ maxConsecutiveRestoreFailures: 10 });
  try {
    const { opened, session } = await open(service);
    assert.equal(Object.hasOwn(opened, "restoreFailures"), false, "a healthy session keeps its shape");
    assert.equal(Object.hasOwn(opened, "quarantined"), false);
    assert.equal(await service.unloadSession(session), true);
    factory.restoreError = refused();
    for (const [index, how] of ["config", "prompt", "task_prompt", "run"].entries()) {
      await failRestore(service, clock, session, how);
      assert.equal(session.restoreFailures, index + 1, how);
    }
    const got = await get(service, session.id);
    assert.equal(got.restoreFailures, 4);
    assert.equal(Object.hasOwn(got, "quarantined"), false, "below the limit nothing is stopped");
    assert.equal(service.taskStore.records.size, 0, "the failed task handles were withdrawn");

    factory.restoreError = null;
    await service.call("config", { sessionId: session.id, action: "list" }, MAIN);
    assert.equal(session.status, "idle");
    assert.equal(session.restoreFailures, 0);
    assert.equal(Object.hasOwn(await get(service, session.id), "restoreFailures"), false);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("unload, provider exit, cancel and close never count; a failed restore after them does", async () => {
  const { service, clock, factory } = harness();
  try {
    const { session } = await open(service);
    // An idle unload is the Gateway's own choice.
    assert.equal(await service.unloadSession(session), true);
    assert.equal(session.restoreFailures ?? 0, 0);
    await service.call("config", { sessionId: session.id, action: "list" }, MAIN);

    // Main cancels a running turn.
    await service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN);
    await service.call("cancel", { sessionId: session.id }, MAIN);
    assert.equal(session.status, "cancelling");
    assert.equal(session.restoreFailures ?? 0, 0);
    session.client.turns.at(-1).resolve({ stopReason: "cancelled" });
    await until(() => session.status === "cancelled", "cancelled turn");

    // The provider exits under the session.
    session.client.crash();
    await until(() => session.status === "disconnected", "provider exit");
    assert.equal(session.restoreFailures ?? 0, 0);

    // What follows the exit is a restore, and its failure counts.
    factory.restoreError = refused();
    await failRestore(service, clock, session);
    assert.equal(session.restoreFailures, 1);
    assert.equal(session.quarantined ?? null, null);

    // Closing ends the record; it does not rewrite its history.
    const closed = await service.call("session", { action: "close", sessionId: session.id }, MAIN);
    assert.deepEqual(closed, { ok: true, closed: session.id });
    assert.equal(session.restoreFailures, 1);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("the limit quarantines, and prompt, run, task_prompt and config then fail fast without contacting a provider", async () => {
  const { service, clock, factory } = harness();
  try {
    const { session } = await open(service);
    await quarantine(service, clock, factory, session, 2);
    assert.equal(session.quarantined ?? null, null, "two in a row is not yet the limit");
    // The attempt that reaches the limit still reports its own failure.
    await failRestore(service, clock, session, "prompt");
    assert.deepEqual(session.quarantined, { at: iso(EPOCH + 3_000), failures: 3, lastErrorCode: "ACP_ERROR" });
    assert.equal(session.restoreFailures, 3);
    assert.equal(session.status, "unavailable");

    // No process of the provider is alive, so any restore would have to start one.
    for (const worker of factory.workers) await worker.stop();
    factory.restoreError = null;
    const before = contacts(factory);
    const eventsBefore = session.events.length;
    const matches = expectedQuarantineError(session);
    await assert.rejects(service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN), matches);
    await assert.rejects(service.call("task_prompt", { sessionId: session.id, prompt: "go" }, MAIN), matches);
    await assert.rejects(service.call("run", { sessionId: session.id, prompt: "go", waitMs: 0 }, MAIN), matches);
    await assert.rejects(service.call("run", { sessionId: session.id, prompt: "go" }, MAIN), matches);
    await assert.rejects(service.call("config", { sessionId: session.id, action: "list" }, MAIN), matches);
    await assert.rejects(
      service.call("config", { sessionId: session.id, action: "set", configId: "mode", value: "x" }, MAIN), matches
    );
    // Straight at the choke point, as any future caller of it would.
    await assert.rejects(service.ensureConnected(session, MAIN), matches);

    assert.deepEqual(contacts(factory), before, "no provider was started or asked");
    assert.equal(service.taskStore.records.size, 0, "no Task handle was minted");
    assert.equal(session.events.length, eventsBefore, "a refusal is not an attempt");
    assert.equal(session.restoreFailures, 3, "refusals do not count");
    assert.equal(session.status, "unavailable");
    assert.equal(session._reserved ?? null, null);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a quarantined session can still be read, polled, pinned, cancelled, checked, diffed and closed", async () => {
  await withDirectory(async (directory) => {
    const { service, clock, factory } = harness({ workspaceRoot: join(directory, "workspaces") });
    try {
      const project = join(directory, "project");
      await mkdir(project);
      await writeFile(join(project, "a.txt"), "a\n");
      const healthy = await open(service);
      const { session } = await open(service, { cwd: project, workspace: "snapshot" });
      await writeFile(join(session.cwd, "a.txt"), "b\n");
      await quarantine(service, clock, factory, session);
      assert.ok(session.quarantined);
      const before = contacts(factory);

      const got = await get(service, session.id);
      assert.equal(got.restoreFailures, 3);
      assert.deepEqual(got.quarantined, session.quarantined);
      const listed = (await service.call("session", { action: "list" }, MAIN)).sessions.find((item) => item.sessionId === session.id);
      assert.deepEqual([listed.restoreFailures, listed.quarantined], [3, session.quarantined]);
      const others = (await service.call("session", { action: "list" }, MAIN)).sessions.find((item) => item.sessionId === healthy.session.id);
      assert.equal(Object.hasOwn(others, "restoreFailures") || Object.hasOwn(others, "quarantined"), false);

      // Quiet: the default and compact polls do not grow — byte for byte what
      // the same session polls without the two facts. Diagnostic says them.
      for (const responseProfile of ["current", "compact"]) {
        const poll = () => service.call("poll", { sessionId: session.id, cursor: 0, responseProfile }, MAIN);
        const withFacts = await poll();
        const saved = { restoreFailures: session.restoreFailures, quarantined: session.quarantined };
        Object.assign(session, { restoreFailures: 0, quarantined: null });
        const withoutFacts = await poll();
        Object.assign(session, saved);
        assert.equal(JSON.stringify(withFacts), JSON.stringify(withoutFacts), responseProfile);
      }
      const diagnostic = await service.call("poll", { sessionId: session.id, cursor: 0, responseProfile: "diagnostic" }, MAIN);
      assert.deepEqual([diagnostic.restoreFailures, diagnostic.quarantined], [3, session.quarantined]);
      const plainDiagnostic = await service.call(
        "poll", { sessionId: healthy.session.id, cursor: 0, responseProfile: "diagnostic" }, MAIN
      );
      assert.equal(Object.hasOwn(plainDiagnostic, "restoreFailures") || Object.hasOwn(plainDiagnostic, "quarantined"), false);

      assert.equal((await service.call("session", { action: "pin", sessionId: session.id }, MAIN)).pinned, true);
      assert.equal((await service.call("session", { action: "unpin", sessionId: session.id }, MAIN)).pinned, false);
      const cancelled = await service.call("cancel", { sessionId: session.id }, MAIN);
      assert.deepEqual([cancelled.ok, cancelled.status], [true, "unavailable"]);

      // Explicit restore is still possible, so check does not call it hopeless.
      assert.deepEqual(await service.call("session", { action: "check", sessionId: session.id }, MAIN), {
        ok: true, sessionId: session.id, restorable: "restorable_with_caveats", method: "resume",
        caveats: ["last_restore_failed", "session_quarantined"]
      });
      const diff = await service.call("session", { action: "workspace_diff", sessionId: session.id }, MAIN);
      assert.deepEqual(diff.files, ["a.txt"]);
      assert.deepEqual(contacts(factory), before, "none of these contacted a provider");

      assert.deepEqual(await service.call("session", { action: "close", sessionId: session.id }, MAIN), { ok: true, closed: session.id });
      assert.equal(session.status, "closed");
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("an explicit restore is Main's call: a failure counts and keeps the quarantine, a success lifts it in place", async () => {
  const { service, clock, factory } = harness();
  try {
    const { session } = await open(service);
    await quarantine(service, clock, factory, session);
    const since = session.quarantined.at;
    const records = service.store.list().length;

    // Argument mistakes are refused before the attempt and never count.
    await assert.rejects(explicitRestore(service, session, { cwd: tmpdir() }), { code: "INVALID_ARGUMENT" });
    await assert.rejects(explicitRestore(service, session, { permissionPolicy: "nonsense" }), /./);
    assert.equal(session.restoreFailures, 3);

    // Allowed while quarantined: the provider is asked, the worker refuses again.
    clock.now += 1_000;
    const restoresBefore = factory.restores.length;
    await assert.rejects(explicitRestore(service, session), /Resource not found/);
    assert.equal(factory.restores.length, restoresBefore + 1);
    assert.equal(session.restoreFailures, 4);
    assert.deepEqual(session.quarantined, { at: since, failures: 4, lastErrorCode: "ACP_ERROR" });
    assert.deepEqual(session.lastRestore, { at: iso(EPOCH + 4_000), method: "resume", outcome: "failed", errorCode: "ACP_ERROR" });
    // And the transparent path is still stopped.
    await assert.rejects(service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN), { code: "SESSION_QUARANTINED" });

    // The worker comes back. Same record, not a second registration.
    factory.restoreError = null;
    clock.now += 1_000;
    const restored = await explicitRestore(service, session, { pinned: true });
    assert.equal(restored.sessionId, session.id);
    assert.equal(restored.restoredWith, "resume");
    assert.equal(restored.generation, 2);
    assert.equal(restored.pinned, true);
    assert.equal(Object.hasOwn(restored, "restoreFailures") || Object.hasOwn(restored, "quarantined"), false);
    assert.equal(service.store.list().length, records);
    assert.deepEqual([session.status, session.restoreFailures, session.quarantined], ["idle", 0, null]);
    assert.deepEqual(session.lastRestore, { at: iso(EPOCH + 5_000), method: "resume", outcome: "resumed", errorCode: null });
    assert.equal(factory.opened, 1, "no session/new behind Main's back");

    // It works again, transparently too.
    const ack = await service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN);
    assert.equal(ack.status, "running");
    // A live record is not restored twice, and asking contacts no provider.
    const before = contacts(factory);
    await assert.rejects(explicitRestore(service, session), /already registered/);
    assert.deepEqual(contacts(factory), before);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("an explicit restore also counts below the limit and can be the attempt that quarantines", async () => {
  const { service, clock, factory } = harness({ maxConsecutiveRestoreFailures: 2 });
  try {
    const { session } = await open(service);
    assert.equal(await service.unloadSession(session), true);
    factory.restoreError = refused();
    clock.now += 1_000;
    await assert.rejects(explicitRestore(service, session), /Resource not found/);
    assert.equal(session.restoreFailures, 1);
    await failRestore(service, clock, session);
    assert.deepEqual(session.quarantined, { at: iso(EPOCH + 2_000), failures: 2, lastErrorCode: "ACP_ERROR" });

    // A provider that cannot even start is a failed restore too.
    factory.restoreError = null;
    for (const worker of factory.workers) await worker.stop();
    factory.startError = new Error("spawn ENOENT");
    clock.now += 1_000;
    await assert.rejects(explicitRestore(service, session), /spawn ENOENT/);
    assert.deepEqual(session.quarantined, { at: iso(EPOCH + 2_000), failures: 3, lastErrorCode: "GATEWAY_ERROR" });
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("the count and the quarantine survive a daemon restart, which itself counts nothing", async () => {
  await withDirectory(async (directory) => {
    const statePath = join(directory, "state.json");
    const artifactRoot = join(directory, "artifacts");
    let counting;
    let stopped;
    let quarantined;
    const before = harness({ statePath, artifactRoot });
    try {
      await before.service.init();
      counting = (await open(before.service)).session;
      stopped = (await open(before.service)).session;
      await quarantine(before.service, before.clock, before.factory, counting, 2);
      await quarantine(before.service, before.clock, before.factory, stopped, 3);
      quarantined = stopped.quarantined;
      await before.service.flushPersist();
      const saved = JSON.parse(await readFile(statePath, "utf8")).sessions;
      const byId = Object.fromEntries(saved.map((record) => [record.id, record]));
      assert.deepEqual([byId[counting.id].restoreFailures, byId[counting.id].quarantined], [2, null]);
      assert.deepEqual([byId[stopped.id].restoreFailures, byId[stopped.id].quarantined], [3, quarantined]);
    } finally {
      await before.service.shutdown();
    }

    const after = harness({ statePath, artifactRoot });
    try {
      await after.service.init();
      const got = await get(after.service, stopped.id);
      assert.equal(got.status, "disconnected");
      assert.deepEqual([got.restoreFailures, got.quarantined], [3, quarantined]);
      assert.equal((await get(after.service, counting.id)).restoreFailures, 2);

      // Still stopped, and still nothing is started for it.
      const record = after.service.requireSession(stopped.id);
      await assert.rejects(after.service.call("prompt", { sessionId: stopped.id, prompt: "go" }, MAIN), expectedQuarantineError(record));
      assert.equal(after.factory.starts, 0);

      // The streak carries over: one more failure is the third in a row.
      after.factory.restoreError = refused();
      await failRestore(after.service, after.clock, after.service.requireSession(counting.id));
      assert.equal(after.service.requireSession(counting.id).quarantined.failures, 3);

      // Main lifts the old one explicitly.
      after.factory.restoreError = null;
      const restored = await explicitRestore(after.service, record);
      assert.equal(restored.sessionId, stopped.id);
      assert.deepEqual([record.restoreFailures, record.quarantined], [0, null]);
    } finally {
      await after.service.shutdown();
    }
  });
});

test("provider_degraded appears after the same number of failed starts in a row, blocks nothing, and clears", async () => {
  const { service, factory } = harness();
  try {
    const degraded = async (mode) => (await service.call("setup", { mode }, MAIN)).alerts
      .filter((alert) => alert.code === "provider_degraded");
    factory.startError = new Error(`spawn ENOENT ${"x".repeat(5_000)}`);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await assert.rejects(open(service), /spawn ENOENT/);
      assert.equal(factory.starts, attempt, "every attempt still tries");
      if (attempt === 2) assert.deepEqual(await degraded("summary"), [], "two in a row is not yet the limit");
    }
    for (const mode of ["summary", "full"]) {
      const [alert] = await degraded(mode);
      assert.equal(alert.level, "warning", mode);
      assert.equal(alert.provider, "claude");
      assert.equal(alert.failures, 4);
      assert.match(alert.lastError, /^claude ACP setup failed: spawn ENOENT x/);
      assert.ok(Buffer.byteLength(alert.lastError) <= 300, "bounded");
      assert.equal(typeof alert.message, "string");
    }

    // The next start that works clears it.
    factory.startError = null;
    await open(service);
    assert.deepEqual(await degraded("summary"), []);
    assert.deepEqual(await degraded("full"), []);
    assert.equal(service.providerStartFailures.size, 0);
  } finally {
    await service.shutdown().catch(() => {});
  }
});
