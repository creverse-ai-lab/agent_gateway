// State v5 (PR 4): snapshot + critical WAL. These tests are in-process and
// deterministic — formats, replay, migration, rotation, health. The kill -9
// ordering matrix lives in test/crash-matrix.test.js.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, linkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { ArtifactStore } from "../src/artifacts.js";
import { GatewayService } from "../src/gateway-service.js";
import { claimStateLock, decodeRecord, encodeRecord, StateStore, statePaths, WAL_TYPES } from "../src/state-store.js";
import { writeFreshBase } from "./helpers/state-files.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MAIN = { rootId: "main-a" };
const fs = createRequire(import.meta.url)("fs");

// Replaces node:fs functions for the length of run(), each by wrap(original).
// The store imports them by name, and syncing the builtin ESM exports moves
// those bindings too (test/helpers/fault-fs.js does the same for a daemon).
async function withFs(wrappers, run) {
  const originals = Object.fromEntries(Object.keys(wrappers).map((name) => [name, fs[name]]));
  for (const [name, wrap] of Object.entries(wrappers)) fs[name] = wrap(originals[name]);
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}

// A disk that fills halfway through the next write of a WAL record naming key:
// half of the record reaches the file, then the write fails.
function halfThenNoSpace(key) {
  let armed = true;
  return (original) => function writeSync(fd, buffer, offset = 0, length = buffer.length - offset, ...rest) {
    if (!armed || !Buffer.isBuffer(buffer) || !buffer.includes(`"key":${JSON.stringify(key)}`)) {
      return original.call(this, fd, buffer, offset, length, ...rest);
    }
    armed = false;
    original.call(this, fd, buffer, offset, Math.floor(length / 2));
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  };
}

// Every line of the log decodes, and the seqs run without a gap.
async function assertWholeLog(paths) {
  const lines = (await readFile(paths.wal, "utf8")).split("\n");
  assert.equal(lines.pop(), "", "the log ends with a whole record");
  const records = lines.map((line) => decodeRecord(Buffer.from(line, "utf8")));
  assert.ok(records.every((record) => record != null), "every record passes its crc32");
  records.forEach((record, index) => {
    if (index > 0) assert.equal(record.seq, records[index - 1].seq + 1, "no seq is skipped");
  });
  return records;
}

function makeService(directory, { permissionPolicy = "read_only", ...options } = {}) {
  return new GatewayService({
    statePath: join(directory, "state.json"),
    createClient: (_provider, clientOptions) =>
      new AcpClient(
        { provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy },
        clientOptions
      ),
    gcIntervalMs: 0,
    ...options
  });
}

function openSession(service, permissionPolicy = "read_only") {
  return service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy }, MAIN);
}

async function waitForIdle(service, sessionId) {
  let last = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const poll = await service.call("poll", { sessionId, cursor: 0, waitMs: 100 }, MAIN);
    last = poll;
    if (poll.status === "idle") return poll;
    if (["error", "unavailable"].includes(poll.status)) throw new Error(poll.error);
  }
  throw new Error(`session never became idle (last status: ${last?.status})`);
}

// One completed task, taken all the way through the durable commit path.
async function runTask(service, prompt = "narrated-result") {
  const opened = await openSession(service);
  const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt, ttl: 600_000 }, MAIN);
  await waitForIdle(service, opened.sessionId);
  return { opened, task };
}

async function readWal(paths) {
  const raw = await readFile(paths.wal);
  return raw
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => decodeRecord(Buffer.from(line, "utf8")));
}

async function readSnapshot(paths) {
  const raw = await readFile(paths.snapshot, "utf8");
  const split = raw.indexOf("\n");
  return {
    header: JSON.parse(raw.slice(0, split)),
    body: JSON.parse(raw.slice(split + 1)),
    bodyText: raw.slice(split + 1).replace(/\n$/, "")
  };
}

// A daemon that died leaves an unrotated log behind. Reproduced without killing
// anything: keep the log bytes, let the service shut down cleanly (its worker
// child has to be reaped or the test runner never exits), then put the log back.
// rewind also puts back the snapshot it went on from, the empty one of the
// directory's first rotation (writeFreshBase), as a daemon killed before its
// next snapshot leaves it; otherwise the shutdown's snapshot, which covers the
// whole log, stays.
async function keepLogAcrossShutdown(service, paths, { rewind = true } = {}) {
  await service.flushPersist();
  const wal = await readFile(paths.wal);
  await service.shutdown();
  await writeFile(paths.wal, wal, { mode: 0o600 });
  if (rewind) await writeFreshBase(paths.state, wal);
  return wal;
}

