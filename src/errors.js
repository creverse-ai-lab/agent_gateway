// Error codes are a stable wire contract: Main-side callers branch on them
// after the message text has already been rewritten. Never rename or reuse a
// code, only add new ones.
export const ERROR_CODES = Object.freeze({
  OBSERVER_ACCESS_DENIED: "OBSERVER_ACCESS_DENIED",
  PROVIDER_DISABLED: "PROVIDER_DISABLED",
  CONFIG_INVALID: "CONFIG_INVALID",
  CONFIG_CONFLICT: "CONFIG_CONFLICT",
  CONFIG_BUSY: "CONFIG_BUSY",
  SHUTDOWN_BLOCKED: "SHUTDOWN_BLOCKED",
  GATEWAY_DRAINING: "GATEWAY_DRAINING",
  SUBSCRIPTION_LIMIT_EXCEEDED: "SUBSCRIPTION_LIMIT_EXCEEDED",
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
  // The session's worker failed to come back maxConsecutiveRestoreFailures
  // times in a row, so the Gateway stopped restoring it behind Main's back.
  // Refused before any provider is started or contacted; details carry the
  // failure count, the last error code and Main's options (next).
  SESSION_QUARANTINED: "SESSION_QUARANTINED",
  TASK_NOT_COMPLETE: "TASK_NOT_COMPLETE",
  // Raised by TaskStore budgets and waits. The store itself stays
  // dependency-free and tags plain Errors with these same strings; the gateway
  // re-raises them as GatewayError so the wire envelope carries the code.
  TASK_LIMIT_EXCEEDED: "TASK_LIMIT_EXCEEDED",
  TASK_WAITER_LIMIT: "TASK_WAITER_LIMIT",
  TASK_TTL_EXPIRED: "TASK_TTL_EXPIRED",
  TASK_STORE_CLOSED: "TASK_STORE_CLOSED",
  WAIT_TIMEOUT: "WAIT_TIMEOUT",
  WAIT_ABORTED: "WAIT_ABORTED",
  SUBSCRIPTION_NOT_OWNED: "SUBSCRIPTION_NOT_OWNED",
  CONTROL_ACCESS_DENIED: "CONTROL_ACCESS_DENIED",
  ROOT_REQUIRED: "ROOT_REQUIRED",
  ROOT_MISMATCH: "ROOT_MISMATCH",
  SOCKET_ALREADY_BOUND: "SOCKET_ALREADY_BOUND",
  // The socket path cannot be trusted with the token. A client raises it before
  // it connects or writes anything: the path holds something other than a
  // socket owned by this user (on Linux the default path is in the shared /tmp,
  // where another user can create it first), or a directory from the
  // filesystem root down to the socket's is not this user's or root's, or is
  // writable by group or others without the sticky bit, so another user could
  // swap a link into it. Nothing was written to it, the token included, and no
  // daemon was started. details: socketPath, type, ownerUid, uid for the socket
  // itself; socketPath, dir (the directory at fault), uid and what is wrong
  // with it (type, ownerUid, mode or reason) for the directory chain. The
  // daemon raises it as a startup halt: it checks the same chain before it
  // locks, probes, unlinks or binds anything at the path, and on failure exits
  // 78 with this code in the recovery marker. A socket directory that does not
  // exist is not this to a client: nothing can be listening there, so it sends
  // nothing and takes it as no daemon (ENOENT, alreadyStopped for a shutdown).
  // A daemon autostarted into it halts with this code, which the client then
  // reports from the recovery marker.
  SOCKET_UNTRUSTED: "SOCKET_UNTRUSTED",
  // The caller's pid is, or runs under, the daemon or a process the daemon
  // spawned (a provider or one of its terminals): the agent CLI behind this
  // connection is a worker, or something a worker or its terminal started. The
  // spawned-process match still catches a worker when the daemon is pid 1, where
  // no ancestor can be matched to the daemon's own pid. Workers never get the
  // Control, whatever token they present. Also raised, with "ancestry cannot be
  // verified on this host" in the message, when the caller cannot be placed at
  // all: the walk did not reach the daemon or a spawned process, and the daemon
  // cannot read even its own process entry (no /proc, and ps missing or
  // blocked), so a worker could not be told from a Main. Windows, which reads
  // no ancestry, is never refused for that. Refused before the connection binds
  // or anything runs. The verdict is reused only while the connection's caller
  // pid stays the same; a request that names another pid is checked on its own.
  // A connection that never names a caller pid (management clients) is never
  // refused for this.
  WORKER_CONTROL_DENIED: "WORKER_CONTROL_DENIED",
  // The fail-closed persistence path: a Task handle is a durability promise, so
  // it is refused rather than issued while the state store cannot keep it.
  PERSISTENCE_UNHEALTHY: "PERSISTENCE_UNHEALTHY",
  // Startup-only halts. Each one means "state exists on disk that this process
  // cannot safely interpret", and each names the opt-in that overrides it. They
  // never appear on a request path.
  STATE_WAL_CORRUPT: "STATE_WAL_CORRUPT",
  STATE_SNAPSHOT_CORRUPT: "STATE_SNAPSHOT_CORRUPT",
  STATE_VERSION_UNSUPPORTED: "STATE_VERSION_UNSUPPORTED",
  STATE_DIR_LOCKED: "STATE_DIR_LOCKED",
  // Startup-only too: a daemon told to read its Control identity from stdin
  // (the autostart, socket-rpc.js) got no line, or one that holds no usable
  // identity. Halts the same way, marker and exit code included.
  DAEMON_IDENTITY_INVALID: "DAEMON_IDENTITY_INVALID",
  // Bounded transport (NdjsonChannel): the write side of an NDJSON connection.
  // A frame nobody can send, a backlog nobody is draining, or a peer that
  // stopped taking bytes at all.
  TRANSPORT_CLOSED: "TRANSPORT_CLOSED",
  TRANSPORT_CONGESTED: "TRANSPORT_CONGESTED",
  TRANSPORT_WRITE_TIMEOUT: "TRANSPORT_WRITE_TIMEOUT",
  FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
  // Admission budgets. Each is refused before any work is dispatched, so a
  // caller that sees one has spent nothing but the round trip.
  TOO_MANY_INFLIGHT_REQUESTS: "TOO_MANY_INFLIGHT_REQUESTS",
  PROMPT_TOO_LARGE: "PROMPT_TOO_LARGE",
  SESSION_LIMIT_EXCEEDED: "SESSION_LIMIT_EXCEEDED",
  INBOX_BUDGET_EXCEEDED: "INBOX_BUDGET_EXCEEDED",
  // A run retried with an idempotencyKey that already names different work. The
  // existing taskId is in details, so the caller can attach to it deliberately.
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  // The worker answered a JSON-RPC request with an error. details.acpCode and
  // details.acpMessage carry the worker's own error unchanged.
  ACP_ERROR: "ACP_ERROR",
  // A snapshot workspace could not be created, compared or removed.
  WORKSPACE_ERROR: "WORKSPACE_ERROR",
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

export function isGatewayErrorCode(code) {
  return typeof code === "string" && Object.hasOwn(ERROR_CODES, code);
}

// Keep the legacy wire field names. Only registry codes become errorCode —
// Node codes like ENOENT must not look like a Gateway contract.
export function errorEnvelope(error) {
  return {
    error: error?.message ?? String(error),
    ...(isGatewayErrorCode(error?.code) ? { errorCode: error.code } : {}),
    ...(error != null && Object.hasOwn(error, "details") ? { details: error.details } : {})
  };
}
