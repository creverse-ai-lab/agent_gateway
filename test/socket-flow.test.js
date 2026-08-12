import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { ERROR_CODES } from "../src/errors.js";
import { createSocketSender } from "../src/socket-flow.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";

const isCode = (code) => (error) => error?.code === code;

// The socket stand-in gained drain plumbing (the sender owns a write channel now)
// and a credit model, so backpressure is a property of the test rather than of the
// platform. writableLength is still set directly: it is what the OS-side gates read.
function mockSocket({ writableLength = 0, credits = Infinity } = {}) {
  return {
    destroyed: false,
    destroyError: null,
    writableLength,
    credits,
    frames: [],
    drainHandlers: new Set(),
    write(value) {
      this.frames.push(value.toString("utf8"));
      if (this.credits === Infinity) return true;
      if (this.credits > 0) {
        this.credits -= 1;
        return true;
      }
      return false;
    },
    on(event, handler) {
      if (event === "drain") this.drainHandlers.add(handler);
      return this;
    },
    off(event, handler) {
      if (event === "drain") this.drainHandlers.delete(handler);
      return this;
    },
    destroy(error) {
      this.destroyed = true;
      this.destroyError = error ?? null;
    },
    release(credits = 1_000_000) {
      this.credits += credits;
      for (const handler of [...this.drainHandlers]) handler();
    },
    messages() {
      return this.frames
        .flatMap((frame) => frame.split("\n"))
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    }
  };
}

const chunk = (sequence, text = "x") => ({
  sessionId: "session-a", sequence, type: "agent_message_chunk", text
});

// Preserved from 1.3.2: a subscriber that never opted into gap tolerance is still
// removed and told why, and the control connection it shares stays usable.
test("slow subscription is removed while the control connection remains usable", () => {
  const removed = [];
  const socket = mockSocket({ writableLength: 101 });
  const sender = createSocketSender(socket, {
    unsubscribe: (id) => removed.push(`service:${id}`),
    removeSubscription: (id) => removed.push(`socket:${id}`),
    maxSubscriptionBytes: 100,
    maxQueueBytes: 400
  });
  assert.equal(sender.sendEvent("sub-slow", { sequence: 1 }), false);
  assert.deepEqual(removed, ["service:sub-slow", "socket:sub-slow"]);
  assert.equal(socket.destroyed, false);
  const writes = socket.messages();
  assert.equal(writes[0].type, "subscription_error");
  sender.send({ id: "control", ok: true });
  assert.equal(socket.messages()[1].id, "control");
});

// Preserved from 1.3.2, with the knob renamed: the OS-side gate stays a separate
// check from the channel's own queue accounting, never a sum of the two.
test("hard connection backpressure destroys the whole socket", () => {
  const socket = mockSocket({ writableLength: 401 });
  const sender = createSocketSender(socket, {
    unsubscribe() {},
    removeSubscription() {},
    maxSubscriptionBytes: 100,
    maxQueueBytes: 400
  });
  assert.throws(() => sender.send({ id: "control" }), /connection buffer exceeded/);
  assert.equal(socket.destroyed, true);
});

