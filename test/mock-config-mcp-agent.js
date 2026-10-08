import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// A worker whose CLI starts the Control MCP from the user's own config, the way
// Codex starts what ~/.codex/config.toml registers for the workers the Gateway
// runs (W1). Before it answers anything it starts the real front door three
// ways, and writes how each one exited, with its own pid and marker, to
// ACP_MOCK_FRONT_DOOR_LOG:
//   inherited: with this worker's env, as a CLI that passes its env on would;
//   cleared:   without the worker marker, as Codex clears its MCP servers' env;
//   socket:    cleared, on the daemon's own socket (ACP_MOCK_DAEMON_SOCKET), as
//              a config entry that names the socket would be.
const frontDoor = fileURLToPath(new URL("../src/index.js", import.meta.url));
const start = (env) => {
  const result = spawnSync(process.execPath, [frontDoor], { env, input: "", encoding: "utf8", timeout: 20_000 });
  return { status: result.status, stderr: result.stderr };
};
const { ACP_GATEWAY_WORKER: marker, ...cleared } = process.env;
writeFileSync(process.env.ACP_MOCK_FRONT_DOOR_LOG, JSON.stringify({
  pid: process.pid,
  marker: marker ?? null,
  inherited: start(process.env),
  cleared: start(cleared),
  socket: start({ ...cleared, ACP_GATEWAY_SOCKET: process.env.ACP_MOCK_DAEMON_SOCKET })
}));

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method || !Object.hasOwn(message, "id")) return;
  const result = message.method === "initialize"
    ? { protocolVersion: 1, agentCapabilities: {} }
    : message.method === "session/new"
      ? { sessionId: `config-mcp-${process.pid}` }
      : message.method === "session/prompt" ? { stopReason: "end_turn" } : {};
  send({ jsonrpc: "2.0", id: message.id, result });
});
