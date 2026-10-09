// 1.8.0 U6: what the Gateway keeps on disk, and for how long. The v5 snapshot
// holds large task results by reference and, with the WAL on, is rewritten at
// most once per interval; the v4 state.json is no longer written; quarantine
// copies, crashed writers' temporaries and orphaned snapshot workspaces are
// bounded or reclaimed; a closed pinned session ages out; the resolved inbox cap
// holds between gc ticks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { GatewayService } from "../src/gateway-service.js";
import { GatewaySettings } from "../src/settings.js";
import { decodeRecord, statePaths, WAL_TYPES } from "../src/state-store.js";
import { createSnapshot } from "../src/workspace.js";
import { readSnapshotBody } from "./helpers/state-files.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MAIN = { rootId: "main-a" };
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDirectory(name, run) {
  const directory = await mkdtemp(join(tmpdir(), `acp-hygiene-${name}-`));
  try {
    return await run(directory);
  } finally {
    await chmod(join(directory, "workspaces"), 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

async function until(predicate, description) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function mockService(directory, options = {}) {
  return new GatewayService({
    statePath: join(directory, "state.json"),
    artifactRoot: join(directory, "artifacts"),
    workspaceRoot: join(directory, "workspaces"),
    createClient: (_provider, clientOptions) => new AcpClient(
      { provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" },
      clientOptions
    ),
    gcIntervalMs: 0,
    ...options
  });
}

function openMock(service) {
  return service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, MAIN);
}

async function runTask(service, prompt) {
  const opened = await openMock(service);
  const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt, ttl: 600_000 }, MAIN);
  await until(async () => ["completed", "failed", "cancelled"]
    .includes((await service.call("task_get", { taskId: task.taskId }, MAIN)).status), "a terminal task");
  return { opened, taskId: task.taskId };
}

async function snapshotTask(statePath, taskId) {
  return (await readSnapshotBody(statePath)).tasks.find((task) => task.taskId === taskId);
}

async function walRecords(statePath) {
  const raw = await readFile(statePaths(statePath).wal, "utf8");
  return raw.split("\n").filter(Boolean).map((line) => decodeRecord(Buffer.from(line, "utf8")));
}

function countSnapshotWrites(service) {
  const times = [];
  const write = service.stateStore.writeSnapshot.bind(service.stateStore);
  service.stateStore.writeSnapshot = (options) => {
    times.push(performance.now());
    return write(options);
  };
  return times;
}

// --------------------------------------------------------------- P1: results

test("the snapshot holds a large result by reference, and a restart restores it from the artifact", async () => {
  await withDirectory("byref", async (directory) => {
    const statePath = join(directory, "state.json");
    const persistence = { walInlineResultBytes: 64 };
    let taskId;
    let expected;
    let ref;
    const first = mockService(directory, { persistence });
    try {
      await first.init();
      ({ taskId } = await runTask(first, "large-result"));
      expected = await first.call("task_result", { taskId }, MAIN);
      first.persistDirty = true;
      await first.flushPersist();

      const record = await snapshotTask(statePath, taskId);
      ref = record.resultRef;
      assert.equal(typeof ref.path, "string");
      assert.equal(ref.sha256, createHash("sha256").update(await readFile(ref.path)).digest("hex"));
      // The degraded head is all a lost artifact (or a pre-1.8 reader) gets.
      assert.equal(record.result.resultDegraded, true);
      const raw = await readFile(statePaths(statePath).snapshot, "utf8");
      assert.equal(raw.includes(expected.result.text), false, "the envelope itself is not in the snapshot");
    } finally {
      await first.shutdown();
    }

    // The clean shutdown rotated, so the log is empty: the snapshot's reference
    // is the only way back to the result.
    const second = mockService(directory, { persistence });
    try {
      await second.init();
      assert.equal((await second.call("setup", {}, MAIN)).persistence.lastRecovery.replayed, 0);
      assert.deepEqual(await second.call("task_result", { taskId }, MAIN), expected);
      // Restored from the artifact, so still written by the same reference.
      second.persistDirty = true;
      await second.flushPersist();
      assert.deepEqual((await snapshotTask(statePath, taskId)).resultRef, ref);
    } finally {
      await second.shutdown();
    }

    // The artifact gone: the outcome survives as the degraded head, exactly as
    // a WAL reference to a missing file degrades.
    await rm(ref.path);
    const third = mockService(directory, { persistence });
    try {
      await third.init();
      assert.equal((await third.call("task_get", { taskId }, MAIN)).status, "completed");
      assert.equal((await third.call("task_result", { taskId }, MAIN)).resultDegraded, true);
    } finally {
      await third.shutdown();
    }
  });
});

test("a small result stays inline in the snapshot", async () => {
  await withDirectory("inline", async (directory) => {
    const statePath = join(directory, "state.json");
    const service = mockService(directory);
    try {
      await service.init();
      const { taskId } = await runTask(service, "narrated-result");
      service.persistDirty = true;
      await service.flushPersist();
      const record = await snapshotTask(statePath, taskId);
      assert.equal(Object.hasOwn(record, "resultRef"), false);
      assert.equal(record.result.result.text, "FINAL ANSWER");
    } finally {
      await service.shutdown();
    }
  });
});

test("a spilled result that its barrier then failed is persisted as the failure, never by reference", async () => {
  await withDirectory("byref-failed", async (directory) => {
    const statePath = join(directory, "state.json");
    const persistence = { walInlineResultBytes: 64 };
    let taskId;
    const first = mockService(directory, { persistence });
    try {
      await first.init();
      const appendDurable = first.stateStore.appendDurable.bind(first.stateStore);
      first.stateStore.appendDurable = (type, ...args) => {
        if (type === WAL_TYPES.TASK_RESULT_COMMITTED) throw new Error("injected result fsync failure");
        return appendDurable(type, ...args);
      };
      ({ taskId } = await runTask(first, "large-result"));
      first.stateStore.appendDurable = appendDurable;
      assert.equal((await first.call("task_get", { taskId }, MAIN)).status, "failed");
      // The artifact landed before the barrier failed; the record no longer holds it.
      assert.equal(first.stateStore.resultRefPaths().length, 1);
      first.persistDirty = true;
      await first.flushPersist();
      const record = await snapshotTask(statePath, taskId);
      assert.equal(Object.hasOwn(record, "resultRef"), false);
      assert.equal(record.result.ok, false);
    } finally {
      await first.shutdown();
    }

    const second = mockService(directory, { persistence });
    try {
      await second.init();
      const result = await second.call("task_result", { taskId }, MAIN);
      assert.equal(result.ok, false);
      assert.match(result.error, /injected result fsync failure/);
    } finally {
      await second.shutdown();
    }
  });
});

test("a reference whose task recovery dropped stops pinning its artifact", async () => {
  await withDirectory("byref-expired", async (directory) => {
    let clock = Date.parse("2026-05-01T00:00:00.000Z");
    const persistence = { walInlineResultBytes: 64 };
    let path;
    const first = mockService(directory, { persistence, now: () => clock });
    try {
      await first.init();
      await runTask(first, "large-result");
      [path] = first.stateStore.resultRefPaths();
      assert.equal(typeof path, "string");
    } finally {
      await first.shutdown();
    }

    clock += 700_000; // past the task's 600s TTL while the daemon was down
    const second = mockService(directory, { persistence, now: () => clock });
    try {
      await second.init();
      assert.equal(second.taskStore.size, 0);
      assert.deepEqual(second.stateStore.resultRefPaths(), [], "maintenance may age the artifact out again");
    } finally {
      await second.shutdown();
    }
  });
});

// ------------------------------------------------------------- P1: cadence

test("with the WAL on, a burst of changes rewrites the snapshot at most once per interval, and the last change lands", async () => {
  await withDirectory("cadence", async (directory) => {
    const statePath = join(directory, "state.json");
    const interval = 300;
    const service = mockService(directory, { snapshotIntervalMs: interval });
    try {
      await service.init();
      const { sessionId } = await openMock(service);
      service.persistDirty = true;
      await service.flushPersist();
      const writes = countSnapshotWrites(service);
      let pinned = false;
      const started = performance.now();
      let changes = 0;
      while (performance.now() - started < 900) {
        pinned = !pinned;
        await service.call("session", { action: pinned ? "pin" : "unpin", sessionId }, MAIN);
        changes += 1;
        await delay(10);
      }
      // The 50ms debounce alone would have rewritten it a dozen times or more.
      assert.ok(changes > 30, `${changes} changes`);
      assert.ok(writes.length <= 4, `${writes.length} snapshot writes during the burst`);
      for (let index = 1; index < writes.length; index += 1) {
        assert.ok(writes[index] - writes[index - 1] >= interval - 25, `writes ${writes[index] - writes[index - 1]}ms apart`);
      }
      await delay(interval + 200);
      assert.equal((await readSnapshotBody(statePath)).sessions[0].pinned, pinned, "the trailing write has the last change");
    } finally {
      await service.shutdown();
    }
  });
});

test("with the WAL off, the 50 ms debounce stays", async () => {
  await withDirectory("cadence-off", async (directory) => {
    const service = mockService(directory, { persistence: { wal: false }, snapshotIntervalMs: 60_000 });
    try {
      await service.init();
      const { sessionId } = await openMock(service);
      service.persistDirty = true;
      await service.flushPersist();
      const writes = countSnapshotWrites(service);
      await service.call("session", { action: "pin", sessionId }, MAIN);
      await until(() => writes.length >= 1, "the first debounced write");
      await service.call("session", { action: "unpin", sessionId }, MAIN);
      await until(() => writes.length >= 2, "a second write well inside the WAL-on interval");
    } finally {
      await service.shutdown();
    }
  });
});

test("shutdown writes what the snapshot interval was still holding back", async () => {
  await withDirectory("cadence-shutdown", async (directory) => {
    const statePath = join(directory, "state.json");
    const service = mockService(directory, { snapshotIntervalMs: 60_000 });
    try {
      await service.init();
      const { sessionId } = await openMock(service);
      service.persistDirty = true;
      await service.flushPersist();
      await service.call("session", { action: "pin", sessionId }, MAIN);
      assert.notEqual(service.persistTimer, null, "the write is held back by the interval");
      assert.equal((await readSnapshotBody(statePath)).sessions[0].pinned, false);
    } finally {
      await service.shutdown();
    }
    assert.equal((await readSnapshotBody(statePath)).sessions[0].pinned, true);
  });
});

// ------------------------------------------------------------ v4 state.json

test("a state.json a 1.7 daemon left beside a valid snapshot is not read, and is retired", async () => {
  await withDirectory("legacy-marked", async (directory) => {
    const statePath = join(directory, "state.json");
    let sessionId;
    const first = mockService(directory);
    try {
      await first.init();
      ({ sessionId } = await openMock(first));
    } finally {
      await first.shutdown();
    }
    const [record] = (await readSnapshotBody(statePath)).sessions;
    // Marked, as every 1.4-1.7 v5 daemon wrote it, so not a downgrade.
    await writeFile(statePath, `${JSON.stringify({
      version: 4, writerVersion: "1.7.2", sessions: [{ ...record, id: "acp-stale" }], tasks: [], inbox: []
    })}\n`, { mode: 0o600 });

    const second = mockService(directory);
    try {
      await second.init();
      assert.equal((await second.call("setup", {}, MAIN)).persistence.lastRecovery.source, "snapshot");
      assert.deepEqual((await second.call("session", { action: "list" }, MAIN)).sessions.map((item) => item.sessionId), [sessionId]);
      assert.equal(existsSync(statePath), false);
    } finally {
      await second.shutdown();
    }
  });
});

// ------------------------------------------------- W11: quarantine and temps

test("quarantine copies are bounded per file and reason, and age out", async () => {
  await withDirectory("quarantine-bound", async (directory) => {
    const statePath = join(directory, "state.json");
    const paths = statePaths(statePath);
    const clock = Date.parse("2026-06-10T12:00:00.000Z");
    const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, "-");
    const copy = (path, reason, age) => `${basename(path)}.${reason}-${stamp(clock - age)}`;
    const walCopies = [1, 2, 3, 4, 5].map((hours) => copy(paths.wal, "corrupt", hours * HOUR));
    const recentDowngrade = copy(paths.snapshot, "downgraded", HOUR);
    const oldDowngrade = copy(paths.snapshot, "downgraded", 8 * DAY);
    const rotGap = copy(paths.rotating, "gap", 2 * HOUR);
    const unrelated = [`${basename(paths.wal)}.corrupt-not-a-stamp`, `other.json.corrupt-${stamp(clock - 9 * DAY)}`];
    for (const name of [...walCopies, recentDowngrade, oldDowngrade, rotGap, ...unrelated]) {
      await writeFile(join(directory, name), "x\n");
    }

    const service = new GatewayService({ statePath, now: () => clock, gcIntervalMs: 0 });
    try {
      await service.init();
    } finally {
      await service.shutdown();
    }
    const left = new Set(await readdir(directory));
    assert.deepEqual(walCopies.map((name) => left.has(name)), [true, true, true, false, false], "the newest three");
    assert.equal(left.has(recentDowngrade), true);
    assert.equal(left.has(oldDowngrade), false, "older than a week");
    assert.equal(left.has(rotGap), true, "the .rot file's copies are counted on their own");
    for (const name of unrelated) assert.equal(left.has(name), true, name);
  });
});

