import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { GATEWAY_WORKER_ENV, withoutSessionMarkers, workerEnv } from "../src/caller.js";
import { ERROR_CODES } from "../src/errors.js";
import { GatewayService, sanitizeWorkerMcpServers } from "../src/gateway-service.js";
import { readNdjson } from "../src/ndjson.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import {
  callerVerdicts, canReadAncestry, daemonLockPid, findAncestor, MAX_ANCESTRY_DEPTH, readProcessInfo, runsGatewayDaemon,
  runsUnder, WORKER_CALLER_ANCESTRY_UNVERIFIABLE, WORKER_CALLER_UNDER_DAEMON, WORKER_CALLER_UNDER_SPAWNED,
  WORKER_TREE_ANCESTRY_UNREADABLE, WORKER_TREE_EXIT_CODE, workerControlDeniedMessage, workerTreeReason, workerTreeRefusalMessage
} from "../src/worker-tree.js";
import { startDaemon } from "./helpers/daemon-harness.js";
import { processGone, withEnv, withTemp } from "./helpers/scratch.js";

// W1 (1.8.0 review): a Codex worker the daemon started loaded the user's own
// ~/.codex/config.toml and launched the Control MCP registered there, which
// found its identity and handed the worker every agent_acp_* tool. Workers never
// get the Control: the front door refuses to start under one, and the daemon
// refuses a caller that runs under it. W12: the session-level check on the MCP
// servers a Main hands a worker missed the installed runtime and the identity env.

const frontDoor = fileURLToPath(new URL("../src/index.js", import.meta.url));
const configMcpAgent = fileURLToPath(new URL("./mock-config-mcp-agent.js", import.meta.url));
const capabilityAgent = fileURLToPath(new URL("./mock-capability-agent.js", import.meta.url));
const permissionAgent = fileURLToPath(new URL("./mock-permission-agent.js", import.meta.url));
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

const byPid = (pids) => [...pids].sort((a, b) => a - b);

// Terminal scripts that say "ready" once they run: one that is done then, one
// that keeps running, and one that also ignores SIGTERM.
const READY = "console.log('ready');";
const READY_AND_RUNNING = "console.log('ready'); setInterval(() => {}, 1000);";
const STUBBORN = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);";

// One turn of the permission mock on a started client that opens a terminal for
// each script and leaves it to run (hold); the terminals' records, once each has
// said it runs.
async function heldTerminals(client, cwd, scripts) {
  const { sessionId } = await client.sessionNew({ cwd, permissionPolicy: "auto_approve" });
  const steps = scripts.map((script) => ({ terminal: { command: process.execPath, args: ["-e", script], hold: true } }));
  const held = await client.sessionPrompt({ sessionId, prompt: JSON.stringify({ steps }) });
  assert.deepEqual(JSON.parse(held.stopReason), steps.map(() => "terminal-held"));
  const terminals = [...client.terminals.values()];
  for (const terminal of terminals) await waitFor(() => terminal.outputBuffer.toString().includes("ready"), () => "a terminal to start");
  return terminals;
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
    // One whose command line cannot be read still counts where this process
    // (150, in none of these tables) cannot read its own entry either: gone
    // from the table, a read that fails, or an empty command line. Where it
    // can, see R1 below.
    const unlisted = { ...WORKER_CHAIN };
    delete unlisted[40];
    for (const unreadable of [
      processTable(unlisted).readProcess,
      async (pid) => {
        if (pid === 40) throw new Error("ps failed");
        return processTable(WORKER_CHAIN).readProcess(pid);
      },
      processTable({ ...WORKER_CHAIN, 40: [1, " "] }).readProcess
    ]) assert.equal(await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess: unreadable }), held);
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
    assert.equal(await callerVerdicts({ daemonPid: 1, readProcess })(100).denied, null);
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
    // Refused as unverifiable, not mislabelled a worker that runs under the daemon.
    assert.equal(await callerVerdicts({ daemonPid: 40, readProcess })(100).denied, WORKER_CALLER_ANCESTRY_UNVERIFIABLE);
  }
  // The marker decides before any lookup, unreadable chain or not.
  assert.equal(
    await workerTreeReason({ env: { [GATEWAY_WORKER_ENV]: "1" }, ppid: 100, socketPath: "/nonexistent/gateway.sock", readProcess: () => assert.fail("the marker decides first") }),
    "ACP_GATEWAY_WORKER=1 is set"
  );
});