async function withDirectory(name, run) {
  const directory = await mkdtemp(join(tmpdir(), `acp-${name}-`));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("v5 writes a two-line checksummed snapshot beside a crc32 WAL, and no longer writes v4", async () => {
  await withDirectory("state-format", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    const service = makeService(directory);
    try {
      await service.init();
      const { task } = await runTask(service);
      await service.flushPersist();

      const snapshot = await readSnapshot(paths);
      assert.equal(snapshot.header.version, 5);
      assert.equal(snapshot.header.gatewayApiVersion, 1);
      assert.equal(snapshot.header.writerPid, process.pid);
      assert.equal(typeof snapshot.header.epoch, "number");
      // The checksum covers the exact body bytes, so it is computed on the raw
      // text and not on a re-serialization of the parsed object.
      assert.equal(snapshot.header.bodyBytes, Buffer.byteLength(snapshot.bodyText));
      assert.equal(snapshot.header.bodySha256, createHash("sha256").update(snapshot.bodyText).digest("hex"));
      assert.equal(snapshot.body.tasks.length, 1);
      assert.equal(snapshot.body.tasks[0].taskId, task.taskId);
      assert.equal(snapshot.body.tasks[0].status, "completed");

      const records = await readWal(paths);
      assert.ok(records.every((record) => record != null), "every record must pass its crc32");
      assert.deepEqual(records.map((record) => record.type).slice(0, 3), [
        "wal.opened", "session.registered", "task.created"
      ]);
      assert.ok(records.some((record) => record.type === "task.result_committed"));
      // seq is the only ordering authority, so it must be dense and increasing.
      // It does not start at 1: init rotates, and the log that produced the
      // recovery snapshot took the first seqs with it.
      const first = records[0].seq;
      assert.deepEqual(
        records.map((record) => record.seq),
        records.map((_, index) => first + index)
      );

      // 1.8.0: the v4 dual-write (downgrade insurance through 1.5.x) is gone.
      await assert.rejects(readFile(paths.state, "utf8"), /ENOENT/, "no v4 state.json is written");
      await assert.rejects(stat(`${paths.state}.${process.pid}.tmp`), /ENOENT/);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("a completed task and its result survive a restart until its TTL", async () => {
  await withDirectory("state-restart", async (directory) => {
    const first = makeService(directory);
    let taskId = null;
    try {
      await first.init();
      const { task } = await runTask(first);
      taskId = task.taskId;
      assert.equal((await first.call("task_get", { taskId }, MAIN)).status, "completed");
    } finally {
      await first.shutdown();
    }

    const second = makeService(directory);
    try {
      await second.init();
      const got = await second.call("task_get", { taskId }, MAIN);
      assert.equal(got.status, "completed", "a terminal handle is durable across a restart");
      const result = await second.call("task_result", { taskId }, MAIN);
      assert.equal(result.result.text, "FINAL ANSWER");
      assert.equal(result.ok, true);
      // A clean shutdown rotates, so the restart replayed nothing.
      const status = (await second.call("setup", {}, MAIN)).persistence;
      assert.equal(status.mode, "wal");
      assert.equal(status.lastRecovery.replayed, 0);
      assert.equal(status.lastRecovery.source, "snapshot");
    } finally {
      await second.shutdown();
    }
  });
});

test("a failed result barrier never exposes success and restart agrees on failure", async () => {
  await withDirectory("state-result-barrier", async (directory) => {
    const first = makeService(directory, { permissionPolicy: "ask" });
    let taskId;
    const durable = first.stateStore?.appendDurable;
    try {
      await first.init();
      const opened = await openSession(first, "ask");
      const task = await first.call("task_prompt", { sessionId: opened.sessionId, prompt: "go" }, MAIN);
      taskId = task.taskId;
      for (let attempt = 0; attempt < 40 && first.requireSession(opened.sessionId).status !== "waiting_permission"; attempt += 1) {
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.equal(first.requireSession(opened.sessionId).status, "waiting_permission");
      const pending = (await first.call("inbox", { action: "list", status: "pending" }, MAIN)).items
        .find((item) => item.sessionId === opened.sessionId);
      assert.ok(pending);
      const original = first.stateStore.appendDurable.bind(first.stateStore);
      first.stateStore.appendDurable = (type, ...args) => {
        if (type === WAL_TYPES.TASK_RESULT_COMMITTED) throw new Error("injected result fsync failure");
        return original(type, ...args);
      };
      const resultWaiting = first.call("task_result", { taskId, waitMs: 30_000 }, MAIN);
      await first.call("permission", {
        sessionId: opened.sessionId,
        requestId: pending.requestId,
        optionId: "allow-once"
      }, MAIN);
      for (let attempt = 0; attempt < 80 && first.requireSession(opened.sessionId).status !== "idle"; attempt += 1) {
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.equal(first.requireSession(opened.sessionId).status, "idle");
      const result = await resultWaiting;
      assert.equal(result.ok, false);
      assert.equal(result.status, "failed");
      assert.match(result.error, /injected result fsync failure/);
      assert.equal((await first.call("task_get", { taskId }, MAIN)).status, "failed");
      first.stateStore.appendDurable = original;
      await first.flushPersist();
    } finally {
      if (first.stateStore && durable) first.stateStore.appendDurable = durable.bind(first.stateStore);
      await first.shutdown().catch(() => {});
    }

    const second = makeService(directory);
    try {
      await second.init();
      assert.equal((await second.call("task_get", { taskId }, MAIN)).status, "failed");
      assert.equal((await second.call("task_result", { taskId }, MAIN)).ok, false);
    } finally {
      await second.shutdown();
    }
  });
});

test("an in-flight task is failed on restart while its session comes back disconnected", async () => {
  await withDirectory("state-inflight", async (directory) => {
    const first = makeService(directory, { permissionPolicy: "ask" });
    let taskId = null;
    let sessionId = null;
    try {
      await first.init();
      const opened = await openSession(first, "ask");
      sessionId = opened.sessionId;
      // The default mock prompt blocks on a permission request: the turn is still
      // in flight, and there is a pending inbox row for it.
      const task = await first.call("task_prompt", { sessionId, prompt: "block" }, MAIN);
      taskId = task.taskId;
      for (let attempt = 0; attempt < 40 && first.requireSession(sessionId).status !== "waiting_permission"; attempt += 1) {
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.equal((await first.call("task_get", { taskId }, MAIN)).status, "input_required");
      assert.equal((await first.call("inbox", { action: "list", status: "pending" }, MAIN)).items.length, 1);
      await first.flushPersist();
    } finally {
      await first.shutdown();
    }

    const second = makeService(directory, { permissionPolicy: "ask" });
    try {
      await second.init();
      const got = await second.call("task_get", { taskId }, MAIN);
      assert.equal(got.status, "failed");
      assert.match(got.statusMessage, /Gateway restarted/);
      assert.equal((await second.call("task_result", { taskId }, MAIN)).ok, false);
      assert.equal((await second.call("session", { action: "list" }, MAIN)).sessions[0].status, "disconnected");
      const inbox = await second.call("inbox", { action: "list" }, MAIN);
      assert.equal(inbox.items[0].status, "interrupted");
      assert.deepEqual((await second.call("inbox", { action: "list", status: "pending" }, MAIN)).items, []);
    } finally {
      await second.shutdown();
    }
  });
});

test("an oversized result is spilled to an artifact the WAL references, and comes back byte-identical", async () => {
  await withDirectory("state-result-ref", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    const first = makeService(directory, { persistence: { walInlineResultBytes: 64 } });
    let taskId = null;
    let expected = null;
    try {
      await first.init();
      const { task } = await runTask(first, "large-result");
      taskId = task.taskId;
      expected = (await first.call("task_result", { taskId }, MAIN)).result.text;
      assert.ok(expected.length > 64);
      await first.flushPersist();

      const committed = (await readWal(paths)).find((record) => record.type === "task.result_committed");
      assert.equal(committed.payload.result, undefined, "an oversized result is not inlined in the log");
      assert.equal(typeof committed.payload.ref.path, "string");
      assert.equal(typeof committed.payload.ref.sha256, "string");
      assert.ok(committed.payload.preview.length > 0, "the preview is the last-resort fallback");
      const spilled = await readFile(committed.payload.ref.path, "utf8");
      assert.equal(createHash("sha256").update(spilled).digest("hex"), committed.payload.ref.sha256);
      // The reference must be durable before the record that names it.
      assert.ok((await stat(committed.payload.ref.path)).size > 0);
    } finally {
      await first.shutdown();
    }

    // Reload from the snapshot (which inlines the result), then again from a WAL
    // that only holds the reference.
    const second = makeService(directory, { persistence: { walInlineResultBytes: 64 } });
    try {
      await second.init();
      assert.equal((await second.call("task_result", { taskId }, MAIN)).result.text, expected);
    } finally {
      await second.shutdown();
    }
  });
});

test("replay resolves a result reference, and degrades to the preview when the file is gone", async () => {
  await withDirectory("state-ref-degrade", async (directory) => {
    const statePath = join(directory, "state.json");
    const paths = statePaths(statePath);
    const first = makeService(directory, { persistence: { walInlineResultBytes: 64 } });
    let taskId = null;
    try {
      await first.init();
      const { task } = await runTask(first, "large-result");
      taskId = task.taskId;
    } finally {
      await keepLogAcrossShutdown(first, paths);
    }
    // The reference in the log is now the only copy of the result.
    const wal = await readFile(paths.wal);
    const committed = (await readWal(paths)).find((record) => record.type === "task.result_committed");

    const withRef = makeService(directory, { persistence: { walInlineResultBytes: 64 } });
    try {
      await withRef.init();
      const result = await withRef.call("task_result", { taskId }, MAIN);
      assert.ok(result.result.text.length > 64, "the referenced file rehydrates the full result");
      assert.equal(result.resultDegraded, undefined);
    } finally {
      await withRef.shutdown();
    }

    await writeFreshBase(statePath, wal);
    await writeFile(paths.wal, wal, { mode: 0o600 });
    await rm(committed.payload.ref.path);
    const degraded = makeService(directory, { persistence: { walInlineResultBytes: 64 } });
    try {
      await degraded.init();
      const task = await degraded.call("task_get", { taskId }, MAIN);
      assert.equal(task.status, "completed", "a lost artifact must not lose the outcome");
      const result = await degraded.call("task_result", { taskId }, MAIN);
      assert.equal(result.resultDegraded, true);
    } finally {
      await degraded.shutdown();
    }
  });
});

// Astra I13: the artifact a large result was meant for failed, the log got its
// preview alone, and the commit of that preview cleared the artifact's failure:
// Main read the whole result beside healthy persistence, while a crash before
// the next snapshot would have brought back only the preview.
test("a result whose artifact failed says it is not durable, as health does, until the snapshot that holds it lands", async () => {
  await withDirectory("state-ref-failed", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    const options = { persistence: { walInlineResultBytes: 64 }, maxArtifactBytes: 100, maxArtifactTotalBytes: 100 };
    // The debounced writer stays quiet until the flush below.
    const service = makeService(directory, { ...options, snapshotIntervalMs: 60_000 });
    const notDurable = { persisted: false, errorCode: "PERSISTENCE_UNHEALTHY" };
    let taskId = null;
    let text = null;
    try {
      await service.init();
      const { task } = await runTask(service, "large-result");
      taskId = task.taskId;
      const committed = (await readWal(paths)).find((record) => record.type === "task.result_committed");
      assert.equal(committed.payload.ref, undefined, "the artifact was cut short at 100 bytes");
      assert.equal(committed.payload.result, undefined);
      assert.ok(committed.payload.preview.length > 0, "the log holds the preview alone");

      const persistence = (await service.call("setup", { mode: "summary" }, MAIN)).persistence;
      assert.equal(persistence.healthy, false);
      assert.match(persistence.error, /Task result artifact failed/);
      const result = await service.call("task_result", { taskId }, MAIN);
      assert.deepEqual(result.durability, notDurable);
      text = result.result.text;
      assert.equal(text, "가나다".repeat(32), "the whole result is what is delivered");
      assert.deepEqual((await service.call("run", { taskId }, MAIN)).durability, notDurable);

      // The next snapshot holds it whole: both go.
      await service.flushPersist();
      assert.equal((await service.call("setup", { mode: "summary" }, MAIN)).persistence.healthy, true);
      assert.equal(Object.hasOwn(await service.call("task_result", { taskId }, MAIN), "durability"), false);
    } finally {
      await service.shutdown();
    }
    const reloaded = makeService(directory, options);
    try {
      await reloaded.init();
      const result = await reloaded.call("task_result", { taskId }, MAIN);
      assert.equal(result.result.text, text);
      assert.equal(result.resultDegraded, undefined);
      assert.equal(Object.hasOwn(result, "durability"), false);
    } finally {
      await reloaded.shutdown();
    }
  });
});

// Review of the I13 fix: the commit of the preview kept the artifact's failure in
// persistence health, but the next durable append that held (another result,
// a prompt's dispatch stamp, a restore outcome) cleared it, so setup said
// healthy while the result still said it was not durable. Only the snapshot
// that holds the whole result clears it now.
test("persistence stays unhealthy while a preview-only result waits for its snapshot, whatever else the log takes", async () => {
  await withDirectory("state-ref-wait", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    const service = makeService(directory, {
      permissionPolicy: "ask",
      // The small result (about 270 bytes) is logged inline, the large one
      // (about 560) goes to an artifact, which fails at 100 bytes.
      persistence: { walInlineResultBytes: 400 },
      maxArtifactBytes: 100,
      maxArtifactTotalBytes: 100,
      // The debounced writer stays quiet until the flush below.
      snapshotIntervalMs: 60_000
    });
    const health = async () => (await service.call("setup", { mode: "summary" }, MAIN)).persistence;
    try {
      await service.init();
      // A task whose turn waits on Main, started while persistence is healthy,
      // on a provider of its own: the mock serves one session per process.
      const waiting = await service.call("session_open", { provider: "codex", cwd: process.cwd(), permissionPolicy: "ask" }, MAIN);
      const later = await service.call("task_prompt", { sessionId: waiting.sessionId, prompt: "go", ttl: 600_000 }, MAIN);
      for (let attempt = 0; attempt < 40 && service.requireSession(waiting.sessionId).status !== "waiting_permission"; attempt += 1) {
        await new Promise((done) => setTimeout(done, 25));
      }
      const pending = (await service.call("inbox", { action: "list", status: "pending" }, MAIN)).items
        .find((item) => item.sessionId === waiting.sessionId);
      assert.ok(pending);
      // Then a result whose artifact fails: the log holds its preview alone.
      const { task } = await runTask(service, "large-result");
      assert.equal((await health()).healthy, false);

      // The waiting task's result is committed, durably and whole: an append
      // that held, not the snapshot the other result waits for.
      await service.call("permission", { sessionId: waiting.sessionId, requestId: pending.requestId, optionId: "allow-once" }, MAIN);
      for (let attempt = 0; attempt < 80 && service.requireSession(waiting.sessionId).status !== "idle"; attempt += 1) {
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.equal((await service.call("task_get", { taskId: later.taskId }, MAIN)).status, "completed");
      const committed = new Map((await readWal(paths))
        .filter((record) => record.type === "task.result_committed")
        .map((record) => [record.key, record.payload]));
      assert.ok(committed.get(later.taskId).result, "the later result is in the log whole");
      assert.equal(committed.get(task.taskId).result, undefined, "the earlier one by its preview alone");
      const unhealthy = await health();
      assert.equal(unhealthy.healthy, false, "the append did not answer the result that waits");
      assert.match(unhealthy.error, /Task result artifact failed/);
      assert.deepEqual((await service.call("task_result", { taskId: task.taskId }, MAIN)).durability, {
        persisted: false, errorCode: "PERSISTENCE_UNHEALTHY"
      });

      // The snapshot that holds it whole answers both.
      await service.flushPersist();
      assert.equal((await health()).healthy, true);
      assert.equal(Object.hasOwn(await service.call("task_result", { taskId: task.taskId }, MAIN), "durability"), false);
    } finally {
      await service.shutdown();
    }
  });
});

// Astra I8 (f613b8e): the commit of a result by reference synced the artifact
// but not whether its directory synced too, so a directory sync that failed
// (EIO) still put a reference in the log, one a power loss could leave naming
// nothing, beside a result reported durable.
test("a result artifact whose directory did not sync is not durable either, until the snapshot that holds it", async () => {
  await withDirectory("state-ref-dirsync", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    const artifactRoot = join(directory, "artifacts");
    await mkdir(artifactRoot, { mode: 0o700 });
    const root = await stat(artifactRoot);
    // The artifact directory's fsync fails with code; every other one syncs.
    const failingRoot = (code) => (original) => function fsyncSync(fd, ...rest) {
      const info = fs.fstatSync(fd);
      if (info.isDirectory() && info.dev === root.dev && info.ino === root.ino) {
        throw Object.assign(new Error(`${code}: directory sync failed, fsync`), { code });
      }
      return original.call(this, fd, ...rest);
    };
    const notDurable = { persisted: false, errorCode: "PERSISTENCE_UNHEALTHY" };
    // The debounced writer stays quiet until the flush below.
    const service = makeService(directory, { persistence: { walInlineResultBytes: 64 }, artifactRoot, snapshotIntervalMs: 60_000 });
    try {
      await service.init();
      const { task } = await withFs({ fsyncSync: failingRoot("EIO") }, () => runTask(service, "large-result"));
      const committed = (await readWal(paths)).find((record) => record.type === "task.result_committed");
      assert.equal(committed.payload.ref, undefined, "no reference to a name that may not last");
      assert.ok(committed.payload.preview.length > 0, "the log holds the preview alone");
      const persistence = (await service.call("setup", { mode: "summary" }, MAIN)).persistence;
      assert.equal(persistence.healthy, false);
      assert.match(persistence.error, /Task result artifact failed: EIO/);
      const result = await service.call("task_result", { taskId: task.taskId }, MAIN);
      assert.deepEqual(result.durability, notDurable);
      assert.equal(result.result.text, "가나다".repeat(32), "the whole result is what is delivered");

      // The next snapshot holds it whole.
      await service.flushPersist();
      assert.equal((await service.call("setup", { mode: "summary" }, MAIN)).persistence.healthy, true);
      assert.equal(Object.hasOwn(await service.call("task_result", { taskId: task.taskId }, MAIN), "durability"), false);
    } finally {
      await service.shutdown();
    }

    // A file system that cannot sync a directory at all is no failure, as before.
    const store = new ArtifactStore({ root: artifactRoot });
    for (const code of ["EINVAL", "ENOTSUP"]) {
      assert.equal(await withFs({ fsyncSync: failingRoot(code) }, () => store.syncDirectory()), null, code);
    }
    assert.equal((await withFs({ fsyncSync: failingRoot("EIO") }, () => store.syncDirectory()))?.code, "EIO");
    assert.equal(store.syncDirectory(), null);
  });
});

test("rotation rolls the log, bumps the epoch, and the seq watermark filters a duplicate replay", async () => {
  await withDirectory("state-rotate", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    const service = makeService(directory, { persistence: { walRotateRecords: 4 } });
    let staged = null;
    try {
      await service.init();
      await runTask(service);
      await service.flushPersist();
      const rotated = await readSnapshot(paths);
      assert.ok(rotated.header.epoch >= 1, "the record trigger fired at least one rotation");
      assert.ok(rotated.header.walSeq > 0);
      const afterRotation = await readWal(paths);
      assert.equal(afterRotation[0].type, "wal.opened");
      assert.ok(afterRotation[0].seq > 1, "the log rolled instead of growing");
      staged = await readFile(paths.wal);
    } finally {
      await service.shutdown();
    }
    // Re-stage the rolled-aside segment: exactly the crash window between the
    // rename and the unlink that follows a landed snapshot.
    await writeFile(paths.rotating, staged, { mode: 0o600 });

    const reloaded = makeService(directory);
    try {
      await reloaded.init();
      const recovery = (await reloaded.call("setup", {}, MAIN)).persistence.lastRecovery;
      assert.ok(recovery.skipped > 0, "records the snapshot already covers are skipped, not replayed");
      assert.equal((await reloaded.call("task_list", {}, MAIN)).tasks.length, 1, "no duplicated handle");
    } finally {
      await reloaded.shutdown();
    }
  });
});

// Astra I2: the inode check refuses a hard link to the live log, but a rotation
// only unlinked the segment it retired, and the link went on holding its task
// results and inbox payloads on an inode nothing protected any more.
test("a hard link to the log holds nothing once a rotation retires its segment", async () => {
  await withDirectory("state-rotate-link", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    const service = makeService(directory);
    try {
      await service.init();
      const opened = await openSession(service);
      service.stateStore.barrier();
      // A Worker's name for the live log, outside the state directory.
      const held = join(directory, "held.ndjson");
      await link(paths.wal, held);
      assert.ok((await readFile(held, "utf8")).includes(opened.sessionId));
      service.stateStore.rotate();
      assert.equal(await readFile(held, "utf8"), "", "emptied, not only unlinked");
      await assert.rejects(stat(paths.rotating), /ENOENT/);

      // A segment an interrupted rotation left behind goes the same way.
      await writeFile(paths.rotating, `${encodeRecord({ v: 1, seq: 1, type: "wal.opened", key: "old", payload: {} })}`, { mode: 0o600 });
      const leftover = join(directory, "leftover.ndjson");
      await link(paths.rotating, leftover);
      service.stateStore.rotate();
      assert.equal(await readFile(leftover, "utf8"), "");
    } finally {
      await service.shutdown();
    }
  });
});

// Astra I5: the debounced snapshot replaced the synced one without a sync of
// its own, so once a rotation had retired the segments the synced one covered,
// power loss could leave a torn base and a log that only goes on from it.
test("every snapshot, the debounced one included, is synced before its rename, and the rename after", async () => {
  await withDirectory("state-snapshot-sync", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    const service = makeService(directory, { snapshotIntervalMs: 60_000 });
    try {
      await service.init();
      await openSession(service);
      service.stateStore.barrier();
      const opened = new Map();
      const calls = [];
      await withFs({
        openSync: (original) => function openSync(path, ...rest) {
          const fd = original.call(this, path, ...rest);
          opened.set(fd, String(path));
          return fd;
        },
        fsyncSync: (original) => function fsyncSync(fd) {
          calls.push(`fsync ${opened.get(fd)}`);
          return original.call(this, fd);
        },
        renameSync: (original) => function renameSync(from, to) {
          calls.push(`rename ${from} -> ${to}`);
          return original.call(this, from, to);
        }
      }, async () => {
        service.persistDirty = true;
        await service.flushPersist();
      });
      const temporary = `${paths.snapshot}.${process.pid}.tmp`;
      assert.deepEqual(calls, [
        `fsync ${temporary}`,
        `rename ${temporary} -> ${paths.snapshot}`,
        `fsync ${paths.directory}`
      ]);
    } finally {
      await service.shutdown();
    }
  });
});

// The store's directory sync swallowed every error, so a snapshot whose rename
// was not durable was reported written, and a rotation went on to retire the
// segment that snapshot was to cover.
test("a directory sync that fails fails the snapshot or rotation it belongs to, which stays owed until one syncs", async () => {
  await withDirectory("state-dirsync-fails", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    // The debounced writer stays quiet until the flushes below.
    const service = makeService(directory, { snapshotIntervalMs: 60_000 });
    let taskId = null;
    try {
      await service.init();
      taskId = (await runTask(service)).task.taskId;
      await service.flushPersist();
      const root = await stat(directory);
      // The state directory's sync fails with code; every other one syncs.
      const failing = (code) => ({
        fsyncSync: (original) => function fsyncSync(fd, ...rest) {
          const info = fs.fstatSync(fd);
          if (info.isDirectory() && info.dev === root.dev && info.ino === root.ino) {
            throw Object.assign(new Error(`${code}: directory sync failed, fsync`), { code });
          }
          return original.call(this, fd, ...rest);
        }
      });
      const health = async () => (await service.call("setup", { mode: "summary" }, MAIN)).persistence;

      // A file system that cannot sync a directory at all is no failure, as before.
      await withFs(failing("EINVAL"), async () => {
        service.persistDirty = true;
        await service.flushPersist();
      });
      assert.equal((await health()).healthy, true);

      // The snapshot is renamed into place but not reported written.
      await withFs(failing("EIO"), async () => {
        service.persistDirty = true;
        await assert.rejects(service.flushPersist(), /EIO/);
      });
      assert.equal((await health()).healthy, false);
      assert.match((await health()).error, /EIO/);
      assert.equal(service.persistDirty, true, "the snapshot is still owed");
      // A rotation stops before it retires the segment it rolled aside.
      await withFs(failing("EIO"), () => {
        assert.throws(() => service.stateStore.rotate(), /EIO/);
      });
      await stat(paths.rotating);

      // Once the directory syncs again the owed snapshot lands, and the next
      // rotation folds the segment in.
      await service.flushPersist();
      assert.equal((await health()).healthy, true);
      service.stateStore.rotate();
      await assert.rejects(stat(paths.rotating), /ENOENT/);
    } finally {
      await service.shutdown();
    }
    const restarted = makeService(directory);
    try {
      await restarted.init();
      assert.equal((await restarted.call("task_get", { taskId }, MAIN)).status, "completed");
    } finally {
      await restarted.shutdown();
    }
  });
});

test("a v4 state.json migrates into v5 on first start", async () => {
  await withDirectory("state-migrate", async (directory) => {
    const statePath = join(directory, "state.json");
    const paths = statePaths(statePath);
    const timestamp = new Date().toISOString();
    await writeFile(statePath, `${JSON.stringify({
      version: 4,
      sessions: [{
        id: "acp-migrated", provider: "claude", acpSessionId: "acp-1", cwd: "/", title: null,
        permissionPolicy: "ask", model: null, ownerRootId: "main-a", mcpServers: [],
        additionalDirectories: [], pinned: false, status: "idle", createdAt: timestamp,
        updatedAt: timestamp, completedAt: null, orphanedAt: null, lastOwnerActivityAt: timestamp,
        transientClearedAt: null, eventSequence: 3, turnId: null, stopReason: null
      }],
      tasks: [{
        taskId: "task-migrated", sessionId: "acp-migrated", ownerRootId: "main-a", turnId: null,
        status: "completed", ttl: 600_000, pollInterval: 1_000, createdAt: timestamp,
        lastUpdatedAt: timestamp, statusMessage: "end_turn", result: { ok: true }
      }],
      inbox: []
    })}\n`, { mode: 0o600 });

    const service = makeService(directory);
    try {
      await service.init();
      const status = (await service.call("setup", {}, MAIN)).persistence;
      assert.equal(status.lastRecovery.source, "migrated-v4");
      assert.equal((await service.call("task_get", { taskId: "task-migrated" }, MAIN)).status, "completed");
      assert.equal((await service.call("session", { action: "list" }, MAIN)).sessions[0].sessionId, "acp-migrated");
      // init rotates, so the migrated state is already in a v5 snapshot.
      assert.equal((await readSnapshot(paths)).body.tasks.length, 1);
      // That synced snapshot is what makes the v4 file redundant, so it is gone:
      // left behind, it would keep its sessions and inbox payloads forever.
      await assert.rejects(stat(statePath), /ENOENT/, "the migrated v4 file is deleted once v5 is durable");
    } finally {
      await service.shutdown();
    }
  });
});

test("an unmarked state.json newer than the snapshot re-migrates and raises DOWNGRADE_DETECTED", async () => {
  await withDirectory("state-downgrade", async (directory) => {
    const statePath = join(directory, "state.json");
    const paths = statePaths(statePath);
    const first = makeService(directory);
    try {
      await first.init();
      await openSession(first);
      await first.flushPersist();
    } finally {
      await first.shutdown();
    }
    // Since 1.8.0 a v5 run writes no state.json at all, so any that appears was
    // written by someone else; the session shape is taken from our snapshot.
    await assert.rejects(stat(statePath), /ENOENT/, "a v5 run leaves no state.json");
    const before = (await readSnapshot(paths)).body;

    // What a rolled-back 1.3.2 daemon leaves behind: the same file shape with no
    // marker (its persist() writes fixed literals), newer than our snapshot.
    const rolledBack = {
      version: 4,
      sessions: [{ ...before.sessions[0], id: "acp-from-v4", title: "written by v4" }],
      tasks: [],
      inbox: []
    };
    await writeFile(statePath, `${JSON.stringify(rolledBack)}\n`, { mode: 0o600 });
    const snapshotTime = (await stat(paths.snapshot)).mtime;
    const newer = new Date(snapshotTime.getTime() + 5_000);
    await utimes(statePath, newer, newer);

    const second = makeService(directory);
    try {
      await second.init();
      const setup = await second.call("setup", {}, MAIN);
      assert.equal(setup.persistence.lastRecovery.source, "downgrade-remigrated");
      assert.ok(setup.alerts.some((alert) => alert.code === "DOWNGRADE_DETECTED"));
      const sessions = (await second.call("session", { action: "list" }, MAIN)).sessions;
      assert.deepEqual(sessions.map((session) => session.sessionId), ["acp-from-v4"]);
    } finally {
      await second.shutdown();
    }
  });
});

test("an unmarked state.json with the same mtime as the snapshot is treated as a downgrade", async () => {
  await withDirectory("state-downgrade-equal", async (directory) => {
    const statePath = join(directory, "state.json");
    const paths = statePaths(statePath);
    const first = makeService(directory);
    try {
      await first.init();
      await openSession(first);
      await first.flushPersist();
    } finally {
      await first.shutdown();
    }
    const before = (await readSnapshot(paths)).body;
    await writeFile(statePath, `${JSON.stringify({
      version: 4,
      sessions: [{ ...before.sessions[0], id: "acp-equal-mtime", title: "written by v4" }],
      tasks: [],
      inbox: []
    })}\n`, { mode: 0o600 });
    const same = new Date(1_900_000_000_000);
    await utimes(paths.snapshot, same, same);
    await utimes(statePath, same, same);

    const second = makeService(directory);
    try {
      await second.init();
      const setup = await second.call("setup", {}, MAIN);
      assert.equal(setup.persistence.lastRecovery.source, "downgrade-remigrated");
      assert.ok(setup.alerts.some((alert) => alert.code === "DOWNGRADE_DETECTED"));
      assert.deepEqual(
        (await second.call("session", { action: "list" }, MAIN)).sessions.map((session) => session.sessionId),
        ["acp-equal-mtime"]
      );
    } finally {
      await second.shutdown();
    }
  });
});

test("a torn WAL tail starts silently; damage inside the log halts with a quarantine copy", async () => {
  await withDirectory("state-tail", async (directory) => {
    const statePath = join(directory, "state.json");
    const paths = statePaths(statePath);
    const service = makeService(directory);
    try {
      await service.init();
      await runTask(service);
    } finally {
      await keepLogAcrossShutdown(service, paths);
    }
    const intact = await readFile(paths.wal, "utf8");

    // kill -9 in the middle of a write: the last line has no newline.
    await writeFile(paths.wal, `${intact}{"v":1,"seq":999,"at":"2026-01-01T00`, { mode: 0o600 });
    const tolerant = makeService(directory);
    try {
      await tolerant.init();
      const recovery = (await tolerant.call("setup", {}, MAIN)).persistence.lastRecovery;
      assert.equal(recovery.droppedTail, 1, "an un-fsynced tail is discarded and counted");
      assert.ok(recovery.replayed > 0);
      assert.equal((await tolerant.call("task_list", {}, MAIN)).tasks.length, 1);
      // The repair is on disk: appending after it must not leave a spliced record.
      const repaired = await readFile(paths.wal, "utf8");
      assert.ok(repaired.endsWith("\n"));
    } finally {
      await tolerant.shutdown();
    }

    // Damage in the middle is a different fact: it can manufacture a half state.
    const lines = intact.split("\n").filter(Boolean);
    lines[1] = lines[1].replace(/"type":"[a-z.]+"/, '"type":"task.created"');
    await writeFile(paths.wal, `${lines.join("\n")}\n`);
    await writeFreshBase(statePath, intact);
    const halting = makeService(directory);
    await assert.rejects(halting.init(), (error) => {
      assert.equal(error.code, "STATE_WAL_CORRUPT");
      assert.match(error.message, /ACP_GATEWAY_STATE_RECOVERY=truncate/);
      assert.match(error.message, /byte \d+/);
      return true;
    });
    const quarantined = await readFile(`${paths.wal}.corrupt-${(await readdirCorrupt(directory, "wal"))}`, "utf8")
      .catch(() => null);
    assert.ok(quarantined == null || quarantined.length > 0);

    // The opt-in replays up to the last intact record and keeps going.
    const truncating = makeService(directory, { persistence: { stateRecovery: "truncate" } });
    try {
      await truncating.init();
      const setup = await truncating.call("setup", {}, MAIN);
      assert.ok(setup.alerts.some((alert) => alert.code === "STATE_WAL_TRUNCATED"));
    } finally {
      await truncating.shutdown();
    }
  });
});

test("a newline-terminated bad CRC and a sequence gap both halt WAL replay", async () => {
  for (const fault of ["bad-crc", "sequence-gap"]) {
    await withDirectory(`state-${fault}`, async (directory) => {
      const statePath = join(directory, "state.json");
      const paths = statePaths(statePath);
      const service = makeService(directory);
      try {
        await service.init();
        await runTask(service);
      } finally {
        await keepLogAcrossShutdown(service, paths);
      }
      const intact = await readFile(paths.wal, "utf8");
      const records = await readWal(paths);
      const lastSeq = records.at(-1).seq;
      const appended = fault === "bad-crc"
        ? `${JSON.stringify({ v: 1, seq: lastSeq + 1, type: "wal.opened", key: "bad", payload: {}, crc32: "00000000" })}\n`
        : encodeRecord({ v: 1, seq: lastSeq + 2, type: "wal.opened", key: "gap", payload: {} });
      await writeFile(paths.wal, `${intact}${appended}`, { mode: 0o600 });
      const halting = makeService(directory);
      await assert.rejects(halting.init(), (error) => {
        assert.equal(error.code, "STATE_WAL_CORRUPT");
        assert.match(error.message, fault === "bad-crc" ? /damaged/ : /sequence gap/);
        return true;
      });
    });
  }
});

// Astra I3: a write that failed partway left half a record in the log and used
// up its seq. The next append landed right behind those bytes and could sync
// and clear health, and a restart then met a damaged record mid-log, or a seq
// gap, and refused to start (STATE_WAL_CORRUPT).
// A task on the session, run to its end: its records are the ones a restart
// must find after a failed append.
async function runTaskOn(service, sessionId) {
  const task = await service.call("task_prompt", { sessionId, prompt: "narrated-result", ttl: 600_000 }, MAIN);
  await waitForIdle(service, sessionId);
  service.stateStore.barrier();
  return task;
}

test("an append that fails partway takes nothing: later records land whole, and a crash replays them", async () => {
  await withDirectory("state-append-failure", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    const service = makeService(directory);
    let opened = null;
    let task = null;
    try {
      await service.init();
      opened = await openSession(service);
      service.stateStore.barrier();
      const seq = service.stateStore.walSeq;
      const bytes = (await stat(paths.wal)).size;
      await withFs({ writeSync: halfThenNoSpace("task-ghost") }, () => {
        assert.equal(service.stateStore.append(WAL_TYPES.TASK_SEEN, "task-ghost", { seenAt: new Date().toISOString() }), false);
      });
      assert.match(service.persistError, /ENOSPC/);
      assert.equal(service.stateStore.walSeq, seq, "the failed record took no seq");
      assert.equal((await stat(paths.wal)).size, bytes, "nor left any of its bytes");
      // A write that lands answers the failure, and the task's records follow.
      await service.flushPersist();
      task = await runTaskOn(service, opened.sessionId);
      const records = await assertWholeLog(paths);
      assert.equal(records.some((record) => record.key === "task-ghost"), false);
    } finally {
      await keepLogAcrossShutdown(service, paths);
    }
    // From the log alone, as a crash leaves it.
    const restarted = makeService(directory);
    try {
      await restarted.init();
      assert.equal((await restarted.call("task_get", { taskId: task.taskId }, MAIN)).status, "completed");
      assert.equal((await restarted.call("setup", {}, MAIN)).persistence.lastRecovery.droppedTail, 0);
    } finally {
      await restarted.shutdown();
    }
  });
});

