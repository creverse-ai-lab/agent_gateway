// MCP Tasks through the Control front door (src/index.js), driven as a host
// drives it: the SDK Client over stdio, against a real daemon running the mock
// Worker. A task-augmented agent_acp_run creates a Task, and the front door
// follows it, sending notifications/tasks/status for each status change and
// the terminal one exactly once: for a session that closed, after a frame the
// stream lost (the heartbeat), and across a daemon restart.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
  ErrorCode,
  McpError,
  TaskStatusNotificationSchema
} from "@modelcontextprotocol/sdk/types.js";
import { GatewayService } from "../src/gateway-service.js";
import { startDaemon, writeMockProviders } from "./helpers/daemon-harness.js";

const FRONT_DOOR = fileURLToPath(new URL("../src/index.js", import.meta.url));
const MOCK_AGENT = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const DROP_EVENTS = fileURLToPath(new URL("./helpers/drop-events.js", import.meta.url));
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MAIN = { rootId: "main-a" };
const CALLER_A = { provider: "claude", sessionId: "main-a-session", pid: null, instanceId: "mcp-a" };
const CALLER_B = { provider: "claude", sessionId: "main-b-session", pid: null, instanceId: "mcp-b" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("gateway: a task subscription replays where the task stands and hears each status, also one committed after its session closed", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = service.store.create({
      provider: "mock", acpSessionId: "closing", cwd: "/", ownerRootId: "main-a", permissionPolicy: "ask", turnId: "turn-1"
    });
    session.status = "running";
    const created = service.taskStore.create({ sessionId: session.id, ownerRootId: "main-a" });
    session.activeTaskId = created.taskId;
    const followed = [];
    const subscribed = service.subscribe({ sessionIds: [], taskIds: [created.taskId] }, MAIN, (event) => followed.push(event));
    const watched = [];
    service.subscribe({ sessionIds: [session.id] }, MAIN, (event) => watched.push(event));
    assert.deepEqual(subscribed.taskIds, [created.taskId]);
    assert.deepEqual(subscribed.sessions, []);
    assert.deepEqual(subscribed.replay, {});
    assert.deepEqual(subscribed.cursorTruncated, {});
    assert.deepEqual(subscribed.events, [
      { type: "task_status", ...(await service.call("task_get", { taskId: created.taskId }, MAIN)) }
    ]);

    service.updateTaskForSession(session, "input_required", "Waiting for Main permission");
    assert.deepEqual(followed.map((event) => [event.status, event.statusMessage]), [["input_required", "Waiting for Main permission"]]);
    assert.equal(followed[0].createdAt, created.createdAt, "the task whole, as task_get reads it");
    assert.equal(followed[0].sequence, undefined, "no ring's event, so it moves no cursor");

    // The turn's finalizer already holds the turn, so the close leaves the
    // task to it, and its commit lands with the session closed and gone.
    session.turnSeal = session.turnId;
    await service.call("session", { action: "close", sessionId: session.id }, MAIN);
    assert.equal(service.store.get(session.id), undefined);
    service.updateTaskForSession(session, "completed", "end_turn", { ok: true, status: "idle" });
    assert.deepEqual(followed.map((event) => event.status), ["input_required", "completed"]);
    assert.equal(followed[1].taskId, created.taskId);
    // The session's own stream is over: it carried the session_closed, and
    // nothing after it.
    assert.deepEqual(watched.map((event) => event.status ?? event.type), ["input_required", "session_closed"]);
  } finally {
    await service.shutdown();
  }
});