test("F6: the daemon denial reason words the unverifiable host apart from a worker", () => {
  assert.equal(
    workerControlDeniedMessage(WORKER_CALLER_UNDER_DAEMON, 4242),
    "Control access denied: caller process 4242 runs inside a Gateway worker"
  );
  assert.equal(
    workerControlDeniedMessage(WORKER_CALLER_ANCESTRY_UNVERIFIABLE, 4242),
    "Control access denied: caller process 4242 ancestry cannot be verified on this host"
  );
});

test("F6: a readable chain with no daemon is allowed, and a no-caller request is never refused", async () => {
  // Read all the way to pid 1, no daemon above: a Main, allowed at both ends. The
  // daemon (pid 40) is alive and readable, so the daemon-side probe finds the
  // host healthy and the caller merely outside it.
  const { readProcess } = processTable({ 100: [90, "/bin/zsh"], 90: [1, "/sbin/launchd"], 40: [1, "node /x/gateway-daemon.js"] });
  assert.equal(await workerTreeReason({ env: {}, ppid: 100, socketPath: "/nonexistent/gateway.sock", readProcess }), null);
  assert.equal(await callerVerdicts({ daemonPid: 40, readProcess })(100).denied, null);
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
  assert.equal(await callerVerdicts({ daemonPid: 40, readProcess: unreadable, ancestrySupported: false })(100).denied, null);
});

// R1 (1.8.0 release review): with /proc mounted hidepid=1 or 2 a user cannot
// see another user's processes, so the walk of a Main started over SSH is cut
// short at the root-owned sshd above its login shell, and F6 refused that Main
// (exit 77) although /proc and ps work. The front door now fails closed on a
// walk cut short only where it cannot read its own entry either, the broken
// host F6 is about; anywhere else the walk ends there, no daemon above.
test("R1: a walk cut short by a process this user cannot see ends there, unless this process cannot read itself either", async () => {
  const socketPath = "/nonexistent/gateway.sock";
  // The front door (150), the agent CLI, the login shell and sshd's session
  // process are this user's; sshd's privileged monitor above them (60) is
  // root's, and hidepid hides it: its read fails as a gone process's would.
  const sshMain = {
    150: [100, "node /home/me/.acp-gateway/runtime/current/gateway/src/index.js"],
    100: [90, "/home/me/.local/bin/claude"],
    90: [80, "-bash"],
    80: [60, "sshd: me@pts/0"]
  };
  const hidden = processTable(sshMain);
  assert.equal(await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess: hidden.readProcess }), null);
  assert.deepEqual(hidden.reads, [100, 90, 80, 60, 150], "up to the hidden process, then this process's own entry");
  // A read of the hidden process that throws (ps refusing it) ends the walk alike.
  const refusing = async (pid) => {
    if (pid === 60) throw new Error("ps refused");
    return processTable(sshMain).readProcess(pid);
  };
  assert.equal(await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess: refusing }), null);

  // A worker's chain reaches the daemon through this user's own processes,
  // which hidepid never hides, so the daemon is found before anything hidden.
  const underDaemon = processTable({ ...WORKER_CHAIN, 150: [100, "node /x/src/index.js"], 40: [35, WORKER_CHAIN[40][1]] });
  assert.match(
    await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess: underDaemon.readProcess }),
    /^ancestor process 40 runs the Gateway daemon: /
  );
  assert.deepEqual(underDaemon.reads, [100, 50, 45, 40], "neither the process above it nor this one is read");

  // This process cannot read even itself: the host can place no process, and
  // the front door is refused as unverifiable, not as a worker.
  const noSelf = { ...sshMain };
  delete noSelf[150];
  for (const readProcess of [
    processTable(noSelf).readProcess,
    async (pid) => {
      if (pid === 150) throw new Error("ps blocked");
      return processTable(noSelf).readProcess(pid);
    }
  ]) assert.equal(await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess }), WORKER_TREE_ANCESTRY_UNREADABLE);
  // Only a walk cut short asks: one read all the way to pid 1 never does.
  const whole = processTable({ ...noSelf, 80: [1, "sshd: me@pts/0"] });
  assert.equal(await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess: whole.readProcess }), null);
  assert.deepEqual(whole.reads, [100, 90, 80]);

  // Where no ancestry is read at all (Windows), nothing changes: marker only,
  // and this process is never probed.
  const nothing = processTable({});
  assert.equal(await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess: nothing.readProcess, ancestrySupported: false }), null);
  assert.deepEqual(nothing.reads, [100]);
  // The marker still decides before any of it.
  assert.equal(
    await workerTreeReason({ env: { [GATEWAY_WORKER_ENV]: "1" }, pid: 150, ppid: 100, socketPath, readProcess: () => assert.fail("the marker decides first") }),
    "ACP_GATEWAY_WORKER=1 is set"
  );
});

