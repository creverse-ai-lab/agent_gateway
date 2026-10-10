// Concurrency tests for the per-session mailbox. Every ordering here is forced
// by a marker, a counter, or a status the gateway itself published — never by a
// timer — so a failure means the serialization is wrong rather than that the
// machine was busy.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { GatewayService } from "../src/gateway-service.js";
import { SESSION_CRITICAL_QUEUE_RESERVE, SESSION_QUEUE_LIMIT } from "../src/session-queue.js";
import { FakeWorker } from "./helpers/fake-worker.js";
import { readSnapshotBody } from "./helpers/state-files.js";

const raceAgent = fileURLToPath(new URL("./mock-race-agent.js", import.meta.url));
const MAIN = { rootId: "main-a" };

function makeService({ hold = "", permissionPolicy = "ask", ...options } = {}) {
  const createClient = (_provider, clientOptions) =>
    new AcpClient(
      {
        provider: "mock",
        command: process.execPath,
        args: [raceAgent],
        permissionPolicy,
        modelScope: "session",
        env: hold ? { ACP_MOCK_HOLD: hold } : {}
      },
      clientOptions
    );
  return new GatewayService({ createClient, gcIntervalMs: 0, ...options });
}

// Runs a case against a fresh service and asserts the transition table was
// never violated on the way through — the invariant every case shares.
async function withService(options, body) {
  const service = makeService(options);
  try {
    await body(service);
    assert.equal(service.illegalTransitions, 0, "illegal status transitions");
  } finally {
    await service.shutdown().catch(() => {});
  }
}