test("gateway: taskIds is checked as task_get checks a task, before the subscription registers", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = service.store.create({
      provider: "mock", acpSessionId: "owned", cwd: "/", ownerRootId: "main-a", permissionPolicy: "ask", openedBy: CALLER_A
    });
    const own = service.taskStore.create({ sessionId: session.id, ownerRootId: "main-a", caller: CALLER_A });
    const asA = { rootId: "main-a", access: "control", caller: CALLER_A };
    assert.equal((await service.call("setup", {}, MAIN)).capabilities.taskSubscriptions, true, "declared, never probed");
    for (const taskIds of [[], "task", [1], [""], Array.from({ length: 101 }, (_, index) => `task-${index}`)]) {
      assert.throws(() => service.subscribe({ taskIds }, asA, () => {}), { code: "INVALID_ARGUMENT" });
    }
    assert.throws(
      () => service.subscribe({ sessionIds: [session.id], taskIds: [own.taskId] }, asA, () => {}),
      { code: "INVALID_ARGUMENT" }
    );
    assert.throws(() => service.subscribe({ taskIds: ["task-missing"] }, asA, () => {}), { code: "UNKNOWN_TASK" });
    assert.throws(() => service.subscribe({ taskIds: [own.taskId] }, { ...asA, caller: CALLER_B }, () => {}), { code: "NOT_TASK_OWNER" });
    assert.throws(() => service.subscribe({ taskIds: [own.taskId] }, { rootId: "main-b" }, () => {}), { code: "NOT_TASK_OWNER" });
    assert.equal(service.subscriptions.size, 0);

    // Without sessionIds it is still a subscription to the task alone, never
    // one to every session.
    const events = [];
    const subscribed = service.subscribe({ taskIds: [own.taskId, own.taskId] }, asA, (event) => events.push(event));
    assert.deepEqual(subscribed.taskIds, [own.taskId]);
    assert.deepEqual(subscribed.sessions, []);
    service.store.push(session, { type: "turn_start" });
    assert.deepEqual(events, []);
  } finally {
    await service.shutdown();
  }
});

