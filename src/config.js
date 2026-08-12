import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const uid = typeof process.getuid === "function" ? process.getuid() : "user";

export function gatewaySocketPath() {
  return process.env.ACP_GATEWAY_SOCKET || join(tmpdir(), `acp-gateway-${uid}.sock`);
}

export function gatewayStatePath() {
  return process.env.ACP_GATEWAY_STATE || join(homedir(), ".acp-gateway", "state.json");
}

export function controlToken() {
  const value = process.env.ACP_GATEWAY_CONTROL_TOKEN;
  if (!value || value.length < 24) {
    throw new Error("ACP_GATEWAY_CONTROL_TOKEN must be set to at least 24 characters");
  }
  return value;
}

export function rootId() {
  return process.env.ACP_GATEWAY_ROOT_ID || `main-${process.ppid}`;
}

export function gatewayLifecycleConfig() {
  return {
    gcIntervalMs: numberEnv("ACP_GATEWAY_GC_INTERVAL_MS", 5 * 60_000, 1_000),
    idleUnloadMs: numberEnv("ACP_GATEWAY_IDLE_UNLOAD_MS", 30 * 60_000, 0),
    orphanGraceMs: numberEnv("ACP_GATEWAY_ORPHAN_GRACE_MS", 24 * 60 * 60_000, 0),
    resultRetentionMs: numberEnv("ACP_GATEWAY_RESULT_RETENTION_MS", 24 * 60 * 60_000, 0),
    inboxRetentionMs: numberEnv("ACP_GATEWAY_INBOX_RETENTION_MS", 24 * 60 * 60_000, 0),
    // Separate from a task's ttl: ttl bounds how long a handle answers, this
    // bounds how long its bytes survive. A handle with ttl=null (legacy records
    // opt out of expiry) would otherwise live in the snapshot forever.
    taskRetentionMs: numberEnv("ACP_GATEWAY_TASK_RETENTION_MS", 24 * 60 * 60_000, 0),
    sessionRetentionMs: numberEnv("ACP_GATEWAY_SESSION_RETENTION_MS", 7 * 24 * 60 * 60_000, 0),
    maxEvents: numberEnv("ACP_GATEWAY_MAX_EVENTS", 200, 1),
    maxTextBytes: numberEnv("ACP_GATEWAY_MAX_TEXT_BYTES", 1_000_000, 1),
    maxArtifactBytes: numberEnv("ACP_GATEWAY_MAX_ARTIFACT_BYTES", 100 * 1024 * 1024, 1),
    maxArtifactTotalBytes: numberEnv("ACP_GATEWAY_MAX_ARTIFACT_TOTAL_BYTES", 512 * 1024 * 1024, 1),
    maxTerminalsPerSession: numberEnv("ACP_GATEWAY_MAX_TERMINALS_PER_SESSION", 16, 1),
    maxPendingRequestsPerSession: numberEnv("ACP_GATEWAY_MAX_PENDING_REQUESTS_PER_SESSION", 64, 1),
    maxInboxItemBytes: numberEnv("ACP_GATEWAY_MAX_INBOX_ITEM_BYTES", 64 * 1024, 1024),
    maxPendingInboxBytesPerSession: numberEnv("ACP_GATEWAY_MAX_PENDING_INBOX_BYTES_PER_SESSION", 512 * 1024, 1024),
    maxPendingInboxBytesPerRoot: numberEnv("ACP_GATEWAY_MAX_PENDING_INBOX_BYTES_PER_ROOT", 4 * 1024 * 1024, 1024),
    maxFrameBytes: numberEnv("ACP_GATEWAY_MAX_FRAME_BYTES", 32 * 1024 * 1024, 1024),
    // Per-connection write budget and stall deadline for every NDJSON transport.
    // The default is today's MAX_CONNECTION_BUFFER_BYTES, split into lane shares
    // inside the channel rather than configured lane by lane.
    maxQueueBytes: numberEnv("ACP_GATEWAY_MAX_QUEUE_BYTES", 4_000_000, 1024),
    writeTimeoutMs: numberEnv("ACP_GATEWAY_WRITE_TIMEOUT_MS", 10_000, 0),
    // Session-tier budgets: what one turn, one file read and one terminal answer
    // may cost.
    maxPromptBytes: numberEnv("ACP_GATEWAY_MAX_PROMPT_BYTES", 1_000_000, 1024),
    maxFileReadBytes: numberEnv("ACP_GATEWAY_MAX_FILE_READ_BYTES", 500_000, 1024),
    maxTerminalOutputBytes: numberEnv("ACP_GATEWAY_MAX_TERMINAL_OUTPUT_BYTES", 10_000_000, 1024),
    // Root-tier budgets: how much a single Main may hold at once.
    maxSessionsPerRoot: numberEnv("ACP_GATEWAY_MAX_SESSIONS_PER_ROOT", 64, 1),
    maxInboxHistoryPerRoot: numberEnv("ACP_GATEWAY_MAX_INBOX_HISTORY_PER_ROOT", 1_000, 1)
  };
}

