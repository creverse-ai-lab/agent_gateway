import { isTaskCreator } from "./attention.js";
import { normalizeCaller } from "./caller.js";
import { ERROR_CODES, GatewayError } from "./errors.js";

export function requireAccess(access = "control") {
  if (!["control", "observer"].includes(access)) throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "access must be control or observer");
  return access;
}

export function isReadOnlyCall(method, args = {}) {
  return ["guide", "poll", "task_get", "task_list", "task_result", "subscribe", "unsubscribe", "request_cancel", "retention_preview"].includes(method)
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