test("an opted-in subscriber that falls behind is shed, not killed", () => {
  const removed = [];
  const socket = mockSocket({ writableLength: 2_000_000, credits: 0 });
  const sender = createSocketSender(socket, {
    subscriptions: new Map([["sub-1", { acceptsGaps: true }]]),
    unsubscribe: (id) => removed.push(id),
    removeSubscription: (id) => removed.push(id),
    maxSubscriptionBytes: 100,
    maxQueueBytes: 4_000,
    writeTimeoutMs: 0
  });
  // The first frame goes out inline and blocks the socket; the rest queue on LOW
  // until its derived share is gone.
  assert.equal(sender.sendEvent("sub-1", chunk(0)), true);
  let shed = 0;
  let firstShed = null;
  for (let sequence = 1; sequence <= 200; sequence += 1) {
    if (sender.sendEvent("sub-1", chunk(sequence, "y".repeat(60)))) continue;
    firstShed ??= sequence;
    shed += 1;
  }
  assert.ok(shed > 0, "the lane sheds once its budget is gone");
  // Not the 1.3.2 outcome: the subscription is still alive.
  assert.deepEqual(removed, []);
  assert.equal(socket.destroyed, false);
  socket.release();
  const gaps = socket.messages().filter((message) => message.type === "subscription_gap");
  assert.equal(gaps.length, 1, "an arbitrarily long drop run costs one marker");
  assert.equal(gaps[0].subscriptionId, "sub-1");
  assert.equal(gaps[0].sessionId, "session-a");
  assert.equal(gaps[0].reason, "slow_subscriber");
  assert.equal(gaps[0].fromSequence, firstShed);
  assert.equal(gaps[0].toSequence, 200);
  assert.equal(gaps[0].droppedCount, shed);
  // Deliberately absent: a finite sequence here would advance the receiver's
  // cursor past the range the marker exists to announce.
  assert.equal(Object.hasOwn(gaps[0], "sequence"), false);
});

// The backlog moved into the channel, so the "too slow" measure had to move with
// it. Without that, a subscriber that never opted in would be shed in silence —
// the one outcome the opt-in gate exists to prevent.
test("a subscriber that never opted in is killed by real backpressure, never shed", () => {
  const removed = [];
  const socket = mockSocket({ credits: 0 });
  const subscriptions = new Map([["sub-old", { acceptsGaps: false }]]);
  const sender = createSocketSender(socket, {
    subscriptions,
    unsubscribe: (id) => removed.push(`service:${id}`),
    removeSubscription: (id) => {
      removed.push(`socket:${id}`);
      subscriptions.delete(id);
    },
    maxSubscriptionBytes: 20_000,
    maxQueueBytes: 4_000_000,
    writeTimeoutMs: 0
  });
  let killedAt = null;
  for (let sequence = 0; sequence < 5_000 && killedAt === null; sequence += 1) {
    if (sender.sendEvent("sub-old", chunk(sequence, "y".repeat(60))) === false) killedAt = sequence;
  }
  assert.ok(killedAt !== null, "the subscription is removed once it falls behind");
  assert.deepEqual(removed, ["service:sub-old", "socket:sub-old"]);
  assert.equal(socket.destroyed, false, "the control connection survives");
  socket.release();
  const messages = socket.messages();
  assert.equal(messages.some((message) => message.type === "subscription_gap"), false,
    "a client that cannot understand a gap marker is never sent one");
  const error = messages.find((message) => message.type === "subscription_error");
  assert.equal(error.error, "Gateway subscriber is too slow");
  assert.equal(error.subscriptionId, "sub-old");
  // Everything it was sent before the kill arrived, in the order it was published.
  // A client that cannot be told about a loss must not be made to suffer one.
  const delivered = messages
    .filter((message) => message.type === "event")
    .map((message) => message.event.sequence);
  assert.deepEqual(delivered, [...Array(killedAt).keys()]);
});

// The other half of the opt-in gate, and the one the old comment claimed without
// implementing: coalescing is a loss too. Superseding a queued frame means a
// sequence never arrives, which is exactly what a non-opting client has no way to
// learn about.
test("a subscriber that never opted in is never coalesced", () => {
  const socket = mockSocket({ credits: 0 });
  const sender = createSocketSender(socket, {
    subscriptions: new Map([["sub-old", { acceptsGaps: false }]]),
    unsubscribe() {},
    removeSubscription() {},
    maxSubscriptionBytes: 1_000_000,
    maxQueueBytes: 4_000_000,
    writeTimeoutMs: 0
  });
  const update = (sequence) => ({
    sessionId: "session-a",
    sequence,
    type: "tool_call_update",
    data: { toolCallId: "tool-1", status: `step-${sequence}` }
  });
  sender.sendEvent("sub-old", update(0));
  for (let sequence = 1; sequence <= 20; sequence += 1) {
    assert.equal(sender.sendEvent("sub-old", update(sequence)), true);
  }
  socket.release();
  const updates = socket.messages().filter((message) => message.event?.type === "tool_call_update");
  assert.equal(updates.length, 21, "every revision is delivered, stale or not");
  assert.deepEqual(updates.map((message) => message.event.sequence), [...Array(21).keys()]);
  assert.equal(socket.messages().some((message) => message.type === "subscription_gap"), false);
  assert.equal(sender.channel.snapshot().coalesced, 0);
  assert.equal(sender.channel.snapshot().dropped, 0);
});

