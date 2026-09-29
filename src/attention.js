import { Buffer } from "node:buffer";
import { ERROR_CODES, GatewayError } from "./errors.js";

// The attention view (agent_acp_inbox action "attention"): what is waiting on a
// Main (pending worker requests) and what finished without that Main having
// received it (unseen terminal tasks). Every Main on a machine shares one
// rootId, so "seen" belongs to the Main that started the task, never to the root.

export const DEFAULT_ATTENTION_STALE_MS = 10 * 60_000;
export const ATTENTION_DEFAULT_LIMIT = 50;
export const ATTENTION_MAX_LIMIT = 100;
export const ACK_MAX_TASK_IDS = 100;
// Why an ack left a task alone. Closed list: Main branches on it.
export const ACK_SKIP_REASONS = Object.freeze(["unknown_task", "not_task_owner", "not_terminal", "not_creator"]);

/**
 * Whether `requester` is the Main that created a task recorded with `creator`.
 * Session ids decide when both sides have one (one Codex process hosts many
 * threads); otherwise the front door's instanceId does. A task recorded with no
 * caller (a pre-1.6 front door) is nobody's, so any Main may take it; a
 * requester with no caller can prove nothing and matches only those.
 */
export function isTaskCreator(creator, requester) {
  if (!creator) return true;
  if (!requester) return false;
  if (creator.sessionId && requester.sessionId) return creator.sessionId === requester.sessionId;
  return creator.instanceId === requester.instanceId;
}

// Oldest first for both lists. A request is keyed by when it was raised, an
// update by when it became terminal; neither moves once written, and anything
// new sorts after every existing key, so a keyset page never skips or repeats.
export const requestKey = (item) => [item.createdAt, item.inboxId];
export const updateKey = (task) => [task.lastUpdatedAt, task.taskId];

export function compareKeys(left, right) {
  for (let index = 0; index < 2; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

// One page of one list, after `position` (the key of the last item a previous
// page returned). An exhausted list keeps its position, so later pages only
// show what arrived after it.
export function pageAfter(items, keyOf, position, limit) {
  const after = position ? items.filter((item) => compareKeys(keyOf(item), position) > 0) : items;
  const page = after.slice(0, limit);
  return { items: page, more: after.length > limit, position: page.length ? keyOf(page.at(-1)) : position ?? null };
}

export function encodeAttentionCursor(needsMain, updates) {
  return Buffer.from(JSON.stringify({ v: 1, n: needsMain, u: updates }), "utf8").toString("base64url");
}

export function decodeAttentionCursor(cursor) {
  if (typeof cursor !== "string" || !cursor.trim()) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "cursor must be a non-empty string");
  }
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    parsed = null;
  }
  const position = (value) => value === null
    || (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "string" && part));
  if (!parsed || typeof parsed !== "object" || parsed.v !== 1 || !position(parsed.n) || !position(parsed.u)) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "cursor is not a valid attention cursor");
  }
  return { needsMain: parsed.n, updates: parsed.u };
}

export function requireAckTaskIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > ACK_MAX_TASK_IDS
    || value.some((taskId) => typeof taskId !== "string" || !taskId.trim())) {
    throw new GatewayError(
      ERROR_CODES.INVALID_ARGUMENT,
      `taskIds must be an array of 1 to ${ACK_MAX_TASK_IDS} non-empty strings`
    );
  }
  return [...new Set(value)];
}