test("a log that cannot be cut back takes no record until a rotation behind a synced snapshot replaces it", async () => {
  await withDirectory("state-append-torn", async (directory) => {
    const statePath = join(directory, "state.json");
    const paths = statePaths(statePath);
    // The debounced writer stays quiet: the rotation below is the flush's.
    const service = makeService(directory, { snapshotIntervalMs: 60_000 });
    let first = null;
    let task = null;
    let torn = null;
    try {
      await service.init();
      first = await openSession(service);
      service.stateStore.barrier();
      const noTruncate = () => function ftruncateSync() {
        throw Object.assign(new Error("EIO: i/o error, ftruncate"), { code: "EIO" });
      };
      await withFs({ writeSync: halfThenNoSpace("task-ghost"), ftruncateSync: noTruncate }, async () => {
        const seen = { seenAt: new Date().toISOString() };
        assert.equal(service.stateStore.append(WAL_TYPES.TASK_SEEN, "task-ghost", seen), false);
        // Nothing may land behind the half record the log could not shed.
        assert.equal(service.stateStore.append(WAL_TYPES.TASK_SEEN, "task-later", seen), false);
        assert.match(service.persistError, /could not be cut back/);
        await assert.rejects(
          service.call("task_prompt", { sessionId: first.sessionId, prompt: "narrated-result" }, MAIN),
          { code: "PERSISTENCE_UNHEALTHY" }
        );
        // What a crash right now leaves: the snapshot from the start, and a log
        // that ends in the torn bytes.
        torn = { snapshot: await readFile(paths.snapshot), wal: await readFile(paths.wal) };
        // Due at once: a synced snapshot, then a new log, while the old one still
        // cannot be cut.
        service.persistDirty = true;
        await service.flushPersist();
      });
      assert.equal(service.persistError, null);
      const restarted = await readWal(paths);
      assert.equal(restarted[0].type, "wal.opened", "a new log");
      assert.equal(restarted[0].seq, (await readSnapshot(paths)).header.walSeq + 1);
      task = await runTaskOn(service, first.sessionId);
      await assertWholeLog(paths);
    } finally {
      await keepLogAcrossShutdown(service, paths, { rewind: false });
    }
    const afterRepair = makeService(directory);
    try {
      await afterRepair.init();
      const listed = (await afterRepair.call("session", { action: "list" }, MAIN)).sessions.map((session) => session.sessionId);
      assert.deepEqual(listed, [first.sessionId]);
      assert.equal((await afterRepair.call("task_get", { taskId: task.taskId }, MAIN)).status, "completed");
    } finally {
      await afterRepair.shutdown();
    }
    // The crash before the rotation: the torn bytes are the end of the live
    // log, the one place replay drops a damaged record.
    await writeFile(paths.snapshot, torn.snapshot, { mode: 0o600 });
    await writeFile(paths.wal, torn.wal, { mode: 0o600 });
    const beforeRepair = makeService(directory);
    try {
      await beforeRepair.init();
      assert.equal((await beforeRepair.call("setup", {}, MAIN)).persistence.lastRecovery.droppedTail, 1);
      const listed = (await beforeRepair.call("session", { action: "list" }, MAIN)).sessions.map((session) => session.sessionId);
      assert.deepEqual(listed, [first.sessionId]);
      assert.deepEqual((await beforeRepair.call("task_list", {}, MAIN)).tasks, []);
    } finally {
      await beforeRepair.shutdown();
    }
  });
});

