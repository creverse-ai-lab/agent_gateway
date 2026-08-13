// Response projection. Every shape a Main can ask for is derived here from the
// one set of facts the gateway already holds, so a profile can never become a
// second source of truth: `current` is the frozen default, `compact` and
// `diagnostic` are pure projections of it.
//
// The organizing rule is that no concept gets a second vocabulary. compact
// reuses events/result/nextCursor, the inbox summary reuses the toolCall head
// the event path already emits, and the result projection is the single builder
// behind the poll response AND all three terminal task envelopes — which is how
// the orphan-cancel copy stopped being able to drift away from the others.

import { readHeadBytes, utf8ByteHead } from "./bounded-utf8.js";
import { ERROR_CODES, GatewayError } from "./errors.js";

export const PROFILES = Object.freeze(["current", "compact", "diagnostic"]);
const PROFILE_SET = new Set(PROFILES);

export const RESULT_DELIVERIES = Object.freeze(["inline", "artifact"]);
const DELIVERY_SET = new Set(RESULT_DELIVERIES);

// Advertised in the tool schema as the effective ceiling. It is deliberately NOT
// applied when the caller omits resultBudgetBytes: the retained final text is
// already bounded by maxInlineResultBytes, so a default limit here could only
// ever change behaviour on a service configured with a larger inline cap. Absent
// means "no truncation", which is exactly what 1.3.2 did.
export const DEFAULT_RESULT_BUDGET_BYTES = 65_536;

export function requireProfile(value) {
  if (value == null) return "current";
  if (typeof value !== "string" || !PROFILE_SET.has(value)) {
    throw new GatewayError(
      ERROR_CODES.INVALID_ARGUMENT,
      `responseProfile must be one of: ${PROFILES.join(", ")}`
    );
  }
  return value;
}

export function requireResultDelivery(value) {
  if (value == null) return "inline";
  if (typeof value !== "string" || !DELIVERY_SET.has(value)) {
    throw new GatewayError(
      ERROR_CODES.INVALID_ARGUMENT,
      `resultDelivery must be one of: ${RESULT_DELIVERIES.join(", ")}`
    );
  }
  return value;
}

export function requireResultBudget(value) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > DEFAULT_RESULT_BUDGET_BYTES) {
    throw new GatewayError(
      ERROR_CODES.INVALID_ARGUMENT,
      `resultBudgetBytes must be an integer from 0 to ${DEFAULT_RESULT_BUDGET_BYTES}`
    );
  }
  return parsed;
}

// The delivery decision tree, in one place because all three thresholds
// (maxInlineResultBytes for memory, walInlineResultBytes for durability, this
// one for delivery) otherwise get confused for each other.
//
//   delivery "artifact" -> nothing inline, everything through the pointer
//   bytes <= budget     -> exactly 1.3.2
//   bytes >  budget     -> bounded head + totals + a guaranteed pointer
//
// totalBytes is the size of THIS answer; transcriptBytes is the size of the
// whole narration. They are different numbers and conflating them is the trap
// this comment exists to name.
function deliverText(session, text, { budget, delivery, spill }) {
  const retainedBytes = Buffer.byteLength(text);
  const existing = completeArtifact(session.resultFinalArtifact) ? session.resultFinalArtifact : null;
  const totalBytes = existing?.bytes ?? retainedBytes;
  if (delivery === "artifact") {
    const textArtifact = existing ?? ensureTextArtifact(session, text, spill);
    return {
      text: "",
      totalBytes,
      omittedBytes: totalBytes,
      textArtifact,
      bounded: true,
      degraded: !textArtifact
    };
  }
  if (budget == null) {
    return { text, totalBytes, omittedBytes: 0, textArtifact: session.resultFinalArtifact ?? null, bounded: false };
  }
  if (totalBytes <= budget) {
    const completeText = existing && retainedBytes < totalBytes
      ? readHeadBytes(existing.path, budget)
      : text;
    return {
      text: completeText ?? text,
      totalBytes,
      omittedBytes: completeText == null ? totalBytes - retainedBytes : 0,
      textArtifact: session.resultFinalArtifact ?? null,
      bounded: completeText == null,
      degraded: completeText == null
    };
  }
  const head = existing?.path
    ? readHeadBytes(existing.path, budget) ?? utf8ByteHead(text, budget)
    : utf8ByteHead(text, budget);
  const textArtifact = existing ?? ensureTextArtifact(session, text, spill);
  return {
    text: head,
    totalBytes,
    omittedBytes: totalBytes - Buffer.byteLength(head),
    textArtifact,
    bounded: true,
    degraded: !textArtifact
  };
}

