import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GATEWAY_WORKER_ENV, withoutSessionMarkers, workerEnv } from "../src/caller.js";
import { ERROR_CODES } from "../src/errors.js";
import { sanitizeWorkerMcpServers } from "../src/gateway-service.js";
import { readNdjson } from "../src/ndjson.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import {
  callerVerdicts, canReadAncestry, daemonLockPid, findAncestor, MAX_ANCESTRY_DEPTH, readProcessInfo, runsGatewayDaemon,
  runsUnder, WORKER_TREE_EXIT_CODE, workerTreeReason
} from "../src/worker-tree.js";
import { startDaemon } from "./helpers/daemon-harness.js";
import { withTemp } from "./helpers/scratch.js";

// W1 (1.8.0 review): a Codex worker the daemon started loaded the user's own
// ~/.codex/config.toml and launched the Control MCP registered there, which
// found its identity and handed the worker every agent_acp_* tool. Workers never
// get the Control: the front door refuses to start under one, and the daemon
// refuses a caller that runs under it. W12: the session-level check on the MCP
// servers a Main hands a worker missed the installed runtime and the identity env.

const frontDoor = fileURLToPath(new URL("../src/index.js", import.meta.url));
const configMcpAgent = fileURLToPath(new URL("./mock-config-mcp-agent.js", import.meta.url));
const unix = process.platform !== "win32";

// An injected process table, pid -> [ppid, command], and the pids it was asked for.
function processTable(entries) {
  const reads = [];
  const readProcess = async (pid) => {
    reads.push(pid);
    const entry = entries[pid];
    return entry ? { ppid: entry[0], command: entry[1] } : null;
  };
  return { readProcess, reads };
}

// What W1 looked like: front door <- codex <- the adapter <- npm exec <- daemon.
const WORKER_CHAIN = {
  100: [50, "/opt/homebrew/bin/codex app-server"],
  50: [45, "node /Users/me/.npm/_npx/1a2b/node_modules/@agentclientprotocol/codex-acp/dist/index.js"],
  45: [40, "node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js exec @agentclientprotocol/codex-acp"],
  40: [1, "/usr/local/bin/node /Users/me/.acp-gateway/runtime/current/gateway/src/gateway-daemon.js"]
};

test("W1: the worker marker alone refuses a front door, before any process is read", async () => {
  const noLookup = () => assert.fail("the marker decides without a lookup");
  assert.equal(
    await workerTreeReason({ env: { [GATEWAY_WORKER_ENV]: "1" }, ppid: 100, socketPath: "/nonexistent/gateway.sock", readProcess: noLookup }),
    "ACP_GATEWAY_WORKER=1 is set"
  );
  // Any other value is not the marker: the chain decides.
  const { readProcess } = processTable({ 100: [1, "/bin/zsh"] });
  assert.equal(await workerTreeReason({ env: { [GATEWAY_WORKER_ENV]: "0" }, ppid: 100, socketPath: "/nonexistent/gateway.sock", readProcess }), null);
});

test("W1: workers and the terminals they open always carry the marker", () => {
  const inherited = { PATH: "/bin", ACP_GATEWAY_CONTROL_TOKEN: "inherited-control-token-at-least-24", CLAUDE_CODE_SESSION_ID: "main" };
  assert.deepEqual(workerEnv({ NO_COLOR: "1" }, inherited), { PATH: "/bin", NO_COLOR: "1", [GATEWAY_WORKER_ENV]: "1" });
  // A terminal's env is the worker's request: it cannot ask the marker away.
  assert.equal(workerEnv({ [GATEWAY_WORKER_ENV]: "0" }, inherited)[GATEWAY_WORKER_ENV], "1");
  assert.equal(Object.hasOwn(inherited, GATEWAY_WORKER_ENV), false, "a copy: the caller's env is untouched");
});

test("W1: an ancestor holding the daemon lock refuses the front door", async () => {
  await withTemp("acp-worker-tree-lock-", async (directory) => {
    const socketPath = join(directory, "gateway.sock");
    await writeFile(`${socketPath}.lock`, "40\n");
    const held = `ancestor process 40 holds the Gateway daemon lock ${socketPath}.lock`;
    // The lock's pid is read, and its command line runs the daemon.
    const { readProcess, reads } = processTable(WORKER_CHAIN);
    assert.equal(await workerTreeReason({ env: {}, ppid: 100, socketPath, readProcess }), held);
    assert.deepEqual(reads, [100, 50, 45, 40]);
    // One whose command line cannot be read still counts: gone from the table,
    // a read that fails, or an empty command line.
    const unlisted = { ...WORKER_CHAIN };
    delete unlisted[40];
    for (const unreadable of [
      processTable(unlisted).readProcess,
      async (pid) => {
        if (pid === 40) throw new Error("ps failed");
        return processTable(WORKER_CHAIN).readProcess(pid);
      },
      processTable({ ...WORKER_CHAIN, 40: [1, " "] }).readProcess
    ]) assert.equal(await workerTreeReason({ env: {}, ppid: 100, socketPath, readProcess: unreadable }), held);
  });
});

