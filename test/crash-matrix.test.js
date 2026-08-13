// Crash matrix C1-C18 (PR 4 design section 8). Each case kills a real daemon at
// one specific point and then asserts what the next daemon may and may not see.
//
// HONEST CAVEAT, and it is the whole reason to read this comment: this matrix
// validates ORDERING and REPLAY IDEMPOTENCY, not fsync. A page-cache write
// survives the death of the process that made it, so a kill -9 test cannot tell
// a barriered write from an unbarriered one. What it does prove is that the
// gateway writes its records in the order that makes every crash point
// interpretable, and that replaying them twice changes nothing. That fsync is
// actually called is argued from the code path plus the counter in C18; only a
// power cut (or a filesystem that lies) could distinguish further.
//
// Invariants under test:
//   P1 a handle that was RETURNED still exists after a restart (never UNKNOWN_TASK)
//   P2 no half-existing handle: terminal implies a result, non-terminal implies
//      failed with the restart message
//   P3 a handle that was never returned may be gone OR failed - both are correct,
//      so the assertion is the disjunction
//   P4 a task whose create was not made durable never started an ACP turn
//   P5 a durable result comes back byte-identical (modulo resultDegraded)
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { statePaths } from "../src/state-store.js";
import { daemonPaths, HARNESS_ROOT_ID, startDaemon, writeMockProviders } from "./helpers/daemon-harness.js";

const FAULT_PRELOAD = ["--import", fileURLToPath(new URL("./helpers/fault-fs.js", import.meta.url))];
const SESSION_ID = "acp-crash-session";

async function boot(directory, { faults = [], env = {}, policy = "read_only", ...rest } = {}) {
  const providers = await writeMockProviders(directory, { permissionPolicy: policy });
  return startDaemon({
    directory,
    execArgv: faults.length ? FAULT_PRELOAD : [],
    env: {
      ...providers,
      ACP_MOCK_PROMPT_LOG: join(directory, "prompts.ndjson"),
      ...(faults.length ? { ACP_GATEWAY_FAULT_FS: JSON.stringify(faults) } : {}),
      ...env
    },
    ...rest
  });
}

function connect(daemon) {
  return new GatewayRpcClient({
    socketPath: daemon.socketPath,
    token: daemon.token,
    rootId: daemon.rootId,
    statePath: daemon.statePath,
    autoStart: false
  });
}

async function openSession(client, policy = "read_only") {
  const opened = await client.call("session_open", { provider: "mock", cwd: tmpdir(), permissionPolicy: policy });
  // Force the group commit for session.registered to land, so a later crash in a
  // task path is only ever about the task.
  await client.call("task_list");
  await new Promise((done) => setTimeout(done, 25));
  return opened;
}