// The gate it replaces compared socket.writableLength against the connection
// budget, which the channel made unreachable: it stops feeding the socket at a
// 16KB high-water mark, so a megabytes-deep backlog now sits in the channel and
// the OS-side number never moves. Whichever buffer holds it, four megabytes behind
// is four megabytes behind.
test("a backlog held by the channel trips the connection gate, not just the socket buffer", () => {
  const socket = mockSocket({ credits: 0 });
  const sender = createSocketSender(socket, {
    subscriptions: new Map([["sub-1", { acceptsGaps: true }]]),
    unsubscribe() {},
    removeSubscription() {},
    maxSubscriptionBytes: 1_000_000,
    maxQueueBytes: 400,
    writeTimeoutMs: 0
  });
  sender.sendEvent("sub-1", chunk(0, "inline"));
  // One frame far over the whole connection budget: an empty lane always admits
  // it, so this is the case where the channel really is holding more than the
  // connection is allowed to be behind.
  sender.sendEvent("sub-1", chunk(1, "y".repeat(2_000)));
  assert.equal(socket.writableLength, 0, "the OS-side buffer never sees it");
  assert.ok(sender.channel.queuedBytes > 400);
  assert.throws(() => sender.send({ id: "control" }), /connection buffer exceeded/);
  assert.equal(socket.destroyed, true);
});

// Reworked for the overtaking fix: durable events used to be queued here purely
// to watch them jump the droppable backlog, which is the reordering that made a
// receiver discard the jumped frames in silence. Overtaking now retracts what it
// passes, so the lane table is asserted with the traffic that has no other lane to
// jump — reserved control frames over droppable event frames.
test("the lane table reserves control traffic and defaults new types to droppable", () => {
  const socket = mockSocket({ credits: 0 });
  const sender = createSocketSender(socket, {
    subscriptions: new Map([["sub-1", { acceptsGaps: true }]]),
    unsubscribe() {},
    removeSubscription() {},
    maxQueueBytes: 1_000_000,
    writeTimeoutMs: 0
  });
  sender.sendEvent("sub-1", chunk(0, "inline"));
  sender.sendEvent("sub-1", chunk(1, "streamed"));
  sender.sendEvent("sub-1", { sessionId: "session-a", sequence: 2, type: "invented_future_type" });
  sender.send({ id: "rpc-1", ok: true });
  socket.release();
  const order = socket.messages().map((message) => message.id ?? message.event?.type);
  assert.deepEqual(order, [
    "agent_message_chunk",     // inline, before any backpressure existed
    "rpc-1",                   // HIGH, ahead of a droppable backlog
    "agent_message_chunk",     // LOW
    "invented_future_type"     // LOW: unknown types are droppable by default
  ]);
  // Nothing was passed, so nothing was retracted: reordering across lanes is what
  // costs frames, and there is none here.
  assert.equal(socket.messages().some((message) => message.type === "subscription_gap"), false);
});

