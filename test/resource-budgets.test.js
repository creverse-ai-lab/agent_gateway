import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { readTextHead, readTextLines, trimIncompleteUtf8 } from "../src/bounded-utf8.js";
import { ERROR_CODES } from "../src/errors.js";
import { GatewayService } from "../src/gateway-service.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const capabilityAgent = fileURLToPath(new URL("./mock-capability-agent.js", import.meta.url));
const MAIN = { rootId: "main-a" };

async function withDirectory(prefix, run) {
  const directory = await mkdtemp(join(tmpdir(), `acp-budget-${prefix}-`));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const isCode = (code) => (error) => error?.code === code;

test("an incomplete UTF-8 tail is removed rather than decoded to a replacement character", () => {
  const smile = Buffer.from("🙂", "utf8");
  assert.equal(smile.length, 4);
  for (let keep = 1; keep < 4; keep += 1) {
    const cut = trimIncompleteUtf8(smile.subarray(0, keep));
    assert.equal(cut.length, 0, `a ${keep}-byte prefix of a 4-byte character keeps nothing`);
  }
  assert.equal(trimIncompleteUtf8(smile).length, 4);
  assert.equal(trimIncompleteUtf8(Buffer.from("ok", "utf8")).toString("utf8"), "ok");
  assert.equal(trimIncompleteUtf8(Buffer.alloc(0)).length, 0);
});

test("a bounded head read cuts on a character boundary, never mid-character", async () => {
  await withDirectory("head", async (directory) => {
    const path = join(directory, "cjk.txt");
    // Three bytes per character, so no cap that is not a multiple of three can be
    // honoured without backing up.
    await writeFile(path, "가".repeat(4_000), "utf8");
    for (const cap of [1, 2, 3, 1_000, 1_001, 1_002, 5_000]) {
      const read = await readTextHead(path, cap);
      assert.equal(read.truncated, true, `cap=${cap}`);
      assert.equal(read.text.includes("�"), false, `cap=${cap} produced a replacement character`);
      assert.equal(read.bytes % 3, 0, `cap=${cap} cut mid-character`);
      assert.ok(read.bytes <= cap);
      assert.equal(read.text, "가".repeat(read.bytes / 3));
    }
    // A file that fits is returned whole and reports no truncation.
    const whole = await readTextHead(path, 12_000);
    assert.equal(whole.truncated, false);
    assert.equal(whole.bytes, 12_000);
    assert.equal(whole.text.length, 4_000);
  });
});

test("the streaming line window matches split-and-join for every shape", async () => {
  await withDirectory("window", async (directory) => {
    const path = join(directory, "lines.txt");
    const text = "α\nbb\n\nccc\n한글 line\nlast";
    await writeFile(path, text, "utf8");
    const lines = text.split("\n");
    for (const line of [1, 2, 3, 4, 5, 6, 7, 20]) {
      for (const limit of [0, 1, 2, 3, 100]) {
        const expected = lines.slice(line - 1, line - 1 + limit).join("\n");
        const read = await readTextLines(path, { line, limit });
        assert.equal(read.text, expected, `line=${line} limit=${limit}`);
        assert.equal(read.truncated, false);
      }
    }
  });
});

test("a line window deep in a large file is read in one pass and respects the byte cap", async () => {
  await withDirectory("window-large", async (directory) => {
    const path = join(directory, "big-lines.txt");
    const lines = Array.from({ length: 200_000 }, (_, index) => `line-${index}`);
    await writeFile(path, lines.join("\n"), "utf8");
    // Crosses many 64KB read buffers, and nothing proportional to the skipped
    // prefix is ever allocated.
    const read = await readTextLines(path, { line: 150_001, limit: 3 });
    assert.equal(read.text, "line-150000\nline-150001\nline-150002");
    assert.equal(read.truncated, false);
    const capped = await readTextLines(path, { line: 150_001, limit: 1_000, maxBytes: 40 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.bytes, 40);
    assert.equal(capped.text, "line-150000\nline-150001\nline-150002\nline");
    // A window that ends exactly at the cap is complete, not truncated.
    const exact = await readTextLines(path, { line: 1, limit: 1, maxBytes: 6 });
    assert.equal(exact.text, "line-0");
    assert.equal(exact.truncated, false);
  });
});

// The plateau claim, on a real file: no sparse tricks and no /dev/zero, because
// both let a filesystem lie about the bytes a read has to move.
test("reading a 64MB file costs the cap, not the file", async (t) => {
  if (process.env.CI) {
    t.skip("writes 64MB; skipped where the disk is shared with other jobs");
    return;
  }
  await withDirectory("plateau", async (directory) => {
    const path = join(directory, "huge.txt");
    const megabyte = `${"x".repeat(1_000_000 - 1)}\n`;
    const chunks = [];
    for (let index = 0; index < 64; index += 1) chunks.push(megabyte);
    await writeFile(path, chunks.join(""), "utf8");
    assert.equal((await stat(path)).size, 64_000_000);
    // First read outside the measurement: it is what warms the buffers.
    await readTextHead(path, 500_000);
    global.gc?.();
    const before = process.memoryUsage();
    let bytes = 0;
    for (let round = 0; round < 4; round += 1) {
      const read = await readTextHead(path, 500_000);
      assert.equal(read.truncated, true);
      bytes += read.bytes;
      const window = await readTextLines(path, { line: 40, limit: 2, maxBytes: 500_000 });
      bytes += window.bytes;
    }
    const after = process.memoryUsage();
    // Proof the reads were real work: each round moved the cap twice, once as a
    // head read and once as a window.
    assert.equal(bytes, 4 * (500_000 + 500_000));
    const heapDelta = after.heapUsed - before.heapUsed;
    const externalDelta = after.external - before.external;
    assert.ok(heapDelta < 16 * 1024 * 1024, `heap grew by ${heapDelta} bytes reading a 64MB file`);
    assert.ok(externalDelta < 16 * 1024 * 1024, `external grew by ${externalDelta} bytes`);
  });
});

test("an oversized file read is truncated with a _meta record, and a small one is untouched", async () => {
  await withDirectory("read-meta", async (directory) => {
    await writeFile(join(directory, "big.txt"), "z".repeat(2_000_000), "utf8");
    await writeFile(join(directory, "small.txt"), "just enough", "utf8");
    await writeFile(join(directory, "lines.txt"), Array.from({ length: 50 }, (_, i) => `row-${i}`).join("\n"), "utf8");
    const client = new AcpClient(
      { provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "auto_approve" },
      { permissionPolicy: "auto_approve" }
    );
    try {
      await client.start();
      const session = await client.sessionNew({ cwd: directory, permissionPolicy: "auto_approve" });
      const ask = async (mode) => JSON.parse(
        (await client.sessionPrompt({ sessionId: session.sessionId, prompt: mode })).stopReason
      );

      const big = await ask("read-file:big.txt");
      assert.equal(big.bytes, 500_000, "the cap is bytes now, not UTF-16 code units");
      assert.deepEqual(big.keys, ["_meta", "content"]);
      assert.deepEqual(big.meta["acp-gateway/read"], {
        truncated: true, bytes: 500_000, fileBytes: 2_000_000, maxBytes: 500_000
      });

      // Byte-identical to every previous version: no _meta key at all.
      const small = await ask("read-file:small.txt");
      assert.deepEqual(small.keys, ["content"]);
      assert.equal(small.meta, null);
      assert.equal(small.bytes, 11);

      const windowed = await ask("read-file:lines.txt:3:2");
      assert.deepEqual(windowed.keys, ["content"]);
      assert.equal(windowed.head, "row-2\nrow-3");
      assert.equal(windowed.bytes, 11);
    } finally {
      await client.stop();
    }
  });
});

test("a terminal output clamp is a knob with the value it always had", async () => {
  const client = new AcpClient(
    { provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" },
    { permissionPolicy: "read_only" }
  );
  assert.equal(client.maxTerminalOutputBytes, 10_000_000);
  assert.equal(client.maxFileReadBytes, 500_000);
  const tightened = new AcpClient(
    { provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" },
    { permissionPolicy: "read_only", maxTerminalOutputBytes: 4_096, maxFileReadBytes: 64 }
  );
  assert.equal(tightened.maxTerminalOutputBytes, 4_096);
  assert.equal(tightened.maxFileReadBytes, 64);
});

test("setup reports every budget as a flat number", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const limits = (await service.setup()).resourceLimits;
    for (const [key, value] of Object.entries(limits)) {
      assert.equal(typeof value, "number", `${key} must stay a flat number`);
    }
    assert.equal(limits.maxQueueBytes, 4_000_000);
    assert.equal(limits.writeTimeoutMs, 10_000);
    assert.equal(limits.maxPromptBytes, 1_000_000);
    assert.equal(limits.maxFileReadBytes, 500_000);
    assert.equal(limits.maxTerminalOutputBytes, 10_000_000);
    assert.equal(limits.maxSessionsPerRoot, 64);
    assert.equal(limits.maxInboxHistoryPerRoot, 1_000);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("an oversized prompt is refused in admission, before a turn exists", async () => {
  await withDirectory("prompt", async (directory) => {
    const service = new GatewayService({
      gcIntervalMs: 0,
      maxPromptBytes: 1_000,
      artifactRoot: join(directory, "artifacts")
    });
    try {
      const session = service.store.create({
        provider: "mock", acpSessionId: "prompt-budget", cwd: "/", ownerRootId: "main-a",
        permissionPolicy: "ask"
      });
      await assert.rejects(
        service.call("prompt", { sessionId: session.id, prompt: "p".repeat(2_000) }, MAIN),
        isCode(ERROR_CODES.PROMPT_TOO_LARGE)
      );
      // Nothing was reserved and no turn was minted: the refusal happened before
      // either could exist.
      assert.equal(session.turnId, null);
      assert.ok(!session._reserved);
      await assert.rejects(
        service.call("prompt", { sessionId: session.id, prompt: [{ type: "text", text: "q".repeat(2_000) }] }, MAIN),
        isCode(ERROR_CODES.PROMPT_TOO_LARGE)
      );
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("a root cannot hold more sessions than its budget", async () => {
  await withDirectory("sessions", async (directory) => {
    // The capability agent mints a new session id per session/new, which is what
    // this test needs; the plain mock agent reuses one.
    const makeClient = (_provider, options) => new AcpClient(
      { provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "read_only" },
      options
    );
    const service = new GatewayService({
      gcIntervalMs: 0,
      createClient: makeClient,
      maxSessionsPerRoot: 2,
      artifactRoot: join(directory, "artifacts")
    });
    try {
      const open = () => service.call(
        "session_open",
        { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" },
        MAIN
      );
      const first = await open();
      await open();
      await assert.rejects(open(), isCode(ERROR_CODES.SESSION_LIMIT_EXCEEDED));
      // Another Main has its own allowance.
      await service.call(
        "session_open",
        { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" },
        { rootId: "main-b" }
      );
      // And closing one frees a slot.
      await service.call("session", { action: "close", sessionId: first.sessionId }, MAIN);
      assert.equal((await open()).ok, true);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("resolved inbox history is evicted oldest first while pending rows are untouchable", async () => {
  await withDirectory("inbox-history", async (directory) => {
    const service = new GatewayService({
      gcIntervalMs: 0,
      maxInboxHistoryPerRoot: 3,
      artifactRoot: join(directory, "artifacts")
    });
    try {
      const session = service.store.create({
        provider: "mock", acpSessionId: "inbox-budget", cwd: "/", ownerRootId: "main-a",
        permissionPolicy: "ask", turnId: "turn-1"
      });
      session.status = "running";
      for (let index = 0; index < 6; index += 1) {
        service.handleUpdate(session, {
          sessionUpdate: "permission_request",
          requestId: index,
          toolCall: { toolCallId: `tool-${index}`, title: "Edit", kind: "edit" },
          options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
        });
        session.status = "running";
      }
      const rows = [...service.inbox.values()];
      assert.equal(rows.length, 6);
      // Five answered at increasing times, one left as an obligation.
      rows.slice(0, 5).forEach((row, index) => {
        row.status = "answered";
        row.resolution = "allowed";
        // Recent, so age-based retention has no opinion and the count bound is
        // what does the evicting.
        row.resolvedAt = new Date(Date.now() - (5 - index) * 1_000).toISOString();
      });
      await service.runMaintenance();
      const kept = [...service.inbox.values()];
      assert.equal(kept.length, 4, "three resolved rows plus the untouchable pending one");
      assert.equal(kept.filter((row) => row.status === "pending").length, 1);
      const survivors = kept.filter((row) => row.status === "answered").map((row) => row.requestId).sort();
      assert.deepEqual(survivors, [2, 3, 4], "the oldest resolved rows go first");
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

// The GC bug the design flags: an inbox row outlives the event it came from, so the
// artifact behind an oversized tool call must be reachable from the row itself.
test("an artifact a pending inbox row points at survives the retention sweep", async () => {
  await withDirectory("inbox-gc", async (directory) => {
    const service = new GatewayService({ gcIntervalMs: 0, artifactRoot: join(directory, "artifacts") });
    try {
      const session = service.store.create({
        provider: "mock", acpSessionId: "inbox-gc", cwd: "/", ownerRootId: "main-a",
        permissionPolicy: "ask", turnId: "turn-1"
      });
      session.status = "running";
      service.handleUpdate(session, {
        sessionUpdate: "permission_request",
        requestId: 1,
        toolCall: { toolCallId: "tool-big", title: "Edit", kind: "edit", rawInput: "r".repeat(10_000) },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
      });
      const row = [...service.inbox.values()][0];
      assert.equal(row.status, "pending");
      const artifactPath = row.toolCallArtifact.path;
      assert.equal(JSON.parse(await readFile(artifactPath, "utf8")).rawInput.length, 10_000);
      // Push the permission event out of the 200-entry ring, so the artifact is
      // reachable only through the inbox row.
      for (let index = 0; index < 260; index += 1) {
        service.handleUpdate(session, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `filler-${index}` }
        });
      }
      assert.equal(
        session.events.some((event) => event.type === "permission_request"),
        false,
        "the event that wrote the artifact is gone from the ring"
      );
      // A sweep far past the retention window: without the inbox walk in keepPaths
      // this is where the artifact disappears under an unanswered request.
      await service.runMaintenance(Date.now() + 25 * 60 * 60_000);
      assert.equal(JSON.parse(await readFile(artifactPath, "utf8")).rawInput.length, 10_000);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("a small elicitation row stays fully inline", async () => {
  await withDirectory("elicitation", async (directory) => {
    const service = new GatewayService({ gcIntervalMs: 0, artifactRoot: join(directory, "artifacts") });
    try {
      const session = service.store.create({
        provider: "mock", acpSessionId: "elicit", cwd: "/", ownerRootId: "main-a",
        permissionPolicy: "ask", turnId: "turn-1"
      });
      session.status = "running";
      const requestedSchema = { type: "object", properties: { choice: { type: "string" } } };
      service.handleUpdate(session, {
        sessionUpdate: "elicitation_request",
        requestId: 3,
        mode: "form",
        message: "Which one?",
        requestedSchema,
        toolCallId: "tool-1"
      });
      const row = (await service.call("inbox", { action: "list" }, MAIN)).items[0];
      assert.equal(row.type, "worker_question");
      assert.equal(row.message, "Which one?");
      assert.deepEqual(row.requestedSchema, requestedSchema);
      assert.equal(row.messageTruncated, undefined);
      assert.equal(row.requestedSchemaTruncated, undefined);

      // An oversized schema is the one that becomes a pointer.
      session.status = "running";
      service.handleUpdate(session, {
        sessionUpdate: "elicitation_request",
        requestId: 4,
        mode: "form",
        message: "m".repeat(9_000),
        requestedSchema: { type: "object", description: "d".repeat(9_000) },
        toolCallId: "tool-2"
      });
      const big = (await service.call("inbox", { action: "list" }, MAIN))
        .items.find((item) => item.requestId === 4);
      assert.equal(big.requestedSchemaTruncated, true);
      assert.ok(big.requestedSchemaBytes > 9_000);
      assert.equal(typeof big.requestedSchemaArtifact.path, "string");
      assert.equal(big.requestedSchema, undefined);
      assert.equal(big.messageTruncated, true);
      assert.equal(big.messageBytes, 9_000);
      assert.ok(Buffer.byteLength(big.message) <= 4_000);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});