test("a corrupt snapshot halts instead of starting empty; snapshot-drop starts from the log and a leftover v4 file", async () => {
  await withDirectory("state-snapshot-corrupt", async (directory) => {
    const statePath = join(directory, "state.json");
    const paths = statePaths(statePath);
    const service = makeService(directory);
    let sessionId = null;
    try {
      await service.init();
      sessionId = (await openSession(service)).sessionId;
    } finally {
      // The log as a killed daemon leaves it, next to the snapshot damaged below.
      await keepLogAcrossShutdown(service, paths, { rewind: false });
    }

    const corrupt = async () => {
      const raw = await readFile(paths.snapshot, "utf8");
      const split = raw.indexOf("\n");
      // One flipped byte in the body: the header's length still matches.
      const body = raw.slice(split + 1).replace(/"provider":"claude"/, '"provider":"clauda"');
      await writeFile(paths.snapshot, `${raw.slice(0, split)}\n${body}`);
    };
    await corrupt();

    const halting = makeService(directory);
    await assert.rejects(halting.init(), (error) => {
      assert.equal(error.code, "STATE_SNAPSHOT_CORRUPT");
      assert.match(error.message, /checksum mismatch/);
      assert.match(error.message, /snapshot-drop/);
      return true;
    });

    // No v4 dual-write since 1.8.0: the log alone is the fallback, and the
    // session registered in it comes back.
    const dropping = makeService(directory, { persistence: { stateRecovery: "snapshot-drop" } });
    try {
      await dropping.init();
      const setup = await dropping.call("setup", {}, MAIN);
      assert.ok(setup.alerts.some((alert) => alert.code === "STATE_SNAPSHOT_DROPPED"));
      assert.deepEqual((await dropping.call("session", { action: "list" }, MAIN)).sessions.map((item) => item.sessionId), [sessionId]);
    } finally {
      await dropping.shutdown();
    }

    // A v4 file an older Gateway left behind is still read when the snapshot is
    // dropped, and retired once the state it fed is durable.
    const [record] = (await readSnapshot(paths)).body.sessions;
    await corrupt();
    await writeFile(statePath, `${JSON.stringify({
      version: 4, writerVersion: "1.7.2", sessions: [{ ...record, id: "acp-from-v4" }], tasks: [], inbox: []
    })}\n`, { mode: 0o600 });
    const fallback = makeService(directory, { persistence: { stateRecovery: "snapshot-drop" } });
    try {
      await fallback.init();
      assert.deepEqual(
        (await fallback.call("session", { action: "list" }, MAIN)).sessions.map((item) => item.sessionId),
        ["acp-from-v4"]
      );
      await assert.rejects(stat(statePath), /ENOENT/);
    } finally {
      await fallback.shutdown();
    }
  });
});

