import assert from "node:assert/strict";
import test from "node:test";
import { TaskStore, TERMINAL_TASK_STATUSES } from "../src/task-store.js";

// Every store gets an injected manual clock so TTL/lastUpdatedAt assertions are
// exact instead of timing-dependent. Only waiter timeouts use real timers.
function makeStore(options = {}) {
  const clock = { t: 0 };
  const store = new TaskStore({ now: () => clock.t, ...options });
  return { store, clock };
}

function assertCode(code) {
  return (error) => {
    assert.equal(error.code, code, `expected code ${code} but got ${error.code} (${error.message})`);
    return true;
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function persisted(overrides = {}) {
  return {
    taskId: "task-persisted",
    sessionId: "session-1",
    ownerRootId: "rootA",
    turnId: "turn-1",
    status: "working",
    ttl: 3_600_000,
    pollInterval: 1_000,
    createdAt: iso(0),
    lastUpdatedAt: iso(100),
    statusMessage: "Prompt running",
    result: null,
    ...overrides
  };
}

test("exported terminal statuses match the gateway wire contract", () => {
  assert.deepEqual([...TERMINAL_TASK_STATUSES].sort(), ["cancelled", "completed", "failed"]);
});

test("create returns the legacy task record shape", () => {
  const { store } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA", turnId: "turn-1" });
  assert.deepEqual(Object.keys(task), [
    "taskId",
    "sessionId",
    "ownerRootId",
    "turnId",
    "status",
    "ttl",
    "pollInterval",
    "createdAt",
    "lastUpdatedAt",
    "statusMessage",
    "result"
  ]);
  assert.match(task.taskId, /^task-[0-9a-f-]{36}$/);
  assert.equal(task.status, "working");
  assert.equal(task.statusMessage, "Prompt accepted");
  assert.equal(task.ttl, 3_600_000);
  assert.equal(task.pollInterval, 1_000);
  assert.equal(task.createdAt, iso(0));
  assert.equal(task.lastUpdatedAt, iso(0));
  assert.equal(task.result, null);
  assert.equal(store.size, 1);
});

test("create validates its arguments", () => {
  const { store } = makeStore();
  assert.throws(() => store.create({ ownerRootId: "rootA" }), assertCode("INVALID_ARGUMENT"));
  assert.throws(() => store.create({ sessionId: "session-1" }), assertCode("INVALID_ARGUMENT"));
  assert.throws(() => store.create({ sessionId: "session-1", ownerRootId: "  " }), assertCode("INVALID_ARGUMENT"));
  assert.throws(() => store.create({ sessionId: "session-1", ownerRootId: "rootA", turnId: 7 }), assertCode("INVALID_ARGUMENT"));
});

test("ttl expiry is keyed off createdAt, never lastUpdatedAt", () => {
  const { store, clock } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA", ttl: 1_000 });

  clock.t = 900;
  const touched = store.transition(task.taskId, "working", "Prompt running");
  assert.equal(touched.lastUpdatedAt, iso(900));
  assert.equal(touched.createdAt, iso(0), "createdAt is the immutable TTL anchor");

  clock.t = 999;
  assert.equal(store.get(task.taskId).status, "working");

  // A lastUpdatedAt-keyed TTL (the old pruneTasks behaviour) would keep this
  // record alive until t=1900. createdAt+ttl is the MCP contract.
  clock.t = 1_001;
  assert.throws(() => store.get(task.taskId), assertCode("UNKNOWN_TASK"));
});

test("ttl=0 survives its own creation and expires on the first sweep", () => {
  const { store } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA", ttl: 0 });
  assert.equal(task.ttl, 0);
  assert.equal(store.expireSweep(), 1);
  assert.equal(store.size, 0);
  assert.throws(() => store.get(task.taskId), assertCode("UNKNOWN_TASK"));
});

test("ttl is clamped to [0, maxTaskTtlMs] and falls back to the default", () => {
  const { store } = makeStore({ defaultTtlMs: 5_000, maxTaskTtlMs: 10_000 });
  const base = { sessionId: "session-1", ownerRootId: "rootA" };
  assert.equal(store.create({ ...base, ttl: 99_999 }).ttl, 10_000);
  assert.equal(store.create({ ...base, ttl: -5 }).ttl, 0);
  assert.equal(store.create({ ...base, ttl: null }).ttl, 5_000);
  assert.equal(store.create({ ...base }).ttl, 5_000);
  assert.throws(() => store.create({ ...base, ttl: Infinity }), assertCode("INVALID_ARGUMENT"));
  assert.throws(() => store.create({ ...base, ttl: Number.NaN }), assertCode("INVALID_ARGUMENT"));
  assert.throws(() => store.create({ ...base, ttl: "1000" }), assertCode("INVALID_ARGUMENT"));
});

test("pollInterval is clamped to the configured floor", () => {
  const { store } = makeStore();
  const base = { sessionId: "session-1", ownerRootId: "rootA" };
  assert.equal(store.create({ ...base, pollInterval: 10 }).pollInterval, 100);
  assert.equal(store.create({ ...base, pollInterval: 5_000 }).pollInterval, 5_000);
  assert.equal(store.create({ ...base, pollInterval: null }).pollInterval, 1_000);
  assert.throws(() => store.create({ ...base, pollInterval: Infinity }), assertCode("INVALID_ARGUMENT"));
});

test("an active task past its ttl is failed, rejects waiters, then becomes unknown", async () => {
  const events = [];
  const { store, clock } = makeStore({ onChange: (event) => events.push(event) });
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA", ttl: 1_000 });
  const waiting = store.waitForTerminal(task.taskId, { timeoutMs: 30_000 });

  clock.t = 1_000;
  assert.equal(store.expireSweep(), 1);
  await assert.rejects(waiting, assertCode("TASK_TTL_EXPIRED"));
  assert.throws(() => store.get(task.taskId), assertCode("UNKNOWN_TASK"));

  const updated = events.find((event) => event.type === "updated");
  assert.equal(updated.task.status, "failed");
  assert.equal(updated.task.statusMessage, "Task TTL elapsed before completion");
  assert.deepEqual(updated.task.result, { ok: false, error: "Task TTL elapsed before completion" });
  assert.equal(updated.task.lastUpdatedAt, iso(1_000));
  // The failed commit is observable, then the handle is removed in the same sweep.
  assert.equal(events.at(-1).type, "removed");
  assert.equal(events.at(-1).taskId, task.taskId);
});

test("expiry is evaluated lazily on read paths, not only via explicit sweeps", () => {
  const { store, clock } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA", ttl: 100 });
  clock.t = 100;
  assert.equal(store.listPage({ ownerRootId: "rootA" }).tasks.length, 0);
  assert.equal(store.size, 0);
  assert.throws(() => store.result(task.taskId), assertCode("UNKNOWN_TASK"));
});

test("waitForTerminal resolves when the task reaches a terminal state", async () => {
  const { store, clock } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  const waiting = store.waitForTerminal(task.taskId, { ownerRootId: "rootA", timeoutMs: 30_000 });
  clock.t = 50;
  store.transition(task.taskId, "completed", "end_turn", { result: { ok: true, text: "final" } });
  const record = await waiting;
  assert.equal(record.status, "completed");
  assert.equal(record.lastUpdatedAt, iso(50));
  assert.deepEqual(record.result, { ok: true, text: "final" });
});

test("waitForTerminal resolves immediately for an already terminal task", async () => {
  const { store } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  store.transition(task.taskId, "cancelled", "cancelled", { result: { ok: true } });
  const record = await store.waitForTerminal(task.taskId, { timeoutMs: 1 });
  assert.equal(record.status, "cancelled");
});

test("waitForTerminal rejects on unknown task, timeout and abort", async () => {
  const { store } = makeStore();
  await assert.rejects(store.waitForTerminal("task-missing"), assertCode("UNKNOWN_TASK"));

  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  await assert.rejects(store.waitForTerminal(task.taskId, { timeoutMs: 5 }), assertCode("WAIT_TIMEOUT"));

  const controller = new AbortController();
  const aborting = store.waitForTerminal(task.taskId, { timeoutMs: 30_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(aborting, assertCode("WAIT_ABORTED"));

  await assert.rejects(
    store.waitForTerminal(task.taskId, { timeoutMs: 30_000, signal: AbortSignal.abort() }),
    assertCode("WAIT_ABORTED")
  );
  await assert.rejects(store.waitForTerminal(task.taskId, { timeoutMs: 0 }), assertCode("INVALID_ARGUMENT"));
  assert.equal(store.get(task.taskId).status, "working", "failed waits never touch the record");
});

test("waiter budget is enforced per task", async () => {
  const { store } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  const waits = [];
  for (let index = 0; index < 16; index += 1) {
    waits.push(store.waitForTerminal(task.taskId, { timeoutMs: 30_000 }));
  }
  await assert.rejects(store.waitForTerminal(task.taskId, { timeoutMs: 30_000 }), assertCode("TASK_WAITER_LIMIT"));

  store.transition(task.taskId, "completed", "end_turn", { result: { ok: true } });
  const settled = await Promise.all(waits);
  assert.equal(settled.length, 16);
  assert.equal(settled.every((record) => record.status === "completed"), true);
  // The 17th slot is free again once the earlier waiters settle.
  assert.equal((await store.waitForTerminal(task.taskId, { timeoutMs: 30_000 })).status, "completed");
});

test("waiter budget is enforced per root across tasks", async () => {
  const { store } = makeStore();
  const waits = [];
  const tasks = [];
  for (let index = 0; index < 5; index += 1) {
    tasks.push(store.create({ sessionId: `session-${index}`, ownerRootId: "rootA" }).taskId);
  }
  for (let index = 0; index < 4; index += 1) {
    for (let waiter = 0; waiter < 16; waiter += 1) {
      waits.push(store.waitForTerminal(tasks[index], { timeoutMs: 30_000 }));
    }
  }
  // 4 tasks * 16 waiters = the per-root cap of 64; the 65th is refused even
  // though the 5th task has no waiters of its own.
  await assert.rejects(store.waitForTerminal(tasks[4], { timeoutMs: 30_000 }), assertCode("TASK_WAITER_LIMIT"));

  const other = store.create({ sessionId: "session-other", ownerRootId: "rootB" });
  const otherWait = store.waitForTerminal(other.taskId, { timeoutMs: 30_000 });
  store.transition(other.taskId, "completed", "end_turn", { result: { ok: true } });
  assert.equal((await otherWait).status, "completed", "another root keeps its own budget");

  store.clear();
  const settled = await Promise.allSettled(waits);
  assert.equal(settled.length, 64);
  assert.equal(settled.every((entry) => entry.status === "rejected" && entry.reason.code === "TASK_STORE_CLOSED"), true);
});

test("clear rejects every pending waiter with TASK_STORE_CLOSED", async () => {
  const { store } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  const waiting = store.waitForTerminal(task.taskId, { timeoutMs: 30_000 });
  store.clear();
  await assert.rejects(waiting, assertCode("TASK_STORE_CLOSED"));
  assert.equal(store.size, 0);
  assert.throws(() => store.get(task.taskId), assertCode("UNKNOWN_TASK"));
});

test("terminal state is final: a different terminal target is an inert no-op", async () => {
  const events = [];
  const { store, clock } = makeStore({ onChange: (event) => events.push(event) });
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  const waiting = store.waitForTerminal(task.taskId, { timeoutMs: 30_000 });

  clock.t = 10;
  store.transition(task.taskId, "completed", "end_turn", { result: { ok: true, attempt: 1 } });
  assert.equal((await waiting).status, "completed");
  const before = store.get(task.taskId);

  clock.t = 999;
  const afterFailed = store.transition(task.taskId, "failed", "late failure", { result: { ok: false } });
  assert.deepEqual(afterFailed, before, "a terminal record is returned unchanged");
  assert.equal(afterFailed.status, "completed");
  assert.equal(afterFailed.statusMessage, "end_turn");
  assert.deepEqual(afterFailed.result, { ok: true, attempt: 1 });
  assert.equal(afterFailed.lastUpdatedAt, iso(10), "no lastUpdatedAt bump on a terminal no-op");

  // Replaying the same terminal target is equally inert (idempotent commits).
  assert.deepEqual(store.transition(task.taskId, "completed", "replayed", { result: { ok: true, attempt: 2 } }), before);
  assert.equal(events.filter((event) => event.type === "updated").length, 1, "no second durable mutation, so no second waiter fan-out");

  // A waiter registered after the fact still sees the first recorded outcome.
  assert.equal((await store.waitForTerminal(task.taskId, { timeoutMs: 30_000 })).statusMessage, "end_turn");
});

test("state machine allows same-status refresh and rejects unknown statuses", () => {
  const { store, clock } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });

  // Chosen semantics: transition(status === current) is a legal "refresh" that
  // moves statusMessage/lastUpdatedAt but never the createdAt TTL anchor.
  clock.t = 5;
  const refreshed = store.transition(task.taskId, "working", "Prompt running");
  assert.equal(refreshed.status, "working");
  assert.equal(refreshed.statusMessage, "Prompt running");
  assert.equal(refreshed.lastUpdatedAt, iso(5));
  assert.equal(refreshed.createdAt, iso(0));

  clock.t = 6;
  assert.equal(store.transition(task.taskId, "input_required", "needs input").status, "input_required");
  clock.t = 7;
  assert.equal(store.transition(task.taskId, "input_required", "still needs input").status, "input_required");
  clock.t = 8;
  assert.equal(store.transition(task.taskId, "working", "answer accepted").status, "working");

  // Omitting statusMessage keeps the previous one.
  clock.t = 9;
  const kept = store.transition(task.taskId, "working");
  assert.equal(kept.statusMessage, "answer accepted");
  assert.equal(kept.lastUpdatedAt, iso(9));

  assert.throws(() => store.transition(task.taskId, "bogus", "x"), assertCode("INVALID_ARGUMENT"));
  assert.throws(() => store.transition(task.taskId, "working", 7), assertCode("INVALID_ARGUMENT"));
  assert.throws(() => store.transition("task-missing", "completed", "x"), assertCode("UNKNOWN_TASK"));

  // Documented asymmetry: an illegal transition out of a terminal state does NOT
  // throw, it no-ops. Only unknown statuses and unknown ids throw.
  store.transition(task.taskId, "completed", "end_turn", { result: { ok: true } });
  assert.equal(store.transition(task.taskId, "working", "resurrect").status, "completed");
});

test("transition stores an explicitly passed result even before terminal", () => {
  const { store } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  assert.deepEqual(store.transition(task.taskId, "working", "partial", { result: { ok: true, partial: true } }).result, {
    ok: true,
    partial: true
  });
  // A terminal transition without an explicit result keeps whatever was stored.
  assert.deepEqual(store.transition(task.taskId, "completed", "end_turn").result, { ok: true, partial: true });
});

test("listPage pagination stays stable across mid-iteration expiry and inserts", () => {
  const { store, clock } = makeStore();
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    clock.t = index * 10;
    created.push(
      store.create({ sessionId: `session-${index}`, ownerRootId: "rootA", ttl: index === 2 ? 15 : 1_000_000 }).taskId
    );
  }

  const first = store.listPage({ ownerRootId: "rootA", limit: 2 });
  assert.deepEqual(first.tasks.map((task) => task.taskId), [created[0], created[1]]);
  assert.notEqual(first.nextCursor, null);

  // Between pages: created[2] expires and two later tasks are inserted.
  clock.t = 100;
  const inserted = [store.create({ sessionId: "session-5", ownerRootId: "rootA", ttl: 1_000_000 }).taskId];
  clock.t = 110;
  inserted.push(store.create({ sessionId: "session-6", ownerRootId: "rootA", ttl: 1_000_000 }).taskId);

  const seen = [...first.tasks.map((task) => task.taskId)];
  let cursor = first.nextCursor;
  let guard = 0;
  while (cursor && guard < 10) {
    guard += 1;
    const page = store.listPage({ ownerRootId: "rootA", limit: 2, cursor });
    seen.push(...page.tasks.map((task) => task.taskId));
    cursor = page.nextCursor;
  }
  assert.equal(cursor, null, "nextCursor is null once the page set is exhausted");
  assert.equal(new Set(seen).size, seen.length, "no duplicates across pages");
  for (const id of [created[0], created[1], created[3], created[4]]) {
    assert.equal(seen.filter((value) => value === id).length, 1, "surviving items are returned exactly once");
  }
  assert.equal(seen.includes(created[2]), false, "the expired item is gone, and its slot never shifts the window");
  assert.deepEqual(seen.slice(-2), inserted, "later inserts land after the cursor");
  assert.deepEqual(seen, [created[0], created[1], created[3], created[4], ...inserted]);
});

test("listPage cursors are opaque, replayable and validated", () => {
  const { store, clock } = makeStore();
  for (let index = 0; index < 3; index += 1) {
    clock.t = index * 10;
    store.create({ sessionId: `session-${index}`, ownerRootId: "rootA" });
  }
  const first = store.listPage({ ownerRootId: "rootA", limit: 1 });
  assert.equal(typeof first.nextCursor, "string");
  // Same cursor twice yields the same page (cursors carry no server state).
  assert.deepEqual(
    store.listPage({ ownerRootId: "rootA", limit: 1, cursor: first.nextCursor }),
    store.listPage({ ownerRootId: "rootA", limit: 1, cursor: first.nextCursor })
  );
  assert.throws(() => store.listPage({ ownerRootId: "rootA", cursor: "not-a-cursor" }), assertCode("INVALID_ARGUMENT"));
  assert.throws(
    () => store.listPage({ ownerRootId: "rootA", cursor: Buffer.from('{"c":1}').toString("base64url") }),
    assertCode("INVALID_ARGUMENT")
  );
  assert.throws(() => store.listPage({ ownerRootId: "rootA", cursor: "" }), assertCode("INVALID_ARGUMENT"));
});

test("listPage is root scoped and refuses cross-root access", async () => {
  const { store } = makeStore();
  const mine = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  const theirs = store.create({ sessionId: "session-2", ownerRootId: "rootB" });

  assert.deepEqual(store.listPage({ ownerRootId: "rootA" }).tasks.map((task) => task.taskId), [mine.taskId]);
  assert.deepEqual(store.listPage({ ownerRootId: "rootB" }).tasks.map((task) => task.taskId), [theirs.taskId]);

  assert.throws(() => store.get(theirs.taskId, { ownerRootId: "rootA" }), assertCode("NOT_TASK_OWNER"));
  assert.throws(() => store.result(theirs.taskId, { ownerRootId: "rootA" }), assertCode("NOT_TASK_OWNER"));
  assert.throws(() => store.markCancelling(theirs.taskId, { ownerRootId: "rootA" }), assertCode("NOT_TASK_OWNER"));
  await assert.rejects(store.waitForTerminal(theirs.taskId, { ownerRootId: "rootA" }), assertCode("NOT_TASK_OWNER"));

  // Root scoping is mandatory: there is no unscoped listing mode.
  assert.throws(() => store.listPage(), assertCode("INVALID_ARGUMENT"));
  assert.throws(() => store.listPage({}), assertCode("INVALID_ARGUMENT"));
  assert.throws(() => store.listPage({ ownerRootId: "" }), assertCode("INVALID_ARGUMENT"));
});

test("listPage filters by status and clamps the limit", () => {
  const { store, clock } = makeStore();
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    clock.t = index * 10;
    ids.push(store.create({ sessionId: `session-${index}`, ownerRootId: "rootA" }).taskId);
  }
  store.transition(ids[0], "completed", "end_turn", { result: { ok: true } });
  store.transition(ids[1], "input_required", "needs input");

  assert.deepEqual(
    store.listPage({ ownerRootId: "rootA", status: "completed" }).tasks.map((task) => task.taskId),
    [ids[0]]
  );
  assert.equal(store.listPage({ ownerRootId: "rootA", status: ["input_required", "working"] }).tasks.length, 2);
  assert.equal(store.listPage({ ownerRootId: "rootA", status: "cancelled" }).tasks.length, 0);
  assert.equal(store.listPage({ ownerRootId: "rootA", status: "cancelled" }).nextCursor, null);
  assert.throws(() => store.listPage({ ownerRootId: "rootA", status: "bogus" }), assertCode("INVALID_ARGUMENT"));

  const clampedLow = store.listPage({ ownerRootId: "rootA", limit: 0 });
  assert.equal(clampedLow.tasks.length, 1, "limit is clamped up to 1");
  assert.notEqual(clampedLow.nextCursor, null);
  assert.equal(store.listPage({ ownerRootId: "rootA", limit: -3 }).tasks.length, 1);
  assert.equal(store.listPage({ ownerRootId: "rootA", limit: 1.9 }).tasks.length, 1);
  assert.equal(store.listPage({ ownerRootId: "rootA" }).tasks.length, 3);
  assert.throws(() => store.listPage({ ownerRootId: "rootA", limit: Number.NaN }), assertCode("INVALID_ARGUMENT"));
});