// Spill once, then remember. A budgeted poll runs on every tick of a Main's
// loop; writing a fresh artifact per call would leak one file per poll for the
// same unchanged answer.
//
// The memo is a field of its own rather than resultFinalArtifact: writing there
// would make one caller's budgeted read change what the NEXT caller's default
// read returns, which is exactly the hidden mode that keeps budgets off the
// session record in the first place. An overflow spill that already exists is
// reused, because it is the same bytes.
function ensureTextArtifact(session, text, spill) {
  if (completeArtifact(session.resultFinalArtifact)) return session.resultFinalArtifact;
  if (completeArtifact(session.resultBudgetArtifact)) return session.resultBudgetArtifact;
  if (typeof spill !== "function" || !text) return null;
  const artifact = spill(text);
  if (completeArtifact(artifact)) session.resultBudgetArtifact = artifact;
  return completeArtifact(artifact) ? artifact : null;
}

function completeArtifact(artifact) {
  return artifact?.complete === true && artifact.truncated !== true && !artifact.error
    && typeof artifact.path === "string" && Number.isFinite(artifact.bytes)
    ? artifact
    : null;
}

// The single result builder. Callers pass what they know; the shape is decided
// here. With no options this returns byte-for-byte what 1.3.2 returned.
export function projectResult(session, options = {}) {
  const {
    profile = "current",
    active = false,
    stopReason = session.stopReason,
    includeThoughts = false,
    inspection = null,
    usageSummary = null,
    budget = null,
    delivery = "inline",
    spill = null,
    degraded = false
  } = options;
  const text = active ? session.resultText : session.resultFinalText ?? session.resultText;
  const delivered = deliverText(session, text, { budget, delivery, spill });
  const artifact = session.resultArtifact ?? null;
  const bounds = delivered.bounded
    ? { totalBytes: delivered.totalBytes, omittedBytes: delivered.omittedBytes }
    : {};

  if (profile === "compact") {
    // publicSession is gone from a compact poll, so stopReason lives here: an
    // active turn has no stop reason, and this is the object that knows it.
    return {
      text: delivered.text,
      transcriptBytes: Buffer.byteLength(session.resultText),
      stopReason,
      ...(artifact ? { artifact } : {}),
      ...(delivered.textArtifact ? { textArtifact: delivered.textArtifact } : {}),
      ...bounds,
      ...(degraded || delivered.degraded ? { resultDegraded: true } : {}),
      ...(usageSummary ? { usageSummary } : {}),
      ...(includeThoughts ? { thought: session.thoughtText } : {}),
      ...(inspection ? { inspection: inspection.segments, inspectionDropped: inspection.dropped } : {})
    };
  }

  return {
    text: delivered.text,
    transcriptBytes: Buffer.byteLength(session.resultText),
    artifact,
    ...(delivered.textArtifact ? { textArtifact: delivered.textArtifact } : {}),
    ...bounds,
    ...(degraded || delivered.degraded ? { resultDegraded: true } : {}),
    ...(includeThoughts ? { thought: session.thoughtText } : {}),
    stopReason,
    ...(inspection ? { inspection: inspection.segments, inspectionDropped: inspection.dropped } : {}),
    ...(usageSummary ? { usageSummary } : {})
  };
}

// Projects the poll response that sessionPoll already built. Building `current`
// first and narrowing is deliberate: there is one place that decides what a poll
// knows, and two places that decide how much of it to say.
export function projectPoll(profile, response, diagnostics = null) {
  if (profile === "current") return response;
  if (profile === "diagnostic") {
    return {
      ...response,
      queue: diagnostics?.queue ?? { depth: 0, reserved: null },
      illegalTransitions: diagnostics?.illegalTransitions ?? 0,
      pending: diagnostics?.pending ?? { permissions: 0, elicitations: 0 }
    };
  }
  return {
    ok: response.ok,
    sessionId: response.sessionId,
    turnId: response.turnId,
    status: response.status,
    nextCursor: response.nextCursor,
    events: response.events,
    // Zero and false are the ordinary case; saying so on every poll is the cost
    // compact exists to remove. The drop signal itself stays honest — a true
    // cursorTruncated is always printed.
    ...(response.filteredCount ? { filteredCount: response.filteredCount } : {}),
    ...(response.cursorTruncated ? { cursorTruncated: true } : {}),
    ...(Object.hasOwn(response, "result") ? { result: response.result } : {})
  };
}

