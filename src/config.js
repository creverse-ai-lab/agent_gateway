import { readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONTROL_IDENTITY_ENV } from "./caller.js";
import { resolveSettings, SETTING_DEFINITIONS, settingsPaths } from "./settings.js";

const uid = typeof process.getuid === "function" ? process.getuid() : "user";

export function gatewaySocketPath() {
  return process.env.ACP_GATEWAY_SOCKET || join(tmpdir(), `acp-gateway-${uid}.sock`);
}

export function gatewayStatePath() {
  return process.env.ACP_GATEWAY_STATE || join(homedir(), ".acp-gateway", "state.json");
}

// Paths a worker must never read or write, whatever its session roots: the
// directories holding the Control token (install.json), engine settings and
// Gateway state, and the control socket. Stripping the token from the worker's
// environment is not enough when the file that stores it is readable.
export function gatewayProtectedPaths({ statePath = gatewayStatePath(), env = process.env } = {}) {
  const { legacy, path: settingsPath } = settingsPaths(env);
  const candidates = [
    join(homedir(), ".acp-gateway"),
    dirname(legacy),
    dirname(settingsPath),
    dirname(statePath),
    gatewaySocketPath()
  ];
  // The socket usually does not exist yet, so canonicalize through its parent:
  // on macOS the temp directory is itself a symlink into /private.
  const canonical = candidates.map((path) => {
    const absolute = resolve(path);
    try {
      return realpathSync(absolute);
    } catch {
      try {
        return join(realpathSync(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
      } catch {
        return absolute;
      }
    }
  });
  return [...new Set(canonical)];
}

const TOKEN_REQUIRED = "ACP_GATEWAY_CONTROL_TOKEN must be set to at least 24 characters";
const MIN_TOKEN_LENGTH = 24;

export function controlToken(env = process.env) {
  const value = env.ACP_GATEWAY_CONTROL_TOKEN;
  if (!value || value.length < MIN_TOKEN_LENGTH) throw new Error(TOKEN_REQUIRED);
  return value;
}

/**
 * The Control identity the installer keeps in install.json
 * (ACP_GATEWAY_INSTALL_STATE, else ~/.acp-gateway/install.json): {path, token,
 * rootId}, a field undefined when the file does not hold it. Throws when the
 * file cannot be read or parsed.
 */
export function installedIdentity(env = process.env) {
  const path = settingsPaths(env).legacy;
  let identity;
  try {
    identity = JSON.parse(readFileSync(path, "utf8"))?.identity;
  } catch (error) {
    throw new Error(`Cannot read the Control identity from ${path}: ${error.message}`, { cause: error });
  }
  const text = (value) => typeof value === "string" && value ? value : undefined;
  return { path, token: text(identity?.token), rootId: text(identity?.rootId) };
}

/**
 * The identity a front door presents. Each of the token and the root id comes
 * from the env when the env sets it (an entry registered before 1.8.0, tests,
 * an isolated deployment), else from install.json, which is the only place the
 * installer keeps it since agent configs stopped carrying it, else the old
 * error (token) or fallback (`main-<ppid>` root id). install.json is read only
 * when the env leaves something out.
 */
export function controlIdentity({ env = process.env, ppid = process.ppid } = {}) {
  let installed;
  const fromInstall = () => {
    if (!installed) {
      try {
        installed = installedIdentity(env);
      } catch (error) {
        installed = { error };
      }
    }
    return installed;
  };
  let token;
  if (env.ACP_GATEWAY_CONTROL_TOKEN) {
    token = controlToken(env);
  } else {
    const stored = fromInstall();
    if (!stored.token || stored.token.length < MIN_TOKEN_LENGTH) {
      const reason = stored.error?.message ?? `${stored.path} holds no valid Control identity`;
      throw new Error(`${TOKEN_REQUIRED}, or install.json must hold the Control identity that acp-gateway-bootstrap --install-control writes: ${reason}`);
    }
    token = stored.token;
  }
  // A root id the install state cannot supply is the old per-process fallback, never an error.
  return { token, rootId: env.ACP_GATEWAY_ROOT_ID || fromInstall().rootId || `main-${ppid}` };
}

/**
 * The daemon's identity, read once at startup and then deleted from its env:
 * whatever it spawns later inherits process.env unless told otherwise, and npm
 * or uv running an adapter update's lifecycle scripts must not find the token
 * there. The socket path stays: the daemon reads it again (protected paths).
 */
export function takeDaemonIdentity(env = process.env) {
  const token = controlToken(env);
  const rootId = env.ACP_GATEWAY_ROOT_ID || null;
  for (const name of CONTROL_IDENTITY_ENV) delete env[name];
  return { token, rootId };
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
