// PR 7 acceptance: agent_acp_run, the response profiles, the inbox page, the
// per-turn result budget, and the compatibility gates that keep an old skill
// talking to this gateway byte-for-byte.
//
// T1..T11 map to the design's test register; each test names its own.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, RELATED_TASK_META_KEY } from "@modelcontextprotocol/sdk/types.js";
import { AcpClient } from "../src/acp-client.js";
import { GatewayService } from "../src/gateway-service.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { daemonPaths, startDaemon, writeMockProviders } from "./helpers/daemon-harness.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MAIN = { rootId: "main-a" };
// The inherited current-profile byte counts for flows an old skill produces.
// PR 5 intentionally added bounded Inbox metadata, so the gate freezes the
// immediate parent rather than pretending that additive field never shipped.
const INHERITED_CURRENT_BYTES = { empty_active_poll: 483, active_poll_permission: 814, inbox_list_one_permission: 527 };

test("T1: agent_acp_run and tasks/result return the same envelope, byte for byte", async () => {
  const service = new GatewayService({ createClient: mockClient("read_only"), gcIntervalMs: 0 });
  try {
    const opened = await open(service);
    const ran = await service.call(
      "run",
      { sessionId: opened.sessionId, prompt: "narrated-result", waitMs: 15_000 },
      MAIN
    );
    assert.equal(ran.ok, true);
    assert.equal(ran.result.text, "FINAL ANSWER");
    assert.equal(typeof ran.taskId, "string");

    const fetched = await service.call("task_result", { taskId: ran.taskId }, MAIN);
    // Exact, on the same taskId, with no normalization: both paths end at
    // taskResult(), so identity is structural rather than maintained.
    assert.deepEqual(ran, fetched);
    assert.equal(JSON.stringify(ran), JSON.stringify(fetched));
    // isError is derived from the same field on both front-door paths.
    assert.equal(ran.ok === false, fetched.ok === false);

    // The handle is a real Task: listed, and marked with the tool that made it.
    const listed = await service.call("task_list", {}, MAIN);
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].origin, "run");
    assert.equal(listed.tasks[0].status, "completed");
    const prompted = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, MAIN);
    assert.equal(prompted.origin, "prompt");
    await waitForIdle(service, opened.sessionId);
    // H5: the prompt-mode envelope carries taskId too, so one rule covers both.
    assert.equal((await service.call("task_result", { taskId: prompted.taskId }, MAIN)).taskId, prompted.taskId);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("T2: a run that hits a permission hands control back and never prompts twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-run-permission-"));
  const log = join(directory, "prompts.ndjson");
  process.env.ACP_MOCK_PROMPT_LOG = log;
  const service = new GatewayService({
    createClient: mockClient("ask"),
    gcIntervalMs: 0,
    artifactRoot: join(directory, "artifacts")
  });
  try {
    const opened = await open(service, "ask");
    const waiting = await service.call(
      "run",
      { sessionId: opened.sessionId, prompt: "block", waitMs: 15_000 },
      MAIN
    );
    // Not an error and not a result: the request cannot be answered from inside
    // the call that is blocked on it, so control comes back with the obligation.
    assert.equal(waiting.ok, true);
    assert.equal(waiting.status, "input_required");
    assert.equal(waiting.pending.type, "permission_request");
    assert.equal(waiting.next.answerWith, "agent_acp_permission");
    assert.deepEqual(waiting.next.thenAttach, { tool: "agent_acp_run", arguments: { taskId: waiting.taskId } });
    assert.ok(Array.isArray(waiting.pending.options) && waiting.pending.options.length > 0);
    assert.equal(await promptCount(log), 1);

    await service.call(
      "permission",
      { sessionId: opened.sessionId, requestId: waiting.pending.requestId, optionId: "allow-once" },
      MAIN
    );
    // Attach mode carries no prompt at all, so a re-attach is structurally
    // incapable of starting the work a second time.
    const done = await service.call("run", { taskId: waiting.taskId, waitMs: 15_000 }, MAIN);
    assert.equal(done.ok, true);
    assert.equal(done.taskId, waiting.taskId);
    assert.match(done.result.text, /DONE/);
    assert.equal(await promptCount(log), 1, "one ACP prompt for the whole run");
  } finally {
    delete process.env.ACP_MOCK_PROMPT_LOG;
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("T3: the idempotency key covers the window admission cannot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-run-idempotent-"));
  const log = join(directory, "prompts.ndjson");
  process.env.ACP_MOCK_PROMPT_LOG = log;
  const service = new GatewayService({
    createClient: mockClient("read_only"),
    gcIntervalMs: 0,
    artifactRoot: join(directory, "artifacts")
  });
  try {
    const opened = await open(service);
    const first = await service.call(
      "run",
      { sessionId: opened.sessionId, prompt: "narrated-result", waitMs: 15_000, idempotencyKey: "unit-of-work-1" },
      MAIN
    );
    assert.equal(await promptCount(log), 1);
    // The gap: the turn has finished, so the session is idle and admission would
    // happily accept a second prompt. Without the key this is a double run.
    assert.equal((await service.call("poll", { sessionId: opened.sessionId, cursor: 0 }, MAIN)).status, "idle");
    const retried = await service.call(
      "run",
      { sessionId: opened.sessionId, prompt: "narrated-result", waitMs: 15_000, idempotencyKey: "unit-of-work-1" },
      MAIN
    );
    assert.equal(retried.taskId, first.taskId, "the retry attached instead of re-prompting");
    assert.equal(await promptCount(log), 1, "TRIPWIRE: a second ACP prompt means the key stopped working");
    assert.equal(JSON.stringify(retried), JSON.stringify(first));

    // A different key is different work.
    const other = await service.call(
      "run",
      { sessionId: opened.sessionId, prompt: "narrated-result", waitMs: 15_000, idempotencyKey: "unit-of-work-2" },
      MAIN
    );
    assert.notEqual(other.taskId, first.taskId);
    assert.equal(await promptCount(log), 2);

    // Start and attach are mutually exclusive, so the shape itself cannot carry
    // both a handle and a prompt.
    await assert.rejects(
      service.call("run", { taskId: first.taskId, sessionId: opened.sessionId, prompt: "again" }, MAIN),
      (error) => {
        assert.equal(error.code, "INVALID_ARGUMENT");
        return true;
      }
    );
  } finally {
    delete process.env.ACP_MOCK_PROMPT_LOG;
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("T3b: an idempotency key survives a daemon restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-run-idempotent-restart-"));
  const log = join(directory, "prompts.ndjson");
  const statePath = join(directory, "state.json");
  process.env.ACP_MOCK_PROMPT_LOG = log;
  let service = new GatewayService({
    statePath,
    createClient: mockClient("read_only"),
    gcIntervalMs: 0,
    artifactRoot: join(directory, "artifacts")
  });
  try {
    await service.init();
    const opened = await open(service);
    const first = await service.call(
      "run",
      { sessionId: opened.sessionId, prompt: "narrated-result", waitMs: 15_000, idempotencyKey: "durable-unit" },
      MAIN
    );
    await service.shutdown();

    service = new GatewayService({
      statePath,
      createClient: mockClient("read_only"),
      gcIntervalMs: 0,
      artifactRoot: join(directory, "artifacts")
    });
    await service.init();
    const retried = await service.call(
      "run",
      { sessionId: opened.sessionId, prompt: "narrated-result", waitMs: 15_000, idempotencyKey: "durable-unit" },
      MAIN
    );
    assert.equal(retried.taskId, first.taskId);
    assert.equal(await promptCount(log), 1, "restart retry attached to the durable task instead of prompting again");
  } finally {
    delete process.env.ACP_MOCK_PROMPT_LOG;
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("T3c: an expired durable key starts a new run after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-run-idempotent-expiry-"));
  const log = join(directory, "prompts.ndjson");
  const statePath = join(directory, "state.json");
  process.env.ACP_MOCK_PROMPT_LOG = log;
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  let service = new GatewayService({
    statePath,
    now: () => clock,
    createClient: mockClient("read_only"),
    gcIntervalMs: 0,
    artifactRoot: join(directory, "artifacts")
  });
  try {
    await service.init();
    const opened = await open(service);
    const first = await service.call(
      "run",
      {
        sessionId: opened.sessionId,
        prompt: "narrated-result",
        waitMs: 15_000,
        ttl: 10,
        idempotencyKey: "expires"
      },
      MAIN
    );
    await service.shutdown();

    service = new GatewayService({
      statePath,
      now: () => clock,
      createClient: mockClient("read_only"),
      gcIntervalMs: 0,
      artifactRoot: join(directory, "artifacts")
    });
    await service.init();
    clock += 11;
    const retried = await service.call(
      "run",
      { sessionId: opened.sessionId, prompt: "narrated-result", waitMs: 15_000, idempotencyKey: "expires" },
      MAIN
    );
    assert.notEqual(retried.taskId, first.taskId);
    assert.equal(await promptCount(log), 2);
  } finally {
    delete process.env.ACP_MOCK_PROMPT_LOG;
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("T4: the profiles are a containment chain, not three independent shapes", async () => {
  // Frozen clock: this test compares two responses byte for byte, and
  // lastOwnerActivityAt moves between calls on a live one.
  const service = new GatewayService({ gcIntervalMs: 0, now: () => Date.parse("2026-01-01T00:00:00.000Z") });
  try {
    const session = service.store.create({
      provider: "mock", acpSessionId: "profiles", cwd: "/", ownerRootId: "main-a",
      permissionPolicy: "ask", turnId: "turn-1"
    });
    session.status = "running";
    service.handleUpdate(session, {
      sessionUpdate: "permission_request",
      requestId: 3,
      toolCall: { toolCallId: "tool-1", title: "Edit file", kind: "edit" },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
    });

    const current = await service.call("poll", { sessionId: session.id, cursor: 0 }, MAIN);
    const compact = await service.call("poll", { sessionId: session.id, cursor: 0, responseProfile: "compact" }, MAIN);
    const diagnostic = await service.call(
      "poll", { sessionId: session.id, cursor: 0, responseProfile: "diagnostic" }, MAIN
    );

    // Set relations instead of a combinatorial golden per profile.
    for (const key of Object.keys(compact)) {
      assert.ok(Object.hasOwn(current, key), `compact key ${key} must exist in current`);
    }
    for (const key of Object.keys(current)) {
      assert.ok(Object.hasOwn(diagnostic, key), `current key ${key} must exist in diagnostic`);
    }
    assert.deepEqual(
      Object.keys(diagnostic).filter((key) => !Object.hasOwn(current, key)).sort(),
      ["illegalTransitions", "pending", "queue"]
    );
    // Explicit "current" is the same object as no argument at all.
    assert.equal(
      JSON.stringify(await service.call("poll", { sessionId: session.id, cursor: 0, responseProfile: "current" }, MAIN)),
      JSON.stringify(current)
    );
    // compact drops the whole session envelope and every zero-valued field.
    assert.deepEqual(Object.keys(compact), ["ok", "sessionId", "turnId", "status", "nextCursor", "events"]);
    assert.equal(Object.hasOwn(compact, "cursorTruncated"), false, "false is not worth a key");
    assert.equal(Object.hasOwn(compact, "filteredCount"), false, "zero is not worth a key");
    assert.ok(
      Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(current)) * 0.62,
      "compact must actually be compact"
    );
    // diagnostic is capped: it must never become the biggest payload in the system.
    assert.ok(
      Buffer.byteLength(JSON.stringify(diagnostic)) < Buffer.byteLength(JSON.stringify(current)) * 3,
      "diagnostic stays within 3x of current"
    );
    assert.equal(diagnostic.queue.reserved, null);
    assert.deepEqual(diagnostic.pending, { permissions: 0, elicitations: 0 });

    // An unknown profile is refused loudly. A typo must not read as a downgrade.
    await assert.rejects(
      service.call("poll", { sessionId: session.id, cursor: 0, responseProfile: "compakt" }, MAIN),
      (error) => {
        assert.equal(error.code, "INVALID_ARGUMENT");
        return true;
      }
    );
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("T4b: compact moves stopReason into the result and keeps the terminal answer", async () => {
  const service = new GatewayService({ createClient: mockClient("read_only"), gcIntervalMs: 0 });
  try {
    const opened = await open(service);
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, MAIN);
    await waitForIdle(service, opened.sessionId);
    const compact = await service.call(
      "poll", { sessionId: opened.sessionId, cursor: 0, responseProfile: "compact" }, MAIN
    );
    assert.equal(compact.status, "idle");
    assert.equal(compact.result.text, "FINAL ANSWER");
    assert.equal(compact.result.stopReason, "end_turn");
    // An active turn has no stop reason, which is the reason it moved inside.
    assert.equal(Object.hasOwn(compact, "stopReason"), false);
    // Null artifacts are simply absent.
    assert.equal(Object.hasOwn(compact.result, "artifact"), false);
    assert.equal(Object.hasOwn(compact.result, "usageSummary"), false, "usage stays opt-in even in compact");
    const withUsage = await service.call(
      "poll", { sessionId: opened.sessionId, cursor: 0, responseProfile: "compact", includeUsage: true }, MAIN
    );
    assert.deepEqual(Object.keys(withUsage.result.usageSummary).sort(), ["session", "turn"]);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("T5: a caller that sends no new arguments keeps the inherited current profile byte for byte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-frozen-bytes-"));
  const service = new GatewayService({ gcIntervalMs: 0, artifactRoot: join(directory, "artifacts") });
  try {
    const session = service.store.create({
      provider: "mock", acpSessionId: "bench-session", cwd: "/", ownerRootId: MAIN.rootId,
      permissionPolicy: "ask", turnId: "turn-bench"
    });
    session.status = "running";
    service.handleUpdate(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it. " } });
    service.handleUpdate(session, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checking the repository layout" } });
    service.handleUpdate(session, { sessionUpdate: "tool_call", toolCallId: "tool-bench-1", title: "Read file", kind: "read" });
    assert.equal(
      bytes(await service.call("poll", { sessionId: session.id, cursor: 0 }, MAIN)),
      INHERITED_CURRENT_BYTES.empty_active_poll
    );
    service.handleUpdate(session, {
      sessionUpdate: "permission_request",
      requestId: 1,
      toolCall: { toolCallId: "tool-bench-2", title: "Edit file", kind: "edit" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" }
      ]
    });
    assert.equal(
      bytes(await service.call("poll", { sessionId: session.id, cursor: 0 }, MAIN)),
      INHERITED_CURRENT_BYTES.active_poll_permission
    );
    // The unpaged inbox keeps {ok, items} and never grows a nextCursor.
    const listed = await service.call("inbox", { action: "list" }, MAIN);
    assert.deepEqual(Object.keys(listed), ["ok", "items"]);
    assert.equal(bytes(listed), INHERITED_CURRENT_BYTES.inbox_list_one_permission);
    // Filtering without paging is still an unpaged response.
    assert.deepEqual(
      Object.keys(await service.call("inbox", { action: "list", status: "pending" }, MAIN)),
      ["ok", "items"]
    );
    // The prompt acknowledgement is untouched: no taskId, no new fields.
    const setup = await service.call("setup", {}, MAIN);
    assert.equal(Object.hasOwn(setup, "staleFrontDoor"), false);
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("T6: capability is declared, never probed", async () => {
  const service = new GatewayService({ createClient: mockClient("read_only"), gcIntervalMs: 0 });
  try {
    // The trap: an old gateway ignores an unknown argument silently, so a
    // compact request comes back FULL with no error to notice. This gateway
    // reproduces that indistinguishability on purpose — omitting the argument
    // and being ignored look identical on the wire.
    const opened = await open(service);
    const withoutProfile = await service.call("poll", { sessionId: opened.sessionId, cursor: 0 }, MAIN);
    assert.ok(Object.hasOwn(withoutProfile, "acpSessionId"), "no profile means the full session envelope");
    assert.ok(Object.hasOwn(withoutProfile, "cursorTruncated"));

    // Which is why support has to be declared. Both surfaces carry it, and
    // session_open is the hot-path one: no extra round trip to learn it.
    const setup = await service.call("setup", {}, MAIN);
    assert.deepEqual(setup.responseProfiles, ["current", "compact", "diagnostic"]);
    assert.deepEqual(opened.responseProfiles, ["current", "compact", "diagnostic"]);
    assert.equal(opened.gatewayApiVersion, 1);
    assert.deepEqual((await service.call("setup", { mode: "summary" }, MAIN)).responseProfiles, setup.responseProfiles);

    // The same rule for the tool itself: run is discovered from the tool list,
    // and its absence is the signal to fall back to prompt + poll.
    const { readFile: read } = await import("node:fs/promises");
    const frontDoor = await read(fileURLToPath(new URL("../src/index.js", import.meta.url)), "utf8");
    assert.match(frontDoor, /name: "agent_acp_run"/);
    // A gateway that has run also answers the method; one without it says so
    // with a stable code rather than hanging or half-working.
    await assert.rejects(service.call("no_such_method", {}, MAIN), (error) => {
      assert.equal(error.code, "UNKNOWN_METHOD");
      return true;
    });
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("T7: inbox keyset pages survive inserts between pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-inbox-page-"));
  let clock = Date.parse("2026-02-01T00:00:00.000Z");
  const service = new GatewayService({
    gcIntervalMs: 0, artifactRoot: join(directory, "artifacts"), now: () => clock
  });
  try {
    const session = service.store.create({
      provider: "mock", acpSessionId: "page", cwd: "/", ownerRootId: "main-a",
      permissionPolicy: "ask", turnId: "turn-1"
    });
    session.status = "running";
    // Five rows on the SAME millisecond: the tiebreaker is what makes the page
    // boundary total. A createdAt-only cursor skips or repeats here.
    for (let index = 0; index < 5; index += 1) {
      service.handleUpdate(session, {
        sessionUpdate: "permission_request",
        requestId: index + 1,
        toolCall: { toolCallId: `tool-${index}`, title: "Edit file", kind: "edit" },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
      });
    }
    await waitForInboxCount(service, 5);
    const first = await service.call("inbox", { action: "list", limit: 2 }, MAIN);
    assert.equal(first.items.length, 2);
    assert.equal(typeof first.nextCursor, "string");

    // A new obligation arrives between pages. Keyset paging must not shift the
    // window under the reader.
    clock += 1_000;
    service.handleUpdate(session, {
      sessionUpdate: "permission_request",
      requestId: 99,
      toolCall: { toolCallId: "tool-late", title: "Edit file", kind: "edit" },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
    });
    await waitForInboxCount(service, 6);

    const seen = first.items.map((item) => item.inboxId);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await service.call("inbox", { action: "list", limit: 2, cursor }, MAIN);
      for (const item of page.items) seen.push(item.inboxId);
      cursor = page.nextCursor;
    }
    assert.equal(new Set(seen).size, seen.length, "no row is delivered twice");
    assert.equal(seen.length, 5, "the late insert sorts ahead of the cursor and is not resurrected");
    // The last page says null rather than omitting the key: one shape per page.
    const single = await service.call("inbox", { action: "list", limit: 100 }, MAIN);
    assert.equal(single.nextCursor, null);
    assert.equal(single.items.length, 6);

    // detail:summary is a key projection of the same row, not a third shape.
    const summary = await service.call("inbox", { action: "list", limit: 1, detail: "summary" }, MAIN);
    const full = await service.call("inbox", { action: "list", limit: 1 }, MAIN);
    assert.deepEqual(
      Object.keys(summary.items[0]),
      Object.keys(full.items[0]).filter((key) => !["options", "message", "requestedSchema"].includes(key))
    );
    assert.deepEqual(Object.keys(summary.items[0].toolCall).sort(), ["kind", "title", "toolCallId"]);
    assert.ok(bytes(summary) < bytes(full));

    // Filters compose with paging.
    const filtered = await service.call(
      "inbox", { action: "list", limit: 10, sessionId: session.id, type: "permission_request" }, MAIN
    );
    assert.equal(filtered.items.length, 6);
    assert.equal(
      (await service.call("inbox", { action: "list", limit: 10, type: "worker_question" }, MAIN)).items.length,
      0
    );
    await assert.rejects(
      service.call("inbox", { action: "list", cursor: "not-a-cursor!!" }, MAIN),
      (error) => {
        assert.equal(error.code, "INVALID_ARGUMENT");
        return true;
      }
    );
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("T8: the result budget truncates once and spills once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-budget-"));
  const artifactRoot = join(directory, "artifacts");
  const service = new GatewayService({ createClient: mockClient("read_only"), gcIntervalMs: 0, artifactRoot });
  try {
    const opened = await open(service);
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "large-result" }, MAIN);
    await waitForIdle(service, opened.sessionId);

    const plain = await service.call("poll", { sessionId: opened.sessionId, cursor: 0 }, MAIN);
    const full = plain.result.text;
    assert.ok(Buffer.byteLength(full) > 128);
    // Default path: no budget keys at all.
    assert.equal(Object.hasOwn(plain.result, "totalBytes"), false);
    assert.equal(Object.hasOwn(plain.result, "omittedBytes"), false);

    const budgeted = await service.call(
      "poll", { sessionId: opened.sessionId, cursor: 0, resultBudgetBytes: 128 }, MAIN
    );
    // The head is bounded by BYTES and never splits a character: this answer is
    // 3-byte glyphs, so it lands just under the budget rather than on it.
    const head = Buffer.byteLength(budgeted.result.text);
    assert.ok(head <= 128 && head > 120, `head ${head} must fill the budget without splitting a character`);
    assert.equal(budgeted.result.totalBytes, Buffer.byteLength(full));
    assert.equal(budgeted.result.omittedBytes, Buffer.byteLength(full) - head);
    assert.ok(budgeted.result.textArtifact?.path, "a truncated answer always keeps a pointer to the whole one");
    // totalBytes is this answer; transcriptBytes is the whole narration.
    assert.equal(budgeted.result.totalBytes, Buffer.byteLength(full));

    const again = await service.call(
      "poll", { sessionId: opened.sessionId, cursor: 0, resultBudgetBytes: 128 }, MAIN
    );
    assert.deepEqual(again.result.textArtifact, budgeted.result.textArtifact, "spill once, then reuse");
    const spills = (await readdir(artifactRoot, { recursive: true }))
      .filter((entry) => entry.includes("result-final"));
    assert.equal(spills.length, 1, "one artifact per answer, not one per poll");
    assert.equal(
      (await readFile(budgeted.result.textArtifact.path, "utf8")).length,
      full.length,
      "the pointer holds the complete answer"
    );

    // A budgeted read must not change what the next default read returns.
    const afterwards = await service.call("poll", { sessionId: opened.sessionId, cursor: 0 }, MAIN);
    assert.equal(JSON.stringify(afterwards.result), JSON.stringify(plain.result));

    // delivery:"artifact" is the whole answer through the pointer.
    const pointer = await service.call(
      "poll", { sessionId: opened.sessionId, cursor: 0, resultDelivery: "artifact" }, MAIN
    );
    assert.equal(pointer.result.text, "");
    assert.equal(pointer.result.omittedBytes, pointer.result.totalBytes);
    assert.ok(pointer.result.textArtifact.path);

    // On a task, the budget is stated when the work is submitted, because the
    // envelope is built by a turn callback with no caller present.
    const task = await service.call(
      "run",
      { sessionId: opened.sessionId, prompt: "large-result", waitMs: 15_000, resultBudgetBytes: 64, responseProfile: "compact" },
      MAIN
    );
    assert.ok(Buffer.byteLength(task.result.text) <= 64);
    assert.ok(task.result.omittedBytes > 0);
    assert.ok(task.result.textArtifact.path);
    assert.equal(
      JSON.stringify(task),
      JSON.stringify(await service.call("task_result", { taskId: task.taskId }, MAIN)),
      "a budgeted run is still identical to its tasks/result"
    );
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("T8b: budgets use the complete artifact and never reuse a prior turn's spill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-budget-authoritative-"));
  const service = new GatewayService({
    createClient: mockClient("read_only"),
    gcIntervalMs: 0,
    artifactRoot: join(directory, "artifacts"),
    maxInlineResultBytes: 64
  });
  try {
    const opened = await open(service);
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "large-result" }, MAIN);
    await waitForIdle(service, opened.sessionId);
    const firstSession = service.requireSession(opened.sessionId);
    assert.ok(firstSession.resultFinalArtifact?.bytes > Buffer.byteLength(firstSession.resultFinalText));

    const budgeted = await service.call(
      "poll", { sessionId: opened.sessionId, cursor: 0, resultBudgetBytes: 128 }, MAIN
    );
    assert.equal(budgeted.result.totalBytes, firstSession.resultFinalArtifact.bytes);
    assert.ok(Buffer.byteLength(budgeted.result.text) > Buffer.byteLength(firstSession.resultFinalText));
    assert.equal(
      budgeted.result.omittedBytes,
      budgeted.result.totalBytes - Buffer.byteLength(budgeted.result.text)
    );
    const firstPath = budgeted.result.textArtifact.path;

    await service.call("prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, MAIN);
    await waitForIdle(service, opened.sessionId);
    const second = await service.call(
      "poll", { sessionId: opened.sessionId, cursor: 0, resultBudgetBytes: 4 }, MAIN
    );
    assert.notEqual(second.result.textArtifact.path, firstPath);
    assert.equal(await readFile(second.result.textArtifact.path, "utf8"), "FINAL ANSWER");
    await assert.rejects(
      service.call("poll", { sessionId: opened.sessionId, resultBudgetBytes: 65_537 }, MAIN),
      /0 to 65536/
    );
  } finally {
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("T9: setup summary and session_open carry exactly the bind-time facts", async () => {
  const service = new GatewayService({ createClient: mockClient("read_only"), gcIntervalMs: 0 });
  try {
    const full = await service.call("setup", {}, MAIN);
    const summary = await service.call("setup", { mode: "summary" }, MAIN);
    assert.deepEqual(Object.keys(summary), [
      "ok", "gatewayVersion", "gatewayApiVersion", "stateSchemaVersion", "responseProfiles",
      "persistence", "alerts", "providers", "liveSessions"
    ]);
    assert.deepEqual(Object.keys(summary.persistence), ["healthy", "error"]);
    assert.equal(summary.liveSessions, 0);
    // The gate is expressed against the SAME build's full setup, never against a
    // historic byte count: PR 4 and PR 5 grew full setup, and summary is what
    // pays that back.
    assert.ok(
      bytes(summary) <= bytes(full) * 0.2,
      `summary ${bytes(summary)}B must be within 20% of full ${bytes(full)}B`
    );
    // Machine dependence lives in `detected`, which summary omits.
    assert.equal(Object.hasOwn(summary, "detected"), false);
    await assert.rejects(service.call("setup", { mode: "brief" }, MAIN), (error) => {
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    });

    const opened = await open(service);
    assert.equal(typeof opened.gatewayVersion, "string");
    assert.deepEqual(Object.keys(opened.limits), [
      "maxPromptBytes", "maxInlineResultBytes", "resultRetentionMs", "sessionRetentionMs", "taskRetentionMs"
    ]);
    assert.equal(opened.limits.maxPromptBytes, 1_000_000);
    assert.deepEqual(opened.relevantAlerts, []);
    assert.equal(Object.hasOwn(opened, "alertsOmitted"), false);
    // Persistence health is deliberately NOT repeated here: it fails a task
    // closed and raises an alert, and one fact on two channels drifts.
    assert.equal(Object.hasOwn(opened, "persistence"), false);

    // The filter keeps what a session must know and drops the rest. Exercised
    // through the projection directly: the mock agent mints one ACP session id,
    // so a second session_open is a duplicate registration by construction.
    service.recordStateAlert({ code: "DOWNGRADE_DETECTED", message: "downgrade" });
    service.recordStateAlert({ code: "acp_registry_stale", message: "not this session's problem" });
    service.recordStateAlert({ level: "error", code: "whatever", message: "errors always ride" });
    service.recordStateAlert({ code: "acp_agent_update_failed", provider: "claude", message: "this provider" });
    const facts = service.bindTimeFacts(service.store.get(opened.sessionId));
    assert.deepEqual(
      facts.relevantAlerts.map((alert) => alert.code),
      ["DOWNGRADE_DETECTED", "whatever", "acp_agent_update_failed"]
    );
    assert.equal(Object.hasOwn(facts, "alertsOmitted"), false);
    for (let index = 0; index < 4; index += 1) {
      service.recordStateAlert({ level: "error", code: `flood-${index}`, message: "x" });
    }
    const flooded = service.bindTimeFacts(service.store.get(opened.sessionId));
    assert.equal(flooded.relevantAlerts.length, 3);
    assert.equal(flooded.alertsOmitted, 4);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("T10: a run attached after a crash reports a failed envelope, never an unknown task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-run-crash-"));
  let daemon = null;
  let client = null;
  try {
    const providers = await writeMockProviders(directory, { permissionPolicy: "read_only" });
    daemon = await startDaemon({
      directory,
      env: { ...providers, ACP_GATEWAY_CRASH_AFTER: "task_create_durable" }
    });
    client = connect(daemon);
    const opened = await client.call("session_open", { provider: "mock", cwd: tmpdir(), permissionPolicy: "read_only" });
    // The daemon dies between the durable create and the ACP turn, so the caller
    // never receives the taskId that is nevertheless on disk.
    await assert.rejects(client.call("run", { sessionId: opened.sessionId, prompt: "narrated-result", waitMs: 5_000 }));
    await daemon.waitForExit();
    client.close();

    daemon = await startDaemon({ directory, env: providers });
    client = connect(daemon);
    const tasks = (await client.call("task_list")).tasks;
    assert.equal(tasks.length, 1, "the durable handle survived");
    assert.equal(tasks[0].origin, "run", "origin survives the restart");
    assert.equal(tasks[0].status, "failed");
    // The point of the test: attaching returns the failed OUTCOME, not
    // UNKNOWN_TASK. A phantom handle would be the worse failure.
    const attached = await client.call("run", { taskId: tasks[0].taskId, waitMs: 5_000 });
    assert.equal(attached.ok, false);
    assert.match(attached.error, /Gateway restarted/);
    assert.equal(
      JSON.stringify(attached),
      JSON.stringify(await client.call("task_result", { taskId: tasks[0].taskId }))
    );
  } finally {
    client?.close();
    await daemon?.killHard().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("T11: abandoning the wait does not cancel the turn; cancel does", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-run-abandon-"));
  const log = join(directory, "prompts.ndjson");
  process.env.ACP_MOCK_PROMPT_LOG = log;
  const service = new GatewayService({
    createClient: mockClient("ask"),
    gcIntervalMs: 0,
    artifactRoot: join(directory, "artifacts")
  });
  try {
    const opened = await open(service, "ask");
    // A wait short enough to run out while the worker is still blocked on a
    // permission. This is the abandoned wait: the turn is mid-flight when the
    // call returns, and the call returns anyway.
    const handoff = await service.call(
      "run", { sessionId: opened.sessionId, prompt: "block", waitMs: 1 }, MAIN
    );
    assert.equal(handoff.ok, true, "a wait running out is never an error");
    assert.ok(["working", "input_required"].includes(handoff.status));
    assert.equal(typeof handoff.taskId, "string");
    await waitForPending(service, opened.sessionId);
    assert.equal(await promptCount(log), 1);

    // The worker is untouched: answering the request it is still waiting on
    // lets the same turn finish normally. The wait ran out on OUR budget, so the
    // request may still be in flight when it returns.
    const pending = await waitForPending(service, opened.sessionId);
    await service.call(
      "permission", { sessionId: opened.sessionId, requestId: pending.requestId, optionId: "allow-once" }, MAIN
    );
    const collected = await service.call("run", { taskId: handoff.taskId, waitMs: 15_000 }, MAIN);
    assert.equal(collected.ok, true);
    assert.match(collected.result.text, /DONE/);
    assert.equal(collected.result.stopReason, "end_turn", "abandoning a wait did not cancel the turn");
    assert.equal(await promptCount(log), 1);

    // Cancelling is the instruction that does stop the turn — a different verb
    // for a different intention.
    const second = await service.call(
      "run", {
        sessionId: opened.sessionId,
        prompt: "block",
        waitMs: 1,
        responseProfile: "compact",
        resultBudgetBytes: 2
      }, MAIN
    );
    assert.equal(second.ok, true);
    await waitForPending(service, opened.sessionId);
    assert.equal(await promptCount(log), 2);
    await waitForPending(service, opened.sessionId);
    await service.call("task_cancel", { taskId: second.taskId }, MAIN);
    const cancelled = await service.call("task_result", { taskId: second.taskId }, MAIN);
    assert.equal(cancelled.taskId, second.taskId);
    assert.equal(cancelled.result.stopReason, "cancelled");
    assert.equal(Buffer.byteLength(cancelled.result.text), 2);
    assert.equal(cancelled.result.totalBytes, 6);
    assert.equal(cancelled.result.omittedBytes, 4);
    assert.equal(cancelled.result.textArtifact.complete, true);
  } finally {
    delete process.env.ACP_MOCK_PROMPT_LOG;
    await service.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("T1b: through the real front door, the run CallToolResult IS the tasks/result one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-run-frontdoor-"));
  let daemon = null;
  let mcpClient = null;
  try {
    const providers = await writeMockProviders(directory, { permissionPolicy: "read_only" });
    daemon = await startDaemon({ directory, env: providers });
    mcpClient = new Client({ name: "pr7-run", version: "1.0.0" });
    await mcpClient.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
      stderr: "pipe",
      env: {
        ...process.env,
        ACP_GATEWAY_SOCKET: daemon.socketPath,
        ACP_GATEWAY_CONTROL_TOKEN: daemon.token,
        ACP_GATEWAY_ROOT_ID: daemon.rootId,
        ...providers
      }
    }));

    // The tool has to be discoverable: an older gateway's front door does not
    // list it, which is the fallback signal the skill reads.
    const tools = (await mcpClient.listTools()).tools;
    const run = tools.find((tool) => tool.name === "agent_acp_run");
    const prompt = tools.find((tool) => tool.name === "agent_acp_prompt");
    assert.ok(run, "agent_acp_run must be in the live tool list");
    assert.deepEqual(run.execution, { taskSupport: "optional" });
    assert.equal(prompt.execution, undefined, "the acknowledgement-only prompt tool is not task-capable");
    assert.equal(Object.hasOwn(prompt.inputSchema.properties, "resultBudgetBytes"), false);

    const opened = await mcpClient.callTool({
      name: "agent_acp_session_open",
      arguments: { provider: "mock", cwd: directory, permissionPolicy: "read_only" }
    });
    const sessionId = opened.structuredContent.sessionId;
    assert.deepEqual(opened.structuredContent.responseProfiles, ["current", "compact", "diagnostic"]);
    // Same build on both sides of the socket, so there is nothing to warn about.
    assert.equal(Object.hasOwn(opened.structuredContent, "staleFrontDoor"), false);

    const ran = await mcpClient.callTool({
      name: "agent_acp_run",
      arguments: { sessionId, prompt: "narrated-result", waitMs: 20_000 }
    });
    assert.equal(ran.isError, false);
    assert.equal(ran.structuredContent.result.text, "FINAL ANSWER");
    const taskId = ran.structuredContent.taskId;
    assert.match(taskId, /^task-/);
    assert.deepEqual(ran._meta?.[RELATED_TASK_META_KEY], { taskId });
    // content duplicates structuredContent, which the parent-link detection in
    // downstream consumers depends on.
    assert.equal(ran.content[0].text, JSON.stringify(ran.structuredContent));

    const payload = await mcpClient.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
    // The whole CallToolResult, not just the envelope: same content, same
    // structuredContent, same isError, same _meta.
    assert.deepEqual(payload, ran);

    const listed = await mcpClient.experimental.tasks.listTasks();
    assert.deepEqual(listed.tasks.map((task) => task.taskId), [taskId]);
    // The SDK's TaskSchema is closed: it keeps only the six spec fields and
    // strips everything else, which is why origin (like sessionId, turnId and
    // pollInterval before it) is a gateway-API field and not an MCP tasks/*
    // one. The handle is still the same handle.
    assert.equal(listed.tasks[0].origin, undefined);
    assert.equal(listed.tasks[0].status, "completed");
  } finally {
    await mcpClient?.close().catch(() => {});
    await daemon?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

function mockClient(permissionPolicy) {
  return (_provider, options) =>
    new AcpClient(
      { provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy },
      options
    );
}

function connect(daemon) {
  return new GatewayRpcClient({
    socketPath: daemon.socketPath,
    token: daemon.token,
    rootId: daemon.rootId,
    statePath: daemonPaths(daemon.directory ?? "").statePath || daemon.statePath,
    autoStart: false
  });
}

function open(service, permissionPolicy = "read_only") {
  return service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy }, MAIN);
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

async function promptCount(path) {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).length;
}

async function waitForPending(service, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const items = (await service.call("inbox", { action: "list", status: "pending" }, MAIN)).items
      .filter((item) => item.sessionId === sessionId);
    if (items.length) return items[0];
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("no pending worker request arrived");
}

async function waitForInboxCount(service, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const items = (await service.call("inbox", { action: "list", status: "pending" }, MAIN)).items;
    if (items.length === expected) return items;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`inbox did not reach ${expected} items`);
}

async function waitForIdle(service, sessionId) {
  let cursor = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const poll = await service.call("poll", { sessionId, cursor, waitMs: 100 }, MAIN);
    cursor = poll.nextCursor;
    if (poll.status === "idle") return poll;
    if (["error", "unavailable"].includes(poll.status)) throw new Error(poll.error);
  }
  throw new Error("session did not become idle");
}
