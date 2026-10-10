// TaskFollower (src/task-follower.js) on its own, against a scripted Gateway
// client: what reaches the MCP client as notifications/tasks/status, from the
// subscription and from the heartbeat, and when following stops.
import assert from "node:assert/strict";
import test from "node:test";
import { TASK_HEARTBEAT_MS, TaskFollower, taskHeartbeatMs } from "../src/task-follower.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CREATED = "2026-10-10T00:00:00.000Z";

function task(taskId, status, statusMessage = status, at = CREATED) {
  return { taskId, sessionId: "acp-1", status, statusMessage, ttl: 60_000, pollInterval: 1_000, createdAt: CREATED, lastUpdatedAt: at, origin: "run" };
}

const event = (record) => ({ type: "task_status", ...record });

// What the follower is handed by connect(): records every request and answers
// from the test's script. push() is the daemon publishing to a subscription.
class ScriptedGateway {
  constructor({ subscribe = (args) => ({ taskIds: args.taskIds, events: [] }), taskGet = null } = {}) {
    this.answerSubscribe = subscribe;
    this.taskGet = taskGet;
    this.requests = [];
    this.handlers = new Map();
    this.closed = false;
    this.next = 1;
  }

  async subscribe(args, onEvent) {
    this.requests.push(["subscribe", args]);
    const answer = await this.answerSubscribe(args);
    const subscriptionId = `sub-${this.next++}`;
    this.handlers.set(subscriptionId, onEvent);
    return { subscriptionId, sessions: [], replay: {}, cursorTruncated: {}, ...answer };
  }

  async unsubscribe(subscriptionId) {
    this.requests.push(["unsubscribe", subscriptionId]);
    this.handlers.delete(subscriptionId);
    return { ok: true, removed: true };
  }

  async call(method, args) {
    this.requests.push([method, args]);
    if (method !== "task_get" || !this.taskGet) throw new Error(`unexpected ${method}`);
    return this.taskGet(args.taskId);
  }

  push(payload) {
    for (const onEvent of this.handlers.values()) onEvent(payload);
  }

  count(method) {
    return this.requests.filter(([name]) => name === method).length;
  }

  close() {
    this.closed = true;
  }
}

function follower(gateway, heartbeatMs = TASK_HEARTBEAT_MS) {
  const sent = [];
  let connects = 0;
  const instance = new TaskFollower({
    connect: () => {
      connects += 1;
      return gateway;
    },
    notify: (record) => {
      sent.push(record);
    },
    heartbeatMs
  });
  return { follower: instance, sent, connects: () => connects };
}

