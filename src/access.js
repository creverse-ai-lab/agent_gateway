import { ERROR_CODES, GatewayError } from "./errors.js";

export function requireAccess(access = "control") {
  if (!["control", "observer"].includes(access)) throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "access must be control or observer");
  return access;
}

export function isReadOnlyCall(method, args = {}) {
  return ["guide", "poll", "task_get", "task_list", "task_result", "subscribe", "unsubscribe", "request_cancel", "retention_preview"].includes(method)
    || (method === "setup" && !args.provider && !args.refreshAgentUpdates)
    || (method === "session" && ["list", "get"].includes(args.action))
    || (method === "inbox" && ["list", "get"].includes(args.action ?? "list"))
    || (method === "config" && (args.action ?? "list") === "list")
    || (method === "gateway_config" && (args.action ?? "get") === "get")
    || (method === "provider" && (args.action ?? "list") === "list");
}

export function authorizeCall(method, args, context = {}) {
  if (requireAccess(context.access) === "observer" && !isReadOnlyCall(method, args)) {
    throw new GatewayError(ERROR_CODES.OBSERVER_ACCESS_DENIED, `Observer cannot call ${method}`);
  }
}