// Review: a daemon that dies without removing its lock leaves its pid there, and
// once the Main's own CLI or another of its ancestors takes that pid, every
// front door that Main starts would refuse, and nothing would start the daemon
// that rewrites the lock.
test("W1: a lock whose pid now runs something else is stale, and the walk goes on past it", async () => {
  await withTemp("acp-worker-tree-stale-", async (directory) => {
    const socketPath = join(directory, "gateway.sock");
    const mainChain = {
      100: [90, "/Users/me/.local/bin/claude"],
      90: [80, "-zsh"],
      80: [1, "/Applications/iTerm.app/Contents/MacOS/iTerm2"]
    };
    for (const stale of [100, 90, 80]) {
      await writeFile(`${socketPath}.lock`, `${stale}\n`);
      const { readProcess, reads } = processTable(mainChain);
      assert.equal(await workerTreeReason({ env: {}, ppid: 100, socketPath, readProcess }), null, `lock ${stale}`);
      assert.deepEqual(reads, [100, 90, 80], "read, found not to be the daemon, and walked past");
    }
    // Past a stale lock pid, a daemon further up is still found by its command line.
    await writeFile(`${socketPath}.lock`, "50\n");
    assert.match(
      await workerTreeReason({ env: {}, ppid: 100, socketPath, readProcess: processTable(WORKER_CHAIN).readProcess }),
      /^ancestor process 40 runs the Gateway daemon: /
    );
    // A daemon whose command line names no daemon entry (an app hosting it)
    // reads the same as a reused pid, so its lock no longer refuses on its own.
    // Its workers still carry the marker, and the daemon refuses them as callers.
    await writeFile(`${socketPath}.lock`, "40\n");
    const hosted = processTable({ ...WORKER_CHAIN, 40: [1, "/Applications/Some App.app/Contents/MacOS/Some App"] });
    assert.equal(await workerTreeReason({ env: {}, ppid: 100, socketPath, readProcess: hosted.readProcess }), null);
    assert.equal(await runsUnder(100, 40, { readProcess: hosted.readProcess }), true);
  });
});

// Review: a daemon that is pid 1 (a container entrypoint with no init) writes 1
// into its lock, and every chain ends at pid 1.
test("W1: pid 1 is the top of every chain, never the daemon, even when the lock names it", async () => {
  await withTemp("acp-worker-tree-init-", async (directory) => {
    const socketPath = join(directory, "gateway.sock");
    await writeFile(`${socketPath}.lock`, "1\n");
    // pid 1 is in the table and readable (init always is), so the daemon-side
    // probe of a pid-1 daemon finds the host healthy; the walk still never reads
    // or matches it.
    const { readProcess, reads } = processTable({ 100: [90, "/usr/local/bin/claude"], 90: [1, "/bin/sh -c claude"], 1: [0, "/sbin/init"] });
    assert.equal(await workerTreeReason({ env: {}, ppid: 100, socketPath, readProcess }), null);
    assert.deepEqual(reads, [100, 90], "pid 1 is neither matched nor read");
    assert.equal(await findAncestor(1, { pids: [1], readProcess: () => assert.fail("pid 1 is never read") }), null);
    // The daemon's side: everything runs under it, so ancestry refuses nobody.
    assert.equal(await runsUnder(100, 1, { readProcess }), false);
    assert.equal(await callerVerdicts({ daemonPid: 1, readProcess })(100).denied, false);
    // There the marker alone tells its workers apart.
    assert.equal(await workerTreeReason({ env: { [GATEWAY_WORKER_ENV]: "1" }, ppid: 100, socketPath, readProcess }), "ACP_GATEWAY_WORKER=1 is set");
  });
});

