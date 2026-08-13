// Golden characterization of the shipped 1.3.2 control surface. These tests
// assert SHAPE (key sets, presence and absence of fields), never timing or
// event interleavings, so later refactors show up here as an explicit,
// reviewable diff instead of a silent contract change.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { ERROR_CODES, GatewayError, errorEnvelope } from "../src/errors.js";
import { GatewayService } from "../src/gateway-service.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { GATEWAY_VERSION } from "../src/version.js";
import { startDaemon } from "./helpers/daemon-harness.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MAIN = { rootId: "main-a" };

// publicSession() fields (src/sessions.js). Adding or removing one is a
// control-plane contract change and must be reviewed as such.
const PUBLIC_SESSION_KEYS = [
  "sessionId", "acpSessionId", "provider", "status", "cwd", "permissionPolicy", "model", "title",
  "pinned", "lastOwnerActivityAt", "turnId", "stopReason", "error", "createdAt", "updatedAt",
  "eventCount", "resultArtifact"
];
const ACTIVE_POLL_KEYS = sorted([
  "ok", ...PUBLIC_SESSION_KEYS, "nextCursor", "cursorTruncated", "events", "filteredCount"
]);
const TERMINAL_POLL_KEYS = sorted([...ACTIVE_POLL_KEYS, "result"]);
// What a caller actually receives for a small result: JSON drops the
// undefined-valued thought field, and textArtifact appears only when the
// final answer was spilled to disk.
const WIRE_RESULT_KEYS = sorted(["text", "transcriptBytes", "artifact", "stopReason"]);
// GOLDEN DIFF (1.4.0 PR 7, H1): responseProfiles joins setup. It is the only
// way a Main can learn that compact/diagnostic exist: an old gateway ignores an
// unknown argument silently, so probing by sending one cannot detect support.
// Everything else in full setup is frozen; mode:"summary" is a separate, opt-in
// response and never changes this one.
const SETUP_KEYS = sorted([
  "ok", "gatewayVersion", "gatewayApiVersion", "stateSchemaVersion", "responseProfiles", "persistence",
  "lifecycle", "resourceLimits", "metrics", "agentUpdates", "gatewayUpdate", "alerts", "detected", "providers"
]);
// GOLDEN DIFF (1.4.0 PR 4): taskRetentionMs joins lifecycle. A task's bytes now
// have their own retention, separate from its session's, because a completed
// handle must stay readable until its own TTL.
const LIFECYCLE_KEYS = sorted([
  "gcIntervalMs", "idleUnloadMs", "orphanGraceMs", "resultRetentionMs", "inboxRetentionMs",
  "sessionRetentionMs", "taskRetentionMs", "liveSessions"
]);
// GOLDEN DIFF (1.4.0 PR 4): healthy/error keep their names and meaning; the rest
// is additive durability diagnostics (state v5 snapshot + WAL).
const PERSISTENCE_KEYS = sorted([
  "healthy", "error", "stateSchemaVersion", "mode", "walSeq", "walBytes", "snapshotEpoch",
  "fsyncCount", "lastRecovery"
]);
// GOLDEN DIFF (1.4.0 PR 5): resourceLimits grows from 8 fields to 15. Every
// addition is a budget that was previously either absent or a literal buried in
// the code, and each one is a flat number because Main renders this object
// directly. Additive: nothing here was renamed or removed.
const RESOURCE_LIMIT_KEYS = sorted([
  "maxEvents", "maxTextBytes", "maxInlineResultBytes", "maxArtifactBytes", "maxArtifactTotalBytes",
  "maxTerminalsPerSession", "maxPendingRequestsPerSession", "maxFrameBytes",
  "maxQueueBytes", "writeTimeoutMs", "maxPromptBytes", "maxFileReadBytes",
  "maxTerminalOutputBytes", "maxSessionsPerRoot", "maxInboxHistoryPerRoot",
  "maxInboxItemBytes", "maxPendingInboxBytesPerSession", "maxPendingInboxBytesPerRoot"
]);
const METRICS_KEYS = sorted([
  "startedAt", "pollResponses", "pollBytes", "eventBytes", "resultBytes", "eventsByType"
]);
// publicInboxItem() fields: list returns the same record as get, and for a row
// under the payload cap that record is byte-identical to 1.3.2's.
const INBOX_ITEM_KEYS = sorted([
  "inboxId", "sessionId", "turnId", "type", "status", "createdAt", "resolvedAt", "resolution",
  "requestId", "toolCall", "options", "mode", "message", "requestedSchema", "toolCallId", "payloadBytes"
]);
// GOLDEN DIFF (1.4.0 PR 5, G4): a row whose tool call exceeded the 4000-byte
// payload cap gains these three, and only then. The truncation is now visible
// instead of the row silently holding a second copy of the whole payload.
const INBOX_TRUNCATED_ITEM_KEYS = sorted([
  ...INBOX_ITEM_KEYS, "toolCallTruncated", "toolCallBytes", "toolCallArtifact"
]);
// publicTask() fields.
// GOLDEN DIFF (1.4.0 PR 7, H6): origin says which tool minted the handle,
// "prompt" or "run". A declared +5.2% on task_get, and the only way tasks/list
// stays legible once two tools create handles; a recovered pre-1.4.0 record
// reads back as "prompt", which is what it necessarily was.
const TASK_KEYS = sorted([
  "taskId", "sessionId", "turnId", "status", "ttl", "pollInterval", "createdAt", "lastUpdatedAt",
  "statusMessage", "origin"
]);