test("repeated halting starts keep three copies, including the one the error names", async () => {
  await withDirectory("quarantine-halts", async (directory) => {
    const statePath = join(directory, "state.json");
    const paths = statePaths(statePath);
    await writeFile(paths.wal, "not a record\n{}\n", { mode: 0o600 });
    let clock = Date.parse("2026-06-10T12:00:00.000Z");
    let named = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      clock += 1_000;
      const halting = new GatewayService({ statePath, now: () => clock, gcIntervalMs: 0 });
      await assert.rejects(halting.init(), (error) => {
        assert.equal(error.code, "STATE_WAL_CORRUPT");
        named = /A copy is at (\S+?)\. /.exec(error.message)?.[1];
        return true;
      });
    }
    const copies = (await readdir(directory)).filter((name) => name.startsWith(`${basename(paths.wal)}.corrupt-`));
    assert.equal(copies.length, 3);
    assert.ok(named && existsSync(named), "the copy the last error points at is kept");
  });
});

test("temporaries a dead writer left are swept at startup; a live writer's are not", async () => {
  await withDirectory("temporaries", async (directory) => {
    const statePath = join(directory, "state.json");
    const paths = statePaths(statePath);
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const settingsPath = join(directory, "config", "settings.json");
    await mkdir(join(directory, "config"));
    const files = {
      deadSnapshot: `${paths.snapshot}.${dead}.tmp`,
      deadLegacy: `${statePath}.${dead}.tmp`,
      liveSnapshot: `${paths.snapshot}.${process.ppid}.tmp`,
      notOurs: `${paths.snapshot}.backup.tmp`,
      oldSettings: `${settingsPath}.${randomUUID()}.tmp`,
      freshSettings: `${settingsPath}.${randomUUID()}.tmp`
    };
    for (const path of Object.values(files)) await writeFile(path, "partial");
    const hourAgo = new Date(Date.now() - HOUR);
    await utimes(files.oldSettings, hourAgo, hourAgo);
    const settings = () => new GatewaySettings({ path: settingsPath, legacy: join(directory, "config", "install.json"), env: {} });

    const service = new GatewayService({ statePath, settings: settings(), gcIntervalMs: 0 });
    try {
      await service.init();
    } finally {
      await service.shutdown();
    }
    const exists = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, existsSync(path)]));
    assert.deepEqual(exists, {
      deadSnapshot: false, deadLegacy: false, liveSnapshot: true, notOurs: true, oldSettings: false, freshSettings: true
    });

    // A settings writer holding its lock may still own an old-looking temporary.
    const held = `${settingsPath}.${randomUUID()}.tmp`;
    await writeFile(held, "partial");
    await utimes(held, hourAgo, hourAgo);
    await writeFile(`${settingsPath}.write.lock`, `${process.pid}\n`);
    const locked = new GatewayService({ statePath, settings: settings(), gcIntervalMs: 0 });
    try {
      await locked.init();
    } finally {
      await locked.shutdown();
    }
    assert.equal(existsSync(held), true);
  });
});

