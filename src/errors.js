// Error codes are a stable wire contract: Main-side callers branch on them
// after the message text has already been rewritten. Never rename or reuse a
// code, only add new ones.
export const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  UNKNOWN_METHOD: "UNKNOWN_METHOD",
  UNKNOWN_SESSION: "UNKNOWN_SESSION",
  UNKNOWN_TASK: "UNKNOWN_TASK",
  UNKNOWN_INBOX: "UNKNOWN_INBOX",
  NOT_SESSION_OWNER: "NOT_SESSION_OWNER",
  NOT_TASK_OWNER: "NOT_TASK_OWNER",
  NOT_INBOX_OWNER: "NOT_INBOX_OWNER",
  SESSION_ACTIVE: "SESSION_ACTIVE",
  SESSION_CLOSED: "SESSION_CLOSED",
  SESSION_NOT_WAITING: "SESSION_NOT_WAITING",
  TASK_NOT_COMPLETE: "TASK_NOT_COMPLETE",
  SUBSCRIPTION_NOT_OWNED: "SUBSCRIPTION_NOT_OWNED",
  CONTROL_ACCESS_DENIED: "CONTROL_ACCESS_DENIED",
  ROOT_REQUIRED: "ROOT_REQUIRED",
  ROOT_MISMATCH: "ROOT_MISMATCH",
  SOCKET_ALREADY_BOUND: "SOCKET_ALREADY_BOUND",
  // Reserved for the fail-closed persistence path (state durability work).
  PERSISTENCE_UNHEALTHY: "PERSISTENCE_UNHEALTHY",
  // Fallback for an error that has no more specific code yet.
  GATEWAY_ERROR: "GATEWAY_ERROR"
});

// A Gateway failure with a stable code. The message stays the human-readable
// contract it has always been; the code is what callers should branch on.
export class GatewayError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