// What the gateway keeps about a turn beyond the turn's own answer. Separate
// from lifecycle on purpose: lifecycle maps 1:1 onto a frozen setup() table, and
// an observability knob is a policy about retention detail, not a resource bound.
export function gatewayObservabilityConfig() {
  return {
    // tail is the default because full is the only per-session cost with no
    // artifact escape hatch: reasoning text has no spill writer, so "keep it all"
    // silently means "keep 1MB per session". 8KB still answers what the worker
    // was thinking when it stopped.
    thoughtCapture: enumEnv("ACP_GATEWAY_THOUGHT_CAPTURE", "tail", ["none", "tail", "full"])
  };
}

// Durability knobs live apart from lifecycle and resourceLimits on purpose: they
// describe how the state store writes, not what the gateway retains or admits.
export function gatewayPersistenceConfig() {
  return {
    // The first-class fallback. Off keeps the same barrier() promise by writing a
    // synchronous snapshot per critical mutation, so a bad WAL day is a config
    // flip rather than a revert.
    wal: booleanEnv("ACP_GATEWAY_WAL", true),
    walGroupCommitMs: numberEnv("ACP_GATEWAY_WAL_GROUP_COMMIT_MS", 5, 0),
    walRotateBytes: numberEnv("ACP_GATEWAY_WAL_ROTATE_BYTES", 4 * 1024 * 1024, 1024),
    walRotateRecords: numberEnv("ACP_GATEWAY_WAL_ROTATE_RECORDS", 10_000, 1),
    walRotateIntervalMs: numberEnv("ACP_GATEWAY_WAL_ROTATE_INTERVAL_MS", 15 * 60_000, 0),
    // Mirrors EVENT_PAYLOAD_CAP: a result larger than this goes to an artifact and
    // the WAL keeps a reference plus a preview.
    walInlineResultBytes: numberEnv("ACP_GATEWAY_WAL_INLINE_RESULT_BYTES", 4096, 64),
    fsync: enumEnv("ACP_GATEWAY_FSYNC", "normal", ["normal", "off"]),
    // Opt-in recovery overrides. Absent means "halt and tell the operator".
    stateRecovery: enumEnv("ACP_GATEWAY_STATE_RECOVERY", null, ["truncate", "snapshot-drop", "cold"])
  };
}

export function gatewayAgentUpdateConfig() {
  const policy = readAgentUpdatePolicy();
  const autoUpdate = typeof policy.autoUpdate === "boolean" ? policy.autoUpdate : true;
  const notifications = typeof policy.notifications === "boolean" ? policy.notifications : true;
  return {
    enabled: booleanEnv("ACP_GATEWAY_AGENT_AUTO_UPDATE", autoUpdate),
    notifications: booleanEnv("ACP_GATEWAY_AGENT_UPDATE_NOTIFICATIONS", notifications),
    intervalMs: numberEnv("ACP_GATEWAY_AGENT_UPDATE_INTERVAL_MS", 24 * 60 * 60_000, 5 * 60_000)
  };
}

function readAgentUpdatePolicy() {
  const path = process.env.ACP_GATEWAY_INSTALL_STATE || join(homedir(), ".acp-gateway", "install.json");
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    return state?.agentUpdates && typeof state.agentUpdates === "object" ? state.agentUpdates : {};
  } catch {
    return {};
  }
}

function numberEnv(name, fallback, minimum) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be a number >= ${minimum}`);
  return value;
}

function enumEnv(name, fallback, allowed) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (!allowed.includes(raw)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return raw;
}

function booleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (["1", "true", "on", "yes"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "off", "no"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be on or off`);
}