async function promptCount(directory) {
  const raw = await readFile(join(directory, "prompts.ndjson"), "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).length;
}

async function taskOrNull(client, taskId) {
  try {
    return await client.call("task_get", { taskId });
  } catch (error) {
    if (error.code === "UNKNOWN_TASK") return null;
    throw error;
  }
}

// P2 + P3: whatever survived must be internally consistent.
async function assertNoHalfHandle(client, taskId) {
  const task = await taskOrNull(client, taskId);
  if (task == null) return null;
  if (["completed", "cancelled"].includes(task.status)) {
    const result = await client.call("task_result", { taskId });
    assert.ok(result != null, "a terminal handle must have a result");
    return task;
  }
  assert.equal(task.status, "failed", `a surviving non-terminal handle must be failed, got ${task.status}`);
  const result = await client.call("task_result", { taskId });
  assert.equal(result.ok, false);
  return task;
}

async function withDirectory(name, run) {
  const directory = await mkdtemp(join(tmpdir(), `acp-crash-${name}-`));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function seedV4State(extra = {}) {
  const timestamp = new Date().toISOString();
  return {
    version: 4,
    sessions: [{
      id: SESSION_ID, provider: "mock", acpSessionId: "mock-session", cwd: tmpdir(), title: null,
      permissionPolicy: "read_only", model: "mock-default", ownerRootId: HARNESS_ROOT_ID, mcpServers: [],
      additionalDirectories: [], pinned: false, status: "idle", createdAt: timestamp, updatedAt: timestamp,
      completedAt: null, orphanedAt: null, lastOwnerActivityAt: timestamp, transientClearedAt: null,
      eventSequence: 2, turnId: null, stopReason: null
    }],
    tasks: [],
    inbox: [],
    ...extra
  };
}

// --------------------------------------------------------------- create window

test("C1: killed before the task.created record is written, no phantom handle or turn", async () => {
  await withDirectory("c1", async (directory) => {
    let daemon = await boot(directory, {
      faults: [{ call: "writeSync", path: "state.wal", contains: "task.created", action: "kill" }]
    });
    let client = connect(daemon);
    const opened = await openSession(client);
    await assert.rejects(client.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }));
    const dead = await daemon.waitForExit();
    assert.equal(dead.signalCode, "SIGKILL");
    client.close();

    // P4: nothing was made durable, so nothing was started.
    assert.equal(await promptCount(directory), 0);

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      assert.deepEqual((await client.call("task_list")).tasks, [], "a create that never landed leaves no handle");
      const sessions = (await client.call("session", { action: "list" })).sessions;
      assert.deepEqual(sessions.map((session) => session.sessionId), [opened.sessionId]);
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C2: killed mid task.created write, the torn tail is discarded silently", async () => {
  await withDirectory("c2", async (directory) => {
    let daemon = await boot(directory, {
      faults: [{ call: "writeSync", path: "state.wal", contains: "task.created", action: "half-then-kill" }]
    });
    let client = connect(daemon);
    const opened = await openSession(client);
    await assert.rejects(client.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }));
    await daemon.waitForExit();
    client.close();
    assert.equal(await promptCount(directory), 0, "P4: no turn started behind a half-written record");

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      const setup = await client.call("setup");
      assert.equal(setup.persistence.healthy, true, "a torn tail is a normal start, not a failure");
      assert.equal(setup.persistence.lastRecovery.droppedTail, 1);
      assert.deepEqual((await client.call("task_list")).tasks, []);
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C3: killed after the create barrier and before the ACP turn, the handle survives as failed", async () => {
  await withDirectory("c3", async (directory) => {
    let daemon = await boot(directory, { env: { ACP_GATEWAY_CRASH_AFTER: "task_create_durable" } });
    let client = connect(daemon);
    const opened = await openSession(client);
    // The reply never arrives: the daemon aborts between the durable write and
    // the ACP turn. The handle is durable, but the caller never received it.
    await assert.rejects(client.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }));
    await daemon.waitForExit();
    client.close();
    // P4: the barrier is before sessionPrompt, so no turn was ever started.
    assert.equal(await promptCount(directory), 0);

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      const tasks = (await client.call("task_list")).tasks;
      assert.equal(tasks.length, 1, "the durable handle is still there");
      // P2: the restart conversion, not a working handle nobody will ever finish.
      assert.equal(tasks[0].status, "failed");
      assert.match(tasks[0].statusMessage, /Gateway restarted/);
      await assertNoHalfHandle(client, tasks[0].taskId);
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C4: killed with a permission outstanding, the handle fails and the request is interrupted", async () => {
  await withDirectory("c4", async (directory) => {
    let daemon = await boot(directory, { policy: "ask" });
    let client = connect(daemon);
    const opened = await openSession(client, "ask");
    const task = await client.call("task_prompt", { sessionId: opened.sessionId, prompt: "block" });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const inbox = await client.call("inbox", { action: "list", status: "pending" });
      if (inbox.items.length > 0) break;
      await new Promise((done) => setTimeout(done, 25));
    }
    assert.equal((await client.call("inbox", { action: "list", status: "pending" })).items.length, 1);
    assert.equal(await promptCount(directory), 1, "the turn really did start");
    // No grace period: the inbox record is T1 (only its fsync is grouped), so the
    // bytes are already in the page cache by the time Main can see the request.
    // A killed process cannot take them back - only a power cut could.
    await daemon.killHard();
    client.close();

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      // P1: this handle was returned, so it must exist.
      const got = await client.call("task_get", { taskId: task.taskId });
      assert.equal(got.status, "failed");
      await assertNoHalfHandle(client, task.taskId);
      const inbox = await client.call("inbox", { action: "list" });
      assert.equal(inbox.items.length, 1, "the durable request record survived");
      assert.equal(inbox.items[0].status, "interrupted", "its worker is gone, so it can never be answered");
      assert.deepEqual((await client.call("inbox", { action: "list", status: "pending" })).items, []);
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C5: killed before the inbox record is written, the handle is still consistent", async () => {
  await withDirectory("c5", async (directory) => {
    let daemon = await boot(directory, {
      policy: "ask",
      faults: [{ call: "writeSync", path: "state.wal", contains: "inbox.created", action: "kill" }]
    });
    let client = connect(daemon);
    const opened = await openSession(client, "ask");
    const task = await client.call("task_prompt", { sessionId: opened.sessionId, prompt: "block" });
    const dead = await daemon.waitForExit();
    assert.equal(dead.signalCode, "SIGKILL");
    client.close();

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      // P1 holds even though the inbox record never landed: inbox is T1, the
      // handle is T0, and the two are independent facts.
      const got = await assertNoHalfHandle(client, task.taskId);
      assert.equal(got.status, "failed");
      // P3-shaped: the request record may or may not exist, but it must never be
      // pending, because nothing can answer it.
      assert.deepEqual((await client.call("inbox", { action: "list", status: "pending" })).items, []);
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

// ---------------------------------------------------------------- result window

test("C6: killed before the result artifact is fsynced, the handle does not claim success", async () => {
  await withDirectory("c6", async (directory) => {
    let daemon = await boot(directory, {
      env: { ACP_GATEWAY_WAL_INLINE_RESULT_BYTES: "64" },
      faults: [{ call: "fsyncSync", path: "acp-artifact-", action: "kill" }]
    });
    let client = connect(daemon);
    const opened = await openSession(client);
    const task = await client.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" });
    await daemon.waitForExit();
    client.close();

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      const got = await assertNoHalfHandle(client, task.taskId);
      // P2 in its most important form: a result that was never durable must not
      // come back as completed.
      assert.equal(got.status, "failed");
      assert.match(got.statusMessage, /Gateway restarted/);
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C7: killed mid result artifact write, the partial file is never referenced", async () => {
  await withDirectory("c7", async (directory) => {
    let daemon = await boot(directory, {
      env: { ACP_GATEWAY_WAL_INLINE_RESULT_BYTES: "64" },
      faults: [{ call: "writeSync", path: "acp-artifact-", action: "half-then-kill" }]
    });
    let client = connect(daemon);
    const opened = await openSession(client);
    const task = await client.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" });
    await daemon.waitForExit();
    client.close();

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      const got = await assertNoHalfHandle(client, task.taskId);
      assert.equal(got.status, "failed");
      const wal = await readFile(statePaths(daemonPaths(directory).statePath).wal, "utf8").catch(() => "");
      assert.equal(wal.includes("task.result_committed"), false, "no record names the half-written file");
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C8: killed after the artifact fsync but before the result record, the outcome is not claimed", async () => {
  await withDirectory("c8", async (directory) => {
    let daemon = await boot(directory, {
      env: { ACP_GATEWAY_WAL_INLINE_RESULT_BYTES: "64" },
      faults: [{ call: "writeSync", path: "state.wal", contains: "task.result_committed", action: "kill" }]
    });
    let client = connect(daemon);
    const opened = await openSession(client);
    const task = await client.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" });
    await daemon.waitForExit();
    client.close();

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      const got = await assertNoHalfHandle(client, task.taskId);
      assert.equal(got.status, "failed", "the artifact landed, but nothing points at it yet");
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C9: killed after the result barrier, the result comes back byte-identical", async () => {
  await withDirectory("c9", async (directory) => {
    let daemon = await boot(directory, { env: { ACP_GATEWAY_WAL_INLINE_RESULT_BYTES: "64" } });
    let client = connect(daemon);
    const opened = await openSession(client);
    const task = await client.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" });
    let before = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const got = await client.call("task_get", { taskId: task.taskId });
      if (got.status === "completed") {
        before = await client.call("task_result", { taskId: task.taskId });
        break;
      }
      await new Promise((done) => setTimeout(done, 25));
    }
    assert.ok(before != null, "the task must complete before the kill");
    // Every RPC after the commit is served in a later tick than the synchronous
    // barrier, so observing "completed" over the socket means the record is down.
    await daemon.killHard();
    client.close();

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      const got = await client.call("task_get", { taskId: task.taskId });
      assert.equal(got.status, "completed", "P1 + P2");
      // P5.
      assert.deepEqual(await client.call("task_result", { taskId: task.taskId }), before);
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

// -------------------------------------------------------------- rotation window

test("C10: killed after the rotation rename and before its snapshot, the segment replays", async () => {
  await withDirectory("c10", async (directory) => {
    const paths = statePaths(daemonPaths(directory).statePath);
    let daemon = await boot(directory, {
      env: { ACP_GATEWAY_WAL_ROTATE_RECORDS: "2" },
      // nth 2: the first rename belongs to the rotation every start performs
      // right after recovery.
      faults: [{ call: "renameSync", path: "state.wal.ndjson", nth: 2, action: "kill-after" }]
    });
    let client = connect(daemon);
    const opened = await openSession(client);
    await daemon.waitForExit();
    client.close();
    assert.ok((await stat(paths.rotating)).size > 0, "the rolled-aside segment is still on disk");

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      const setup = await client.call("setup");
      assert.ok(setup.persistence.lastRecovery.replayed > 0);
      const sessions = (await client.call("session", { action: "list" })).sessions;
      assert.deepEqual(
        sessions.map((session) => session.sessionId),
        [opened.sessionId],
        "the session registered into the rolled segment is not lost"
      );
      await assert.rejects(stat(paths.rotating), /ENOENT/, "recovery retires the segment it replayed");
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C11: killed after the rotation snapshot and before the unlink, the duplicate replay is inert", async () => {
  await withDirectory("c11", async (directory) => {
    const paths = statePaths(daemonPaths(directory).statePath);
    let daemon = await boot(directory, {
      env: { ACP_GATEWAY_WAL_ROTATE_RECORDS: "2" },
      faults: [{ call: "unlinkSync", path: "state.wal.ndjson.rot", nth: 2, action: "kill" }]
    });
    let client = connect(daemon);
    const opened = await openSession(client);
    await daemon.waitForExit();
    client.close();
    assert.ok((await stat(paths.rotating)).size > 0);

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      const setup = await client.call("setup");
      // The snapshot already covers every record in the segment, so the whole
      // replay is skipped by the seq watermark instead of applied twice.
      assert.ok(setup.persistence.lastRecovery.skipped > 0, "the watermark filtered the duplicate");
      const sessions = (await client.call("session", { action: "list" })).sessions;
      assert.deepEqual(sessions.map((session) => session.sessionId), [opened.sessionId], "no duplicated session");
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

// -------------------------------------------------------------- damaged records

test("C12: a torn WAL tail starts the daemon silently", async () => {
  await withDirectory("c12", async (directory) => {
    const paths = statePaths(daemonPaths(directory).statePath);
    let daemon = await boot(directory);
    let client = connect(daemon);
    const opened = await openSession(client);
    await client.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" });
    await new Promise((done) => setTimeout(done, 100));
    await daemon.killHard();
    client.close();

    const intact = await readFile(paths.wal, "utf8");
    await writeFile(paths.wal, `${intact}{"v":1,"seq":9999,"type":"task.created"`, { mode: 0o600 });

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      const setup = await client.call("setup");
      assert.equal(setup.persistence.healthy, true);
      assert.equal(setup.persistence.lastRecovery.droppedTail, 1);
      assert.equal((await client.call("task_list")).tasks.length, 1, "the intact records still replayed");
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C13: damage inside the WAL halts the daemon with a marker, an exit code and a client message", async () => {
  await withDirectory("c13", async (directory) => {
    const statePath = daemonPaths(directory).statePath;
    const paths = statePaths(statePath);
    let daemon = await boot(directory);
    let client = connect(daemon);
    const opened = await openSession(client);
    await client.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" });
    await new Promise((done) => setTimeout(done, 100));
    await daemon.killHard();
    client.close();

    // Flip a byte inside a record that is not the last one: this is the only
    // shape of damage that can manufacture a half-existing handle.
    const lines = (await readFile(paths.wal, "utf8")).split("\n").filter(Boolean);
    assert.ok(lines.length >= 3, "need a record with records after it");
    lines[1] = lines[1].replace(/"at":"20/, '"at":"19');
    await writeFile(paths.wal, `${lines.join("\n")}\n`, { mode: 0o600 });

    const halted = await boot(directory, { expectExit: true });
    const exit = await halted.waitForExit();
    assert.equal(exit.exitCode, 78, "EX_CONFIG: an operator has to look at this");
    assert.match(exit.stderr, /STATE_WAL_CORRUPT|damaged at byte/);
    const marker = JSON.parse(await readFile(paths.marker, "utf8"));
    assert.equal(marker.errorCode, "STATE_WAL_CORRUPT");
    assert.match(marker.error, /ACP_GATEWAY_STATE_RECOVERY=truncate/);

    // A Main that tries to reach the gateway is told the real reason.
    const blind = new GatewayRpcClient({
      socketPath: halted.socketPath,
      token: halted.token,
      rootId: halted.rootId,
      statePath,
      autoStart: false
    });
    await assert.rejects(blind.call("setup"), (error) => {
      assert.equal(error.code, "STATE_WAL_CORRUPT");
      assert.match(error.message, /Gateway could not start/);
      return true;
    });
    blind.close();

    // The opt-in replays up to the damage and starts.
    daemon = await boot(directory, { env: { ACP_GATEWAY_STATE_RECOVERY: "truncate" } });
    client = connect(daemon);
    try {
      const setup = await client.call("setup");
      assert.ok(setup.alerts.some((alert) => alert.code === "STATE_WAL_TRUNCATED"));
      assert.ok(setup.persistence.lastRecovery.quarantined.includes(".corrupt-"));
      await assert.rejects(stat(paths.marker), /ENOENT/, "a successful start clears the marker");
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C14: a corrupt snapshot never starts empty", async () => {
  await withDirectory("c14", async (directory) => {
    const paths = statePaths(daemonPaths(directory).statePath);
    let daemon = await boot(directory);
    let client = connect(daemon);
    await openSession(client);
    client.close();
    await daemon.stop(); // clean shutdown: the snapshot is the whole state

    const raw = await readFile(paths.snapshot, "utf8");
    const split = raw.indexOf("\n");
    await writeFile(
      paths.snapshot,
      `${raw.slice(0, split)}\n${raw.slice(split + 1).replace('"provider":"mock"', '"provider":"m0ck"')}`,
      { mode: 0o600 }
    );

    const halted = await boot(directory, { expectExit: true });
    const exit = await halted.waitForExit();
    assert.equal(exit.exitCode, 78);
    assert.match(exit.stderr, /body checksum mismatch/);

    // snapshot-drop falls back to the v4 dual-write, which is the entire reason
    // that file is still being written.
    daemon = await boot(directory, { env: { ACP_GATEWAY_STATE_RECOVERY: "snapshot-drop" } });
    client = connect(daemon);
    try {
      const sessions = (await client.call("session", { action: "list" })).sessions;
      assert.equal(sessions.length, 1, "the session came back from state.json, not from nothing");
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C15: a kill during the v4 migration leaves the migration repeatable", async () => {
  await withDirectory("c15", async (directory) => {
    const statePath = daemonPaths(directory).statePath;
    const paths = statePaths(statePath);
    await writeFile(statePath, `${JSON.stringify(seedV4State())}\n`, { mode: 0o600 });

    const halted = await boot(directory, {
      expectExit: true,
      faults: [{ call: "renameSync", path: "state.snapshot.json", action: "kill" }]
    });
    const exit = await halted.waitForExit();
    assert.equal(exit.signalCode, "SIGKILL");
    await assert.rejects(stat(paths.snapshot), /ENOENT/, "no snapshot landed");

    const daemon = await boot(directory);
    const client = connect(daemon);
    try {
      const setup = await client.call("setup");
      assert.equal(setup.persistence.lastRecovery.source, "migrated-v4", "the migration simply runs again");
      const sessions = (await client.call("session", { action: "list" })).sessions;
      assert.deepEqual(sessions.map((session) => session.sessionId), [SESSION_ID]);
      assert.equal(sessions[0].status, "disconnected");
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C16: a second daemon on the same state directory is refused", async () => {
  await withDirectory("c16", async (directory) => {
    const daemon = await boot(directory);
    try {
      const intruder = await boot(directory, {
        expectExit: true,
        env: { ACP_GATEWAY_SOCKET: join(directory, "other.sock") }
      });
      const exit = await intruder.waitForExit();
      assert.equal(exit.exitCode, 78);
      assert.match(exit.stderr, /STATE_DIR_LOCKED|state directory/);
      const marker = JSON.parse(await readFile(statePaths(daemon.statePath).marker, "utf8"));
      assert.equal(marker.errorCode, "STATE_DIR_LOCKED");
    } finally {
      await daemon.killHard();
    }
  });
});

test("C17: a v4 daemon that wrote after us triggers re-migration on the next start", async () => {
  await withDirectory("c17", async (directory) => {
    const statePath = daemonPaths(directory).statePath;
    let daemon = await boot(directory);
    let client = connect(daemon);
    await openSession(client);
    client.close();
    await daemon.stop();

    // Exactly what a rolled-back 1.3.2 daemon leaves: the v4 shape with no
    // writerVersion marker (its persist() writes fixed literals), written later
    // than our snapshot.
    await new Promise((done) => setTimeout(done, 25));
    await writeFile(statePath, `${JSON.stringify(seedV4State())}\n`, { mode: 0o600 });

    daemon = await boot(directory);
    client = connect(daemon);
    try {
      const setup = await client.call("setup");
      assert.equal(setup.persistence.lastRecovery.source, "downgrade-remigrated");
      assert.ok(setup.alerts.some((alert) => alert.code === "DOWNGRADE_DETECTED"));
      const sessions = (await client.call("session", { action: "list" })).sessions;
      assert.deepEqual(
        sessions.map((session) => session.sessionId),
        [SESSION_ID],
        "the work the user did on the old daemon is what survives"
      );
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});

test("C18: the create and the result commit each raise the fsync counter", async () => {
  await withDirectory("c18", async (directory) => {
    // The turn has to be held open by a permission: with an auto-answering policy
    // the whole turn finishes inside the task_prompt round trip, and the two
    // barriers are no longer separately observable.
    const daemon = await boot(directory, { policy: "ask" });
    const client = connect(daemon);
    try {
      const opened = await openSession(client, "ask");
      const before = (await client.call("setup")).persistence;
      assert.equal(before.mode, "wal");
      const task = await client.call("task_prompt", { sessionId: opened.sessionId, prompt: "block" });
      const afterCreate = (await client.call("setup")).persistence;
      assert.ok(
        afterCreate.fsyncCount > before.fsyncCount,
        `create must barrier: ${before.fsyncCount} -> ${afterCreate.fsyncCount}`
      );
      assert.ok(afterCreate.walSeq > before.walSeq);
      assert.equal((await client.call("task_get", { taskId: task.taskId })).status, "input_required");

      const pending = (await client.call("inbox", { action: "list", status: "pending" })).items[0];
      await client.call("permission", {
        sessionId: opened.sessionId,
        requestId: pending.requestId,
        optionId: "allow-once"
      });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if ((await client.call("task_get", { taskId: task.taskId })).status === "completed") break;
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.equal((await client.call("task_get", { taskId: task.taskId })).status, "completed");
      const afterResult = (await client.call("setup")).persistence;
      assert.ok(
        afterResult.fsyncCount > afterCreate.fsyncCount,
        `result commit must barrier: ${afterCreate.fsyncCount} -> ${afterResult.fsyncCount}`
      );
      // This counter is the only direct evidence the matrix can offer about fsync,
      // and it counts every barrier rather than attributing each one; see the
      // caveat at the top of this file.
    } finally {
      client.close();
      await daemon.killHard();
    }
  });
});