test("W1: an ancestor running gateway-daemon.js refuses the front door, on any socket", async () => {
  await withTemp("acp-worker-tree-command-", async (directory) => {
    // No lock at this front door's socket: the daemon above it serves another one.
    const { readProcess } = processTable(WORKER_CHAIN);
    const reason = await workerTreeReason({ env: {}, ppid: 100, socketPath: join(directory, "gateway.sock"), readProcess });
    assert.match(reason, /^ancestor process 40 runs the Gateway daemon: \/usr\/local\/bin\/node .*\/src\/gateway-daemon\.js$/);
  });
});

test("W1: a Main's chain is never refused, whatever its CLI was told", async () => {
  await withTemp("acp-worker-tree-main-", async (directory) => {
    const socketPath = join(directory, "gateway.sock");
    // The daemon this Main autostarted runs beside it, not above it.
    await writeFile(`${socketPath}.lock`, "7777\n");
    const { readProcess, reads } = processTable({
      100: [90, "/Users/me/.local/bin/claude fix src/gateway-daemon.js"],
      90: [80, "/bin/zsh -c nvim src/gateway-daemon.js"],
      80: [70, "nvim src/gateway-daemon.js"],
      70: [1, "/Applications/iTerm.app/Contents/MacOS/iTerm2"]
    });
    assert.equal(await workerTreeReason({ env: {}, ppid: 100, socketPath, readProcess }), null);
    assert.deepEqual(reads, [100, 90, 80, 70], "pid 1 is the top and is never read");
  });
});

test("W1: only a runtime running the daemon entry, with no arguments after it, is the daemon", () => {
  for (const command of [
    "node /x/src/gateway-daemon.js",
    "/usr/local/bin/node /Users/me/.acp-gateway/runtime/current/gateway/src/gateway-daemon.js",
    "node --import /x/fault.js --max-old-space-size=4096 /x/src/gateway-daemon.js",
    "node /opt/homebrew/bin/acp-gateway-daemon",
    "/opt/homebrew/bin/acp-gateway-daemon",
    "nodejs src/gateway-daemon.js",
    "node22 src/gateway-daemon.js"
  ]) assert.equal(runsGatewayDaemon(command), true, command);
  for (const command of [
    "claude fix src/gateway-daemon.js",
    "node /usr/local/bin/claude look at src/gateway-daemon.js",
    "nvim src/gateway-daemon.js",
    "node /x/src/gateway-daemon.js --verbose",
    "node /x/src/index.js",
    "node /x/src/gateway-daemon.json",
    "Paseo Daemon",
    "",
    null
  ]) assert.equal(runsGatewayDaemon(command), false, String(command));
});

test("W1: the ancestry lookup is bounded and treats what it cannot read as no evidence", async () => {
  // A chain longer than the bound, with the daemon just past it.
  const chain = {};
  for (let pid = 1000; pid > 1000 - MAX_ANCESTRY_DEPTH; pid -= 1) chain[pid] = [pid - 1, `node /x/step-${pid}.js`];
  chain[1000 - MAX_ANCESTRY_DEPTH] = [1, "node /x/src/gateway-daemon.js"];
  const beyond = processTable(chain);
  assert.equal(await findAncestor(1000, { commandMatches: runsGatewayDaemon, readProcess: beyond.readProcess }), null);
  assert.equal(beyond.reads.length, MAX_ANCESTRY_DEPTH);
  const within = processTable(chain);
  assert.equal((await findAncestor(999, { commandMatches: runsGatewayDaemon, readProcess: within.readProcess }))?.pid, 1000 - MAX_ANCESTRY_DEPTH);

  const fails = [
    async () => { throw new Error("ps failed"); },
    () => { throw new Error("thrown synchronously"); },
    async () => null,
    async () => ({ ppid: Number.NaN, command: "node /x/a.js" })
  ];
  for (const readProcess of fails) {
    assert.equal(await findAncestor(100, { pids: [40], commandMatches: runsGatewayDaemon, readProcess }), null);
    assert.equal(await runsUnder(100, 40, { readProcess }), false);
    // F6: findAncestor and runsUnder stay predicates — an unreadable chain is not
    // a match and not "under". Where the host cannot read ancestry at all, the
    // front door keeps treating it as no evidence; where it can, F6 fails closed
    // (the next test), so the marker stays the only signal on such a host.
    assert.equal(await workerTreeReason({ env: {}, ppid: 100, socketPath: "/nonexistent/gateway.sock", readProcess, ancestrySupported: false }), null);
  }
  // A chain that loops (a pid reused mid-walk) ends instead of spinning to the bound.
  const loop = processTable({ 10: [11, "a"], 11: [10, "b"] });
  assert.equal(await findAncestor(10, { pids: [40], readProcess: loop.readProcess }), null);
  assert.deepEqual(loop.reads, [10, 11]);
  for (const pid of [0, -1, 1.5, null, undefined]) assert.equal(await findAncestor(pid, { pids: [pid], readProcess: () => assert.fail() }), null);
});

