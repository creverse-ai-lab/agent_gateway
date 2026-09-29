import { fileURLToPath } from "node:url";
import { gatewaySocketPath } from "./config.js";
import { compareReleases } from "./version.js";

const RECONNECT = "reconnect the agent-acp MCP server";
// shutdown_if_idle first shipped in 1.5.0; an older daemon rejects it as an
// unknown method, so pointing a user at it would be a dead end.
const IDLE_SHUTDOWN_SINCE = "1.5.0";

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
