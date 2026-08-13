import { randomUUID } from "node:crypto";
import { BoundedUtf8Text, readHeadBytes, utf8ByteHead } from "./bounded-utf8.js";

const textAccumulators = new WeakMap();

// The control lane. An event worth persisting is an event worth never dropping,
// so one closed list decides all three of its consumers: the ring slots telemetry
// can never evict (here), snapshot scheduling (gateway-service) and the
// transport's non-droppable lane (socket-flow, which imports the re-export).
// Closed is the DoS property: a worker cannot promote its own chatter into the
// protected lane by naming it something new.
export const DURABLE_EVENT_TYPES = new Set([
  "session_created", "session_restored", "session_restore_start", "session_restore_failed",
  "turn_start", "turn_end", "error", "permission_request", "permission_response",
  "elicitation_request", "elicitation_response", "cancel_requested", "orphan_cancel_requested",
  "provider_disconnected", "session_closed", "model_changed", "config_changed", "task_status"
]);

// The highest-volume, lowest-value events in the protocol. They keep a lane of
// their own instead of sharing the ring: one turn of streaming would otherwise
// evict every permission request and turn boundary the session ever recorded.
// They remain available to explicitly opted-in live subscribers, but never enter
// retrospective poll or replay storage.
export const CHUNK_EVENT_TYPES = new Set([
  "agent_message_chunk", "agent_thought_chunk", "user_message_chunk"
]);

// 2 x (maxPendingRequestsPerSession + one response each). The bound on ACP
// pending requests is 64 concurrent, not 64 per turn, so this is two full
// saturations of the request path — about nine typical turns of control history,
// where today's shared ring guarantees none at all.
const CONTROL_EVENT_SLOTS = 256;
// Mirrors the inspection bound: a per-turn projection is a debugging aid, and a
// worker with thousands of live tool calls is a bug, not a workload.
const MAX_PROJECTED_TOOL_CALLS = 64;
// 128x cheaper than the 1MB transcript bound and still enough to answer "what
// was it thinking when it stopped".
export const THOUGHT_TAIL_BYTES = 8192;
export const THOUGHT_CAPTURE_MODES = ["none", "tail", "full"];

export function normalizeThoughtCapture(value, fallback = "tail") {
  return THOUGHT_CAPTURE_MODES.includes(value) ? value : fallback;
}

export class SessionStore {
  constructor({
    maxEvents = 200,
    maxTextBytes = 1_000_000,
    maxInlineResultBytes = 64 * 1024,
    artifactStore = null,
    onChange = null,
    onEvent = null
  } = {}) {
    this.sessions = new Map();
    this.maxEvents = maxEvents;
    this.maxTextBytes = maxTextBytes;
    this.maxInlineResultBytes = maxInlineResultBytes;
    this.artifactStore = artifactStore;
    this.onChange = onChange;
    this.onEvent = onEvent;
  }

  // Writes complete text to a disk artifact so a capped inline copy always has
  // a pointer to the full data.
  spillText(sessionId, kind, text) {
    const writer = this.artifactStore?.create(sessionId, kind);
    if (!writer) return null;
    writer.append(text);
    writer.finalize();
    return writer.metadata();
  }

