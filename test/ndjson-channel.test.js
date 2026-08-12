import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_CODES } from "../src/errors.js";
import {
  LANE_HIGH, LANE_LOW, LANE_NORMAL, LANE_SHARE, NdjsonChannel
} from "../src/ndjson-channel.js";

// A deterministic Writable stand-in. `credits` is how many more frames the OS
// will accept before write() starts returning false, which makes backpressure a
// property of the test instead of the platform: real sockets auto-tune their
// buffers, so byte-level assertions against them are flaky on macOS.
class MockStream {
  constructor({ credits = Infinity } = {}) {
    this.credits = credits;
    this.frames = [];
    this.destroyed = false;
    this.drainHandlers = new Set();
  }

  write(frame) {
    // A frame that triggers backpressure is still handed to the stream, exactly
    // as Node does: write() buffers it and reports "no more".
    this.frames.push(frame.toString("utf8"));
    if (this.credits === Infinity) return true;
    if (this.credits > 0) {
      this.credits -= 1;
      return true;
    }
    return false;
  }

  on(event, handler) {
    if (event === "drain") this.drainHandlers.add(handler);
    return this;
  }

  off(event, handler) {
    if (event === "drain") this.drainHandlers.delete(handler);
    return this;
  }

  release(credits = 1) {
    this.credits += credits;
    for (const handler of [...this.drainHandlers]) handler();
  }

  tags() {
    return this.frames.map((line) => JSON.parse(line).tag);
  }
}

const isCode = (code) => (error) => error?.code === code;

test("lane shares derive from one queue budget and reserve HIGH", () => {
  const channel = new NdjsonChannel(new MockStream(), { maxQueueBytes: 4_000_000 });
  const lanes = channel.snapshot().lanes;
  assert.equal(lanes.high.budget, 500_000);
  assert.equal(lanes.normal.budget, 1_500_000);
  assert.equal(lanes.low.budget, 2_000_000);
  assert.equal(lanes.high.budget + lanes.normal.budget + lanes.low.budget, 4_000_000);
  assert.equal(LANE_SHARE[LANE_HIGH] + LANE_SHARE[LANE_NORMAL] + LANE_SHARE[LANE_LOW], 1);
});

test("without backpressure lanes are unobservable and delivery stays FIFO", () => {
  const stream = new MockStream();
  const channel = new NdjsonChannel(stream, { writeTimeoutMs: 0 });
  for (const [lane, tag] of [[LANE_LOW, "a"], [LANE_HIGH, "b"], [LANE_NORMAL, "c"], [LANE_LOW, "d"]]) {
    assert.equal(channel.write(lane, { tag }), true);
  }
  // The canary for R1: every existing FIFO-dependent caller runs on this path.
  assert.deepEqual(stream.tags(), ["a", "b", "c", "d"]);
  assert.equal(channel.snapshot().queuedBytes, 0);
  assert.equal(channel.blocked, false);
});

test("under backpressure a HIGH frame overtakes a queued LOW backlog", () => {
  const stream = new MockStream({ credits: 0 });
  const channel = new NdjsonChannel(stream, { maxQueueBytes: 1_000_000, writeTimeoutMs: 0 });
  channel.write(LANE_LOW, { tag: "inline" });
  assert.equal(channel.blocked, true);
  for (let index = 0; index < 5; index += 1) channel.write(LANE_LOW, { tag: `low-${index}` });
  channel.write(LANE_HIGH, { tag: "high" });
  channel.write(LANE_NORMAL, { tag: "normal" });
  stream.release(100);
  assert.deepEqual(stream.tags(), [
    "inline", "high", "normal", "low-0", "low-1", "low-2", "low-3", "low-4"
  ]);
});

test("a LOW frame is bounded behind the reserved lanes rather than starved", () => {
  const stream = new MockStream({ credits: 0 });
  const channel = new NdjsonChannel(stream, { maxQueueBytes: 1_000_000, writeTimeoutMs: 0 });
  channel.write(LANE_HIGH, { tag: "inline" });
  channel.write(LANE_LOW, { tag: "low" });
  const reserved = 16;
  for (let index = 0; index < reserved; index += 1) channel.write(LANE_HIGH, { tag: `high-${index}` });
  stream.release(1_000);
  // Position, not timing: the LOW frame leaves after the frames that were queued
  // ahead of it and nothing else. Priority delays it by a bounded amount.
  assert.equal(stream.tags().indexOf("low"), reserved + 1);
});