async function open(service, extra = {}) {
  return service.call(
    "session_open",
    { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask", ...extra },
    MAIN
  );
}

// Yields to the event loop and the ACP pipe without asserting how long an
// ordering takes: the predicate is the contract, the loop is only patience.
async function until(predicate, description) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function markers(service, sessionId) {
  const session = service.store.get(sessionId);
  return (session?.events ?? [])
    .filter((event) => event.type === "test_marker")
    .map((event) => event.data?.marker);
}

// The agent announces a hold as a session update, so "the worker is parked
// inside this method" is an event the gateway already delivered.
function waitForMarker(service, sessionId, marker) {
  return until(() => markers(service, sessionId).includes(marker), `marker ${marker}`);
}

function waitForStatus(service, sessionId, expected) {
  return until(
    () => service.store.get(sessionId)?.status === expected,
    `session ${sessionId} status ${expected}`
  );
}

// Captures an outcome at submission time. These cases deliberately leave a
// command in flight while awaiting something else, and a rejection nobody is
// listening to yet is an unhandled rejection.
function settle(promise) {
  return promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
}

function counters(client) {
  return client.request("test/counters");
}

function release(client, hold) {
  return client.request("test/release", { hold });
}

function eventsOfType(service, sessionId, type) {
  return (service.store.get(sessionId)?.events ?? []).filter((event) => event.type === type);
}

test("T1 races a cancel against a prompt that is still choosing a model", async () => {
  await withService({ hold: "config,prompt" }, async (service) => {
    const opened = await open(service);
    const client = service.requireSession(opened.sessionId).client;

    // The prompt is parked inside set_config_option, before it has a turn.
    const prompt = service.call(
      "prompt",
      { sessionId: opened.sessionId, prompt: "one", model: "race-pro" },
      MAIN
    );
    await waitForMarker(service, opened.sessionId, "hold:config");
    const cancel = service.call("cancel", { sessionId: opened.sessionId }, MAIN);
    await release(client, "config");

    const ack = await prompt;
    const cancelled = await cancel;
    assert.equal(ack.status, "running");
    // The cancel waited for the turn instead of being dropped on the floor
    // while the session still looked idle.
    assert.equal(cancelled.status, "cancelling");

    const { order } = await counters(client);
    assert.ok(
      order.indexOf("prompt") < order.indexOf("cancel"),
      `cancel must not overtake its own prompt: ${order.join(",")}`
    );

    await waitForMarker(service, opened.sessionId, "hold:prompt");
    await release(client, "prompt");
    await waitForStatus(service, opened.sessionId, "cancelled");
    assert.equal(service.requireSession(opened.sessionId).stopReason, "cancelled");
  });
});

test("T2 cancels a session whose worker is mid-resume without raising or leaking", async () => {
  await withService({ hold: "resume" }, async (service) => {
    const keepAlive = await open(service);
    const opened = await open(service);
    const client = service.requireSession(opened.sessionId).client;
    assert.equal(service.requireSession(keepAlive.sessionId).client, client);

    // Unloaded: the record survives with no client at all, which is the shape
    // that used to make cancel throw a bare TypeError.
    assert.equal(await service.unloadSession(service.requireSession(opened.sessionId)), true);
    assert.equal(service.requireSession(opened.sessionId).client, null);

    const prompt = service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
    await until(async () => (await counters(client)).counters.resume === 1, "session/resume to arrive");
    const cancel = service.call("cancel", { sessionId: opened.sessionId }, MAIN);
    await release(client, "resume");

    await prompt;
    await cancel;
    await waitForStatus(service, opened.sessionId, "cancelled");

    // The cancel flag belonged to that turn only; the next one must not be born
    // pre-cancelled.
    const second = await service.call("prompt", { sessionId: opened.sessionId, prompt: "two" }, MAIN);
    assert.equal(second.status, "running");
    await waitForStatus(service, opened.sessionId, "idle");
    assert.equal(service.requireSession(opened.sessionId).stopReason, "end_turn");
  });
});

test("T2b cancel is a no-op on a restoring session with no client", async () => {
  await withService({}, async (service) => {
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    session.client = null;
    session.status = "restoring";

    const result = await service.call("cancel", { sessionId: opened.sessionId }, MAIN);
    assert.equal(result.ok, true);
    assert.equal(result.status, "restoring");
    assert.ok(!session.cancelRequested, "cancelRequested must not leak onto the next turn");
    assert.equal(eventsOfType(service, opened.sessionId, "cancel_requested").length, 0);
  });
});

test("T3 closing a session mid-resume leaves no record and no re-attached handler", async () => {
  await withService({ hold: "resume" }, async (service) => {
    const keepAlive = await open(service);
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;
    const acpSessionId = session.acpSessionId;

    const delivered = [];
    service.subscribe({ sessionIds: [opened.sessionId] }, MAIN, (event) => delivered.push(event.type));

    assert.equal(await service.unloadSession(session), true);
    const config = service.call("config", { sessionId: opened.sessionId, action: "list" }, MAIN);
    await until(async () => (await counters(client)).counters.resume === 1, "session/resume to arrive");
    const closed = service.call("session", { action: "close", sessionId: opened.sessionId }, MAIN);
    await release(client, "resume");
    await config;
    await closed;

    assert.equal(service.store.get(opened.sessionId), undefined);
    assert.equal(client.sessionHandlers.has(acpSessionId), false);
    const closedAt = delivered.indexOf("session_closed");
    assert.ok(closedAt >= 0, `session_closed must be delivered: ${delivered.join(",")}`);
    assert.equal(
      delivered.slice(closedAt).includes("session_restored"),
      false,
      `no restore may follow a close: ${delivered.join(",")}`
    );
    assert.ok(service.requireSession(keepAlive.sessionId).client.alive);
  });
});

test("T3b a resume that finishes after the record is gone does not revive it", async () => {
  await withService({ hold: "resume" }, async (service) => {
    await open(service);
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;
    const acpSessionId = session.acpSessionId;

    assert.equal(await service.unloadSession(session), true);
    const prompt = service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
    await until(async () => (await counters(client)).counters.resume === 1, "session/resume to arrive");
    // Simulates the record disappearing under an in-flight resume.
    service.store.delete(opened.sessionId);
    await release(client, "resume");

    await assert.rejects(prompt, /is closed/);
    assert.equal(client.sessionHandlers.has(acpSessionId), false);
    assert.equal(session.client, null);
    assert.equal(eventsOfType(service, opened.sessionId, "session_restored").length, 0);
  });
});

test("T4 a close during a live turn drops the late completion and cancels the task", async () => {
  await withService({ hold: "prompt" }, async (service) => {
    const opened = await open(service);
    const client = service.requireSession(opened.sessionId).client;
    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
    await waitForMarker(service, opened.sessionId, "hold:prompt");

    const session = service.requireSession(opened.sessionId);
    const events = [];
    service.subscribe({ sessionIds: [opened.sessionId] }, MAIN, (event) => events.push(event.type));
    await service.call("session", { action: "close", sessionId: opened.sessionId }, MAIN);
    assert.equal(service.store.get(opened.sessionId), undefined);

    // The worker answers after the session is gone.
    await release(client, "prompt");
    await until(async () => (await counters(client)).holding.prompt === 0, "the held reply to be sent");

    const closedAt = events.indexOf("session_closed");
    assert.ok(closedAt >= 0);
    assert.equal(
      events.slice(closedAt + 1).includes("turn_end"),
      false,
      `no turn_end may follow a close: ${events.join(",")}`
    );
    assert.equal(session.status, "closed");
    const record = await service.call("task_get", { taskId: task.taskId }, MAIN);
    assert.equal(record.status, "cancelled");
    const result = await service.call("task_result", { taskId: task.taskId }, MAIN);
    assert.equal(result.result.stopReason, "cancelled");
  });
});

test("T5 a prompt queued behind a close is refused instead of running on a dead session", async () => {
  await withService({ hold: "close" }, async (service) => {
    const opened = await open(service);
    const client = service.requireSession(opened.sessionId).client;

    const closing = service.call("session", { action: "close", sessionId: opened.sessionId }, MAIN);
    await waitForMarker(service, opened.sessionId, "hold:close");
    const prompt = settle(service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN));
    await release(client, "close");
    await closing;

    const refused = await prompt;
    assert.equal(refused.ok, false);
    assert.match(refused.error.message, /is closed/);
    assert.equal(refused.error.code, "SESSION_CLOSED");
    assert.equal((await counters(client)).counters.prompt, undefined);
    assert.equal(service.store.get(opened.sessionId), undefined);
  });
});