// F6 (1.8.0 review): when the ancestry walk cannot read parents — no /proc and
// ps missing or blocked — workerTreeReason used to return null (front door
// starts) and the daemon's caller check treated the chain as not-under-it
// (caller allowed), so a worker CLI that forwards no marker (Codex) got Control
// on such a host. The checks now tell "walked, no daemon" from "could not read"
// and fail closed on the latter, where the host can read ancestry at all.
test("F6: an unreadable ancestry fails closed at the front door and the daemon, the marker still first", async () => {
  // No /proc and no ps: every read fails. canReadAncestry is true on this Unix
  // test host, so this is the rare broken host the checks fail closed on.
  for (const readProcess of [async () => null, async () => { throw new Error("ps blocked"); }]) {
    assert.match(
      await workerTreeReason({ env: {}, ppid: 100, socketPath: "/nonexistent/gateway.sock", readProcess }),
      /process ancestry cannot be read/
    );
    assert.equal(await callerVerdicts({ daemonPid: 40, readProcess })(100).denied, true, "the daemon refuses the caller pid");
  }
  // The marker decides before any lookup, unreadable chain or not.
  assert.equal(
    await workerTreeReason({ env: { [GATEWAY_WORKER_ENV]: "1" }, ppid: 100, socketPath: "/nonexistent/gateway.sock", readProcess: () => assert.fail("the marker decides first") }),
    "ACP_GATEWAY_WORKER=1 is set"
  );
});

test("F6: a readable chain with no daemon is allowed, and a no-caller request is never refused", async () => {
  // Read all the way to pid 1, no daemon above: a Main, allowed at both ends. The
  // daemon (pid 40) is alive and readable, so the daemon-side probe finds the
  // host healthy and the caller merely outside it.
  const { readProcess } = processTable({ 100: [90, "/bin/zsh"], 90: [1, "/sbin/launchd"], 40: [1, "node /x/gateway-daemon.js"] });
  assert.equal(await workerTreeReason({ env: {}, ppid: 100, socketPath: "/nonexistent/gateway.sock", readProcess }), null);
  assert.equal(await callerVerdicts({ daemonPid: 40, readProcess })(100).denied, false);
  // A management request names no caller: a fresh connection asked for none has
  // no verdict and is never looked up.
  assert.equal(callerVerdicts({ daemonPid: 40, readProcess })(undefined), null);
});

test("F6: where no host can read ancestry at all (no /proc, no ps), an unreadable chain is not failed closed", async () => {
  // Windows has neither, so there the marker is the only signal and an unreadable
  // chain must not be treated as a worker; canReadAncestry draws that line.
  assert.equal(canReadAncestry("win32"), false);
  assert.equal(canReadAncestry("linux"), true);
  assert.equal(canReadAncestry("darwin"), true);
  const unreadable = async () => null;
  assert.equal(
    await workerTreeReason({ env: {}, ppid: 100, socketPath: "/nonexistent/gateway.sock", readProcess: unreadable, ancestrySupported: false }),
    null
  );
  assert.equal(await callerVerdicts({ daemonPid: 40, readProcess: unreadable, ancestrySupported: false })(100).denied, false);
});

test("W1: the daemon lock yields a pid only when it holds one", async () => {
  await withTemp("acp-worker-tree-lockfile-", async (directory) => {
    const socketPath = join(directory, "gateway.sock");
    assert.equal(daemonLockPid(socketPath), null, "no lock");
    for (const [text, pid] of [["123\n", 123], ["0\n", null], ["-5", null], ["1.5", null], ["", null], ["abc", null]]) {
      await writeFile(`${socketPath}.lock`, text);
      assert.equal(daemonLockPid(socketPath), pid, JSON.stringify(text));
    }
  });
});