  create(fields) {
    const { resultText: initialResultText, thoughtText: initialThoughtText, ...rest } = fields;
    const session = {
      id: fields.id ?? `acp-${randomUUID()}`,
      status: "idle",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      // Compatibility-only inspection field. Raw chunks are live telemetry and
      // are never appended here.
      chunkEvents: [],
      turnId: null,
      stopReason: null,
      error: null,
      waiters: new Set(),
      eventSequence: 0,
      ...rest
    };
    session.chunkEvents = Array.isArray(session.chunkEvents) ? session.chunkEvents : [];
    session.thoughtCapture = normalizeThoughtCapture(session.thoughtCapture);
    // The highest sequence number that left a lane. "cursor at or below this"
    // means at least one event the caller has not seen is gone, even when the
    // ring still starts below the cursor because control survived.
    session.eventsEvictedThrough = Number.isFinite(session.eventsEvictedThrough)
      ? session.eventsEvictedThrough : -1;
    let resultWriter = null;
    const resultBuffer = new BoundedUtf8Text(this.maxTextBytes, {
      onTrim: (buffer) => {
        resultWriter ??= this.artifactStore?.create(session.id, "result") ?? null;
        resultWriter?.append(buffer);
        session.resultArtifact = resultWriter?.metadata() ?? null;
      }
    });
    // The bound follows the capture policy, which can change across a restore;
    // appendThoughtText re-applies it, and BoundedUtf8Text trims on the next
    // append, so a full -> tail switch costs nothing but the next chunk.
    const thoughtBuffer = new BoundedUtf8Text(thoughtLimitFor(session, this.maxTextBytes));
    let segmentWriter = null;
    const segmentBuffer = new BoundedUtf8Text(this.maxTextBytes, {
      onTrim: (buffer) => {
        segmentWriter ??= this.artifactStore?.create(session.id, "segment") ?? null;
        segmentWriter?.append(buffer);
      }
    });
    if (initialResultText) resultBuffer.append(initialResultText);
    if (initialThoughtText) thoughtBuffer.append(initialThoughtText);
    textAccumulators.set(session, {
      resultBuffer,
      thoughtBuffer,
      segmentBuffer,
      inspection: [],
      inspectionDropped: 0,
      // Projection state and usage live here rather than on the session: a
      // session property leaks through every spread into publicSession,
      // checkpoints and the snapshot, and none of this is any of their business.
      toolCalls: new Map(),
      toolCallsDropped: 0,
      usageTurn: emptyUsage(),
      usageSession: emptyUsage(),
      usagePrevTokens: null,
      get resultWriter() { return resultWriter; },
      // Closes the spill writer for the current segment (if one started) and
      // returns its metadata, so the full segment stays readable on disk.
      closeSegmentWriter(tail) {
        if (!segmentWriter?.active) {
          segmentWriter = null;
          return null;
        }
        segmentWriter.finalize(tail);
        const artifact = segmentWriter.metadata();
        segmentWriter = null;
        return artifact;
      }
    });
    Object.defineProperties(session, {
      resultText: {
        enumerable: true,
        configurable: true,
        get: () => resultBuffer.toString(),
        set: (value) => {
          if (resultWriter?.started && !resultWriter.complete) resultWriter.finalize(resultBuffer.toString());
          resultWriter = null;
          session.resultArtifact = null;
          resultBuffer.reset(value);
          const state = textAccumulators.get(session);
          state.closeSegmentWriter(null);
          segmentBuffer.reset(value);
          state.inspection.length = 0;
          state.inspectionDropped = 0;
          // A turn owns its projection and its token count. This setter is the
          // one place a turn starts over, so it is the one place they reset.
          state.toolCalls.clear();
          state.toolCallsDropped = 0;
          state.usageTurn = emptyUsage();
          state.usagePrevTokens = null;
          session.resultFinalText = null;
          session.resultFinalArtifact = null;
          session.resultBudgetArtifact = null;
          session.resultInspection = [];
        }
      },
      thoughtText: {
        enumerable: true,
        configurable: true,
        get: () => thoughtBuffer.toString(),
        set: (value) => thoughtBuffer.reset(value)
      }
    });
    session.eventSequence = Math.max(
      Number(session.eventSequence ?? 0),
      (session.events.at(-1)?.i ?? -1) + 1
    );
    this.sessions.set(session.id, session);
    this.onChange?.(session, null);
    return session;
  }