// The same hidepid, and the daemon lock: a lock pid whose command line cannot
// be read counted as the daemon, so a stale lock whose pid a root-owned process
// above a Main had taken (sshd's, over SSH) refused that Main. The daemon runs
// as this user, whose processes hidepid never hides, so an unreadable lock pid
// is the daemon only where this process cannot read its own entry either.
test("R1: an unreadable lock pid is the daemon only where this process cannot read its own entry either", async () => {
  await withTemp("acp-r1-lock-", async (directory) => {
    const socketPath = join(directory, "gateway.sock");
    const held = (pid) => `ancestor process ${pid} holds the Gateway daemon lock ${socketPath}.lock`;
    // The SSH Main of the test above. The stale lock names sshd's monitor (60),
    // root's, which hidepid hides from this user.
    const sshMain = {
      150: [100, "node /home/me/.acp-gateway/runtime/current/gateway/src/index.js"],
      100: [90, "/home/me/.local/bin/claude"],
      90: [80, "-bash"],
      80: [60, "sshd: me@pts/0"]
    };
    await writeFile(`${socketPath}.lock`, "60\n");
    const hidden = processTable(sshMain);
    assert.equal(await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess: hidden.readProcess }), null);
    assert.deepEqual(hidden.reads, [100, 90, 80, 60, 150], "the lock pid, then this process's own entry, once");
    // A read of it that throws (ps refusing it) reads the same.
    const refusing = async (pid) => {
      if (pid === 60) throw new Error("ps refused");
      return processTable(sshMain).readProcess(pid);
    };
    assert.equal(await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess: refusing }), null);
    // A lock pid that can be read but names no command (a zombie, a kernel
    // thread) is passed like any other process: the walk goes on above it, and
    // a daemon there is still found by its command line.
    await writeFile(`${socketPath}.lock`, "50\n");
    const blank = processTable({ ...WORKER_CHAIN, 150: [100, "node /x/src/index.js"], 50: [45, " "] });
    assert.match(
      await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess: blank.readProcess }),
      /^ancestor process 40 runs the Gateway daemon: /
    );
    assert.deepEqual(blank.reads, [100, 50, 150, 45, 40]);

    // This process cannot read even itself: an unreadable lock pid still
    // counts, as it always did.
    await writeFile(`${socketPath}.lock`, "60\n");
    const noSelf = { ...sshMain };
    delete noSelf[150];
    assert.equal(await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess: processTable(noSelf).readProcess }), held(60));
    await writeFile(`${socketPath}.lock`, "50\n");
    const blankNoSelf = processTable({ ...WORKER_CHAIN, 50: [45, " "] });
    assert.equal(await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess: blankNoSelf.readProcess }), held(50));
    // A lock pid that runs the daemon counts at once, and this process is not read.
    await writeFile(`${socketPath}.lock`, "40\n");
    const daemon = processTable({ ...WORKER_CHAIN, 150: [100, "node /x/src/index.js"] });
    assert.equal(await workerTreeReason({ env: {}, pid: 150, ppid: 100, socketPath, readProcess: daemon.readProcess }), held(40));
    assert.deepEqual(daemon.reads, [100, 50, 45, 40]);
  });
});