// A snapshot or settings file replaced by rename keeps its bytes under any other
// name it has, out of reach of the protected directory's inode check: a hard
// link made to it would go on holding the state (results, inbox payloads) or the
// settings it held. Nothing keeps that file on purpose, a quarantine copy being
// a copy, so each replacement empties it once the rename stands.
test("a snapshot or settings file replaced by a newer one keeps nothing under a hard link", async () => {
  await withDirectory("replaced", async (directory) => {
    const statePath = join(directory, "state.json");
    const service = mockService(directory);
    try {
      await service.init();
      await openMock(service);
      service.persistDirty = true;
      await service.flushPersist();
      await link(statePaths(statePath).snapshot, join(directory, "linked-snapshot.json"));
      assert.equal(
        await readFile(join(directory, "linked-snapshot.json"), "utf8"),
        await readFile(statePaths(statePath).snapshot, "utf8")
      );
    } finally {
      await service.shutdown();
    }
    assert.equal(await readFile(join(directory, "linked-snapshot.json"), "utf8"), "", "the shutdown's snapshot replaced it");
    assert.equal((await readSnapshotBody(statePath)).sessions.length, 1, "and is whole");

    const settingsPath = join(directory, "config", "settings.json");
    const settings = new GatewaySettings({ path: settingsPath, legacy: join(directory, "config", "install.json"), env: {} });
    settings.update({ expectedRevision: 0, values: { maxEvents: 300 } });
    await link(settingsPath, join(directory, "linked-settings.json"));
    settings.update({ expectedRevision: 1, values: { maxEvents: 400 } });
    assert.equal(await readFile(join(directory, "linked-settings.json"), "utf8"), "");
    assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).values.maxEvents, 400);
  });
});

