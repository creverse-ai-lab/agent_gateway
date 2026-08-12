import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { createSocketSender } from "../src/socket-flow.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";

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
});

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
  sender.sendEvent("sub-1", { sessionId: "session-a", sequence: 3, type: "turn_end" });
  sender.sendEvent("sub-1", { sessionId: "session-a", sequence: 4, type: "permission_request" });
  sender.send({ id: "rpc-1", ok: true });
  socket.release();
  const order = socket.messages().map((message) => message.id ?? message.event?.type);
  assert.deepEqual(order, [
    "agent_message_chunk",     // inline, before any backpressure existed
    "rpc-1",                   // HIGH
    "turn_end",                // NORMAL
    "permission_request",      // NORMAL
    "agent_message_chunk",     // LOW
    "invented_future_type"     // LOW: unknown types are droppable by default
  ]);
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