test("W1: a connection's caller is looked up once per pid, and a pid-less request shares its verdict", async () => {
  const { readProcess, reads } = processTable({ ...WORKER_CHAIN, 300: [1, "/Users/me/.local/bin/claude"] });
  const verdictFor = callerVerdicts({ daemonPid: 40, readProcess });
  assert.equal(verdictFor(undefined), null, "no pid named yet: nothing to wait for");
  assert.equal(verdictFor(1), null, "pid 1 is no caller");
  const first = verdictFor(100);
  assert.equal(first.pid, 100);
  assert.equal(await first.denied, true);
  assert.equal(verdictFor(100), first);
  assert.equal(verdictFor(null), first);
  assert.deepEqual(reads, [100, 50, 45], "one lookup while the pid stays the same");
  // Another pid on the connection is checked on its own, and this one is not
  // under the daemon: a denial is not kept for the connection.
  const second = verdictFor(300);
  assert.notEqual(second, first);
  assert.equal(await second.denied, false);
  // 300 is read and found not under the daemon; then (F6) the daemon reads its
  // own live pid once to confirm the host can place callers at all, so 300 is a
  // caller outside it rather than one it cannot read.
  assert.deepEqual(reads, [100, 50, 45, 300, 40]);
  // The daemon itself as the caller's agent CLI: under the daemon by the walk, so
  // it is refused before any probe (the reader is never called).
  assert.equal(await callerVerdicts({ daemonPid: 40, readProcess: () => assert.fail() })(40).denied, true);
});

test("W1: the process reader reads this platform's processes", { skip: !unix }, async () => {
  const self = await readProcessInfo(process.pid);
  assert.equal(self.ppid, process.ppid);
  assert.match(self.command, /node/i);
  // Above every pid_max: no such process.
  assert.equal(await readProcessInfo(2 ** 22 + 1), null);
  assert.equal((await findAncestor(process.pid, { pids: [process.ppid] }))?.pid, process.ppid);
  assert.equal(await runsUnder(process.ppid, process.pid), false, "a parent never runs under its child");
});