test("T5b a worker request arriving during close cannot leave an orphan inbox row", async () => {
  await withService({ hold: "close" }, async (service) => {
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;

    const closing = service.call("session", { action: "close", sessionId: opened.sessionId }, MAIN);
    await waitForMarker(service, opened.sessionId, "hold:close");
    await client.request("test/emit", {
      sessionId: session.acpSessionId,
      update: {
        sessionUpdate: "permission_request",
        requestId: "late-permission",
        toolCall: { toolCallId: "late-tool", title: "Late edit", kind: "edit" },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
      }
    });

    await release(client, "close");
    await closing;
    assert.equal(service.store.get(opened.sessionId), undefined);
    assert.equal(
      [...service.inbox.values()].some((item) => item.sessionId === opened.sessionId),
      false,
      "a closed session cannot leave a pending worker request"
    );
  });
});

test("T6 an orphan cancel finalizes the turn exactly once", async () => {
  let clock = Date.now();
  await withService(
    { hold: "prompt", orphanGraceMs: 10, maxInlineResultBytes: 4, now: () => clock },
    async (service) => {
      service.attachRoot("main-a");
      const opened = await open(service);
      const client = service.requireSession(opened.sessionId).client;
      const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
      await waitForMarker(service, opened.sessionId, "hold:prompt");

      service.detachRoot("main-a");
      clock += 11;
      await service.runMaintenance();
      const session = service.requireSession(opened.sessionId);
      assert.equal(session.status, "cancelled");
      const finalArtifact = session.resultFinalArtifact?.path;
      assert.ok(finalArtifact, "the cancelled turn must spill its final segment once");

      // The real completion lands after the gateway already had the last word.
      await release(client, "prompt");
      await until(async () => (await counters(client)).holding.prompt === 0, "the held reply to be sent");

      assert.equal(session.resultFinalArtifact?.path, finalArtifact, "no second final spill");
      const terminal = eventsOfType(service, opened.sessionId, "turn_end")
        .concat(eventsOfType(service, opened.sessionId, "error"));
      assert.equal(terminal.length, 1, "exactly one terminal event");
      assert.equal((await service.call("task_get", { taskId: task.taskId }, MAIN)).status, "cancelled");
      assert.equal(session.status, "cancelled");
    }
  );
});

test("T6b reconnecting while orphan cancel is queued preserves the live turn", async () => {
  let clock = Date.now();
  await withService(
    { hold: "prompt", orphanGraceMs: 10, now: () => clock },
    async (service) => {
      service.attachRoot("main-a");
      const opened = await open(service);
      const session = service.requireSession(opened.sessionId);
      const client = session.client;
      const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
      await waitForMarker(service, opened.sessionId, "hold:prompt");

      let releaseMailbox;
      const mailboxBlock = session._queue.run("test_block", () => new Promise((resolve) => {
        releaseMailbox = resolve;
      }));
      await until(() => typeof releaseMailbox === "function", "mailbox blocker to start");

      service.detachRoot("main-a");
      clock += 11;
      const maintenance = service.runMaintenance();
      service.attachRoot("main-a");
      releaseMailbox();
      await mailboxBlock;
      await maintenance;

      assert.equal(session.status, "running");
      assert.notEqual(session.orphanCancelRequested, true);
      assert.equal((await service.call("task_get", { taskId: task.taskId }, MAIN)).status, "working");

      await release(client, "prompt");
      await waitForStatus(service, opened.sessionId, "idle");
    }
  );
});

