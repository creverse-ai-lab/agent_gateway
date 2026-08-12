// The bounded write counterpart to src/ndjson.js (the read side, untouched).
// Three lanes with strict priority, one byte budget derived into lane shares,
// and a deadline that only runs while the peer has stopped taking bytes.
import { ERROR_CODES, GatewayError } from "./errors.js";

export const LANE_HIGH = "high";
export const LANE_NORMAL = "normal";
export const LANE_LOW = "low";

// Priority order, and the only order the pump ever iterates.
const LANE_ORDER = [LANE_HIGH, LANE_NORMAL, LANE_LOW];
// Lane budgets are derived from one knob rather than configured. Three tunable
// byte caps would let an operator make HIGH unschedulable, so the split stays a
// property of the lane contract: HIGH is a reservation, LOW is the shock
// absorber. Only LOW is droppable — HIGH and NORMAL are never shed.
export const LANE_SHARE = Object.freeze({ [LANE_HIGH]: 1 / 8, [LANE_NORMAL]: 3 / 8, [LANE_LOW]: 1 / 2 });
export const DEFAULT_MAX_QUEUE_BYTES = 4_000_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;

export class NdjsonChannel {
  #drainHandler = () => this.#onDrain();

  constructor(stream, {
    maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    writeTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
    onFatal = null,
    onDrop = null
  } = {}) {
    this.stream = stream;
    this.maxQueueBytes = maxQueueBytes;
    this.maxFrameBytes = maxFrameBytes;
    this.writeTimeoutMs = writeTimeoutMs;
    this.onFatal = onFatal;
    this.onDrop = onDrop;
    this.lanes = new Map(LANE_ORDER.map((lane) => [lane, {
      lane,
      frames: [],
      bytes: 0,
      budget: Math.max(1, Math.floor(maxQueueBytes * LANE_SHARE[lane]))
    }]));
    this.queuedBytes = 0;
    this.blocked = false;
    this.closed = false;
    this.fatal = null;
    this.stats = { frames: 0, bytes: 0, dropped: 0, droppedBytes: 0, coalesced: 0 };
    this.timer = null;
    this.flushWaiters = [];
    stream.on("drain", this.#drainHandler);
  }

  // Returns false only for a dropped LOW frame. Everything else that cannot be
  // delivered throws synchronously, which is deliberate: the existing call sites
  // (and publishEvent's throw-based subscription pruning) are built on throws.
  write(lane, message, { coalesceKey = null, meta = null } = {}) {
    const state = this.lanes.get(lane);
    if (!state) throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Unknown transport lane: ${lane}`);
    if (this.closed || this.fatal) {
      throw new GatewayError(ERROR_CODES.TRANSPORT_CLOSED, this.fatal?.message ?? "Transport is closed");
    }
    if (this.#streamGone()) throw new GatewayError(ERROR_CODES.TRANSPORT_CLOSED, "Transport is closed");
    // Serialize once: the cap check, the byte accounting and the write all use
    // this exact buffer.
    const frame = Buffer.from(`${JSON.stringify(message)}\n`);
    // Checked before enqueue on purpose. A frame nobody can ever send must not
    // consume a lane budget on its way to being refused.
    if (frame.length > this.maxFrameBytes) {
      throw new GatewayError(ERROR_CODES.FRAME_TOO_LARGE, `NDJSON frame exceeds ${this.maxFrameBytes} bytes`);
    }
    // Fast path. Nothing is queued and the peer is taking bytes, so the frame
    // goes out inline and lane reordering is unobservable: callers that depend on
    // FIFO see exactly the order they saw before lanes existed. Reordering is
    // only ever visible under real backpressure.
    if (this.queuedBytes === 0 && !this.blocked) {
      this.#toStream(frame);
      return true;
    }
    if (coalesceKey != null) {
      const index = state.frames.findIndex((item) => item.coalesceKey === coalesceKey);
      if (index >= 0) {
        const previous = state.frames[index];
        const delta = frame.length - previous.frame.length;
        // Coalescing replaces a frame; it does not buy an exemption from the lane
        // budget. Without this check an update that grows on every revision walks
        // the lane arbitrarily far past its share while reporting itself as a
        // saving. The single-frame exemption still applies: when the superseded
        // frame is the only one in the lane, the lane is still admitting exactly
        // one frame, however large.
        if (delta > 0 && state.frames.length > 1 && state.bytes + delta > state.budget) {
          if (lane === LANE_LOW) {
            // The queued frame keeps its place, so the update is the one that
            // never arrives and the one the gap has to name.
            this.stats.dropped += 1;
            this.stats.droppedBytes += frame.length;
            this.onDrop?.([{ lane, bytes: frame.length, coalesceKey, meta }]);
            return false;
          }
          const error = new GatewayError(
            ERROR_CODES.TRANSPORT_CONGESTED,
            `Transport ${lane} lane exceeded ${state.budget} queued bytes`
          );
          this.#fail(error);
          throw error;
        }
        state.bytes += delta;
        this.queuedBytes += delta;
        // Keeps the older queue position: a superseded frame must not be able to
        // walk itself to the back of the lane by being updated.
        state.frames[index] = { frame, coalesceKey, meta, message };
        this.stats.coalesced += 1;
        // A superseded frame never arrives, so it is reported like any other
        // drop. Without this the receiver's cursor would advance past a sequence
        // it never saw, which is the silent loss the gap marker exists to prevent.
        this.onDrop?.([{ lane, bytes: previous.frame.length, coalesceKey, meta: previous.meta, coalesced: true }]);
        return true;
      }
    }
    // Load-bearing invariant: an empty lane always admits one frame, however
    // large. An 8MB terminal response must not become undeliverable because the
    // HIGH lane's derived share is 512KB. maxFrameBytes bounds a single frame,
    // the lane budget bounds a backlog.
    const exempt = state.frames.length === 0;
    if (!exempt && state.bytes + frame.length > state.budget) {
      if (lane === LANE_LOW) {
        this.stats.dropped += 1;
        this.stats.droppedBytes += frame.length;
        this.onDrop?.([{ lane, bytes: frame.length, coalesceKey, meta }]);
        return false;
      }
      const error = new GatewayError(
        ERROR_CODES.TRANSPORT_CONGESTED,
        `Transport ${lane} lane exceeded ${state.budget} queued bytes`
      );
      this.#fail(error);
      throw error;
    }
    state.frames.push({ frame, coalesceKey, meta, message });
    state.bytes += frame.length;
    this.queuedBytes += frame.length;
    return true;
  }

  // Lets a policy layer merge into a frame that is still queued: the daemon's
  // gap marker widens its own range instead of queueing a second marker.
  pending(lane, coalesceKey) {
    const found = this.lanes.get(lane)?.frames.find((item) => item.coalesceKey === coalesceKey);
    return found ? found.message : null;
  }

  // Lets a policy layer retract frames it has decided must not be delivered. The
  // daemon uses it for the one case lane priority creates: a reserved frame is
  // about to overtake droppable frames that were published before it, and a
  // receiver filtering on a monotonic cursor would discard those on arrival with
  // nothing to announce the loss. Retracting them reports them like any other
  // shed frame, which is what turns overtaking into an honest gap.
  dropWhere(lane, predicate) {
    const state = this.lanes.get(lane);
    if (!state || state.frames.length === 0) return 0;
    const kept = [];
    const dropped = [];
    for (const item of state.frames) {
      if (predicate(item)) dropped.push(item);
      else kept.push(item);
    }
    if (dropped.length === 0) return 0;
    let bytes = 0;
    for (const item of dropped) bytes += item.frame.length;
    state.frames = kept;
    state.bytes -= bytes;
    this.queuedBytes -= bytes;
    this.stats.dropped += dropped.length;
    this.stats.droppedBytes += bytes;
    // After the accounting is settled, never during it: onDrop writes the gap
    // marker back into this same channel.
    this.onDrop?.(dropped.map((item) => ({
      lane, bytes: item.frame.length, coalesceKey: item.coalesceKey, meta: item.meta
    })));
    return dropped.length;
  }

  whenFlushed() {
    if (this.fatal) return Promise.reject(this.fatal);
    if (this.#idle()) return Promise.resolve();
    return new Promise((resolve, reject) => this.flushWaiters.push({ resolve, reject }));
  }

  // Refuses new frames immediately, then gives the backlog a bounded chance to
  // reach the OS. A flush that does not finish in time is not an error: the
  // caller is already shutting this transport down.
  async close({ flushMs = 0 } = {}) {
    if (this.closed) return;
    this.closed = true;
    if (flushMs > 0 && !this.#idle()) {
      await Promise.race([
        this.whenFlushed().catch(() => {}),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, flushMs);
          timer.unref?.();
        })
      ]);
    }
    this.#teardown(new GatewayError(ERROR_CODES.TRANSPORT_CLOSED, "Transport is closed"));
  }

  // Synchronous teardown for an owner that already knows the transport is gone.
  // Never calls onFatal: the owner is the one doing the tearing down, and a
  // fatal callback here would re-enter its own teardown.
  destroy(error = null) {
    this.closed = true;
    this.#teardown(error ?? new GatewayError(ERROR_CODES.TRANSPORT_CLOSED, "Transport is closed"));
  }

  snapshot() {
    return {
      queuedBytes: this.queuedBytes,
      blocked: this.blocked,
      lanes: Object.fromEntries(LANE_ORDER.map((lane) => {
        const state = this.lanes.get(lane);
        return [lane, { frames: state.frames.length, bytes: state.bytes, budget: state.budget }];
      })),
      ...this.stats
    };
  }

  #idle() {
    return this.queuedBytes === 0 && !this.blocked;
  }

  #streamGone() {
    return this.stream.destroyed === true || this.stream.writable === false;
  }

  #toStream(frame) {
    this.stats.frames += 1;
    this.stats.bytes += frame.length;
    if (this.stream.write(frame)) return;
    // The peer stopped taking bytes. From here the deadline runs and lane order
    // becomes observable.
    this.blocked = true;
    this.#arm();
  }

  // Armed only while blocked, and restarted by every drain: the deadline measures
  // time since the OS last accepted a byte, not total time spent queued. A slow
  // but progressing reader is never killed.
  #arm() {
    if (this.timer || !(this.writeTimeoutMs > 0)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#fail(new GatewayError(
        ERROR_CODES.TRANSPORT_WRITE_TIMEOUT,
        `Transport made no write progress for ${this.writeTimeoutMs}ms`
      ));
    }, this.writeTimeoutMs);
    this.timer.unref?.();
  }

  #onDrain() {
    // Deliberately not gated on `closed`: close() stops accepting frames but
    // still wants the backlog it already accepted to reach the OS, and teardown
    // removes this listener when it is really over.
    if (this.fatal) return;
    this.blocked = false;
    this.#clearTimer();
    this.#pump();
    this.#settle();
  }

  #pump() {
    while (!this.blocked && this.queuedBytes > 0) {
      const state = LANE_ORDER.map((lane) => this.lanes.get(lane)).find((item) => item.frames.length > 0);
      if (!state) break;
      const item = state.frames.shift();
      state.bytes -= item.frame.length;
      this.queuedBytes -= item.frame.length;
      this.#toStream(item.frame);
    }
  }

  #settle() {
    if (!this.#idle()) return;
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  // Exactly once. Every transport's fatal handler is a teardown (socket.destroy,
  // RPC #disconnect, provider SIGTERM), so a second call would tear down a
  // connection that already belongs to the next generation.
  #fail(error) {
    if (this.fatal) return;
    this.fatal = error;
    this.#discard();
    this.#clearTimer();
    this.#rejectWaiters(error);
    this.onFatal?.(error);
  }

  #teardown(error) {
    this.#clearTimer();
    this.stream.off("drain", this.#drainHandler);
    this.#discard();
    this.fatal ??= error;
    this.#rejectWaiters(error);
  }

  // Queued frames are dropped silently. Reporting them through onDrop would ask
  // a dying connection to describe its own loss, and the policy layer would try
  // to write that report back into this channel.
  #discard() {
    for (const state of this.lanes.values()) {
      this.stats.dropped += state.frames.length;
      this.stats.droppedBytes += state.bytes;
      state.frames = [];
      state.bytes = 0;
    }
    this.queuedBytes = 0;
  }

  #rejectWaiters(error) {
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  #clearTimer() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