  // The turn token gate: a chunk that arrives after its turn was sealed belongs
  // to a result that has already been finalized and handed out. Appending it
  // would grow a finished transcript and seed the next turn's first segment with
  // the previous turn's tail. A comparison, not a lock — the ACP read loop stays
  // synchronous and never waits on the mailbox.
  appendResultText(session, text) {
    if (session.turnSeal != null && session.turnSeal === session.turnId) return;
    const state = textAccumulators.get(session);
    state?.resultBuffer.append(text);
    state?.segmentBuffer.append(text);
  }

  // A work boundary (tool_call start, permission, elicitation) closes the
  // current message segment: the text before it is narration, not the final
  // answer. Progress updates and bookkeeping must not reach here.
  markSegmentBoundary(session, boundary) {
    const state = textAccumulators.get(session);
    if (!state) return;
    const text = state.segmentBuffer.toString();
    let artifact = state.closeSegmentWriter(text.trim() ? text : null);
    if (text.trim() || artifact) {
      const bytes = artifact?.bytes ?? Buffer.byteLength(text);
      if (!artifact && bytes > 4000) {
        // Keep the capped preview recoverable: mid-sized segments get a disk
        // pointer too, not only the ones that overflowed the memory bound.
        artifact = this.spillText(session.id, "narration", text);
      }
      state.inspection.push({
        text: utf8ByteHead(text, 4000),
        bytes,
        truncated: bytes > 4000,
        ...(artifact ? { artifact } : {}),
        boundary
      });
      if (state.inspection.length > 32) {
        state.inspectionDropped += state.inspection.length - 32;
        state.inspection.splice(0, state.inspection.length - 32);
      }
    }
    state.segmentBuffer.reset("");
  }

  // Provider bookkeeping, folded into a per-turn and a per-session total. It is
  // deliberately NOT a ring event: some adapters stream usage per token, so
  // retaining it would wake every long poll and turn accounting chatter into
  // frontdoor traffic. Synchronous, no status write, no waiter, no publish.
  recordUsage(session, raw, source = "usage_update") {
    const state = textAccumulators.get(session);
    if (!state) return null;
    const sample = adaptUsage(source, raw);
    // Token totals arrive either as a running total or as this turn's count, and
    // one sample cannot tell those apart. This handles both without guessing;
    // the cost of not guessing is that consecutive non-decreasing per-turn counts
    // are read as a growing total.
    const deltas = {};
    const seen = { ...state.usagePrevTokens };
    for (const field of TOKEN_FIELDS) {
      const now = sample.tokens[field];
      if (now == null) continue;
      const previous = state.usagePrevTokens?.[field] ?? null;
      deltas[field] = previous != null && now >= previous ? now - previous : now;
      seen[field] = now;
    }
    state.usagePrevTokens = seen;
    applyUsage(state.usageTurn, sample, deltas);
    applyUsage(state.usageSession, sample, deltas);
    return state.usageTurn;
  }

  usageSnapshot(session) {
    const state = textAccumulators.get(session);
    return {
      turn: { ...(state?.usageTurn ?? emptyUsage()) },
      session: { ...(state?.usageSession ?? emptyUsage()) }
    };
  }

  // The per-turn total resets with the transcript; the cumulative one only when
  // the session's transient state is cleared wholesale.
  clearSessionUsage(session) {
    const state = textAccumulators.get(session);
    if (!state) return;
    state.usageTurn = emptyUsage();
    state.usageSession = emptyUsage();
    state.usagePrevTokens = null;
  }

  inspectionSnapshot(session) {
    const state = textAccumulators.get(session);
    return {
      segments: state ? [...state.inspection] : [],
      dropped: state?.inspectionDropped ?? 0
    };
  }

  notifyWaiters(session) {
    for (const wake of [...session.waiters]) wake();
  }