export function requireInboxDetail(value) {
  if (value == null) return "full";
  if (value !== "full" && value !== "summary") {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "detail must be one of: full, summary");
  }
  return value;
}

// A key projection, not a third record shape: summary is the full row minus the
// three unbounded fields, with the tool call reduced to the same head the event
// path and the oversized-row path already emit.
const INBOX_SUMMARY_DROPPED = new Set(["options", "message", "requestedSchema"]);

export function projectInboxItem(item, detail = "full") {
  if (detail !== "summary") return item;
  const summary = {};
  for (const [key, value] of Object.entries(item)) {
    if (INBOX_SUMMARY_DROPPED.has(key)) continue;
    summary[key] = key === "toolCall" && value
      ? { toolCallId: value.toolCallId, title: value.title, kind: value.kind }
      : value;
  }
  return summary;
}

// Keyset paging over the inbox. base64url so it survives every transport we
// have, and the inboxId tiebreaker is mandatory: a fan-out of worker requests
// puts several rows on the same millisecond routinely, and a createdAt-only
// cursor would then skip or repeat them.
export function encodeInboxCursor(item) {
  return Buffer.from(`${item.createdAt}|${item.inboxId}`, "utf8").toString("base64url");
}

export function decodeInboxCursor(cursor) {
  if (typeof cursor !== "string" || !cursor.trim()) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "cursor must be a non-empty string");
  }
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator <= 0 || separator === decoded.length - 1) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "cursor is not a valid inbox cursor");
  }
  return { createdAt: decoded.slice(0, separator), inboxId: decoded.slice(separator + 1) };
}

// Newest first, tie broken by id so the order is total. One comparator serves
// both the unpaged list and the keyset pages; a second one would eventually
// disagree with this one at exactly the boundary that matters.
export function compareInboxDesc(left, right) {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  if (left.inboxId !== right.inboxId) return left.inboxId < right.inboxId ? 1 : -1;
  return 0;
}

export function isAfterInboxCursor(item, cursor) {
  if (!cursor) return true;
  if (item.createdAt !== cursor.createdAt) return item.createdAt < cursor.createdAt;
  return item.inboxId < cursor.inboxId;
}

// The relevance filter for session_open. Everything else stays visible in
// setup(): this list is what a Main must know BEFORE it prompts a worker.
const SESSION_ALERT_CODES = new Set([
  "persistence_unhealthy",
  "gateway_source_update_available",
  "downgrade_detected",
  "state_recovery_required"
]);
const MAX_SESSION_ALERTS = 3;

export function relevantAlerts(alerts, provider) {
  const matching = (alerts ?? []).filter((alert) => {
    if (!alert) return false;
    if (alert.severity === "error" || alert.level === "error") return true;
    if (alert.provider != null && alert.provider === provider) return true;
    return typeof alert.code === "string" && SESSION_ALERT_CODES.has(alert.code.toLowerCase());
  });
  return {
    relevantAlerts: matching.slice(0, MAX_SESSION_ALERTS),
    ...(matching.length > MAX_SESSION_ALERTS
      ? { alertsOmitted: matching.length - MAX_SESSION_ALERTS }
      : {})
  };
}

// Options are what Main chooses between, so they are never dropped outright —
// but a worker that offers hundreds of them would otherwise make the run
// response unbounded on the one path that has no cursor to page with.
export const MAX_PENDING_OPTIONS = 16;

export function capPendingOptions(item) {
  const options = item?.options;
  if (!Array.isArray(options) || options.length <= MAX_PENDING_OPTIONS) return item;
  return {
    ...item,
    options: options.slice(0, MAX_PENDING_OPTIONS),
    optionsOmitted: options.length - MAX_PENDING_OPTIONS
  };
}