// ------------------------------------------------------ P6: snapshot copies

// The smallest worker session_open accepts. sessionNew waits on factory.gate,
// which holds an open between its copy and its registration.
class FakeWorker {
  constructor(options, factory) {
    this.options = options;
    this.factory = factory;
    this.config = { modelScope: "session" };
    this.alive = false;
    this.initResult = null;
  }

  async start() {
    this.alive = true;
    this.initResult = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } };
    return this.initResult;
  }

  async sessionNew() {
    this.factory.opened += 1;
    await this.factory.gate;
    return { sessionId: `fake-${this.factory.opened}`, configOptions: [] };
  }

  onSessionUpdate() {}
  clearSession() {}
  cancelSession() {}
  pendingSessionInput() { return { permissions: 0, elicitations: 0 }; }
  async setSessionConfigOption() { return { configOptions: [] }; }
  async request() { return {}; }
  async stop() { this.alive = false; }
}

async function workspaceFixture(directory, options = {}) {
  const project = join(directory, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "a.txt"), "a".repeat(600));
  const factory = { opened: 0, gate: null };
  const service = new GatewayService({
    // Beside the project, never around it: the state directory is protected.
    statePath: join(directory, "state", "state.json"),
    artifactRoot: join(directory, "artifacts"),
    workspaceRoot: join(directory, "workspaces"),
    gcIntervalMs: 0,
    createClient: (_provider, clientOptions) => new FakeWorker(clientOptions, factory),
    ...options
  });
  const open = () => service.call("session_open", { provider: "claude", cwd: project, workspace: "snapshot" }, MAIN);
  return { service, factory, project, open };
}

