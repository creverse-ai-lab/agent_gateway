import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";

const directory = await mkdtemp(join(tmpdir(), "acp-smoke-"));
const socketPath = join(directory, "gateway.sock");
const statePath = join(directory, "state.json");
const token = "live-smoke-control-token-at-least-24-characters";
const daemon = spawn(process.execPath, [fileURLToPath(new URL("../src/gateway-daemon.js", import.meta.url))], {
  stdio: ["ignore", "ignore", "inherit"],
  env: {
    ...process.env,
    ACP_GATEWAY_SOCKET: socketPath,
    ACP_GATEWAY_STATE: statePath,
    ACP_GATEWAY_CONTROL_TOKEN: token
  }
});
const probe = new GatewayRpcClient({ socketPath, autoStart: false });
await waitForGateway(probe, daemon);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../src/index.js", import.meta.url).pathname],
  stderr: "pipe",
  env: {
    ...process.env,
    ACP_GATEWAY_SOCKET: socketPath,
    ACP_GATEWAY_CONTROL_TOKEN: token,
    ACP_GATEWAY_ROOT_ID: "live-smoke-main"
  }
});
const client = new Client({ name: "acp-mcp-live-smoke", version: "0.1.0" });

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const data = result.structuredContent;
  if (result.isError || data?.ok === false) throw new Error(`${name}: ${data?.error}`);
  return data;
}

async function run(provider) {
  const marker = `${provider.toUpperCase()}_MCP_ACP_OK`;
  const requestedModel = provider === "grok" ? "grok-4.5" : "sonnet";
  const opened = await call("agent_acp_session_open", {
    provider,
    cwd: process.cwd(),
    title: "live smoke",
    model: requestedModel,
    permissionPolicy: "auto_approve"
  });
  assert.equal(typeof opened.model, "string");
  try {
    await call("agent_acp_prompt", {
      sessionId: opened.sessionId,
      prompt: `Reply with exactly ${marker}. Do not use tools.`
    });
    let cursor = 0;
    while (true) {
      const poll = await call("agent_acp_poll", {
        sessionId: opened.sessionId,
        cursor,
        waitMs: 10_000
      });
      cursor = poll.nextCursor;
      if (["idle", "error", "cancelled"].includes(poll.status)) {
        assert.equal(poll.status, "idle", poll.error);
        assert.equal(poll.result.text, marker);
        return { provider, model: opened.model, status: poll.status, text: poll.result.text };
      }
      if (poll.status === "waiting_permission") {
        throw new Error(`${provider} unexpectedly requested permission`);
      }
    }
  } finally {
    await call("agent_acp_session", { action: "close", sessionId: opened.sessionId });
  }
}

await client.connect(transport);
try {
  console.log(JSON.stringify(await Promise.all([run("grok"), run("claude")]), null, 2));
} finally {
  await client.close();
  probe.close();
  const exited = once(daemon, "close");
  daemon.kill("SIGTERM");
  await exited;
  await rm(directory, { recursive: true, force: true });
}

async function waitForGateway(rpc, child) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Gateway daemon exited with ${child.exitCode}`);
    try {
      await rpc.connect();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}