test("T7 answering a permission never leaves the session running after the turn ends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-race-permission-"));
  try {
    await withService({}, async (service) => {
      const opened = await open(service, { cwd: directory });
      await service.call(
        "prompt",
        { sessionId: opened.sessionId, prompt: `write:${join(directory, "race.txt")}` },
        MAIN
      );
      await waitForStatus(service, opened.sessionId, "waiting_permission");
      const pending = await service.call("inbox", { action: "list", status: "pending" }, MAIN);

      await service.call(
        "permission",
        { sessionId: opened.sessionId, requestId: pending.items[0].requestId, optionId: "allow-once" },
        MAIN
      );
      await waitForStatus(service, opened.sessionId, "idle");

      // The wedge was a session stuck in an active status no caller could leave.
      const session = service.requireSession(opened.sessionId);
      assert.equal(session.status, "idle");
      assert.equal(session.turnSeal, session.turnId);
      const second = await service.call("prompt", { sessionId: opened.sessionId, prompt: "two" }, MAIN);
      assert.equal(second.status, "running");
      await waitForStatus(service, opened.sessionId, "idle");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("T7b input-state sync refuses to reopen a turn that already ended", async () => {
  await withService({}, async (service) => {
    const opened = await open(service);
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
    await waitForStatus(service, opened.sessionId, "idle");
    const session = service.requireSession(opened.sessionId);

    // The mirror runs after every answer; on a sealed turn it must write nothing.
    service.syncSessionInputState(session);
    assert.equal(session.status, "idle");

    session.status = "cancelled";
    service.syncSessionInputState(session);
    assert.equal(session.status, "cancelled");
    assert.equal(service.illegalTransitions, 0);
  });
});

// ACP request ids are strings or integers. A string one used to reach Main
// intact and come back through Number(), as NaN, which no request has: the
// worker waited for good.
test("T7c a worker request id keeps its type from the worker to Main and back", async () => {
  await withService({ hold: "prompt" }, async (service) => {
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
    await waitForMarker(service, opened.sessionId, "hold:prompt");
    const answers = async () => (await client.request("test/answers")).answers;
    const ask = async (id, question = false) => {
      await client.request("test/ask", { sessionId: session.acpSessionId, id, question });
      await waitForStatus(service, opened.sessionId, question ? "waiting_input" : "waiting_permission");
      const [row] = (await service.call("inbox", { action: "list", status: "pending" }, MAIN)).items;
      assert.equal(row.requestId, id, "the inbox row carries the id as the worker sent it");
    };

    await ask("perm-1");
    await service.call("permission", { sessionId: opened.sessionId, requestId: "perm-1", optionId: "allow-once" }, MAIN);
    assert.deepEqual((await answers()).at(-1), {
      id: "perm-1",
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
      error: null
    });

    await ask("question-1", true);
    await service.call(
      "answer",
      { sessionId: opened.sessionId, requestId: "question-1", action: "accept", content: { choice: "socket" } },
      MAIN
    );
    assert.deepEqual((await answers()).at(-1), {
      id: "question-1",
      result: { action: "accept", content: { choice: "socket" } },
      error: null
    });

    // An integer one a host hands back as a string still answers it, under the
    // worker's own integer.
    await ask(77);
    await service.call("permission", { sessionId: opened.sessionId, requestId: "77", optionId: "reject-once" }, MAIN);
    assert.deepEqual((await answers()).at(-1), {
      id: 77,
      result: { outcome: { outcome: "selected", optionId: "reject-once" } },
      error: null
    });

    // Neither a string nor a number is no id at all, and answers nothing.
    await ask("perm-2");
    await assert.rejects(
      service.call("permission", { sessionId: opened.sessionId, requestId: { id: "perm-2" }, optionId: "allow-once" }, MAIN),
      (error) => error.code === "INVALID_ARGUMENT" && /requestId must be a string or an integer/.test(error.message)
    );
    await service.call("permission", { sessionId: opened.sessionId, requestId: "perm-2", optionId: "allow-once" }, MAIN);

    const responses = (service.store.get(opened.sessionId)?.events ?? [])
      .filter((event) => event.type === "permission_response" || event.type === "elicitation_response")
      .map((event) => event.requestId);
    assert.deepEqual(responses, ["perm-1", "question-1", 77, "perm-2"]);
    const answered = (await service.call("inbox", { action: "list", status: "answered" }, MAIN)).items;
    assert.deepEqual(
      answered.map((item) => JSON.stringify(item.requestId)).sort(),
      ["\"perm-1\"", "\"perm-2\"", "\"question-1\"", "77"]
    );

    await release(client, "prompt");
    await waitForStatus(service, opened.sessionId, "idle");
  });
});

test("T8 a prompt is refused while a config set owns the session", async () => {
  await withService({ hold: "config" }, async (service) => {
    const opened = await open(service);
    const client = service.requireSession(opened.sessionId).client;

    const configuring = service.call(
      "config",
      { sessionId: opened.sessionId, action: "set", configId: "model", value: "race-pro" },
      MAIN
    );
    await waitForMarker(service, opened.sessionId, "hold:config");
    await assert.rejects(
      service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN),
      /still active/
    );
    assert.equal((await counters(client)).counters.prompt, undefined);

    await release(client, "config");
    const changed = await configuring;
    assert.equal(changed.changed.value, "race-pro");
    assert.equal(service.requireSession(opened.sessionId).model, "race-pro");
  });
});

test("T9 two commands needing the same worker back produce one session/resume", async () => {
  await withService({}, async (service) => {
    await open(service);
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;
    assert.equal(await service.unloadSession(session), true);

    // The prompt goes first: it reserves the session in its own tick, so a
    // later command cannot be admitted as if the session were still idle.
    const first = service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
    const second = service.call("config", { sessionId: opened.sessionId, action: "list" }, MAIN);
    await first;
    await second;

    assert.equal((await counters(client)).counters.resume, 1);
    assert.equal(eventsOfType(service, opened.sessionId, "session_restored").length, 1);
  });
});

test("T10 concurrent ensureConnected calls share one in-flight restore", async () => {
  await withService({}, async (service) => {
    await open(service);
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;
    assert.equal(await service.unloadSession(session), true);

    const both = await Promise.all([
      service.ensureConnected(session, MAIN),
      service.ensureConnected(session, MAIN)
    ]);
    assert.equal(both[0], session);
    assert.equal(both[1], session);
    assert.equal((await counters(client)).counters.resume, 1);
    assert.equal(session._restoring, null);
  });
});

test("T11 a worker that dies mid-close still leaves the session closed", async () => {
  await withService({ hold: "close" }, async (service) => {
    const opened = await open(service);
    const client = service.requireSession(opened.sessionId).client;

    const closing = service.call("session", { action: "close", sessionId: opened.sessionId }, MAIN);
    await waitForMarker(service, opened.sessionId, "hold:close");
    client.proc.kill("SIGKILL");
    await closing;

    // The old failure mode was a record stranded at "disconnected" whose inbox
    // had already been interrupted by the close that never finished.
    assert.equal(service.store.get(opened.sessionId), undefined);
    assert.equal(service.store.list().length, 0, "no record may survive as disconnected");
    await until(() => client.alive === false, "the client to notice the exit");
    // The provider-exit handler queued behind the close finds the record gone
    // and stays silent rather than resurrecting it.
    assert.equal(eventsOfType(service, opened.sessionId, "provider_disconnected").length, 0);
  });
});

test("T12 a worker death during a held config releases the reservation and the task", async () => {
  await withService({ hold: "config" }, async (service) => {
    const opened = await open(service);
    const client = service.requireSession(opened.sessionId).client;

    const task = service.call(
      "task_prompt",
      { sessionId: opened.sessionId, prompt: "one", model: "race-pro" },
      MAIN
    );
    await waitForMarker(service, opened.sessionId, "hold:config");
    assert.equal(service.requireSession(opened.sessionId)._reserved, "prompt");
    client.proc.kill("SIGKILL");
    await assert.rejects(task, /ACP|exited|cancelled|cleared|Transport|closed/);

    const session = service.requireSession(opened.sessionId);
    assert.equal(session._reserved, null, "a failed prompt must not wedge the session");
    assert.equal(session.activeTaskId, null);
    assert.equal((await service.call("task_list", {}, MAIN)).tasks.length, 0);
  });
});

test("T13 a permission request that arrives after a cancel is dropped", async () => {
  await withService({ hold: "prompt" }, async (service) => {
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
    await waitForMarker(service, opened.sessionId, "hold:prompt");
    await service.call("cancel", { sessionId: opened.sessionId }, MAIN);
    assert.equal(session.status, "cancelling");

    // Awaiting the reply proves the update line that preceded it was consumed.
    await client.request("test/emit", {
      sessionId: session.acpSessionId,
      update: {
        sessionUpdate: "permission_request",
        requestId: 4242,
        toolCall: { toolCallId: "late", title: "Edit", kind: "edit" },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
      }
    });

    assert.equal(session.status, "cancelling");
    const pending = await service.call("inbox", { action: "list", status: "pending" }, MAIN);
    assert.equal(
      pending.items.some((item) => item.requestId === 4242),
      false,
      "a notified cancel must not grow a new obligation"
    );
    await assert.rejects(
      service.call("permission", { sessionId: opened.sessionId, requestId: 4242, optionId: "allow-once" }, MAIN),
      /not waiting for permission/
    );
    await release(client, "prompt");
    await waitForStatus(service, opened.sessionId, "cancelled");
  });
});

test("T14 task bookkeeping and the turn it describes cannot disagree", async () => {
  await withService({ hold: "prompt" }, async (service) => {
    const opened = await open(service);
    const client = service.requireSession(opened.sessionId).client;
    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);

    const session = service.requireSession(opened.sessionId);
    assert.equal(task.turnId, session.turnId);
    assert.equal(task.status, "working");
    assert.equal(task.statusMessage, "Prompt running");

    await release(client, "prompt");
    await waitForStatus(service, opened.sessionId, "idle");

    const done = await service.call("task_get", { taskId: task.taskId }, MAIN);
    assert.equal(done.status, "completed");
    assert.equal(done.turnId, session.turnId);
    // The clobber this guards against turned a finished task back into
    // "working", so its result could never be collected.
    assert.notEqual(done.statusMessage, "Prompt running");
    const result = await service.call("task_result", { taskId: task.taskId }, MAIN);
    assert.equal(result.ok, true);
  });
});

test("T15 the prompt acknowledgement contract survives a concurrent prompt", async () => {
  await withService({ hold: "prompt" }, async (service) => {
    const opened = await open(service);
    const client = service.requireSession(opened.sessionId).client;

    const first = service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
    // Same tick as the first: the refusal cannot wait for a turn to appear.
    const second = service.call("prompt", { sessionId: opened.sessionId, prompt: "two" }, MAIN);
    await assert.rejects(second, /still active/);

    const ack = await first;
    assert.deepEqual(Object.keys(ack), ["ok", "sessionId", "turnId", "status"]);
    assert.equal(ack.ok, true);
    assert.equal(ack.sessionId, opened.sessionId);
    assert.equal(ack.status, "running");
    assert.match(ack.turnId, /^turn-/);
    assert.equal((await counters(client)).counters.prompt, 1);

    await release(client, "prompt");
    await waitForStatus(service, opened.sessionId, "idle");
  });
});

test("T16 the mailbox refuses work past its bound instead of growing without limit", async () => {
  await withService({ hold: "config" }, async (service) => {
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;

    const configuring = service.call(
      "config",
      { sessionId: opened.sessionId, action: "set", configId: "model", value: "race-pro" },
      MAIN
    );
    await waitForMarker(service, opened.sessionId, "hold:config");

    // Submitted without awaiting: the point is what the mailbox does while it
    // is already full, so nothing here may drain it first.
    const excess = 4;
    const submitted = [];
    for (let attempt = 0; attempt < SESSION_QUEUE_LIMIT + excess; attempt += 1) {
      submitted.push(settle(service.call("config", { sessionId: opened.sessionId, action: "list" }, MAIN)));
    }
    // The held config set owns the one slot the lists could not have.
    assert.equal(session._queue.depth, SESSION_QUEUE_LIMIT);

    await release(client, "config");
    await configuring;
    const outcomes = await Promise.all(submitted);
    const refused = outcomes.filter((outcome) => !outcome.ok);
    assert.equal(outcomes.length - refused.length, SESSION_QUEUE_LIMIT - 1);
    assert.equal(refused.length, excess + 1);
    for (const outcome of refused) {
      assert.match(outcome.error.message, /has too many queued commands/);
      assert.equal(outcome.error.code, "SESSION_ACTIVE");
    }
    assert.equal(session._queue.depth, 0);
  });
});

test("T16b a full external mailbox still accepts the worker terminal callback", async () => {
  await withService({ hold: "prompt" }, async (service) => {
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;
    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
    await waitForMarker(service, opened.sessionId, "hold:prompt");

    let releaseMailbox;
    const mailboxBlock = session._queue.run("test_block", () => new Promise((resolve) => {
      releaseMailbox = resolve;
    }));
    await until(() => typeof releaseMailbox === "function", "mailbox blocker to start");
    const queued = [];
    for (let attempt = 1; attempt < SESSION_QUEUE_LIMIT; attempt += 1) {
      queued.push(session._queue.run(`test_queued_${attempt}`, () => undefined));
    }
    assert.equal(session._queue.depth, SESSION_QUEUE_LIMIT);

    await release(client, "prompt");
    await until(() => session._queue.depth === SESSION_QUEUE_LIMIT + 1, "terminal callback reserve");
    releaseMailbox();
    await mailboxBlock;
    await Promise.all(queued);
    await waitForStatus(service, opened.sessionId, "idle");
    assert.equal((await service.call("task_get", { taskId: task.taskId }, MAIN)).status, "completed");
    assert.equal(eventsOfType(service, opened.sessionId, "turn_end").length, 1);
  });
});

test("T16c a full external mailbox still accepts provider exit", async () => {
  await withService({}, async (service) => {
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;
    await service.call("config", { sessionId: opened.sessionId, action: "list" }, MAIN);

    let releaseMailbox;
    const mailboxBlock = session._queue.run("test_block", () => new Promise((resolve) => {
      releaseMailbox = resolve;
    }));
    await until(() => typeof releaseMailbox === "function", "mailbox blocker to start");
    const queued = [];
    for (let attempt = 1; attempt < SESSION_QUEUE_LIMIT; attempt += 1) {
      queued.push(session._queue.run(`test_queued_${attempt}`, () => undefined));
    }
    assert.equal(session._queue.depth, SESSION_QUEUE_LIMIT);

    client.proc.kill("SIGKILL");
    await until(() => client.alive === false, "provider exit callback");
    assert.equal(session._queue.depth, SESSION_QUEUE_LIMIT + 1);
    releaseMailbox();
    await mailboxBlock;
    await Promise.all(queued);
    assert.equal(eventsOfType(service, opened.sessionId, "provider_disconnected").length, 1);
    assert.equal(session.status, "disconnected");
  });
});

// A command the mailbox holds until released, with no-ops queued behind it up
// to the limit: what Main's own commands can fill it with.
async function fillMailbox(session) {
  let release = null;
  const done = session._queue.run("test_block", () => new Promise((resolve) => {
    release = resolve;
  }));
  await until(() => typeof release === "function", "mailbox blocker to start");
  const queued = [];
  for (let attempt = 1; attempt < SESSION_QUEUE_LIMIT; attempt += 1) {
    queued.push(session._queue.run(`test_queued_${attempt}`, () => undefined));
  }
  assert.equal(session._queue.depth, SESSION_QUEUE_LIMIT);
  return { release: () => release(), drained: async () => { await done; await Promise.all(queued); } };
}

// A worker request the mailbox has no room for used to be dropped there while
// its RPC stayed registered: no inbox row for Main to answer, and a worker
// waiting on it for good. It is refused to the worker instead, at once.
test("T16d a worker request the mailbox cannot take is answered with an error at once, and none is left waiting", async () => {
  await withService({ hold: "prompt" }, async (service) => {
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
    await waitForMarker(service, opened.sessionId, "hold:prompt");
    const mailbox = await fillMailbox(session);

    // Six in one write, as a worker with parallel tool calls asks: the reserve
    // takes two, and the four the mailbox cannot hold are answered before the
    // reply to the burst itself is read.
    await client.request("test/burst", { sessionId: session.acpSessionId, count: 6 });
    const refused = (await client.request("test/answers")).answers;
    assert.equal(refused.length, 4);
    for (const answer of refused) {
      assert.equal(answer.result, null);
      assert.equal(answer.error.code, -32000);
      assert.match(answer.error.message, /has too many queued commands/);
    }
    assert.equal(session._queue.depth, SESSION_QUEUE_LIMIT + SESSION_CRITICAL_QUEUE_RESERVE);
    assert.equal(client.pendingSessionInput(session.acpSessionId).permissions, 2, "only what was queued waits for Main");

    mailbox.release();
    await mailbox.drained();
    await waitForStatus(service, opened.sessionId, "waiting_permission");
    const pending = (await service.call("inbox", { action: "list", status: "pending" }, MAIN)).items;
    assert.equal(pending.length, 2);
    for (const item of pending) {
      await service.call("permission", { sessionId: opened.sessionId, requestId: item.requestId, optionId: "allow-once" }, MAIN);
    }
    const answers = (await client.request("test/answers")).answers;
    assert.equal(answers.length, 6, "every request of the burst is answered");
    assert.equal(answers.filter((answer) => answer.result?.outcome?.optionId === "allow-once").length, 2);

    await release(client, "prompt");
    await waitForStatus(service, opened.sessionId, "idle");
  });
});

// Worker requests may take the reserve, never the turn's end or the provider's
// exit: one dropped there would leave the turn running for good.
test("T16e a mailbox whose reserve worker requests took still accepts the turn's end and the provider's exit", async () => {
  await withService({ hold: "prompt" }, async (service) => {
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
    await waitForMarker(service, opened.sessionId, "hold:prompt");
    const mailbox = await fillMailbox(session);
    await client.request("test/burst", { sessionId: session.acpSessionId, count: SESSION_CRITICAL_QUEUE_RESERVE + 1 });
    const full = SESSION_QUEUE_LIMIT + SESSION_CRITICAL_QUEUE_RESERVE;
    assert.equal(session._queue.depth, full);

    await release(client, "prompt");
    await until(() => session._queue.depth === full + 1, "the turn's end queued past the reserve");
    client.proc.kill("SIGKILL");
    await until(() => client.alive === false, "provider exit callback");
    assert.equal(session._queue.depth, full + 2);

    mailbox.release();
    await mailbox.drained();
    await waitForStatus(service, opened.sessionId, "disconnected");
    assert.equal(eventsOfType(service, opened.sessionId, "turn_end").length, 1);
    assert.equal(eventsOfType(service, opened.sessionId, "provider_disconnected").length, 1);
  });
});

// A worker request for a session the client does not serve, one it never
// opened or one already closed, was kept and announced to no one: no inbox row,
// no Main to answer it, a worker waiting on it for good, and nothing bounding
// how many were kept, since the session id is the worker's to choose.
test("T16f a worker request for a session the client does not serve is answered -32000 at once, and none is kept", async () => {
  await withService({}, async (service) => {
    const opened = await open(service);
    const closed = await open(service);
    const client = service.requireSession(opened.sessionId).client;
    const closedAcpId = service.requireSession(closed.sessionId).acpSessionId;
    await service.call("session", { action: "close", sessionId: closed.sessionId }, MAIN);
    await client.request("test/ask", { sessionId: "not-a-session", id: 1 });
    await client.request("test/ask", { sessionId: "not-a-session", id: 2, question: true });
    await client.request("test/ask", { sessionId: closedAcpId, id: 3 });
    const answers = (await client.request("test/answers")).answers;
    assert.deepEqual(answers.map(({ id, result, error }) => [id, result, error?.code, error?.message]), [
      [1, null, -32000, "Unknown ACP session: not-a-session"],
      [2, null, -32000, "Unknown ACP session: not-a-session"],
      [3, null, -32000, `Unknown ACP session: ${closedAcpId}`]
    ]);
    assert.equal(client.pendingPermissions.size + client.pendingElicitations.size, 0);
    assert.equal(service.inbox.size, 0);
  });
});

// One that arrived while a close waited on the worker was kept, and the close
// then cleared the session without answering it.
test("T16g a worker request a close leaves behind is answered when the session is cleared", async () => {
  await withService({ hold: "close" }, async (service) => {
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    const client = session.client;
    const closing = service.call("session", { action: "close", sessionId: opened.sessionId }, MAIN);
    await waitForMarker(service, opened.sessionId, "hold:close");
    await client.request("test/ask", { sessionId: session.acpSessionId, id: "late-1" });
    assert.equal(client.pendingSessionInput(session.acpSessionId).permissions, 1);
    await release(client, "close");
    await closing;
    assert.equal(client.pendingPermissions.size, 0);
    assert.deepEqual((await client.request("test/answers")).answers, [
      { id: "late-1", result: { outcome: { outcome: "cancelled" } }, error: null }
    ]);
  });
});

// The per-session limit bounds one session; spread over sessions, a provider's
// requests waiting for Main are bounded as a whole too.
test("T16h worker requests waiting for Main are bounded across a provider's sessions, not only per session", async () => {
  const client = new AcpClient(
    { provider: "mock", command: process.execPath, args: [raceAgent], permissionPolicy: "ask" },
    { maxPendingRequestsPerProvider: 3 }
  );
  try {
    await client.start();
    const sessions = [];
    for (let index = 0; index < 2; index += 1) {
      const { sessionId } = await client.sessionNew({ cwd: process.cwd(), permissionPolicy: "ask" });
      client.onSessionUpdate(sessionId, () => {});
      sessions.push(sessionId);
    }
    // Two in each session, each far under its own limit: the fourth is one
    // more than the provider may keep.
    for (const sessionId of sessions) await client.request("test/burst", { sessionId, count: 2 });
    const [refused, ...rest] = (await client.request("test/answers")).answers;
    assert.equal(rest.length, 0);
    assert.equal(refused.error.code, -32000);
    assert.equal(refused.error.message, "ACP provider pending request limit exceeded: 3");
    assert.equal(client.pendingPermissions.size, 3);
    // An answer makes room again.
    const [first] = client.pendingPermissions.keys();
    client.respondPermission(first, "allow-once", sessions[0]);
    await client.request("test/ask", { sessionId: sessions[1], id: "room" });
    assert.equal(client.pendingPermissions.has("room"), true);
  } finally {
    await client.stop();
  }
});

test("T17 shutdown drains in-flight commands and stops arming the persist timer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-race-shutdown-"));
  const statePath = join(directory, "state.json");
  const service = makeService({ hold: "prompt", statePath });
  try {
    // Opens the state; before 1.8.0 the v4 writer reached disk without it.
    await service.init();
    const opened = await open(service);
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "one" }, MAIN);
    await waitForMarker(service, opened.sessionId, "hold:prompt");
    const session = service.requireSession(opened.sessionId);

    await service.shutdown();

    assert.equal(service.stopped, true);
    assert.equal(service.persistTimer, null);
    assert.equal(session._queue.idle, true);

    // A callback landing after shutdown must not arm a writer behind the
    // final flush.
    service.schedulePersist();
    assert.equal(service.persistTimer, null);

    const persisted = await readSnapshotBody(statePath);
    assert.equal(persisted.sessions.length, 1);
    assert.equal(persisted.sessions[0].id, opened.sessionId);
    assert.equal(service.illegalTransitions, 0);
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("R1 a command that waits on its own mailbox fails loudly instead of deadlocking", async () => {
  await withService({}, async (service) => {
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);
    // Opening is not a queued command, and the mailbox is built on first use:
    // records made straight through the store must not need to know about it.
    assert.equal(session._queue, undefined);
    await service.call("config", { sessionId: opened.sessionId, action: "list" }, MAIN);
    const queue = session._queue;
    assert.ok(queue, "a queued command materializes the mailbox");

    // A silent deadlock at the only serialization point is the worst failure
    // this module can have, so re-entry is an error rather than a wait.
    await assert.rejects(
      queue.run("outer", () => queue.run("inner", () => true)),
      /re-entered by inner/
    );
    // The mailbox is still usable afterwards: one bad command does not poison it.
    assert.equal(await queue.run("after", () => "ok"), "ok");
    assert.equal(queue.idle, true);
  });
});

