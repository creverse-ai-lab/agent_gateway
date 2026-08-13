#!/usr/bin/env node

// Serialized response size for the Main-facing flows that dominate token cost.
// Everything runs in-process against the mock ACP agent with a fixed clock, so
// repeated runs on one machine produce identical byte counts and a payload
// regression shows up as a delta against the checked-in baseline.
//
// setup_no_provider is the one machine-dependent flow: it embeds locally
// detected providers and home-relative command paths.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { GatewayService } from "../src/gateway-service.js";
import { GATEWAY_VERSION } from "../src/version.js";

// Provider files configured on the developer's machine would change the setup
// payload; the benchmark measures the built-in surface only.
process.env.ACP_GATEWAY_DISABLE_DYNAMIC_PROVIDERS ??= "1";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE_PATH = resolve(root, "test/fixtures/payload-baseline.json");
const MOCK_AGENT = resolve(root, "test/mock-agent.js");
const MAIN = { rootId: "main-bench" };
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");

export const FLOW_NAMES = Object.freeze([
  "empty_active_poll",
  "active_poll_permission",
  "idle_poll_result",
  "setup_no_provider",
  "inbox_list_one_permission",
  "task_get",
  // 1.4.0 PR 7. The first six keep taking zero arguments so their numbers stay
  // comparable across releases; these five are what the new arguments cost or
  // save on exactly the same fixtures.
  "compact_poll",
  "compact_poll_permission",
  "setup_summary",
  "run_terminal",
  "inbox_summary_spilled"
]);

const NOTES = Object.freeze([
  "Sizes are Buffer.byteLength(JSON.stringify(response)) for one call.",
  "setup_no_provider depends on locally detected providers and home path length.",
  "setup_summary is machine-independent: the detected-provider block is what makes setup_no_provider vary.",
  "run_terminal is the full CallToolResult (content + structuredContent + isError), so it measures the duplication cost the 1.5.0 discussion needs."
]);

// The front door sends content and structuredContent for the same object. This
// is that envelope, measured rather than argued about.
function toolResultBytes(data) {
  return payloadBytes({
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    isError: data.ok === false
  });
}

