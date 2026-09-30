// 1.7.0 W4: when work is cut short, Main learns what is known (why, and
// whether the worker can have acted), what it may do next, and whether the
// session can come back — and the Gateway itself never re-runs a prompt or
// silently opens a fresh session. Every case drives an in-process fake worker
// on an injected clock.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isReadOnlyCall } from "../src/access.js";
import { ERROR_CODES, GatewayError } from "../src/errors.js";
import { CHECK_CAVEATS, GatewayService } from "../src/gateway-service.js";
import { decodeRecord, encodeRecord, statePaths, WAL_TYPES } from "../src/state-store.js";
import { EXECUTION_OUTCOMES, INTERRUPTION_REASONS } from "../src/task-store.js";
import { createSnapshot } from "../src/workspace.js";

const MAIN = { rootId: "main-a" };
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const RESTART_MESSAGE = "Gateway restarted before this task completed";
const ACTED_NOTE = "re-running may repeat side effects the worker already made";
const NOT_STARTED_NOTE = "the worker never received this prompt, so re-running repeats nothing";
const RESUME = { sessionCapabilities: { resume: {}, close: {} } };
const iso = (ms) => new Date(ms).toISOString();

// The smallest worker the service accepts, with every contact counted so a
// test can prove a read-only call made none. Turns resolve only when told to.
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
    await this.factory.restoreGate;
    if (this.factory.restoreError) throw this.factory.restoreError;
    return { sessionId, configOptions: [] };
  }

  onSessionUpdate(sessionId, handler) { this.handlers.set(sessionId, handler); }
  clearSession(sessionId) { this.handlers.delete(sessionId); }

  sessionPrompt() {
    this.factory.onPrompt?.();
    return new Promise((resolve, reject) => this.turns.push({ resolve, reject }));
  }

  cancelSession() {}
  pendingSessionInput() { return { permissions: 0, elicitations: 0 }; }
  async setSessionConfigOption() { return { configOptions: [] }; }
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
    opened: 0, starts: 0, restores: [], workers: [], capabilities: RESUME,
    restoreGate: null, restoreError: null, startError: null, onPrompt: null
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
  const directory = await mkdtemp(join(tmpdir(), "acp-recovery-outcome-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function terminal(service, taskId) {
  return () => ["completed", "failed", "cancelled"].includes(service.taskStore.find(taskId)?.status);
}

function check(service, sessionId, context = MAIN) {
  return service.call("session", { action: "check", sessionId }, context);
}

// Every way a worker can be contacted, so a check can prove it used none.
function contacts(factory) {
  return { workers: factory.workers.length, starts: factory.starts, opened: factory.opened, restores: factory.restores.length };
}

test("the interruption and caveat vocabularies are closed, and check speaks exactly its list", async () => {
  assert.deepEqual([...INTERRUPTION_REASONS], ["gateway_restarted", "provider_disconnected", "orphan_cancelled"]);
  assert.deepEqual([...EXECUTION_OUTCOMES], ["not_started", "unknown"]);
  assert.ok(Object.isFrozen(INTERRUPTION_REASONS) && Object.isFrozen(EXECUTION_OUTCOMES) && Object.isFrozen(CHECK_CAVEATS));
  const source = await readFile(new URL("../src/gateway-service.js", import.meta.url), "utf8");
  const spoken = [...source.matchAll(/caveats\.push\("([a-z_]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(spoken)].sort(), [...CHECK_CAVEATS].sort());
});

test("the dispatch stamp is on disk before the worker is sent the prompt", async () => {
  await withDirectory(async (directory) => {
    const statePath = join(directory, "state.json");
    const { service, factory } = harness({ statePath, artifactRoot: join(directory, "artifacts") });
    try {
      await service.init();
      const { session } = await open(service);
      let seenAtSend = null;
      factory.onPrompt = () => {
        const task = service.taskStore.find(session.activeTaskId);
        const onDisk = readFileSync(statePaths(statePath).wal, "utf8").split("\n").filter(Boolean)
          .map((line) => decodeRecord(Buffer.from(line, "utf8")))
          .filter((record) => record.type === WAL_TYPES.TASK_STATUS_CHANGED && record.key === task.taskId);
        seenAtSend = { inMemory: task.promptDispatchedAt, onDisk: onDisk.map((record) => record.payload.promptDispatchedAt) };
      };
      const task = await service.call("task_prompt", { sessionId: session.id, prompt: "go" }, MAIN);
      assert.equal(seenAtSend.inMemory, iso(EPOCH));
      assert.deepEqual(seenAtSend.onDisk, [iso(EPOCH)]);
      // Internal provenance: task reads do not grow for it.
      assert.equal(Object.hasOwn(await service.call("task_get", { taskId: task.taskId }, MAIN), "promptDispatchedAt"), false);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("without a WAL the stamp is in a synced snapshot before the send", async () => {
  await withDirectory(async (directory) => {
    const statePath = join(directory, "state.json");
    const { service, factory } = harness({
      statePath, artifactRoot: join(directory, "artifacts"), persistence: { wal: false }
    });
    try {
      await service.init();
      assert.equal(service.stateStore.mode, "snapshot");
      const { session } = await open(service);
      let onDisk = null;
      factory.onPrompt = () => {
        const raw = readFileSync(statePaths(statePath).snapshot, "utf8");
        const body = JSON.parse(raw.slice(raw.indexOf("\n") + 1));
        onDisk = body.tasks.find((task) => task.taskId === session.activeTaskId)?.promptDispatchedAt ?? null;
      };
      await service.call("task_prompt", { sessionId: session.id, prompt: "go" }, MAIN);
      assert.equal(onDisk, iso(EPOCH));
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("a stamp that cannot be made durable fails the prompt before the worker hears of it", async () => {
  await withDirectory(async (directory) => {
    const { service } = harness({ statePath: join(directory, "state.json"), artifactRoot: join(directory, "artifacts") });
    try {
      await service.init();
      const { session, worker } = await open(service);
      const appendDurable = service.stateStore.appendDurable.bind(service.stateStore);
      service.stateStore.appendDurable = (type, key, payload) => {
        if (type === WAL_TYPES.TASK_STATUS_CHANGED) throw new Error("disk full");
        return appendDurable(type, key, payload);
      };
      await assert.rejects(
        service.call("task_prompt", { sessionId: session.id, prompt: "go" }, MAIN),
        { code: ERROR_CODES.PERSISTENCE_UNHEALTHY }
      );
      assert.equal(worker.turns.length, 0, "the worker never received the prompt");
      assert.equal(session.status, "idle");
      assert.equal(session.activeTaskId, null);
      assert.deepEqual((await service.call("task_list", {}, MAIN)).tasks, []);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("a restart after the prompt was sent reports gateway_restarted with an unknown outcome", async () => {
  await withDirectory(async (directory) => {
    const statePath = join(directory, "state.json");
    const artifactRoot = join(directory, "artifacts");
    let taskId;
    let sessionId;
    const before = harness({ statePath, artifactRoot });
    try {
      await before.service.init();
      const { session } = await open(before.service);
      sessionId = session.id;
      taskId = (await before.service.call("task_prompt", { sessionId, prompt: "go" }, MAIN)).taskId;
      await before.service.flushPersist();
    } finally {
      // A clean shutdown never finalizes an in-flight turn: the restart
      // conversion is what reports it.
      await before.service.shutdown();
    }

    const after = harness({ statePath, artifactRoot });
    after.clock.now = EPOCH + 5_000;
    try {
      await after.service.init();
      const interruption = { reason: "gateway_restarted", executionOutcome: "unknown", at: iso(EPOCH + 5_000) };
      const got = await after.service.call("task_get", { taskId }, MAIN);
      assert.equal(got.status, "failed");
      assert.equal(got.statusMessage, RESTART_MESSAGE);
      assert.deepEqual(got.interruption, interruption);
      assert.deepEqual(await after.service.call("task_result", { taskId }, MAIN), {
        taskId,
        ok: false,
        error: RESTART_MESSAGE,
        interruption,
        next: [{ action: "session_check", sessionId }, { action: "decide_rerun", note: ACTED_NOTE }]
      });
      const [listed] = (await after.service.call("task_list", {}, MAIN)).tasks;
      assert.deepEqual(listed.interruption, interruption);
      // The Gateway re-ran nothing: no process was started to do it.
      assert.equal(after.factory.starts, 0);
    } finally {
      await after.service.shutdown().catch(() => {});
    }
  });
});

test("a restart before the prompt reached the worker reports not_started, and offers no diff", async () => {
  await withDirectory(async (directory) => {
    // Beside the project, not around it: the state directory is protected, and
    // a snapshot of anything inside it is refused.
    await mkdir(join(directory, "state"));
    const statePath = join(directory, "state", "state.json");
    const paths = statePaths(statePath);
    const project = join(directory, "project");
    await mkdir(project);
    await writeFile(join(project, "a.txt"), "a\n");
    const workspaceRoot = join(directory, "workspaces");
    let taskId;
    let sessionId;
    let wal;
    const before = harness({ statePath, workspaceRoot, artifactRoot: join(directory, "artifacts") });
    try {
      await before.service.init();
      const { session } = await open(before.service, { cwd: project, workspace: "snapshot" });
      sessionId = session.id;
      assert.equal(await before.service.unloadSession(session), true);
      // The next prompt has to resume first; hold the resume so the durable
      // task exists while nothing has been sent to the worker.
      let release;
      before.factory.restoreGate = new Promise((resolve) => { release = resolve; });
      const pending = before.service.call("task_prompt", { sessionId, prompt: "go" }, MAIN);
      await until(() => before.factory.restores.length === 1, "resume in flight");
      taskId = [...before.service.taskStore.records.values()][0].taskId;
      assert.equal(before.service.taskStore.find(taskId).promptDispatchedAt, undefined);
      // The crash point: the log as a killed daemon would leave it.
      await before.service.flushPersist();
      wal = await readFile(paths.wal);
      before.factory.restoreError = new Error("gone");
      release();
      await assert.rejects(pending, /gone/);
    } finally {
      await before.service.shutdown();
    }
    await writeFile(paths.wal, wal, { mode: 0o600 });
    await rm(paths.snapshot, { force: true });

    // What makes the missing stamp mean "never sent": the record says, durably,
    // that its dispatch was tracked.
    const created = wal.toString("utf8").split("\n").filter(Boolean).map((line) => decodeRecord(Buffer.from(line, "utf8")))
      .find((record) => record.type === WAL_TYPES.TASK_CREATED && record.key === taskId);
    assert.equal(created.payload.dispatchTracking, 1);

    const after = harness({ statePath, workspaceRoot, artifactRoot: join(directory, "artifacts") });
    after.clock.now = EPOCH + 7_000;
    try {
      await after.service.init();
      const interruption = { reason: "gateway_restarted", executionOutcome: "not_started", at: iso(EPOCH + 7_000) };
      assert.deepEqual((await after.service.call("task_get", { taskId }, MAIN)).interruption, interruption);
      const result = await after.service.call("task_result", { taskId }, MAIN);
      assert.equal(result.error, RESTART_MESSAGE);
      assert.deepEqual(result.next, [
        { action: "session_check", sessionId },
        { action: "decide_rerun", note: NOT_STARTED_NOTE }
      ]);
    } finally {
      await after.service.shutdown().catch(() => {});
    }
  });
});

// 1.6.0 never stamped a dispatch, so on its records a missing stamp proves
// nothing. The state files below carry exactly the keys 1.6.0 wrote: its
// session checkpoint, its task record, its status-change payload.
test("1.6.0 tasks cut short by the upgrade restart are unknown and offer the diff, from the snapshot and from the log", async () => {
  await withDirectory(async (directory) => {
    await mkdir(join(directory, "state"));
    const statePath = join(directory, "state", "state.json");
    const paths = statePaths(statePath);
    const project = join(directory, "project");
    await mkdir(project);
    await writeFile(join(project, "a.txt"), "a\n");
    const workspace = await createSnapshot(project, join(directory, "workspaces"));
    const at = iso(EPOCH - 60_000);
    const session160 = (id, extra) => ({
      id, provider: "claude", acpSessionId: `acp-${id}`, cwd: process.cwd(), title: null, permissionPolicy: "ask",
      model: null, ownerRootId: MAIN.rootId, mcpServers: [], additionalDirectories: [], pinned: false,
      status: "running", createdAt: at, updatedAt: at, completedAt: null, orphanedAt: null, lastOwnerActivityAt: at,
      transientClearedAt: null, eventSequence: 3, lastMessageSequence: -1, lastThoughtSequence: -1,
      eventsEvictedThrough: -1, turnId: "turn-1", stopReason: null, thoughtCapture: null, ...extra
    });
    const sessions = [
      session160("session-direct", {}),
      session160("session-snapshot", { cwd: workspace.path, status: "waiting_permission", workspace })
    ];
    const created160 = (taskId, sessionId) => ({
      taskId, sessionId, ownerRootId: MAIN.rootId, turnId: null, status: "working", ttl: 3_600_000,
      pollInterval: 1_000, createdAt: at, lastUpdatedAt: at, statusMessage: "Prompt accepted", origin: "prompt", result: null
    });
    const status160 = (status, statusMessage) => ({ status, statusMessage, lastUpdatedAt: at, turnId: "turn-1" });
    const running = status160("working", "Prompt running");
    const waiting = status160("input_required", "Waiting for Main permission");
    const snapshotTasks = [
      { ...created160("task-working", "session-direct"), ...running },
      { ...created160("task-input", "session-snapshot"), ...waiting }
    ];
    const walRecords = [
      [WAL_TYPES.WAL_OPENED, "4242", { pid: 4242, writerVersion: "1.6.0", epoch: 0 }],
      ...sessions.map((session) => [WAL_TYPES.SESSION_REGISTERED, session.id, session]),
      [WAL_TYPES.TASK_CREATED, "task-working", created160("task-working", "session-direct")],
      [WAL_TYPES.TASK_STATUS_CHANGED, "task-working", running],
      [WAL_TYPES.TASK_CREATED, "task-input", created160("task-input", "session-snapshot")],
      [WAL_TYPES.TASK_STATUS_CHANGED, "task-input", running],
      [WAL_TYPES.TASK_STATUS_CHANGED, "task-input", waiting]
    ];

    for (const source of ["snapshot", "wal"]) {
      for (const path of [paths.snapshot, paths.wal, paths.rotating, statePath]) await rm(path, { force: true });
      if (source === "snapshot") {
        const body = Buffer.from(JSON.stringify({ sessions, tasks: snapshotTasks, inbox: [] }), "utf8");
        const header = {
          version: 5, gatewayApiVersion: 1, writerVersion: "1.6.0", writerPid: 4242, createdAt: at, epoch: 0,
          walSeq: 0, bodyBytes: body.length, bodySha256: createHash("sha256").update(body).digest("hex")
        };
        await writeFile(paths.snapshot, Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), body, Buffer.from("\n")]));
      } else {
        const lines = walRecords.map(([type, key, payload], index) => encodeRecord({ v: 1, seq: index + 1, at, type, key, payload }));
        await writeFile(paths.wal, lines.join(""));
      }

      const { service, factory } = harness({ statePath, artifactRoot: join(directory, "artifacts") });
      try {
        await service.init();
        const interruption = { reason: "gateway_restarted", executionOutcome: "unknown", at: iso(EPOCH) };
        for (const taskId of ["task-working", "task-input"]) {
          const got = await service.call("task_get", { taskId }, MAIN);
          assert.equal(got.status, "failed", `${source} ${taskId}`);
          assert.deepEqual(got.interruption, interruption, `${source} ${taskId}`);
        }
        const direct = await service.call("task_result", { taskId: "task-working" }, MAIN);
        assert.deepEqual([direct.error, direct.interruption], [RESTART_MESSAGE, interruption], source);
        assert.deepEqual(direct.next, [
          { action: "session_check", sessionId: "session-direct" },
          { action: "decide_rerun", note: ACTED_NOTE }
        ], source);
        // The worker may have changed its copy before the restart: the diff is offered.
        assert.deepEqual((await service.call("task_result", { taskId: "task-input" }, MAIN)).next, [
          { action: "session_check", sessionId: "session-snapshot" },
          { action: "workspace_diff", sessionId: "session-snapshot" },
          { action: "decide_rerun", note: ACTED_NOTE }
        ], source);
        assert.equal(factory.starts, 0, "nothing was re-run");
      } finally {
        await service.shutdown().catch(() => {});
      }
    }
  });
});

test("a provider exit mid-turn reports provider_disconnected; the envelope keeps its fields and gains two", async () => {
  await withDirectory(async (directory) => {
    const statePath = join(directory, "state.json");
    const artifactRoot = join(directory, "artifacts");
    let taskId;
    let sessionId;
    let interruption;
    let delivered;
    let wal;
    const before = harness({ statePath, artifactRoot });
    try {
      await before.service.init();
      const { session, worker } = await open(before.service);
      sessionId = session.id;
      taskId = (await before.service.call("task_prompt", { sessionId, prompt: "go" }, MAIN)).taskId;
      before.clock.now += 1_000;
      worker.crash();
      await until(terminal(before.service, taskId), "task terminal");

      interruption = { reason: "provider_disconnected", executionOutcome: "unknown", at: iso(EPOCH + 1_000) };
      const got = await before.service.call("task_get", { taskId }, MAIN);
      assert.equal(got.status, "failed");
      assert.equal(got.statusMessage, "worker crashed", "legacy wording unchanged");
      assert.deepEqual(got.interruption, interruption);
      delivered = await before.service.call("task_result", { taskId }, MAIN);
      assert.deepEqual(Object.keys(delivered), [
        "ok", "sessionId", "turnId", "taskId", "status", "interruption", "next", "result", "error"
      ]);
      assert.equal(delivered.ok, false);
      assert.equal(delivered.status, "disconnected");
      assert.equal(delivered.error, "worker crashed");
      assert.deepEqual(delivered.interruption, interruption);
      assert.deepEqual(delivered.next, [{ action: "session_check", sessionId }, { action: "decide_rerun", note: ACTED_NOTE }]);
      // The session was not revived behind Main's back.
      assert.equal(session.status, "disconnected");
      assert.equal(before.factory.restores.length, 0);
      await before.service.flushPersist();
      wal = await readFile(statePaths(statePath).wal);
    } finally {
      await before.service.shutdown();
    }

    // Terminal handles and their interruption survive a restart unchanged, from
    // the snapshot and, with the snapshot gone, from the log alone.
    // Compared as the wire sees it: JSON drops the envelope's undefined fields.
    const wire = (value) => JSON.parse(JSON.stringify(value));
    for (const source of ["snapshot", "wal"]) {
      if (source === "wal") {
        await writeFile(statePaths(statePath).wal, wal, { mode: 0o600 });
        await rm(statePaths(statePath).snapshot, { force: true });
      }
      const after = harness({ statePath, artifactRoot });
      after.clock.now = EPOCH + 9_000;
      try {
        await after.service.init();
        assert.deepEqual((await after.service.call("task_get", { taskId }, MAIN)).interruption, interruption, source);
        assert.deepEqual(wire(await after.service.call("task_result", { taskId }, MAIN)), wire(delivered), source);
      } finally {
        await after.service.shutdown().catch(() => {});
      }
    }
  });
});

test("one provider exit reads the same whichever of turn failure and exit notice lands first", async () => {
  const outcomes = [];
  for (const order of ["exit_first", "turn_failure_first"]) {
    const { service, clock } = harness();
    try {
      const { session, worker } = await open(service);
      const { taskId } = await service.call("task_prompt", { sessionId: session.id, prompt: "go" }, MAIN);
      clock.now += 1_000;
      if (order === "exit_first") {
        worker.crash();
        await until(() => session.status === "disconnected", "provider exit");
        worker.turns[0].reject(new Error("worker crashed"));
      } else {
        // The rejection reaches the mailbox before the exit notice does.
        worker.alive = false;
        worker.turns[0].reject(new Error("worker crashed"));
        await until(terminal(service, taskId), "task terminal");
        worker.options.onExit?.(new Error("worker crashed"));
      }
      await until(terminal(service, taskId), "task terminal");
      await new Promise((resolve) => setImmediate(resolve));
      const got = await service.call("task_get", { taskId }, MAIN);
      outcomes.push({
        session: [session.status, session.statusReason, session.statusChangedAt],
        task: [got.status, got.statusMessage, got.interruption]
      });
    } finally {
      await service.shutdown().catch(() => {});
    }
  }
  const expected = {
    session: ["disconnected", "provider_disconnected", iso(EPOCH + 1_000)],
    task: ["failed", "worker crashed", { reason: "provider_disconnected", executionOutcome: "unknown", at: iso(EPOCH + 1_000) }]
  };
  assert.deepEqual(outcomes, [expected, expected]);
});

test("an orphan cancel reports orphan_cancelled with the legacy wording", async () => {
  const { service, clock } = harness({ orphanGraceMs: 10 });
  try {
    service.attachRoot(MAIN.rootId);
    const { session } = await open(service);
    const { taskId } = await service.call("task_prompt", { sessionId: session.id, prompt: "go" }, MAIN);
    service.detachRoot(MAIN.rootId);
    clock.now += 11;
    await service.runMaintenance();
    const interruption = { reason: "orphan_cancelled", executionOutcome: "unknown", at: iso(EPOCH + 11) };
    const got = await service.call("task_get", { taskId }, MAIN);
    assert.equal(got.status, "cancelled");
    assert.equal(got.statusMessage, "Cancelled after Main disconnect");
    assert.deepEqual(got.interruption, interruption);
    const result = await service.call("task_result", { taskId }, MAIN);
    assert.equal(result.ok, true);
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.interruption, interruption);
    assert.deepEqual(result.next, [
      { action: "session_check", sessionId: session.id }, { action: "decide_rerun", note: ACTED_NOTE }
    ]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("ordinary endings carry neither interruption nor next", async () => {
  const { service } = harness();
  try {
    const { session, worker } = await open(service);
    const ordinary = async (finish) => {
      const { taskId } = await service.call("task_prompt", { sessionId: session.id, prompt: "go" }, MAIN);
      await finish(worker.turns.at(-1), taskId);
      await until(terminal(service, taskId), "task terminal");
      const got = await service.call("task_get", { taskId }, MAIN);
      assert.equal(Object.hasOwn(got, "interruption"), false);
      assert.deepEqual(Object.keys(got), [
        "taskId", "sessionId", "turnId", "status", "ttl", "pollInterval", "createdAt", "lastUpdatedAt", "statusMessage", "origin"
      ]);
      return service.call("task_result", { taskId }, MAIN);
    };

    const completed = await ordinary((turn) => turn.resolve({ stopReason: "end_turn" }));
    assert.deepEqual(Object.keys(completed), ["ok", "sessionId", "turnId", "taskId", "status", "result"]);
    // A worker that answers with an error is still there: that is its answer,
    // not an interruption.
    const refused = await ordinary((turn) => turn.reject(new Error("model refused")));
    assert.deepEqual(Object.keys(refused), ["ok", "sessionId", "turnId", "taskId", "status", "result", "error"]);
    // Main's own cancel is Main's decision, not something that happened to it.
    const cancelled = await ordinary((_turn, taskId) => service.call("task_cancel", { taskId }, MAIN));
    assert.equal(Object.hasOwn(cancelled, "interruption") || Object.hasOwn(cancelled, "next"), false);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("next offers workspace_diff for a snapshot session the worker may have changed", async () => {
  await withDirectory(async (directory) => {
    const project = join(directory, "project");
    await mkdir(project);
    await writeFile(join(project, "a.txt"), "a\n");
    const { service } = harness({ workspaceRoot: join(directory, "workspaces") });
    try {
      const { session, worker } = await open(service, { cwd: project, workspace: "snapshot" });
      const { taskId } = await service.call("task_prompt", { sessionId: session.id, prompt: "go" }, MAIN);
      worker.crash();
      await until(terminal(service, taskId), "task terminal");
      assert.deepEqual((await service.call("task_result", { taskId }, MAIN)).next, [
        { action: "session_check", sessionId: session.id },
        { action: "workspace_diff", sessionId: session.id },
        { action: "decide_rerun", note: ACTED_NOTE }
      ]);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("check is read-only for observers too, and names it in the access table", async () => {
  assert.equal(isReadOnlyCall("session", { action: "check" }), true);
  const { service } = harness();
  try {
    const { session } = await open(service);
    const observed = await check(service, session.id, { ...MAIN, access: "observer" });
    assert.deepEqual(observed, { ok: true, sessionId: session.id, restorable: "restorable", method: "live", caveats: [] });
    await assert.rejects(check(service, session.id, { rootId: "main-b" }), { code: ERROR_CODES.NOT_SESSION_OWNER });
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("check decides from what is known, and never starts, resumes or opens anything", async () => {
  await withDirectory(async (directory) => {
    const { service, factory } = harness();
    const expectCheck = async (session, restorable, method, caveats) => {
      const before = contacts(factory);
      assert.deepEqual(await check(service, session.id), { ok: true, sessionId: session.id, restorable, method, caveats });
      assert.deepEqual(contacts(factory), before, "check contacted a worker");
    };
    try {
      // Live: nothing to restore.
      const live = await open(service);
      await expectCheck(live.session, "restorable", "live", []);

      // Unloaded: no process left, so the capabilities recorded at open decide.
      assert.equal(await service.unloadSession(live.session), true);
      assert.equal(service.clients.size, 0);
      await expectCheck(live.session, "restorable", "resume", []);

      // Not recorded (a pre-1.7 record) and no live process to ask.
      live.session.restoreCapabilities = null;
      await expectCheck(live.session, "unknown", null, ["provider_capabilities_unknown"]);

      // A load-only provider, again from what was recorded at open.
      factory.capabilities = { loadSession: true };
      const loadOnly = await open(service);
      assert.equal(await service.unloadSession(loadOnly.session), true);
      await expectCheck(loadOnly.session, "restorable", "load", []);

      // A provider that cannot restore at all.
      factory.capabilities = {};
      const neither = await open(service);
      neither.worker.crash();
      await until(() => neither.session.status === "disconnected", "provider exit");
      await expectCheck(neither.session, "not_restorable", null, ["provider_restore_unsupported"]);

      // The last restore failed: it may fail again.
      factory.capabilities = RESUME;
      const failing = await open(service);
      assert.equal(await service.unloadSession(failing.session), true);
      factory.restoreError = new Error("resume refused");
      await assert.rejects(service.call("config", { sessionId: failing.session.id, action: "list" }, MAIN), /resume refused/);
      factory.restoreError = null;
      assert.equal(failing.session.status, "unavailable");
      await expectCheck(failing.session, "restorable_with_caveats", "resume", ["last_restore_failed"]);

      // The provider is no longer installed.
      service.providerDetector = async () => [{ id: "claude", agentInstalled: false, adapterInstalled: true }];
      await expectCheck(failing.session, "not_restorable", null, ["provider_not_installed", "last_restore_failed"]);
      service.providerDetector = async () => [];
      await expectCheck(failing.session, "not_restorable", null, ["provider_not_installed", "last_restore_failed"]);
      service.providerDetector = async () => [{ id: "claude", agentInstalled: true, adapterInstalled: true }];

      // The working directory is gone: a restore would fail on it. A live
      // session keeps working, so there it is only a caveat.
      const cwd = join(directory, "cwd");
      await mkdir(cwd);
      const gone = await open(service, { cwd });
      await rm(cwd, { recursive: true });
      await expectCheck(gone.session, "restorable_with_caveats", "live", ["cwd_missing"]);
      gone.worker.crash();
      await until(() => gone.session.status === "disconnected", "provider exit");
      await expectCheck(gone.session, "not_restorable", null, ["cwd_missing"]);

      // A snapshot session's copy is its cwd, named for what it is.
      const project = join(directory, "project");
      await mkdir(project);
      await writeFile(join(project, "a.txt"), "a\n");
      service.workspaceRoot = join(directory, "workspaces");
      const snapshot = await open(service, { cwd: project, workspace: "snapshot" });
      snapshot.worker.crash();
      await until(() => snapshot.session.status === "disconnected", "provider exit");
      await expectCheck(snapshot.session, "restorable", "resume", []);
      await rm(snapshot.session.workspace.path, { recursive: true });
      await expectCheck(snapshot.session, "not_restorable", null, ["workspace_missing"]);

      // Missing identity, and a closed record.
      const bare = await open(service);
      bare.worker.crash();
      await until(() => bare.session.status === "disconnected", "provider exit");
      const acpSessionId = bare.session.acpSessionId;
      bare.session.acpSessionId = null;
      await expectCheck(bare.session, "not_restorable", null, ["acp_session_id_missing"]);
      bare.session.acpSessionId = acpSessionId;
      bare.session.status = "closed";
      await expectCheck(bare.session, "not_restorable", null, ["session_closed"]);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("check answers while a restore is in flight, without waiting for it", async () => {
  const { service, factory } = harness();
  try {
    const { session } = await open(service);
    assert.equal(await service.unloadSession(session), true);
    let release;
    factory.restoreGate = new Promise((resolve) => { release = resolve; });
    const listed = service.call("config", { sessionId: session.id, action: "list" }, MAIN);
    await until(() => factory.restores.length === 1, "resume in flight");
    const before = contacts(factory);
    assert.deepEqual(await check(service, session.id), {
      ok: true, sessionId: session.id, restorable: "unknown", method: "resume", caveats: ["restore_in_progress"]
    });
    assert.deepEqual(contacts(factory), before);
    release();
    await listed;
    assert.equal((await check(service, session.id)).method, "live");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("every restore records its outcome, and a failed one says what it tried and why", async () => {
  const { service, clock, factory } = harness();
  try {
    const { opened, session } = await open(service);
    assert.deepEqual([opened.generation, opened.lastRestore], [1, null]);

    assert.equal(await service.unloadSession(session), true);
    clock.now += 1_000;
    await service.call("config", { sessionId: session.id, action: "list" }, MAIN);
    assert.deepEqual(session.lastRestore, { at: iso(EPOCH + 1_000), method: "resume", outcome: "resumed", errorCode: null });
    assert.equal(session.generation, 2);
    const restored = session.events.filter((event) => event.type === "session_restored").at(-1);
    assert.deepEqual([restored.method, restored.outcome], ["resume", "resumed"]);

    factory.capabilities = { loadSession: true };
    assert.equal(await service.unloadSession(session), true);
    clock.now += 1_000;
    await service.call("config", { sessionId: session.id, action: "list" }, MAIN);
    assert.deepEqual(session.lastRestore, { at: iso(EPOCH + 2_000), method: "load", outcome: "loaded", errorCode: null });
    assert.equal(session.generation, 3);

    // The worker refused: the method is known, and the code is the registry's.
    factory.capabilities = RESUME;
    assert.equal(await service.unloadSession(session), true);
    factory.restoreError = new GatewayError(ERROR_CODES.ACP_ERROR, "Resource not found");
    clock.now += 1_000;
    await assert.rejects(service.call("config", { sessionId: session.id, action: "list" }, MAIN), /Resource not found/);
    assert.deepEqual(session.lastRestore, { at: iso(EPOCH + 3_000), method: "resume", outcome: "failed", errorCode: "ACP_ERROR" });
    const failed = session.events.filter((event) => event.type === "session_restore_failed").at(-1);
    assert.deepEqual([failed.method, failed.outcome, failed.errorCode], ["resume", "failed", "ACP_ERROR"]);
    assert.equal(session.generation, 3, "a failed restore is not a new connection");

    // The provider never started: no method was chosen, and a non-registry
    // error reads as GATEWAY_ERROR. (The refused resume left a live process
    // behind; retire it so the next restore has to start one.)
    for (const worker of factory.workers) await worker.stop();
    factory.restoreError = null;
    factory.startError = new Error("spawn ENOENT");
    clock.now += 1_000;
    await assert.rejects(service.call("config", { sessionId: session.id, action: "list" }, MAIN), /spawn ENOENT/);
    assert.deepEqual(session.lastRestore, { at: iso(EPOCH + 4_000), method: null, outcome: "failed", errorCode: "GATEWAY_ERROR" });

    // Read-model facts: session get/list and diagnostic, never the default or compact poll.
    factory.startError = null;
    const got = await service.call("session", { action: "get", sessionId: session.id }, MAIN);
    assert.deepEqual([got.generation, got.lastRestore], [3, session.lastRestore]);
    const diagnostic = await service.call("poll", { sessionId: session.id, cursor: 0, responseProfile: "diagnostic" }, MAIN);
    assert.deepEqual([diagnostic.generation, diagnostic.lastRestore], [3, session.lastRestore]);
    for (const responseProfile of ["current", "compact"]) {
      const poll = await service.call("poll", { sessionId: session.id, cursor: 0, responseProfile }, MAIN);
      assert.equal(Object.hasOwn(poll, "generation") || Object.hasOwn(poll, "lastRestore"), false, responseProfile);
    }
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("an explicit restore mints generation 1 with the restore as its last one", async () => {
  const { service, factory } = harness();
  try {
    const restored = await service.call(
      "session_restore", { provider: "claude", acpSessionId: "external-1", cwd: process.cwd() }, MAIN
    );
    assert.equal(restored.restoredWith, "resume");
    assert.equal(restored.generation, 1);
    assert.deepEqual(restored.lastRestore, { at: iso(EPOCH), method: "resume", outcome: "resumed", errorCode: null });
    assert.equal(factory.opened, 0);

    // A refused explicit restore registers nothing and opens nothing.
    factory.restoreError = new Error("unknown session");
    await assert.rejects(
      service.call("session_restore", { provider: "claude", acpSessionId: "external-2", cwd: process.cwd() }, MAIN),
      /unknown session/
    );
    assert.equal(service.store.list().length, 1);
    assert.equal(factory.opened, 0);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a failed resume never opens a fresh session in its place", async () => {
  const { service, factory } = harness();
  try {
    const { session } = await open(service);
    assert.equal(factory.opened, 1);
    const acpSessionId = session.acpSessionId;
    assert.equal(await service.unloadSession(session), true);
    factory.restoreError = new GatewayError(ERROR_CODES.ACP_ERROR, "Resource not found");

    await assert.rejects(service.call("prompt", { sessionId: session.id, prompt: "go" }, MAIN), /Resource not found/);
    await assert.rejects(service.call("task_prompt", { sessionId: session.id, prompt: "go" }, MAIN), /Resource not found/);
    await assert.rejects(service.call("run", { sessionId: session.id, prompt: "go", waitMs: 0 }, MAIN), /Resource not found/);
    // Each attempt tried to resume the same ACP session, and only that.
    assert.deepEqual(factory.restores, ["session/resume", "session/resume", "session/resume"]);
    assert.equal(factory.opened, 1, "no session/new behind Main's back");
    assert.equal(session.acpSessionId, acpSessionId);
    assert.equal(session.generation, 1);
    assert.equal(session.status, "unavailable");
    assert.equal(service.store.list().length, 1);
    assert.equal(factory.workers.flatMap((worker) => worker.turns).length, 0, "the prompt reached no worker");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("generation, lastRestore and the known capabilities survive a restart; pre-1.7 records read as 1", async () => {
  await withDirectory(async (directory) => {
    const statePath = join(directory, "state.json");
    const artifactRoot = join(directory, "artifacts");
    let sessionId;
    let lastRestore;
    const before = harness({ statePath, artifactRoot });
    try {
      await before.service.init();
      const { session } = await open(before.service);
      sessionId = session.id;
      assert.equal(await before.service.unloadSession(session), true);
      await before.service.call("config", { sessionId, action: "list" }, MAIN);
      assert.equal(session.generation, 2);
      lastRestore = session.lastRestore;
      await before.service.flushPersist();
      const [record] = JSON.parse(await readFile(statePath, "utf8")).sessions;
      assert.deepEqual([record.generation, record.lastRestore, record.restoreCapabilities],
        [2, lastRestore, { resume: true, load: false }]);
    } finally {
      await before.service.shutdown();
    }

    const after = harness({ statePath, artifactRoot });
    try {
      await after.service.init();
      const got = await after.service.call("session", { action: "get", sessionId }, MAIN);
      assert.deepEqual([got.generation, got.lastRestore], [2, lastRestore]);
      // No process has started since the restart; the recorded capabilities answer.
      assert.deepEqual(await check(after.service, sessionId), {
        ok: true, sessionId, restorable: "restorable", method: "resume", caveats: []
      });
      assert.equal(after.factory.starts, 0);
      await after.service.call("config", { sessionId, action: "list" }, MAIN);
      assert.equal(after.service.requireSession(sessionId).generation, 3);
    } finally {
      await after.service.shutdown();
    }

    // A checkpoint written before 1.7 has none of the three.
    const legacy = JSON.parse(await readFile(statePath, "utf8"));
    for (const record of legacy.sessions) {
      delete record.generation;
      delete record.lastRestore;
      delete record.restoreCapabilities;
    }
    await rm(statePaths(statePath).snapshot, { force: true });
    await rm(statePaths(statePath).wal, { force: true });
    await writeFile(statePath, `${JSON.stringify(legacy)}\n`);
    const old = harness({ statePath, artifactRoot });
    try {
      await old.service.init();
      const got = await old.service.call("session", { action: "get", sessionId }, MAIN);
      assert.deepEqual([got.generation, got.lastRestore], [1, null]);
      assert.deepEqual((await check(old.service, sessionId)).caveats, ["provider_capabilities_unknown"]);
    } finally {
      await old.service.shutdown();
    }
  });
});
