import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("socket Gateway separates public guide access from Main control", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-socket-"));
  const socketPath = join(directory, "gateway.sock");
  const statePath = join(directory, "state.json");
  const token = "test-control-token-at-least-24-characters";
  const daemonPath = fileURLToPath(new URL("../src/gateway-daemon.js", import.meta.url));
  const daemon = spawn(process.execPath, [daemonPath], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      ACP_GATEWAY_SOCKET: socketPath,
      ACP_GATEWAY_STATE: statePath,
      ACP_GATEWAY_CONTROL_TOKEN: token,
      ACP_GATEWAY_ROOT_ID: "main-a"
    }
  });
  let daemonError = "";
  daemon.stderr.on("data", (chunk) => {
    daemonError += chunk;
  });
  const guide = new GatewayRpcClient({ socketPath, autoStart: false });
  const wrong = new GatewayRpcClient({
    socketPath,
    token: "wrong-control-token-at-least-24-chars",
    rootId: "main-a",
    autoStart: false
  });
  const main = new GatewayRpcClient({ socketPath, token, rootId: "main-a", autoStart: false });
  const imposter = new GatewayRpcClient({ socketPath, token, rootId: "main-b", autoStart: false });
  let mcpClient;
  try {
    await waitForSocket(guide, daemon, () => daemonError);
    assert.equal((await guide.call("guide")).controlAvailable, false);
    await assert.rejects(wrong.call("session", { action: "list" }), /Control access denied/);
    await assert.rejects(imposter.call("session", { action: "list" }), /root identity mismatch/);
    assert.deepEqual((await main.call("session", { action: "list" })).sessions, []);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
      stderr: "pipe",
      env: {
        ...process.env,
        ACP_GATEWAY_SOCKET: socketPath,
        ACP_GATEWAY_CONTROL_TOKEN: token,
        ACP_GATEWAY_ROOT_ID: "main-a"
      }
    });
    mcpClient = new Client({ name: "gateway-test", version: "0.2.0" });
    await mcpClient.connect(transport);
    const listedTools = await mcpClient.listTools();
    assert.ok(listedTools.tools.some((tool) => tool.name === "agent_acp_config"));
    const viaMcp = await mcpClient.callTool({
      name: "agent_acp_session",
      arguments: { action: "list" }
    });
    assert.equal(viaMcp.isError, false);
    assert.deepEqual(viaMcp.structuredContent.sessions, []);

    const viaMcpError = await mcpClient.callTool({
      name: "agent_acp_session",
      arguments: { action: "get", sessionId: "session-missing" }
    });
    assert.equal(viaMcpError.isError, true);
    assert.deepEqual(viaMcpError.structuredContent, {
      ok: false,
      error: "Unknown sessionId: session-missing",
      errorCode: "UNKNOWN_SESSION",
      details: { sessionId: "session-missing" }
    });
  } finally {
    await mcpClient?.close();
    guide.close();
    wrong.close();
    imposter.close();
    main.close();
    if (daemon.exitCode == null) {
      const exited = once(daemon, "close");
      daemon.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("socket client reconnects subscriptions with the last delivered cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-reconnect-"));
  const socketPath = join(directory, "gateway.sock");
  const received = [];
  let restoredCursor;
  let first;
  let second;
  const client = new GatewayRpcClient({ socketPath, token: "token", rootId: "main-a", autoStart: false });
  try {
    first = await startSubscriptionServer(socketPath, 1, (request) => {
      if (request.method !== "subscribe") return { ok: true, result: { removed: true } };
      return {
        ok: true,
        result: { subscriptionId: "server-sub-1", sessions: [], events: [], cursorTruncated: {} },
        event: { subscriptionId: "server-sub-1", event: { sessionId: "session-a", sequence: 0, type: "first" } }
      };
    });
    const subscription = await client.subscribe({ sessionIds: ["session-a"] }, (event) => received.push(event));
    await waitFor(() => received.some((event) => event.sequence === 0));

    for (const socket of first.sockets) socket.destroy();
    first.server.close();
    await once(first.server, "close");
    await unlink(socketPath).catch(() => {});

    second = await startSubscriptionServer(socketPath, 2, (request) => {
      if (request.method === "subscribe") {
        restoredCursor = request.args.cursors?.["session-a"];
        return {
          ok: true,
          result: {
            subscriptionId: "server-sub-2",
            sessions: [],
            events: [{ sessionId: "session-a", sequence: 1, type: "replayed" }],
            cursorTruncated: { "session-a": false }
          },
          event: { subscriptionId: "server-sub-2", event: { sessionId: "session-a", sequence: 2, type: "live" } }
        };
      }
      return { ok: true, result: { removed: true } };
    });

    await waitFor(() => received.some((event) => event.sequence === 2));
    assert.equal(restoredCursor, 1);
    assert.deepEqual(received.filter((event) => Number.isFinite(event.sequence)).map((event) => event.sequence), [0, 1, 2]);
    assert.equal((await client.unsubscribe(subscription.subscriptionId)).removed, true);
  } finally {
    client.close();
    for (const fixture of [first, second]) {
      if (!fixture) continue;
      for (const socket of fixture.sockets) socket.destroy();
      if (fixture.server.listening) {
        fixture.server.close();
        await once(fixture.server, "close");
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("socket client removes only the failed subscription on subscription_error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-subscription-error-"));
  const socketPath = join(directory, "gateway.sock");
  const received = [];
  let fixture;
  const client = new GatewayRpcClient({ socketPath, token: "token", rootId: "main-a", autoStart: false });
  try {
    fixture = await startSubscriptionServer(socketPath, 1, (request) => ({
      ok: true,
      result: { subscriptionId: "failed-sub", sessions: [], events: [], cursorTruncated: {} },
      subscriptionError: { subscriptionId: "failed-sub", error: "too slow" }
    }));
    const subscription = await client.subscribe({}, (event) => received.push(event));
    await waitFor(() => received.some((event) => event.type === "subscription_error"));
    assert.equal(received.at(-1).error, "too slow");
    assert.equal(client.subscriptions.has(subscription.subscriptionId), false);
    assert.equal(client.reconnectTimer, null);
  } finally {
    client.close();
    if (fixture) {
      for (const socket of fixture.sockets) socket.destroy();
      if (fixture.server.listening) {
        fixture.server.close();
        await once(fixture.server, "close");
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent daemon starts leave exactly one owner for a socket and state file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-gateway-daemon-lock-"));
  const socketPath = join(directory, "gateway.sock");
  const statePath = join(directory, "state.json");
  const token = "daemon-lock-token-at-least-24-characters";
  const daemonPath = fileURLToPath(new URL("../src/gateway-daemon.js", import.meta.url));
  const daemons = [0, 1].map(() => spawn(process.execPath, [daemonPath], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      ACP_GATEWAY_SOCKET: socketPath,
      ACP_GATEWAY_STATE: statePath,
      ACP_GATEWAY_CONTROL_TOKEN: token,
      ACP_GATEWAY_ROOT_ID: "main-a"
    }
  }));
  const errors = ["", ""];
  daemons.forEach((daemon, index) => daemon.stderr.on("data", (chunk) => { errors[index] += chunk; }));
  const guide = new GatewayRpcClient({ socketPath, autoStart: false });
  try {
    await waitFor(() => daemons.filter((daemon) => daemon.exitCode != null).length === 1);
    const loserIndex = daemons.findIndex((daemon) => daemon.exitCode != null);
    assert.notEqual(daemons[loserIndex].exitCode, 0);
    assert.match(errors[loserIndex], /already starting or running/);
    await waitForSocket(guide, daemons[1 - loserIndex], () => errors[1 - loserIndex]);
    assert.equal((await guide.call("guide")).ok, true);
  } finally {
    guide.close();
    for (const daemon of daemons) {
      if (daemon.exitCode != null) continue;
      const exited = once(daemon, "close");
      daemon.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForSocket(client, daemon, readDaemonError) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (daemon.exitCode != null) {
      throw new Error(`Gateway daemon exited with ${daemon.exitCode}: ${readDaemonError()}`);
    }
    try {
      await client.connect();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

async function startSubscriptionServer(socketPath, generation, respond) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const request = JSON.parse(line);
      const response = respond(request);
      const messages = [JSON.stringify({ id: request.id, ...response })];
      if (response.event) messages.push(JSON.stringify({ type: "event", ...response.event }));
      if (response.subscriptionError) messages.push(JSON.stringify({ type: "subscription_error", ...response.subscriptionError }));
      socket.write(`${messages.join("\n")}\n`);
    });
  });
  server.generation = generation;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { server, sockets };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not reached");
}