  // Bounds the inline copy of a final result; oversized text goes to disk in
  // full and the response carries the head plus the pointer. When the memory
  // buffer already lost its prefix, the inline head is re-read from the full
  // artifact so it is the head of the answer, not of the retained tail.
  #capFinal(session, text, artifact, lostPrefix) {
    if (!lostPrefix && Buffer.byteLength(text) <= this.maxInlineResultBytes) {
      return { text, artifact: artifact ?? null };
    }
    const full = artifact ?? this.spillText(session.id, "final", text);
    const head = lostPrefix && full?.path ? readHeadBytes(full.path, this.maxInlineResultBytes) : null;
    return {
      text: head ?? utf8ByteHead(text, this.maxInlineResultBytes),
      artifact: full ?? null
    };
  }

  finalizeResult(session) {
    const state = textAccumulators.get(session);
    // Finalize the transcript spill first so the fallback below can reuse it
    // as the full-text pointer instead of re-spilling a truncated tail.
    const writer = state?.resultWriter;
    if (writer?.active) {
      writer.finalize(state.resultBuffer.toString());
      session.resultArtifact = writer.metadata();
    }
    if (state) {
      const finalText = state.segmentBuffer.toString();
      const capped = finalText.trim()
        ? this.#capFinal(
            session, finalText, state.closeSegmentWriter(finalText),
            state.segmentBuffer.trimmedBytes > 0
          )
        // The turn ended on a boundary (tool work after the last message), so
        // no single segment is the answer; fall back to the whole transcript.
        : (state.closeSegmentWriter(null), this.#capFinal(
            session, state.resultBuffer.toString(), session.resultArtifact ?? null,
            state.resultBuffer.trimmedBytes > 0
          ));
      session.resultFinalText = capped.text;
      session.resultFinalArtifact = capped.artifact;
      session.resultInspection = [...state.inspection];
    }
    return session.resultArtifact ?? null;
  }

  // Policy governs retention, never the stream: all three modes keep delivering
  // thought chunks live to subscribers and to a poll that asks for them. none
  // still reports "" rather than dropping the key, so the wire shape holds.
  appendThoughtText(session, text) {
    if (session.thoughtCapture === "none") return;
    const buffer = textAccumulators.get(session)?.thoughtBuffer;
    if (!buffer) return;
    buffer.maxBytes = thoughtLimitFor(session, this.maxTextBytes);
    buffer.append(text);
  }

  get(id) {
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()];
  }

  delete(id) {
    const deleted = this.sessions.delete(id);
    if (deleted) this.onChange?.(null, null);
    return deleted;
  }

  push(session, event) {
    const stored = { i: session.eventSequence++, ts: new Date().toISOString(), turnId: session.turnId, ...event };
    session.events.push(stored);
    this.#evict(session);
    session.updatedAt = new Date().toISOString();
    for (const wake of session.waiters) wake();
    this.onEvent?.(session, stored);
    this.onChange?.(session, stored);
    return stored;
  }

  // Telemetry-first eviction on one array. Telemetry keeps the whole maxEvents
  // budget it has today, and control keeps slots of its own on top, so a flood of
  // worker progress can never drop a permission request or a turn boundary —
  // while a quiet session pays nothing for the reservation. Unknown types are
  // telemetry by default: a worker must not be able to buy protected slots by
  // inventing a type name.
  #evict(session) {
    const events = session.events;
    // Below the smaller of the two budgets, neither lane can be over its own.
    if (events.length <= Math.min(this.maxEvents, CONTROL_EVENT_SLOTS)) return;
    let control = 0;
    for (const event of events) if (DURABLE_EVENT_TYPES.has(event.type)) control += 1;
    let telemetry = events.length - control;
    let index = 0;
    while (telemetry > this.maxEvents && index < events.length) {
      if (DURABLE_EVENT_TYPES.has(events[index].type)) {
        index += 1;
        continue;
      }
      this.#dropEvent(session, events, index);
      telemetry -= 1;
    }
    // Control is only ever evicted by newer control, and only past its own bound.
    while (control > CONTROL_EVENT_SLOTS) {
      const at = events.findIndex((event) => DURABLE_EVENT_TYPES.has(event.type));
      if (at < 0) break;
      this.#dropEvent(session, events, at);
      control -= 1;
    }
  }

  #dropEvent(session, events, index) {
    session.eventsEvictedThrough = Math.max(session.eventsEvictedThrough, events[index].i);
    events.splice(index, 1);
  }

  // Raw chunks are live telemetry only. The bounded message/thought
  // accumulators retain the state used by results and diagnostics; keeping each
  // fragment would recreate the noisy ring under another name.
  publishChunk(session, event) {
    const stored = { i: session.eventSequence++, ts: new Date().toISOString(), turnId: session.turnId, ...event };
    session.updatedAt = new Date().toISOString();
    this.onEvent?.(session, stored);
    return stored;
  }

  // The merged view, built only when the caller's filter selects chunks. Both
  // lanes are already ascending by sequence, so this is a linear merge and the
  // default poll path never pays for it.
  mergedEvents(session) {
    return session.events;
  }

  // Collapses a tool call's progress to its newest state by DELETING the prior
  // ring entry and re-pushing with a fresh sequence number. Mutating in place
  // would keep the old number, which a subscriber past that cursor drops as
  // already-seen — leaving it permanently unable to observe the new state. The
  // re-push preserves monotonicity, live delivery and "at most one entry per
  // call" all at once. The oversized artifact of a superseded update becomes
  // age-prune eligible by leaving the ring; it is never unlinked eagerly,
  // because a poll may already have handed its path out.
  pushToolCallUpdate(session, event, toolCallId) {
    const state = toolCallId == null ? null : textAccumulators.get(session);
    if (state) {
      const prior = state.toolCalls.get(toolCallId);
      state.toolCalls.delete(toolCallId);
      const at = prior ? session.events.indexOf(prior) : -1;
      if (at >= 0) session.events.splice(at, 1);
    }
    const stored = this.push(session, event);
    if (state) {
      state.toolCalls.set(toolCallId, stored);
      // LRU by insertion order: the oldest call stops being projected, which
      // costs uncollapsed telemetry for it, never a dropped update.
      if (state.toolCalls.size > MAX_PROJECTED_TOOL_CALLS) {
        state.toolCalls.delete(state.toolCalls.keys().next().value);
        state.toolCallsDropped += 1;
      }
    }
    return stored;
  }

  projectionSnapshot(session) {
    const state = textAccumulators.get(session);
    return { toolCalls: state?.toolCalls.size ?? 0, toolCallsDropped: state?.toolCallsDropped ?? 0 };
  }

  trimText(value) {
    const text = String(value ?? "");
    const bytes = Buffer.from(text);
    if (bytes.length <= this.maxTextBytes) return text;
    let start = bytes.length - this.maxTextBytes;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    return bytes.subarray(start).toString("utf8");
  }

  checkpoints() {
    return this.list().map((session) => ({
      id: session.id,
      provider: session.provider,
      acpSessionId: session.acpSessionId,
      cwd: session.cwd,
      title: session.title ?? null,
      permissionPolicy: session.permissionPolicy,
      model: session.model ?? null,
      ownerRootId: session.ownerRootId,
      mcpServers: session.mcpServers ?? [],
      additionalDirectories: session.additionalDirectories ?? [],
      pinned: session.pinned === true,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      completedAt: session.completedAt ?? null,
      orphanedAt: session.orphanedAt ?? null,
      lastOwnerActivityAt: session.lastOwnerActivityAt ?? session.updatedAt,
      transientClearedAt: session.transientClearedAt ?? null,
      eventSequence: session.eventSequence,
      turnId: session.turnId ?? null,
      stopReason: session.stopReason ?? null,
      // Additive: a capture policy chosen per session must survive a restart, or
      // a restored session silently reverts to the gateway default.
      thoughtCapture: session.thoughtCapture ?? null
    }));
  }

  // Waiters fire only for retained events or status changes. Raw progress is a
  // subscription stream and never wakes a poll, even when its filter names a
  // chunk type.
  wait(session, waitMs, shouldWake = () => true) {
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        session.waiters.delete(wake);
        done();
      };
      const wake = () => {
        if (shouldWake()) finish();
      };
      const timer = setTimeout(finish, waitMs);
      session.waiters.add(wake);
    });
  }
}