test("listPage clamps the limit down to 200", () => {
  const { store, clock } = makeStore({ maxTasksPerRoot: 400, maxConcurrentTasksPerRoot: 400 });
  for (let index = 0; index < 201; index += 1) {
    clock.t = index;
    store.create({ sessionId: `session-${index}`, ownerRootId: "rootA" });
  }
  const page = store.listPage({ ownerRootId: "rootA", limit: 9_999 });
  assert.equal(page.tasks.length, 200);
  assert.notEqual(page.nextCursor, null);
  const tail = store.listPage({ ownerRootId: "rootA", limit: 9_999, cursor: page.nextCursor });
  assert.equal(tail.tasks.length, 1);
  assert.equal(tail.nextCursor, null);
});

test("maxTasksPerRoot counts every live record, terminal ones included", () => {
  const { store, clock } = makeStore({ maxTasksPerRoot: 3, maxConcurrentTasksPerRoot: 3, defaultTtlMs: 1_000 });
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    ids.push(store.create({ sessionId: `session-${index}`, ownerRootId: "rootA" }).taskId);
  }
  assert.throws(() => store.create({ sessionId: "session-x", ownerRootId: "rootA" }), assertCode("TASK_LIMIT_EXCEEDED"));

  store.transition(ids[0], "completed", "end_turn", { result: { ok: true } });
  // A terminal task keeps its retention slot until TTL: it frees concurrency,
  // not the per-root handle budget.
  assert.throws(() => store.create({ sessionId: "session-x", ownerRootId: "rootA" }), assertCode("TASK_LIMIT_EXCEEDED"));
  assert.equal(store.create({ sessionId: "session-y", ownerRootId: "rootB" }).status, "working", "budgets are per root");

  clock.t = 1_000;
  assert.equal(store.create({ sessionId: "session-x", ownerRootId: "rootA" }).status, "working", "expiry frees the budget");
});

