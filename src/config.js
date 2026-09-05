import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSettings, SETTING_DEFINITIONS } from "./settings.js";

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

function settingsGroup(groups, effectiveValues = resolveSettings().effectiveValues) {
  return Object.fromEntries(SETTING_DEFINITIONS.filter(d => groups.includes(d.group)).map(d => [d.id, effectiveValues[d.id]]));
}

export function gatewayLifecycleConfig(values) {
  return settingsGroup(["lifecycle", "resourceLimits"], values);
}

export function gatewayObservabilityConfig(values) {
  return settingsGroup(["observability"], values);
}

export function gatewayPersistenceConfig(values) {
  const stateRecovery = process.env.ACP_GATEWAY_STATE_RECOVERY || null;
  if (stateRecovery != null && !["truncate", "snapshot-drop", "cold"].includes(stateRecovery)) throw new Error("Invalid ACP_GATEWAY_STATE_RECOVERY");
  return { ...settingsGroup(["persistence"], values), stateRecovery };
}

export function gatewayAgentUpdateConfig(activeValues) {
  const values = settingsGroup(["agentUpdates"], activeValues);
  return { enabled: values.agentAutoUpdate, notifications: values.agentUpdateNotifications, intervalMs: values.agentUpdateIntervalMs };
}