// A state directory as a crash leaves it: a snapshot that holds task-snapshot,
// rotated into before task-log and task-log-2 were logged, the log that went on
// from it, and a v4 state.json a 1.7 Gateway left beside them. store() opens
// it with the given persistence config, on the given clock if one is given.
async function seedState(directory) {
  const statePath = join(directory, "state.json");
  const paths = statePaths(statePath);
  const task = (taskId, day) => ({ taskId, sessionId: "s", status: "working", createdAt: `2026-01-0${day}T00:00:00.000Z` });
  let body = { sessions: [], tasks: [], inbox: [] };
  const store = (config = {}, { now } = {}) => new StateStore({
    statePath, ...(now ? { now } : {}), config: { fsync: "off", ...config }, snapshotProvider: () => body
  });
  const first = store();
  first.open();
  first.appendDurable(WAL_TYPES.TASK_CREATED, "task-snapshot", task("task-snapshot", 1));
  // The rotation folds task-snapshot into the snapshot and retires the segment
  // that held it.
  body = { sessions: [], tasks: [task("task-snapshot", 1)], inbox: [] };
  first.rotate();
  first.appendDurable(WAL_TYPES.TASK_CREATED, "task-log", task("task-log", 2));
  first.appendDurable(WAL_TYPES.TASK_CREATED, "task-log-2", task("task-log-2", 3));
  const files = { snapshot: await readFile(paths.snapshot), wal: await readFile(paths.wal) };
  first.close();
  body = { sessions: [], tasks: [], inbox: [] };
  await writeFile(paths.snapshot, files.snapshot, { mode: 0o600 });
  await writeFile(paths.wal, files.wal, { mode: 0o600 });
  files.state = Buffer.from(`${JSON.stringify({
    version: 4, writerVersion: "1.7.2", sessions: [{ id: "session-v4" }], tasks: [], inbox: []
  })}\n`, "utf8");
  await writeFile(statePath, files.state, { mode: 0o600 });
  return { statePath, paths, store, files };
}

// Astra I3 (f613b8e): rotation retires the log segments a snapshot covers, and
// since 1.8.0 no state.json covers for that snapshot. With it gone, the log
// that went on from it came back as the whole state: the task only the
// snapshot held was gone, recovery said "empty", and nothing said so.
test("a log whose snapshot is missing halts, and snapshot-drop takes the log alone and says what it lost", async () => {
  await withDirectory("state-base-missing", async (directory) => {
    const { statePath, paths, store, files } = await seedState(directory);
    await rm(statePath);
    await rm(paths.snapshot);
    const firstSeq = decodeRecord(files.wal.subarray(0, files.wal.indexOf(0x0a))).seq;
    assert.ok(firstSeq > 2, "the log starts where the rotation started it");

    assert.throws(() => store().open(), (error) => {
      assert.equal(error.code, "STATE_SNAPSHOT_CORRUPT");
      assert.match(error.message, /state\.snapshot\.json is missing/);
      assert.match(error.message, new RegExp(`goes on from it at seq ${firstSeq}\\b`));
      assert.match(error.message, new RegExp(`seq 1 to ${firstSeq - 1}\\b`));
      assert.match(error.message, /ACP_GATEWAY_STATE_RECOVERY=snapshot-drop/);
      assert.match(error.message, /=cold/);
      return true;
    });
    assert.deepEqual(await readFile(paths.wal), files.wal, "the halt changes nothing");

    const dropping = store({ stateRecovery: "snapshot-drop" });
    try {
      const loaded = dropping.open();
      assert.deepEqual(loaded.tasks.map((task) => task.taskId), ["task-log", "task-log-2"]);
      assert.deepEqual(loaded.recovery.alerts.map((alert) => alert.code), ["STATE_WAL_TAIL_REPLAYED"]);
      assert.match(loaded.recovery.alerts[0].message, new RegExp(`seq 1 to ${firstSeq - 1}\\)`));
    } finally {
      dropping.close();
    }
  });
});

test("the log alone is the whole state only from seq 1, or on a v4 file", async () => {
  await withDirectory("state-base-other", async (directory) => {
    const { paths, store } = await seedState(directory);
    // A v4 file says no seq: a 1.7 Gateway wrote it beside the log, so the log
    // goes on from it at whatever seq, as it did then.
    await rm(paths.snapshot);
    const legacy = store();
    try {
      const loaded = legacy.open();
      assert.deepEqual(loaded.sessions.map((session) => session.id), ["session-v4"]);
      assert.deepEqual(loaded.tasks.map((task) => task.taskId), ["task-log", "task-log-2"]);
      assert.deepEqual(loaded.recovery.alerts, []);
    } finally {
      legacy.close();
    }
    // A log from seq 1 holds everything: a crash before the first snapshot.
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory);
    const fresh = store();
    fresh.open();
    fresh.appendDurable(WAL_TYPES.TASK_CREATED, "task-first", { taskId: "task-first", status: "working", createdAt: "2026-01-04" });
    const wal = await readFile(paths.wal);
    fresh.close();
    await writeFile(paths.wal, wal, { mode: 0o600 });
    await rm(paths.snapshot);
    assert.equal(decodeRecord(wal.subarray(0, wal.indexOf(0x0a))).seq, 1);
    const restarted = store();
    try {
      const loaded = restarted.open();
      assert.deepEqual(loaded.tasks.map((task) => task.taskId), ["task-first"]);
      assert.equal(loaded.recovery.source, "empty");
      assert.deepEqual(loaded.recovery.alerts, []);
    } finally {
      restarted.close();
    }
  });
});