async function copies(directory) {
  return (await readdir(join(directory, "workspaces"))).filter((name) => name.startsWith("ws-")).sort();
}

test("an orphaned copy this state made is reclaimed at startup; copies it cannot vouch for are left", async () => {
  await withDirectory("ws-orphans", async (directory) => {
    const first = await workspaceFixture(directory);
    let live;
    let owner;
    try {
      await first.service.init();
      owner = first.service.workspaceOwner;
      const opened = await first.open();
      live = first.service.requireSession(opened.sessionId).workspace.home;
      assert.equal(JSON.parse(await readFile(join(live, "owner.json"), "utf8")).state, owner);
    } finally {
      await first.service.shutdown();
    }

    const root = await realpath(join(directory, "workspaces"));
    const plant = async (marker) => {
      const home = join(root, `ws-${randomUUID()}`);
      await mkdir(join(home, "tree"), { recursive: true });
      if (marker) await writeFile(join(home, "owner.json"), `${JSON.stringify(marker)}\n`);
      return home;
    };
    // A crash between a copy and its registration leaves exactly this.
    const mine = await plant({ state: owner });
    const foreign = await plant({ state: join(directory, "elsewhere", "state.json") });
    const unmarked = await plant(null);
    await mkdir(join(root, "not-a-copy"));

    const second = await workspaceFixture(directory);
    try {
      await second.service.init();
      assert.equal(existsSync(mine), false, "reclaimed");
      for (const home of [live, foreign, unmarked, join(root, "not-a-copy")]) assert.equal(existsSync(home), true, home);
    } finally {
      await second.service.shutdown();
    }
  });
});

