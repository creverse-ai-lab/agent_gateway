import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { GatewayService, sanitizeWorkerMcpServers } from "../src/gateway-service.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const capabilityAgent = fileURLToPath(new URL("./mock-capability-agent.js", import.meta.url));

test("Gateway setup exposes ACP update health alerts and supports a fresh check", async () => {
  let refreshCalls = 0;
  let stopped = false;
  const agentUpdateManager = {
    start() {},
    stop() { stopped = true; },
    async refresh() { refreshCalls += 1; },
    snapshot() {
      return {
        enabled: true,
        status: "ready",
        alerts: [{ level: "info", code: "acp_agents_auto_updated", message: "updated" }]
      };
    }
  };
  const service = new GatewayService({ agentUpdateManager });
  try {
    await service.init();
    const health = await service.call("setup", { refreshAgentUpdates: true }, { rootId: "main-a" });
    assert.equal(refreshCalls, 1);
    assert.equal(health.agentUpdates.status, "ready");
    assert.equal(health.alerts[0].code, "acp_agents_auto_updated");
  } finally {
    await service.shutdown();
    assert.equal(stopped, true);
  }
});

test("Gateway isolates Main ownership, persists sessions, and resumes them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-test-"));
  const statePath = join(directory, "state.json");
  const makeClient = (_provider, options) =>
    new AcpClient(
      {
        provider: "mock",
        command: process.execPath,
        args: [mockAgent],
        permissionPolicy: "ask"
      },
      options
    );
  let service = new GatewayService({ statePath, createClient: makeClient });
  try {
    await service.init();
    const opened = await service.call(
      "session_open",
      { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" },
      { rootId: "main-a" }
    );
    assert.equal((await service.call("session", { action: "list" }, { rootId: "main-b" })).sessions.length, 0);
    await assert.rejects(
      service.call("prompt", { sessionId: opened.sessionId, prompt: "go" }, { rootId: "main-b" }),
      /another Main/
    );

    await service.call("prompt", { sessionId: opened.sessionId, prompt: "go" }, { rootId: "main-a" });
    const first = await waitForIdle(service, opened.sessionId);
    assert.equal(first.result.text, "READY DENIED");
    await service.shutdown();

    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.sessions[0].ownerRootId, "main-a");

    service = new GatewayService({ statePath, createClient: makeClient });
    await service.init();
    const restoredList = await service.call("session", { action: "list" }, { rootId: "main-a" });
    assert.equal(restoredList.sessions[0].status, "disconnected");
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "again" }, { rootId: "main-a" });
    const second = await waitForIdle(service, opened.sessionId);
    assert.equal(second.result.text, "READY DENIED");
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway poll omits the cumulative result object when includeResult is false", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "go" }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
    const withResult = await service.call("poll", { sessionId: opened.sessionId, cursor: 0 }, { rootId: "main-a" });
    assert.equal(withResult.result.text, "READY DENIED");
    const withoutResult = await service.call(
      "poll",
      { sessionId: opened.sessionId, cursor: 0, includeResult: false },
      { rootId: "main-a" }
    );
    assert.equal(Object.hasOwn(withoutResult, "result"), false);
    assert.deepEqual(withoutResult.events, []);
    assert.equal(typeof withoutResult.nextCursor, "number");
    assert.equal(withoutResult.status, "idle");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway poll withholds the cumulative result while the turn is active", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "go" }, { rootId: "main-a" });
    const waiting = await waitForStatus(service, opened.sessionId, "waiting_permission");
    assert.equal(Object.hasOwn(waiting, "result"), false);
    const explicit = await service.call(
      "poll",
      { sessionId: opened.sessionId, cursor: 0, includeResult: true },
      { rootId: "main-a" }
    );
    assert.equal(explicit.result.text, "READY ");
    const request = waiting.events.find((event) => event.type === "permission_request")
      ?? explicit.events.find((event) => event.type === "permission_request");
    await service.call(
      "permission",
      { sessionId: opened.sessionId, requestId: request.requestId, optionId: "allow-once" },
      { rootId: "main-a" }
    );
    const done = await waitForIdle(service, opened.sessionId);
    assert.equal(done.result.text, "DONE");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway poll excludes tool_call events unless requested and caps oversized event data by UTF-8 bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-event-artifact-"));
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({ createClient: makeClient, artifactRoot: join(directory, "artifacts") });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "tool-events" }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
    const withoutTools = await service.call("poll", { sessionId: opened.sessionId, cursor: 0 }, { rootId: "main-a" });
    assert.equal(withoutTools.events.some((event) => event.type.startsWith("tool_call")), false);
    const withTools = await service.call(
      "poll",
      { sessionId: opened.sessionId, cursor: 0, includeToolEvents: true },
      { rootId: "main-a" }
    );
    const small = withTools.events.find((event) => event.type === "tool_call");
    assert.equal(small.data.toolCallId, "tool-small");
    assert.equal(small.dataTruncated, undefined);
    // 3,000 Korean chars serialize to ~9KB: a character-based cap would keep
    // the full payload; the byte-based cap must truncate and spill it.
    const large = withTools.events.find((event) => event.type === "tool_call_update");
    assert.equal(large.dataTruncated, true);
    assert.equal(Object.hasOwn(large, "data"), false);
    assert.ok(Buffer.byteLength(large.text) <= 4000);
    assert.doesNotMatch(large.text, /�/);
    assert.equal(large.dataArtifact.complete, true);
    assert.equal(large.dataArtifact.truncated, false);
    const spilled = JSON.parse(await readFile(large.dataArtifact.path, "utf8"));
    assert.equal(spilled.toolCallId, "tool-large");
    assert.equal(spilled.rawOutput, "가".repeat(3_000));
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway separates the final answer from narration segments", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, { rootId: "main-a" });
    const done = await waitForIdle(service, opened.sessionId);
    assert.equal(done.result.text, "FINAL ANSWER");
    assert.equal(done.result.transcriptBytes, Buffer.byteLength("Working on it. Still checking. FINAL ANSWER"));
    assert.equal(Object.hasOwn(done.result, "inspection"), false);
    const inspected = await service.call(
      "poll",
      { sessionId: opened.sessionId, cursor: 999_999, includeInspection: true },
      { rootId: "main-a" }
    );
    assert.deepEqual(inspected.result.inspection.map((segment) => segment.text), ["Working on it. ", "Still checking. "]);
    assert.equal(inspected.result.inspection[0].boundary, "tool_call");
    const summary = await service.call("session", { action: "get", sessionId: opened.sessionId }, { rootId: "main-a" });
    assert.equal(Object.hasOwn(summary, "resultText"), false);
    assert.equal(summary.transcriptBytes, Buffer.byteLength("Working on it. Still checking. FINAL ANSWER"));
    assert.equal(summary.finalResultText, "FINAL ANSWER");
    const detail = await service.call(
      "session",
      { action: "get", sessionId: opened.sessionId, includeTranscript: true },
      { rootId: "main-a" }
    );
    assert.equal(detail.resultText, "Working on it. Still checking. FINAL ANSWER");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway keeps every narration part when a multi-segment turn ends on tool work", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "multi-narration-tool-end" }, { rootId: "main-a" });
    const done = await waitForIdle(service, opened.sessionId);
    assert.equal(done.result.text, "Part A important. Part B progress.");
    const inspected = await service.call(
      "poll",
      { sessionId: opened.sessionId, cursor: 999_999, includeInspection: true },
      { rootId: "main-a" }
    );
    assert.deepEqual(
      inspected.result.inspection.map((segment) => segment.text),
      ["Part A important. ", "Part B progress."]
    );
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway caps inline finals and points mid-sized narration at artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-inline-cap-"));
  const service = new GatewayService({
    gcIntervalMs: 0,
    maxInlineResultBytes: 64,
    artifactRoot: join(directory, "artifacts")
  });
  try {
    const session = service.store.create({
      provider: "mock", acpSessionId: "cap-test", cwd: "/", ownerRootId: "main-a",
      permissionPolicy: "ask", turnId: "turn-1"
    });
    session.status = "running";
    const narration = `narration ${"n".repeat(5_000)}`;
    service.handleUpdate(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: narration } });
    service.handleUpdate(session, { sessionUpdate: "tool_call", toolCallId: "tool-x", title: "Read", kind: "read" });
    const finalText = `final ${"f".repeat(200)}`;
    service.handleUpdate(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: finalText } });
    session.status = "idle";
    session.stopReason = "end_turn";
    service.store.finalizeResult(session);
    const poll = await service.call(
      "poll",
      { sessionId: session.id, cursor: 999_999, includeInspection: true },
      { rootId: "main-a" }
    );
    assert.ok(Buffer.byteLength(poll.result.text) <= 64);
    assert.equal(poll.result.textArtifact.complete, true);
    assert.equal(await readFile(poll.result.textArtifact.path, "utf8"), finalText);
    const segment = poll.result.inspection[0];
    assert.equal(segment.truncated, true);
    assert.ok(Buffer.byteLength(segment.text) <= 4000);
    assert.equal(segment.artifact.complete, true);
    assert.equal(await readFile(segment.artifact.path, "utf8"), narration);
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway falls back to the transcript when a turn ends without a final message segment", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "tool-then-end" }, { rootId: "main-a" });
    const done = await waitForIdle(service, opened.sessionId);
    assert.equal(done.result.text, "ONLY NARRATION");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway task result returns only the final answer segment", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" });
    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
    const result = await service.call("task_result", { taskId: task.taskId }, { rootId: "main-a" });
    assert.equal(result.result.text, "FINAL ANSWER");
    assert.equal(result.result.transcriptBytes, Buffer.byteLength("Working on it. Still checking. FINAL ANSWER"));
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway poll defaults to terminal results and ignores progress or usage updates", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = service.store.create({
      provider: "mock", acpSessionId: "wake-test", cwd: "/", ownerRootId: "main-a",
      permissionPolicy: "ask", turnId: "turn-1"
    });
    session.status = "running";
    const startedAt = Date.now();
    const pending = service.call("poll", { sessionId: session.id, waitMs: 5_000 }, { rootId: "main-a" });
    setTimeout(() => {
      service.handleUpdate(session, { sessionUpdate: "tool_call", toolCallId: "noisy", title: "Read", kind: "read" });
    }, 30);
    setTimeout(() => {
      service.handleUpdate(session, { sessionUpdate: "usage_update", usage: { inputTokens: 10, outputTokens: 5 } });
    }, 120);
    setTimeout(() => {
      service.handleUpdate(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "progress" } });
    }, 210);
    setTimeout(() => {
      service.handleUpdate(session, {
        sessionUpdate: "permission_request",
        requestId: 7,
        toolCall: { toolCallId: "need-input", title: "Edit", kind: "edit" },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
      });
    }, 300);
    const response = await pending;
    assert.ok(Date.now() - startedAt >= 250, "progress and usage must not wake the default poll");
    assert.deepEqual(response.events.map((event) => event.type), ["permission_request"]);
    assert.equal(session.events.some((event) => event.type === "usage_update"), false);

    const filteredOnly = service.call(
      "poll",
      { sessionId: session.id, cursor: response.nextCursor, waitMs: 300 },
      { rootId: "main-a" }
    );
    setTimeout(() => {
      service.handleUpdate(session, { sessionUpdate: "tool_call", toolCallId: "noisy-2", title: "Read", kind: "read" });
    }, 30);
    const quietStart = Date.now();
    const quiet = await filteredOnly;
    assert.ok(Date.now() - quietStart >= 250, "poll should sleep through filtered-out events");
    assert.deepEqual(quiet.events, []);

    const explicitMessages = await service.call(
      "poll",
      { sessionId: session.id, cursor: 0, eventTypes: ["agent_message_chunk"] },
      { rootId: "main-a" }
    );
    assert.deepEqual(explicitMessages.events.map((event) => event.text), ["progress"]);

    // A status change without any new event must still wake a filtered poll.
    const statusWatch = service.call(
      "poll",
      { sessionId: session.id, cursor: quiet.nextCursor, waitMs: 5_000, eventTypes: ["never_matches"] },
      { rootId: "main-a" }
    );
    setTimeout(() => {
      session.status = "idle";
      service.store.notifyWaiters(session);
    }, 30);
    const statusStart = Date.now();
    const woke = await statusWatch;
    assert.ok(Date.now() - statusStart < 4_000);
    assert.equal(woke.status, "idle");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway final segment survives mid-answer progress updates and thoughts", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = service.store.create({
      provider: "mock", acpSessionId: "mid-answer", cwd: "/", ownerRootId: "main-a",
      permissionPolicy: "ask", turnId: "turn-1"
    });
    session.status = "running";
    service.handleUpdate(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer is " } });
    service.handleUpdate(session, { sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress" });
    service.handleUpdate(session, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    service.handleUpdate(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "42" } });
    session.status = "idle";
    session.stopReason = "end_turn";
    service.store.finalizeResult(session);
    const poll = await service.call("poll", { sessionId: session.id, cursor: 999_999 }, { rootId: "main-a" });
    assert.equal(poll.result.text, "Answer is 42");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway retention spares active turns and session-referenced artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-retention-"));
  const service = new GatewayService({
    gcIntervalMs: 0,
    resultRetentionMs: 60_000,
    maxInlineResultBytes: 32,
    artifactRoot: join(directory, "artifacts")
  });
  try {
    const active = service.store.create({
      provider: "mock", acpSessionId: "active", cwd: "/", ownerRootId: "main-a",
      permissionPolicy: "ask", turnId: "turn-2"
    });
    active.status = "running";
    active.completedAt = new Date(Date.now() - 3_600_000).toISOString();
    service.store.appendResultText(active, "live turn text");

    const finished = service.store.create({
      provider: "mock", acpSessionId: "finished", cwd: "/", ownerRootId: "main-a",
      permissionPolicy: "ask", turnId: "turn-1"
    });
    finished.status = "idle";
    service.store.appendResultText(finished, `final ${"x".repeat(200)}`);
    service.store.finalizeResult(finished);
    const referenced = finished.resultFinalArtifact.path;
    const loose = service.store.spillText("loose-session", "final", "unreferenced").path;

    const future = Date.now() + 3_600_000;
    await service.runMaintenance(future);
    assert.equal(active.resultText, "live turn text", "active turn must not be cleared");
    assert.equal(existsSync(referenced), true, "referenced artifact must survive prune");
    assert.equal(existsSync(loose), false, "unreferenced artifact should be pruned");

    active.status = "idle";
    await service.runMaintenance(future);
    assert.equal(active.resultText, "", "idle expired turn is cleared");
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway caps chunk and permission payload copies while keeping full data recoverable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-payload-cap-"));
  const service = new GatewayService({ gcIntervalMs: 0, artifactRoot: join(directory, "artifacts") });
  try {
    const session = service.store.create({
      provider: "mock", acpSessionId: "payload", cwd: "/", ownerRootId: "main-a",
      permissionPolicy: "ask", turnId: "turn-1"
    });
    session.status = "running";
    const hugeChunk = `chunk ${"c".repeat(10_000)}`;
    service.handleUpdate(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: hugeChunk } });
    service.handleUpdate(session, {
      sessionUpdate: "permission_request",
      requestId: 7,
      toolCall: { toolCallId: "tool-big", title: "Edit file", kind: "edit", rawInput: "r".repeat(10_000) },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
    });
    const poll = await service.call(
      "poll",
      {
        sessionId: session.id,
        cursor: 0,
        includeResult: false,
        eventTypes: ["agent_message_chunk", "permission_request"]
      },
      { rootId: "main-a" }
    );
    const chunk = poll.events.find((event) => event.type === "agent_message_chunk");
    assert.ok(Buffer.byteLength(chunk.text) <= 4000);
    assert.equal(chunk.textTruncated, true);
    const permission = poll.events.find((event) => event.type === "permission_request");
    assert.equal(permission.toolCallTruncated, true);
    assert.deepEqual(permission.toolCall, { toolCallId: "tool-big", title: "Edit file", kind: "edit" });
    assert.equal(JSON.parse(await readFile(permission.dataArtifact.path, "utf8")).rawInput.length, 10_000);
    assert.deepEqual(permission.options, [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]);
    const inbox = await service.call("inbox", { action: "list", status: "pending" }, { rootId: "main-a" });
    assert.equal(inbox.items[0].toolCall.rawInput.length, 10_000, "inbox keeps the full tool call");
    const detail = await service.call(
      "session",
      { action: "get", sessionId: session.id, includeTranscript: true },
      { rootId: "main-a" }
    );
    assert.equal(detail.resultText, hugeChunk, "transcript keeps the full chunk text");
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway poll supports bounded retrospective reads by cursor range and event type", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-range-"));
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({ createClient: makeClient, artifactRoot: join(directory, "artifacts") });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "tool-events" }, { rootId: "main-a" });
    const done = await waitForIdle(service, opened.sessionId);
    const exact = await service.call(
      "poll",
      { sessionId: opened.sessionId, cursor: 0, toCursor: done.nextCursor, eventTypes: ["tool_call"], waitMs: 5_000 },
      { rootId: "main-a" }
    );
    assert.deepEqual(exact.events.map((event) => event.type), ["tool_call"]);
    const evidence = await service.call(
      "poll",
      { sessionId: opened.sessionId, cursor: 0, toCursor: done.nextCursor, eventTypes: ["tool_call*"] },
      { rootId: "main-a" }
    );
    assert.deepEqual(
      evidence.events.map((event) => event.type),
      ["tool_call", "tool_call_update"]
    );
    assert.ok(evidence.filteredCount > 0);
    const messages = await service.call(
      "poll",
      { sessionId: opened.sessionId, cursor: 0, toCursor: done.nextCursor, eventTypes: ["agent_message_chunk"] },
      { rootId: "main-a" }
    );
    assert.ok(messages.events.some((event) => event.type === "agent_message_chunk"));
    await assert.rejects(
      service.call("poll", { sessionId: opened.sessionId, eventTypes: [] }, { rootId: "main-a" }),
      /eventTypes must be/
    );
    await assert.rejects(
      service.call("poll", { sessionId: opened.sessionId, toCursor: "nope" }, { rootId: "main-a" }),
      /toCursor must be/
    );
    await assert.rejects(
      service.call("poll", { sessionId: opened.sessionId, cursor: "NaN" }, { rootId: "main-a" }),
      /cursor must be/
    );
    await assert.rejects(
      service.call("poll", { sessionId: opened.sessionId, cursor: 1.5 }, { rootId: "main-a" }),
      /cursor must be/
    );
    await assert.rejects(
      service.call("poll", { sessionId: opened.sessionId, eventTypes: ["*"] }, { rootId: "main-a" }),
      /wildcard entries/
    );
    assert.throws(
      () => service.subscribe(
        { sessionIds: [opened.sessionId], cursors: { [opened.sessionId]: "bogus" } },
        { rootId: "main-a" },
        () => {}
      ),
      /must be a non-negative integer/
    );
    const detail = await service.call(
      "session",
      { action: "get", sessionId: opened.sessionId, includeEvents: true },
      { rootId: "main-a" }
    );
    assert.ok(detail.events.length > 0);
    assert.equal(detail.events.some((event) => Object.hasOwn(event, "data")), false);
    const replay = service.subscribe({ sessionIds: [opened.sessionId] }, { rootId: "main-a" }, () => {});
    assert.equal(replay.events.some((event) => event.type.startsWith("tool_call")), false);
    service.unsubscribe(replay.subscriptionId, { rootId: "main-a" });
    const replayWithTools = service.subscribe(
      { sessionIds: [opened.sessionId], includeToolEvents: true },
      { rootId: "main-a" },
      () => {}
    );
    assert.equal(replayWithTools.events.some((event) => event.type.startsWith("tool_call")), true);
    service.unsubscribe(replayWithTools.subscriptionId, { rootId: "main-a" });
    const metrics = (await service.call("setup", {}, { rootId: "main-a" })).metrics;
    assert.ok(metrics.pollResponses > 0);
    assert.ok(metrics.pollBytes > 0);
    assert.ok(metrics.eventsByType.agent_message_chunk >= 1);
    assert.ok(metrics.eventsByType.tool_call >= 1);
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway poll returns a complete artifact for an oversized worker result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-artifact-"));
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({
    createClient: makeClient,
    maxTextBytes: 24,
    artifactRoot: join(directory, "artifacts")
  });
  try {
    const opened = await service.call(
      "session_open",
      { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" },
      { rootId: "main-a" }
    );
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "large-result" }, { rootId: "main-a" });
    const poll = await waitForIdle(service, opened.sessionId);
    assert.equal(poll.result.artifact.complete, true);
    assert.equal(poll.result.artifact.truncated, false);
    assert.equal(await readFile(poll.result.artifact.path, "utf8"), "가나다".repeat(32));
    // The memory buffer only held a 24-byte tail, but the inline final is
    // re-read from the spill so it is the head of the actual answer.
    assert.equal(poll.result.text, "가나다".repeat(32));
    assert.equal(poll.result.textArtifact.complete, true);
    assert.equal(poll.result.textArtifact.truncated, false);
    assert.equal(await readFile(poll.result.textArtifact.path, "utf8"), "가나다".repeat(32));
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway rejects recursive Control MCP injection", () => {
  assert.throws(
    () => sanitizeWorkerMcpServers([{ name: "agent-acp", command: "acp-gateway-control" }]),
    /cannot be injected/
  );
  assert.deepEqual(sanitizeWorkerMcpServers([{ name: "project-guide", command: "guide-mcp" }]), [
    { name: "project-guide", command: "guide-mcp" }
  ]);
  assert.deepEqual(
    sanitizeWorkerMcpServers([{ name: "agent-acp-guide", command: "acp-gateway-guide" }]),
    [{ name: "agent-acp-guide", command: "acp-gateway-guide" }]
  );
});

