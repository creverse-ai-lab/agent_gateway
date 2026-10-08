import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";

// Who is on the other end of a control connection. The control MCP server is a
// child of the agent CLI that uses it, so its parent process and the session id
// that CLI exports are facts about the caller, not guesses. The Gateway records
// them on the sessions a caller opens and the turns it starts, so a consumer can
// tell two Mains apart without reading either one's transcript (every Main on a
// machine shares one rootId).
//
// instanceId is minted per MCP server process. Codex exports no thread id to its
// MCP servers and one Codex app process hosts many threads, so the process can
// only say "codex"; the thread arrives per call instead (see callerForCall).

export const CALLER_PROVIDERS = Object.freeze(["claude", "codex", "grok"]);
const SESSION_ENV = Object.freeze({
  claude: "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
  grok: "GROK_SESSION_ID"
});
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const isId = (value) => typeof value === "string" && ID.test(value);

// Env vars that say which agent session a process belongs to. The daemon
// inherits the env of whichever Main autostarted it, and a worker inherits the
// daemon's, so without scrubbing every worker would claim to be that Main.
export const SESSION_MARKER_ENV = Object.freeze([
  "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "GROK_SESSION_ID"
]);

/** A copy of env without the session markers. */
export function withoutSessionMarkers(env) {
  const copy = { ...env };
  for (const name of SESSION_MARKER_ENV) delete copy[name];
  return copy;
}

// The Control identity a Main authenticates with.
export const CONTROL_IDENTITY_ENV = Object.freeze(["ACP_GATEWAY_CONTROL_TOKEN", "ACP_GATEWAY_ROOT_ID"]);

// What lets a process reach the Control and act as a Main: the identity, and
// the socket to present it on. The daemon is the only child ever handed them,
// by its autostart (socket-rpc.js), explicitly.
export const GATEWAY_ACCESS_ENV = Object.freeze([...CONTROL_IDENTITY_ENV, "ACP_GATEWAY_SOCKET"]);

/**
 * The env a child process may get: the inherited env without session markers,
 * then what the spawner sets explicitly, and never the Gateway access env, not
 * even when it is asked for. Markers set explicitly stay: a worker naming its
 * own session is not claiming the Main's. Workers, terminals, installer and
 * update commands (npm and uv run third-party lifecycle scripts) all get this.
 */
export function childEnv(explicit = {}, inherited = process.env) {
  const env = { ...withoutSessionMarkers(inherited), ...explicit };
  for (const name of GATEWAY_ACCESS_ENV) delete env[name];
  return env;
}

/**
 * The agent CLI a process name belongs to, or null. Whole name tokens only, and
 * an ambiguous name (two providers) is nobody's: "grok-codex-bridge" must not
 * become whichever provider happens to be listed first.
 */
export function agentFromCommand(command) {
  const tokens = new Set(basename(String(command ?? "").trim()).toLowerCase().split(/[^a-z0-9]+/));
  const matches = CALLER_PROVIDERS.filter((provider) => tokens.has(provider));
  return matches.length === 1 ? matches[0] : null;
}

function readParentCommand(ppid) {
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(ppid)], { encoding: "utf8", timeout: 1_000, env: childEnv() }).trim();
  } catch {
    return null;
  }
}

export function callerFromProcess({ env = process.env, ppid = process.ppid, readCommand = readParentCommand } = {}) {
  const pid = Number.isInteger(ppid) && ppid > 1 ? ppid : null;
  // The parent's own name decides the provider. Session markers alone can't:
  // an agent started from another agent's shell inherits its launcher's id too.
  let provider = pid ? agentFromCommand(readCommand(pid)) : null;
  if (!provider) {
    const marked = CALLER_PROVIDERS.filter((candidate) => ID.test(env[SESSION_ENV[candidate]] ?? ""));
    provider = marked.length === 1 ? marked[0] : null;
  }
  const sessionId = provider && ID.test(env[SESSION_ENV[provider]] ?? "") ? env[SESSION_ENV[provider]] : null;
  return normalizeCaller({ provider, sessionId, pid, instanceId: `mcp-${randomUUID()}` });
}

const CODEX_TURN_META = "x-codex-turn-metadata";

/**
 * The caller for one tools/call: the process caller plus the thread and turn
 * Codex puts in that call's _meta (codex-cli 0.155.1 sends `threadId` and
 * `x-codex-turn-metadata.{thread_id, turn_id}` on every call). Always a copy,
 * never the process caller mutated: calls from different threads interleave.
 * A parent already known to be another CLI keeps its identity, and with no
 * known parent only the Codex-branded key is taken as proof of Codex.
 */
export function callerForCall(caller, meta) {
  if (!caller || (caller.provider !== null && caller.provider !== "codex")) return caller;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return caller;
  const raw = meta[CODEX_TURN_META];
  const turn = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (caller.provider === null && !turn) return caller;
  const threadId = [meta.threadId, turn?.thread_id].find(isId);
  if (!threadId) return caller;
  const { turnId: _stale, ...rest } = caller;
  return { ...rest, provider: "codex", sessionId: threadId, ...(isId(turn?.turn_id) ? { turnId: turn.turn_id } : {}) };
}

/**
 * The caller a request claims, reduced to known, well-formed fields, or null.
 * Tolerant by design: a malformed caller only loses attribution, never the call.
 */
export function normalizeCaller(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isId(value.instanceId)) return null;
  return {
    provider: CALLER_PROVIDERS.includes(value.provider) ? value.provider : null,
    sessionId: isId(value.sessionId) ? value.sessionId : null,
    pid: Number.isInteger(value.pid) && value.pid > 1 ? value.pid : null,
    instanceId: value.instanceId,
    // The Main's own turn (Codex only, from _meta). Absent elsewhere, so a
    // recorded caller (and every poll that carries it) does not grow.
    ...(isId(value.turnId) ? { turnId: value.turnId } : {})
  };
}
