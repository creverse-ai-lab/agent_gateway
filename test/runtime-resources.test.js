// 1.8.0 U7: what the daemon holds while it runs (text buffers, installer
// subprocesses, reply frames, tool-event artifacts, poll waiters) stays bounded by
// what it is for, not by how long the daemon runs or how a worker chunks its
// output. The transport half of P5 is in ndjson-channel and socket-flow tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { AgentUpdateManager } from "../src/agent-updates.js";
import { ArtifactStore } from "../src/artifacts.js";
import { BoundedUtf8Text } from "../src/bounded-utf8.js";
import { ERROR_CODES } from "../src/errors.js";
import { GatewayService } from "../src/gateway-service.js";
import { parseInstallerArgs, runCommand } from "../src/installer.js";
import { GatewaySettings } from "../src/settings.js";
import { decodeRecord, statePaths } from "../src/state-store.js";
import { runInstaller } from "./helpers/installer.js";
import { processGone } from "./helpers/scratch.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MAIN = { rootId: "main-a" };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A child that never exits on its own.
const HANG = "setInterval(() => {}, 1000)";

async function withDirectory(name, run) {
  const directory = await mkdtemp(join(tmpdir(), `acp-resources-${name}-`));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function until(predicate, description) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function directSession(service, id, ownerRootId = "main-a") {
  const session = service.store.create({
    provider: "mock", acpSessionId: id, cwd: "/", ownerRootId, permissionPolicy: "ask", turnId: "turn-1"
  });
  session.status = "running";
  return session;
}

// The pid a test child wrote to path, or null if it has not written one yet.
// The file exists a moment before the pid is in it, so waiting on existsSync
// alone could kill the child first and leave an empty file to read.
async function pidIn(path) {
  if (!existsSync(path)) return null;
  const pid = Number(await readFile(path, "utf8"));
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

// ------------------------------------------------------------- P3: text tails

// The accumulator as it was through 1.7.x, kept as the behavioral reference:
// 1.8.0 changed what it keeps alive, never what it returns or hands to onTrim.
class ReferenceText {
  constructor(maxBytes, { onTrim = null } = {}) {
    this.maxBytes = maxBytes;
    this.onTrim = onTrim;
    this.chunks = [];
    this.head = 0;
    this.totalBytes = 0;
    this.trimmedBytes = 0;
    this.pendingHighSurrogate = "";
    this.pendingBytes = 0;
  }

  append(text) {
    if (text == null || text === "") return;
    let value = this.pendingHighSurrogate + String(text);
    this.pendingHighSurrogate = "";
    this.pendingBytes = 0;
    const lastCodeUnit = value.charCodeAt(value.length - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      this.pendingHighSurrogate = value.at(-1);
      this.pendingBytes = Buffer.byteLength(this.pendingHighSurrogate, "utf8");
      value = value.slice(0, -1);
    }
    const chunk = Buffer.from(value, "utf8");
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.totalBytes += chunk.length;
    }
    this.#trim();
  }

  reset(text = "") {
    this.chunks = [];
    this.head = 0;
    this.totalBytes = 0;
    this.trimmedBytes = 0;
    this.pendingHighSurrogate = "";
    this.pendingBytes = 0;
    this.append(text);
  }

  toString() {
    const liveChunks = this.chunks.length - this.head;
    if (liveChunks === 0) return "";
    if (liveChunks > 1) this.chunks = [Buffer.concat(this.chunks.slice(this.head), this.totalBytes)];
    else if (this.head > 0) this.chunks = [this.chunks[this.head]];
    this.head = 0;
    return this.chunks[0].toString("utf8");
  }

  #trim() {
    while (this.totalBytes + this.pendingBytes > this.maxBytes && this.head < this.chunks.length) {
      const front = this.chunks[this.head];
      const excess = this.totalBytes + this.pendingBytes - this.maxBytes;
      if (front.length <= excess) {
        this.onTrim?.(front);
        this.totalBytes -= front.length;
        this.trimmedBytes += front.length;
        this.head += 1;
        continue;
      }
      let start = excess;
      while (start < front.length && (front[start] & 0xc0) === 0x80) start += 1;
      this.onTrim?.(front.subarray(0, start));
      this.totalBytes -= start;
      this.trimmedBytes += start;
      this.chunks[this.head] = front.subarray(start);
    }
    if (this.totalBytes + this.pendingBytes > this.maxBytes) {
      if (this.pendingHighSurrogate) this.onTrim?.(Buffer.from(this.pendingHighSurrogate, "utf8"));
      this.trimmedBytes += this.pendingBytes;
      this.pendingHighSurrogate = "";
      this.pendingBytes = 0;
    }
  }
}