// R2 (1.8.0 release review): the front door said "refusing to start inside a
// Gateway worker" also when it had found no worker, only an ancestry it could
// not read. It now says it cannot tell.
test("R2: the front door's refusal names the worker it found, or says it cannot tell", async () => {
  await withTemp("acp-r2-", async (directory) => {
    const socketPath = join(directory, "gateway.sock");
    await writeFile(`${socketPath}.lock`, "40\n");
    const { readProcess } = processTable(WORKER_CHAIN);
    const found = [
      await workerTreeReason({ env: { [GATEWAY_WORKER_ENV]: "1" }, ppid: 100, socketPath, readProcess }),
      await workerTreeReason({ env: {}, ppid: 100, socketPath, readProcess }),
      await workerTreeReason({ env: {}, ppid: 100, socketPath: join(directory, "other.sock"), readProcess })
    ];
    assert.deepEqual(found.map((reason) => reason.split(" ").slice(0, 4).join(" ")), [
      "ACP_GATEWAY_WORKER=1 is set",
      "ancestor process 40 holds",
      "ancestor process 40 runs"
    ]);
    for (const reason of found) {
      assert.equal(
        workerTreeRefusalMessage(reason),
        `acp-gateway-control: refusing to start inside a Gateway worker (${reason}). `
          + "Only a Main's agent CLI may run the Control MCP; workers never get it."
      );
    }
    const unreadable = await workerTreeReason({ env: {}, ppid: 100, socketPath, readProcess: async () => null });
    assert.equal(unreadable, WORKER_TREE_ANCESTRY_UNREADABLE);
    assert.equal(
      workerTreeRefusalMessage(unreadable),
      "acp-gateway-control: refusing to start: it cannot tell whether it runs inside a Gateway worker, because its process "
        + "ancestry cannot be read (no /proc, and ps is missing or blocked). Workers never get the Control, so it starts only "
        + "once /proc or ps is available."
    );
  });
});

// F5 (1.8.0 review): when the daemon is pid 1 (a container entrypoint with no
// init) the ancestry walk cannot match a caller to the daemon's own pid — pid 1
// ends every chain — so a worker whose CLI forwards no marker (Codex) was not
// told from a Main by that test. The daemon now also refuses a caller that is or
// runs under one of the actual processes it spawned (providers and terminals),
// whose pids are real children and never 1.
test("F5: a caller that is or descends from a spawned process is refused, even when the daemon is pid 1", async () => {
  // The daemon is pid 1; 7000 is the provider it spawned, 8100 one of that
  // provider's terminals. The control MCP the worker starts is or runs under them.
  const { readProcess } = processTable({
    8300: [8100, "node /x/control/src/index.js"], // control MCP under the terminal
    8100: [7000, "/bin/bash -lc codex"],          // terminal child
    7000: [1, "codex app-server"],                // provider, child of the pid-1 daemon
    1: [0, "/sbin/init"]
  });
  const spawnedPids = () => [7000, 8100];
  // The caller IS the provider pid: matched before any read.
  assert.equal(
    await callerVerdicts({ daemonPid: 1, spawnedPids, readProcess: () => assert.fail("a pid match needs no read") })(7000).denied,
    WORKER_CALLER_UNDER_SPAWNED
  );
  // The caller DESCENDS from the terminal pid.
  assert.equal(await callerVerdicts({ daemonPid: 1, spawnedPids, readProcess })(8300).denied, WORKER_CALLER_UNDER_SPAWNED);
});

test("F5: a pid gone from the spawned set is no longer refused, so a reused pid is not stale-denied", async () => {
  // 8100 was a terminal; its child exited and the pid now belongs to an unrelated
  // process that goes straight to init. The daemon is pid 1, so nothing else can
  // place the caller.
  const { readProcess } = processTable({ 8100: [1, "/usr/bin/some-reused-tool"], 1: [0, "/sbin/init"] });
  // While 8100 is tracked, a caller that is it is refused.
  assert.equal(await callerVerdicts({ daemonPid: 1, spawnedPids: () => [8100], readProcess })(8100).denied, WORKER_CALLER_UNDER_SPAWNED);
  // Once it leaves the set, the same pid is allowed: the pid-1 daemon is readable,
  // so the host can place callers and this one runs outside everything tracked.
  assert.equal(await callerVerdicts({ daemonPid: 1, spawnedPids: () => [], readProcess })(8100).denied, null);
});