const TOKEN_FIELDS = [
  "totalTokens", "inputTokens", "outputTokens",
  "thoughtTokens", "cachedReadTokens", "cachedWriteTokens"
];

function emptyUsage() {
  return {
    // "none" is what tells a reader that zeros mean "the provider said nothing",
    // not "the provider said zero".
    source: "none",
    updates: 0,
    usedLast: 0,
    usedPeak: 0,
    contextSize: 0,
    costTotal: 0,
    costCurrency: null,
    costMixedCurrency: false,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0
  };
}

// The single input adapter. UsageUpdate carries a context gauge ({used, size,
// cost}); the token breakdown is a different, UNSTABLE type that arrives on
// PromptResponse.usage. Both land here so there is one place to change when the
// protocol moves this payload again, and every field is optional.
function adaptUsage(source, raw) {
  const root = raw && typeof raw === "object" ? raw : {};
  const nested = root.usage && typeof root.usage === "object" ? root.usage : {};
  const pick = (name) => (nested[name] !== undefined ? nested[name] : root[name]);
  const cost = root.cost ?? nested.cost ?? null;
  const tokens = {};
  for (const field of TOKEN_FIELDS) tokens[field] = usageNumber(pick(field));
  return {
    source,
    used: usageNumber(pick("used")),
    contextSize: usageNumber(pick("size") ?? pick("contextSize")),
    cost: usageNumber(cost && typeof cost === "object" ? cost.amount : null),
    currency: typeof cost?.currency === "string" && cost.currency ? cost.currency : null,
    tokens
  };
}

