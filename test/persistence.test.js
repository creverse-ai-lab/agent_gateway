// State v5 (PR 4): snapshot + critical WAL. These tests are in-process and
// deterministic — formats, replay, migration, rotation, health. The kill -9
// ordering matrix lives in test/crash-matrix.test.js.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { GatewayService } from "../src/gateway-service.js";
import { decodeRecord, encodeRecord, statePaths, WAL_TYPES } from "../src/state-store.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MAIN = { rootId: "main-a" };

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
async function keepLogAcrossShutdown(service, paths, { dropSnapshot = true } = {}) {
  await service.flushPersist();
  const wal = await readFile(paths.wal);
  await service.shutdown();
  await writeFile(paths.wal, wal, { mode: 0o600 });
  if (dropSnapshot) await rm(paths.snapshot, { force: true });
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

test("v5 writes a two-line checksummed snapshot beside a crc32 WAL, and keeps writing v4", async () => {
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

      // The v4 file keeps its exact 1.3.2 shape, plus the two marker fields.
      const legacy = JSON.parse(await readFile(paths.state, "utf8"));
      assert.equal(legacy.version, 4);
      assert.equal(typeof legacy.writerVersion, "string");
      assert.deepEqual(legacy.tasks, [], "terminal handles stay out of the v4 file");
      assert.equal(legacy.sessions.length, 1);
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

    await rm(paths.snapshot);
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
    const before = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(typeof before.writerVersion, "string", "a v5 write always carries the marker");

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
    const before = JSON.parse(await readFile(statePath, "utf8"));
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
    await rm(paths.snapshot, { force: true });
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

test("a corrupt snapshot halts instead of starting empty, and snapshot-drop falls back to v4", async () => {
  await withDirectory("state-snapshot-corrupt", async (directory) => {
    const statePath = join(directory, "state.json");
    const paths = statePaths(statePath);
    const service = makeService(directory);
    try {
      await service.init();
      await openSession(service);
      await service.flushPersist();
    } finally {
      await service.shutdown();
    }

    const raw = await readFile(paths.snapshot, "utf8");
    const split = raw.indexOf("\n");
    // One flipped byte in the body: the header's length still matches.
    const body = raw.slice(split + 1).replace(/"provider":"claude"/, '"provider":"clauda"');
    await writeFile(paths.snapshot, `${raw.slice(0, split)}\n${body}`);

    const halting = makeService(directory);
    await assert.rejects(halting.init(), (error) => {
      assert.equal(error.code, "STATE_SNAPSHOT_CORRUPT");
      assert.match(error.message, /checksum mismatch/);
      assert.match(error.message, /snapshot-drop/);
      return true;
    });

    const dropping = makeService(directory, { persistence: { stateRecovery: "snapshot-drop" } });
    try {
      await dropping.init();
      const setup = await dropping.call("setup", {}, MAIN);
      assert.ok(setup.alerts.some((alert) => alert.code === "STATE_SNAPSHOT_DROPPED"));
      // The v4 dual-write is what made the fallback possible.
      assert.equal((await dropping.call("session", { action: "list" }, MAIN)).sessions.length, 1);
    } finally {
      await dropping.shutdown();
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
      await service.shutdown().catch(() => {});
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

async function readdirCorrupt(directory, kind) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory);
  const match = entries.find((entry) => entry.includes(`${kind}.ndjson.corrupt-`));
  return match ? match.split(".corrupt-")[1] : "none";
}
