import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";

const directory = await mkdtemp(join(tmpdir(), "acp-gateway-subagent-smoke-"));
// The Gateway protects the directory its state lives in, and a Claude worker is
// denied Read of everything under a protected path, so the workspace has to be
// a sibling of that directory and never inside it. The socket stays in
// `directory`: only the socket file itself is protected, and a deeper path gets
// close to the unix socket path limit (104 bytes on macOS).
const gatewayDirectory = join(directory, "gateway");
const workspace = join(directory, "workspace");
const socketPath = join(directory, "gateway.sock");
const statePath = join(gatewayDirectory, "state.json");
const token = "subagent-smoke-control-token-at-least-24-characters";
await mkdir(gatewayDirectory, { mode: 0o700 });
await mkdir(workspace);
await writeFile(join(workspace, "task.txt"), "alpha=17\nbeta=25\n", "utf8");

const daemon = spawn(process.execPath, [fileURLToPath(new URL("../src/gateway-daemon.js", import.meta.url))], {
  stdio: ["ignore", "ignore", "inherit"],
  env: {
    ...process.env,
    ACP_GATEWAY_SOCKET: socketPath,
    ACP_GATEWAY_STATE: statePath,
    ACP_GATEWAY_CONTROL_TOKEN: token,
    ACP_GATEWAY_ROOT_ID: "subagent-smoke-main"
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
    ACP_GATEWAY_ROOT_ID: "subagent-smoke-main"
  }
});
const client = new Client({ name: "acp-subagent-live-smoke", version: "0.2.0" });

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const data = result.structuredContent;
  if (result.isError || data?.ok === false) throw new Error(`${name}: ${data?.error}`);
  return data;
}

async function run(provider) {
  const model = provider === "grok" ? "grok-4.5" : "sonnet";
  const marker = `${provider.toUpperCase()}_SUBAGENT_OK CHILD_SUM_42`;
  const opened = await call("agent_acp_session_open", {
    provider,
    cwd: workspace,
    title: `${provider} nested subagent smoke`,
    model,
    permissionPolicy: "auto_approve"
  });
  const events = [];
  try {
    await call("agent_acp_prompt", {
      sessionId: opened.sessionId,
      prompt: [
        "This is an end-to-end nested-agent integration test.",
        "You MUST invoke exactly one built-in subagent using your Agent/Task/subagent tool.",
        "Delegate this bounded job to it: read task.txt, add alpha and beta, and return exactly CHILD_SUM_42 to you.",
        "Wait for and inspect the child result. Do not modify files and do not perform the delegated calculation yourself.",
        `After receiving the child result, reply with exactly: ${marker}`
      ].join("\n")
    });
    let cursor = 0;
    while (true) {
      const poll = await call("agent_acp_poll", {
        sessionId: opened.sessionId,
        cursor,
        waitMs: 10_000,
        includeThoughts: false,
        includeToolEvents: true
      });
      cursor = poll.nextCursor;
      events.push(...poll.events);
      if (["idle", "error", "cancelled"].includes(poll.status)) {
        assert.equal(poll.status, "idle", poll.error);
        assert.ok(
          poll.result.text.trim().endsWith(marker),
          `${provider} parent did not finish with the child result marker: ${poll.result.text}`
        );
        const toolEvents = events.filter((event) => /tool/i.test(event.type ?? ""));
        const evidence = JSON.stringify(toolEvents);
        assert.match(
          evidence,
          /subagent|agent|task|general-purpose|explore/i,
          `${provider} returned the marker without observable nested-agent tool evidence: ${evidence.slice(0, 4000)}`
        );
        return {
          provider,
          model: opened.model,
          status: poll.status,
          text: poll.result.text.trim(),
          nestedToolEvents: toolEvents.map(compactToolEvent)
        };
      }
      if (["waiting_permission", "waiting_input"].includes(poll.status)) {
        throw new Error(`${provider} unexpectedly requires Main input under auto_approve: ${JSON.stringify(poll.events)}`);
      }
    }
  } finally {
    await call("agent_acp_session", { action: "close", sessionId: opened.sessionId }).catch(() => {});
  }
}

await client.connect(transport);
try {
  const results = [];
  for (const provider of ["claude", "grok"]) results.push(await run(provider));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await client.close();
  probe.close();
  const exited = once(daemon, "close");
  daemon.kill("SIGTERM");
  await exited;
  await rm(directory, { recursive: true, force: true });
}

function compactToolEvent(event) {
  return {
    type: event.type,
    title: event.title ?? event.toolCall?.title ?? event.data?.title ?? null,
    kind: event.kind ?? event.toolCall?.kind ?? event.data?.kind ?? null,
    status: event.status ?? event.data?.status ?? null
  };
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