test("maxConcurrentTasksPerRoot counts only working and input_required", () => {
  const { store } = makeStore({ maxTasksPerRoot: 10, maxConcurrentTasksPerRoot: 2 });
  const base = { sessionId: "session-1", ownerRootId: "rootA" };
  const first = store.create(base);
  const second = store.create(base);
  assert.throws(() => store.create(base), assertCode("TASK_LIMIT_EXCEEDED"));

  store.transition(first.taskId, "completed", "end_turn", { result: { ok: true } });
  assert.equal(store.create(base).status, "working", "a terminal task frees a concurrency slot");
  assert.equal(store.size, 3, "the terminal record is still a live record");
  assert.throws(() => store.create(base), assertCode("TASK_LIMIT_EXCEEDED"));

  store.transition(second.taskId, "input_required", "needs input");
  assert.throws(() => store.create(base), assertCode("TASK_LIMIT_EXCEEDED"), "input_required still occupies a slot");
});

test("markCancelling annotates active tasks without transitioning them", () => {
  const { store, clock } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  clock.t = 25;
  const cancelling = store.markCancelling(task.taskId, { ownerRootId: "rootA" });
  assert.equal(cancelling.status, "working", "status only changes when the turn actually ends");
  assert.equal(cancelling.statusMessage, "Cancellation requested");
  assert.equal(cancelling.lastUpdatedAt, iso(25));

  store.transition(task.taskId, "input_required", "needs input");
  clock.t = 30;
  assert.equal(store.markCancelling(task.taskId).status, "input_required");
  assert.equal(store.get(task.taskId).statusMessage, "Cancellation requested");

  clock.t = 40;
  store.transition(task.taskId, "cancelled", "cancelled", { result: { ok: true } });
  const noop = store.markCancelling(task.taskId);
  assert.equal(noop.statusMessage, "cancelled", "terminal markCancelling is a no-op");
  assert.equal(noop.lastUpdatedAt, iso(40));
});