test("characterization: prompt ack is exactly the accepted-turn envelope", async () => {
  const service = new GatewayService({ createClient: mockClientFactory("read_only"), gcIntervalMs: 0 });
  try {
    const opened = await openMockSession(service, "read_only");
    const ack = await service.call("prompt", { sessionId: opened.sessionId, prompt: "go" }, MAIN);
    assert.deepEqual(sorted(Object.keys(ack)), sorted(["ok", "sessionId", "turnId", "status"]));
    assert.equal(ack.ok, true);
    assert.equal(ack.sessionId, opened.sessionId);
    assert.equal(ack.status, "running");
    assert.match(ack.turnId, /^turn-/);
    await waitForIdle(service, opened.sessionId);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("characterization: default poll stays quiet on progress but delivers permission and terminal result", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = service.store.create({
      provider: "mock", acpSessionId: "quiet", cwd: "/", ownerRootId: "main-a",
      permissionPolicy: "ask", turnId: "turn-1"
    });
    session.status = "running";
    service.handleUpdate(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "progress " } });
    service.handleUpdate(session, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    service.handleUpdate(session, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", kind: "read" });

    const quiet = await service.call("poll", { sessionId: session.id, cursor: 0 }, MAIN);
    assert.deepEqual(quiet.events, []);
    assert.ok(quiet.filteredCount > 0, "the cursor still advances over filtered-out events");
    assert.equal(Object.hasOwn(quiet, "result"), false, "an active turn withholds the cumulative result");

    service.handleUpdate(session, {
      sessionUpdate: "permission_request",
      requestId: 7,
      toolCall: { toolCallId: "tool-2", title: "Edit file", kind: "edit" },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
    });
    const actionable = await service.call("poll", { sessionId: session.id, cursor: 0 }, MAIN);
    assert.deepEqual(actionable.events.map((event) => event.type), ["permission_request"]);
    assert.equal(Object.hasOwn(actionable, "result"), false);
  } finally {
    await service.shutdown().catch(() => {});
  }

  const live = new GatewayService({ createClient: mockClientFactory("read_only"), gcIntervalMs: 0 });
  try {
    const opened = await openMockSession(live, "read_only");
    await live.call("prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, MAIN);
    const done = await waitForIdle(live, opened.sessionId);
    assert.equal(Object.hasOwn(done, "result"), true, "a finished turn returns its result by default");
    assert.equal(done.result.text, "FINAL ANSWER");
  } finally {
    await live.shutdown().catch(() => {});
  }
});

test("characterization: poll response carries exactly the session envelope plus paging fields", async () => {
  const service = new GatewayService({ createClient: mockClientFactory("read_only"), gcIntervalMs: 0 });
  try {
    const active = service.store.create({
      provider: "mock", acpSessionId: "active", cwd: "/", ownerRootId: "main-a",
      permissionPolicy: "ask", turnId: "turn-1"
    });
    active.status = "running";
    const activePoll = await service.call("poll", { sessionId: active.id, cursor: 0 }, MAIN);
    assert.deepEqual(sorted(Object.keys(activePoll)), ACTIVE_POLL_KEYS);

    const opened = await openMockSession(service, "read_only");
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, MAIN);
    const done = await waitForIdle(service, opened.sessionId);
    assert.deepEqual(sorted(Object.keys(done)), TERMINAL_POLL_KEYS);
    assert.deepEqual(sorted(Object.keys(JSON.parse(JSON.stringify(done.result)))), WIRE_RESULT_KEYS);
    assert.equal(done.status, "idle");
    assert.equal(done.stopReason, "end_turn");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("characterization: setup reports gateway, API and state schema versions with a fixed field set", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const setup = await service.call("setup", {}, MAIN);
    assert.deepEqual(sorted(Object.keys(setup)), SETUP_KEYS);
    assert.equal(setup.ok, true);
    assert.equal(setup.gatewayVersion, GATEWAY_VERSION);
    assert.equal(setup.gatewayApiVersion, 1);
    assert.deepEqual(setup.responseProfiles, ["current", "compact", "diagnostic"]);
    // GOLDEN DIFF (1.4.0 PR 4): the persisted schema is v5 (snapshot + WAL). The
    // v4 state.json is still written alongside it as downgrade insurance, which is
    // why every other assertion about that file is unchanged.
    assert.equal(setup.stateSchemaVersion, 5);
    assert.deepEqual(sorted(Object.keys(setup.persistence)), PERSISTENCE_KEYS);
    assert.equal(setup.persistence.healthy, true);
    // No state path here, so there is nothing to be durable with.
    assert.equal(setup.persistence.mode, "disabled");
    assert.deepEqual(sorted(Object.keys(setup.lifecycle)), LIFECYCLE_KEYS);
    assert.deepEqual(sorted(Object.keys(setup.resourceLimits)), RESOURCE_LIMIT_KEYS);
    assert.deepEqual(sorted(Object.keys(setup.metrics)), METRICS_KEYS);
    assert.equal(setup.agentUpdates, null);
    assert.equal(setup.gatewayUpdate, null);
    assert.deepEqual(setup.alerts, []);
    assert.ok(Array.isArray(setup.detected) && setup.detected.length > 0);
    for (const item of setup.detected) {
      assert.equal(typeof item.id, "string");
      assert.equal(typeof item.agentInstalled, "boolean");
      assert.equal(typeof item.adapterInstalled, "boolean");
    }
    // Without an explicit provider, setup never starts one: it reports
    // detection only, with no per-provider capabilities.
    assert.equal(setup.providers.length, setup.detected.length);
    for (const item of setup.providers) {
      assert.deepEqual(sorted(Object.keys(item)), sorted(["provider", "ok", "started"]));
      assert.equal(item.started, false);
    }
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("characterization: inbox list returns the same full payload as inbox get", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-characterization-inbox-"));
  const service = new GatewayService({ gcIntervalMs: 0, artifactRoot: join(directory, "artifacts") });
  try {
    const session = service.store.create({
      provider: "mock", acpSessionId: "inbox", cwd: "/", ownerRootId: "main-a",
      permissionPolicy: "ask", turnId: "turn-1"
    });
    session.status = "running";
    const rawInput = "r".repeat(10_000);
    service.handleUpdate(session, {
      sessionUpdate: "permission_request",
      requestId: 11,
      toolCall: { toolCallId: "tool-big", title: "Edit file", kind: "edit", rawInput },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
    });

    // A second request whose tool call is comfortably under the cap: this row is
    // the one that must not have changed at all.
    service.handleUpdate(session, {
      sessionUpdate: "permission_request",
      requestId: 12,
      toolCall: { toolCallId: "tool-small", title: "Read file", kind: "read", rawInput: "small" },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
    });

    await waitForInboxCount(service, 2);
    const listed = await service.call("inbox", { action: "list" }, MAIN);
    assert.deepEqual(sorted(Object.keys(listed)), sorted(["ok", "items"]));
    assert.equal(listed.items.length, 2);
    const small = listed.items.find((row) => row.toolCall.toolCallId === "tool-small");
    const item = listed.items.find((row) => row.toolCall.toolCallId === "tool-big");
    // Unchanged from 1.3.2: an ordinary row is the full record, same key set.
    assert.deepEqual(sorted(Object.keys(small)), INBOX_ITEM_KEYS);
    assert.equal(small.toolCall.rawInput, "small");
    // GOLDEN DIFF (1.4.0 PR 5, G4): the oversized row keeps the head Main needs and
    // points at the artifact the event path already wrote, rather than carrying a
    // second full copy of a payload only that artifact is ever read for.
    assert.deepEqual(sorted(Object.keys(item)), INBOX_TRUNCATED_ITEM_KEYS);
    assert.equal(item.toolCall.rawInput, undefined);
    assert.equal(item.toolCallTruncated, true);
    assert.ok(item.toolCallBytes > rawInput.length);
    assert.equal(typeof item.toolCallArtifact.path, "string");
    const got = await service.call("inbox", { action: "get", inboxId: item.inboxId }, MAIN);
    assert.deepEqual(sorted(Object.keys(got)), sorted(["ok", "item"]));
    // Preserved: list is not a summary. Whatever get returns, list returned too —
    // and get returns the pointer rather than rehydrating the artifact.
    assert.deepEqual(item, got.item);
    assert.equal(item.status, "pending");
    assert.equal(item.type, "permission_request");
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("characterization: a completed task stays in memory and is never persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-characterization-task-"));
  const statePath = join(directory, "state.json");
  const service = new GatewayService({
    statePath,
    createClient: mockClientFactory("read_only"),
    gcIntervalMs: 0
  });
  try {
    await service.init();
    const opened = await openMockSession(service, "read_only");
    const task = await service.call(
      "task_prompt",
      { sessionId: opened.sessionId, prompt: "narrated-result", ttl: 60_000, pollInterval: 100 },
      MAIN
    );
    assert.deepEqual(sorted(Object.keys(task)), TASK_KEYS);
    assert.equal(task.status, "working");
    await waitForIdle(service, opened.sessionId);
    await service.flushPersist();

    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.version, 4);
    assert.deepEqual(saved.tasks, [], "terminal tasks are dropped from state.json");
    const got = await service.call("task_get", { taskId: task.taskId }, MAIN);
    assert.equal(got.status, "completed", "the terminal task is still readable in memory");
    assert.deepEqual(sorted(Object.keys(got)), TASK_KEYS);
    assert.equal((await service.call("task_result", { taskId: task.taskId }, MAIN)).result.text, "FINAL ANSWER");
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

// GOLDEN DIFF (1.4.0 PR 3, checklist section 2 / PR 3 and section 6 rule 3).
// 1.3.2 keyed task expiry off lastUpdatedAt, so every status touch bought the
// handle another full TTL and a chatty task could outlive its declared lifetime
// indefinitely. TaskStore anchors expiry to createdAt, which is the MCP contract
// (SDK spec: ttl is "requested duration in milliseconds to retain task from
// creation"). This test previously asserted the lastUpdatedAt behaviour; it now
// pins the createdAt behaviour, and it is the only characterization case PR 3
// rewrites.
test("characterization: task TTL expires from createdAt, and touching lastUpdatedAt cannot extend it", async () => {
  const epoch = Date.parse("2026-01-01T00:00:00.000Z");
  let clock = epoch;
  const service = new GatewayService({
    createClient: mockClientFactory("read_only"),
    gcIntervalMs: 0,
    now: () => clock
  });
  try {
    const opened = await openMockSession(service, "read_only");
    const task = await service.call(
      "task_prompt",
      { sessionId: opened.sessionId, prompt: "narrated-result", ttl: 60_000, pollInterval: 100 },
      MAIN
    );
    await waitForIdle(service, opened.sessionId);
    const record = service.tasks.get(task.taskId);
    assert.equal(record.status, "completed");
    assert.equal(record.createdAt, "2026-01-01T00:00:00.000Z");

    // The touch that used to buy another 60s. It moves lastUpdatedAt and nothing
    // else: createdAt is the immutable expiry anchor.
    record.lastUpdatedAt = new Date(epoch + 50_000).toISOString();
    clock = epoch + 59_999;
    assert.equal(
      (await service.call("task_get", { taskId: task.taskId }, MAIN)).status,
      "completed",
      "readable right up to createdAt+ttl"
    );
    assert.equal(service.tasks.get(task.taskId).lastUpdatedAt, new Date(epoch + 50_000).toISOString());

    // 1.3.2 kept this handle until lastUpdatedAt+ttl (epoch+110s).
    clock = epoch + 60_000;
    await assert.rejects(service.call("task_get", { taskId: task.taskId }, MAIN), (error) => {
      assert.match(error.message, /^Unknown taskId: /);
      assert.equal(error.code, "UNKNOWN_TASK");
      return true;
    });
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("conformance: task_result waits for terminal state and task_list keeps the legacy unpaged shape", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const createdAt = new Date().toISOString();
    service.tasks.set("task-fabricated", {
      taskId: "task-fabricated",
      sessionId: "acp-fabricated",
      ownerRootId: "main-a",
      turnId: "turn-1",
      status: "working",
      ttl: 60_000,
      pollInterval: 1_000,
      createdAt,
      lastUpdatedAt: createdAt,
      statusMessage: "Prompt running",
      result: null
    });

    await assert.rejects(service.call("task_result", { taskId: "task-fabricated", waitMs: 10 }, MAIN), (error) => {
      assert.match(error.message, /Timed out/);
      assert.equal(error.code, "WAIT_TIMEOUT");
      return true;
    });

    const listed = await service.call("task_list", {}, MAIN);
    assert.deepEqual(Object.keys(listed), ["tasks"], "task_list is unpaged in 1.3.2");
    assert.equal(listed.tasks.length, 1);
    assert.deepEqual(sorted(Object.keys(listed.tasks[0])), TASK_KEYS);
    assert.deepEqual((await service.call("task_list", {}, { rootId: "main-b" })).tasks, []);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("characterization: structured errors retain details and drop foreign codes", () => {
  const details = { method: "nope", retryable: false };
  assert.deepEqual(
    errorEnvelope(new GatewayError(ERROR_CODES.UNKNOWN_METHOD, "Unknown gateway method: nope", details)),
    {
      error: "Unknown gateway method: nope",
      errorCode: ERROR_CODES.UNKNOWN_METHOD,
      details
    }
  );
  assert.deepEqual(errorEnvelope(new Error("plain failure")), { error: "plain failure" });
  const nodeish = new Error("no such file or directory");
  nodeish.code = "ENOENT";
  assert.deepEqual(errorEnvelope(nodeish), { error: "no such file or directory" });
});

test("characterization: the socket error envelope carries a stable error code and details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-characterization-wire-"));
  let daemon = null;
  let main = null;
  let wrong = null;
  try {
    daemon = await startDaemon({ directory });
    main = new GatewayRpcClient({
      socketPath: daemon.socketPath,
      token: daemon.token,
      rootId: daemon.rootId,
      autoStart: false
    });
    await assert.rejects(main.call("nope"), (error) => {
      assert.equal(error.message, "Unknown gateway method: nope");
      assert.equal(error.code, "UNKNOWN_METHOD");
      assert.deepEqual(error.details, { method: "nope" });
      return true;
    });

    await assert.rejects(
      main.call("session_open", {
        provider: "claude",
        cwd: "/definitely-missing-acp-gateway-dir",
        permissionPolicy: "read_only"
      }),
      (error) => {
        assert.match(error.message, /ENOENT|no such file|Not a directory/i);
        assert.equal(error.code, undefined, "Node codes must not become wire errorCode");
        return true;
      }
    );

    wrong = new GatewayRpcClient({
      socketPath: daemon.socketPath,
      token: "wrong-control-token-at-least-24-chars",
      rootId: daemon.rootId,
      autoStart: false
    });
    await assert.rejects(wrong.call("session", { action: "list" }), (error) => {
      assert.equal(error.message, "Control access denied");
      assert.equal(error.code, "CONTROL_ACCESS_DENIED");
      assert.equal(Object.hasOwn(error, "details"), false);
      return true;
    });
  } finally {
    main?.close();
    wrong?.close();
    await daemon?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

function mockClientFactory(permissionPolicy) {
  return (_provider, options) =>
    new AcpClient(
      { provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy },
      options
    );
}

function openMockSession(service, permissionPolicy) {
  return service.call(
    "session_open",
    { provider: "claude", cwd: process.cwd(), permissionPolicy },
    MAIN
  );
}

function sorted(keys) {
  return [...keys].sort();
}

async function waitForIdle(service, sessionId) {
  let cursor = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const poll = await service.call("poll", { sessionId, cursor, waitMs: 100 }, MAIN);
    cursor = poll.nextCursor;
    if (poll.status === "idle") return poll;
    if (["error", "unavailable"].includes(poll.status)) throw new Error(poll.error);
  }
  throw new Error("Gateway session did not become idle");
}

async function waitForInboxCount(service, expected) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const inbox = await service.call("inbox", { action: "list", status: "pending" }, MAIN);
    if (inbox.items.length === expected) return inbox.items;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Gateway inbox did not reach ${expected} pending items`);
}