test("F5: a Main outside every spawned process is allowed; the daemon-pid test and no-caller are unchanged", async () => {
  // Spawned processes exist, but this Main's chain touches none; the daemon (40)
  // is alive and readable.
  const { readProcess } = processTable({ 100: [90, "/bin/zsh"], 90: [1, "/sbin/launchd"], 40: [1, "node /x/src/gateway-daemon.js"], 1: [0, "/sbin/init"] });
  const spawnedPids = () => [7000, 8100];
  assert.equal(await callerVerdicts({ daemonPid: 40, spawnedPids, readProcess })(100).denied, null);
  // A management request names no caller: never looked up, spawned set or not.
  assert.equal(callerVerdicts({ daemonPid: 40, spawnedPids, readProcess })(undefined), null);
  // The daemon-pid test still fires for a caller that is the daemon itself but not
  // in the spawned set — a pid match needs no read.
  assert.equal(
    await callerVerdicts({ daemonPid: 40, spawnedPids, readProcess: () => assert.fail() })(40).denied,
    WORKER_CALLER_UNDER_DAEMON
  );
});

test("F5: the spawned-worker denial carries the worker message", () => {
  assert.equal(
    workerControlDeniedMessage(WORKER_CALLER_UNDER_SPAWNED, 4242),
    "Control access denied: caller process 4242 runs inside a Gateway worker"
  );
});

test("F5: a started client reports its provider pid and drops it on stop", async () => {
  const client = new AcpClient({ provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "auto_approve" });
  await client.start();
  try {
    assert.ok(Number.isInteger(client.proc.pid));
    assert.deepEqual(client.spawnedPids(), [client.proc.pid], "just the live provider");
  } finally {
    await client.stop();
  }
  assert.deepEqual(client.spawnedPids(), [], "nothing after stop nulls the provider");
});

test("F5: a client includes a live terminal pid and drops it once the terminal exits", { skip: !unix }, async () => {
  // The provider and each terminal count while their processes run; one that has
  // exited is left out even while its record lingers in `terminals` until the
  // worker releases it.
  await withTemp("acp-f5-terminals-", async (directory) => {
    const client = new AcpClient(
      { provider: "mock", command: process.execPath, args: [permissionAgent], permissionPolicy: "auto_approve" },
      { protectedPaths: [], terminalSandbox: null }
    );
    try {
      await client.start();
      const [done, running] = await heldTerminals(client, directory, [READY, READY_AND_RUNNING]);
      await waitFor(() => done.exitStatus !== null, () => "the first terminal to exit");
      assert.equal(client.terminals.size, 2, "its record lingers");
      assert.deepEqual(byPid(client.spawnedPids()), byPid([client.proc.pid, running.child.pid]));
    } finally {
      await client.stop();
    }
    assert.deepEqual(client.spawnedPids(), [], "stop() ended the provider and the running terminal");
  });
});

test("F5: every client the service creates keeps its pids in one set of the service's, read as a copy", async () => {
  await withTemp("acp-f5-service-", async (directory) => {
    const handed = [];
    const service = new GatewayService({
      statePath: join(directory, "state.json"),
      gcIntervalMs: 0,
      artifactStore: { create: () => null },
      // An injected factory gets the set in its options, as an AcpClient does.
      createClient: (_provider, options) => {
        handed.push(options.spawnedProcesses);
        return { alive: true, initResult: {}, start: async () => ({}), stop: async () => {} };
      }
    });
    try {
      const first = await service.getClient("claude");
      // Gone, so the next start creates another client.
      first.alive = false;
      await service.getClient("claude");
      assert.equal(handed.length, 2);
      assert.ok(handed[0] instanceof Set);
      assert.equal(handed[1], handed[0], "one set for every client");
      // A client adds a child's pid at its spawn and removes it at its exit.
      handed[0].add(101).add(102);
      const pids = service.spawnedPids();
      assert.deepEqual(byPid(pids), [101, 102]);
      pids.delete(101);
      assert.deepEqual(byPid(service.spawnedPids()), [101, 102], "a copy: the caller check cannot change the set");
      handed[1].delete(101);
      assert.deepEqual(byPid(service.spawnedPids()), [102]);
    } finally {
      await service.shutdown();
    }
  });
});

