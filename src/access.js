import { isSameCaller, isTaskCreator } from "./attention.js";
import { normalizeCaller } from "./caller.js";
import { ERROR_CODES, GatewayError } from "./errors.js";

// How many distinct callers one control connection is tracked for. A Codex
// front door names a caller per thread, so one connection can speak for many
// Mains. Past this many it counts as speaking for anyone, which can only ever
// refuse an adoption (CallerPresence), never allow one.
const MAX_CALLERS_PER_CONNECTION = 1_024;
const ANYONE = Symbol("anyone");

export function requireAccess(access = "control") {
  if (!["control", "observer"].includes(access)) throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "access must be control or observer");
  return access;
}

export function isReadOnlyCall(method, args = {}) {
  return [
    "guide", "poll", "task_get", "task_list", "task_result", "subscribe", "unsubscribe", "request_cancel", "retention_preview",
    "wait", "main_list"
  ].includes(method)
    || (method === "setup" && !args.provider && !args.refreshAgentUpdates)
    || (method === "session" && ["list", "get", "check"].includes(args.action))
    || (method === "inbox" && ["list", "get", "attention"].includes(args.action ?? "list"))
    || (method === "config" && (args.action ?? "list") === "list")
    || (method === "gateway_config" && (args.action ?? "get") === "get")
    || (method === "provider" && (args.action ?? "list") === "list");
}

export function authorizeCall(method, args, context = {}) {
  if (requireAccess(context.access) === "observer" && !isReadOnlyCall(method, args)) {
    throw new GatewayError(ERROR_CODES.OBSERVER_ACCESS_DENIED, `Observer cannot call ${method}`);
  }
}

// Per-Main isolation (1.8.0). Every Main on a machine shares one rootId, so the
// root alone cannot keep one Main out of another's sessions, tasks and inbox.
// A control request that names its caller comes from a front-door Main and is
// confined to that Main's records. One that names none (management: AgenLynk,
// the admin CLI, installer health checks, and pre-1.6 front doors) and every
// observer keep the whole root. Like observer access, this is not a credential
// boundary: a process that holds the token can claim to be any caller.

/** The front-door Main a request speaks for, or null when it keeps the whole root. */
export function requesterOf(context) {
  return context?.access === "observer" ? null : normalizeCaller(context?.caller);
}

/**
 * Whether `requester` (requesterOf) may see and act on a record owned by
 * `owner`: a session's openedBy, which its tasks and inbox rows follow. A
 * record no Main is recorded for (written before 1.6, or opened by management)
 * stays every Main's, which is the creator rule of attention.js; any other is
 * its own Main's only.
 */
export function isVisibleTo(owner, requester) {
  return requester == null || isTaskCreator(owner, requester);
}

/**
 * The Mains connected right now, for the one place another Main's session can
 * change hands: an explicit session_restore that adopts it once its Main is
 * gone (GatewayService isOwnerLive). A control connection that named a caller
 * speaks for that Main until the connection closes; a caller matches as scope
 * "mine" matches (isSameCaller). The daemon keeps this beside root presence,
 * which does not count: every Main on a machine shares one root.
 */
export class CallerPresence {
  // connection -> Map(identity key -> {sessionId, instanceId}), or ANYONE
  #connections = new Map();

  /** Records that `connection` spoke for `caller`; a malformed caller records nothing. */
  bind(connection, caller) {
    const normalized = normalizeCaller(caller);
    if (!normalized) return;
    const callers = this.#connections.get(connection) ?? new Map();
    if (callers === ANYONE) return;
    this.#connections.set(connection, callers);
    const key = `${normalized.sessionId ?? ""}\u0000${normalized.instanceId}`;
    if (callers.has(key)) return;
    if (callers.size >= MAX_CALLERS_PER_CONNECTION) {
      this.#connections.set(connection, ANYONE);
      return;
    }
    callers.set(key, { sessionId: normalized.sessionId, instanceId: normalized.instanceId });
  }

  /** The connection closed: whoever it spoke for is gone unless another one still speaks for them. */
  release(connection) {
    this.#connections.delete(connection);
  }

  /** Whether a live connection speaks for `owner` (a recorded openedBy). */
  isLive(owner) {
    for (const callers of this.#connections.values()) {
      if (callers === ANYONE) return true;
      for (const caller of callers.values()) {
        if (isSameCaller(owner, caller)) return true;
      }
    }
    return false;
  }
}