async function until(predicate, what) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await pause(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test("task follower: each pushed change is sent once, and the terminal one ends the following", async () => {
  const gateway = new ScriptedGateway({
    subscribe: (args) => ({ taskIds: args.taskIds, events: [event(task("task-a", "working", "Prompt running"))] })
  });
  const { follower: following, sent } = follower(gateway);
  following.follow(task("task-a", "working", "Prompt running"));
  await until(() => gateway.handlers.size === 1, "the subscription");
  assert.deepEqual(gateway.requests[0], ["subscribe", { sessionIds: [], taskIds: ["task-a"] }]);
  assert.deepEqual(sent, [], "where the task stood at creation is the client's already");

  gateway.push(event(task("task-a", "input_required", "Waiting for Main permission")));
  gateway.push(event(task("task-a", "input_required", "Waiting for Main permission")));
  gateway.push({ type: "task_status", taskId: "task-other", status: "completed" });
  gateway.push({ type: "subscription_replay_truncated", sessionIds: [] });
  gateway.push(event(task("task-a", "working", "Main response sent")));
  gateway.push(event(task("task-a", "completed", "end_turn")));
  gateway.push(event(task("task-a", "completed", "end_turn")));
  assert.deepEqual(sent.map((record) => record.status), ["input_required", "working", "completed"]);
  assert.equal(sent.at(-1).createdAt, CREATED, "the task is sent whole");
  await until(() => gateway.count("unsubscribe") === 1, "the unsubscribe");
  assert.equal(gateway.closed, true, "nothing left to follow, so no connection either");
  assert.equal(gateway.count("task_get"), 0);
});

test("task follower: the heartbeat sends what the stream did not deliver, then stops", async () => {
  let reads = 0;
  const gateway = new ScriptedGateway({
    taskGet: (taskId) => (++reads < 2 ? task(taskId, "working", "Prompt running") : task(taskId, "completed", "end_turn"))
  });
  const { follower: following, sent } = follower(gateway, 20);
  following.follow(task("task-a", "working", "Prompt running"));
  await until(() => sent.length === 1, "the completion");
  assert.equal(sent[0].status, "completed");
  const beats = gateway.count("task_get");
  await pause(100);
  assert.equal(gateway.count("task_get"), beats, "no heartbeat once nothing is followed");
  assert.equal(sent.length, 1);
  assert.equal(gateway.closed, true);
});

test("task follower: a heartbeat read that a push overtook is not sent", async () => {
  let release = null;
  const gateway = new ScriptedGateway({
    taskGet: (taskId) => new Promise((resolve) => {
      release = () => resolve(task(taskId, "working", "Prompt running"));
    })
  });
  const { follower: following, sent } = follower(gateway, 20);
  following.follow(task("task-a", "working", "Prompt running"));
  await until(() => release != null, "a heartbeat read in flight");
  gateway.push(event(task("task-a", "input_required", "Waiting for Main permission")));
  release();
  await pause(10);
  // The read left before the push and came back after it: it is older.
  assert.deepEqual(sent.map((record) => record.status), ["input_required"]);
  following.close();
});

test("task follower: a subscription refused, or one an older daemon cannot stream, leaves the heartbeat", async () => {
  const cases = [
    {
      subscribe: () => {
        throw Object.assign(new Error("At most 64 subscriptions per root"), { code: "SUBSCRIPTION_LIMIT_EXCEEDED" });
      },
      unsubscribes: 0
    },
    // An older Gateway ignores taskIds, so its reply names none: the
    // subscription it made (to no session at all) is let go at once.
    { subscribe: () => ({ events: [] }), unsubscribes: 1 }
  ];
  for (const { subscribe, unsubscribes } of cases) {
    const gateway = new ScriptedGateway({
      subscribe,
      taskGet: (taskId) => task(taskId, "failed", "Gateway restarted before this task completed")
    });
    const { follower: following, sent } = follower(gateway, 20);
    following.follow(task("task-a", "working", "Prompt running"));
    await until(() => sent.length === 1, "the heartbeat's report");
    assert.equal(sent[0].status, "failed");
    assert.equal(gateway.count("unsubscribe"), unsubscribes);
    assert.equal(gateway.closed, true);
  }
});

test("task follower: a task that is gone stops being followed, with nothing sent", async () => {
  const gone = Object.assign(new Error("Unknown taskId: task-a"), { code: "UNKNOWN_TASK" });
  const viaHeartbeat = new ScriptedGateway({
    taskGet: () => {
      throw gone;
    }
  });
  const first = follower(viaHeartbeat, 20);
  first.follower.follow(task("task-a", "working"));
  await until(() => viaHeartbeat.closed, "the follower to let the task go");
  const reads = viaHeartbeat.count("task_get");
  await pause(80);
  assert.equal(viaHeartbeat.count("task_get"), reads);
  assert.deepEqual(first.sent, []);

  // A resubscribe the daemon refused after a reconnect, because the task is gone.
  const viaStream = new ScriptedGateway();
  const second = follower(viaStream);
  second.follower.follow(task("task-b", "working"));
  await until(() => viaStream.handlers.size === 1, "the subscription");
  viaStream.push({ type: "subscription_error", error: "Unknown taskId: task-b", errorCode: "UNKNOWN_TASK" });
  assert.equal(viaStream.closed, true);
  assert.deepEqual(second.sent, []);

  // Any other end of the subscription leaves the heartbeat following it.
  const dropped = new ScriptedGateway({ taskGet: (taskId) => task(taskId, "cancelled", "Task cancelled by Main") });
  const third = follower(dropped, 20);
  third.follower.follow(task("task-c", "working"));
  await until(() => dropped.handlers.size === 1, "the subscription");
  dropped.push({ type: "subscription_error", error: "Gateway subscriber is too slow" });
  await until(() => third.sent.length === 1, "the heartbeat's report");
  assert.equal(third.sent[0].status, "cancelled");
});

test("task follower: nothing runs before a task is followed or after close", async () => {
  const gateway = new ScriptedGateway({ taskGet: (taskId) => task(taskId, "completed") });
  const { follower: following, sent, connects } = follower(gateway, 20);
  await pause(60);
  assert.equal(connects(), 0, "no connection and no heartbeat while nothing is followed");
  // A task created already finished has nothing left to report.
  following.follow(task("task-done", "completed"));
  assert.equal(connects(), 0);

  following.follow(task("task-a", "working"));
  following.close();
  assert.equal(gateway.closed, true);
  following.follow(task("task-b", "working"));
  gateway.push(event(task("task-a", "completed")));
  await pause(60);
  assert.deepEqual(sent, []);
  assert.equal(gateway.count("task_get"), 0);
});

test("task follower: ACP_GATEWAY_TASK_HEARTBEAT_MS is bounded", () => {
  assert.equal(taskHeartbeatMs({}), TASK_HEARTBEAT_MS);
  assert.equal(TASK_HEARTBEAT_MS, 30_000);
  assert.equal(taskHeartbeatMs({ ACP_GATEWAY_TASK_HEARTBEAT_MS: "250" }), 250);
  assert.equal(taskHeartbeatMs({ ACP_GATEWAY_TASK_HEARTBEAT_MS: "99" }), TASK_HEARTBEAT_MS);
  assert.equal(taskHeartbeatMs({ ACP_GATEWAY_TASK_HEARTBEAT_MS: "abc" }), TASK_HEARTBEAT_MS);
  assert.equal(taskHeartbeatMs({ ACP_GATEWAY_TASK_HEARTBEAT_MS: "900000" }), 300_000);
});
