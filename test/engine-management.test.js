import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AcpClient } from "../src/acp-client.js";
import { GatewayService } from "../src/gateway-service.js";
import { GatewaySettings } from "../src/settings.js";
import { GatewayRpcClient } from "acp-gateway/client";
import { startDaemon, writeMockProviders } from "./helpers/daemon-harness.js";

const context = { rootId: "main-a" };
const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate) {
  for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value; await pause(10); }
  throw new Error("Expected state was not reached");
}
async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), "acp-engine150-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const makeSession = service => service.store.create({ provider: "mock", acpSessionId: "mock", cwd: "/", ownerRootId: context.rootId, turnId: "test-turn", status: "running", permissionPolicy: "ask" });

test("settings migrate supported legacy values, preserve identity, and distinguish applied revision", async () => temporary(async directory => {
  const path = join(directory, "settings.json"), legacy = join(directory, "install.json");
  const original = { version: 1, identity: { token: "unchanged" }, gatewayConfig: { lifecycle: { idleUnloadMs: 123456 }, workers: { workerThoughtStream: true }, monitor: { localScannerEnabled: false } } };
  await writeFile(legacy, JSON.stringify(original));
  const store = new GatewaySettings({ path, legacy, env: {} });
  assert.equal(store.activeValues.idleUnloadMs, 123456);
  assert.deepEqual(store.snapshot().unsupportedLegacySettings, ["workerThoughtStream"]);
  const changed = store.update({ expectedRevision: 0, values: { idleUnloadMs: 222222, maxInlineResultBytes: 100 } });
  assert.equal(changed.pendingRestart, true);
  assert.equal(changed.activeRevision, 0);
  assert.equal(changed.revision, 1);
  assert.equal(new GatewaySettings({ path, legacy, env: {} }).activeValues.idleUnloadMs, 222222);
  assert.deepEqual(JSON.parse(await readFile(legacy)), original);
  assert.throws(() => store.update({ expectedRevision: 0, values: { idleUnloadMs: 333333 } }), { code: "CONFIG_CONFLICT" });
  assert.throws(() => store.update({ expectedRevision: 1, values: { artifactSessionLimit: 1 } }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => store.update({ expectedRevision: 1, values: { maxEvents: 1.5 } }), { code: "CONFIG_INVALID" });
  assert.throws(() => store.update({ expectedRevision: 1, values: { maxArtifactTotalBytes: 100 } }), { code: "CONFIG_INVALID" });
  assert.equal(store.snapshot().revision, 1, "failed transactions do not change revision");
  const locked = new GatewaySettings({ path, legacy, env: { ACP_GATEWAY_IDLE_UNLOAD_MS: "777777" } });
  assert.equal(locked.activeValues.idleUnloadMs, 777777);
  assert.throws(() => locked.update({ expectedRevision: 1, values: { idleUnloadMs: 1 } }), { code: "CONFIG_CONFLICT" });
  store.update({ expectedRevision: 1, resetIds: ["idleUnloadMs"] });
  assert.equal(new GatewaySettings({ path, legacy, env: {} }).activeValues.idleUnloadMs, 1800000, "reset must not resurrect a legacy value");
}));

test("malformed settings halt instead of silently discarding configured policy", async () => temporary(async directory => {
  const path = join(directory, "settings.json"), legacy = join(directory, "install.json");
  await writeFile(path, "{broken");
  assert.throws(() => new GatewaySettings({ path, legacy, env: {} }), { code: "CONFIG_INVALID" });
  await writeFile(path, "null");
  assert.throws(() => new GatewaySettings({ path, legacy, env: {} }), { code: "CONFIG_INVALID" });
}));

test("dispatch rejects malformed arguments and inherited object methods", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    for (const method of ["constructor", "toString", "__proto__"]) {
      await assert.rejects(service.call(method, {}, context), { code: "UNKNOWN_METHOD" });
    }
    for (const args of [null, [], "invalid"]) {
      await assert.rejects(service.call("setup", args, context), { code: "INVALID_ARGUMENT" });
      assert.throws(() => service.subscribe(args, context, () => {}), { code: "INVALID_ARGUMENT" });
    }
  } finally { await service.shutdown(); }
});

