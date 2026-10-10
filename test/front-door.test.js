import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { CreateTaskResultSchema, TaskStatusNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { withoutSessionMarkers } from "../src/caller.js";
import { staleFrontDoorNotice } from "../src/front-door.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { startDaemon, writeMockProviders } from "./helpers/daemon-harness.js";

const FRONT_DOOR = fileURLToPath(new URL("../src/index.js", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A bound that keeps nothing running once what it bounds is over.
const bound = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());
const paths ={ adminScript: "/opt/acp/src/admin.js", socketPath: "/tmp/acp-gateway-501.sock" };

test("staleFrontDoor tells an older daemon to restart when idle, not to reconnect", () => {
  const notice = staleFrontDoorNotice("1.6.0", "1.5.2", paths);
  assert.deepEqual(Object.keys(notice), ["frontDoorVersion", "gatewayVersion", "reason", "action"]);
  assert.equal(notice.frontDoorVersion, "1.6.0");
  assert.equal(notice.gatewayVersion, "1.5.2");
  assert.equal(notice.reason, "gateway_older");
  assert.equal(
    notice.action,
    "restart the gateway daemon when idle: run `acp-gateway-admin shutdown_if_idle` "
      + "(without that command on PATH: `node /opt/acp/src/admin.js shutdown_if_idle`); "
      + "it refuses while work is in flight, so retry later. The next agent-acp call then starts 1.6.0"
  );
  assert.doesNotMatch(notice.action, /reconnect/);
  // Numeric order, not string order.
  assert.equal(staleFrontDoorNotice("1.10.0", "1.9.3", paths).reason, "gateway_older");
});

test("staleFrontDoor gives a daemon without shutdown_if_idle a stop it understands", () => {
  const notice = staleFrontDoorNotice("1.6.0", "1.4.0", paths);
  assert.equal(notice.reason, "gateway_older");
  assert.equal(
    notice.action,
    "restart the gateway daemon when idle: it predates shutdown_if_idle, so as a last resort: confirm no worker is busy "
      + "and that `ps -p $(cat /tmp/acp-gateway-501.sock.lock) -o command=` shows gateway-daemon.js, "
      + "then run `kill $(cat /tmp/acp-gateway-501.sock.lock)`, which unlike shutdown_if_idle is not idle-safe; "
      + "if another app manages the daemon (e.g. a menu-bar monitor), stop or restart it there instead. "
      + "The next agent-acp call then starts 1.6.0"
  );
  const spaced = staleFrontDoorNotice("1.6.0", "1.5.0", { ...paths, adminScript: "/Users/me/App Support/src/admin.js" });
  assert.match(spaced.action, /`node '\/Users\/me\/App Support\/src\/admin\.js' shutdown_if_idle`/);
  assert.match(staleFrontDoorNotice("1.6.0", "1.5.0").action, /node \S*admin\.js shutdown_if_idle/);
});

test("staleFrontDoor keeps reconnect for an older front door and for labels that do not order", () => {
  assert.deepEqual(staleFrontDoorNotice("1.5.2", "1.6.0", paths), {
    frontDoorVersion: "1.5.2",
    gatewayVersion: "1.6.0",
    reason: "front_door_older",
    action: "reconnect the agent-acp MCP server"
  });
  for (const [frontDoor, gateway] of [["1.6.0", "dev"], ["main", "1.6.0"], ["1.6.0-rc.1", "1.6.0"]]) {
    assert.deepEqual(staleFrontDoorNotice(frontDoor, gateway, paths), {
      frontDoorVersion: frontDoor,
      gatewayVersion: gateway,
      action: "reconnect the agent-acp MCP server"
    });
  }
  assert.equal(staleFrontDoorNotice("1.6.0", "1.6.0", paths), null);
  assert.equal(staleFrontDoorNotice("1.6.0", null, paths), null);
});

// A host that goes away without a signal only closes the front door's stdin.
// That used to close the task follower's Gateway connection alone: the front
// door's own stayed open, kept the process running, and kept its Main present
// in main_list and out of reach of a new Main's adoption. Now the front door
// closes both connections and exits, and the daemon sees its Main gone.
test("front door: a host that closes stdin ends the front door, both its connections and its Main", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-fd-"));
  const clients = [];
  let daemon = null;
  let child = null;
  try {
    const providers = await writeMockProviders(directory, { permissionPolicy: "ask" });
    daemon = await startDaemon({ directory, env: providers });
    const management = new GatewayRpcClient({
      socketPath: daemon.socketPath, token: daemon.token, rootId: daemon.rootId, statePath: daemon.statePath, autoStart: false
    });
    clients.push(management);
    const events = [];
    await management.subscribe({}, (event) => {
      if (event.type === "main_status") events.push(event);
    });

    child = spawn(process.execPath, [FRONT_DOOR], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        // Without the suite runner's own session markers: this front door is a
        // Main of its own.
        ...withoutSessionMarkers(process.env),
        ACP_GATEWAY_SOCKET: daemon.socketPath,
        ACP_GATEWAY_CONTROL_TOKEN: daemon.token,
        ACP_GATEWAY_ROOT_ID: daemon.rootId,
        // The daemon's own isolation, so a daemon this front door started could
        // never touch the developer's state.
        ACP_GATEWAY_STATE: daemon.statePath,
        ACP_GATEWAY_REGISTRY_CACHE: join(directory, "registry.json"),
        ACP_GATEWAY_INSTALL_STATE: join(directory, "install.json"),
        ACP_GATEWAY_AGENT_AUTO_UPDATE: "0",
        ACP_GATEWAY_AGENT_UPDATE_NOTIFICATIONS: "0",
        ...providers
      }
    });
    child.stderr.resume();
    const exited = once(child, "exit");
    const host = new Client({ name: "eof-test", version: "1.0.0" });
    const statuses = [];
    host.setNotificationHandler(TaskStatusNotificationSchema, (notification) => statuses.push(notification.params.status));
    await host.connect(new FrontDoorStdio(child));
    const opened = await host.callTool({
      name: "agent_acp_session_open",
      arguments: { provider: "mock", cwd: directory, permissionPolicy: "ask" }
    });
    assert.equal(opened.isError, false, JSON.stringify(opened.structuredContent));
    // A Task the front door follows, so the follower holds a connection of its
    // own too: the status its subscription pushes says that one is up.
    const { task } = await host.request(
      {
        method: "tools/call",
        params: { name: "agent_acp_run", arguments: { sessionId: opened.structuredContent.sessionId, prompt: "go" } }
      },
      CreateTaskResultSchema,
      { task: { ttl: 600_000 } }
    );
    await until(() => statuses.includes("input_required"), "the followed task's input_required");
    const [main] = (await management.call("main_list", {})).mains;
    assert.equal(main.status, "active");

    // The end of stdin, and nothing else: no signal reaches the front door.
    child.stdin.end();
    const outcome = await Promise.race([exited, bound(10_000).then(() => null)]);
    assert.deepEqual(outcome, [0, null], "the front door exits on its own, cleanly");
    await until(() => events.some((event) => event.status === "gone" && event.caller.instanceId === main.caller.instanceId),
      "its Main gone");
    assert.deepEqual((await management.call("main_list", {})).mains, []);
    // Leaving ends the waiting, never the work.
    assert.equal((await management.call("task_get", { taskId: task.taskId })).status, "input_required");
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    for (const client of clients) client.close();
    await daemon?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

// The front door's stdio, as a host speaks to it, on a process the test holds:
// closing it ends the front door's stdin and sends no signal, where the SDK's
// stdio transport sends SIGTERM to a process still up 2 seconds after that.
class FrontDoorStdio {
  constructor(child) {
    this.child = child;
    this.buffer = new ReadBuffer();
  }

  async start() {
    this.child.stdout.on("data", (chunk) => {
      this.buffer.append(chunk);
      for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) this.onmessage?.(message);
    });
    this.child.once("close", () => this.onclose?.());
  }

  async send(message) {
    this.child.stdin.write(serializeMessage(message));
  }

  async close() {
    this.child.stdin.end();
  }
}

async function until(predicate, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
