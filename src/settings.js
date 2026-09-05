import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readJsonFile, updateJsonFile } from "./atomic-json.js";
import { ERROR_CODES, GatewayError } from "./errors.js";

const number = (id, group, environment, defaultValue, minimum) => ({ id, group, environment, defaultValue, minimum, type: "number" });
const boolean = (id, group, environment, defaultValue) => ({ id, group, environment, defaultValue, type: "boolean" });
const enumeration = (id, group, environment, defaultValue, values) => ({ id, group, environment, defaultValue, values, type: "enum" });
export const SETTING_DEFINITIONS = Object.freeze([
  number("gcIntervalMs", "lifecycle", "ACP_GATEWAY_GC_INTERVAL_MS", 5 * 60_000, 1_000),
  number("idleUnloadMs", "lifecycle", "ACP_GATEWAY_IDLE_UNLOAD_MS", 30 * 60_000, 0),
  number("orphanGraceMs", "lifecycle", "ACP_GATEWAY_ORPHAN_GRACE_MS", 24 * 60 * 60_000, 0),
  number("resultRetentionMs", "lifecycle", "ACP_GATEWAY_RESULT_RETENTION_MS", 24 * 60 * 60_000, 0),
  number("inboxRetentionMs", "lifecycle", "ACP_GATEWAY_INBOX_RETENTION_MS", 24 * 60 * 60_000, 0),
  number("taskRetentionMs", "lifecycle", "ACP_GATEWAY_TASK_RETENTION_MS", 24 * 60 * 60_000, 0),
  number("sessionRetentionMs", "lifecycle", "ACP_GATEWAY_SESSION_RETENTION_MS", 7 * 24 * 60 * 60_000, 0),
  number("maxEvents", "resourceLimits", "ACP_GATEWAY_MAX_EVENTS", 200, 1),
  number("maxTextBytes", "resourceLimits", "ACP_GATEWAY_MAX_TEXT_BYTES", 1_000_000, 1),
  number("maxArtifactBytes", "resourceLimits", "ACP_GATEWAY_MAX_ARTIFACT_BYTES", 100 * 1024 * 1024, 1),
  number("maxArtifactTotalBytes", "resourceLimits", "ACP_GATEWAY_MAX_ARTIFACT_TOTAL_BYTES", 512 * 1024 * 1024, 1),
  number("maxTerminalsPerSession", "resourceLimits", "ACP_GATEWAY_MAX_TERMINALS_PER_SESSION", 16, 1),
  number("maxPendingRequestsPerSession", "resourceLimits", "ACP_GATEWAY_MAX_PENDING_REQUESTS_PER_SESSION", 64, 1),
  number("maxInboxItemBytes", "resourceLimits", "ACP_GATEWAY_MAX_INBOX_ITEM_BYTES", 64 * 1024, 1024),
  number("maxPendingInboxBytesPerSession", "resourceLimits", "ACP_GATEWAY_MAX_PENDING_INBOX_BYTES_PER_SESSION", 512 * 1024, 1024),
  number("maxPendingInboxBytesPerRoot", "resourceLimits", "ACP_GATEWAY_MAX_PENDING_INBOX_BYTES_PER_ROOT", 4 * 1024 * 1024, 1024),
  number("maxFrameBytes", "resourceLimits", "ACP_GATEWAY_MAX_FRAME_BYTES", 32 * 1024 * 1024, 1024),
  number("maxQueueBytes", "resourceLimits", "ACP_GATEWAY_MAX_QUEUE_BYTES", 4_000_000, 1024),
  number("writeTimeoutMs", "resourceLimits", "ACP_GATEWAY_WRITE_TIMEOUT_MS", 10_000, 0),
  number("maxPromptBytes", "resourceLimits", "ACP_GATEWAY_MAX_PROMPT_BYTES", 1_000_000, 1024),
  number("maxFileReadBytes", "resourceLimits", "ACP_GATEWAY_MAX_FILE_READ_BYTES", 500_000, 1024),
  number("maxTerminalOutputBytes", "resourceLimits", "ACP_GATEWAY_MAX_TERMINAL_OUTPUT_BYTES", 10_000_000, 1024),
  number("maxSessionsPerRoot", "resourceLimits", "ACP_GATEWAY_MAX_SESSIONS_PER_ROOT", 64, 1),
  number("maxInboxHistoryPerRoot", "resourceLimits", "ACP_GATEWAY_MAX_INBOX_HISTORY_PER_ROOT", 1_000, 1),
  enumeration("thoughtCapture", "observability", "ACP_GATEWAY_THOUGHT_CAPTURE", "tail", ["none", "tail", "full"]),
  boolean("wal", "persistence", "ACP_GATEWAY_WAL", true),
  number("walGroupCommitMs", "persistence", "ACP_GATEWAY_WAL_GROUP_COMMIT_MS", 5, 0),
  number("walRotateBytes", "persistence", "ACP_GATEWAY_WAL_ROTATE_BYTES", 4 * 1024 * 1024, 1024),
  number("walRotateRecords", "persistence", "ACP_GATEWAY_WAL_ROTATE_RECORDS", 10_000, 1),
  number("walRotateIntervalMs", "persistence", "ACP_GATEWAY_WAL_ROTATE_INTERVAL_MS", 15 * 60_000, 0),
  number("walInlineResultBytes", "persistence", "ACP_GATEWAY_WAL_INLINE_RESULT_BYTES", 4096, 64),
  enumeration("fsync", "persistence", "ACP_GATEWAY_FSYNC", "normal", ["normal", "off"]),
  number("maxInlineResultBytes", "resourceLimits", "ACP_GATEWAY_MAX_INLINE_RESULT_BYTES", 64 * 1024, 1),
  boolean("agentAutoUpdate", "agentUpdates", "ACP_GATEWAY_AGENT_AUTO_UPDATE", true),
  boolean("agentUpdateNotifications", "agentUpdates", "ACP_GATEWAY_AGENT_UPDATE_NOTIFICATIONS", true),
  number("agentUpdateIntervalMs", "agentUpdates", "ACP_GATEWAY_AGENT_UPDATE_INTERVAL_MS", 24 * 60 * 60_000, 5 * 60_000),
].map(definition => Object.freeze({ ...definition, requiresRestart: true })));
const definitions = new Map(SETTING_DEFINITIONS.map(d => [d.id, d]));
const policyKeys = { agentAutoUpdate: "autoUpdate", agentUpdateNotifications: "notifications", agentUpdateIntervalMs: "intervalMs" };