test("Main selects the worker model through the ACP session config", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call(
      "session_open",
      { provider: "claude", cwd: process.cwd(), model: "mock-pro", permissionPolicy: "read_only" },
      { rootId: "main-a" }
    );
    assert.equal(opened.model, "mock-pro");
    assert.equal(
      opened.capabilities.configOptions.find((option) => option.category === "model").currentValue,
      "mock-pro"
    );
    assert.equal((await service.call("session", { action: "get", sessionId: opened.sessionId }, { rootId: "main-a" })).model, "mock-pro");
    await service.call("prompt", {
      sessionId: opened.sessionId,
      model: "mock-default",
      prompt: "switch model before this turn"
    }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
    assert.equal((await service.call("session", { action: "get", sessionId: opened.sessionId }, { rootId: "main-a" })).model, "mock-default");
    service.requireSession(opened.sessionId).client.config.modelScope = "process";
    await assert.rejects(
      service.call("prompt", { sessionId: opened.sessionId, model: "mock-pro", prompt: "invalid process switch" }, { rootId: "main-a" }),
      /open a new session/
    );
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Main lists and controls Worker-advertised session parameters", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call(
      "session_open",
      { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" },
      { rootId: "main-a" }
    );
    const listed = await service.call(
      "config",
      { action: "list", sessionId: opened.sessionId },
      { rootId: "main-a" }
    );
    assert.deepEqual(listed.configOptions.map((option) => option.id), ["model", "thought_level", "auto_compact"]);

    const thought = await service.call(
      "config",
      { action: "set", sessionId: opened.sessionId, configId: "thought_level", value: "high" },
      { rootId: "main-a" }
    );
    assert.equal(thought.changed.value, "high");
    assert.equal(thought.configOptions.find((option) => option.id === "thought_level").currentValue, "high");

    const compact = await service.call(
      "config",
      { action: "set", sessionId: opened.sessionId, configId: "auto_compact", value: true },
      { rootId: "main-a" }
    );
    assert.equal(compact.configOptions.find((option) => option.id === "auto_compact").currentValue, true);

    await service.call(
      "config",
      { action: "set", sessionId: opened.sessionId, configId: "model", value: "mock-pro" },
      { rootId: "main-a" }
    );
    const inspected = await service.call(
      "session",
      { action: "get", sessionId: opened.sessionId, includeEvents: true },
      { rootId: "main-a" }
    );
    assert.equal(inspected.model, "mock-pro");
    assert.equal(inspected.events.filter((event) => event.type === "config_changed").length, 3);

    await assert.rejects(
      service.call("config", {
        action: "set",
        sessionId: opened.sessionId,
        configId: "thought_level",
        value: "extreme"
      }, { rootId: "main-a" }),
      /expected one of/
    );
    await assert.rejects(
      service.call("config", {
        action: "set",
        sessionId: opened.sessionId,
        configId: "auto_compact",
        value: "true"
      }, { rootId: "main-a" }),
      /boolean value/
    );
    await assert.rejects(
      service.call("config", { action: "list", sessionId: opened.sessionId }, { rootId: "main-b" }),
      /another Main/
    );
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway waits for provider initialization before sharing a client", async () => {
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  let createdClients = 0;
  let sessionCounter = 0;
  let initialized = false;
  let prematureSessionCalls = 0;
  const fakeClient = {
    config: { modelScope: "session" },
    alive: false,
    initResult: null,
    stderr: "",
    async start() {
      this.alive = true;
      await startGate;
      initialized = true;
      this.initResult = { protocolVersion: 1, agentCapabilities: {} };
      return this.initResult;
    },
    async sessionNew() {
      if (!initialized) prematureSessionCalls += 1;
      return { sessionId: `delayed-${++sessionCounter}` };
    },
    onSessionUpdate() {},
    clearSession() {},
    async stop() { this.alive = false; }
  };
  const service = new GatewayService({
    createClient: () => {
      createdClients += 1;
      return fakeClient;
    }
  });
  try {
    const first = service.call("session_open", { provider: "claude", cwd: process.cwd() }, { rootId: "main-a" });
    while (!fakeClient.alive) await new Promise((resolve) => setImmediate(resolve));
    const second = service.call("session_open", { provider: "claude", cwd: process.cwd() }, { rootId: "main-a" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prematureSessionCalls, 0);
    releaseStart();
    const opened = await Promise.all([first, second]);
    assert.equal(createdClients, 1);
    assert.equal(prematureSessionCalls, 0);
    assert.equal(new Set(opened.map((item) => item.sessionId)).size, 2);
  } finally {
    releaseStart();
    await service.shutdown().catch(() => {});
  }
});

test("Gateway keeps task handles in memory but persists only a minimal resume checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-task-"));
  const statePath = join(directory, "state.json");
  const makeClient = (_provider, options) =>
    new AcpClient(
      { provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" },
      options
    );
  const service = new GatewayService({ statePath, createClient: makeClient });
  try {
    await service.init();
    const opened = await service.call(
      "session_open",
      { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" },
      { rootId: "main-a" }
    );
    const task = await service.call(
      "task_prompt",
      { sessionId: opened.sessionId, prompt: "go", ttl: 60_000, pollInterval: 100 },
      { rootId: "main-a" }
    );
    assert.equal(task.status, "working");
    assert.equal(task.sessionId, opened.sessionId);
    assert.match(task.turnId, /^turn-/);
    await waitForStatus(service, opened.sessionId, "waiting_permission");
    assert.equal((await service.call("task_get", { taskId: task.taskId }, { rootId: "main-a" })).status, "input_required");
    const pendingInbox = await service.call("inbox", { action: "list", status: "pending" }, { rootId: "main-a" });
    assert.equal(pendingInbox.items.length, 1);
    assert.equal(pendingInbox.items[0].sessionId, opened.sessionId);
    assert.equal(pendingInbox.items[0].type, "permission_request");
    await service.call(
      "permission",
      { sessionId: opened.sessionId, requestId: 100, optionId: "allow-once" },
      { rootId: "main-a" }
    );
    await waitForIdle(service, opened.sessionId);
    assert.equal((await service.call("inbox", { action: "list", status: "answered" }, { rootId: "main-a" })).items.length, 1);
    assert.equal((await service.call("task_get", { taskId: task.taskId }, { rootId: "main-a" })).status, "completed");
    assert.equal((await service.call("task_result", { taskId: task.taskId }, { rootId: "main-a" })).result.text, "DONE");
    await service.flushPersist();
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.version, 4);
    assert.deepEqual(saved.tasks, []);
    assert.deepEqual(saved.inbox, []);
    assert.equal(saved.sessions[0].acpSessionId, opened.acpSessionId);
    assert.equal(saved.sessions[0].ownerRootId, "main-a");
    assert.equal(Object.hasOwn(saved.sessions[0], "events"), false);
    assert.equal(Object.hasOwn(saved.sessions[0], "resultText"), false);
    assert.equal(Object.hasOwn(saved.sessions[0], "thoughtText"), false);
    await assert.rejects(service.call("task_get", { taskId: task.taskId }, { rootId: "main-b" }), /another Main/);
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway maintenance unloads idle sessions and deletes expired transient state", async () => {
  let clock = Date.now();
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({
    createClient: makeClient,
    gcIntervalMs: 0,
    idleUnloadMs: 10,
    resultRetentionMs: 20,
    inboxRetentionMs: 20,
    sessionRetentionMs: 30,
    now: () => clock
  });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "go" }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
    const session = service.requireSession(opened.sessionId);
    const inbox = service.createPermissionInbox(session, { requestId: 77, toolCall: {}, options: [] });
    service.resolveInbox(session, 77, "answered", "done");

    clock += 11;
    await service.runMaintenance();
    assert.equal(session.status, "disconnected");
    assert.equal(session.client, null);
    assert.notEqual(session.resultText, "");

    clock += 10;
    await service.runMaintenance();
    assert.equal(session.resultText, "");
    assert.deepEqual(session.events, []);
    assert.equal(service.inbox.has(inbox.inboxId), false);

    clock += 10;
    await service.runMaintenance();
    assert.equal(service.store.get(opened.sessionId), undefined);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway pinning exempts a session from automatic unload and deletion", async () => {
  let clock = Date.now();
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({
    createClient: makeClient,
    gcIntervalMs: 0,
    idleUnloadMs: 1,
    resultRetentionMs: 1,
    sessionRetentionMs: 1,
    now: () => clock
  });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only", pinned: true }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "go" }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
    clock += 10;
    await service.runMaintenance();
    const session = service.requireSession(opened.sessionId);
    assert.equal(session.pinned, true);
    assert.equal(session.client.alive, true);
    assert.notEqual(session.resultText, "");
    assert.equal((await service.call("session", { action: "unpin", sessionId: opened.sessionId }, { rootId: "main-a" })).pinned, false);
    await service.runMaintenance();
    assert.equal(service.store.get(opened.sessionId), undefined);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway keeps a non-resumable provider live until final session retention expires", async () => {
  let clock = Date.now();
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({
    createClient: makeClient,
    gcIntervalMs: 0,
    idleUnloadMs: 0,
    sessionRetentionMs: 10,
    now: () => clock
  });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "write" }, { rootId: "main-a" });
    await waitForStatus(service, opened.sessionId, "idle");
    await service.runMaintenance();
    assert.equal(service.requireSession(opened.sessionId).client.alive, true);
    clock += 11;
    await service.runMaintenance();
    assert.equal(service.store.get(opened.sessionId), undefined);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway cancels abandoned active sessions after the owner grace period without requiring disconnect", async () => {
  let clock = Date.now();
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "auto_approve" }, options);
  const service = new GatewayService({ createClient: makeClient, gcIntervalMs: 0, orphanGraceMs: 10, now: () => clock });
  try {
    service.attachRoot("main-a");
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "auto_approve" }, { rootId: "main-a" });
    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "long-terminal" }, { rootId: "main-a" });
    await waitForTerminalCount(service, opened.sessionId, 1);
    clock += 11;
    await service.runMaintenance();
    await waitForStatus(service, opened.sessionId, "cancelled");
    assert.equal(service.requireSession(opened.sessionId).client.terminals.size, 0);
    assert.equal((await service.call("task_get", { taskId: task.taskId }, { rootId: "main-a" })).status, "cancelled");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway clears the orphan lease when Main reconnects before grace expires", async () => {
  let clock = Date.now();
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "auto_approve" }, options);
  const service = new GatewayService({ createClient: makeClient, gcIntervalMs: 0, orphanGraceMs: 10, now: () => clock });
  try {
    service.attachRoot("main-a");
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "auto_approve" }, { rootId: "main-a" });
    await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "long-terminal" }, { rootId: "main-a" });
    await waitForTerminalCount(service, opened.sessionId, 1);
    service.detachRoot("main-a");
    assert.notEqual(service.requireSession(opened.sessionId).orphanedAt, null);
    clock += 9;
    service.attachRoot("main-a");
    assert.equal(service.requireSession(opened.sessionId).orphanedAt, null);
    clock += 2;
    await service.runMaintenance();
    assert.notEqual(service.requireSession(opened.sessionId).status, "cancelling");

    service.detachRoot("main-a");
    clock += 11;
    await service.runMaintenance();
    await waitForStatus(service, opened.sessionId, "cancelled");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway subscription replays cursor events, pushes updates, and enforces ownership", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient(
      { provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" },
      options
    );
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call(
      "session_open",
      { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" },
      { rootId: "main-a" }
    );
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "go" }, { rootId: "main-a" });
    await waitForStatus(service, opened.sessionId, "waiting_permission");

    const pushed = [];
    const subscription = service.subscribe(
      { sessionIds: [opened.sessionId], cursors: { [opened.sessionId]: 0 } },
      { rootId: "main-a" },
      (event) => pushed.push(event)
    );
    assert.ok(subscription.events.some((event) => event.type === "turn_start"));
    assert.ok(subscription.events.some((event) => event.type === "permission_request"));
    assert.throws(
      () => service.subscribe({ sessionIds: [opened.sessionId] }, { rootId: "main-b" }, () => {}),
      /another Main/
    );

    await service.call(
      "permission",
      { sessionId: opened.sessionId, requestId: 100, optionId: "allow-once" },
      { rootId: "main-a" }
    );
    await waitForIdle(service, opened.sessionId);
    assert.ok(pushed.some((event) => event.type === "permission_response"));
    assert.ok(pushed.some((event) => event.type === "turn_end"));
    assert.equal(service.unsubscribe(subscription.subscriptionId, { rootId: "main-a" }).removed, true);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway watch-all subscriptions include sessions opened later", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const pushed = [];
    service.subscribe({}, { rootId: "main-a" }, (event) => pushed.push(event));
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "go" }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
    assert.ok(pushed.some((event) => event.sessionId === opened.sessionId && event.type === "turn_start"));
    assert.ok(pushed.some((event) => event.sessionId === opened.sessionId && event.type === "turn_end"));
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway preserves historical turn IDs and reports truncated subscription cursors", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({ createClient: makeClient, maxEvents: 20 });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" });
    const first = await service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
    const second = await service.call("prompt", { sessionId: opened.sessionId, prompt: "two" }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
    assert.notEqual(first.turnId, second.turnId);
    const session = service.requireSession(opened.sessionId);
    const historical = session.events.find((event) => event.turnId === first.turnId);
    assert.ok(historical);
    for (let index = 0; index < 25; index += 1) service.store.push(session, { type: "test_event", index });
    const replay = service.subscribe({ sessionIds: [opened.sessionId], cursors: { [opened.sessionId]: 0 } }, { rootId: "main-a" }, () => {});
    assert.equal(replay.cursorTruncated[opened.sessionId], true);
    assert.ok(replay.events.every((event) => event.turnId === first.turnId || event.turnId === second.turnId));
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway gives repeated provider request IDs unique durable inbox IDs", async () => {
  const service = new GatewayService();
  const session = service.store.create({ id: "same-session", ownerRootId: "main-a", turnId: "turn-1" });
  const first = service.createElicitationInbox(session, { requestId: 7, mode: "form", message: "first" });
  service.resolveInbox(session, 7, "answered", "done");
  session.turnId = "turn-2";
  const second = service.createElicitationInbox(session, { requestId: 7, mode: "form", message: "second" });
  assert.notEqual(first.inboxId, second.inboxId);
  assert.equal(first.status, "answered");
  assert.equal(second.status, "pending");
});