test("cancel commits one terminal result and rejects terminal cancellation", async () => {
  const { store, clock } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  const waiting = store.waitForTerminal(task.taskId, { ownerRootId: "rootA", timeoutMs: 1_000 });

  clock.t = 25;
  const cancelled = store.cancel(task.taskId, {
    ownerRootId: "rootA",
    statusMessage: "cancelled by Main",
    result: { ok: true, status: "cancelled" }
  });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(store.result(task.taskId), { ok: true, status: "cancelled" });
  assert.equal((await waiting).status, "cancelled");

  // A late worker completion cannot overwrite cancellation: terminal-first-wins.
  store.transition(task.taskId, "completed", "late", { result: { ok: true, status: "completed" } });
  assert.equal(store.get(task.taskId).status, "cancelled");
  assert.deepEqual(store.result(task.taskId), { ok: true, status: "cancelled" });
  assert.throws(() => store.cancel(task.taskId), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /terminal status: cancelled/);
    return true;
  });
});

test("result throws TASK_NOT_COMPLETE while active and returns the stored payload once terminal", () => {
  const { store } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });

  assert.throws(() => store.result(task.taskId), (error) => {
    assert.equal(error.code, "TASK_NOT_COMPLETE");
    assert.match(error.message, /is not complete/);
    return true;
  });
  store.transition(task.taskId, "input_required", "needs input");
  assert.throws(() => store.result(task.taskId), assertCode("TASK_NOT_COMPLETE"));

  store.transition(task.taskId, "completed", "end_turn", { result: { ok: true, text: "final" } });
  assert.deepEqual(store.result(task.taskId, { ownerRootId: "rootA" }), { ok: true, text: "final" });

  assert.throws(() => store.result("task-missing"), (error) => {
    assert.equal(error.code, "UNKNOWN_TASK");
    assert.equal(error.message, "Unknown taskId: task-missing");
    return true;
  });
  assert.throws(() => store.get(undefined), assertCode("INVALID_ARGUMENT"));
});