export async function measurePayloads() {
  const artifactRoot = await mkdtemp(join(tmpdir(), "acp-bench-artifacts-"));
  const measured = {};
  let clock = EPOCH;
  const now = () => clock;
  try {
    const fabricated = new GatewayService({ gcIntervalMs: 0, artifactRoot, now });
    try {
      const session = fabricated.store.create({
        provider: "mock", acpSessionId: "bench-session", cwd: "/", ownerRootId: MAIN.rootId,
        permissionPolicy: "ask", turnId: "turn-bench"
      });
      session.status = "running";
      fabricated.handleUpdate(session, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Working on it. " }
      });
      fabricated.handleUpdate(session, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "checking the repository layout" }
      });
      fabricated.handleUpdate(session, {
        sessionUpdate: "tool_call",
        toolCallId: "tool-bench-1",
        title: "Read file",
        kind: "read"
      });
      measured.empty_active_poll = payloadBytes(
        await fabricated.call("poll", { sessionId: session.id, cursor: 0 }, MAIN)
      );
      measured.compact_poll = payloadBytes(
        await fabricated.call("poll", { sessionId: session.id, cursor: 0, responseProfile: "compact" }, MAIN)
      );
      fabricated.handleUpdate(session, {
        sessionUpdate: "permission_request",
        requestId: 1,
        toolCall: { toolCallId: "tool-bench-2", title: "Edit file", kind: "edit" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      });
      measured.active_poll_permission = payloadBytes(
        await fabricated.call("poll", { sessionId: session.id, cursor: 0 }, MAIN)
      );
      measured.compact_poll_permission = payloadBytes(
        await fabricated.call("poll", { sessionId: session.id, cursor: 0, responseProfile: "compact" }, MAIN)
      );
      measured.inbox_list_one_permission = payloadBytes(
        await fabricated.call("inbox", { action: "list" }, MAIN)
      );
      // A row whose tool call overflowed the payload cap: 1.3.2 inlined the whole
      // thing, PR 5 replaced it with a pointer, and summary drops the fields a
      // list view never reads.
      //
      // The clock has to move first. Inbox order is (createdAt DESC, inboxId
      // DESC), and the tiebreaker is a random UUID: with a frozen clock the two
      // rows tie and the "newest" one alternates between runs.
      clock += 1_000;
      fabricated.handleUpdate(session, {
        sessionUpdate: "permission_request",
        requestId: 2,
        toolCall: { toolCallId: "tool-bench-3", title: "Edit file", kind: "edit", rawInput: "r".repeat(10_000) },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }]
      });
      measured.inbox_summary_spilled = payloadBytes(
        await fabricated.call("inbox", { action: "list", limit: 1, detail: "summary" }, MAIN)
      );
    } finally {
      await fabricated.shutdown().catch(() => {});
    }

    const live = new GatewayService({
      gcIntervalMs: 0,
      artifactRoot,
      now,
      createClient: (_provider, options) =>
        new AcpClient(
          { provider: "mock", command: process.execPath, args: [MOCK_AGENT], permissionPolicy: "read_only" },
          options
        )
    });
    try {
      const opened = await live.call(
        "session_open",
        { provider: "claude", cwd: "/", permissionPolicy: "read_only" },
        MAIN
      );
      const task = await live.call(
        "task_prompt",
        { sessionId: opened.sessionId, prompt: "narrated-result" },
        MAIN
      );
      await waitForIdle(live, opened.sessionId);
      measured.idle_poll_result = payloadBytes(
        await live.call("poll", { sessionId: opened.sessionId, cursor: 0 }, MAIN)
      );
      measured.task_get = payloadBytes(await live.call("task_get", { taskId: task.taskId }, MAIN));
      // One whole delegated turn as the model actually receives it.
      measured.run_terminal = toolResultBytes(
        await live.call("run", { sessionId: opened.sessionId, prompt: "narrated-result", waitMs: 15_000 }, MAIN)
      );
    } finally {
      await live.shutdown().catch(() => {});
    }

    // A fresh service keeps the setup payload free of accumulated poll metrics.
    const fresh = new GatewayService({ gcIntervalMs: 0, artifactRoot, now });
    try {
      measured.setup_no_provider = payloadBytes(await fresh.call("setup", {}, MAIN));
      measured.setup_summary = payloadBytes(await fresh.call("setup", { mode: "summary" }, MAIN));
    } finally {
      await fresh.shutdown().catch(() => {});
    }
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
  const missing = FLOW_NAMES.filter((name) => !Number.isInteger(measured[name]));
  if (missing.length) throw new Error(`payload benchmark missed flows: ${missing.join(", ")}`);
  return Object.fromEntries(FLOW_NAMES.map((name) => [name, measured[name]]));
}

export function buildReport(flows, baseline = null) {
  const baselineFlows = baseline?.flows ?? null;
  return {
    gatewayVersion: GATEWAY_VERSION,
    flows,
    baseline: baselineFlows,
    deltaPct: baselineFlows
      ? Object.fromEntries(Object.keys(flows).map((name) => [name, percentDelta(baselineFlows[name], flows[name])]))
      : null,
    notes: [...NOTES]
  };
}

export async function readBaseline(path = BASELINE_PATH) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeBaseline(flows, path = BASELINE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ gatewayVersion: GATEWAY_VERSION, flows }, null, 2)}\n`);
  return path;
}

function percentDelta(before, after) {
  if (!Number.isFinite(before) || before === 0 || !Number.isFinite(after)) return null;
  return Number((((after - before) / before) * 100).toFixed(2));
}

function payloadBytes(response) {
  return Buffer.byteLength(JSON.stringify(response));
}

async function waitForIdle(service, sessionId) {
  let cursor = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const poll = await service.call("poll", { sessionId, cursor, waitMs: 100 }, MAIN);
    cursor = poll.nextCursor;
    if (poll.status === "idle") return poll;
    if (["error", "unavailable"].includes(poll.status)) throw new Error(poll.error);
  }
  throw new Error("benchmark session did not become idle");
}

// The benchmark is a report, never a gate: it always exits 0 so CI can print
// the numbers without blocking a release on a byte count.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const flows = await measurePayloads();
    const report = buildReport(flows, await readBaseline());
    if (process.argv.slice(2).includes("--write-baseline")) {
      report.baselineWritten = await writeBaseline(flows);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error?.message ?? String(error) }, null, 2)}\n`);
    process.exit(1);
  }
  process.exit(0);
}
