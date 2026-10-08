import { fstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONTROL_IDENTITY_ENV } from "./caller.js";
import { ERROR_CODES, GatewayError } from "./errors.js";
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

// Set by the autostart (socket-rpc.js) on a daemon whose identity it writes to
// the daemon's stdin rather than its env. Not a secret: it only says where to look.
export const DAEMON_IDENTITY_STDIN_ENV = "ACP_GATEWAY_IDENTITY_STDIN";
// {token, rootId} is well under 1 KiB. The bound is for a writer that never
// sends the line end.
const IDENTITY_LINE_MAX_BYTES = 16 * 1024;
// The autostart writes the line right after the spawn, before this process has
// even loaded, so it is waiting in the pipe. This only bounds a launcher that
// holds the pipe open and never writes.
const IDENTITY_LINE_TIMEOUT_MS = 5_000;

/**
 * The daemon's identity, taken once at startup and kept out of its env:
 * whatever it spawns later inherits process.env unless told otherwise, and npm
 * or uv running an adapter update's lifecycle scripts must not find the token
 * there. The socket path stays: the daemon reads it again (protected paths).
 *
 * An env that sets the token decides, and stdin is never read: a daemon started
 * by hand, by a supervisor, or by a consumer that launches it itself. Deleting
 * it from process.env does not reach the environment block the OS keeps for
 * the process, though, which any process of the same user can read (`ps -E` on
 * macOS, /proc/<pid>/environ on Linux). So the autostart sets
 * DAEMON_IDENTITY_STDIN_ENV instead and writes one JSON line {token, rootId} to
 * the daemon's stdin, read here with a size bound and a deadline and kept only
 * in what this returns. A missing or unusable line rejects with
 * DAEMON_IDENTITY_INVALID; neither the token nor the flag, with the old error.
 */
export async function takeDaemonIdentity(env = process.env, {
  // A stream to read the line from instead of fd 0 (tests).
  input = null,
  maxBytes = IDENTITY_LINE_MAX_BYTES,
  timeoutMs = IDENTITY_LINE_TIMEOUT_MS
} = {}) {
  const fromEnv = Boolean(env.ACP_GATEWAY_CONTROL_TOKEN) || env[DAEMON_IDENTITY_STDIN_ENV] !== "1";
  const identity = fromEnv ? { token: controlToken(env), rootId: env.ACP_GATEWAY_ROOT_ID || null } : null;
  // Before anything is awaited, so nothing that runs meanwhile can copy them.
  for (const name of [...CONTROL_IDENTITY_ENV, DAEMON_IDENTITY_STDIN_ENV]) delete env[name];
  if (identity) return identity;
  const stream = input ?? stdinPipe();
  if (!stream) throw identityError("stdin is not a pipe");
  return parseIdentityLine(await readIdentityLine(stream, { maxBytes, timeoutMs }));
}

// fd 0 when it is a pipe: a socketpair when Node spawned this process with a
// piped stdin (libuv makes those), a FIFO from a shell. Never a terminal or
// /dev/null, where waiting for a line would only stall the start.
function stdinPipe() {
  try {
    const stats = fstatSync(0);
    return stats.isFIFO() || stats.isSocket() ? process.stdin : null;
  } catch {
    return null;
  }
}

// Exactly one line: nothing after its end is read. The stream is destroyed
// either way, so it cannot hold the event loop open; libuv never closes fds 0-2
// itself, so fd 0 stays an inert pipe at its end.
function readIdentityLine(stream, { maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, line) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.on("error", () => {});
      stream.destroy();
      if (error) reject(error);
      else resolve(line);
    };
    const onData = (chunk) => {
      const end = chunk.indexOf(0x0a);
      const part = end === -1 ? chunk : chunk.subarray(0, end);
      bytes += part.length;
      if (bytes > maxBytes) return finish(identityError(`more than ${maxBytes} bytes arrived on stdin without a line end`));
      parts.push(part);
      if (end !== -1) finish(null, Buffer.concat(parts).toString("utf8"));
    };
    const onEnd = () => finish(identityError("stdin closed before a whole line arrived"));
    const onError = (error) => finish(identityError(`reading stdin failed: ${error.message}`));
    const timer = setTimeout(() => finish(identityError(`no line arrived on stdin within ${timeoutMs} ms`)), timeoutMs);
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

// Never quotes the line: a malformed one may still hold the token.
function parseIdentityLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    throw identityError("the line on stdin is not JSON");
  }
  const { token, rootId = null } = message !== null && typeof message === "object" ? message : {};
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) {
    throw identityError(`the line on stdin holds no Control token of at least ${MIN_TOKEN_LENGTH} characters`);
  }
  if (rootId !== null && (typeof rootId !== "string" || !rootId)) {
    throw identityError("the rootId on stdin is not a non-empty string");
  }
  return { token, rootId };
}

function identityError(reason) {
  return new GatewayError(
    ERROR_CODES.DAEMON_IDENTITY_INVALID,
    `The daemon was started to read its Control identity from stdin (${DAEMON_IDENTITY_STDIN_ENV}=1), but ${reason}`
  );
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