test("waitForTerminal composes with result to form a bounded blocking read", async () => {
  const { store } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  const pending = (async () => {
    await store.waitForTerminal(task.taskId, { ownerRootId: "rootA", timeoutMs: 30_000 });
    return store.result(task.taskId, { ownerRootId: "rootA" });
  })();
  store.transition(task.taskId, "completed", "end_turn", { result: { ok: true, text: "blocked read" } });
  assert.deepEqual(await pending, { ok: true, text: "blocked read" });
});

test("recover converts in-flight records with the legacy restart message", () => {
  const { store, clock } = makeStore();
  clock.t = 5_000;
  const summary = store.recover([
    persisted({ taskId: "task-1", status: "working" }),
    persisted({ taskId: "task-2", status: "input_required" }),
    persisted({ taskId: "task-3", status: "completed", statusMessage: "end_turn", result: { ok: true, text: "kept" }, lastUpdatedAt: iso(200) }),
    persisted({ taskId: "task-4", status: "working", ttl: 100 }),
    persisted({ taskId: "task-5", status: "completed", ttl: 100 }),
    persisted({ taskId: "task-6", status: "bogus" }),
    persisted({ taskId: "" }),
    null
  ]);
  assert.deepEqual(summary, { loaded: 3, restarted: 2, dropped: 5 });

  for (const id of ["task-1", "task-2"]) {
    const record = store.get(id);
    assert.equal(record.status, "failed");
    assert.equal(record.statusMessage, "Gateway restarted before this task completed");
    assert.deepEqual(record.result, { ok: false, error: "Gateway restarted before this task completed" });
    assert.equal(record.lastUpdatedAt, iso(5_000), "only failed conversions bump lastUpdatedAt");
    assert.equal(record.createdAt, iso(0), "the TTL anchor survives recovery");
  }

  const terminal = store.get("task-3");
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.statusMessage, "end_turn");
  assert.equal(terminal.lastUpdatedAt, iso(200));
  assert.deepEqual(terminal.result, { ok: true, text: "kept" });

  assert.throws(() => store.get("task-4"), assertCode("UNKNOWN_TASK"), "expired in-flight records are dropped");
  assert.throws(() => store.get("task-5"), assertCode("UNKNOWN_TASK"), "expired terminal records are dropped");
  assert.throws(() => store.get("task-6"), assertCode("UNKNOWN_TASK"));
  assert.throws(() => store.recover("nope"), assertCode("INVALID_ARGUMENT"));
});