// A parent that records its pid in the socket's lock, as the daemon does, then
// starts the real front door (CommonJS, so any file name works). Saved as
// gateway-daemon.js it is daemon-like; under another name it is a process that
// took a dead daemon's pid.
const DAEMON_LIKE_PARENT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
if (process.env.ACP_TEST_PARENT_LOCK) writeFileSync(process.env.ACP_TEST_PARENT_LOCK, process.pid + "\\n");
const child = spawn(process.execPath, [process.env.ACP_TEST_FRONT_DOOR], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
`;

const mcpFrame = (message) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
const INITIALIZE = mcpFrame({
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "w1-worker-tree", version: "1.0.0" } }
});
const INITIALIZED = mcpFrame({ method: "notifications/initialized" });
const SETUP_CALL = mcpFrame({ id: 2, method: "tools/call", params: { name: "agent_acp_setup", arguments: { mode: "summary" } } });

test("W1: a front door under a daemon-like parent refuses before it serves or connects, and a stale lock stops none", { skip: !unix, timeout: 60_000 }, async () => {
  // Short names: the socket path must fit sun_path (104 bytes on macOS).
  await withTemp("acp-wt-parent-", async (directory) => {
    const socketPath = join(directory, "gateway.sock");
    // A stand-in for the daemon's socket: it answers every request with an
    // error and counts the connections, so a front door that got as far as a
    // tool call would show up here.
    const connections = [];
    const server = createServer((socket) => {
      connections.push(socket);
      readNdjson(socket, {
        onLine: (line) => socket.write(`${JSON.stringify({ id: JSON.parse(line).id, ok: false, error: "stand-in socket" })}\n`)
      });
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    const daemonLike = join(directory, "gateway-daemon.js");
    const reused = join(directory, "parent.js");
    for (const file of [daemonLike, reused]) await writeFile(file, DAEMON_LIKE_PARENT);
    const env = {
      ...withoutSessionMarkers(process.env),
      ACP_GATEWAY_SOCKET: socketPath,
      ACP_GATEWAY_STATE: join(directory, "state.json"),
      ACP_GATEWAY_INSTALL_STATE: join(directory, "install.json"),
      // An identity the front door could use: only the refusal stops it.
      ACP_GATEWAY_CONTROL_TOKEN: "worker-tree-test-token-at-least-24",
      ACP_GATEWAY_ROOT_ID: "main-worker-tree",
      ACP_TEST_FRONT_DOOR: frontDoor
    };
    delete env[GATEWAY_WORKER_ENV];
    // Its own process group, so a front door that outlives a failed test can be
    // ended with its parent.
    const startParent = (parent, extra = {}) => {
      const child = spawn(process.execPath, [parent], { stdio: ["pipe", "pipe", "pipe"], env: { ...env, ...extra }, detached: true });
      const output = { stdout: "", stderr: "" };
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk) => { output.stdout += chunk; });
      child.stderr.on("data", (chunk) => { output.stderr += chunk; });
      const exited = once(child, "exit");
      const stop = async () => {
        if (child.exitCode != null || child.signalCode != null) return;
        // stdin closed and the socket gone, a front door has nothing left to serve.
        child.stdin.end();
        for (const socket of connections) socket.destroy();
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 5_000);
        await exited;
        clearTimeout(timer);
      };
      return { child, output, exited, stop };
    };
    try {
      const refused = startParent(daemonLike, { ACP_TEST_PARENT_LOCK: `${socketPath}.lock` });
      try {
        refused.child.stdin.write(INITIALIZE + INITIALIZED + SETUP_CALL);
        const [code] = await within(refused.exited, 15_000, () => `the front door kept running: ${refused.output.stdout}`);
        assert.equal(code, WORKER_TREE_EXIT_CODE, refused.output.stderr);
        assert.match(
          refused.output.stderr,
          new RegExp(`^acp-gateway-control: refusing to start inside a Gateway worker \\(ancestor process ${refused.child.pid} holds the Gateway daemon lock `)
        );
        assert.equal(refused.output.stdout, "", "it never answered initialize");
        assert.equal(connections.length, 0, "it never connected");
      } finally {
        await refused.stop();
      }

      // A parent whose pid is in the lock but whose command line is not the
      // daemon's took a dead daemon's pid: the same front door serves, and its
      // tool call reaches the socket.
      const served = startParent(reused, { ACP_TEST_PARENT_LOCK: `${socketPath}.lock` });
      try {
        served.child.stdin.write(INITIALIZE);
        await waitFor(() => served.output.stdout.includes("\"id\":1"), () => served.output.stderr);
        served.child.stdin.write(INITIALIZED + SETUP_CALL);
        await waitFor(() => served.output.stdout.includes("\"id\":2"), () => served.output.stderr);
        assert.match(served.output.stdout, /stand-in socket/);
        assert.equal(connections.length, 1);
      } finally {
        await served.stop();
      }
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("W1: a front door a real worker's CLI starts is refused, and so is that worker as a Control caller", { skip: !unix, timeout: 120_000 }, async () => {
  // Short names: the socket path must fit sun_path (104 bytes on macOS).
  await withTemp("acp-wt-daemon-", async (directory) => {
    const log = join(directory, "front-door.json");
    const providersPath = join(directory, "providers.json");
    await writeFile(providersPath, JSON.stringify({
      version: 1,
      providers: { configmcp: { command: process.execPath, args: [configMcpAgent], permissionPolicy: "read_only" } }
    }));
    const daemon = await startDaemon({
      directory,
      env: { ACP_GATEWAY_PROVIDERS: providersPath, ACP_MOCK_FRONT_DOOR_LOG: log, ACP_MOCK_DAEMON_SOCKET: join(directory, "gateway.sock") }
    });
    const client = (caller = null) => new GatewayRpcClient({
      socketPath: daemon.socketPath,
      token: daemon.token,
      rootId: daemon.rootId,
      statePath: daemon.statePath,
      autoStart: false,
      ...(caller ? { caller: { provider: "codex", sessionId: null, pid: caller, instanceId: `mcp-test-${caller}` } } : {})
    });
    const clients = [client()];
    const [management] = clients;
    try {
      // The worker's CLI starts the Control MCP while it starts up, before the session opens.
      await management.call("session_open", { provider: "configmcp", cwd: directory, permissionPolicy: "read_only" });
      const seen = JSON.parse(await readFile(log, "utf8"));
      assert.equal(seen.marker, "1", "the daemon marked its worker");
      assert.equal(seen.inherited.status, WORKER_TREE_EXIT_CODE, seen.inherited.stderr);
      assert.match(seen.inherited.stderr, /\(ACP_GATEWAY_WORKER=1 is set\)/);
      // Without the marker, as under Codex: the daemon's own command line gives it away.
      assert.equal(seen.cleared.status, WORKER_TREE_EXIT_CODE, seen.cleared.stderr);
      assert.match(seen.cleared.stderr, new RegExp(`ancestor process ${daemon.child.pid} runs the Gateway daemon: .*gateway-daemon\\.js`));
      // On the daemon's own socket, its lock does.
      assert.equal(seen.socket.status, WORKER_TREE_EXIT_CODE, seen.socket.stderr);
      assert.match(seen.socket.stderr, new RegExp(`ancestor process ${daemon.child.pid} holds the Gateway daemon lock`));

      // The daemon's side: a caller whose agent CLI is that worker, or the daemon
      // itself, is refused whatever it holds, and cannot stop the daemon either.
      const isWorkerDenied = (pid) => (error) => {
        assert.equal(error.code, ERROR_CODES.WORKER_CONTROL_DENIED);
        assert.equal(error.message, `Control access denied: caller process ${pid} runs inside a Gateway worker`);
        return true;
      };
      const worker = client(seen.pid);
      clients.push(worker);
      await assert.rejects(worker.call("setup", { mode: "summary" }), isWorkerDenied(seen.pid));
      await assert.rejects(worker.call("session", { action: "list" }), isWorkerDenied(seen.pid));
      await assert.rejects(worker.call("daemon_shutdown", {}), isWorkerDenied(seen.pid));
      const itself = client(daemon.child.pid);
      clients.push(itself);
      await assert.rejects(itself.call("setup", { mode: "summary" }), isWorkerDenied(daemon.child.pid));

      // A caller above the daemon (this test started it) and a management client
      // with no caller are untouched, and the daemon is still up.
      const main = client(process.pid);
      clients.push(main);
      assert.equal((await main.call("setup", { mode: "summary" })).ok, true);
      const listed = await management.call("session", { action: "list" });
      assert.equal(listed.sessions.length, 1);
    } finally {
      for (const each of clients) each.close();
      await daemon.stop();
    }
  });
});

// ---------------------------------------------------------------------- W12

const assertRefused = (server) => assert.throws(
  () => sanitizeWorkerMcpServers([server]),
  (error) => error.code === ERROR_CODES.INVALID_ARGUMENT && /cannot be injected/.test(error.message),
  JSON.stringify(server)
);

test("W12: a worker session refuses the Control MCP however it is named, launched or configured", async () => {
  await withTemp("acp-w12-", async (directory) => {
    const plain = { name: "tools", command: "node", args: ["/opt/tools/server.js"] };
    // The identity, or where it is kept, in the env: ACP's [{name, value}] or an object.
    assertRefused({ ...plain, env: { ACP_GATEWAY_CONTROL_TOKEN: "w12-control-token-at-least-24-chars" } });
    assertRefused({ ...plain, env: [{ name: "ACP_GATEWAY_CONTROL_TOKEN", value: "w12-control-token-at-least-24-chars" }] });
    assertRefused({ ...plain, env: [{ name: "PATH", value: "/bin" }, { name: "ACP_GATEWAY_ROOT_ID", value: "main-a" }] });
    assertRefused({ ...plain, env: { ACP_GATEWAY_INSTALL_STATE: "/elsewhere/install.json" } });

    // An installed runtime's entry, which no name pattern catches: the layout
    // ~/.acp-gateway/runtime/current/gateway/src/ has, here in a temp dir.
    const runtime = join(directory, "runtime", "current", "gateway", "src");
    await mkdir(runtime, { recursive: true });
    for (const file of ["index.js", "gateway-daemon.js", "guide.js"]) await writeFile(join(runtime, file), "");
    const entry = join(runtime, "index.js");
    assertRefused({ name: "tools", command: process.execPath, args: [entry] });
    assertRefused({ name: "tools", command: process.execPath, args: ["--no-warnings", `--entry=${entry}`] });
    assertRefused({ name: "tools", command: "/bin/sh", args: ["-c", `exec node '${entry}'`] });
    // Through a symlink, as a bin is.
    await mkdir(join(directory, "bin"));
    await symlink(entry, join(directory, "bin", "team-tools"));
    assertRefused({ name: "tools", command: join(directory, "bin", "team-tools") });
    // What a shell would expand.
    const home = process.env.HOME;
    process.env.HOME = directory;
    try {
      assertRefused({ name: "tools", command: "/bin/sh", args: ["-c", "node ~/runtime/current/gateway/src/index.js"] });
      assertRefused({ name: "tools", command: "/bin/sh", args: ["-c", "exec node \"$HOME/runtime/current/gateway/src/index.js\""] });
    } finally {
      process.env.HOME = home;
    }
    // This package's own entry, and its bins by name.
    assertRefused({ name: "tools", command: process.execPath, args: [frontDoor] });
    for (const bin of ["acp-gateway", "acp-gateway-control", "acp-mcp-bridge", "/usr/local/bin/acp-gateway"]) assertRefused({ name: "tools", command: bin });
    assertRefused({ name: "tools", command: "npx", args: ["--yes", "--package", "some-gateway-fork", "acp-gateway"] });

    // Servers that only look alike are kept as they are.
    const other = join(directory, "other");
    await mkdir(other);
    await writeFile(join(other, "index.js"), "");
    const allowed = [
      { name: "project-guide", command: "guide-mcp" },
      { name: "agent-acp-guide", command: "acp-gateway-guide" },
      // An install's guide is not its Control.
      { name: "gateway-guide", command: process.execPath, args: [join(runtime, "guide.js")] },
      // An index.js with no daemon beside it is somebody else's server.
      { name: "fs", command: process.execPath, args: [join(other, "index.js")], env: [{ name: "API_KEY", value: "k" }] },
      { name: "named", command: "node", args: ["/opt/tools/server.js"], env: { ACP_GATEWAY_WORKSPACES: "/w" } },
      { type: "http", name: "web", url: "https://example.com/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] }
    ];
    assert.deepEqual(sanitizeWorkerMcpServers(structuredClone(allowed)), allowed);
  });
});

// Review: a word was refused for its last name alone, so a filesystem server
// rooted at a checkout called acp-gateway never opened. A path now counts by
// what is there.
test("W12: a directory is never refused for its name, and what runs the Control still is", async () => {
  await withTemp("acp-w12-paths-", async (directory) => {
    const checkout = join(directory, "src", "acp-gateway");
    const bridge = join(directory, "src", "acp-mcp-bridge");
    const tool = join(bridge, "tools", "server.js");
    await mkdir(checkout, { recursive: true });
    await mkdir(dirname(tool), { recursive: true });
    await writeFile(tool, "");
    const filesystem = (root) => ({ name: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", root] });
    const kept = [
      // Project roots named like a Control bin, or mentioning one.
      filesystem(checkout),
      filesystem(`${checkout}/`),
      filesystem(bridge),
      // As an argument, a path not there (moved, or yet to be made) or one
      // relative to a cwd the daemon does not know is no bin by its name.
      filesystem("/Users/me/src/acp-gateway"),
      filesystem("../acp-gateway"),
      // A file counts by its own name, not by the directories it sits in.
      { name: "tools", command: process.execPath, args: [tool, `--root=${bridge}`] },
      { name: "tools", command: "/bin/sh", args: ["-c", `cd '${checkout}' && exec node '${tool}'`] }
    ];
    assert.deepEqual(sanitizeWorkerMcpServers(structuredClone(kept)), kept);
    const home = process.env.HOME;
    process.env.HOME = directory;
    try {
      const underHome = [filesystem("~/src/acp-gateway"), filesystem("$HOME/src/acp-mcp-bridge")];
      assert.deepEqual(sanitizeWorkerMcpServers(structuredClone(underHome)), underHome);
    } finally {
      process.env.HOME = home;
    }

    // A Gateway checked out as acp-mcp-bridge: its Control entry, and its daemon by the file's name.
    const source = join(bridge, "src");
    await mkdir(source);
    for (const file of ["index.js", "gateway-daemon.js"]) await writeFile(join(source, file), "");
    assertRefused({ name: "tools", command: process.execPath, args: [join(source, "index.js")] });
    assertRefused({ name: "tools", command: process.execPath, args: [join(source, "gateway-daemon.js")] });
    // A bin installed as a shim (pnpm, Volta) rather than a link to the entry:
    // a file of the bin's name, run directly, from a script, or through a link.
    const shims = join(directory, "shims");
    await mkdir(shims);
    await writeFile(join(shims, "acp-gateway"), "#!/bin/sh\nexec node /elsewhere/src/index.js \"$@\"\n");
    await symlink(join(shims, "acp-gateway"), join(shims, "team-tools"));
    assertRefused({ name: "tools", command: join(shims, "acp-gateway") });
    assertRefused({ name: "tools", command: "/bin/sh", args: ["-c", `exec '${join(shims, "acp-gateway")}' --verbose`] });
    assertRefused({ name: "tools", command: join(shims, "team-tools") });
    // The command is never a directory: one named like a bin that is not there,
    // or relative, is that bin.
    assertRefused({ name: "tools", command: join(directory, "gone", "acp-gateway") });
    assertRefused({ name: "tools", command: "./node_modules/.bin/acp-gateway" });
  });
});

// A promise that fails the test instead of hanging it.
async function within(promise, ms, describe) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${describe()}`)), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate, describe, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out: ${describe()}`);
}