test("BoundedUtf8Text returns, counts and evicts exactly what the 1.7 accumulator did", () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  // Tiny tokens, multi-byte text, surrogate halves split across appends, a lone
  // low surrogate, and pieces on both sides of the shared-block threshold.
  const pieces = [
    "a", "bc", "é", "한", "😀", "\uD83D", "\uDE00", "\uDC00", "xyz".repeat(50),
    "é".repeat(700), "z".repeat(5_000), "😀".repeat(1_500), "q".repeat(20_000)
  ];
  for (let trial = 0; trial < 300; trial += 1) {
    // 0 is no longer seeded here: the constructor now rejects a bound below 1
    // (F3), and the reference accumulator does not, so the two cannot be built
    // alike with it. Production never built one with 0; 1 exercises the same
    // evict-everything path.
    const maxBytes = pick([1, 3, 4, 9, 32, 255, 4_096, 8_192, 20_000, 70_000]);
    const expectedTrim = [];
    const actualTrim = [];
    const expected = new ReferenceText(maxBytes, { onTrim: (bytes) => expectedTrim.push(Buffer.from(bytes)) });
    const actual = new BoundedUtf8Text(maxBytes, { onTrim: (bytes) => actualTrim.push(Buffer.from(bytes)) });
    for (let step = 0; step < 120; step += 1) {
      const roll = random();
      if (roll < 0.03) {
        const text = pick(pieces);
        expected.reset(text);
        actual.reset(text);
      } else if (roll < 0.15) {
        assert.equal(actual.toString(), expected.toString(), `trial ${trial} step ${step}`);
      } else if (roll < 0.18) {
        // The thought tail changes its bound between appends.
        const bound = pick([3, 100, 8_192]);
        expected.maxBytes = bound;
        actual.maxBytes = bound;
      } else {
        const text = pick(pieces);
        expected.append(text);
        actual.append(text);
      }
      for (const key of ["totalBytes", "trimmedBytes", "pendingBytes", "pendingHighSurrogate"]) {
        assert.equal(actual[key], expected[key], `${key}, trial ${trial} step ${step}`);
      }
    }
    assert.equal(actual.toString(), expected.toString(), `trial ${trial}`);
    assert.deepEqual(Buffer.concat(actualTrim), Buffer.concat(expectedTrim), `evicted bytes, trial ${trial}`);
  }
});

test("F3: BoundedUtf8Text refuses a non-positive-integer bound at construction, before any append", () => {
  // A NaN bound (Number("x")) used to be stored and only throw later, inside an
  // append's Buffer.alloc — on the terminal path a stdout "data" callback with
  // no try/catch around it, which took the whole daemon down.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1.5, "100"]) {
    assert.throws(() => new BoundedUtf8Text(bad), /positive integer/, `maxBytes ${String(bad)}`);
  }
  assert.doesNotThrow(() => new BoundedUtf8Text(1));
  assert.equal(new BoundedUtf8Text(8).maxBytes, 8);
});

test("a 1MB tail fed 64KiB terminal chunks keeps about 1MB alive, not every chunk it evicted", () => {
  const text = new BoundedUtf8Text(1_000_000);
  const chunk = "t".repeat(64 * 1024);
  let peakChunks = 0;
  let peakBytes = 0;
  // Past the 1024 evictions the old compaction waited for: until then it held
  // every evicted chunk, about 64MiB for a 1MB bound.
  for (let index = 0; index < 1_100; index += 1) {
    text.append(chunk);
    const { chunks, retainedBytes } = text.memoryStats();
    peakChunks = Math.max(peakChunks, chunks);
    peakBytes = Math.max(peakBytes, retainedBytes);
  }
  assert.equal(text.totalBytes, 1_000_000);
  assert.ok(peakChunks <= 17, `peak ${peakChunks} chunks`);
  assert.ok(peakBytes <= 1_000_000 + 64 * 1024, `peak ${peakBytes} bytes retained`);
});

test("a stream of one-byte fragments shares a few blocks instead of one Buffer per fragment", () => {
  const bound = 64 * 1024;
  const text = new BoundedUtf8Text(bound);
  let peakChunks = 0;
  let peakBytes = 0;
  for (let index = 0; index < 200_000; index += 1) {
    text.append("x");
    if (index % 997 === 0) {
      const { chunks, retainedBytes } = text.memoryStats();
      peakChunks = Math.max(peakChunks, chunks);
      peakBytes = Math.max(peakBytes, retainedBytes);
    }
  }
  assert.equal(text.toString(), "x".repeat(bound));
  assert.equal(text.trimmedBytes, 200_000 - bound);
  // The live bytes, plus at most a partly evicted block at the front and the
  // free room of the open block at the back (16KiB each).
  assert.ok(peakChunks <= 12, `peak ${peakChunks} chunks`);
  assert.ok(peakBytes <= bound + 2 * 16 * 1024, `peak ${peakBytes} bytes retained`);
});

