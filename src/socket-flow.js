import { DURABLE_EVENT_TYPES } from "./gateway-service.js";
import {
  DEFAULT_MAX_QUEUE_BYTES, LANE_HIGH, LANE_LOW, LANE_NORMAL, NdjsonChannel
} from "./ndjson-channel.js";

// The threshold at which a subscriber is declared too slow. Unchanged, and it now
// only governs subscribers that did not opt into gap tolerance: for those the
// outcome is exactly what it has always been.
export const MAX_SOCKET_BUFFER_BYTES = 1_000_000;

// Lane policy for the daemon -> Main connection, the only transport with
// droppable traffic. NdjsonChannel is subscription-ignorant on purpose, so this
// layer owns the type table, the gap record and the gap-tolerance registry.
const HIGH_EVENT_TYPES = new Set(["subscription_error"]);

// Anything not named here is droppable. Default-deny is deliberate: a new event
// type arrives on LOW and gets promoted knowingly, instead of quietly acquiring
// the right to congest a connection. Control events ride NORMAL rather than HIGH
// because HIGH is a reservation for correctness traffic, and the authoritative
// delivery path for a permission is the inbox that Main pulls anyway.
function laneForEvent(event) {
  const type = event?.type;
  if (typeof type !== "string") return LANE_LOW;
  if (HIGH_EVENT_TYPES.has(type)) return LANE_HIGH;
  if (DURABLE_EVENT_TYPES.has(type)) return LANE_NORMAL;
  return LANE_LOW;
}

// tool_call_update is the one type where a later frame fully supersedes an earlier
// one, so a slow subscriber receives the newest state of a call instead of a queue
// of stale ones. The superseded frame is still reported as a drop, which is what
// keeps the receiver's cursor honest.
function coalesceKeyForEvent(event) {
  if (event?.type !== "tool_call_update") return null;
  const toolCallId = event.data?.toolCallId ?? event.toolCallId ?? null;
  return toolCallId == null ? null : `tool:${event.sessionId}:${toolCallId}`;
}

export function createSocketSender(socket, {
  subscriptions = new Map(),
  unsubscribe,
  removeSubscription,
  maxSubscriptionBytes = MAX_SOCKET_BUFFER_BYTES,
  maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES,
  writeTimeoutMs,
  maxFrameBytes
}) {
  const channel = new NdjsonChannel(socket, {
    maxQueueBytes,
    writeTimeoutMs,
    maxFrameBytes,
    // The socket's own close handler already does the cleanup, and ten seconds
    // without the peer taking a byte is the primary stall trigger.
    onFatal: (error) => socket.destroy(error),
    onDrop: (items) => reportGaps(items)
  });

  // The channel reports what it shed; this turns it into the wire record. NORMAL
  // because HIGH is reserved and NORMAL is never dropped, so a marker announcing
  // loss cannot itself be lost. There is deliberately no `sequence` field: a
  // finite one would advance the receiver's cursor past the range it just lost.
  function reportGaps(items) {
    for (const item of items) {
      // Only shed subscriber traffic produces gaps. Skipping the other lanes also
      // stops a coalesced gap marker from reporting itself.
      if (item.lane !== LANE_LOW) continue;
      const { subscriptionId, sessionId, sequence } = item.meta ?? {};
      if (subscriptionId == null || !Number.isFinite(sequence)) continue;
      const coalesceKey = `gap:${subscriptionId}:${sessionId}`;
      // Widen the marker that is still queued instead of queueing another one, so
      // an arbitrarily long drop run costs one frame on a lane that cannot shed.
      const queued = channel.pending(LANE_NORMAL, coalesceKey);
      try {
        channel.write(LANE_NORMAL, {
          type: "subscription_gap",
          subscriptionId,
          sessionId,
          fromSequence: queued ? Math.min(queued.fromSequence, sequence) : sequence,
          toSequence: queued ? Math.max(queued.toSequence, sequence) : sequence,
          droppedCount: (queued?.droppedCount ?? 0) + 1,
          reason: "slow_subscriber"
        }, { coalesceKey });
      } catch {
        // The connection is already failing; onFatal has the teardown.
      }
    }
  }

  // Verbatim: the OS-side buffer gate stays a separate check from the channel's
  // own queue accounting. The two are never summed — that would double-count the
  // same backpressure and halve the real budget.
  const send = (message) => {
    if (socket.destroyed) throw new Error("Gateway socket closed");
    if (socket.writableLength > maxQueueBytes) {
      socket.destroy(new Error("Gateway connection buffer exceeded"));
      throw new Error("Gateway connection buffer exceeded");
    }
    channel.write(LANE_HIGH, message);
  };

  return {
    channel,
    send,
    sendEvent(subscriptionId, event) {
      if (socket.destroyed) throw new Error("Gateway socket closed");
      // A subscriber that did not opt in keeps today's behavior exactly: too far
      // behind means the subscription is removed and told why. A vendored old
      // client can therefore never receive a gap marker, so its cursor can never
      // be poisoned by one.
      //
      // Which buffer counts as "behind" had to move with the backlog. Before this
      // channel existed, everything not yet on the wire sat in the socket, so
      // writableLength was the whole answer; now the channel stops feeding the
      // socket at its high-water mark and holds the rest, so the socket alone
      // would never reach a megabyte again and this subscriber would be shed in
      // silence instead of being told. Either buffer passing the threshold means
      // this connection is a megabyte behind — a max, never a sum, because summing
      // the two would count the same backpressure twice.
      if (subscriptions.get(subscriptionId)?.acceptsGaps !== true) {
        if (socket.writableLength > maxSubscriptionBytes || channel.queuedBytes > maxSubscriptionBytes) {
          unsubscribe(subscriptionId);
          removeSubscription(subscriptionId);
          if (socket.writableLength <= maxQueueBytes) {
            send({ type: "subscription_error", subscriptionId, error: "Gateway subscriber is too slow" });
          }
          return false;
        }
      }
      const lane = laneForEvent(event);
      return channel.write(lane, { type: "event", subscriptionId, event }, {
        coalesceKey: lane === LANE_LOW ? coalesceKeyForEvent(event) : null,
        // What reportGaps needs to describe the loss. The channel never reads it.
        meta: lane === LANE_LOW ? { subscriptionId, sessionId: event?.sessionId, sequence: event?.sequence } : null
      });
    },
    destroy(error = null) {
      channel.destroy(error);
    }
  };
}
