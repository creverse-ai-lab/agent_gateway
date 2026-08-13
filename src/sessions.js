import { randomUUID } from "node:crypto";
import { BoundedUtf8Text, readHeadBytes, utf8ByteHead } from "./bounded-utf8.js";

const textAccumulators = new WeakMap();

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
      turnId: null,
      stopReason: null,
      error: null,
      waiters: new Set(),
      eventSequence: 0,
      ...rest
    };
    let resultWriter = null;
    const resultBuffer = new BoundedUtf8Text(this.maxTextBytes, {
      onTrim: (buffer) => {
        resultWriter ??= this.artifactStore?.create(session.id, "result") ?? null;
        resultWriter?.append(buffer);
        session.resultArtifact = resultWriter?.metadata() ?? null;
      }
    });
    const thoughtBuffer = new BoundedUtf8Text(this.maxTextBytes);
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
          session.resultFinalText = null;
          session.resultFinalArtifact = null;
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

  appendResultText(session, text) {
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

  appendThoughtText(session, text) {
    textAccumulators.get(session)?.thoughtBuffer.append(text);
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
    if (session.events.length > this.maxEvents) {
      session.events.splice(0, session.events.length - this.maxEvents);
    }
    session.updatedAt = new Date().toISOString();
    for (const wake of session.waiters) wake();
    this.onEvent?.(session, stored);
    this.onChange?.(session, stored);
    return stored;
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
      stopReason: session.stopReason ?? null
    }));
  }

  // Waiters fire on every push; shouldWake keeps the poll asleep for events
  // the caller would only filter out again (tool noise for a text-only poll).
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