test("recover keeps a null ttl as never-expires and repairs corrupt fields", () => {
  const { store, clock } = makeStore();
  store.recover([
    persisted({ taskId: "task-forever", status: "completed", ttl: null }),
    persisted({ taskId: "task-corrupt", status: "completed", ttl: "bad", pollInterval: 1, turnId: 12, statusMessage: 5 })
  ]);
  clock.t = 10 ** 12;
  assert.equal(store.get("task-forever").ttl, null);
  assert.equal(store.get("task-forever").status, "completed");
  assert.throws(() => store.get("task-corrupt"), assertCode("UNKNOWN_TASK"), "a repaired ttl still expires");

  const { store: fresh } = makeStore();
  fresh.recover([persisted({ taskId: "task-corrupt", status: "completed", ttl: "bad", pollInterval: 1, turnId: 12, statusMessage: 5 })]);
  const repaired = fresh.get("task-corrupt");
  assert.equal(repaired.ttl, 3_600_000);
  assert.equal(repaired.pollInterval, 100);
  assert.equal(repaired.turnId, null);
  assert.equal(repaired.statusMessage, "");
});

test("recover ignores per-root budgets so durable handles are never lost", () => {
  const { store } = makeStore({ maxTasksPerRoot: 1, maxConcurrentTasksPerRoot: 1 });
  const summary = store.recover([
    persisted({ taskId: "task-1", status: "completed" }),
    persisted({ taskId: "task-2", status: "completed" }),
    persisted({ taskId: "task-3", status: "working" })
  ]);
  assert.equal(summary.loaded, 3);
  assert.equal(store.size, 3);
  assert.throws(() => store.create({ sessionId: "session-1", ownerRootId: "rootA" }), assertCode("TASK_LIMIT_EXCEEDED"));
});

test("toPersistedRecords can reproduce the legacy in-flight-only filter", () => {
  const { store, clock } = makeStore();
  const first = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  clock.t = 10;
  const second = store.create({ sessionId: "session-2", ownerRootId: "rootB" });
  store.transition(second.taskId, "completed", "end_turn", { result: { ok: true } });

  const all = store.toPersistedRecords();
  assert.deepEqual(all.map((record) => record.taskId), [first.taskId, second.taskId]);
  assert.deepEqual(Object.keys(all[0]), Object.keys(first));

  const inFlight = store.toPersistedRecords({ includeTerminal: false });
  assert.deepEqual(inFlight.map((record) => record.taskId), [first.taskId]);

  // Persisted records are copies: mutating them cannot corrupt the store.
  all[0].status = "cancelled";
  assert.equal(store.get(first.taskId).status, "working");
});

