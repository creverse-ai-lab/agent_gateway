import { fileURLToPath } from "node:url";
import { gatewaySocketPath } from "./config.js";
import { compareReleases } from "./version.js";

const RECONNECT = "reconnect the agent-acp MCP server";
// shutdown_if_idle first shipped in 1.5.0; an older daemon rejects it as an
// unknown method, so pointing a user at it would be a dead end.
const IDLE_SHUTDOWN_SINCE = "1.5.0";

// How long one agent_acp_wait may sleep for the host on the other end, by the
// clientInfo name it sent at initialize: the default heartbeat, and the most a
// requested timeoutMs gets. A tool call the host gives up on loses its answer,
// so both stay under what the host allows. Measured with a test server whose
// tool slept 300s, sending notifications/progress every 10s, and with
// agent_acp_wait end to end:
//   Codex 0.162.0 ("codex-mcp-client")    gave up at exactly 300s (its
//                                          tool_timeout_sec, default 300); it
//                                          sends a progressToken, but progress
//                                          did not extend the limit
//   Claude Code 2.1.287 ("claude-code")   completed a whole 540s tool call; it
//                                          sends a progressToken and took the
//                                          progress
//   any other or unknown client (Grok CLI not measured yet): the usual 60s,
//   so 55s both ways
// These are what was measured and may change with the hosts. Codex's limit is
// the user's to raise (tool_timeout_sec under [mcp_servers.agent-acp] in
// ~/.codex/config.toml), which no front door can see, so
// ACP_GATEWAY_WAIT_LIMIT_MS in the agent-acp entry's env replaces both numbers,
// for any host, never past WAIT_MAX_MS.
export const WAIT_MAX_MS = 600_000;
const CLIENT_WAIT_LIMITS = Object.freeze({
  "codex-mcp-client": Object.freeze({ defaultMs: 270_000, limitMs: 280_000 }),
  "claude-code": Object.freeze({ defaultMs: 540_000, limitMs: WAIT_MAX_MS })
});
const UNKNOWN_CLIENT_WAIT_LIMITS = Object.freeze({ defaultMs: 55_000, limitMs: 55_000 });
const MIN_WAIT_LIMIT_MS = 1_000;

/** {defaultMs, limitMs} of a wait for the client that named itself clientName. */
export function waitLimits(clientName, env = process.env) {
  const configured = Number(env.ACP_GATEWAY_WAIT_LIMIT_MS);
  if (Number.isInteger(configured) && configured >= MIN_WAIT_LIMIT_MS) {
    const limitMs = Math.min(configured, WAIT_MAX_MS);
    return { defaultMs: limitMs, limitMs };
  }
  const known = typeof clientName === "string" && Object.hasOwn(CLIENT_WAIT_LIMITS, clientName);
  return { ...(known ? CLIENT_WAIT_LIMITS[clientName] : UNKNOWN_CLIENT_WAIT_LIMITS) };
}

// An abort abandons the WAIT, never the work: the worker keeps working and a
// handle stays collectable, because "I stopped waiting" and "stop the work" are
// different instructions and only agent_acp_cancel means the second one. The
// wait resolves with `abandoned`, the handoff that says where to wait again,
// unless the wait's own answer has already settled: an agent_acp_wait answer
// can carry results the Gateway counted as delivered, so it is never swapped
// for the handoff. The abandon therefore waits one turn, behind whatever is
// already settling, and only an abandon that won cancels the rpc.
export function raceAbort(pending, signal, abandoned, abandonWait = () => {}) {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", abandon);
      callback(value);
      return true;
    };
    const abandon = () => {
      setImmediate(() => {
        // Resolve the user-facing handoff first, then cancel only the
        // outstanding wait rpc. The task and worker turn are untouched.
        if (finish(resolve, abandoned)) queueMicrotask(abandonWait);
      });
    };
    pending.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
    if (signal.aborted) abandon();
    else signal.addEventListener("abort", abandon, { once: true });
  });
}

// How often agent_acp_wait tells a client that asked for progress (a
// progressToken) that it is still waiting: often enough for a client that
// resets its tool timeout on progress, as the usual 60s one is, to let the
// wait sleep past it.
export const WAIT_PROGRESS_MS = 20_000;
const MIN_WAIT_PROGRESS_MS = 100;
const MAX_WAIT_PROGRESS_MS = 300_000;

/** ACP_GATEWAY_WAIT_PROGRESS_MS, bounded; the default when unset or invalid. */
export function waitProgressMs(env = process.env) {
  const value = Number(env.ACP_GATEWAY_WAIT_PROGRESS_MS);
  if (!Number.isInteger(value) || value < MIN_WAIT_PROGRESS_MS) return WAIT_PROGRESS_MS;
  return Math.min(value, MAX_WAIT_PROGRESS_MS);
}

// The version-skew notice attached to setup and session responses, or null
// when the two sides agree. Which side is older decides the remedy: an older
// front door is fixed by reconnecting, but reconnecting to an older daemon
// only reattaches to the same daemon. Labels that do not order (unparsable,
// or equal numbers with different suffixes) keep the original notice.
export function staleFrontDoorNotice(frontDoorVersion, gatewayVersion, {
  adminScript = fileURLToPath(new URL("./admin.js", import.meta.url)),
  socketPath = gatewaySocketPath()
} = {}) {
  if (!gatewayVersion || gatewayVersion === frontDoorVersion) return null;
  const notice = { frontDoorVersion, gatewayVersion };
  const order = compareReleases(frontDoorVersion, gatewayVersion);
  if (!order) return { ...notice, action: RECONNECT };
  if (order < 0) return { ...notice, reason: "front_door_older", action: RECONNECT };
  // The front door autostarts the daemon from its own install when nothing is
  // listening, so stopping the old one is the whole upgrade.
  const lock = shellQuote(`${socketPath}.lock`);
  const stop = compareReleases(gatewayVersion, IDLE_SHUTDOWN_SINCE) < 0
    ? "it predates shutdown_if_idle, so as a last resort: confirm no worker is busy and that "
      + `\`ps -p $(cat ${lock}) -o command=\` shows gateway-daemon.js, then run \`kill $(cat ${lock})\`, `
      + "which unlike shutdown_if_idle is not idle-safe; if another app manages the daemon (e.g. a menu-bar monitor), "
      + "stop or restart it there instead"
    : `run \`acp-gateway-admin shutdown_if_idle\` (without that command on PATH: \`node ${shellQuote(adminScript)} shutdown_if_idle\`); it refuses while work is in flight, so retry later`;
  return {
    ...notice,
    reason: "gateway_older",
    action: `restart the gateway daemon when idle: ${stop}. The next agent-acp call then starts ${frontDoorVersion}`
  };
}

function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