test("a stream that grants one credit at a time drains in strict lane order", () => {
  const stream = new MockStream({ credits: 0 });
  const channel = new NdjsonChannel(stream, { maxQueueBytes: 1_000_000, writeTimeoutMs: 0 });
  channel.write(LANE_NORMAL, { tag: "inline" });
  channel.write(LANE_LOW, { tag: "low" });
  channel.write(LANE_NORMAL, { tag: "normal" });
  channel.write(LANE_HIGH, { tag: "high" });
  // One credit moves two frames: the second is the one that re-blocks the stream,
  // which is exactly how Node's write() behaves at the high-water mark.
  stream.release(1);
  assert.deepEqual(stream.tags(), ["inline", "high", "normal"]);
  assert.equal(channel.blocked, true);
  stream.release(1);
  assert.deepEqual(stream.tags(), ["inline", "high", "normal", "low"]);
  assert.equal(channel.snapshot().queuedBytes, 0);
});

test("a peer that never drains exhausts a reserved lane and fails exactly once", () => {
  const stream = new MockStream({ credits: 0 });
  const fatals = [];
  const channel = new NdjsonChannel(stream, {
    maxQueueBytes: 8_000,
    writeTimeoutMs: 0,
    onFatal: (error) => fatals.push(error)
  });
  channel.write(LANE_NORMAL, { tag: "inline" });
  assert.throws(() => {
    for (let index = 0; index < 10_000; index += 1) {
      channel.write(LANE_NORMAL, { tag: `n-${index}`, pad: "x".repeat(100) });
    }
  }, isCode(ERROR_CODES.TRANSPORT_CONGESTED));
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].code, ERROR_CODES.TRANSPORT_CONGESTED);
  assert.equal(channel.snapshot().queuedBytes, 0, "a failed channel drops its backlog");
  // Every later write is refused as closed, and the fatal handler is not called
  // again: it is a teardown, and the next generation of the connection owns it.
  assert.throws(() => channel.write(LANE_NORMAL, { tag: "after" }), isCode(ERROR_CODES.TRANSPORT_CLOSED));
  assert.equal(fatals.length, 1);
});

test("a frame over the cap is refused before it can consume a lane budget", () => {
  const stream = new MockStream({ credits: 0 });
  const channel = new NdjsonChannel(stream, { maxQueueBytes: 4_000, maxFrameBytes: 200, writeTimeoutMs: 0 });
  channel.write(LANE_HIGH, { tag: "inline" });
  assert.throws(
    () => channel.write(LANE_HIGH, { tag: "big", pad: "x".repeat(400) }),
    isCode(ERROR_CODES.FRAME_TOO_LARGE)
  );
  assert.equal(channel.snapshot().queuedBytes, 0, "a refused frame reserves nothing");
  assert.equal(channel.write(LANE_HIGH, { tag: "small" }), true);
});

test("an empty lane admits one frame far over its derived budget", () => {
  const stream = new MockStream({ credits: 0 });
  const channel = new NdjsonChannel(stream, {
    maxQueueBytes: 4_000,
    maxFrameBytes: 8 * 1024 * 1024,
    writeTimeoutMs: 0
  });
  channel.write(LANE_NORMAL, { tag: "inline" });
  // The HIGH share of 4000 bytes is 500. A 2MB terminal answer still goes on:
  // maxFrameBytes bounds a frame, the lane budget bounds a backlog.
  assert.equal(channel.write(LANE_HIGH, { tag: "huge", pad: "x".repeat(2_000_000) }), true);
  const lanes = channel.snapshot().lanes;
  assert.ok(lanes.high.bytes > lanes.high.budget);
  // The exemption is for one frame, not for the lane.
  assert.throws(
    () => channel.write(LANE_HIGH, { tag: "second", pad: "y".repeat(2_000_000) }),
    isCode(ERROR_CODES.TRANSPORT_CONGESTED)
  );
});