test("failed external restore configuration closes the unregistered ACP session", async () => temporary(async directory => {
  const closed = [], cleared = [];
  const service = new GatewayService({ gcIntervalMs: 0 });
  service.getClient = async () => ({
    alive: true, config: {},
    initResult: { agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } },
    sessionRestore: async () => ({ sessionId: "external" }),
    request: async (method, args) => closed.push([method, args.sessionId]),
    clearSession: id => cleared.push(id)
  });
  try {
    await assert.rejects(service.call("session_restore", {
      provider: "claude", cwd: directory, acpSessionId: "external", model: "unadvertised"
    }, context), { code: "INVALID_ARGUMENT" });
    assert.deepEqual(closed, [["session/close", "external"]]);
    assert.deepEqual(cleared, ["external"]);
    assert.equal(service.pendingSessions.size, 0);
    assert.equal(service.store.list().length, 0);
  } finally { await service.shutdown(); }
}));

test("aborting run waits frees all waiter slots without cancelling the Task", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const task = service.taskStore.create({ sessionId: "s", ownerRootId: context.rootId });
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      const waited = service.call("run", { taskId: task.taskId, waitMs: 60000 }, { ...context, signal: controller.signal });
      controller.abort();
      await assert.rejects(waited, { code: "WAIT_ABORTED" });
    }
    const handoff = await service.call("run", { taskId: task.taskId, waitMs: 1 }, context);
    assert.equal(handoff.status, "working");
    assert.equal(service.taskStore.get(task.taskId).status, "working");
  } finally { await service.shutdown(); }
});

test("invalid subscriptions never register and valid subscriptions have a per-root bound", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = makeSession(service);
    for (let i = 0; i < 100; i++) assert.throws(() => service.subscribe({ cursors: { [session.id]: -1 } }, context, () => {}));
    assert.equal(service.subscriptions.size, 0);
    const ids = Array.from({ length: 64 }, () => service.subscribe({}, context, () => {}).subscriptionId);
    assert.throws(() => service.subscribe({}, context, () => {}), { code: "SUBSCRIPTION_LIMIT_EXCEEDED" });
    service.removeSubscriptions(ids);
    assert.equal(service.subscriptions.size, 0);
  } finally { await service.shutdown(); }
});

test("replay declares unrecoverable raw chunks while final Task results remain separately collectable", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = makeSession(service);
    service.store.push(session, { type: "turn_start" });
    service.handleUpdate(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "live" } });
    service.store.push(session, { type: "turn_end" });
    const replay = service.subscribe({ cursors: { [session.id]: 1 } }, context, () => {});
    assert.deepEqual(replay.events.map(e => e.sequence), [2]);
    assert.equal(replay.cursorTruncated[session.id], true);
    assert.equal(replay.replay[session.id].liveOnlyMissing, true);
    assert.equal(replay.replay[session.id].complete, false);
    const current = service.subscribe({ cursors: { [session.id]: 3 } }, context, () => {});
    assert.equal(current.replay[session.id].complete, true);
  } finally { await service.shutdown(); }
});

test("observer reads neither restore a worker nor keep its owner alive", async () => {
  let starts = 0;
  const service = new GatewayService({ gcIntervalMs: 0, createClient: () => { starts++; throw new Error("observer started worker"); } });
  try {
    const session = makeSession(service);
    session.status = "disconnected";
    session.orphanedAt = "2020-01-01T00:00:00.000Z";
    session.lastOwnerActivityAt = "2020-01-01T00:00:00.000Z";
    const observer = { ...context, access: "observer" };
    await service.call("session", { action: "get", sessionId: session.id }, observer);
    await service.call("config", { action: "list", sessionId: session.id }, observer);
    service.subscribe({}, observer, () => {});
    assert.equal(starts, 0);
    assert.equal(session.orphanedAt, "2020-01-01T00:00:00.000Z");
    assert.equal(session.lastOwnerActivityAt, "2020-01-01T00:00:00.000Z");
    for (const [method, args] of [["setup", { provider: "claude" }], ["session", { action: "close", sessionId: session.id }], ["provider", { action: "set_enabled", provider: "mock", enabled: false }]]) {
      await assert.rejects(service.call(method, args, observer), { code: "OBSERVER_ACCESS_DENIED" });
    }
  } finally { await service.shutdown(); }
});

test("shutdown rejects an in-flight open and restores admission after refusal", async () => temporary(async directory => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const service = new GatewayService({ gcIntervalMs: 0, maxSessionsPerRoot: 1, createClient: (_provider, options) => {
    const client = new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
    const original = client.sessionNew.bind(client);
    client.sessionNew = async args => { started(); await held; return original(args); };
    return client;
  } });
  const pending = service.call("session_open", { provider: "claude", cwd: directory }, context);
  try {
    await entered;
    await assert.rejects(service.call("session_open", { provider: "claude", cwd: directory }, context), { code: "SESSION_LIMIT_EXCEEDED" });
    assert.throws(() => service.prepareShutdown(), { code: "SHUTDOWN_BLOCKED" });
    assert.equal(service.draining, false);
    release();
    const opened = await pending;
    await service.call("session", { action: "close", sessionId: opened.sessionId }, context);
    service.prepareShutdown();
    await assert.rejects(service.call("session_open", { provider: "claude", cwd: directory }, context), { code: "GATEWAY_DRAINING" });
  } finally { release(); await pending.catch(() => {}); await service.shutdown(); }
}));