test("Gateway routes ACP elicitation through the durable inbox and back to the worker", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "read_only" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" });
    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "elicit" }, { rootId: "main-a" });
    const waiting = await waitForStatus(service, opened.sessionId, "waiting_input");
    assert.equal((await service.call("task_get", { taskId: task.taskId }, { rootId: "main-a" })).status, "input_required");
    const inbox = await service.call("inbox", { action: "list", status: "pending" }, { rootId: "main-a" });
    assert.equal(inbox.items[0].type, "worker_question");
    assert.equal(inbox.items[0].message, "Which implementation should be used?");
    assert.deepEqual(inbox.items[0].requestedSchema.required, ["choice"]);
    const request = waiting.events.findLast((event) => event.type === "elicitation_request");
    await service.call("answer", {
      sessionId: opened.sessionId,
      requestId: request.requestId,
      action: "accept",
      content: { choice: "socket" }
    }, { rootId: "main-a" });
    const done = await waitForIdle(service, opened.sessionId);
    assert.equal(done.stopReason, "socket");
    assert.equal((await service.call("inbox", { action: "list", status: "answered" }, { rootId: "main-a" })).items.length, 1);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway cancellation terminates an active terminal and completes the task as cancelled", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "auto_approve" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "auto_approve" }, { rootId: "main-a" });
    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "long-terminal" }, { rootId: "main-a" });
    await waitForTerminalCount(service, opened.sessionId, 1);
    await service.call("task_cancel", { taskId: task.taskId }, { rootId: "main-a" });
    const done = await waitForStatus(service, opened.sessionId, "cancelled");
    assert.equal(done.stopReason, "cancelled");
    assert.equal(service.requireSession(opened.sessionId).client.terminals.size, 0);
    assert.equal((await service.call("task_get", { taskId: task.taskId }, { rootId: "main-a" })).status, "cancelled");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway keeps waiting until every concurrent permission request is answered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-multi-permission-"));
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "ask" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: directory, permissionPolicy: "ask" }, { rootId: "main-a" });
    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "two-writes" }, { rootId: "main-a" });
    const pending = await waitForInboxCount(service, 2);
    assert.equal((await service.call("task_get", { taskId: task.taskId }, { rootId: "main-a" })).status, "input_required");
    await service.call("permission", {
      sessionId: opened.sessionId,
      requestId: pending[0].requestId,
      optionId: "allow-once"
    }, { rootId: "main-a" });
    assert.equal(service.requireSession(opened.sessionId).status, "waiting_permission");
    assert.equal((await service.call("task_get", { taskId: task.taskId }, { rootId: "main-a" })).status, "input_required");
    await service.call("permission", {
      sessionId: opened.sessionId,
      requestId: pending[1].requestId,
      optionId: "allow-once"
    }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
    assert.equal((await service.call("task_get", { taskId: task.taskId }, { rootId: "main-a" })).status, "completed");
    assert.equal(await readFile(join(directory, "first.txt"), "utf8"), "first");
    assert.equal(await readFile(join(directory, "second.txt"), "utf8"), "second");
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway interrupts pending inbox items on explicit cancel and close", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const first = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, { rootId: "main-a" });
    const task = await service.call("task_prompt", { sessionId: first.sessionId, prompt: "go" }, { rootId: "main-a" });
    await waitForStatus(service, first.sessionId, "waiting_permission");
    await service.call("task_cancel", { taskId: task.taskId }, { rootId: "main-a" });
    await waitForStatus(service, first.sessionId, "cancelled");
    let inbox = await service.call("inbox", { action: "list" }, { rootId: "main-a" });
    assert.equal(inbox.items[0].status, "interrupted");
    assert.match(inbox.items[0].resolution, /cancelled/);
    await service.call("session", { action: "close", sessionId: first.sessionId }, { rootId: "main-a" });

    const second = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: second.sessionId, prompt: "go" }, { rootId: "main-a" });
    await waitForStatus(service, second.sessionId, "waiting_permission");
    await service.call("session", { action: "close", sessionId: second.sessionId }, { rootId: "main-a" });
    inbox = await service.call("inbox", { action: "list" }, { rootId: "main-a" });
    assert.equal(inbox.items.filter((item) => item.status === "pending").length, 0);
    assert.ok(inbox.items.some((item) => item.status === "interrupted" && /closed/.test(item.resolution)));
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway keeps an interrupted inbox record when it restarts during a worker request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-inbox-"));
  const statePath = join(directory, "state.json");
  const makeClient = (_provider, options) =>
    new AcpClient(
      { provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" },
      options
    );
  let service = new GatewayService({ statePath, createClient: makeClient });
  try {
    await service.init();
    const opened = await service.call(
      "session_open",
      { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" },
      { rootId: "main-a" }
    );
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "go" }, { rootId: "main-a" });
    await waitForStatus(service, opened.sessionId, "waiting_permission");
    await service.flushPersist();
    await service.shutdown();

    service = new GatewayService({ statePath, createClient: makeClient });
    await service.init();
    const inbox = await service.call("inbox", { action: "list" }, { rootId: "main-a" });
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].status, "interrupted");
    assert.match(inbox.items[0].resolution, /Gateway restarted/);
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway marks an in-flight durable task failed after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-task-restart-"));
  const statePath = join(directory, "state.json");
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" }, options);
  let service = new GatewayService({ statePath, createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, { rootId: "main-a" });
    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "go" }, { rootId: "main-a" });
    await waitForStatus(service, opened.sessionId, "waiting_permission");
    await service.flushPersist();
    await service.shutdown();

    service = new GatewayService({ statePath, createClient: makeClient });
    await service.init();
    const restored = await service.call("task_get", { taskId: task.taskId }, { rootId: "main-a" });
    assert.equal(restored.status, "failed");
    assert.match(restored.statusMessage, /Gateway restarted/);
    const result = await service.call("task_result", { taskId: task.taskId }, { rootId: "main-a" });
    assert.equal(result.ok, false);
    assert.match(result.error, /Gateway restarted/);
    assert.equal(service.requireSession(opened.sessionId).activeTaskId, null);
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway interrupts pending inbox items when an ACP provider exits", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, { rootId: "main-a" });
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "go" }, { rootId: "main-a" });
    await waitForStatus(service, opened.sessionId, "waiting_permission");
    service.requireSession(opened.sessionId).client.proc.kill("SIGKILL");
    await waitForStatus(service, opened.sessionId, "disconnected");
    const inbox = await service.call("inbox", { action: "list" }, { rootId: "main-a" });
    assert.equal(inbox.items[0].status, "interrupted");
    assert.match(inbox.items[0].resolution, /provider exited/);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway rejects concurrent prompts before either turn starts", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, { rootId: "main-a" });
    const first = service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, { rootId: "main-a" });
    await assert.rejects(
      service.call("prompt", { sessionId: opened.sessionId, prompt: "two" }, { rootId: "main-a" }),
      /still active/
    );
    await first;
    const waiting = await waitForStatus(service, opened.sessionId, "waiting_permission");
    const request = waiting.events.findLast((event) => event.type === "permission_request");
    await service.call("permission", { sessionId: opened.sessionId, requestId: request.requestId, optionId: "reject-once" }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway rejects concurrent task prompts without losing the active task link", async () => {
  const makeClient = (_provider, options) =>
    new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" }, options);
  const service = new GatewayService({ createClient: makeClient });
  try {
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, { rootId: "main-a" });
    const first = service.call("task_prompt", { sessionId: opened.sessionId, prompt: "one" }, { rootId: "main-a" });
    await assert.rejects(
      service.call("task_prompt", { sessionId: opened.sessionId, prompt: "two" }, { rootId: "main-a" }),
      /still active/
    );
    const task = await first;
    assert.equal(service.requireSession(opened.sessionId).activeTaskId, task.taskId);
    const waiting = await waitForStatus(service, opened.sessionId, "waiting_permission");
    const request = waiting.events.findLast((event) => event.type === "permission_request");
    await service.call("permission", { sessionId: opened.sessionId, requestId: request.requestId, optionId: "reject-once" }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
    assert.equal((await service.call("task_get", { taskId: task.taskId }, { rootId: "main-a" })).status, "completed");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("Gateway surfaces persistence failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-persist-error-"));
  const statePath = join(directory, "state.json");
  await mkdir(statePath);
  const service = new GatewayService({ statePath });
  try {
    service.persistDirty = true;
    await assert.rejects(service.flushPersist());
    assert.equal(typeof service.persistError, "string");
    assert.ok(service.persistError.length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gateway recreates its state directory if it is removed while running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-state-recreate-"));
  const stateDirectory = join(directory, "state");
  const statePath = join(stateDirectory, "state.json");
  const service = new GatewayService({ statePath, gcIntervalMs: 0 });
  try {
    service.persistDirty = true;
    await service.flushPersist();
    await rm(stateDirectory, { recursive: true, force: true });
    service.persistDirty = true;
    await service.flushPersist();
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).version, 4);
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForIdle(service, sessionId) {
  let cursor = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const poll = await service.call(
      "poll",
      { sessionId, cursor, waitMs: 100 },
      { rootId: "main-a" }
    );
    cursor = poll.nextCursor;
    if (poll.status === "idle") return poll;
    if (["error", "unavailable"].includes(poll.status)) throw new Error(poll.error);
  }
  throw new Error("Gateway session did not become idle");
}

async function waitForStatus(service, sessionId, expected) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const poll = await service.call("poll", { sessionId, waitMs: 100 }, { rootId: "main-a" });
    if (poll.status === expected) return poll;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Gateway session did not reach ${expected}`);
}

async function waitForTerminalCount(service, sessionId, expected) {
  for (;;) {
    const session = service.requireSession(sessionId);
    const count = [...session.client.terminals.values()].filter((terminal) => terminal.sessionId === session.acpSessionId).length;
    if (count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForInboxCount(service, expected) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const inbox = await service.call("inbox", { action: "list", status: "pending" }, { rootId: "main-a" });
    if (inbox.items.length === expected) return inbox.items;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Gateway inbox did not reach ${expected} pending items`);
}