test("LOW sheds frames at its budget, reports every drop, and spares HIGH", () => {
  const stream = new MockStream({ credits: 0 });
  const drops = [];
  const channel = new NdjsonChannel(stream, {
    maxQueueBytes: 4_000,
    writeTimeoutMs: 0,
    onDrop: (items) => drops.push(...items),
    onFatal: () => assert.fail("a saturated LOW lane must never be fatal")
  });
  channel.write(LANE_LOW, { tag: "inline" });
  let admitted = 0;
  let refused = 0;
  for (let index = 0; index < 200; index += 1) {
    const ok = channel.write(
      LANE_LOW,
      { tag: `low-${index}`, pad: "x".repeat(50) },
      { meta: { sessionId: "acp-1", sequence: index } }
    );
    if (ok) admitted += 1;
    else refused += 1;
  }
  assert.ok(admitted > 0, "the lane admits up to its budget");
  assert.ok(refused > 0, "and sheds beyond it");
  assert.equal(drops.length, refused);
  assert.equal(drops[0].lane, LANE_LOW);
  assert.equal(drops[0].meta.sessionId, "acp-1");
  assert.equal(typeof drops[0].meta.sequence, "number");
  // The whole point of the reservation: control traffic still gets through a
  // saturated stream of droppable chunks.
  assert.equal(channel.write(LANE_HIGH, { tag: "high" }), true);
  assert.equal(channel.write(LANE_NORMAL, { tag: "normal" }), true);
  stream.release(10_000);
  const tags = stream.tags();
  assert.equal(tags[1], "high");
  assert.equal(tags[2], "normal");
});

test("a coalesced frame replaces its predecessor in place", () => {
  const stream = new MockStream({ credits: 0 });
  const channel = new NdjsonChannel(stream, { maxQueueBytes: 1_000_000, writeTimeoutMs: 0 });
  channel.write(LANE_LOW, { tag: "inline" });
  channel.write(LANE_LOW, { tag: "keep" });
  channel.write(LANE_LOW, { tag: "update-1", version: 1 }, { coalesceKey: "tool-1" });
  channel.write(LANE_LOW, { tag: "update-2", version: 2 }, { coalesceKey: "tool-1" });
  channel.write(LANE_LOW, { tag: "other" }, { coalesceKey: "tool-2" });
  // pending() is what lets a policy layer widen a queued record instead of
  // queueing a second one.
  assert.equal(channel.pending(LANE_LOW, "tool-1").version, 2);
  assert.equal(channel.pending(LANE_LOW, "tool-9"), null);
  stream.release(100);
  assert.deepEqual(stream.tags(), ["inline", "keep", "update-2", "other"]);
  assert.equal(channel.snapshot().coalesced, 1);
});

test("the write deadline is armed only while blocked and restarts on progress", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = new MockStream({ credits: 0 });
  const fatals = [];
  const channel = new NdjsonChannel(stream, {
    maxQueueBytes: 1_000_000,
    writeTimeoutMs: 10_000,
    onFatal: (error) => fatals.push(error)
  });
  channel.write(LANE_NORMAL, { tag: "inline" });
  channel.write(LANE_NORMAL, { tag: "queued-1" });
  channel.write(LANE_NORMAL, { tag: "queued-2" });
  const flushed = channel.whenFlushed();
  t.mock.timers.tick(9_999);
  assert.equal(fatals.length, 0);
  // The OS took a byte. The deadline measures time since progress, so it starts
  // over: a slow but moving reader is never killed.
  stream.release(1);
  t.mock.timers.tick(9_999);
  assert.equal(fatals.length, 0, "progress restarts the deadline");
  t.mock.timers.tick(2);
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].code, ERROR_CODES.TRANSPORT_WRITE_TIMEOUT);
  await assert.rejects(flushed, isCode(ERROR_CODES.TRANSPORT_WRITE_TIMEOUT));
  assert.equal(channel.snapshot().queuedBytes, 0);
  assert.throws(() => channel.write(LANE_HIGH, { tag: "after" }), isCode(ERROR_CODES.TRANSPORT_CLOSED));
  assert.equal(fatals.length, 1);
});