// Astra I10 (f613b8e): maintenance stopped every client no registered session
// referenced, and the client a provider's first session is being opened or
// restored on is one: the open lost its worker halfway.
test("R2 maintenance leaves a provider's client running while a session open or restore is still on it", async () => {
  for (const operation of ["open", "restore"]) {
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    let parked = null;
    const reached = new Promise((resolve) => { parked = resolve; });
    class GatedWorker extends FakeWorker {
      async sessionNew(...args) {
        if (operation === "open") { parked(); await gate; }
        return super.sessionNew(...args);
      }

      async sessionRestore(args) {
        if (operation === "restore") { parked(); await gate; }
        return super.sessionRestore(args);
      }
    }
    const workers = [];
    const service = new GatewayService({
      gcIntervalMs: 0,
      createClient: (_provider, options) => {
        workers.push(new GatedWorker(options));
        return workers.at(-1);
      }
    });
    try {
      const pending = settle(operation === "open"
        ? service.call("session_open", { provider: "claude", cwd: process.cwd() }, MAIN)
        : service.call("session_restore", { provider: "claude", cwd: process.cwd(), acpSessionId: "acp-earlier" }, MAIN));
      await Promise.race([reached, pending.then((outcome) => {
        throw new Error(`the ${operation} ended before it reached the worker: ${outcome.error?.message ?? "ok"}`);
      })]);
      await service.runMaintenance();
      assert.equal(workers.length, 1);
      assert.equal(workers[0].alive, true, `${operation}: its client is still running`);
      release();
      const outcome = await pending;
      assert.equal(outcome.ok, true, outcome.error?.message);
      assert.equal(service.requireSession(outcome.value.sessionId).client, workers[0]);
      // Held only while in flight: once nothing needs the client, it goes.
      await service.call("session", { action: "close", sessionId: outcome.value.sessionId }, MAIN);
      await service.runMaintenance();
      assert.equal(workers[0].alive, false, `${operation}: an unused client is still reclaimed`);
      assert.equal(service.clients.size, 0);
    } finally {
      release();
      await service.shutdown().catch(() => {});
    }
  }
});