// The silent-loss path this fix closes: LOW chunks 2-4 are queued when turn_end
// (sequence 5, a durable event on the reserved lane) is published. Strict lane
// priority transmits turn_end first, the receiver's cursor advances past 5, and
// the chunks that arrive afterwards are discarded on arrival — transmitted, so
// never reported as dropped, and therefore never recoverable. Both halves are
// asserted here: the daemon retracts what it overtakes, and a real client's
// delivery path proves nothing goes missing without being named.
test("a durable event that overtakes queued chunks retracts them into a gap instead of losing them", async () => {
  const socket = mockSocket({ credits: 0 });
  const sender = createSocketSender(socket, {
    subscriptions: new Map([["sub-1", { acceptsGaps: true }]]),
    unsubscribe() {},
    removeSubscription() {},
    maxQueueBytes: 1_000_000,
    writeTimeoutMs: 0
  });
  sender.sendEvent("sub-1", chunk(1, "inline"));
  for (const sequence of [2, 3, 4]) sender.sendEvent("sub-1", chunk(sequence));
  sender.sendEvent("sub-1", { sessionId: "session-a", sequence: 5, type: "turn_end" });
  // Published after the durable event, so it was never overtaken and is left
  // alone: only frames the receiver's cursor filter would discard are retracted.
  sender.sendEvent("sub-1", chunk(6, "after"));
  socket.release();

  const wire = socket.messages();
  assert.deepEqual(wire.map((message) => message.type === "event" ? message.event.sequence : message.type), [
    1,                     // inline, before any backpressure existed
    "subscription_gap",    // the retracted range, ahead of the frame that passed it
    5,
    6
  ], "per-session wire order is monotonic again, and the hole is announced before it matters");
  const gap = wire.find((message) => message.type === "subscription_gap");
  assert.equal(gap.fromSequence, 2);
  assert.equal(gap.toSequence, 4);
  assert.equal(gap.droppedCount, 3);
  assert.equal(Object.hasOwn(gap, "sequence"), false);

  // The other half: that exact wire, through the real client delivery path.
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-overtake-"));
  const socketPath = join(directory, "gateway.sock");
  const client = new GatewayRpcClient({ socketPath, token: "t".repeat(24), rootId: "main-a", autoStart: false });
  const received = [];
  let first = null;
  let second = null;
  let restoredCursor = null;
  try {
    first = await startServer(socketPath, (request) => [
      { id: request.id, ok: true, result: { subscriptionId: "sub-1", sessions: [], events: [], cursorTruncated: {} } },
      ...wire
    ]);
    await client.subscribe({ sessionIds: ["session-a"] }, (event) => received.push(event));
    await waitFor(() => received.some((event) => event.sequence === 6));
    // Delivered in order, and the range that never arrived is named rather than
    // absent. Without the retraction, 2-4 reached this client after 5 and #deliver
    // dropped all three without a word.
    assert.deepEqual(received.map((event) => event.sequence ?? event.type), [1, "subscription_gap", 5, 6]);

    for (const socket of first.sockets) socket.destroy();
    first.server.close();
    await once(first.server, "close");
    await unlink(socketPath).catch(() => {});

    second = await startServer(socketPath, (request) => {
      restoredCursor = request.args?.cursors?.["session-a"];
      return [{
        id: request.id,
        ok: true,
        result: {
          subscriptionId: "sub-2",
          sessions: [],
          events: [2, 3, 4].map((sequence) => ({ sessionId: "session-a", sequence, type: "replayed" })),
          cursorTruncated: { "session-a": false }
        }
      }];
    });
    await waitFor(() => received.filter((event) => event.type === "replayed").length === 3);
    assert.equal(restoredCursor, 2, "the gap floor rewinds the resubscribe to the first retracted sequence");
  } finally {
    client.close();
    for (const fixture of [first, second]) {
      if (!fixture) continue;
      for (const socket of fixture.sockets) socket.destroy();
      if (fixture.server.listening) {
        fixture.server.close();
        await once(fixture.server, "close");
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("a durable event is never dropped even while the droppable lane is saturated", () => {
  const socket = mockSocket({ credits: 0 });
  const sender = createSocketSender(socket, {
    subscriptions: new Map([["sub-1", { acceptsGaps: true }]]),
    unsubscribe() {},
    removeSubscription() {},
    maxQueueBytes: 4_000,
    writeTimeoutMs: 0
  });
  sender.sendEvent("sub-1", chunk(0));
  for (let sequence = 1; sequence <= 400; sequence += 1) {
    sender.sendEvent("sub-1", chunk(sequence, "y".repeat(60)));
  }
  assert.equal(sender.sendEvent("sub-1", { sessionId: "session-a", sequence: 401, type: "permission_request" }), true);
  socket.release();
  const delivered = socket.messages().filter((message) => message.event?.type === "permission_request");
  assert.equal(delivered.length, 1);
});

test("tool_call_update is coalesced by tool call, keeping the newest state", () => {
  const socket = mockSocket({ credits: 0 });
  const sender = createSocketSender(socket, {
    subscriptions: new Map([["sub-1", { acceptsGaps: true }]]),
    unsubscribe() {},
    removeSubscription() {},
    maxQueueBytes: 1_000_000,
    writeTimeoutMs: 0
  });
  sender.sendEvent("sub-1", chunk(0, "inline"));
  for (let sequence = 1; sequence <= 20; sequence += 1) {
    sender.sendEvent("sub-1", {
      sessionId: "session-a",
      sequence,
      type: "tool_call_update",
      data: { toolCallId: "tool-1", status: `step-${sequence}` }
    });
  }
  socket.release();
  const updates = socket.messages().filter((message) => message.event?.type === "tool_call_update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].event.data.status, "step-20");
  // A superseded frame never arrived, so it is announced like any other loss.
  const gaps = socket.messages().filter((message) => message.type === "subscription_gap");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].fromSequence, 1);
});

// The tripwire for R2: without the gapFloor fix the resubscribe asks for 6 and the
// dropped range is lost silently forever, which is worse than the error it replaced.
test("a gap marker rewinds the resubscribe cursor to the first dropped sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-gapfloor-"));
  const socketPath = join(directory, "gateway.sock");
  const client = new GatewayRpcClient({ socketPath, token: "t".repeat(24), rootId: "main-a", autoStart: false });
  const received = [];
  let first = null;
  let second = null;
  let restoredCursor = null;
  let acceptsGaps = null;
  try {
    first = await startServer(socketPath, (request) => {
      acceptsGaps = request.args?.acceptsGaps;
      return [
        { id: request.id, ok: true, result: { subscriptionId: "server-sub-1", sessions: [], events: [], cursorTruncated: {} } },
        { type: "event", subscriptionId: "server-sub-1", event: { sessionId: "session-a", sequence: 0, type: "turn_start" } },
        {
          type: "subscription_gap",
          subscriptionId: "server-sub-1",
          sessionId: "session-a",
          fromSequence: 1,
          toSequence: 4,
          droppedCount: 4,
          reason: "slow_subscriber"
        },
        { type: "event", subscriptionId: "server-sub-1", event: { sessionId: "session-a", sequence: 5, type: "turn_end" } }
      ];
    });
    await waitFor(() => true);
    const subscription = await client.subscribe({ sessionIds: ["session-a"] }, (event) => received.push(event));
    await waitFor(() => received.some((event) => event.sequence === 5));
    assert.equal(acceptsGaps, true, "this client opts into being shed");
    assert.ok(received.some((event) => event.type === "subscription_gap"));

    for (const socket of first.sockets) socket.destroy();
    first.server.close();
    await once(first.server, "close");
    await unlink(socketPath).catch(() => {});

    second = await startServer(socketPath, (request) => {
      if (request.method !== "subscribe") return [{ id: request.id, ok: true, result: { removed: true } }];
      restoredCursor = request.args.cursors?.["session-a"];
      return [
        {
          id: request.id,
          ok: true,
          result: {
            subscriptionId: "server-sub-2",
            sessions: [],
            events: [{ sessionId: "session-a", sequence: 2, type: "replayed" }],
            cursorTruncated: { "session-a": false }
          }
        },
        { type: "event", subscriptionId: "server-sub-2", event: { sessionId: "session-a", sequence: 6, type: "live" } }
      ];
    });
    await waitFor(() => received.some((event) => event.sequence === 6));
    assert.equal(restoredCursor, 1, "the cursor is rewound to the gap floor, not the last delivered sequence");
    // The replay inside the rewound range is delivered, which is the whole point.
    assert.ok(received.some((event) => event.type === "replayed"));
    assert.equal((await client.unsubscribe(subscription.subscriptionId)).removed, true);
  } finally {
    client.close();
    for (const fixture of [first, second]) {
      if (!fixture) continue;
      for (const socket of fixture.sockets) socket.destroy();
      if (fixture.server.listening) {
        fixture.server.close();
        await once(fixture.server, "close");
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

// The premise the daemon's error-reply guard got wrong. It sends a failure reply
// under `if (!socket.destroyed)`, as though a live socket meant a writable one —
// but the channel refuses a write the moment the stream stops being writable, and
// nothing has destroyed the socket at that point. The throw escapes the async line
// handler as an unhandled rejection, and there is no handler for those: the daemon
// exits, taking every other connection with it, over a reply nobody is waiting for.
// Hence the reply is wrapped in its own try/catch.
test("a refused write does not mean a destroyed socket", () => {
  const socket = mockSocket();
  const sender = createSocketSender(socket, {
    unsubscribe() {},
    removeSubscription() {},
    maxQueueBytes: 4_000_000,
    writeTimeoutMs: 0
  });
  // Exactly what a peer's half-close leaves behind: the write side is gone, the
  // socket is not.
  socket.writable = false;
  assert.equal(socket.destroyed, false);
  assert.throws(() => sender.send({ id: "reply", ok: false, error: "boom" }), isCode(ERROR_CODES.TRANSPORT_CLOSED));
  assert.equal(socket.destroyed, false, "the guard the daemon reads would have waved this through");
});

// gapFloor lowers a cursor; it must never create one. A session with no cursor is
// already asking the ring for everything it holds, so writing the floor in as a
// new cursor raises the effective start from 0 to the floor — and every sequence
// below it is skipped by the server on replay and by #deliver on arrival.
test("a gap for a session with no cursor leaves the replay asking for everything", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-nocursor-"));
  const socketPath = join(directory, "gateway.sock");
  const client = new GatewayRpcClient({ socketPath, token: "t".repeat(24), rootId: "main-a", autoStart: false });
  const received = [];
  let first = null;
  let second = null;
  let restored = null;
  try {
    first = await startServer(socketPath, (request) => [
      { id: request.id, ok: true, result: { subscriptionId: "sub-1", sessions: [], events: [], cursorTruncated: {} } },
      { type: "event", subscriptionId: "sub-1", event: { sessionId: "session-a", sequence: 0, type: "turn_start" } },
      // session-b has never delivered an event to this client, so it has no cursor.
      {
        type: "subscription_gap",
        subscriptionId: "sub-1",
        sessionId: "session-b",
        fromSequence: 7,
        toSequence: 9,
        droppedCount: 3,
        reason: "slow_subscriber"
      }
    ]);
    await client.subscribe({ sessionIds: ["session-a", "session-b"] }, (event) => received.push(event));
    await waitFor(() => received.some((event) => event.type === "subscription_gap"));

    for (const socket of first.sockets) socket.destroy();
    first.server.close();
    await once(first.server, "close");
    await unlink(socketPath).catch(() => {});

    second = await startServer(socketPath, (request) => {
      restored = request.args?.cursors ?? {};
      return [{
        id: request.id,
        ok: true,
        result: { subscriptionId: "sub-2", sessions: [], events: [], cursorTruncated: {} }
      }];
    });
    await waitFor(() => restored !== null);
    assert.equal(Object.hasOwn(restored, "session-b"), false,
      "an absent cursor stays absent: 7 would have skipped sequences 0 to 6 that were never sent");
    assert.equal(restored["session-a"], 1, "a cursor that does exist is still carried");
  } finally {
    client.close();
    for (const fixture of [first, second]) {
      if (!fixture) continue;
      for (const socket of fixture.sockets) socket.destroy();
      if (fixture.server.listening) {
        fixture.server.close();
        await once(fixture.server, "close");
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(socketPath, respond) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    createInterface({ input: socket }).on("line", (line) => {
      const messages = respond(JSON.parse(line));
      socket.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { server, sockets };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not reached");
}