test("an idle channel arms no deadline at all", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const channel = new NdjsonChannel(new MockStream(), { writeTimeoutMs: 10_000, onFatal: () => assert.fail("idle") });
  for (let index = 0; index < 100; index += 1) channel.write(LANE_NORMAL, { tag: index });
  assert.equal(channel.timer, null);
  t.mock.timers.tick(60_000);
});

test("whenFlushed resolves once the backlog reaches the stream", async () => {
  const stream = new MockStream({ credits: 0 });
  const channel = new NdjsonChannel(stream, { writeTimeoutMs: 0 });
  channel.write(LANE_HIGH, { tag: "inline" });
  channel.write(LANE_HIGH, { tag: "queued" });
  let settled = false;
  const flushed = channel.whenFlushed().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  stream.release(10);
  await flushed;
  assert.equal(settled, true);
  await channel.whenFlushed();
});

test("close refuses new frames and flushes within its budget", async () => {
  const stream = new MockStream({ credits: 0 });
  const channel = new NdjsonChannel(stream, { writeTimeoutMs: 0 });
  channel.write(LANE_HIGH, { tag: "inline" });
  channel.write(LANE_HIGH, { tag: "queued" });
  setTimeout(() => stream.release(10), 5);
  await channel.close({ flushMs: 250 });
  assert.deepEqual(stream.tags(), ["inline", "queued"]);
  assert.throws(() => channel.write(LANE_HIGH, { tag: "after" }), isCode(ERROR_CODES.TRANSPORT_CLOSED));
});

test("close gives up on a peer that never drains instead of hanging", async () => {
  const stream = new MockStream({ credits: 0 });
  const channel = new NdjsonChannel(stream, { writeTimeoutMs: 0 });
  channel.write(LANE_HIGH, { tag: "inline" });
  channel.write(LANE_HIGH, { tag: "stuck" });
  const started = Date.now();
  await channel.close({ flushMs: 30 });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(channel.snapshot().queuedBytes, 0);
});

test("destroy tears the channel down without calling onFatal", async () => {
  const stream = new MockStream({ credits: 0 });
  const channel = new NdjsonChannel(stream, {
    writeTimeoutMs: 0,
    onFatal: () => assert.fail("the owner is already tearing down")
  });
  channel.write(LANE_HIGH, { tag: "inline" });
  channel.write(LANE_HIGH, { tag: "queued" });
  const flushed = channel.whenFlushed();
  channel.destroy();
  await assert.rejects(flushed, isCode(ERROR_CODES.TRANSPORT_CLOSED));
  assert.equal(stream.drainHandlers.size, 0, "the drain listener is released");
  assert.throws(() => channel.write(LANE_HIGH, { tag: "after" }), isCode(ERROR_CODES.TRANSPORT_CLOSED));
});

test("a stream that is already gone reports a closed transport", () => {
  const stream = new MockStream();
  const channel = new NdjsonChannel(stream, { writeTimeoutMs: 0 });
  stream.destroyed = true;
  assert.throws(() => channel.write(LANE_HIGH, { tag: "after" }), isCode(ERROR_CODES.TRANSPORT_CLOSED));
  stream.destroyed = false;
  stream.writable = false;
  assert.throws(() => channel.write(LANE_HIGH, { tag: "after" }), isCode(ERROR_CODES.TRANSPORT_CLOSED));
});

test("frames are serialized once and framed with a single newline", () => {
  const stream = new MockStream();
  const channel = new NdjsonChannel(stream, { writeTimeoutMs: 0 });
  channel.write(LANE_HIGH, { tag: "unicode", text: "안녕 🌏" });
  assert.equal(stream.frames.length, 1);
  assert.equal(stream.frames[0].endsWith("\n"), true);
  assert.equal(stream.frames[0].indexOf("\n"), stream.frames[0].length - 1);
  assert.deepEqual(JSON.parse(stream.frames[0]), { tag: "unicode", text: "안녕 🌏" });
  assert.equal(channel.snapshot().bytes, Buffer.byteLength(stream.frames[0]));
});

test("an unknown lane is a programming error, not a silent drop", () => {
  const channel = new NdjsonChannel(new MockStream(), { writeTimeoutMs: 0 });
  assert.throws(() => channel.write("urgent", { tag: "x" }), isCode(ERROR_CODES.INVALID_ARGUMENT));
});
