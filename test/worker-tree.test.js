import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GATEWAY_WORKER_ENV, withoutSessionMarkers, workerEnv } from "../src/caller.js";
import { ERROR_CODES } from "../src/errors.js";
import { sanitizeWorkerMcpServers } from "../src/gateway-service.js";
import { readNdjson } from "../src/ndjson.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import {
  callerVerdicts, daemonLockPid, findAncestor, MAX_ANCESTRY_DEPTH, readProcessInfo, runsGatewayDaemon, runsUnder,
  WORKER_TREE_EXIT_CODE, workerTreeReason
} from "../src/worker-tree.js";
import { startDaemon } from "./helpers/daemon-harness.js";

// W1 (1.8.0 review): a Codex worker the daemon started loaded the user's own
// ~/.codex/config.toml and launched the Control MCP registered there, which
// found its identity and handed the worker every agent_acp_* tool. Workers never
// get the Control: the front door refuses to start under one, and the daemon
// refuses a caller that runs under it. W12: the session-level check on the MCP
// servers a Main hands a worker missed the installed runtime and the identity env.

const frontDoor = fileURLToPath(new URL("../src/index.js", import.meta.url));
const configMcpAgent = fileURLToPath(new URL("./mock-config-mcp-agent.js", import.meta.url));
const unix = process.platform !== "win32";

async function withTemp(prefix, body) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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
    // A daemon run by a binary whose command line names nothing: only the lock says what it is.
    const { readProcess, reads } = processTable({ ...WORKER_CHAIN, 40: [1, "/Applications/Some App.app/Contents/MacOS/Some App"] });
    const reason = await workerTreeReason({ env: {}, ppid: 100, socketPath, readProcess });
    assert.equal(reason, `ancestor process 40 holds the Gateway daemon lock ${socketPath}.lock`);
    assert.deepEqual(reads, [100, 50, 45], "the lock pid is matched without reading it");
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
    assert.equal(await workerTreeReason({ env: {}, ppid: 100, socketPath: "/nonexistent/gateway.sock", readProcess }), null);
  }
  // A chain that loops (a pid reused mid-walk) ends instead of spinning to the bound.
  const loop = processTable({ 10: [11, "a"], 11: [10, "b"] });
  assert.equal(await findAncestor(10, { pids: [40], readProcess: loop.readProcess }), null);
  assert.deepEqual(loop.reads, [10, 11]);
  for (const pid of [0, -1, 1.5, null, undefined]) assert.equal(await findAncestor(pid, { pids: [pid], readProcess: () => assert.fail() }), null);
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

test("W1: a connection's caller is looked up once, and a pid-less request shares its verdict", async () => {
  const { readProcess, reads } = processTable({ ...WORKER_CHAIN, 300: [1, "/Users/me/.local/bin/claude"] });
  const verdictFor = callerVerdicts({ daemonPid: 40, readProcess });
  assert.equal(verdictFor(undefined), null, "no pid named yet: nothing to wait for");
  assert.equal(verdictFor(1), null, "pid 1 is no caller");
  const first = verdictFor(100);
  assert.equal(first.pid, 100);
  assert.equal(await first.denied, true);
  assert.equal(verdictFor(100), first);
  assert.equal(verdictFor(null), first);
  assert.deepEqual(reads, [100, 50, 45], "one lookup for the connection");
  // Another pid on the connection is another lookup; this one is not under the daemon.
  const second = verdictFor(300);
  assert.notEqual(second, first);
  assert.equal(await second.denied, false);
  assert.deepEqual(reads, [100, 50, 45, 300]);
  // The daemon itself as the caller's agent CLI.
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

// A daemon-like parent: it records its pid in the socket's lock, as the daemon
// does, then starts the real front door (CommonJS, so any file name works).
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

test("W1: a front door under a daemon-like parent refuses before it serves or connects", { skip: !unix, timeout: 60_000 }, async () => {
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
    const parent = join(directory, "parent.js");
    await writeFile(parent, DAEMON_LIKE_PARENT);
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
    const startParent = (extra = {}) => {
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
      const refused = startParent({ ACP_TEST_PARENT_LOCK: `${socketPath}.lock` });
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

      // The same parent without the lock is an ordinary process: the same front
      // door serves, and its tool call reaches the socket.
      await rm(`${socketPath}.lock`);
      const served = startParent();
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

test("W12: a worker session refuses the Control MCP however it is named, launched or configured", async () => {
  await withTemp("acp-w12-", async (directory) => {
    const refused = (server) => assert.throws(
      () => sanitizeWorkerMcpServers([server]),
      (error) => error.code === ERROR_CODES.INVALID_ARGUMENT && /cannot be injected/.test(error.message),
      JSON.stringify(server)
    );
    const plain = { name: "tools", command: "node", args: ["/opt/tools/server.js"] };
    // The identity, or where it is kept, in the env: ACP's [{name, value}] or an object.
    refused({ ...plain, env: { ACP_GATEWAY_CONTROL_TOKEN: "w12-control-token-at-least-24-chars" } });
    refused({ ...plain, env: [{ name: "ACP_GATEWAY_CONTROL_TOKEN", value: "w12-control-token-at-least-24-chars" }] });
    refused({ ...plain, env: [{ name: "PATH", value: "/bin" }, { name: "ACP_GATEWAY_ROOT_ID", value: "main-a" }] });
    refused({ ...plain, env: { ACP_GATEWAY_INSTALL_STATE: "/elsewhere/install.json" } });

    // An installed runtime's entry, which no name pattern catches: the layout
    // ~/.acp-gateway/runtime/current/gateway/src/ has, here in a temp dir.
    const runtime = join(directory, "runtime", "current", "gateway", "src");
    await mkdir(runtime, { recursive: true });
    for (const file of ["index.js", "gateway-daemon.js", "guide.js"]) await writeFile(join(runtime, file), "");
    const entry = join(runtime, "index.js");
    refused({ name: "tools", command: process.execPath, args: [entry] });
    refused({ name: "tools", command: process.execPath, args: ["--no-warnings", `--entry=${entry}`] });
    refused({ name: "tools", command: "/bin/sh", args: ["-c", `exec node '${entry}'`] });
    // Through a symlink, as a bin is.
    await mkdir(join(directory, "bin"));
    await symlink(entry, join(directory, "bin", "team-tools"));
    refused({ name: "tools", command: join(directory, "bin", "team-tools") });
    // What a shell would expand.
    const home = process.env.HOME;
    process.env.HOME = directory;
    try {
      refused({ name: "tools", command: "/bin/sh", args: ["-c", "node ~/runtime/current/gateway/src/index.js"] });
      refused({ name: "tools", command: "/bin/sh", args: ["-c", "exec node \"$HOME/runtime/current/gateway/src/index.js\""] });
    } finally {
      process.env.HOME = home;
    }
    // This package's own entry, and its bins by name.
    refused({ name: "tools", command: process.execPath, args: [frontDoor] });
    for (const bin of ["acp-gateway", "acp-gateway-control", "acp-mcp-bridge", "/usr/local/bin/acp-gateway"]) refused({ name: "tools", command: bin });
    refused({ name: "tools", command: "npx", args: ["--yes", "--package", "some-gateway-fork", "acp-gateway"] });

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