test("one append far over the bound does not keep its whole backing store", () => {
  const text = new BoundedUtf8Text(1_000_000);
  text.append("h".repeat(5_000_000));
  assert.equal(text.trimmedBytes, 4_000_000);
  assert.ok(text.memoryStats().retainedBytes <= 1_000_000 + 16 * 1024, `${text.memoryStats().retainedBytes} bytes`);
  // Tokens between large pieces share blocks too.
  const mixed = new BoundedUtf8Text(100_000);
  for (let index = 0; index < 1_000; index += 1) {
    mixed.append("ab");
    mixed.append("L".repeat(5_000));
  }
  assert.ok(mixed.memoryStats().retainedBytes <= 100_000 + 2 * 16 * 1024, `${mixed.memoryStats().retainedBytes} bytes`);
  assert.ok(mixed.toString().endsWith(`ab${"L".repeat(5_000)}`));
});

// ------------------------------------------------- P4: installer subprocesses

test("an installer command past its deadline is killed and reported as a timeout", async () => {
  await withDirectory("timeout", async (directory) => {
    const pidFile = join(directory, "pid");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${HANG}`;
    const started = Date.now();
    await assert.rejects(
      runCommand(process.execPath, ["-e", script], { timeoutMs: 1_000 }),
      (error) => error.code === "COMMAND_TIMEOUT" && /did not finish within 1s and was stopped/.test(error.message)
    );
    assert.ok(Date.now() - started < 8_000, "the deadline, not the command, ended the wait");
    assert.equal(processGone(Number(await readFile(pidFile, "utf8"))), true, "the command is gone, not orphaned");
  });
});

test("a stopped command is not held by a grandchild that keeps its output open", async () => {
  await withDirectory("grandchild", async (directory) => {
    const pidFile = join(directory, "grandchild");
    // What npm does with a lifecycle script: the script inherits npm's pipes.
    const script = [
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(HANG)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
      HANG
    ].join("\n");
    let grandchild = null;
    try {
      const started = Date.now();
      await assert.rejects(
        runCommand(process.execPath, ["-e", script], { timeoutMs: 1_000 }),
        (error) => error.code === "COMMAND_TIMEOUT"
      );
      grandchild = Number(await readFile(pidFile, "utf8"));
      assert.equal(processGone(grandchild), false, "the grandchild is still there, holding the pipe");
      assert.ok(Date.now() - started < 5_000, "the command's own exit ended the wait");
    } finally {
      if (grandchild) process.kill(grandchild, "SIGKILL");
    }
  });
});

test("an aborted installer command is killed, and one aborted before it starts never runs", async () => {
  await withDirectory("abort", async (directory) => {
    const pidFile = join(directory, "pid");
    const controller = new AbortController();
    const running = runCommand(
      process.execPath,
      ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${HANG}`],
      { signal: controller.signal }
    );
    await until(async () => (await pidIn(pidFile)) !== null, "the command to start");
    controller.abort(new Error("the Gateway is shutting down"));
    await assert.rejects(running, (error) => error.code === "COMMAND_ABORTED" && /shutting down/.test(error.message));
    assert.equal(processGone(Number(await readFile(pidFile, "utf8"))), true);

    const marker = join(directory, "ran");
    await assert.rejects(
      runCommand(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`], { signal: controller.signal }),
      (error) => error.code === "COMMAND_ABORTED"
    );
    await delay(200);
    assert.equal(existsSync(marker), false, "nothing was spawned");
  });
});

// npm finishing an install on its own while a process its lifecycle script
// started lives on, holding npm's pipes: the child prints, then exits 0, and
// the grandchild keeps stdout and stderr open, so "close" never comes.
function exitsLeavingGrandchild(directory) {
  const childPid = join(directory, "child");
  const grandchildPid = join(directory, "grandchild");
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(HANG)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
    "grandchild.unref();",
    `writeFileSync(${JSON.stringify(grandchildPid)}, String(grandchild.pid));`,
    "process.stdout.write('added 1 package');",
    "process.stderr.write('npm warn deprecated');",
    `writeFileSync(${JSON.stringify(childPid)}, String(process.pid));`
  ].join("\n");
  return { script, childPid, grandchildPid };
}

async function killGrandchild(path) {
  const pid = await pidIn(path);
  if (pid && !processGone(pid)) process.kill(pid, "SIGKILL");
}

test("a command that exited 0 on its own resolves with its status and output when the deadline comes while a grandchild holds its pipes", async () => {
  await withDirectory("late-deadline", async (directory) => {
    const { script, grandchildPid } = exitsLeavingGrandchild(directory);
    try {
      const started = Date.now();
      // Long enough for the child to start, print and exit well before it.
      const result = await runCommand(process.execPath, ["-e", script], { timeoutMs: 2_000 });
      assert.deepEqual(result, { code: 0, stdout: "added 1 package", stderr: "npm warn deprecated" }, "not COMMAND_TIMEOUT");
      assert.ok(Date.now() - started < 6_000, "the deadline, not the grandchild, ended the wait");
      const grandchild = await pidIn(grandchildPid);
      assert.ok(grandchild && !processGone(grandchild), "the grandchild still holds the pipes: \"close\" never came");
    } finally {
      await killGrandchild(grandchildPid);
    }
  });
});

test("an abort after a command exited 0 on its own resolves with its status and output, not as aborted", async () => {
  await withDirectory("late-abort", async (directory) => {
    const { script, childPid, grandchildPid } = exitsLeavingGrandchild(directory);
    const controller = new AbortController();
    try {
      const running = runCommand(process.execPath, ["-e", script], { signal: controller.signal });
      // Gone means reaped, and Node emits "exit" as it reaps: runCommand has seen
      // the exit by the time this holds.
      await until(async () => {
        const pid = await pidIn(childPid);
        return pid !== null && processGone(pid);
      }, "the command to exit");
      controller.abort(new Error("the Gateway is shutting down"));
      assert.deepEqual(await running, { code: 0, stdout: "added 1 package", stderr: "npm warn deprecated" }, "not COMMAND_ABORTED");
      const grandchild = await pidIn(grandchildPid);
      assert.ok(grandchild && !processGone(grandchild), "the grandchild still holds the pipes: \"close\" never came");
    } finally {
      await killGrandchild(grandchildPid);
    }
  });
});

test("installer command output keeps its head and tail and says how much it dropped", async () => {
  const script = "process.stdout.write('HEAD' + 'é'.repeat(300000) + 'TAIL'); process.stderr.write('E'.repeat(100000))";
  const result = await runCommand(process.execPath, ["-e", script], { maxOutputBytes: 64 * 1024 });
  assert.equal(result.code, 0);
  assert.equal(result.outputTruncated, true);
  assert.ok(result.stdout.startsWith("HEADé"));
  assert.ok(result.stdout.endsWith("éTAIL"));
  // 600008 bytes printed, the first and last 32KiB kept.
  assert.match(result.stdout, new RegExp(`\\[\\.\\.\\. ${600_008 - 64 * 1024} bytes of output omitted \\.\\.\\.\\]`));
  assert.doesNotMatch(result.stdout, /\uFFFD/, "no character was split at a read boundary");
  assert.ok(Buffer.byteLength(result.stdout) <= 64 * 1024 + 64);
  assert.ok(Buffer.byteLength(result.stderr) <= 64 * 1024 + 64);
  assert.match(result.stderr, /bytes of output omitted/);

  const small = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.deepEqual(small, { code: 0, stdout: "ok", stderr: "" }, "output within the bound is returned as it was");
});

test("an npm list cut at the output bound fails agent discovery with a warning instead of reporting nothing installed", async () => {
  await withDirectory("npm-list", async (directory) => {
    // What `npm list --global --depth=0 --json` prints for a global tree of
    // count packages, captured under a bound made small for the test.
    const npmList = (count) => runCommand(process.execPath, ["-e", [
      `const dependencies = Object.fromEntries(Array.from({ length: ${count} }, (_, index) => ["package-" + index, { version: "1.0.0" }]));`,
      "process.stdout.write(JSON.stringify({ dependencies }, null, 2));"
    ].join("\n")], { maxOutputBytes: 64 * 1024 });
    const calls = [];
    const discovered = [];
    const discover = (count) => runInstaller(parseInstallerArgs(["--discover-agents"]), {
      statePath: join(directory, "install.json"),
      providerRegistryPath: join(directory, "providers.json"),
      runtime: { nodeVersion: "22.0.0", platform: "darwin", arch: "arm64" },
      detectProviders: async () => [],
      registryLoader: async () => ({ registry: { version: "1.0.0", agents: [] }, source: "network", stale: false }),
      registryDiscover: async (_registry, { installedPackages }) => {
        discovered.push([...installedPackages]);
        return [];
      },
      runCommand: async (command, args) => {
        calls.push([command, ...args].join(" "));
        return npmList(count);
      }
    });

    const cut = await discover(5_000);
    assert.deepEqual(calls, ["npm list --global --depth=0 --json"]);
    assert.deepEqual(discovered, [], "discovery never ran on an empty package set");
    assert.match(cut.registry.error, /^Cannot discover ACP registry agents: npm list --global printed more than the installer captures/);
    assert.deepEqual(cut.warnings, [cut.registry.error]);
    assert.deepEqual(cut.registry.configured, []);

    const whole = await discover(3);
    assert.equal(whole.registry.error, undefined);
    assert.deepEqual(whole.warnings, []);
    assert.deepEqual(discovered, [["package-0", "package-1", "package-2"]], "a list within the bound is still read");
  });
});

const registry = {
  version: "1.0.0",
  agents: [{
    id: "claude-acp",
    name: "Claude ACP",
    version: "0.64.0",
    distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@0.64.0" } }
  }]
};

// An update manager whose install hangs in a real child process until killed.
function hangingUpdates(pidFile) {
  return new AgentUpdateManager({
    registryLoader: async () => ({ registry, source: "network", stale: false }),
    detect: async () => [{ id: "claude", registryId: "claude-acp", registryVersion: "0.60.0", agentInstalled: true }],
    applyUpdates: (_updates, { signal }) => runCommand(
      process.execPath,
      ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${HANG}`],
      { signal }
    )
  });
}