test("front door: a task-augmented agent_acp_run returns a CreateTaskResult and notifies each status, the terminal one once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-tn-"));
  const hosts = [];
  let daemon = null;
  try {
    // Two providers on the mock Worker, which names every session it opens the
    // same: one session each.
    const providers = { ACP_GATEWAY_PROVIDERS: join(directory, "providers.json") };
    const worker = { command: process.execPath, args: [MOCK_AGENT], permissionPolicy: "ask" };
    await writeFile(
      providers.ACP_GATEWAY_PROVIDERS,
      JSON.stringify({ version: 1, providers: { mock: worker, "mock-legacy": worker } })
    );
    daemon = await startDaemon({ directory, env: providers });
    const host = await connectFrontDoor(hosts, daemon, directory, providers);
    const { client, statuses } = host;
    assert.deepEqual(client.getServerCapabilities()?.tasks?.requests, { tools: { call: {} } });
    const sessionId = await openSession(client, directory);

    const created = await runAsTask(client, { sessionId, prompt: "go" });
    const { taskId } = created.task;
    assert.match(taskId, /^task-/);
    assert.equal(created.task.status, "working");
    assert.equal(created.task.ttl, 600_000);

    // The worker asks for a permission: the task needs its client now.
    await waitFor(() => statusesOf(statuses, taskId).includes("input_required"), "input_required");
    await allowPending(client, sessionId);
    const terminal = await waitFor(() => terminalOf(statuses, taskId), "a terminal status");
    assert.equal(terminal.status, "completed");
    // The full Task, as tasks/get reads it, and no related-task _meta.
    assert.deepEqual(terminal, await client.experimental.tasks.getTask(taskId));
    assert.equal(Object.hasOwn(terminal, "_meta"), false);
    assert.deepEqual(host.parsed.at(-1), terminal, "the notification parses as notifications/tasks/status");
    const payload = await client.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
    assert.equal(payload.isError, false);
    assert.equal(payload.structuredContent?.result?.text, "DONE");
    await pause(400);
    assert.deepEqual(statusesOf(statuses, taskId), ["input_required", "working", "completed"]);

    // A tool that declares no taskSupport refuses a task-augmented call as a
    // request, -32601, and still answers the same call made without one.
    await assert.rejects(
      client.request(
        { method: "tools/call", params: { name: "agent_acp_session", arguments: { action: "list" } } },
        CreateTaskResultSchema,
        { task: { ttl: 60_000 } }
      ),
      (error) => error instanceof McpError && error.code === ErrorCode.MethodNotFound
        && /agent_acp_session does not support task-augmented calls/.test(error.message)
    );
    const listed = await client.callTool({ name: "agent_acp_session", arguments: { action: "list" } });
    assert.equal(listed.isError, false);
    assert.ok(listed.structuredContent.sessions.some((session) => session.sessionId === sessionId));

    // A creation the Gateway refuses fails as a request with its own message,
    // not as an SDK complaint about an invalid CreateTaskResult.
    await assert.rejects(
      runAsTask(client, { sessionId: "acp-missing", prompt: "go" }),
      (error) => error instanceof McpError && /acp-missing/.test(error.message)
        && !/CreateTaskResult|task creation result/.test(error.message)
    );

    // A plain agent_acp_run is unchanged: it waits and answers, and its handle
    // is never followed.
    const plain = await client.callTool({
      name: "agent_acp_run",
      arguments: { sessionId, prompt: "usage-breakdown", waitMs: 20_000 }
    });
    assert.equal(plain.isError, false);
    assert.equal(plain.structuredContent.status, "idle");
    assert.equal(plain.structuredContent.result.text, "DONE");
    assert.equal(plain.task, undefined);

    // A closed session's task still reports its terminal status.
    const doomed = (await runAsTask(client, { sessionId, prompt: "go" })).task.taskId;
    await waitFor(() => statusesOf(statuses, doomed).includes("input_required"), "input_required before the close");
    const closed = await client.callTool({ name: "agent_acp_session", arguments: { action: "close", sessionId } });
    assert.equal(closed.isError, false);
    const ended = await waitFor(() => terminalOf(statuses, doomed), "the closed session's terminal status");
    assert.equal(ended.status, "cancelled");
    assert.deepEqual(ended, await client.experimental.tasks.getTask(doomed));
    await pause(400);
    assert.deepEqual(statusesOf(statuses, doomed), ["input_required", "cancelled"]);
    assert.equal(statuses.filter((params) => params.taskId === plain.structuredContent.taskId).length, 0);

    // A client that never creates a task hears about none, its own plain runs
    // included.
    const legacy = await connectFrontDoor(hosts, daemon, directory, providers);
    const own = await openSession(legacy.client, directory, "mock-legacy");
    const run = await legacy.client.callTool({
      name: "agent_acp_run",
      arguments: { sessionId: own, prompt: "usage-breakdown", waitMs: 20_000 }
    });
    assert.equal(run.structuredContent.result.text, "DONE");
    await pause(400);
    assert.deepEqual(legacy.statuses, []);
  } finally {
    await closeHosts(hosts);
    await daemon?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("front door: the heartbeat delivers a status change the stream lost", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-tn-"));
  const hosts = [];
  let daemon = null;
  try {
    const providers = await writeMockProviders(directory, { permissionPolicy: "ask" });
    const dropped = join(directory, "dropped.ndjson");
    daemon = await startDaemon({
      directory,
      execArgv: ["--import", DROP_EVENTS],
      env: {
        ...providers,
        // origin is on a task subscription's event (the task as task_get reads
        // it), never on a session's own task_status event.
        ACP_GATEWAY_DROP_EVENTS: JSON.stringify({ type: "task_status", status: "completed", origin: "run" }),
        ACP_GATEWAY_DROP_EVENTS_LOG: dropped
      }
    });
    const { client, statuses } = await connectFrontDoor(hosts, daemon, directory, providers, {
      ACP_GATEWAY_TASK_HEARTBEAT_MS: "200"
    });
    const sessionId = await openSession(client, directory);
    const { taskId } = (await runAsTask(client, { sessionId, prompt: "go" })).task;
    await waitFor(() => statusesOf(statuses, taskId).includes("input_required"), "input_required");
    await allowPending(client, sessionId);

    const terminal = await waitFor(() => terminalOf(statuses, taskId), "the completion the stream lost");
    assert.equal(terminal.status, "completed");
    const lost = (await readFile(dropped, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lost.map((event) => [event.taskId, event.status]), [[taskId, "completed"]],
      "the daemon pushed the completion, and it never arrived");
    // Several beats later: sent once, and nothing more for a finished task.
    await pause(800);
    assert.deepEqual(statusesOf(statuses, taskId).filter((status) => TERMINAL.has(status)), ["completed"]);
  } finally {
    await closeHosts(hosts);
    await daemon?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("front door: a daemon restart mid-task still delivers the task's terminal status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-tn-"));
  const hosts = [];
  let daemon = null;
  try {
    const providers = await writeMockProviders(directory, { permissionPolicy: "ask" });
    daemon = await startDaemon({ directory, env: providers });
    // The default heartbeat (30s) cannot fire within this test: what arrives
    // comes from the task subscription the front door's reconnect restores.
    const { client, statuses } = await connectFrontDoor(hosts, daemon, directory, providers);
    const sessionId = await openSession(client, directory);
    const { taskId } = (await runAsTask(client, { sessionId, prompt: "go" })).task;
    await waitFor(() => statusesOf(statuses, taskId).includes("input_required"), "input_required");

    // Nothing is called through the front door while the daemon is down, so
    // nothing starts one but this test.
    await daemon.stop();
    daemon = await startDaemon({ directory, env: providers });

    const terminal = await waitFor(() => terminalOf(statuses, taskId), "the terminal status after the restart");
    assert.equal(terminal.status, "failed");
    assert.match(terminal.statusMessage, /restarted/);
    assert.deepEqual(terminal, await client.experimental.tasks.getTask(taskId));
    const payload = await client.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
    assert.equal(payload.isError, true);
    assert.equal(payload.structuredContent?.interruption?.reason, "gateway_restarted");
    await pause(400);
    assert.deepEqual(statusesOf(statuses, taskId), ["input_required", "failed"]);
  } finally {
    await closeHosts(hosts);
    await daemon?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

// A host session on its own front door. Every notifications/tasks/status is
// recorded twice: as it arrived on the wire (statuses, _meta and all) and as the
// SDK's schema reads it (parsed).
async function connectFrontDoor(hosts, daemon, directory, providers, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [FRONT_DOOR],
    stderr: "pipe",
    env: {
      ...process.env,
      ACP_GATEWAY_SOCKET: daemon.socketPath,
      ACP_GATEWAY_CONTROL_TOKEN: daemon.token,
      ACP_GATEWAY_ROOT_ID: daemon.rootId,
      // The daemon's own isolation, so a daemon this front door started (it
      // starts one whenever a call finds none) could never touch the
      // developer's state.
      ACP_GATEWAY_STATE: daemon.statePath,
      ACP_GATEWAY_REGISTRY_CACHE: join(directory, "registry.json"),
      ACP_GATEWAY_INSTALL_STATE: join(directory, "install.json"),
      ACP_GATEWAY_AGENT_AUTO_UPDATE: "0",
      ACP_GATEWAY_AGENT_UPDATE_NOTIFICATIONS: "0",
      ...providers,
      ...env
    }
  });
  const statuses = [];
  // Set before connect: the SDK calls a transport's own onmessage first.
  transport.onmessage = (message) => {
    if (message.method === "notifications/tasks/status") statuses.push(message.params);
  };
  const client = new Client({ name: "task-notifications", version: "1.0.0" });
  const parsed = [];
  client.setNotificationHandler(TaskStatusNotificationSchema, (notification) => {
    parsed.push(notification.params);
  });
  const host = { client, statuses, parsed };
  hosts.push(host);
  await client.connect(transport);
  return host;
}

// Before the daemon stops: a front door left running would start a new one
// at its next call.
function closeHosts(hosts) {
  return Promise.all(hosts.map((host) => host.client.close().catch(() => {})));
}

async function openSession(client, cwd, provider = "mock") {
  const opened = await client.callTool({
    name: "agent_acp_session_open",
    arguments: { provider, cwd, permissionPolicy: "ask" }
  });
  assert.equal(opened.isError, false, JSON.stringify(opened.structuredContent));
  return opened.structuredContent.sessionId;
}

function runAsTask(client, args) {
  return client.request(
    { method: "tools/call", params: { name: "agent_acp_run", arguments: args } },
    CreateTaskResultSchema,
    { task: { ttl: 600_000 } }
  );
}

async function allowPending(client, sessionId) {
  const inbox = await client.callTool({
    name: "agent_acp_inbox",
    arguments: { action: "list", status: "pending", sessionId }
  });
  const [request] = inbox.structuredContent.items;
  assert.ok(request, "a permission request is pending");
  const answered = await client.callTool({
    name: "agent_acp_permission",
    arguments: { sessionId, requestId: request.requestId, optionId: "allow-once" }
  });
  assert.equal(answered.isError, false, JSON.stringify(answered.structuredContent));
}

function statusesOf(statuses, taskId) {
  return statuses.filter((params) => params.taskId === taskId).map((params) => params.status);
}

function terminalOf(statuses, taskId) {
  return statuses.find((params) => params.taskId === taskId && TERMINAL.has(params.status)) ?? null;
}

async function waitFor(read, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await pause(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