export function settingsPaths(env = process.env) {
  const legacy = env.ACP_GATEWAY_INSTALL_STATE || join(homedir(), ".acp-gateway", "install.json");
  return { legacy, path: env.ACP_GATEWAY_SETTINGS || join(dirname(legacy), "settings.json") };
}

export function validateSetting(id, value) {
  const d = definitions.get(id);
  if (!d) throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Unsupported Gateway setting: ${id}`);
  const valid = d.type === "number" ? Number.isSafeInteger(value) && value >= d.minimum
    : d.type === "boolean" ? typeof value === "boolean" : d.values.includes(value);
  if (!valid) throw new GatewayError(ERROR_CODES.CONFIG_INVALID, d.type === "enum" ? `${id} must be one of: ${d.values.join(", ")}` : `Invalid value for ${id}`, { id, type: d.type, minimum: d.minimum, values: d.values });
  return value;
}

function validateValues(values) {
  for (const [id, value] of Object.entries(values)) validateSetting(id, value);
  if (values.maxArtifactTotalBytes < values.maxArtifactBytes) {
    throw new GatewayError(ERROR_CODES.CONFIG_INVALID, "maxArtifactTotalBytes must be >= maxArtifactBytes");
  }
}

function documentAt(path, legacy) {
  const saved = readJsonFile(path, undefined);
  if (saved !== undefined) {
    if (!saved || saved.schemaVersion !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0
      || !saved.values || typeof saved.values !== "object" || Array.isArray(saved.values)) {
      throw new GatewayError(ERROR_CODES.CONFIG_INVALID, "Unsupported Gateway settings document");
    }
    validateValues(saved.values);
    return saved;
  }
  const old = readJsonFile(legacy, {});
  if (!old || typeof old !== "object" || Array.isArray(old)) {
    throw new GatewayError(ERROR_CODES.CONFIG_INVALID, "Invalid legacy install document");
  }
  const values = {};
  const unsupported = [];
  for (const [group, entries] of Object.entries(old.gatewayConfig ?? {})) {
    if (group === "monitor") continue; // UI-only settings remain consumer-owned.
    for (const [id, value] of Object.entries(entries ?? {})) {
      if (definitions.has(id)) values[id] = validateSetting(id, value);
      else unsupported.push(id);
    }
  }
  for (const [id, key] of Object.entries(policyKeys)) {
    if (old.agentUpdates?.[key] != null) values[id] = validateSetting(id, old.agentUpdates[key]);
  }
  return { schemaVersion: 1, revision: 0, values, unsupportedLegacySettings: unsupported };
}

function resolveDocument(document, env) {
  const sources = {};
  const values = {};
  for (const d of SETTING_DEFINITIONS) {
    let value = document.values[d.id] ?? d.defaultValue;
    sources[d.id] = Object.hasOwn(document.values, d.id) ? "stored" : "default";
    const raw = env[d.environment];
    if (raw != null && raw !== "") {
      if (d.type === "boolean") {
        const normalized = String(raw).toLowerCase();
        value = ["1", "true", "on", "yes"].includes(normalized) ? true
          : ["0", "false", "off", "no"].includes(normalized) ? false : raw;
      } else value = d.type === "number" ? Number(raw) : raw;
      sources[d.id] = "environment";
    }
    values[d.id] = validateSetting(d.id, value);
  }
  validateValues(values);
  return { ...document, effectiveValues: values, sources };
}

export function resolveSettings({ env = process.env, ...paths } = {}) {
  const { path, legacy } = { ...settingsPaths(env), ...paths };
  return resolveDocument(documentAt(path, legacy), env);
}

export class GatewaySettings {
  constructor({ env = process.env, ...paths } = {}) {
    this.env = { ...env };
    Object.assign(this, { ...settingsPaths(env), ...paths });
    const configured = resolveSettings(this);
    this.activeValues = structuredClone(configured.effectiveValues);
    this.activeRevision = configured.revision;
  }

  snapshot() {
    const configured = resolveSettings(this);
    const options = SETTING_DEFINITIONS.map(d => ({
      ...d, currentValue: this.activeValues[d.id], configuredValue: configured.effectiveValues[d.id],
      storedValue: configured.values[d.id] ?? null, source: configured.sources[d.id],
      editable: configured.sources[d.id] !== "environment",
      pending: this.activeValues[d.id] !== configured.effectiveValues[d.id]
    }));
    return { ok: true, revision: configured.revision, activeRevision: this.activeRevision,
      options, pendingRestart: options.some(d => d.pending), pendingLiveApply: false,
      unsupportedLegacySettings: configured.unsupportedLegacySettings ?? [] };
  }

  update({ values = {}, resetIds = [], expectedRevision } = {}) {
    if (!values || typeof values !== "object" || Array.isArray(values) || !Array.isArray(resetIds)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "values, resetIds and expectedRevision are required in the declared shapes");
    }
    const initial = documentAt(this.path, this.legacy);
    updateJsonFile(this.path, initial, document => {
      if (document.revision !== expectedRevision) throw new GatewayError(ERROR_CODES.CONFIG_CONFLICT, "Settings changed; read them again", { revision: document.revision });
      const next = { ...document, values: { ...document.values }, revision: document.revision + 1 };
      for (const id of new Set([...Object.keys(values), ...resetIds])) {
        const d = definitions.get(id);
        if (!d) throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Unsupported Gateway setting: ${id}`);
        if (this.env[d.environment] != null && this.env[d.environment] !== "") throw new GatewayError(ERROR_CODES.CONFIG_CONFLICT, `${id} is locked by ${d.environment}`);
        if (Object.hasOwn(values, id)) next.values[id] = validateSetting(id, values[id]);
        else delete next.values[id];
      }
      resolveDocument(next, this.env);
      return next;
    });
    return this.snapshot();
  }
}