test("aborting an adapter update kills the install it is running and records why", async () => {
  await withDirectory("update-abort", async (directory) => {
    const pidFile = join(directory, "pid");
    const manager = hangingUpdates(pidFile);
    const refreshing = manager.refresh();
    await until(async () => (await pidIn(pidFile)) !== null, "the install to start");
    manager.abort(new Error("the Gateway is shutting down"));
    const state = await refreshing;
    assert.equal(state.status, "error");
    assert.match(state.error, /was stopped: the Gateway is shutting down/);
    assert.equal(processGone(Number(await readFile(pidFile, "utf8"))), true);
    await manager.stop();
  });
});

test("shutdown waits a bounded time for an adapter update, aborts it, then stops everything else", async () => {
  await withDirectory("shutdown-update", async (directory) => {
    const pidFile = join(directory, "pid");
    const manager = hangingUpdates(pidFile);
    const service = new GatewayService({
      statePath: join(directory, "state.json"),
      artifactRoot: join(directory, "artifacts"),
      gcIntervalMs: 0,
      agentUpdateManager: manager,
      agentUpdateStopMs: 200
    });
    await service.init();
    await until(async () => (await pidIn(pidFile)) !== null, "the update to start its install");
    const started = Date.now();
    const report = await service.shutdown();
    assert.ok(Date.now() - started < 5_000, "a hung install no longer holds shutdown");
    assert.equal(report.agentUpdates.outcome, "aborted");
    assert.match(report.agentUpdates.reason, /still running after 200ms and was aborted/);
    assert.equal(service.shutdownReport, report);
    assert.equal(processGone(Number(await readFile(pidFile, "utf8"))), true, "its npm/uv process does not outlive the daemon");
    // Shutdown went on to its last step: the final state is on disk.
    assert.equal(existsSync(statePaths(join(directory, "state.json")).snapshot), true);
  });
});