// Absent stays absent (null) so a missing field never overwrites a known one.
// Present but unusable becomes 0: the schema does not enforce finiteness or
// non-negativity, and a NaN on the wire must not become a NaN in a total.
function usageNumber(value) {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function applyUsage(bucket, sample, deltas) {
  bucket.updates += 1;
  bucket.source = sample.source;
  if (sample.used != null) {
    bucket.usedLast = sample.used;
    bucket.usedPeak = Math.max(bucket.usedPeak, sample.used);
  }
  if (sample.contextSize != null) bucket.contextSize = sample.contextSize;
  // max, never sum and never last: cost.amount is documented as cumulative, so
  // max is monotonic for well-behaved providers and cannot double-count for a
  // provider that resets it.
  if (sample.cost != null) bucket.costTotal = Math.max(bucket.costTotal, sample.cost);
  if (sample.currency) {
    if (bucket.costCurrency && bucket.costCurrency !== sample.currency) bucket.costMixedCurrency = true;
    bucket.costCurrency ??= sample.currency;
  }
  for (const field of TOKEN_FIELDS) {
    if (deltas[field] != null) bucket[field] += deltas[field];
  }
}

function thoughtLimitFor(session, maxTextBytes) {
  return session.thoughtCapture === "full" ? maxTextBytes : THOUGHT_TAIL_BYTES;
}

export function publicSession(session) {
  return {
    sessionId: session.id,
    acpSessionId: session.acpSessionId,
    provider: session.provider,
    status: session.status,
    cwd: session.cwd,
    permissionPolicy: session.permissionPolicy,
    model: session.model ?? null,
    title: session.title,
    pinned: session.pinned === true,
    lastOwnerActivityAt: session.lastOwnerActivityAt ?? null,
    turnId: session.turnId,
    stopReason: session.stopReason,
    error: session.error,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    eventCount: session.events.length,
    resultArtifact: session.resultArtifact ?? null
  };
}