// R4 (1.8.0 release review): a teardown dropped the provider's or a terminal's
// handle as it started (#fail, a released terminal, a closed session's) or once
// stop()'s bounded wait was over, and the pid left spawnedPids() with it, while
// a process that ignores SIGTERM runs on through the grace; and the service
// counted only the clients it still held, so a retired client gc had dropped
// before its stop() was done, a dead one a new start had replaced, or one whose
// start was under way or had failed counted for nothing. Under a pid-1 daemon a
// markerless Control MCP one of their processes started then was not refused.
// Each client now keeps every child's pid, in its own set and in one the service
// hands it, from the spawn until the child's exit.

// A GatewayService whose clients run the permission mock, with its state in
// directory. The nth client it creates takes starts[n] (later ones are
// ordinary): a stubborn one ignores SIGTERM and gets a grace no test waits out,
// so the test ends it; any other entry is an AcpClient option. shutdown() first
// ends whatever a failed test left running.
function mockService(directory, starts = []) {
  const created = [];
  const service = new GatewayService({
    statePath: join(directory, "state.json"),
    gcIntervalMs: 0,
    createClient: (_provider, options) => {
      const { stubborn = false, ...overrides } = starts[created.length] ?? {};
      const client = new AcpClient(
        { provider: "mock", command: process.execPath, args: [permissionAgent], env: stubborn ? { ACP_MOCK_IGNORE_SIGTERM: "1" } : {}, permissionPolicy: "auto_approve" },
        { ...options, ...(stubborn ? { killGraceMs: 60_000 } : {}), ...overrides }
      );
      created.push(client);
      return client;
    }
  });
  const shutdown = async () => {
    for (const pid of service.spawnedPids()) if (!processGone(pid)) process.kill(pid, "SIGKILL");
    await service.shutdown();
  };
  return { service, created, shutdown };
}

test("R4: a terminal that stop() gave up on stays a spawned pid until it exits", { skip: !unix }, async () => {
  await withTemp("acp-r4-stop-", async (directory) => {
    // The terminal's group gets the SIGTERM, which it ignores; its SIGKILL is
    // swallowed and every check finds it running, so stop() gives up on it after
    // the bounded wait, as on a process stuck in the kernel.
    const killProcess = (pid, signal) => (pid < 0 && signal !== "SIGTERM" ? true : process.kill(pid, signal));
    const client = new AcpClient(
      { provider: "mock", command: process.execPath, args: [permissionAgent], permissionPolicy: "auto_approve" },
      { protectedPaths: [], terminalSandbox: null, killGraceMs: 100, killProcess }
    );
    let terminalPid = null;
    try {
      await client.start();
      const [terminal] = await heldTerminals(client, directory, [STUBBORN]);
      terminalPid = terminal.child.pid;
      const exited = once(terminal.child, "exit");
      await client.stop();
      assert.equal(client.terminals.size, 0, "stop() dropped the terminal's record");
      assert.equal(processGone(terminalPid), false, "and gave up on its process");
      assert.deepEqual(client.spawnedPids(), [terminalPid], "which still counts, unlike the provider that exited");
      process.kill(terminalPid, "SIGKILL");
      await exited;
      assert.deepEqual(client.spawnedPids(), []);
    } finally {
      if (terminalPid && !processGone(terminalPid)) process.kill(terminalPid, "SIGKILL");
      await client.stop().catch(() => {});
    }
  });
});