// Astra I6 (f613b8e): cold said it started from an empty state, then read the
// leftover v4 file and replayed the log onto it anyway; and a damaged log still
// halted it.
test("cold sets every state file aside and replays none of them, whichever one stopped the recovery", async () => {
  for (const fault of ["snapshot", "log"]) {
    await withDirectory(`state-cold-${fault}`, async (directory) => {
      const { statePath, paths, store } = await seedState(directory);
      if (fault === "snapshot") {
        const raw = await readFile(paths.snapshot, "utf8");
        await writeFile(paths.snapshot, raw.replace("task-snapshot", "task-snapshoT"), { mode: 0o600 });
      } else {
        // The middle record, so it is damage and not a torn last write.
        const lines = (await readFile(paths.wal, "utf8")).split("\n");
        lines[1] = lines[1].replace("task-log", "task-loG");
        await writeFile(paths.wal, lines.join("\n"), { mode: 0o600 });
      }
      const before = new Map(await Promise.all([paths.snapshot, paths.wal, statePath]
        .map(async (path) => [path, await readFile(path)])));
      const cold = store({ stateRecovery: "cold" });
      try {
        const loaded = cold.open();
        assert.deepEqual([loaded.sessions, loaded.tasks, loaded.inbox], [[], [], []]);
        assert.equal(loaded.recovery.source, "cold");
        assert.equal(loaded.recovery.replayed, 0);
        assert.deepEqual(loaded.recovery.alerts.map((alert) => alert.code), ["STATE_COLD_STARTED"]);
        const { message } = loaded.recovery.alerts[0];
        assert.match(message, fault === "snapshot" ? /^Gateway state snapshot is unusable \(body checksum mismatch\); started from an empty state/
          : /^Gateway write-ahead log .* is damaged at byte \d+ \(last good seq \d+\); started from an empty state/);
        // Each file is set aside whole, under the quarantine copies' name, and
        // gone from where recovery reads it: the log is a new one.
        const names = await readdir(directory);
        for (const [path, bytes] of before) {
          const prefix = `${path.slice(directory.length + 1)}.cold-`;
          const copies = names.filter((name) => name.startsWith(prefix));
          assert.equal(copies.length, 1, prefix);
          assert.deepEqual(await readFile(join(directory, copies[0])), bytes, prefix);
          assert.ok(message.includes(join(directory, copies[0])), prefix);
        }
        await assert.rejects(stat(statePath), /ENOENT/);
        await assert.rejects(stat(paths.snapshot), /ENOENT/);
        assert.deepEqual((await readWal(paths)).map((record) => [record.seq, record.type]), [[1, "wal.opened"]]);
      } finally {
        cold.close();
      }
      // The next start reads the cold start's own state.
      const again = store();
      try {
        const loaded = again.open();
        assert.deepEqual([loaded.sessions, loaded.tasks], [[], []]);
        assert.equal(loaded.recovery.source, "snapshot");
      } finally {
        again.close();
      }
    });
  }
});

// seedState as a crash in the middle of a rotation leaves it, with a damaged
// snapshot: the log renamed aside as the retired segment, and the new log,
// which holds nothing yet but its opening record. All four state files are
// there for cold to set aside. originals lists them in the order cold removes
// them; files holds the bytes of each.
async function seedColdRotation(directory) {
  const seeded = await seedState(directory);
  const { statePath, paths, files } = seeded;
  const records = files.wal.toString("utf8").split("\n").filter(Boolean).map((line) => decodeRecord(Buffer.from(line, "utf8")));
  await writeFile(paths.rotating, files.wal, { mode: 0o600 });
  files.rotating = files.wal;
  files.wal = Buffer.from(encodeRecord({
    v: 1, seq: records.at(-1).seq + 1, at: new Date().toISOString(), type: "wal.opened", key: "4242", payload: { pid: 4242, epoch: 2 }
  }), "utf8");
  await writeFile(paths.wal, files.wal, { mode: 0o600 });
  const raw = await readFile(paths.snapshot, "utf8");
  files.snapshot = Buffer.from(raw.replace("task-snapshot", "task-snapshoT"), "utf8");
  await writeFile(paths.snapshot, files.snapshot, { mode: 0o600 });
  const originals = [statePath, paths.snapshot, paths.rotating, paths.wal];
  const bytes = new Map([[statePath, files.state], [paths.snapshot, files.snapshot], [paths.rotating, files.rotating], [paths.wal, files.wal]]);
  return { ...seeded, originals, bytes };
}

// What a cold start that went all the way leaves: nothing of the old state.
function assertColdStarted(loaded) {
  assert.deepEqual([loaded.sessions, loaded.tasks, loaded.inbox], [[], [], []]);
  assert.equal(loaded.recovery.source, "cold");
  assert.deepEqual(loaded.recovery.alerts.map((alert) => alert.code), ["STATE_COLD_STARTED"]);
}

// Review of the I6 fix: cold copied each file aside and removed it before it
// copied the next, and synced none of it. A copy that failed later (a large log
// on a full disk), a crash or a power loss could take the snapshot and leave
// the v4 file with the log: a pair the next start read as a whole state, with
// cold too, so the empty start never came and the snapshot was never read.
test("cold removes no state file until each one is set aside, and a copy that fails halts with all of them in place", async () => {
  await withDirectory("state-cold-copy-fails", async (directory) => {
    const { paths, store, originals, bytes } = await seedColdRotation(directory);
    let clock = Date.now();
    const now = () => clock;
    // The second copy cold makes fails for want of space, whichever way it copies.
    let copies = 0;
    const full = (target) => {
      if (String(target).includes(".cold-") && ++copies === 2) {
        throw Object.assign(new Error(`ENOSPC: no space left on device, open '${target}'`), { code: "ENOSPC" });
      }
    };
    await withFs({
      openSync: (original) => function openSync(path, ...rest) {
        full(path);
        return original.call(this, path, ...rest);
      },
      copyFileSync: (original) => function copyFileSync(source, target, ...rest) {
        full(target);
        return original.call(this, source, target, ...rest);
      }
    }, () => {
      assert.throws(() => store({ stateRecovery: "cold" }, { now }).open(), (error) => {
        assert.equal(error.code, "STATE_SNAPSHOT_CORRUPT");
        assert.match(error.message, /^Gateway state snapshot is unusable \(body checksum mismatch\)\. ACP_GATEWAY_STATE_RECOVERY=cold could not set .*state\.snapshot\.json aside \(ENOSPC/);
        assert.match(error.message, /so it removed none of the state files/);
        return true;
      });
    });
    for (const path of originals) assert.deepEqual(await readFile(path), bytes.get(path), path);
    assert.deepEqual((await readdir(directory)).filter((name) => name.includes(".cold-")), [], "nor are its copies left");

    // Once there is room, the same start goes through.
    clock += 1_000;
    const cold = store({ stateRecovery: "cold" }, { now });
    try {
      assertColdStarted(cold.open());
      for (const path of originals.slice(0, -1)) await assert.rejects(stat(path), /ENOENT/, path);
      assert.deepEqual((await readWal(paths)).map((record) => [record.seq, record.type]), [[1, "wal.opened"]]);
    } finally {
      cold.close();
    }
  });
});

test("cold removes the state files in an order a stop at any point cannot leave read back as something else", async () => {
  // The order, and each removal synced before the next: copies first, each one
  // synced, then the directory; then the v4 file, the snapshot, the retired
  // segment and the log, the directory synced after each.
  await withDirectory("state-cold-order", async (directory) => {
    const { store, originals } = await seedColdRotation(directory);
    const events = [];
    const cold = store({ stateRecovery: "cold", fsync: "normal" });
    try {
      await withFs({
        unlinkSync: (original) => function unlinkSync(path, ...rest) {
          if (originals.includes(String(path))) events.push(`remove ${String(path).slice(directory.length + 1)}`);
          return original.call(this, path, ...rest);
        },
        fsyncSync: (original) => function fsyncSync(fd, ...rest) {
          events.push(fs.fstatSync(fd).isDirectory() ? "sync directory" : "sync file");
          return original.call(this, fd, ...rest);
        }
      }, () => assertColdStarted(cold.open()));
    } finally {
      cold.close();
    }
    const start = events.indexOf("sync file");
    assert.deepEqual(events.slice(start, start + 13), [
      "sync file", "sync file", "sync file", "sync file", "sync directory",
      "remove state.json", "sync directory",
      "remove state.snapshot.json", "sync directory",
      "remove state.wal.ndjson.rot", "sync directory",
      "remove state.wal.ndjson", "sync directory"
    ]);
  });

  // A stop after each removal (a crash, a power loss, a removal that fails):
  // the next start refuses what is left rather than read it as a state, and
  // cold, started again, finishes the empty start.
  for (const removed of [1, 2, 3]) {
    await withDirectory(`state-cold-stop-${removed}`, async (directory) => {
      const { store, originals, bytes } = await seedColdRotation(directory);
      let clock = Date.now();
      const now = () => clock;
      let removals = 0;
      await withFs({
        unlinkSync: (original) => function unlinkSync(path, ...rest) {
          if (originals.includes(String(path)) && ++removals > removed) {
            throw Object.assign(new Error(`EIO: i/o error, unlink '${path}'`), { code: "EIO" });
          }
          return original.call(this, path, ...rest);
        }
      }, () => {
        assert.throws(() => store({ stateRecovery: "cold" }, { now }).open(), (error) => {
          assert.equal(error.code, "STATE_SNAPSHOT_CORRUPT");
          assert.match(error.message, /set the state files aside as .*, but could not remove .* \(EIO.*\)\. Start again with =cold to finish\.$/);
          return true;
        });
      });
      // The first ones in the order are gone, the rest are as they were.
      for (const [index, path] of originals.entries()) {
        if (index < removed) await assert.rejects(stat(path), /ENOENT/, path);
        else assert.deepEqual(await readFile(path), bytes.get(path), path);
      }
      // Without cold, what is left halts the start: the damaged snapshot, or
      // a log with no snapshot under it.
      clock += 1_000;
      assert.throws(() => store({}, { now }).open(), (error) => {
        assert.equal(error.code, "STATE_SNAPSHOT_CORRUPT");
        assert.match(error.message, removed === 1 ? /snapshot is unusable/ : /state\.snapshot\.json is missing/);
        return true;
      });
      clock += 1_000;
      const cold = store({ stateRecovery: "cold" }, { now });
      try {
        assertColdStarted(cold.open());
        for (const path of originals.slice(0, -1)) await assert.rejects(stat(path), /ENOENT/, path);
      } finally {
        cold.close();
      }
    });
  }
});

// Review of the fix above: the store's directory sync swallowed every error,
// EIO included, so cold went on to the next removal after a sync that failed,
// and a power loss could then keep the snapshot's unlink but not state.json's.
test("cold halts on a directory sync that fails: before any removal after the copies, before the next one after a removal", async () => {
  // The nth directory sync fails: the first follows the copies, each later one a removal.
  for (const [failing, removed] of [[1, 0], [3, 2]]) {
    await withDirectory(`state-cold-sync-${failing}`, async (directory) => {
      const { store, originals, bytes } = await seedColdRotation(directory);
      let clock = Date.now();
      const now = () => clock;
      let syncs = 0;
      await withFs({
        fsyncSync: (original) => function fsyncSync(fd, ...rest) {
          if (fs.fstatSync(fd).isDirectory() && ++syncs === failing) {
            throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
          }
          return original.call(this, fd, ...rest);
        }
      }, () => {
        assert.throws(() => store({ stateRecovery: "cold", fsync: "normal" }, { now }).open(), (error) => {
          assert.equal(error.code, "STATE_SNAPSHOT_CORRUPT");
          assert.match(error.message, removed === 0
            ? /could not sync the state directory after copying the state files aside \(EIO.*\), so it removed none of the state files/
            : /set the state files aside as .*, but could not sync the state directory once it removed .*state\.snapshot\.json \(EIO.*\)\. Start again with =cold to finish\.$/);
          return true;
        });
      });
      for (const [index, path] of originals.entries()) {
        if (index < removed) await assert.rejects(stat(path), /ENOENT/, path);
        else assert.deepEqual(await readFile(path), bytes.get(path), path);
      }
      const cold = (await readdir(directory)).filter((name) => name.includes(".cold-"));
      assert.equal(cold.length, removed === 0 ? 0 : originals.length, "the copies stay once an original has gone");
      // What is left still halts a plain start, and cold, started again, finishes.
      clock += 1_000;
      assert.throws(() => store({}, { now }).open(), { code: "STATE_SNAPSHOT_CORRUPT" });
      clock += 1_000;
      const finishing = store({ stateRecovery: "cold" }, { now });
      try {
        assertColdStarted(finishing.open());
      } finally {
        finishing.close();
      }
    });
  }
});

test("cold is a choice for a state that cannot be read: one that reads back whole is kept", async () => {
  await withDirectory("state-cold-healthy", async (directory) => {
    const { paths, store } = await seedState(directory);
    const cold = store({ stateRecovery: "cold" });
    try {
      const loaded = cold.open();
      assert.deepEqual(loaded.tasks.map((task) => task.taskId), ["task-snapshot", "task-log", "task-log-2"]);
      assert.equal(loaded.recovery.source, "snapshot");
      assert.deepEqual(loaded.recovery.alerts, []);
      assert.equal((await readdir(directory)).some((name) => name.includes(".cold-")), false);
      assert.ok((await readWal(paths)).length > 1);
    } finally {
      cold.close();
    }
  });
});

for (const version of [6, 4, undefined]) test(`a schema ${version ?? "missing"} snapshot halts rather than being rewritten`, async () => {
  await withDirectory(`state-version-${version ?? "missing"}`, async (directory) => {
    const statePath = join(directory, "state.json");
    const paths = statePaths(statePath);
    const body = JSON.stringify({ sessions: [], tasks: [], inbox: [] });
    await writeFile(paths.snapshot, `${JSON.stringify({
      ...(version === undefined ? {} : { version }),
      bodyBytes: Buffer.byteLength(body),
      bodySha256: createHash("sha256").update(body).digest("hex"),
      walSeq: 0,
      epoch: 0
    })}\n${body}\n`);
    const service = makeService(directory);
    await assert.rejects(service.init(), (error) => {
      assert.equal(error.code, "STATE_VERSION_UNSUPPORTED");
      return true;
    });
    assert.equal((await service.call("setup", {}, MAIN)).persistence.walSeq, 0);
    // Pre-flight is the same check, run while a human is watching the installer.
    const { preflightStateVersion } = await import("../src/state-store.js");
    const preflight = preflightStateVersion(statePath);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.snapshotVersion, version ?? null);
    assert.match(preflight.error, version === undefined ? /no valid schema version/ : new RegExp(`schema v${version}`));
  });
});