test("T18 a full happy path violates no transition and seals exactly one turn", async () => {
  await withService({}, async (service) => {
    const opened = await open(service);
    const session = service.requireSession(opened.sessionId);

    const ack = await service.call("prompt", { sessionId: opened.sessionId, prompt: "chunk:hello" }, MAIN);
    await waitForStatus(service, opened.sessionId, "idle");
    assert.equal(session.turnSeal, ack.turnId);
    assert.equal(session.stopReason, "end_turn");

    const list = await service.call("config", { sessionId: opened.sessionId, action: "list" }, MAIN);
    assert.ok(list.configOptions.length > 0);
    await service.call("cancel", { sessionId: opened.sessionId }, MAIN);
    assert.equal(session.status, "idle", "cancelling a finished turn changes nothing");

    const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "two" }, MAIN);
    await waitForStatus(service, opened.sessionId, "idle");
    assert.equal((await service.call("task_get", { taskId: task.taskId }, MAIN)).status, "completed");

    await service.call("session", { action: "close", sessionId: opened.sessionId }, MAIN);
    assert.equal(service.store.get(opened.sessionId), undefined);
    // Closing twice is the same as closing once.
    await assert.rejects(
      service.call("session", { action: "close", sessionId: opened.sessionId }, MAIN),
      /Unknown sessionId/
    );
    assert.equal(session._illegalTransitions ?? 0, 0);
  });
});