test("R4: a provider that ignores SIGTERM stays a spawned pid after a fatal error drops its handle, until it exits", { skip: !unix }, async () => {
  const client = new AcpClient(
    { provider: "mock", command: process.execPath, args: [permissionAgent], env: { ACP_MOCK_IGNORE_SIGTERM: "1" }, permissionPolicy: "auto_approve" },
    { maxFrameBytes: 4096, killGraceMs: 1_000 }
  );
  let provider = null;
  try {
    await client.start();
    provider = client.proc;
    const exited = once(provider, "exit");
    // A frame over maxFrameBytes is a fatal read overflow: #fail drops the
    // handle and starts the bounded teardown, whose SIGTERM this provider ignores.
    provider.stdout.emit("data", Buffer.alloc(5_000, 0x78));
    await waitFor(() => !client.alive, () => "the fatal transport error");
    assert.equal(client.proc, null);
    assert.equal(processGone(provider.pid), false, "the provider still runs");
    assert.deepEqual(client.spawnedPids(), [provider.pid]);
    // The SIGKILL after the grace ends it, and its exit takes the pid out.
    await exited;
    assert.deepEqual(client.spawnedPids(), []);
  } finally {
    await client.stop().catch(() => {});
    if (provider?.pid && !processGone(provider.pid)) process.kill(provider.pid, "SIGKILL");
  }
});

test("R4: a terminal that ignores SIGTERM stays a spawned pid after the provider's exit drops its record, until it exits", { skip: !unix }, async () => {
  await withTemp("acp-r4-terminal-", async (directory) => {
    const client = new AcpClient(
      { provider: "mock", command: process.execPath, args: [permissionAgent], permissionPolicy: "auto_approve" },
      { protectedPaths: [], terminalSandbox: null, killGraceMs: 1_000 }
    );
    let terminalPid = null;
    try {
      await client.start();
      const [terminal] = await heldTerminals(client, directory, [STUBBORN]);
      terminalPid = terminal.child.pid;
      const exited = once(terminal.child, "exit");
      assert.deepEqual(byPid(client.spawnedPids()), byPid([client.proc.pid, terminalPid]));
      // The provider dies: #fail clears the terminals and starts ending them.
      client.proc.kill("SIGKILL");
      await waitFor(() => !client.alive, () => "the provider's exit");
      assert.equal(client.terminals.size, 0, "the terminal's record is gone");
      assert.equal(processGone(terminalPid), false, "its process is not");
      assert.deepEqual(client.spawnedPids(), [terminalPid]);
      await exited;
      assert.deepEqual(client.spawnedPids(), []);
    } finally {
      await client.stop().catch(() => {});
      if (terminalPid && !processGone(terminalPid)) process.kill(terminalPid, "SIGKILL");
    }
  });
});

test("R4: a retired provider that gc lets go of before its stop() is done stays a spawned pid until it exits", { skip: !unix }, async () => {
  await withTemp("acp-r4-retired-", async (directory) => {
    const providersPath = join(directory, "providers.json");
    const definition = (version) => JSON.stringify({
      version: 1,
      providers: { mockreg: { registryVersion: version, command: process.execPath, args: [permissionAgent, `--v=${version}`], env: {}, modelScope: "session" } }
    });
    await writeFile(providersPath, definition("1.0.0"));
    await withEnv({ ACP_GATEWAY_PROVIDERS: providersPath }, async () => {
      const { service, shutdown } = mockService(directory, [{ stubborn: true }]);
      try {
        await service.init();
        const retired = await service.getClient("mockreg");
        const provider = retired.proc;
        const exited = once(provider, "exit");
        // An adapter update changes the definition: the next start retires this
        // process, and gc stops it once it serves no session.
        await writeFile(providersPath, definition("2.0.0"));
        assert.notEqual(await service.getClient("mockreg"), retired);
        assert.equal(service.retiredClients.has(retired), true);
        const maintenance = service.runMaintenance();
        // gc drops the client first, then waits for its stop(), whose SIGTERM
        // this provider ignores.
        await waitFor(() => !service.retiredClients.has(retired), () => "gc to let go of the retired client");
        assert.equal(processGone(provider.pid), false, "its stop() is still ending the provider");
        assert.deepEqual([...service.spawnedPids()], [provider.pid], "the current provider, which gc stopped first, has exited");
        process.kill(provider.pid, "SIGKILL");
        await exited;
        await maintenance;
        assert.equal(service.spawnedPids().size, 0);
      } finally {
        await shutdown();
      }
    });
  });
});

