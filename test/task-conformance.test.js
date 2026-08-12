// MCP Task conformance for the semantics PR 3 moved into TaskStore, asserted
// through the gateway surface a Main actually calls (and, for the budget
// rejection, through the daemon wire). Restart durability for terminal handles is
// deliberately out of scope here: that is PR 4.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
  RELATED_TASK_META_KEY
} from "@modelcontextprotocol/sdk/types.js";
import { AcpClient } from "../src/acp-client.js";
import { GatewayService } from "../src/gateway-service.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { STATE_SCHEMA_VERSION } from "../src/version.js";
import { daemonPaths, HARNESS_ROOT_ID, startDaemon } from "./helpers/daemon-harness.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MAIN = { rootId: "main-a" };
const OTHER = { rootId: "main-b" };
// Seeded fixtures are dated from process start so their TTL has not elapsed
// against the real clock the un-mocked services in this file use.
const SEED_EPOCH = Date.now();
const TASK_KEYS = [
  "taskId", "sessionId", "turnId", "status", "ttl", "pollInterval", "createdAt", "lastUpdatedAt",
  "statusMessage"
].sort();

test("conformance: TTL is measured from createdAt and status touches cannot extend it", async () => {
  const epoch = Date.parse("2026-03-01T00:00:00.000Z");
  let clock = epoch;
  const service = new GatewayService({
    createClient: mockClientFactory("ask"),
    gcIntervalMs: 0,
    now: () => clock
  });
  try {
    const opened = await openMockSession(service, "ask");
    const task = await service.call(
      "task_prompt",
      { sessionId: opened.sessionId, prompt: "go", ttl: 60_000, pollInterval: 100 },
      MAIN
    );
    assert.equal(task.createdAt, new Date(epoch).toISOString());
    await waitForStatus(service, opened.sessionId, "waiting_permission");
    assert.equal((await service.call("task_get", { taskId: task.taskId }, MAIN)).status, "input_required");

    // Real status traffic, halfway through the TTL: answering the permission
    // drives input_required -> working -> completed, each of which moves
    // lastUpdatedAt. Under the 1.3.2 rule that bought the handle until epoch+90s.
    clock = epoch + 30_000;
    await service.call(
      "permission",
      { sessionId: opened.sessionId, requestId: 100, optionId: "allow-once" },
      MAIN
    );
    await waitForIdle(service, opened.sessionId);
    const touched = await service.call("task_get", { taskId: task.taskId }, MAIN);
    assert.equal(touched.status, "completed");
    assert.equal(touched.createdAt, new Date(epoch).toISOString());
    assert.equal(touched.lastUpdatedAt, new Date(epoch + 30_000).toISOString());

    clock = epoch + 59_999;
    assert.equal((await service.call("task_get", { taskId: task.taskId }, MAIN)).status, "completed");
    assert.equal((await service.call("task_result", { taskId: task.taskId }, MAIN)).result.text, "DONE");

    clock = epoch + 60_000;
    await assert.rejects(service.call("task_get", { taskId: task.taskId }, MAIN), (error) => {
      assert.equal(error.code, "UNKNOWN_TASK");
      assert.equal(error.message, `Unknown taskId: ${task.taskId}`);
      return true;
    });
    assert.deepEqual((await service.call("task_list", {}, MAIN)).tasks, []);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

// The SDK's own reference implementations disagree about a still-active task
// whose TTL elapsed, so this test IS the definition: TTL bounds the handle's
// lifetime, the work keeps running, and nobody is left waiting on a handle that
// will never resolve.
test("conformance: a still-active task past its TTL takes the handle, not the turn", async () => {
  const epoch = Date.parse("2026-03-02T00:00:00.000Z");
  let clock = epoch;
  const service = new GatewayService({
    createClient: mockClientFactory("ask"),
    gcIntervalMs: 0,
    now: () => clock
  });
  try {
    const opened = await openMockSession(service, "ask");
    const task = await service.call(
      "task_prompt",
      { sessionId: opened.sessionId, prompt: "go", ttl: 10_000 },
      MAIN
    );
    await waitForStatus(service, opened.sessionId, "waiting_permission");
    assert.equal((await service.call("task_get", { taskId: task.taskId }, MAIN)).status, "input_required");

    // Parked before the clock moves, so this is a real waiter being cut loose
    // rather than a wait that started on an already-swept record.
    const waiting = service.taskStore.waitForTerminal(task.taskId, { ownerRootId: "main-a", timeoutMs: 30_000 });
    const rejection = assert.rejects(waiting, (error) => {
      assert.equal(error.code, "TASK_TTL_EXPIRED");
      return true;
    });
    clock = epoch + 10_000;
    // The production trigger: the gc tick. Nothing else has to notice.
    await service.runMaintenance();
    await rejection;

    for (const method of ["task_get", "task_result", "task_cancel"]) {
      await assert.rejects(service.call(method, { taskId: task.taskId }, MAIN), (error) => {
        assert.equal(error.code, "UNKNOWN_TASK", `${method} must report the handle as unknown`);
        return true;
      });
    }
    assert.deepEqual((await service.call("task_list", {}, MAIN)).tasks, []);

    // The turn is untouched: it can still be answered and completed, it just no
    // longer has a Task handle describing it.
    assert.equal(service.requireSession(opened.sessionId).status, "waiting_permission");
    await service.call(
      "permission",
      { sessionId: opened.sessionId, requestId: 100, optionId: "allow-once" },
      MAIN
    );
    const idle = await waitForIdle(service, opened.sessionId);
    assert.equal(idle.result.text, "DONE");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("conformance: ttl=0 still acknowledges the turn it started", async () => {
  const service = new GatewayService({ createClient: mockClientFactory("read_only"), gcIntervalMs: 0 });
  try {
    const opened = await openMockSession(service, "read_only");
    // Degenerate but legal: the handle expires on the first read after create, so
    // the ack must still describe the turn that is now running.
    const task = await service.call(
      "task_prompt",
      { sessionId: opened.sessionId, prompt: "narrated-result", ttl: 0 },
      MAIN
    );
    assert.equal(task.ttl, 0);
    assert.equal(task.status, "working");
    assert.match(task.turnId, /^turn-/);
    assert.equal(task.turnId, service.requireSession(opened.sessionId).turnId);
    await assert.rejects(service.call("task_get", { taskId: task.taskId }, MAIN), (error) => {
      assert.equal(error.code, "UNKNOWN_TASK");
      return true;
    });
    // The turn itself is unaffected and still delivers through the session path.
    const idle = await waitForIdle(service, opened.sessionId);
    assert.equal(idle.result.text, "FINAL ANSWER");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("conformance: waiter budgets are enforced on the gateway's own store", async () => {
  const service = new GatewayService({ createClient: mockClientFactory("ask"), gcIntervalMs: 0 });
  try {
    const opened = await openMockSession(service, "ask");
    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "go" }, MAIN);
    await waitForStatus(service, opened.sessionId, "waiting_permission");

    const waits = [];
    for (let index = 0; index < 16; index += 1) {
      waits.push(service.taskStore.waitForTerminal(task.taskId, { ownerRootId: "main-a", timeoutMs: 30_000 }));
    }
    await assert.rejects(
      service.taskStore.waitForTerminal(task.taskId, { ownerRootId: "main-a", timeoutMs: 30_000 }),
      (error) => {
        assert.equal(error.code, "TASK_WAITER_LIMIT");
        return true;
      }
    );
    // Ownership is checked before the budget, so another Main cannot even probe it.
    await assert.rejects(
      service.taskStore.waitForTerminal(task.taskId, { ownerRootId: "main-b", timeoutMs: 30_000 }),
      (error) => {
        assert.equal(error.code, "NOT_TASK_OWNER");
        return true;
      }
    );

    await service.call(
      "permission",
      { sessionId: opened.sessionId, requestId: 100, optionId: "allow-once" },
      MAIN
    );
    const settled = await Promise.all(waits);
    assert.equal(settled.length, 16);
    assert.equal(settled.every((record) => record.status === "completed"), true);
    // Every waiter saw the same commit the polling reader sees.
    const result = await service.call("task_result", { taskId: task.taskId }, MAIN);
    assert.equal(result.ok, true);
    assert.equal(result.result.text, "DONE");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("conformance: a deferred terminal commit is not observable through a waiter until it is flushed", async () => {
  const service = new GatewayService({ createClient: mockClientFactory("ask"), gcIntervalMs: 0 });
  try {
    const opened = await openMockSession(service, "ask");
    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "go" }, MAIN);
    await waitForStatus(service, opened.sessionId, "waiting_permission");

    const settled = [];
    const waiting = service.taskStore
      .waitForTerminal(task.taskId, { ownerRootId: "main-a", timeoutMs: 30_000 })
      .then((record) => {
        settled.push(record.status);
        return record;
      });

    // This is the PR 4 result-commit order: transition(deferWaiters) -> durability
    // barrier -> flushWaiters. Between the two, a blocking reader must not have
    // consumed a result a crash could still take back.
    const envelope = { ok: true, sessionId: opened.sessionId, status: "completed", result: { text: "deferred" } };
    service.taskStore.transition(task.taskId, "completed", "end_turn", { result: envelope, deferWaiters: true });
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(settled, [], "the waiter must still be parked");

    // Non-blocking reads are deliberately not gated; they are retryable polls.
    assert.equal((await service.call("task_get", { taskId: task.taskId }, MAIN)).status, "completed");
    assert.equal((await service.call("task_result", { taskId: task.taskId }, MAIN)).result.text, "deferred");

    assert.equal(service.taskStore.flushWaiters(task.taskId), 1);
    assert.equal((await waiting).status, "completed");
    assert.deepEqual(settled, ["completed"]);

    // The real turn end arrives later and loses to the recorded commit.
    await service.call(
      "permission",
      { sessionId: opened.sessionId, requestId: 100, optionId: "allow-once" },
      MAIN
    );
    await waitForIdle(service, opened.sessionId);
    assert.equal((await service.call("task_result", { taskId: task.taskId }, MAIN)).result.text, "deferred");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("conformance: task_list is unpaged without arguments and keyset paged with them", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const ids = seedTasks(service, [
      { taskId: "task-c1", createdAt: 1_000 },
      { taskId: "task-c2", createdAt: 2_000 },
      { taskId: "task-c3", createdAt: 3_000 },
      { taskId: "task-c4", createdAt: 4_000 },
      { taskId: "task-c5", createdAt: 5_000 }
    ]);
    seedTasks(service, [{ taskId: "task-other", createdAt: 1_500, ownerRootId: "main-b" }]);

    // AgenLynk's monitor calls this with no arguments: the full array, no paging
    // key, and nothing from another Main.
    const unpaged = await service.call("task_list", {}, MAIN);
    assert.deepEqual(Object.keys(unpaged), ["tasks"]);
    assert.deepEqual(unpaged.tasks.map((task) => task.taskId), ids);
    assert.deepEqual(Object.keys(unpaged.tasks[0]).sort(), TASK_KEYS);
    assert.deepEqual((await service.call("task_list", {}, OTHER)).tasks.map((task) => task.taskId), ["task-other"]);

    const first = await service.call("task_list", { limit: 2 }, MAIN);
    assert.deepEqual(Object.keys(first).sort(), ["nextCursor", "tasks"]);
    assert.deepEqual(first.tasks.map((task) => task.taskId), ["task-c1", "task-c2"]);
    assert.equal(typeof first.nextCursor, "string");

    // Keyset stability: a record inside the remaining window disappears and two
    // newer ones are inserted while the caller is between pages.
    service.taskStore.remove("task-c4");
    seedTasks(service, [
      { taskId: "task-c6", createdAt: 6_000 },
      { taskId: "task-c7", createdAt: 7_000 }
    ]);
    const seen = first.tasks.map((task) => task.taskId);
    let cursor = first.nextCursor;
    for (let guard = 0; cursor && guard < 10; guard += 1) {
      const page = await service.call("task_list", { limit: 2, cursor }, MAIN);
      seen.push(...page.tasks.map((task) => task.taskId));
      cursor = page.nextCursor;
    }
    assert.equal(cursor, null, "the last page reports nextCursor null, not a missing key");
    assert.equal(new Set(seen).size, seen.length, "no duplicates across pages");
    assert.deepEqual(seen, ["task-c1", "task-c2", "task-c3", "task-c5", "task-c6", "task-c7"]);

    const filtered = await service.call("task_list", { status: "working" }, MAIN);
    assert.deepEqual(filtered.tasks, []);
    assert.equal(filtered.nextCursor, null);
    await assert.rejects(service.call("task_list", { cursor: "not-a-cursor" }, MAIN), (error) => {
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    });
    await assert.rejects(service.call("task_list", { status: "bogus" }, MAIN), (error) => {
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    });
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("conformance: a per-root task budget rejection leaves the session promptable", async () => {
  const service = new GatewayService({ createClient: mockClientFactory("read_only"), gcIntervalMs: 0 });
  try {
    const opened = await openMockSession(service, "read_only");
    // recover() bypasses budgets on purpose (a durable handle is never dropped),
    // which is also the cheapest way to fill the per-root budget exactly.
    seedTasks(service, Array.from({ length: 200 }, (_, index) => ({
      taskId: `task-full-${index}`,
      createdAt: 1_000 + index
    })));

    await assert.rejects(
      service.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, MAIN),
      (error) => {
        assert.equal(error.code, "TASK_LIMIT_EXCEEDED");
        assert.match(error.message, /^Root main-a holds 200 tasks \(max 200\)$/);
        return true;
      }
    );
    // The refusal happens after admission reserved the session, so the release
    // path matters: one rejected task must not wedge the session forever.
    const session = service.requireSession(opened.sessionId);
    assert.equal(session._reserved, null);
    assert.equal(session.activeTaskId ?? null, null, "a refused handle must not be left claimed");
    assert.equal((await service.call("prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, MAIN)).status, "running");
    await waitForIdle(service, opened.sessionId);

    // Freeing one slot makes the handle available again.
    service.taskStore.remove("task-full-0");
    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, MAIN);
    assert.equal(task.status, "working");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("conformance: a budget rejection reaches Main as a structured error over the daemon socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-task-budget-"));
  const { statePath } = daemonPaths(directory);
  let daemon = null;
  let client = null;
  try {
    const timestamp = new Date().toISOString();
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: STATE_SCHEMA_VERSION,
        sessions: [seedSession(timestamp)],
        // Terminal handles are recovered as-is, so the daemon starts with the
        // per-root budget already full and never has to touch a provider.
        tasks: Array.from({ length: 200 }, (_, index) => ({
          taskId: `task-seeded-${index}`,
          sessionId: "acp-budget-session",
          ownerRootId: HARNESS_ROOT_ID,
          turnId: "turn-seeded",
          status: "completed",
          ttl: 3_600_000,
          pollInterval: 1_000,
          createdAt: timestamp,
          lastUpdatedAt: timestamp,
          statusMessage: "end_turn",
          result: { ok: true }
        })),
        inbox: []
      })}\n`,
      { mode: 0o600 }
    );

    daemon = await startDaemon({ directory });
    client = new GatewayRpcClient({
      socketPath: daemon.socketPath,
      token: daemon.token,
      rootId: daemon.rootId,
      autoStart: false
    });
    assert.equal((await client.call("task_list")).tasks.length, 200);

    await assert.rejects(
      client.call("task_prompt", { sessionId: "acp-budget-session", prompt: "go" }),
      (error) => {
        assert.equal(error.code, "TASK_LIMIT_EXCEEDED", "the wire envelope must carry the stable code");
        assert.match(error.message, /holds 200 tasks \(max 200\)/);
        return true;
      }
    );

    // Paging still works over the socket, and the unpaged call is unchanged.
    const page = await client.call("task_list", { limit: 3 });
    assert.equal(page.tasks.length, 3);
    assert.equal(typeof page.nextCursor, "string");
    assert.deepEqual(Object.keys(await client.call("task_list")), ["tasks"]);
  } finally {
    client?.close();
    await daemon?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("conformance: the MCP front door tags task responses with related-task metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-task-frontdoor-"));
  let daemon = null;
  let rpcClient = null;
  let mcpClient = null;
  try {
    // A dynamic provider pointed at the mock ACP agent, so the daemon can run a
    // real task end to end without a real worker installed.
    const providersPath = join(directory, "providers.json");
    await writeFile(
      providersPath,
      JSON.stringify({
        version: 1,
        providers: {
          mock: { command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" }
        }
      })
    );
    daemon = await startDaemon({ directory, env: { ACP_GATEWAY_PROVIDERS: providersPath } });
    rpcClient = new GatewayRpcClient({
      socketPath: daemon.socketPath,
      token: daemon.token,
      rootId: daemon.rootId,
      autoStart: false
    });
    mcpClient = new Client({ name: "task-conformance", version: "1.0.0" });
    await mcpClient.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
      stderr: "pipe",
      env: {
        ...process.env,
        ACP_GATEWAY_SOCKET: daemon.socketPath,
        ACP_GATEWAY_CONTROL_TOKEN: daemon.token,
        ACP_GATEWAY_ROOT_ID: daemon.rootId,
        ACP_GATEWAY_PROVIDERS: providersPath
      }
    }));

    const opened = await mcpClient.callTool({
      name: "agent_acp_session_open",
      arguments: { provider: "mock", cwd: directory, permissionPolicy: "read_only" }
    });
    const sessionId = opened.structuredContent?.sessionId;
    assert.match(String(sessionId), /^acp-/);

    // Task-mode tools/call: the reply is a CreateTaskResult, and the SDK schema
    // is what validates the _meta shape here.
    const created = await mcpClient.request({
      method: "tools/call",
      params: {
        name: "agent_acp_prompt",
        arguments: { sessionId, prompt: "narrated-result" },
        task: { ttl: 600_000 }
      }
    }, CreateTaskResultSchema);
    const taskId = created.task.taskId;
    assert.match(taskId, /^task-/);
    assert.deepEqual(created._meta?.[RELATED_TASK_META_KEY], { taskId });

    const finished = await waitForTaskTerminal(mcpClient, taskId);
    assert.equal(finished.status, "completed");
    assert.deepEqual(finished._meta?.[RELATED_TASK_META_KEY], { taskId });

    const payload = await mcpClient.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
    assert.equal(payload.isError, false);
    assert.equal(payload.structuredContent?.result?.text, "FINAL ANSWER");
    assert.deepEqual(payload._meta?.[RELATED_TASK_META_KEY], { taskId });

    const cancelled = await mcpClient.experimental.tasks.cancelTask(taskId);
    assert.equal(cancelled.status, "completed", "cancelling a terminal handle is a no-op");
    assert.deepEqual(cancelled._meta?.[RELATED_TASK_META_KEY], { taskId });

    // A second handle, so tasks/list has something to page over.
    const second = await mcpClient.request({
      method: "tools/call",
      params: { name: "agent_acp_prompt", arguments: { sessionId, prompt: "narrated-result" }, task: {} }
    }, CreateTaskResultSchema);
    await waitForTaskTerminal(mcpClient, second.task.taskId);

    const listed = await mcpClient.experimental.tasks.listTasks();
    assert.deepEqual(listed.tasks.map((task) => task.taskId), [taskId, second.task.taskId]);
    assert.equal(listed.nextCursor, undefined, "a page that fits omits nextCursor entirely");

    // tasks/list carries no page size, so mint a cursor on the socket and prove
    // the front door forwards it.
    const firstPage = await rpcClient.call("task_list", { limit: 1 });
    assert.deepEqual(firstPage.tasks.map((task) => task.taskId), [taskId]);
    const resumed = await mcpClient.experimental.tasks.listTasks(firstPage.nextCursor);
    assert.deepEqual(resumed.tasks.map((task) => task.taskId), [second.task.taskId]);
    assert.equal(resumed.nextCursor, undefined);
  } finally {
    await mcpClient?.close().catch(() => {});
    rpcClient?.close();
    await daemon?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForTaskTerminal(mcpClient, taskId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const task = await mcpClient.experimental.tasks.getTask(taskId);
    if (["completed", "failed", "cancelled"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`task ${taskId} never reached a terminal status`);
}

function seedSession(timestamp) {
  return {
    id: "acp-budget-session",
    provider: "claude",
    acpSessionId: "budget-acp-session",
    cwd: "/",
    title: "budget fixture",
    permissionPolicy: "ask",
    model: "mock-default",
    ownerRootId: HARNESS_ROOT_ID,
    mcpServers: [],
    additionalDirectories: [],
    pinned: false,
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    orphanedAt: null,
    lastOwnerActivityAt: timestamp,
    transientClearedAt: null,
    eventSequence: 1,
    turnId: null,
    stopReason: null
  };
}

// Terminal records through the public recovery ingress: no provider, no turn, and
// no budget interference, so list/pagination assertions stay exact. `createdAt` is
// a millisecond offset from process start, because recover() drops handles whose
// TTL already elapsed against the real clock.
function seedTasks(service, records) {
  const summary = service.taskStore.recover(records.map((record) => ({
    taskId: record.taskId,
    sessionId: record.sessionId ?? "session-seeded",
    ownerRootId: record.ownerRootId ?? "main-a",
    turnId: "turn-seeded",
    status: record.status ?? "completed",
    ttl: 3_600_000,
    pollInterval: 1_000,
    createdAt: new Date(SEED_EPOCH + record.createdAt).toISOString(),
    lastUpdatedAt: new Date(SEED_EPOCH + record.createdAt).toISOString(),
    statusMessage: "end_turn",
    result: { ok: true }
  })));
  assert.equal(summary.dropped, 0, "seed fixtures must be valid persisted records");
  return records.map((record) => record.taskId);
}

function mockClientFactory(permissionPolicy) {
  return (_provider, options) =>
    new AcpClient(
      { provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy },
      options
    );
}

function openMockSession(service, permissionPolicy) {
  return service.call(
    "session_open",
    { provider: "claude", cwd: process.cwd(), permissionPolicy },
    MAIN
  );
}

async function waitForStatus(service, sessionId, expected) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const poll = await service.call("poll", { sessionId, waitMs: 100 }, MAIN);
    if (poll.status === expected) return poll;
    if (["error", "unavailable"].includes(poll.status)) throw new Error(poll.error ?? poll.status);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Gateway session did not reach ${expected}`);
}

async function waitForIdle(service, sessionId) {
  let cursor = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const poll = await service.call("poll", { sessionId, cursor, waitMs: 100 }, MAIN);
    cursor = poll.nextCursor;
    if (poll.status === "idle") return poll;
    if (["error", "unavailable"].includes(poll.status)) throw new Error(poll.error ?? poll.status);
  }
  throw new Error("Gateway session did not become idle");
}
