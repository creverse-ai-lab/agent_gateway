// Chaos foundation: a real daemon, killed with SIGKILL, must come back on the
// same state file with the same restart semantics and no duplicated records.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { daemonPaths, HARNESS_ROOT_ID, startDaemon } from "./helpers/daemon-harness.js";

const SESSION_ID = "acp-chaos-session";
const INBOX_ID = "inbox-chaos-pending";

test("daemon restart after SIGKILL reapplies restart semantics without duplicating state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-chaos-restart-"));
  const { statePath } = daemonPaths(directory);
  let daemon = null;
  let client = null;
  try {
    await writeFile(statePath, `${JSON.stringify(seedState())}\n`, { mode: 0o600 });

    daemon = await startDaemon({ directory });
    client = connect(daemon);
    await assertRestartSemantics(client);
    const firstPid = daemon.child.pid;

    // Hard kill: no shutdown hook runs, so the socket file and daemon lock are
    // left behind for the next start to reclaim.
    const killed = await daemon.killHard();
    assert.equal(killed.signalCode, "SIGKILL");
    client.close();
    client = null;

    daemon = await startDaemon({ directory });
    assert.notEqual(daemon.child.pid, firstPid);
    client = connect(daemon);
    await assertRestartSemantics(client);

    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.version, 4, "state schema version must survive a hard restart");
    assert.equal(saved.sessions.length, 1, "the session record must not be duplicated");
    assert.equal(saved.sessions[0].id, SESSION_ID);
    assert.equal(saved.inbox.length, 1, "the inbox record must not be duplicated");
    assert.equal(saved.inbox[0].inboxId, INBOX_ID);
  } finally {
    client?.close();
    await daemon?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

function connect(daemon) {
  return new GatewayRpcClient({
    socketPath: daemon.socketPath,
    token: daemon.token,
    rootId: daemon.rootId,
    autoStart: false
  });
}

async function assertRestartSemantics(client) {
  const sessions = (await client.call("session", { action: "list" })).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, SESSION_ID);
  assert.equal(sessions[0].provider, "claude");
  // An idle session cannot keep its ACP process across a restart; it comes back
  // as disconnected and is restored on the next prompt.
  assert.equal(sessions[0].status, "disconnected");

  const inbox = await client.call("inbox", { action: "list" });
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].inboxId, INBOX_ID);
  // A pending worker request belonged to the dead ACP process; it can never be
  // answered, so Main sees it as interrupted rather than actionable.
  assert.equal(inbox.items[0].status, "interrupted");
  assert.match(inbox.items[0].resolution, /Gateway restarted/);
  assert.deepEqual((await client.call("inbox", { action: "list", status: "pending" })).items, []);
}

// Mirrors SessionStore.checkpoints() plus the raw inbox record shape written by
// GatewayService.persist().
function seedState() {
  const timestamp = new Date().toISOString();
  return {
    version: 4,
    sessions: [
      {
        id: SESSION_ID,
        provider: "claude",
        acpSessionId: "chaos-acp-session",
        cwd: "/",
        title: "chaos fixture",
        permissionPolicy: "ask",
        model: "mock-default",
        ownerRootId: HARNESS_ROOT_ID,
        mcpServers: [],
        additionalDirectories: [],
        pinned: false,
        status: "idle",
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        orphanedAt: null,
        lastOwnerActivityAt: timestamp,
        transientClearedAt: null,
        eventSequence: 7,
        turnId: "turn-chaos",
        stopReason: "end_turn"
      }
    ],
    tasks: [],
    inbox: [
      {
        inboxId: INBOX_ID,
        ownerRootId: HARNESS_ROOT_ID,
        sessionId: SESSION_ID,
        turnId: "turn-chaos",
        type: "permission_request",
        status: "pending",
        createdAt: timestamp,
        resolvedAt: null,
        resolution: null,
        requestId: 42,
        toolCall: { toolCallId: "tool-chaos", title: "Edit file", kind: "edit" },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
      }
    ]
  };
}