test("R4: a provider that ignores SIGTERM stays a spawned pid after a fatal error and a new start replace its client, until it exits", { skip: !unix }, async () => {
  await withTemp("acp-r4-replaced-", async (directory) => {
    const { service, shutdown } = mockService(directory, [{ stubborn: true, maxFrameBytes: 4096 }]);
    try {
      await service.init();
      const dead = await service.getClient("claude");
      const provider = dead.proc;
      const exited = once(provider, "exit");
      // A fatal read overflow: #fail drops the provider's handle and starts the
      // teardown, whose SIGTERM this provider ignores.
      provider.stdout.emit("data", Buffer.alloc(5_000, 0x78));
      await waitFor(() => !dead.alive, () => "the fatal transport error");
      // The next start replaces the dead client, which the service then holds nowhere.
      const replacement = await service.getClient("claude");
      assert.notEqual(replacement, dead);
      assert.equal([...service.clients.values(), ...service.retiredClients].includes(dead), false);
      assert.equal(processGone(provider.pid), false, "its provider still runs");
      assert.deepEqual(byPid(service.spawnedPids()), byPid([provider.pid, replacement.proc.pid]));
      process.kill(provider.pid, "SIGKILL");
      await exited;
      assert.deepEqual([...service.spawnedPids()], [replacement.proc.pid]);
    } finally {
      await shutdown();
    }
  });
});

test("R4: a provider whose start fails stays a spawned pid while its client is in no list, until it exits", { skip: !unix }, async () => {
  await withTemp("acp-r4-failed-start-", async (directory) => {
    // A provider that fixes its model at start has to name the one asked for. The
    // mock names none, so the start fails once the provider is up and stops a
    // client the service never listed.
    const providersPath = join(directory, "providers.json");
    await writeFile(providersPath, JSON.stringify({
      version: 1,
      providers: { mockreg: { command: process.execPath, args: [permissionAgent], env: {}, modelScope: "process" } }
    }));
    await withEnv({ ACP_GATEWAY_PROVIDERS: providersPath }, async () => {
      const { service, created, shutdown } = mockService(directory, [{ stubborn: true }]);
      try {
        await service.init();
        const starting = service.getClient("mockreg", "fixed-model");
        starting.catch(() => {});
        await waitFor(() => created[0]?.proc && !created[0].alive, () => "the failed start to stop its client");
        const provider = created[0].proc;
        const exited = once(provider, "exit");
        assert.equal(service.clients.size + service.retiredClients.size, 0, "the client is in no list");
        assert.equal(processGone(provider.pid), false, "its stop() is still ending the provider");
        assert.deepEqual([...service.spawnedPids()], [provider.pid]);
        process.kill(provider.pid, "SIGKILL");
        await exited;
        await assert.rejects(starting, /required model=fixed-model, actual=<missing>/);
        assert.equal(service.spawnedPids().size, 0);
      } finally {
        await shutdown();
      }
    });
  });
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
  assert.equal(await first.denied, WORKER_CALLER_UNDER_DAEMON);
  assert.equal(verdictFor(100), first);
  assert.equal(verdictFor(null), first);
  assert.deepEqual(reads, [100, 50, 45], "one lookup while the pid stays the same");
  // Another pid on the connection is checked on its own, and this one is not
  // under the daemon: a denial is not kept for the connection.
  const second = verdictFor(300);
  assert.notEqual(second, first);
  assert.equal(await second.denied, null);
  // 300 is read and found not under the daemon; then (F6) the daemon reads its
  // own live pid once to confirm the host can place callers at all, so 300 is a
  // caller outside it rather than one it cannot read.
  assert.deepEqual(reads, [100, 50, 45, 300, 40]);
  // The daemon itself as the caller's agent CLI: under the daemon by the walk, so
  // it is refused before any probe (the reader is never called).
  assert.equal(await callerVerdicts({ daemonPid: 40, readProcess: () => assert.fail() })(40).denied, WORKER_CALLER_UNDER_DAEMON);
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
