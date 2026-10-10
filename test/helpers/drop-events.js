// Test-only, loaded into a daemon with `--import ./test/helpers/drop-events.js`.
// Loses the subscription event frames ACP_GATEWAY_DROP_EVENTS describes (a JSON
// object whose every field the event must carry with that value), as a frame
// lost between the daemon and a subscriber would be: the daemon writes it and
// the subscriber never reads it. Each one lost is appended, as a JSON line, to
// the file ACP_GATEWAY_DROP_EVENTS_LOG names, so a test can prove what never
// arrived. Every daemon frame is one write of one line (ndjson-channel.js), so
// a frame is matched whole.
import { appendFileSync } from "node:fs";
import { Socket } from "node:net";

const match = JSON.parse(process.env.ACP_GATEWAY_DROP_EVENTS ?? "null");
const log = process.env.ACP_GATEWAY_DROP_EVENTS_LOG || null;
const EVENT_FRAME = Buffer.from("{\"type\":\"event\"");

if (match && typeof match === "object") {
  const write = Socket.prototype.write;
  Socket.prototype.write = function dropEvents(chunk, ...rest) {
    const event = matchingEvent(chunk);
    if (!event) return write.call(this, chunk, ...rest);
    if (log) appendFileSync(log, `${JSON.stringify(event)}\n`);
    rest.find((argument) => typeof argument === "function")?.();
    return true;
  };
}

function matchingEvent(chunk) {
  if (!Buffer.isBuffer(chunk) || !chunk.subarray(0, EVENT_FRAME.length).equals(EVENT_FRAME)) return null;
  let frame;
  try {
    frame = JSON.parse(chunk.toString("utf8"));
  } catch {
    return null;
  }
  const event = frame?.event;
  return event && Object.entries(match).every(([key, value]) => event[key] === value) ? event : null;
}