test("onChange reports every durable mutation", () => {
  const events = [];
  const { store, clock } = makeStore({ onChange: (event) => events.push(event), defaultTtlMs: 100 });
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  store.transition(task.taskId, "input_required", "needs input");
  store.markCancelling(task.taskId);
  store.transition(task.taskId, "cancelled", "cancelled", { result: { ok: true } });
  store.transition(task.taskId, "completed", "ignored");
  clock.t = 100;
  assert.equal(store.expireSweep(), 1);
  store.clear();
  assert.deepEqual(events.map((event) => event.type), [
    "created",
    "updated",
    "updated",
    "updated",
    "removed",
    "cleared"
  ]);
  assert.equal(events[0].taskId, task.taskId);
  assert.equal(events.at(-1).task, null);
});

test("a throwing onChange listener cannot corrupt an applied mutation", () => {
  const { store } = makeStore({
    onChange: () => {
      throw new Error("persistence exploded");
    }
  });
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  assert.equal(store.transition(task.taskId, "completed", "end_turn", { result: { ok: true } }).status, "completed");
  assert.deepEqual(store.result(task.taskId), { ok: true });
});

// --- PR 3 additions: the deferred fan-out, removal and turn provenance that
// PR 4 (durable result commit) and PR 7 (agent_acp_run) depend on. -------------

// Lets the microtask and immediate queues drain so "still pending" means pending
// for reasons other than scheduling.
async function quiesce() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("deferWaiters holds the terminal fan-out until flushWaiters releases it", async () => {
  const { store, clock } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  const settled = [];
  const early = store.waitForTerminal(task.taskId, { timeoutMs: 30_000 })
    .then((record) => {
      settled.push(record.status);
      return record;
    });

  clock.t = 10;
  store.transition(task.taskId, "completed", "end_turn", { result: { ok: true, text: "durable" }, deferWaiters: true });
  await quiesce();
  assert.deepEqual(settled, [], "a deferred commit must not wake the waiter that was already parked");

  // A waiter that arrives after the deferred commit queues too: the outcome is
  // recorded but not yet releasable.
  const late = store.waitForTerminal(task.taskId, { timeoutMs: 30_000 });
  await quiesce();

  // Documented asymmetry: only the blocking path is gated. Non-blocking reads are
  // retryable polls, not consumption, so they see the record immediately.
  assert.equal(store.get(task.taskId).status, "completed");
  assert.deepEqual(store.result(task.taskId), { ok: true, text: "durable" });

  assert.equal(store.flushWaiters(task.taskId), 2, "flushWaiters reports how many waiters it woke");
  assert.equal((await early).status, "completed");
  assert.equal((await late).statusMessage, "end_turn");
  assert.deepEqual(settled, ["completed"]);

  // Once flushed, the record behaves like any other terminal record again.
  assert.equal((await store.waitForTerminal(task.taskId, { timeoutMs: 1 })).status, "completed");
  assert.equal(store.get(task.taskId).lastUpdatedAt, iso(10), "deferral changes delivery, never the record");
});

test("failDeferredTerminal replaces only a provisional terminal result", async () => {
  const { store } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  const waiting = store.waitForTerminal(task.taskId, { ownerRootId: "rootA", timeoutMs: 1_000 });
  store.transition(task.taskId, "completed", "end_turn", {
    result: { ok: true },
    deferWaiters: true
  });
  const failed = store.failDeferredTerminal(task.taskId, "barrier failed", { ok: false });
  assert.equal(failed.status, "failed");
  assert.deepEqual((await waiting).result, { ok: false });
  assert.throws(
    () => store.failDeferredTerminal(task.taskId, "again", { ok: false }),
    assertCode("INVALID_ARGUMENT")
  );
});

test("flushWaiters is a no-op unless a deferred commit is outstanding", async () => {
  const { store } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  assert.equal(store.flushWaiters(task.taskId), 0, "nothing deferred yet");
  assert.equal(store.flushWaiters("task-missing"), 0, "unknown ids never throw");

  const waiting = store.waitForTerminal(task.taskId, { timeoutMs: 30_000 });
  store.transition(task.taskId, "cancelled", "cancelled", { result: { ok: true }, deferWaiters: true });
  assert.equal(store.flushWaiters(task.taskId), 1);
  // Idempotent: a committer may flush unconditionally in a finally block.
  assert.equal(store.flushWaiters(task.taskId), 0);
  assert.equal((await waiting).status, "cancelled");
  assert.throws(() => store.flushWaiters(""), assertCode("INVALID_ARGUMENT"));
});

test("a deferred terminal record that expires rejects its waiters instead of stranding them", async () => {
  const { store, clock } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA", ttl: 1_000 });
  const waiting = store.waitForTerminal(task.taskId, { timeoutMs: 30_000 });
  store.transition(task.taskId, "completed", "end_turn", { result: { ok: true }, deferWaiters: true });

  clock.t = 1_000;
  assert.equal(store.expireSweep(), 1);
  await assert.rejects(waiting, assertCode("TASK_TTL_EXPIRED"));
  // The deferral died with the record: a stale marker would swallow the fan-out
  // of the next task that happened to reuse the id.
  assert.equal(store.flushWaiters(task.taskId), 0);
});