test("a copy still being opened is never taken for an orphan", async () => {
  await withDirectory("ws-inflight", async (directory) => {
    const { service, factory, open } = await workspaceFixture(directory);
    try {
      await service.init();
      let release;
      factory.gate = new Promise((resolve) => { release = resolve; });
      const opening = open();
      await until(() => factory.opened === 1, "the copy to exist, its registration held");
      const [name] = await copies(directory);
      assert.ok(name);
      await service.runMaintenance();
      assert.deepEqual(await copies(directory), [name], "not reclaimed while its open is in flight");
      release();
      const opened = await opening;
      assert.equal(basename(service.requireSession(opened.sessionId).workspace.home), name);
      await service.runMaintenance();
      assert.deepEqual(await copies(directory), [name], "referenced now");
    } finally {
      await service.shutdown();
    }
  });
});

test("a failed delete is kept and retried until the copy is gone", { skip: process.getuid?.() === 0 && "root ignores directory permissions" }, async () => {
  await withDirectory("ws-retry", async (directory) => {
    const { service, open } = await workspaceFixture(directory);
    try {
      await service.init();
      const opened = await open();
      const { home } = service.requireSession(opened.sessionId).workspace;
      const root = join(directory, "workspaces");
      await chmod(root, 0o500);
      try {
        await service.call("session", { action: "close", sessionId: opened.sessionId }, MAIN);
        assert.equal(existsSync(home), true, "the copy could not be deleted");
        assert.equal(service.workspaceRemovals.get(home)?.failures, 1, "and is remembered");
        await service.runMaintenance();
        assert.equal(service.workspaceRemovals.get(home)?.failures, 2, "retried");
      } finally {
        await chmod(root, 0o700);
      }
      await service.runMaintenance();
      assert.equal(existsSync(home), false);
      assert.equal(service.workspaceRemovals.size, 0);
    } finally {
      await service.shutdown();
    }
  });
});

test("the combined snapshot budget is enforced at session_open, and a closed copy gives its room back", async () => {
  await withDirectory("ws-budget", async (directory) => {
    const { service, open } = await workspaceFixture(directory, { maxSnapshotTotalBytes: 1_000 });
    try {
      await service.init();
      const first = await open();
      await assert.rejects(open(), (error) => {
        assert.equal(error.code, "WORKSPACE_ERROR");
        assert.deepEqual(error.details, { bytes: 600, usedBytes: 600, limitBytes: 1_000 });
        return true;
      });
      assert.equal((await copies(directory)).length, 1, "a refused open copies nothing");

      await service.call("session", { action: "close", sessionId: first.sessionId }, MAIN);
      const second = await open();
      await service.call("session", { action: "close", sessionId: second.sessionId }, MAIN);

      // Room for one: of two opens at once, exactly one is admitted.
      const outcomes = await Promise.allSettled([open(), open()]);
      assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
      assert.equal(outcomes.find((outcome) => outcome.status === "rejected").reason.code, "WORKSPACE_ERROR");
      assert.equal((await copies(directory)).length, 1);
    } finally {
      await service.shutdown();
    }
  });
});