test("an update that ignores the abort is abandoned, never waited on", async () => {
  const calls = [];
  const manager = {
    running: null,
    start() {},
    stop() {
      calls.push("stop");
      return new Promise(() => {});
    },
    abort(reason) {
      calls.push(`abort: ${reason.message}`);
    },
    snapshot() { return null; }
  };
  const service = new GatewayService({ gcIntervalMs: 0, agentUpdateManager: manager, agentUpdateStopMs: 50 });
  const started = Date.now();
  const report = await service.shutdown();
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(calls, ["stop", "abort: the Gateway is shutting down"]);
  assert.equal(report.agentUpdates.outcome, "abandoned");

  const quick = new GatewayService({ gcIntervalMs: 0, agentUpdateManager: { start() {}, async stop() {}, snapshot() { return null; } } });
  assert.equal(await quick.shutdown(), null, "a manager that stops in time leaves nothing to report");
});

// ------------------------------------------------------ P5: subscribe replay

test("a subscribe replay is bounded by bytes, keeps the newest events and reports the cut", async () => {
  // maxQueueBytes 20000: a 10000-byte replay budget.
  const service = new GatewayService({ gcIntervalMs: 0, maxQueueBytes: 20_000 });
  try {
    const session = directSession(service, "replay-budget");
    for (let index = 0; index < 100; index += 1) {
      service.store.push(session, { type: "turn_start", marker: index, note: "n".repeat(300) });
    }
    const result = service.subscribe(
      { sessionIds: [session.id], cursors: { [session.id]: 0 } }, MAIN, () => {}
    );
    assert.ok(Buffer.byteLength(JSON.stringify(result.events)) <= 10_000 + 2);
    const sequences = result.events.map((event) => event.sequence);
    assert.ok(sequences.length > 0 && sequences.length < 100);
    assert.deepEqual(sequences, session.events.slice(-sequences.length).map((event) => event.i),
      "what is kept is the newest contiguous run, so no cursor can skip a hole");
    assert.equal(result.cursorTruncated[session.id], true, "a client that knows only cursorTruncated learns of the cut");
    const replay = result.replay[session.id];
    assert.equal(replay.complete, false);
    assert.equal(replay.budgetTruncated, true);
    assert.equal(replay.retainedTruncated, false, "nothing left the ring");
    assert.equal(replay.omittedEvents, 100 - sequences.length);
    assert.equal(replay.omittedBefore, sequences[0]);
    // What was cut is still in the ring, for a poll over exactly that range.
    const polled = await service.call("poll", {
      sessionId: session.id, cursor: replay.fromCursor, toCursor: replay.omittedBefore,
      eventTypes: ["turn_start"], maxEvents: 1_000
    }, MAIN);
    assert.equal(polled.events.length, replay.omittedEvents);
    service.unsubscribe(result.subscriptionId, MAIN);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

test("one busy session cannot crowd the others out of a replay", async () => {
  const service = new GatewayService({ gcIntervalMs: 0, maxQueueBytes: 20_000 });
  try {
    const busy = directSession(service, "busy");
    const quiet = directSession(service, "quiet");
    for (let index = 0; index < 100; index += 1) {
      service.store.push(busy, { type: "turn_start", marker: index, note: "n".repeat(300) });
    }
    service.store.push(quiet, { type: "turn_start", marker: 0 });
    service.store.push(quiet, { type: "turn_end", stopReason: "end_turn" });
    const result = service.subscribe({ cursors: { [busy.id]: 0, [quiet.id]: 0 } }, MAIN, () => {});
    assert.deepEqual(result.events.filter((event) => event.sessionId === quiet.id).map((event) => event.type), ["turn_start", "turn_end"]);
    assert.equal(result.replay[quiet.id].complete, true);
    assert.equal(Object.hasOwn(result.replay[quiet.id], "budgetTruncated"), false, "a replay that fits keeps its shape");
    assert.equal(result.replay[busy.id].budgetTruncated, true);
    service.unsubscribe(result.subscriptionId, MAIN);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

// -------------------------------------------- P9: tool-event spills and quota

const oversizedUpdate = (toolCallId, index) => ({
  sessionUpdate: "tool_call_update",
  toolCallId,
  status: "in_progress",
  content: [{ type: "content", content: { type: "text", text: `${index}`.repeat(6_000) } }]
});

test("a superseded tool update nobody was handed is deleted at once, and its bytes return to the quota", async () => {
  await withDirectory("reclaim", async (directory) => {
    const artifactRoot = join(directory, "artifacts");
    const service = new GatewayService({ gcIntervalMs: 0, artifactRoot });
    try {
      const session = directSession(service, "reclaim");
      let previous = null;
      for (let index = 0; index < 20; index += 1) {
        service.handleUpdate(session, oversizedUpdate("call-a", index));
        const current = session.events.at(-1).dataArtifact.path;
        if (previous) assert.equal(existsSync(previous), false, `update ${index - 1} was reclaimed`);
        previous = current;
      }
      assert.deepEqual(await readdir(artifactRoot), [basename(previous)], "one file per tool call, not per update");
      assert.equal(service.artifactStore.usedBytes, (await stat(previous)).size);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("a tool update that was handed out is never deleted under its reader", async () => {
  await withDirectory("handed-out", async (directory) => {
    const service = new GatewayService({ gcIntervalMs: 0, artifactRoot: join(directory, "artifacts") });
    try {
      const session = directSession(service, "handed-out");
      // One oversized update for the call, then deliver() hands it out (or
      // does not), then a newer update supersedes it.
      const supersede = async (toolCallId, deliver) => {
        service.handleUpdate(session, oversizedUpdate(toolCallId, 1));
        const stale = session.events.at(-1).dataArtifact.path;
        await deliver();
        service.handleUpdate(session, oversizedUpdate(toolCallId, 2));
        return stale;
      };
      const replayed = await supersede("call-replay", () => {
        const replay = service.subscribe(
          { sessionIds: [session.id], includeToolEvents: true, cursors: { [session.id]: 0 } }, MAIN, () => {}
        );
        service.unsubscribe(replay.subscriptionId, MAIN);
      });
      assert.equal(existsSync(replayed), true, "handed out by a subscribe replay");
      const got = await supersede("call-get", () =>
        service.call("session", { action: "get", sessionId: session.id, includeEvents: true }, MAIN));
      assert.equal(existsSync(got), true, "handed out by session get");
      const polled = await supersede("call-poll", () =>
        service.call("poll", { sessionId: session.id, cursor: 0, includeToolEvents: true }, MAIN));
      assert.equal(existsSync(polled), true, "handed out by a poll");
      // Live: the subscription is open while the update is pushed.
      const live = service.subscribe({ sessionIds: [session.id], includeToolEvents: true }, MAIN, () => {});
      const streamed = await supersede("call-live", () => {});
      service.unsubscribe(live.subscriptionId, MAIN);
      assert.equal(existsSync(streamed), true, "handed out live");

      // Delivery paths whose filter withheld the event handed nothing out.
      const blind = service.subscribe({ sessionIds: [session.id] }, MAIN, () => {});
      const withheld = await supersede("call-withheld", () =>
        service.call("poll", { sessionId: session.id, cursor: 0 }, MAIN));
      service.unsubscribe(blind.subscriptionId, MAIN);
      assert.equal(existsSync(withheld), false);
    } finally {
      await service.shutdown().catch(() => {});
    }
  });
});

test("the artifact quota keeps a reserve only durable writers may fill", async () => {
  await withDirectory("reserve", async (directory) => {
    const store = new ArtifactStore({ root: directory, maxFileBytes: 1_000, maxTotalBytes: 1_000, durableReserveBytes: 200 });
    const spill = store.create("s", "event-tool_call_update");
    spill.append("x".repeat(1_000));
    spill.finalize();
    assert.equal(spill.metadata().bytes, 800);
    assert.equal(spill.metadata().truncated, true);
    const late = store.create("s", "terminal");
    late.append("y");
    late.finalize();
    assert.equal(late.metadata().path, null, "non-durable writers stop short of the reserve");
    const durable = store.create("s", "task-result", { durable: true });
    durable.append("z".repeat(150));
    durable.finalize(null, { sync: true });
    assert.equal(durable.metadata().bytes, 150);
    assert.equal(durable.metadata().truncated, false);
    assert.equal(store.usedBytes, 950);
  });
});

test("discard removes only a finished artifact of the store's own", async () => {
  await withDirectory("discard", async (directory) => {
    const root = join(directory, "artifacts");
    const store = new ArtifactStore({ root });
    const finished = store.create("s", "event-tool_call_update");
    finished.append("abc");
    finished.finalize();
    const open = store.create("s", "terminal");
    open.append("still writing");
    const outside = join(directory, "acp-artifact-outside.txt");
    const foreign = join(root, "notes.txt");
    await writeFile(outside, "keep");
    await writeFile(foreign, "keep");
    assert.equal(store.discard(outside), false, "not under this store's root");
    assert.equal(store.discard(foreign), false, "not an artifact");
    assert.equal(store.discard(open.metadata().path), false, "still being written");
    assert.equal(existsSync(outside) && existsSync(foreign) && existsSync(open.metadata().path), true);
    const used = store.usedBytes;
    assert.equal(store.discard(finished.metadata().path), true);
    assert.equal(existsSync(finished.metadata().path), false);
    assert.equal(store.usedBytes, used - 3);
    open.finalize();
  });
});

test("tool-event spills cannot starve a durable task result of its artifact", async () => {
  await withDirectory("reserve-task", async (directory) => {
    const statePath = join(directory, "state.json");
    const service = new GatewayService({
      statePath,
      artifactRoot: join(directory, "artifacts"),
      createClient: (_provider, clientOptions) => new AcpClient(
        { provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" },
        clientOptions
      ),
      gcIntervalMs: 0,
      maxArtifactBytes: 64 * 1024,
      maxArtifactTotalBytes: 64 * 1024,
      persistence: { walInlineResultBytes: 64 }
    });
    try {
      await service.init();
      assert.equal(service.artifactStore.durableReserveBytes, 8 * 1024, "an eighth of the quota");
      // Everything that is not a durable result fills its whole share.
      const filler = service.artifactStore.create("filler", "event-tool_call_update");
      filler.append("x".repeat(64 * 1024));
      filler.finalize();
      assert.equal(filler.metadata().bytes, 56 * 1024);

      const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, MAIN);
      const task = await service.call("task_prompt", { sessionId: opened.sessionId, prompt: "large-result", ttl: 600_000 }, MAIN);
      await until(async () => (await service.call("task_get", { taskId: task.taskId }, MAIN)).status === "completed", "the task");
      await service.flushPersist();
      assert.equal(service.persistError, null);
      const wal = (await readFile(statePaths(statePath).wal, "utf8")).split("\n").filter(Boolean)
        .map((line) => decodeRecord(Buffer.from(line, "utf8")));
      const committed = wal.find((record) => record.type === "task.result_committed");
      assert.equal(typeof committed.payload.ref?.path, "string", "the result went to its artifact, not just a preview");
      const stored = await readFile(committed.payload.ref.path, "utf8");
      assert.equal(createHash("sha256").update(stored).digest("hex"), committed.payload.ref.sha256);
    } finally {
      await service.shutdown();
    }
  });
});

// --------------------------------------------------------- P10: poll costs

test("poll metrics count exactly the bytes that go out, without serializing the response again", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "metrics");
    service.store.push(session, {
      type: "permission_request", requestId: 1, toolCall: { toolCallId: "t", title: "Edit \"a\"", kind: "edit" }, options: []
    });
    service.handleUpdate(session, { sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress" });
    service.store.appendResultText(session, "the answer, with \"quotes\" and ünïcode\n".repeat(50));
    session.status = "idle";
    const stringify = JSON.stringify;
    let wholeResponses = 0;
    JSON.stringify = function (value, ...rest) {
      if (value && typeof value === "object" && Object.hasOwn(value, "events") && Object.hasOwn(value, "nextCursor")) {
        wholeResponses += 1;
      }
      return stringify.call(this, value, ...rest);
    };
    const polls = [];
    try {
      for (const args of [{}, { responseProfile: "compact" }, { responseProfile: "diagnostic" }, { includeResult: false }, { includeToolEvents: true }]) {
        const before = { ...service.metrics };
        const response = await service.call("poll", { sessionId: session.id, cursor: 0, ...args }, MAIN);
        polls.push({ before, after: { ...service.metrics }, response });
      }
    } finally {
      JSON.stringify = stringify;
    }
    assert.equal(wholeResponses, 0, "no whole poll response is serialized to be counted");
    for (const { before, after, response } of polls) {
      assert.equal(after.pollBytes - before.pollBytes, Buffer.byteLength(JSON.stringify(response)));
      assert.equal(after.eventBytes - before.eventBytes, response.events.length ? Buffer.byteLength(JSON.stringify(response.events)) : 0);
      assert.equal(after.resultBytes - before.resultBytes, response.result ? Buffer.byteLength(JSON.stringify(response.result)) : 0);
    }
    assert.equal(Object.hasOwn(polls[0].response, "result"), true, "an idle poll still carries its result by default");
  } finally {
    await service.shutdown().catch(() => {});
  }
});

const activeTimeouts = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

test("an aborted long poll removes its waiter and its timer at once", async () => {
  const service = new GatewayService({ gcIntervalMs: 0 });
  try {
    const session = directSession(service, "abandoned");
    const controller = new AbortController();
    const timeouts = activeTimeouts();
    const polling = service.call("poll", { sessionId: session.id, waitMs: 60_000 }, { ...MAIN, signal: controller.signal });
    await until(() => session.waiters.size === 1, "the poll to park");
    assert.equal(activeTimeouts(), timeouts + 1);
    const abortedAt = Date.now();
    controller.abort();
    await assert.rejects(polling, (error) => error.code === ERROR_CODES.WAIT_ABORTED);
    assert.ok(Date.now() - abortedAt < 1_000, "not after waitMs, and not at the next event");
    assert.equal(session.waiters.size, 0);
    assert.equal(activeTimeouts(), timeouts, "its timer went with it");

    // An abort that lands before the wait starts never parks at all.
    await assert.rejects(
      service.call("poll", { sessionId: session.id, waitMs: 60_000 }, { ...MAIN, signal: AbortSignal.abort() }),
      (error) => error.code === ERROR_CODES.WAIT_ABORTED
    );
    assert.equal(session.waiters.size, 0);
  } finally {
    await service.shutdown().catch(() => {});
  }
});

// ------------------------------------------------- startup: install.json tmp

test("startup removes a dead installer's install.json temporary, which holds the Control token", async () => {
  await withDirectory("install-tmp", async (directory) => {
    const config = join(directory, "config");
    await mkdir(config);
    const installPath = join(config, "install.json");
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const stale = `${installPath}.${dead}.tmp`;
    const live = `${installPath}.${process.ppid}.tmp`;
    await writeFile(stale, "{\"identity\":{\"token\":\"x\"}}");
    await writeFile(live, "partial");
    const service = new GatewayService({
      statePath: join(directory, "state.json"),
      artifactRoot: join(directory, "artifacts"),
      settings: new GatewaySettings({ path: join(config, "settings.json"), legacy: installPath, env: {} }),
      gcIntervalMs: 0
    });
    try {
      await service.init();
    } finally {
      await service.shutdown();
    }
    assert.equal(existsSync(stale), false, "a dead writer's copy of the token is gone");
    assert.equal(existsSync(live), true, "a running installer's write is left alone");
  });
});