test("remove deletes a record and rejects its waiters as UNKNOWN_TASK", async () => {
  const events = [];
  const { store } = makeStore({ onChange: (event) => events.push(event) });
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  const waiting = store.waitForTerminal(task.taskId, { timeoutMs: 30_000 });

  assert.equal(store.remove(task.taskId), true);
  await assert.rejects(waiting, (error) => {
    assert.equal(error.code, "UNKNOWN_TASK");
    assert.equal(error.message, `Unknown taskId: ${task.taskId}`);
    return true;
  });
  assert.equal(store.size, 0);
  assert.throws(() => store.get(task.taskId), assertCode("UNKNOWN_TASK"));
  assert.equal(events.at(-1).type, "removed");
  assert.equal(events.at(-1).taskId, task.taskId);

  assert.equal(store.remove(task.taskId), false, "removing twice is not an error");
  assert.equal(store.remove("task-missing"), false);
  assert.throws(() => store.remove(undefined), assertCode("INVALID_ARGUMENT"));
});

test("remove frees the per-root budget a failed create should never have spent", () => {
  const { store } = makeStore({ maxTasksPerRoot: 1, maxConcurrentTasksPerRoot: 1 });
  const first = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  assert.throws(() => store.create({ sessionId: "session-2", ownerRootId: "rootA" }), assertCode("TASK_LIMIT_EXCEEDED"));
  store.remove(first.taskId);
  assert.equal(store.create({ sessionId: "session-2", ownerRootId: "rootA" }).status, "working");
});

test("attachTurn records turn provenance, terminal records included", () => {
  const events = [];
  const { store, clock } = makeStore({ onChange: (event) => events.push(event) });
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  assert.equal(task.turnId, null);

  clock.t = 5;
  const attached = store.attachTurn(task.taskId, "turn-1");
  assert.equal(attached.turnId, "turn-1");
  assert.equal(attached.lastUpdatedAt, iso(0), "provenance is not a status change, so it does not bump lastUpdatedAt");
  assert.equal(events.filter((event) => event.type === "updated").length, 1);

  // Re-attaching the same turn is inert.
  store.attachTurn(task.taskId, "turn-1");
  assert.equal(events.filter((event) => event.type === "updated").length, 1);

  // The race this exists for: the turn ended before the queued command got to
  // record which turn it was. status/statusMessage/result stay frozen, but the
  // turn that produced the outcome is still the turn that produced it.
  clock.t = 10;
  store.transition(task.taskId, "completed", "end_turn", { result: { ok: true } });
  const late = store.attachTurn(task.taskId, "turn-2");
  assert.equal(late.turnId, "turn-2");
  assert.equal(late.status, "completed");
  assert.equal(late.statusMessage, "end_turn");
  assert.equal(late.lastUpdatedAt, iso(10));

  assert.throws(() => store.attachTurn(task.taskId, 7), assertCode("INVALID_ARGUMENT"));
  assert.throws(() => store.attachTurn("task-missing", "turn-1"), assertCode("UNKNOWN_TASK"));
  assert.throws(
    () => store.attachTurn(task.taskId, "turn-3", { ownerRootId: "rootB" }),
    assertCode("NOT_TASK_OWNER")
  );
});

test("find is a non-throwing lookup that still evaluates expiry", () => {
  const { store, clock } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA", ttl: 100 });
  assert.equal(store.find(task.taskId).status, "working");
  assert.equal(store.find("task-missing"), null);
  assert.equal(store.find(undefined), null, "bookkeeping callers pass whatever they hold");
  assert.equal(store.find(""), null);

  clock.t = 100;
  assert.equal(store.find(task.taskId), null, "an expired handle is not found, not returned stale");
  assert.equal(store.size, 0);

  const other = store.create({ sessionId: "session-2", ownerRootId: "rootA" });
  const found = store.find(other.taskId);
  found.status = "completed";
  assert.equal(store.get(other.taskId).status, "working", "find returns a snapshot, not the live record");
});

test("records exposes the raw map for legacy and replay ingress only", () => {
  const { store } = makeStore();
  // The two sanctioned writers: the gateway's legacy `service.tasks` alias and
  // PR 4's WAL replay, which must rebuild plain records without walking them
  // through transition().
  store.records.set("task-replayed", {
    taskId: "task-replayed",
    sessionId: "session-1",
    ownerRootId: "rootA",
    turnId: "turn-1",
    status: "completed",
    ttl: 60_000,
    pollInterval: 1_000,
    createdAt: iso(0),
    lastUpdatedAt: iso(0),
    statusMessage: "end_turn",
    result: { ok: true, text: "replayed" }
  });
  assert.equal(store.size, 1);
  assert.equal(store.get("task-replayed").status, "completed");
  assert.deepEqual(store.result("task-replayed"), { ok: true, text: "replayed" });
  assert.deepEqual(store.listPage({ ownerRootId: "rootA" }).tasks.map((task) => task.taskId), ["task-replayed"]);
});

test("returned records are snapshots, not live store state", () => {
  const { store } = makeStore();
  const task = store.create({ sessionId: "session-1", ownerRootId: "rootA" });
  task.status = "completed";
  task.statusMessage = "tampered";
  const fresh = store.get(task.taskId);
  assert.equal(fresh.status, "working");
  assert.equal(fresh.statusMessage, "Prompt accepted");
  assert.notEqual(store.get(task.taskId), store.get(task.taskId));
});