test("malformed legacy state fails with a stable corruption code", async () => {
  await withDirectory("state-legacy-corrupt", async (directory) => {
    await writeFile(join(directory, "state.json"), "{not-json\n", { mode: 0o600 });
    const service = makeService(directory);
    await assert.rejects(service.init(), (error) => {
      assert.equal(error.code, "STATE_SNAPSHOT_CORRUPT");
      assert.match(error.message, /Legacy Gateway state/);
      return true;
    });
  });
});

test("an unhealthy store refuses new task handles but still opens sessions", async () => {
  await withDirectory("state-unhealthy", async (directory) => {
    const service = makeService(directory);
    try {
      await service.init();
      const opened = await openSession(service);
      const durable = service.stateStore.appendDurable.bind(service.stateStore);
      service.stateStore.appendDurable = () => {
        throw new Error("injected barrier failure");
      };
      const before = service.taskStore.size;
      await assert.rejects(
        service.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, MAIN),
        (error) => {
          assert.equal(error.code, "PERSISTENCE_UNHEALTHY");
          assert.match(error.message, /injected barrier failure/);
          return true;
        }
      );
      // The compensating remove ran: a handle that never became durable must not
      // linger, and the session must still be promptable.
      assert.equal(service.taskStore.size, before);
      assert.equal(service.requireSession(opened.sessionId)._reserved, null);
      assert.equal((await service.call("setup", {}, MAIN)).persistence.healthy, false);

      // A plain prompt is still accepted: only the Task handle is a durability
      // promise, so only it is fail-closed.
      assert.equal(
        (await service.call("prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, MAIN)).status,
        "running"
      );
      await waitForIdle(service, opened.sessionId);

      // Nor is session_open refused (§8.16): the cost of losing a registration is
      // an orphaned child, and refusing it would brick the whole gateway.
      await service.call("session", { action: "close", sessionId: opened.sessionId }, MAIN);
      const second = await openSession(service);
      assert.match(second.sessionId, /^acp-/);

      // Recovery is the next successful write, and a read never clears it.
      service.stateStore.appendDurable = durable;
      await service.call("task_get", { taskId: "task-nope" }, MAIN).catch(() => {});
      assert.equal((await service.call("setup", {}, MAIN)).persistence.healthy, false);
      await service.flushPersist();
      assert.equal((await service.call("setup", {}, MAIN)).persistence.healthy, true);
      const task = await service.call("task_prompt", { sessionId: second.sessionId, prompt: "narrated-result" }, MAIN);
      assert.equal(task.status, "working");
      await waitForIdle(service, second.sessionId);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("an unchanged status change writes no record, and repeats replay last-writer-wins", async () => {
  await withDirectory("state-coalesce", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    const service = makeService(directory, { permissionPolicy: "ask" });
    try {
      await service.init();
      const opened = await openSession(service, "ask");
      const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "block" }, MAIN);
      const session = service.requireSession(opened.sessionId);
      for (let attempt = 0; attempt < 40 && session.status !== "waiting_permission"; attempt += 1) {
        await new Promise((done) => setTimeout(done, 25));
      }
      await service.flushPersist();
      const baseline = (await readWal(paths)).filter((record) => record.type === "task.status_changed").length;

      // The unbounded producer: syncSessionInputState mirrors the same status on
      // every worker request. An identical (status, statusMessage) writes nothing.
      for (let round = 0; round < 20; round += 1) service.syncSessionInputState(session);
      await service.flushPersist();
      const unchanged = (await readWal(paths)).filter((record) => record.type === "task.status_changed").length;
      assert.equal(unchanged, baseline, "an unchanged status change is not a durable fact");

      // Three real changes are three facts. They are written straight through
      // (only the fsync is grouped), and replay resolves them last-writer-wins.
      service.updateTaskForSession(session, "working", "first");
      service.updateTaskForSession(session, "working", "second");
      service.updateTaskForSession(session, "working", "third");
      await service.flushPersist();
      const written = (await readWal(paths)).filter((record) => record.type === "task.status_changed");
      assert.equal(written.length, baseline + 3);
      assert.deepEqual(
        written.slice(-3).map((record) => record.payload.statusMessage),
        ["first", "second", "third"]
      );
      assert.equal(service.taskStore.get(task.taskId).statusMessage, "third");
      const seqs = written.map((record) => record.seq);
      assert.deepEqual([...seqs].sort((left, right) => left - right), seqs, "seq is the ordering authority");
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("a replayed run of status changes lands on the last one", async () => {
  await withDirectory("state-lww", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    const service = makeService(directory, { permissionPolicy: "ask" });
    let taskId = null;
    try {
      await service.init();
      const opened = await openSession(service, "ask");
      const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "block" }, MAIN);
      taskId = task.taskId;
      const session = service.requireSession(opened.sessionId);
      service.updateTaskForSession(session, "working", "first");
      service.updateTaskForSession(session, "input_required", "last one wins");
    } finally {
      await keepLogAcrossShutdown(service, paths);
    }

    const reloaded = makeService(directory, { permissionPolicy: "ask" });
    try {
      await reloaded.init();
      // input_required is in-flight, so the restart conversion applies on top of
      // the last replayed status rather than on top of an earlier one.
      const got = await reloaded.call("task_get", { taskId }, MAIN);
      assert.equal(got.status, "failed");
      assert.match(got.statusMessage, /Gateway restarted/);
    } finally {
      // The reloaded service, whose restart conversion armed a snapshot write
      // that would otherwise land while the directory is being removed.
      await reloaded.shutdown().catch(() => {});
    }
  });
});

test("task bytes are retained on their own clock, and a removal is durable", async () => {
  await withDirectory("state-retention", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    let clock = Date.parse("2026-03-01T00:00:00.000Z");
    const service = makeService(directory, {
      now: () => clock,
      sessionRetentionMs: 10,
      inboxRetentionMs: 10,
      taskRetentionMs: 60_000
    });
    let taskId = null;
    try {
      await service.init();
      const { opened, task } = await runTask(service);
      taskId = task.taskId;

      // Session retention deletes the session record; the task outlives it now.
      clock += 5_000;
      await service.runMaintenance();
      assert.equal(service.store.get(opened.sessionId), undefined, "the session record is gone");
      assert.equal((await service.call("task_get", { taskId }, MAIN)).status, "completed");

      // Its own retention is what ends it, and the removal is written down.
      clock += 60_000;
      await service.runMaintenance();
      await service.flushPersist();
      await assert.rejects(service.call("task_get", { taskId }, MAIN), (error) => {
        assert.equal(error.code, "UNKNOWN_TASK");
        return true;
      });
      const removals = (await readWal(paths)).filter((record) => record.type === "task.removed");
      assert.ok(removals.some((record) => record.key === taskId), "a removal without a record replays as a resurrection");
    } finally {
      await service.shutdown();
    }

    const reloaded = makeService(directory, { now: () => clock });
    try {
      await reloaded.init();
      await assert.rejects(reloaded.call("task_get", { taskId }, MAIN), /Unknown taskId/);
    } finally {
      await reloaded.shutdown();
    }
  });
});

test("ACP_GATEWAY_WAL=off keeps the same durability promise with snapshots only", async () => {
  await withDirectory("state-wal-off", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    const service = makeService(directory, { persistence: { wal: false } });
    let taskId = null;
    try {
      await service.init();
      const { task } = await runTask(service);
      taskId = task.taskId;
      assert.equal((await service.call("setup", {}, MAIN)).persistence.mode, "snapshot");
      await assert.rejects(stat(paths.wal), /ENOENT/, "no log is created in snapshot mode");
      // The barrier still ran: the snapshot on disk already holds the result.
      const snapshot = await readSnapshot(paths);
      assert.equal(snapshot.body.tasks[0].status, "completed");
    } finally {
      await service.shutdown();
    }

    const reloaded = makeService(directory, { persistence: { wal: false } });
    try {
      await reloaded.init();
      assert.equal((await reloaded.call("task_result", { taskId }, MAIN)).result.text, "FINAL ANSWER");
    } finally {
      await reloaded.shutdown();
    }
  });
});

test("the state directory is locked against a second live writer", async () => {
  await withDirectory("state-lock", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    // pid 1 is always alive and is never this process: exactly the "another
    // daemon on a different socket, same state directory" case.
    await writeFile(paths.lock, "1\n", { mode: 0o600 });
    const service = makeService(directory);
    await assert.rejects(service.init(), (error) => {
      assert.equal(error.code, "STATE_DIR_LOCKED");
      assert.match(error.message, /pid=1/);
      return true;
    });

    // A stale lock from a dead writer is reclaimed instead of bricking the start.
    await writeFile(paths.lock, "999999\n", { mode: 0o600 });
    const reclaiming = makeService(directory);
    try {
      await reclaiming.init();
      assert.equal((await reclaiming.call("setup", {}, MAIN)).persistence.mode, "wal");
    } finally {
      await reclaiming.shutdown();
    }
  });
});

// Astra I4: two starters that read the same stale lock each unlinked it by
// name, so the second removed the lock the first had just made, and both wrote
// the same log. And a second store in the same process read its own pid in
// the first one's lock and took it.
test("two starters over one stale state lock: exactly one takes it", async () => {
  await withDirectory("state-lock-race", async (directory) => {
    const lock = statePaths(join(directory, "state.json")).lock;
    await writeFile(lock, "999999\n", { mode: 0o600 });
    const isAlive = (pid) => pid === 1001 || pid === 1002;
    const take = (pid, beforeClaim) => {
      try {
        return { fd: claimStateLock(lock, { pid, isAlive, beforeClaim }) };
      } catch (error) {
        return { error };
      }
    };
    // The second starter judged the same stale lock, and gets through first.
    let second = null;
    const first = take(1001, () => {
      second ??= take(1002);
    });
    try {
      assert.equal([first, second].filter((outcome) => outcome.fd != null).length, 1, "one holder");
      assert.equal(typeof second.fd, "number");
      assert.equal(first.error?.code, "STATE_DIR_LOCKED");
      assert.match(first.error.message, /pid=1002/);
      assert.equal((await readFile(lock, "utf8")).trim(), "1002", "the holder's lock is where it was");
      assert.deepEqual(await readdir(directory), ["state.lock"], "no claimed lock is left behind");
    } finally {
      closeSync(second.fd);
    }
    // A lock that names no pid yet is one being made, never stale.
    await writeFile(lock, "");
    assert.throws(() => claimStateLock(lock, { pid: 1003, isAlive }), { code: "STATE_DIR_LOCKED" });
  });
});

test("a second store for one state directory in one process is refused, under any spelling", async () => {
  await withDirectory("state-lock-twice", async (directory) => {
    const state = join(directory, "state");
    await mkdir(state);
    await symlink(state, join(directory, "link"));
    const statePath = join(state, "state.json");
    const first = new StateStore({ statePath });
    first.open();
    try {
      for (const spelled of [statePath, join(directory, "link", "state.json")]) {
        assert.throws(() => new StateStore({ statePath: spelled }).open(), (error) => {
          assert.equal(error.code, "STATE_DIR_LOCKED");
          assert.match(error.message, /already has the Gateway state directory/);
          return true;
        });
      }
      assert.equal((await readFile(statePaths(statePath).lock, "utf8")).trim(), String(process.pid));
    } finally {
      first.close();
    }
    await assert.rejects(stat(statePaths(statePath).lock), /ENOENT/, "released with its store");
    const next = new StateStore({ statePath });
    next.open();
    next.close();
  });
});

// Astra I2 (161cb41): of three Gateways on different sockets that start over
// one stale state lock, a claim that lost its race can move the first one's
// lock aside, and the third makes its own while the path stands empty
// (restoreLock). Two then wrote the directory, and nothing checked the lock
// again. Lock files cannot prevent that, so the store finds it out before it
// writes: it stops writing, names the Gateway that has the lock, and replaces
// neither the snapshot nor the log.
test("a store whose state lock another Gateway took stops writing, names that Gateway, and replaces nothing", async () => {
  await withDirectory("state-lock-lost", async (directory) => {
    const paths = statePaths(join(directory, "state.json"));
    // The debounced writer stays quiet until the flushes below.
    const service = makeService(directory, { snapshotIntervalMs: 60_000 });
    const health = async () => (await service.call("setup", { mode: "summary" }, MAIN)).persistence;
    const lostLock = (error) => {
      assert.match(error.message, /Another Gateway \(pid=1\) has taken the lock of the state directory .*, so this one \(pid=\d+\) stopped writing state there/);
      return true;
    };
    let taskId = null;
    let stopped = false;
    try {
      await service.init();
      const { opened, task } = await runTask(service);
      taskId = task.taskId;
      await service.flushPersist();
      assert.equal((await health()).healthy, true);

      // A claim that lost its race takes this store's lock aside and puts it
      // back by link(2): the same file, still this store's.
      const aside = `${paths.lock}.4242.tmp`;
      renameSync(paths.lock, aside);
      linkSync(aside, paths.lock);
      unlinkSync(aside);
      await runTaskOn(service, opened.sessionId);
      await service.flushPersist();
      assert.equal((await health()).healthy, true, "a lock put back is still this store's");

      // One that has not put it back yet leaves the path empty: the next
      // write makes the lock again, so a Gateway starting then finds it held,
      // and the claim's link back meets it and drops what it took.
      renameSync(paths.lock, aside);
      await runTaskOn(service, opened.sessionId);
      assert.equal((await readFile(paths.lock, "utf8")).trim(), String(process.pid), "made again");
      assert.throws(() => claimStateLock(paths.lock, { pid: 1003, isAlive: (pid) => pid === process.pid }), { code: "STATE_DIR_LOCKED" });
      unlinkSync(aside);
      await service.flushPersist();
      assert.equal((await health()).healthy, true, "and this store goes on with it");

      // One that found a third starter's lock there drops it instead, and the
      // path holds another Gateway's (pid 1 is always alive).
      renameSync(paths.lock, aside);
      writeFileSync(paths.lock, "1\n", { mode: 0o600 });
      unlinkSync(aside);
      const before = { wal: await readFile(paths.wal), snapshot: await readFile(paths.snapshot) };
      await assert.rejects(
        service.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, MAIN),
        (error) => error.code === "PERSISTENCE_UNHEALTHY" && lostLock(error)
      );
      const persistence = await health();
      assert.equal(persistence.healthy, false);
      lostLock({ message: persistence.error });
      // Every write after it fails the same way, and none touches a file.
      assert.equal(service.stateStore.append(WAL_TYPES.TASK_SEEN, taskId, { seenAt: new Date().toISOString() }), false);
      service.persistDirty = true;
      await assert.rejects(service.flushPersist(), (error) => error.code === "STATE_DIR_LOCKED" && lostLock(error));
      assert.throws(() => service.stateStore.rotate(), (error) => error.code === "STATE_DIR_LOCKED" && lostLock(error));
      // Shutdown included: its last snapshot and rotation are refused too.
      stopped = true;
      await assert.rejects(service.shutdown(), { code: "STATE_DIR_LOCKED" });
      assert.deepEqual(await readFile(paths.wal), before.wal, "nothing more in the log");
      assert.deepEqual(await readFile(paths.snapshot), before.snapshot, "the snapshot is not replaced");
      assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), [], "nor left beside it");
      assert.equal(await readFile(paths.lock, "utf8"), "1\n", "the other Gateway's lock stays");
    } finally {
      if (!stopped) await service.shutdown().catch(() => {});
    }

    // Once that Gateway is gone, what this one wrote before is all there.
    await rm(paths.lock);
    const restarted = makeService(directory);
    try {
      await restarted.init();
      assert.equal((await restarted.call("task_get", { taskId }, MAIN)).status, "completed");
    } finally {
      await restarted.shutdown();
    }
  });
});

async function readdirCorrupt(directory, kind) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory);
  const match = entries.find((entry) => entry.includes(`${kind}.ndjson.corrupt-`));
  return match ? match.split(".corrupt-")[1] : "none";
}