test("a copy made before 1.8.0 is adopted by the state that references it", async () => {
  await withDirectory("ws-adopt", async (directory) => {
    const { service, project } = await workspaceFixture(directory);
    // As 1.7.x made it: no owner marker.
    const workspace = await createSnapshot(project, join(directory, "workspaces"));
    assert.equal(existsSync(join(workspace.home, "owner.json")), false);
    const at = new Date().toISOString();
    await mkdir(join(directory, "state"));
    await writeFile(join(directory, "state", "state.json"), `${JSON.stringify({
      version: 4,
      sessions: [{
        id: "acp-adopted", provider: "claude", acpSessionId: "acp-1", cwd: workspace.path, title: null,
        permissionPolicy: "ask", model: null, ownerRootId: MAIN.rootId, mcpServers: [], additionalDirectories: [],
        pinned: false, status: "idle", createdAt: at, updatedAt: at, completedAt: null, orphanedAt: null,
        lastOwnerActivityAt: at, transientClearedAt: null, eventSequence: 1, turnId: null, stopReason: null, workspace
      }],
      tasks: [],
      inbox: []
    })}\n`, { mode: 0o600 });
    try {
      await service.init();
      const marker = JSON.parse(await readFile(join(workspace.home, "owner.json"), "utf8"));
      assert.equal(marker.state, service.workspaceOwner);
      assert.equal(existsSync(workspace.path), true, "a referenced copy is never reclaimed");
    } finally {
      await service.shutdown();
    }
  });
});

// ------------------------------------------------------------ small retention

test("a closed pinned session ages out like any closed session; an open pinned one does not", async () => {
  await withDirectory("pinned-closed", async (directory) => {
    const statePath = join(directory, "state.json");
    let clock = Date.parse("2026-04-01T00:00:00.000Z");
    const at = new Date(clock - DAY).toISOString();
    const session = (id, status) => ({
      id, provider: "claude", acpSessionId: `acp-${id}`, cwd: "/", title: null, permissionPolicy: "ask", model: null,
      ownerRootId: MAIN.rootId, mcpServers: [], additionalDirectories: [], pinned: true, status, createdAt: at,
      updatedAt: at, completedAt: at, orphanedAt: null, lastOwnerActivityAt: at, transientClearedAt: null,
      eventSequence: 1, turnId: null, stopReason: null
    });
    await writeFile(statePath, `${JSON.stringify({
      version: 4, sessions: [session("acp-closed", "closed"), session("acp-open", "idle")], tasks: [], inbox: []
    })}\n`, { mode: 0o600 });
    const service = new GatewayService({ statePath, now: () => clock, gcIntervalMs: 0 });
    try {
      await service.init();
      const preview = await service.call("retention_preview", { values: { sessionRetentionMs: HOUR } }, MAIN);
      assert.equal(preview.counts.sessions, 1, "only the closed one is eligible");
      clock += 7 * DAY;
      await service.runMaintenance();
      assert.deepEqual(service.store.list().map((item) => item.id), ["acp-open"]);
    } finally {
      await service.shutdown();
    }
  });
});

test("the resolved inbox cap holds as rows resolve, between gc ticks", async () => {
  await withDirectory("inbox-cap", async (directory) => {
    const statePath = join(directory, "state.json");
    let clock = Date.parse("2026-04-01T00:00:00.000Z");
    const service = new GatewayService({ statePath, now: () => clock, gcIntervalMs: 0, maxInboxHistoryPerRoot: 2 });
    try {
      await service.init();
      const session = service.store.create({
        id: "inbox-cap", provider: "mock", acpSessionId: "inbox-cap", cwd: "/", ownerRootId: MAIN.rootId,
        permissionPolicy: "ask", turnId: "turn-1"
      });
      const ask = (requestId) => {
        clock += 1_000;
        return service.createPermissionInbox(session, { requestId, toolCall: {}, options: [] });
      };
      const rows = () => [...service.inbox.values()];
      const answered = [];
      for (const requestId of [1, 2, 3, 4]) {
        answered.push(ask(requestId).inboxId);
        clock += 1;
        service.resolveInbox(session, requestId, "answered", "done");
      }
      assert.deepEqual(rows().map((item) => item.inboxId), answered.slice(2), "the two newest are kept");

      // An interrupt resolves several at once; a pending row is never evicted.
      const interrupted = [5, 6, 7].map((requestId) => ask(requestId).inboxId);
      service.interruptSessionInbox(session, "Main cancelled the worker session");
      const pending = ask(8).inboxId;
      assert.deepEqual(rows().map((item) => item.inboxId), [...interrupted.slice(1), pending]);

      // The evictions are durable: replay must not bring the rows back.
      const removed = (await walRecords(statePath)).filter((record) => record.type === WAL_TYPES.INBOX_REMOVED)
        .map((record) => record.key);
      assert.deepEqual(removed.sort(), [...answered, interrupted[0]].sort());
    } finally {
      await service.shutdown();
    }
  });
});