test("retention preview and GC protect active work, pinned records and pending input", async () => temporary(async directory => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const service = new GatewayService({ gcIntervalMs: 0, artifactRoot: directory, now: () => now, taskRetentionMs: 1, sessionRetentionMs: 1 });
  try {
    const session = makeSession(service);
    session.pinned = true;
    const task = service.taskStore.create({ sessionId: session.id, ownerRootId: context.rootId, ttl: 60000 });
    service.inbox.set("pending", { inboxId: "pending", sessionId: session.id, ownerRootId: context.rootId, status: "pending", createdAt: new Date(now).toISOString() });
    now += 100;
    const preview = service.retentionPreview({ values: { taskRetentionMs: 1, sessionRetentionMs: 1, inboxRetentionMs: 1 } }, context);
    assert.deepEqual(preview.counts, { sessions: 0, tasks: 0, inbox: 0, results: 0 });
    await service.runMaintenance(now);
    assert.ok(service.taskStore.find(task.taskId));
    assert.ok(service.store.get(session.id));
    assert.ok(service.inbox.get("pending"));
    assert.throws(() => service.retentionPreview({ artifactSessionLimit: 1 }, context), { code: "INVALID_ARGUMENT" });
  } finally { await service.shutdown(); }
}));

test("public RPC enforces observer, persisted config, provider Off, and atomic safe shutdown", async () => temporary(async directory => {
  const providerEnv = await writeMockProviders(directory);
  let daemon, control, observer;
  const connect = async () => {
    daemon = await startDaemon({ directory, env: providerEnv });
    control = new GatewayRpcClient({ socketPath: daemon.socketPath, token: daemon.token, rootId: daemon.rootId, autoStart: false });
    observer = new GatewayRpcClient({ socketPath: daemon.socketPath, token: daemon.token, rootId: daemon.rootId, access: "observer", autoStart: false });
  };
  try {
    await connect();
    await assert.rejects(observer.call("session_open", { provider: "mock", cwd: directory }), { code: "OBSERVER_ACCESS_DENIED" });
    const before = await observer.call("gateway_config");
    await control.call("gateway_config", { action: "set", expectedRevision: before.revision, values: { idleUnloadMs: 123456 } });
    assert.equal((await observer.call("gateway_config")).pendingRestart, true);
    const health = await observer.call("setup");
    assert.equal(health.capabilities.safeShutdown, true);
    assert.match(health.gatewayBuildId, /^[a-f0-9]{64}$/);
    assert.equal(health.gatewayVersion, "1.5.0");
    await control.call("provider", { action: "set_enabled", provider: "mock", enabled: false });
    await assert.rejects(control.call("session_open", { provider: "mock", cwd: directory }), { code: "PROVIDER_DISABLED" });
    const closed = daemon.waitForExit();
    await control.call("shutdown_if_idle"); await closed;
    observer.close(); control.close();
    await connect();
    assert.equal((await observer.call("setup")).lifecycle.idleUnloadMs, 123456);
    assert.equal((await observer.call("gateway_config")).pendingRestart, false);
    await assert.rejects(control.call("session_open", { provider: "mock", cwd: directory }), { code: "PROVIDER_DISABLED" });
    await control.call("provider", { action: "set_enabled", provider: "mock", enabled: true });
    const opened = await control.call("session_open", { provider: "mock", cwd: directory, permissionPolicy: "ask" });
    await control.call("prompt", { sessionId: opened.sessionId, prompt: "block" });
    await until(() => observer.call("session", { action: "list" }), value => value.sessions.some(s => s.status === "waiting_permission"));
    await assert.rejects(control.call("daemon_shutdown"), { code: "SHUTDOWN_BLOCKED" });
    const preview = await observer.call("retention_preview", { sessionRetentionMs: 1000 });
    assert.equal(preview.counts.sessions, 0);
    await control.call("session", { action: "close", sessionId: opened.sessionId });
    const exit = daemon.waitForExit(); await control.call("shutdown_if_idle"); await exit;
  } finally { observer?.close(); control?.close(); await daemon?.stop(); }
}));
