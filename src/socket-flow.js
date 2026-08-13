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
//
// No event type rides HIGH. HIGH is the reservation for this connection's control
// traffic — RPC replies, shutdown acks and subscription_error — and every one of
// those goes out through send() below, never through an event frame. A table
// naming event types for HIGH only looked like it did something.
//
// Anything not named durable is droppable. Default-deny is deliberate: a new event
// type arrives on LOW and gets promoted knowingly, instead of quietly acquiring
// the right to congest a connection. Control events ride NORMAL rather than HIGH
// because HIGH is a reservation for correctness traffic, and the authoritative
// delivery path for a permission is the inbox that Main pulls anyway.
function laneForEvent(event) {
  const type = event?.type;
  if (typeof type !== "string") return LANE_LOW;
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
      // A subscriber that never opted in must never be handed a record it cannot
      // interpret. Nothing of its own reaches the droppable lane, so this is a
      // backstop rather than the gate — but the gate has to exist here too, or
      // the opt-in only covers the shed decision and not the marker itself.
      if (subscriptions.get(subscriptionId)?.acceptsGaps !== true) continue;
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

  // How far behind this connection is. Which buffer counts had to move with the
  // backlog: before the channel existed everything not yet on the wire sat in the
  // socket, so writableLength was the whole answer; now the channel stops feeding
  // the socket at its high-water mark and holds the rest, so the socket alone
  // would never reach a megabyte again and the gates below would be unreachable.
  // These are disjoint buffers: writableLength is already handed to Node/the OS,
  // queuedBytes is still owned by the channel. The connection budget covers the
  // sum so neither layer can hide backlog in the other.
  const backlog = () => socket.writableLength + channel.queuedBytes;

  const send = (message) => {
    if (socket.destroyed) throw new Error("Gateway socket closed");
    if (backlog() > maxQueueBytes) {
      socket.destroy(new Error("Gateway connection buffer exceeded"));
      throw new Error("Gateway connection buffer exceeded");
    }
    channel.write(LANE_HIGH, message);
  };

  // Lane priority reorders a session's own events under backpressure: a reserved
  // frame published after a run of droppable ones leaves ahead of them. The
  // receiver filters on a monotonic cursor, so those droppable frames — which were
  // transmitted, and therefore never reported as dropped — are discarded on
  // arrival and lost for good, with no marker and no floor to rewind to. The one
  // honest resolution is to make the overtaking visible: retract the frames that
  // are about to be jumped, which folds them into the coalesced gap marker on the
  // same reserved lane, ahead of the frame that overtook them. Recovery is then
  // the path that already exists — gapFloor plus ring replay.
  function retractOvertaken(subscriptionId, event) {
    const sessionId = event?.sessionId;
    const sequence = event?.sequence;
    if (sessionId == null || !Number.isFinite(sequence)) return;
    channel.dropWhere(LANE_LOW, (item) => item.meta?.subscriptionId === subscriptionId
      && item.meta?.sessionId === sessionId
      // A queued frame without a finite sequence is not subject to the receiver's
      // cursor filter, so arriving late is all that happens to it. Only frames the
      // receiver would silently discard are worth retracting.
      && Number.isFinite(item.meta?.sequence)
      && item.meta.sequence < sequence);
  }

  return {
    channel,
    send,
    sendEvent(subscriptionId, event) {
      if (socket.destroyed) throw new Error("Gateway socket closed");
      // A subscriber that did not opt in keeps 1.3.2 behavior exactly: no
      // coalescing, no gap markers, no drops, in-order delivery until it is a
      // megabyte behind, and then the subscription is removed and told why. Its
      // events therefore ride the reserved lane rather than the droppable one —
      // on LOW the channel could shed a frame that nothing is allowed to report,
      // which is the silent loss the opt-in exists to prevent.
      if (subscriptions.get(subscriptionId)?.acceptsGaps !== true) {
        if (backlog() > maxSubscriptionBytes) {
          unsubscribe(subscriptionId);
          removeSubscription(subscriptionId);
          if (backlog() <= maxQueueBytes) {
            send({ type: "subscription_error", subscriptionId, error: "Gateway subscriber is too slow" });
          }
          return false;
        }
        return channel.write(LANE_NORMAL, { type: "event", subscriptionId, event });
      }
      const lane = laneForEvent(event);
      if (lane !== LANE_LOW) retractOvertaken(subscriptionId, event);
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
