import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { gatewayObservabilityConfig } from "../src/config.js";
import { GatewayService } from "../src/gateway-service.js";
import { DURABLE_EVENT_TYPES, THOUGHT_TAIL_BYTES } from "../src/sessions.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

// The design's constants, pinned here rather than imported: a test that reads the
// implementation's own number cannot notice the number changing.
const CONTROL_EVENT_SLOTS = 256;
const CHUNK_EVENT_SLOTS = 64;
const MAX_PROJECTED_TOOL_CALLS = 64;

async function withDirectory(prefix, run) {
  const directory = await mkdtemp(join(tmpdir(), `acp-lanes-${prefix}-`));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function directSession(service, id = "lanes") {
  const session = service.store.create({
    provider: "mock", acpSessionId: id, cwd: "/", ownerRootId: "main-a",
    permissionPolicy: "ask", turnId: "turn-1"
  });
  session.status = "running";
  return session;
}

const chunk = (text) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const thought = (text) => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const toolUpdate = (toolCallId, index) => ({
  sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", title: `step ${index}`
});
const permission = (requestId) => ({
  sessionUpdate: "permission_request",
  requestId,
  toolCall: { toolCallId: `call-${requestId}`, title: "Edit", kind: "edit" },
  options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
});

// ---------------------------------------------------------------------------
// 1. Telemetry flood vs. the control lane
// ---------------------------------------------------------------------------

test("control events survive a telemetry flood that evicts everything else", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service);
    const control = [];
    for (let index = 0; index < 20; index += 1) {
      control.push(service.store.push(session, { type: "turn_start", marker: index }).i);
      control.push(service.store.push(session, { type: "permission_request", requestId: index }).i);
      control.push(service.store.push(session, { type: "turn_end", stopReason: "end_turn" }).i);
    }
    for (let index = 0; index < 500; index += 1) service.handleUpdate(session, chunk(`c${index}`));
    for (let index = 0; index < 500; index += 1) {
      service.handleUpdate(session, toolUpdate(`call-${index % 8}`, index));
    }
    // Unknown types are telemetry by default; a worker cannot buy a protected
    // slot by inventing a name.
    for (let index = 0; index < 300; index += 1) service.store.push(session, { type: "test_event", index });

    const survived = new Set(session.events.map((event) => event.i));
    assert.deepEqual(control.filter((i) => !survived.has(i)), [], "no control event was evicted");
    assert.equal(session.events.filter((event) => event.type === "test_event").length < 300, true);
    const telemetry = session.events.filter((event) => !DURABLE_EVENT_TYPES.has(event.type));
    assert.ok(telemetry.length <= service.store.maxEvents, "telemetry keeps its own budget, no more");
    assert.ok(session.chunkEvents.length <= CHUNK_EVENT_SLOTS, "the chunk lane is bounded");
    assert.ok(session.eventsEvictedThrough >= 0, "the low-water mark recorded the drops");

    const merged = service.store.mergedEvents(session);
    for (let index = 1; index < merged.length; index += 1) {
      assert.ok(merged[index].i > merged[index - 1].i, "the merged view is strictly monotonic by sequence");
    }
    assert.ok(merged.length > session.events.length, "the merged view is the union of both lanes");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("control is only ever evicted by newer control, past its own slot count", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service);
    const first = service.store.push(session, { type: "permission_request", requestId: 0 });
    for (let index = 1; index < CONTROL_EVENT_SLOTS; index += 1) {
      service.store.push(session, { type: "turn_end", stopReason: "end_turn" });
    }
    assert.ok(session.events.some((event) => event.i === first.i), "at the bound, nothing has gone yet");
    for (let index = 0; index < 10; index += 1) {
      service.store.push(session, { type: "turn_end", stopReason: "end_turn" });
    }
    assert.equal(session.events.some((event) => event.i === first.i), false);
    assert.equal(session.events.length, CONTROL_EVENT_SLOTS);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 2. The Wake-up gate
// ---------------------------------------------------------------------------

test("Wake-up gate: a default long poll sleeps through progress and wakes on input", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "wake-gate");
    const startedAt = Date.now();
    const flooded = service.call("poll", { sessionId: session.id, waitMs: 400 }, { rootId: "main-a" });
    await new Promise((done) => setTimeout(done, 20));
    // Structural, not incidental: a chunk-blind caller is not even registered in
    // the lane that chunk pushes notify, so 500 chunks cost it zero wakes.
    assert.equal(session.waiters.size, 1);
    assert.equal(session.chunkWaiters.size, 0, "a default poll never joins the chunk lane");

    for (let index = 0; index < 500; index += 1) service.handleUpdate(session, chunk(`c${index}`));
    for (let index = 0; index < 200; index += 1) service.handleUpdate(session, toolUpdate("call-a", index));
    for (let index = 0; index < 50; index += 1) {
      service.handleUpdate(session, { sessionUpdate: "usage_update", used: 100 + index, size: 200_000 });
    }
    const quiet = await flooded;
    assert.ok(Date.now() - startedAt >= 380, "750 progress events must not resolve a default poll");
    assert.deepEqual(quiet.events, []);

    const waitingAt = Date.now();
    const pending = service.call(
      "poll",
      { sessionId: session.id, cursor: quiet.nextCursor, waitMs: 5_000 },
      { rootId: "main-a" }
    );
    setTimeout(() => service.handleUpdate(session, permission(9)), 20);
    const woken = await pending;
    assert.ok(Date.now() - waitingAt < 2_000, "a request Main must answer resolves the same poll immediately");
    assert.deepEqual(woken.events.map((event) => event.type), ["permission_request"]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a chunk that arrives after its turn was sealed cannot grow the finished transcript", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "late-chunk");
    service.handleUpdate(session, chunk("answered"));
    assert.equal(session.resultText, "answered");
    // What #finishTurn does the moment the prompt response lands. handleUpdate is
    // synchronous and outside the mailbox, so a chunk still in the read loop can
    // arrive after this point.
    session.turnSeal = session.turnId;
    service.handleUpdate(session, chunk(" and then some"));
    assert.equal(session.resultText, "answered", "a handed-out result is not rewritten behind the caller");
    assert.ok(
      session.chunkEvents.some((event) => event.text === " and then some"),
      "the late chunk is still recorded and still delivered; only the transcript is sealed"
    );
    // The next turn clears the seal along with the transcript, and appending works
    // again: the gate closes a finished turn, it does not close the session.
    session.turnSeal = null;
    session.resultText = "";
    service.handleUpdate(session, chunk("next turn"));
    assert.equal(session.resultText, "next turn");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a chunk-selecting poll does join the chunk lane and is woken by one", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "chunk-wake");
    const pending = service.call(
      "poll",
      { sessionId: session.id, cursor: 0, waitMs: 5_000, eventTypes: ["agent_message_chunk"] },
      { rootId: "main-a" }
    );
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(session.chunkWaiters.size, 1, "asking for chunks subscribes to chunk wakes");
    setTimeout(() => service.handleUpdate(session, chunk("hello")), 20);
    const response = await pending;
    assert.deepEqual(response.events.map((event) => event.text), ["hello"]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 3. cursorTruncated (P6-1) and eventCount (P6-2)
// ---------------------------------------------------------------------------

test("cursorTruncated reports evicted telemetry even when the ring still starts below the cursor", async () => {
  const service = new GatewayService({ gcIntervalMs: 0, maxEvents: 20 });
  try {
    const session = directSession(service, "watermark");
    const anchor = service.store.push(session, { type: "session_created" });
    for (let index = 0; index < 60; index += 1) service.store.push(session, { type: "test_event", index });
    // The control anchor survived, so the ring's first index is below the cursor:
    // the old "cursor < firstIndex" test would have called this untruncated.
    const firstIndex = session.events[0].i;
    assert.equal(firstIndex, anchor.i);
    const cursor = anchor.i + 5;
    assert.ok(cursor > firstIndex);
    assert.ok(cursor <= session.eventsEvictedThrough);
    const poll = await service.call("poll", { sessionId: session.id, cursor }, { rootId: "main-a" });
    assert.equal(poll.cursorTruncated, true, "at least one event after the cursor is gone");

    const fresh = await service.call(
      "poll",
      { sessionId: session.id, cursor: session.eventSequence },
      { rootId: "main-a" }
    );
    assert.equal(fresh.cursorTruncated, false, "a caller that lost nothing is not warned");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("splitting a lane is not a truncation: a caller that lost nothing is never warned", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "no-false-truncation");
    // The shape every streaming session starts with: chunks hold the low sequence
    // numbers, so the ring's own first index is above a cursor-0 caller.
    service.handleUpdate(session, chunk("Working on it. "));
    service.handleUpdate(session, thought("checking the layout"));
    service.handleUpdate(session, { sessionUpdate: "tool_call", toolCallId: "t-1", title: "Read", kind: "read" });
    assert.equal(session.events[0].i, 2, "the ring starts above zero because the chunks took 0 and 1");
    for (const args of [
      { sessionId: session.id, cursor: 0 },
      { sessionId: session.id, cursor: 0, eventTypes: ["agent_message_chunk"] },
      { sessionId: session.id, cursor: 0, includeThoughts: true }
    ]) {
      const poll = await service.call("poll", args, { rootId: "main-a" });
      assert.equal(poll.cursorTruncated, false, `nothing was evicted: ${JSON.stringify(args)}`);
    }
    const replay = service.subscribe(
      { sessionIds: [session.id], cursors: { [session.id]: 0 } }, { rootId: "main-a" }, () => {}
    );
    assert.equal(replay.cursorTruncated[session.id], false);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("eventCount spans every lane", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "count");
    service.store.push(session, { type: "turn_start" });
    for (let index = 0; index < 5; index += 1) service.handleUpdate(session, chunk(`c${index}`));
    const summary = await service.call("session", { action: "get", sessionId: session.id }, { rootId: "main-a" });
    assert.equal(summary.eventCount, session.events.length + session.chunkEvents.length);
    assert.equal(summary.eventCount, 6);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 4. Chunk lane: pollable, live, absent from replay (P6-5)
// ---------------------------------------------------------------------------

test("chunks stay live and pollable but leave subscription replay", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "replay");
    const live = [];
    service.subscribe({ sessionIds: [session.id], includeThoughts: true }, { rootId: "main-a" }, (event) =>
      live.push(event));
    service.store.push(session, { type: "turn_start" });
    service.handleUpdate(session, chunk("streamed"));
    service.handleUpdate(session, thought("reasoning"));
    assert.deepEqual(
      live.map((event) => event.type),
      ["turn_start", "agent_message_chunk", "agent_thought_chunk"],
      "live delivery is untouched: chunks still publish to subscribers"
    );

    const replay = service.subscribe(
      { sessionIds: [session.id], cursors: { [session.id]: 0 }, includeThoughts: true },
      { rootId: "main-a" },
      () => {}
    );
    assert.deepEqual(
      replay.events.map((event) => event.type),
      ["turn_start"],
      "replay is the ring only; a reconnecting monitor does not re-read the stream"
    );

    const polled = await service.call(
      "poll",
      { sessionId: session.id, cursor: 0, eventTypes: ["agent_message_chunk", "agent_thought_chunk"] },
      { rootId: "main-a" }
    );
    assert.deepEqual(polled.events.map((event) => event.text), ["streamed", "reasoning"]);
    assert.equal(polled.nextCursor, session.eventSequence, "one counter across lanes keeps cursors usable");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 5. tool_call_update projection (P6-4) and artifact aging (P6-7)
// ---------------------------------------------------------------------------

test("tool_call_update collapses to one re-pushed entry per call and keeps the start event", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "projection");
    service.handleUpdate(session, { sessionUpdate: "tool_call", toolCallId: "call-a", title: "Read", kind: "read" });
    let last = null;
    for (let index = 0; index < 50; index += 1) {
      const before = session.eventSequence;
      service.handleUpdate(session, toolUpdate("call-a", index));
      const now = session.events.at(-1);
      assert.equal(now.i, before, "the newest state is re-pushed with a fresh sequence, never edited in place");
      if (last) assert.ok(now.i > last.i, "a subscriber past the old cursor can still see the new state");
      last = now;
    }
    const updates = session.events.filter((event) => event.type === "tool_call_update");
    assert.equal(updates.length, 1, "50 updates project down to the newest one");
    assert.equal(JSON.parse(updates[0].text).title, "step 49");
    assert.equal(
      session.events.filter((event) => event.type === "tool_call").length,
      1,
      "the start event stays in the ring: it is the segment boundary and the record the call began"
    );
    assert.deepEqual(service.store.projectionSnapshot(session), { toolCalls: 1, toolCallsDropped: 0 });
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("the projection is bounded and drops the least recently updated call", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "projection-lru");
    for (let index = 0; index < MAX_PROJECTED_TOOL_CALLS + 4; index += 1) {
      service.handleUpdate(session, toolUpdate(`call-${index}`, 0));
    }
    assert.deepEqual(service.store.projectionSnapshot(session), {
      toolCalls: MAX_PROJECTED_TOOL_CALLS, toolCallsDropped: 4
    });
    // Losing projection costs uncollapsed telemetry for that call, never a
    // dropped update: the newest state is still in the ring.
    service.handleUpdate(session, toolUpdate("call-0", 1));
    assert.equal(
      session.events.filter((event) => event.type === "tool_call_update" && JSON.parse(event.text).toolCallId === "call-0").length,
      2
    );
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a turn owns its projection: the result reset clears it", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "projection-turn");
    service.handleUpdate(session, toolUpdate("call-a", 0));
    assert.equal(service.store.projectionSnapshot(session).toolCalls, 1);
    session.resultText = "";
    assert.deepEqual(service.store.projectionSnapshot(session), { toolCalls: 0, toolCallsDropped: 0 });
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a superseded update's artifact ages out while the newest one is kept alive", async () => {
  await withDirectory("projection-gc", async (directory) => {
    const service = new GatewayService({ gcIntervalMs: 0, artifactRoot: join(directory, "artifacts") });
    try {
      const session = directSession(service, "projection-gc");
      const oversized = (index) => ({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-a",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: `${index}`.repeat(6_000) } }]
      });
      service.handleUpdate(session, oversized(1));
      const stale = session.events.at(-1).dataArtifact.path;
      service.handleUpdate(session, oversized(2));
      const fresh = session.events.at(-1).dataArtifact.path;
      assert.notEqual(stale, fresh);
      // Never unlinked eagerly: a poll may already have handed the path out, so
      // it stays readable for the retention window.
      assert.equal(existsSync(stale), true, "the superseded artifact is not deleted under a live reader");
      assert.equal(
        session.events.some((event) => event.dataArtifact?.path === stale),
        false,
        "it left the ring, which is what makes it age-prune eligible"
      );
      await service.runMaintenance(Date.now() + 25 * 60 * 60_000);
      assert.equal(existsSync(stale), false, "the intermediate artifact ages out");
      assert.equal(existsSync(fresh), true, "the newest update's artifact is kept alive by the ring");
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// 6. UsageAccumulator (P6-6)
// ---------------------------------------------------------------------------

test("usage normalizes gauges, cost and token breakdowns without guessing", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "usage");
    assert.deepEqual(service.store.usageSnapshot(session).turn.source, "none", "zero is not the same as unreported");

    service.handleUpdate(session, {
      sessionUpdate: "usage_update", used: 1_000, size: 200_000, cost: { amount: 0.5, currency: "USD" }
    });
    service.handleUpdate(session, {
      sessionUpdate: "usage_update", used: 800, size: 200_000, cost: { amount: 0.4, currency: "USD" }
    });
    let turn = service.store.usageSnapshot(session).turn;
    assert.equal(turn.source, "usage_update");
    assert.equal(turn.updates, 2);
    assert.equal(turn.usedLast, 800, "used is a gauge: the last sample is authoritative");
    assert.equal(turn.usedPeak, 1_000);
    assert.equal(turn.contextSize, 200_000);
    assert.equal(turn.costTotal, 0.5, "cost is cumulative, so max is monotonic and never double-counts");
    assert.equal(turn.costCurrency, "USD");
    assert.equal(turn.costMixedCurrency, false);

    service.handleUpdate(session, { sessionUpdate: "usage_update", used: 900, cost: { amount: 0.6, currency: "EUR" } });
    turn = service.store.usageSnapshot(session).turn;
    assert.equal(turn.costMixedCurrency, true, "two currencies in one total is flagged, not silently summed");
    assert.equal(turn.costCurrency, "USD", "the first currency seen stays the label");
    assert.equal(turn.costTotal, 0.6);

    // The schema enforces neither finiteness nor sign; a bad number must not
    // become a bad total, and an absent field must not overwrite a known one.
    service.handleUpdate(session, { sessionUpdate: "usage_update", used: Number.NaN, size: -5 });
    turn = service.store.usageSnapshot(session).turn;
    assert.equal(turn.usedLast, 0);
    assert.equal(turn.contextSize, 0);
    service.handleUpdate(session, { sessionUpdate: "usage_update", cost: { amount: 0.7, currency: "USD" } });
    assert.equal(service.store.usageSnapshot(session).turn.usedLast, 0, "a missing gauge leaves the last one alone");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("token totals read as a running total or as this turn's count, both without guessing", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "usage-tokens");
    const record = (tokens) => service.store.recordUsage(session, { usage: tokens }, "prompt_response");
    record({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    assert.equal(service.store.usageSnapshot(session).turn.inputTokens, 100);
    // Cumulative style: only the growth counts.
    record({ inputTokens: 250, outputTokens: 45, totalTokens: 295 });
    let turn = service.store.usageSnapshot(session).turn;
    assert.equal(turn.inputTokens, 250);
    assert.equal(turn.outputTokens, 45);
    assert.equal(turn.source, "prompt_response");
    // Per-turn style: a count that drops is a new count, not a negative delta.
    record({ inputTokens: 30, outputTokens: 5, totalTokens: 35 });
    turn = service.store.usageSnapshot(session).turn;
    assert.equal(turn.inputTokens, 280);
    assert.equal(turn.outputTokens, 50);
    assert.ok(turn.cachedReadTokens === 0 && turn.cachedWriteTokens === 0 && turn.thoughtTokens === 0);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("usage_update is still not a ring event, a wake or a publish", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "usage-quiet");
    const published = [];
    service.subscribe({ sessionIds: [session.id], includeThoughts: true, includeToolEvents: true },
      { rootId: "main-a" }, (event) => published.push(event));
    const before = session.eventSequence;
    for (let index = 0; index < 50; index += 1) {
      service.handleUpdate(session, { sessionUpdate: "usage_update", used: index });
    }
    assert.equal(session.events.some((event) => event.type === "usage_update"), false);
    assert.equal(session.chunkEvents.some((event) => event.type === "usage_update"), false);
    assert.equal(session.eventSequence, before, "accounting chatter never consumes a sequence number");
    assert.deepEqual(published, []);
    assert.equal(service.store.usageSnapshot(session).turn.updates, 50, "it was counted, not delivered");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("per-turn usage resets with the transcript; the session total survives until it is cleared", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "usage-reset");
    service.handleUpdate(session, { sessionUpdate: "usage_update", used: 500, size: 1_000 });
    session.resultText = "";
    let snapshot = service.store.usageSnapshot(session);
    assert.equal(snapshot.turn.updates, 0);
    assert.equal(snapshot.turn.source, "none");
    assert.equal(snapshot.session.updates, 1);
    assert.equal(snapshot.session.usedPeak, 500);

    session.status = "idle";
    session.completedAt = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
    await service.runMaintenance(Date.now());
    assert.ok(session.transientClearedAt, "the transient clear ran");
    snapshot = service.store.usageSnapshot(session);
    assert.equal(snapshot.session.updates, 0, "the cumulative total is transient state too");
    assert.equal(snapshot.session.source, "none");
    assert.deepEqual(session.chunkEvents, []);
    assert.equal(
      service.store.checkpoints().some((record) => "usage" in record),
      false,
      "usage is never persisted"
    );
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("usage is exposed on poll only when asked for, and on get and the task envelope", async () => {
  const service = new GatewayService({
    createClient: (_provider, options) =>
      new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options)
  });
  try {
    const opened = await service.call(
      "session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" }
    );
    const task = await service.call(
      "task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, { rootId: "main-a" }
    );
    await waitForIdle(service, opened.sessionId);

    const plain = await service.call("poll", { sessionId: opened.sessionId, cursor: 0 }, { rootId: "main-a" });
    assert.deepEqual(
      Object.keys(JSON.parse(JSON.stringify(plain.result))).sort(),
      ["artifact", "stopReason", "text", "transcriptBytes"],
      "the frozen result shape does not grow a key nobody asked for"
    );
    const opted = await service.call(
      "poll", { sessionId: opened.sessionId, cursor: 0, includeUsage: true }, { rootId: "main-a" }
    );
    assert.deepEqual(Object.keys(opted.result.usageSummary).sort(), ["session", "turn"]);
    assert.equal(opted.result.usageSummary.turn.inputTokens, 1_200, "the mock's usage_update reached the accumulator");
    assert.equal(opted.result.usageSummary.turn.outputTokens, 340);

    const got = await service.call("session", { action: "get", sessionId: opened.sessionId }, { rootId: "main-a" });
    assert.deepEqual(Object.keys(got.usage).sort(), ["session", "turn"]);
    assert.equal(got.usage.session.inputTokens, 1_200);

    const envelope = await service.call("task_result", { taskId: task.taskId }, { rootId: "main-a" });
    const keys = Object.keys(envelope);
    assert.ok(keys.includes("usage"));
    assert.ok(keys.indexOf("usage") < keys.indexOf("result"), "usage sits inside the durable preview head");
    assert.equal(envelope.usage.inputTokens, 1_200);

    const setup = await service.call("setup", {}, { rootId: "main-a" });
    assert.equal("usage" in setup.metrics, false, "metrics are global; one Main must not read another's spend");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("a turn's token breakdown is taken from the prompt response the gateway used to discard", async () => {
  const service = new GatewayService({
    createClient: (_provider, options) =>
      new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options)
  });
  try {
    const opened = await service.call(
      "session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, { rootId: "main-a" }
    );
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "usage-breakdown" }, { rootId: "main-a" });
    await waitForIdle(service, opened.sessionId);
    const poll = await service.call(
      "poll", { sessionId: opened.sessionId, cursor: 0, includeUsage: true }, { rootId: "main-a" }
    );
    const turn = poll.result.usageSummary.turn;
    assert.equal(turn.source, "prompt_response");
    assert.equal(turn.totalTokens, 4_096);
    assert.equal(turn.cachedReadTokens, 900);
    assert.equal(turn.thoughtTokens, 64);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 7. Thought capture policy (P6-3, P6-9)
// ---------------------------------------------------------------------------

test("thought capture keeps none, a tail or everything, and never changes the live stream", async () => {
  for (const [mode, expected] of [["none", 0], ["tail", THOUGHT_TAIL_BYTES], ["full", 20_000]]) {
    const service = new GatewayService({ gcIntervalMs: 0, thoughtCapture: mode });
    try {
      const session = service.store.create({
        provider: "mock", acpSessionId: `thought-${mode}`, cwd: "/", ownerRootId: "main-a",
        permissionPolicy: "ask", turnId: "turn-1", thoughtCapture: mode
      });
      session.status = "running";
      const delivered = [];
      service.subscribe({ sessionIds: [session.id], includeThoughts: true }, { rootId: "main-a" }, (event) =>
        delivered.push(event));
      for (let index = 0; index < 20; index += 1) service.handleUpdate(session, thought("t".repeat(1_000)));
      assert.equal(delivered.length, 20, `live delivery is unaffected in ${mode} mode`);
      assert.equal(typeof session.thoughtText, "string", "none reports empty, it never drops the key");
      assert.equal(Buffer.byteLength(session.thoughtText), expected);
      if (mode === "tail") assert.equal(session.thoughtText.endsWith("t"), true);
    } finally {
      await service.shutdown().catch(() => {});
    }
  }
});

test("thoughtCapture is a session argument, survives a restart, and has an env default", async () => {
  await withDirectory("thought-restart", async (directory) => {
    const statePath = join(directory, "state.json");
    const makeClient = (_provider, options) =>
      new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options);
    let service = new GatewayService({ statePath, createClient: makeClient });
    let sessionId = null;
    try {
      await service.init();
      const opened = await service.call(
        "session_open",
        { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only", thoughtCapture: "none" },
        { rootId: "main-a" }
      );
      sessionId = opened.sessionId;
      assert.equal(service.requireSession(sessionId).thoughtCapture, "none");
      const checkpoint = service.store.checkpoints().find((record) => record.id === sessionId);
      assert.equal(checkpoint.thoughtCapture, "none");
      await service.persist();
    } finally {
      await service.shutdown().catch(() => {});
    }
    service = new GatewayService({ statePath, createClient: makeClient });
    try {
      await service.init();
      assert.equal(service.requireSession(sessionId).thoughtCapture, "none", "a per-session policy survives a restart");
    } finally {
      await service.shutdown().catch(() => {});
    }
    // A record written before the field existed restores on the gateway default,
    // not on a hardcoded one.
    const legacy = new GatewayService({ thoughtCapture: "full" });
    try {
      const restored = legacy.store.create({
        provider: "mock", acpSessionId: "legacy", cwd: "/", ownerRootId: "main-a", permissionPolicy: "ask",
        thoughtCapture: undefined
      });
      assert.equal(restored.thoughtCapture, "tail", "the store's own fallback is the documented default");
    } finally {
      await legacy.shutdown().catch(() => {});
    }
  });
});

test("a session opened without the argument inherits the gateway-wide default", async () => {
  const service = new GatewayService({
    thoughtCapture: "full",
    createClient: (_provider, options) =>
      new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }, options)
  });
  try {
    // One open proves both halves: the gateway-wide default is what a session
    // without an opinion gets, and an unknown value falls back to it rather than
    // failing an otherwise valid open.
    const opened = await service.call(
      "session_open",
      { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only", thoughtCapture: "nonsense" },
      { rootId: "main-a" }
    );
    assert.equal(service.requireSession(opened.sessionId).thoughtCapture, "full");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("ACP_GATEWAY_THOUGHT_CAPTURE selects the gateway-wide default and rejects nonsense", () => {
  const original = process.env.ACP_GATEWAY_THOUGHT_CAPTURE;
  try {
    delete process.env.ACP_GATEWAY_THOUGHT_CAPTURE;
    assert.deepEqual(gatewayObservabilityConfig(), { thoughtCapture: "tail" });
    process.env.ACP_GATEWAY_THOUGHT_CAPTURE = "full";
    assert.equal(gatewayObservabilityConfig().thoughtCapture, "full");
    process.env.ACP_GATEWAY_THOUGHT_CAPTURE = "sometimes";
    assert.throws(() => gatewayObservabilityConfig(), /must be one of/);
  } finally {
    if (original == null) delete process.env.ACP_GATEWAY_THOUGHT_CAPTURE;
    else process.env.ACP_GATEWAY_THOUGHT_CAPTURE = original;
  }
});

// ---------------------------------------------------------------------------
// 8. config_option_update is snapshot-dirty without being control (P6-8)
// ---------------------------------------------------------------------------

test("a worker-initiated model change schedules a snapshot without buying a ring slot", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "config-dirty");
    let scheduled = 0;
    service.schedulePersist = () => { scheduled += 1; };
    service.handleUpdate(session, {
      sessionUpdate: "config_option_update",
      options: [{ id: "model", name: "Model", currentValue: "opus" }]
    });
    assert.equal(scheduled, 1, "the change that rewrites capabilities and model now reaches disk");
    assert.equal(DURABLE_EVENT_TYPES.has("config_option_update"), false, "snapshot-dirty is not the control lane");

    scheduled = 0;
    for (let index = 0; index < 300; index += 1) {
      service.handleUpdate(session, {
        sessionUpdate: "config_option_update", options: [{ id: "model", name: "Model", currentValue: `m${index}` }]
      });
    }
    assert.equal(
      session.events.filter((event) => event.type === "config_option_update").length <= service.store.maxEvents,
      true,
      "unsolicited worker chatter stays evictable"
    );
  } finally {
    await service.shutdown().catch(() => {});
  }
});

async function waitForIdle(service, sessionId, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    const state = await service.call("poll", { sessionId, cursor: 0 }, { rootId: "main-a" });
    if (state.status !== "running" && state.status !== "starting") return state;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("session never left the running state");
}
