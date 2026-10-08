// 1.8.0: an autostarted daemon gets its Control identity over a pipe on its
// stdin, never in its environment. The daemon deletes the token from
// process.env at startup, but that does not reach the environment block the OS
// keeps for the process, which any process of the same user can read (`ps -E`
// on macOS, /proc/<pid>/environ on Linux) given the daemon's pid, and that sits
// in the unprotected <socket>.lock. A daemon started with the token in its env
// (by hand, a supervisor, a consumer, every test harness) keeps that path.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONTROL_IDENTITY_ENV } from "../src/caller.js";
import { DAEMON_IDENTITY_STDIN_ENV, takeDaemonIdentity } from "../src/config.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { statePaths } from "../src/state-store.js";
import { startDaemon } from "./helpers/daemon-harness.js";
import { withTemp } from "./helpers/scratch.js";

const DAEMON = fileURLToPath(new URL("../src/gateway-daemon.js", import.meta.url));
const TOKEN = "stdin-identity-control-token-at-least-24";
const ROOT_ID = "main-stdin-identity";

// Everything a daemon started from here could touch lives in the directory,
// and none of this process's own Gateway env (the token included) rides along.
function isolatedEnv(directory, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ACP_GATEWAY_")));
  return {
    ...env,
    HOME: join(directory, "home"),
    ACP_GATEWAY_SOCKET: join(directory, "g.sock"),
    ACP_GATEWAY_STATE: join(directory, "state", "state.json"),
    ACP_GATEWAY_INSTALL_STATE: join(directory, "install.json"),
    ACP_GATEWAY_SETTINGS: join(directory, "settings.json"),
    ACP_GATEWAY_REGISTRY_CACHE: join(directory, "registry.json"),
    ACP_GATEWAY_WORKSPACES: join(directory, "workspaces"),
    ACP_GATEWAY_ARTIFACTS: join(directory, "artifacts"),
    ACP_GATEWAY_GROK_SANDBOX_DIR: join(directory, "grok-sandbox"),
    ACP_GATEWAY_DISABLE_DYNAMIC_PROVIDERS: "1",
    ACP_GATEWAY_AGENT_AUTO_UPDATE: "0",
    ACP_GATEWAY_AGENT_UPDATE_NOTIFICATIONS: "0",
    ...extra
  };
}

function clientFor(env, overrides = {}) {
  return new GatewayRpcClient({
    socketPath: env.ACP_GATEWAY_SOCKET,
    statePath: env.ACP_GATEWAY_STATE,
    token: TOKEN,
    rootId: ROOT_ID,
    autoStart: false,
    ...overrides
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// What another process of this user reads of pid's environment, as counts
// only: a failing assertion never prints the block, or a value in it. Null
// where there is no such reader to imitate (Windows).
function environmentOf(pid) {
  let block;
  if (process.platform === "linux") block = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").join("\n");
  else if (process.platform === "darwin") block = execFileSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  else return null;
  return {
    count: (name) => block.match(new RegExp(`(?:^|\\s)${name}=`, "g"))?.length ?? 0,
    includes: (value) => block.includes(value)
  };
}

// A front door's part of it, in a process of its own: the identity resolved the
// way src/index.js resolves it, one call that autostarts the daemon, then
// nothing left to do. It prints the daemon's pid and has to exit on its own.
const FRONT_DOOR = `
const { readFileSync } = await import("node:fs");
const { controlIdentity } = await import(process.argv[1]);
const { GatewayRpcClient } = await import(process.argv[2]);
const rpc = new GatewayRpcClient(controlIdentity());
const setup = await rpc.call("setup", { mode: "summary" }, 30000);
rpc.close();
const pid = Number(readFileSync(process.env.ACP_GATEWAY_SOCKET + ".lock", "utf8").trim());
process.stdout.write(JSON.stringify({ ok: setup.ok, pid }));
`;

async function runFrontDoor(env) {
  const child = spawn(process.execPath, [
    "--input-type=module", "-e", FRONT_DOOR,
    new URL("../src/config.js", import.meta.url).href,
    new URL("../src/socket-rpc.js", import.meta.url).href
  ], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // Held by the daemon or the pipe, it would never exit: this is what says so.
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const [code, signal] = await once(child, "close");
  clearTimeout(timer);
  return { code, signal, stdout, stderr };
}

async function stopDaemon(env, pid) {
  const rpc = clientFor(env);
  try {
    await rpc.call("daemon_shutdown", { force: true }, 10_000).catch(() => {});
  } finally {
    rpc.close();
  }
  for (let attempt = 0; attempt < 400 && alive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (alive(pid)) process.kill(pid, "SIGKILL");
}

// The daemon a front door autostarted holds the identity, takes it from the
// line and nowhere else, and shows none of it in its environment block.
async function assertAutostarted(env) {
  const frontDoor = await runFrontDoor(env);
  // The lock names the daemon whether or not the front door got as far as
  // printing it, so no failure below leaves one running.
  const pid = Number((await readFile(`${env.ACP_GATEWAY_SOCKET}.lock`, "utf8").catch(() => "")).trim());
  const main = clientFor(env);
  const wrongToken = clientFor(env, { token: "wrong-control-token-at-least-24-chars" });
  const otherRoot = clientFor(env, { rootId: "main-other" });
  try {
    assert.equal(frontDoor.signal, null, "the front door waited on the daemon it started");
    assert.equal(frontDoor.code, 0, frontDoor.stderr);
    assert.deepEqual(JSON.parse(frontDoor.stdout), { ok: true, pid });
    assert.equal(alive(pid), true, "the daemon outlives the front door that started it");
    const block = environmentOf(pid);
    if (block) {
      // The probe does see this block: the flag the autostart sets is in it.
      assert.equal(block.count(DAEMON_IDENTITY_STDIN_ENV), 1, "the probe reads the daemon's environment block");
      for (const name of CONTROL_IDENTITY_ENV) assert.equal(block.count(name), 0, `${name} is in the daemon's environment block`);
      assert.equal(block.includes(TOKEN), false, "the token is in the daemon's environment block");
    }
    assert.equal((await main.call("setup", { mode: "summary" })).ok, true);
    await assert.rejects(wrongToken.call("setup", { mode: "summary" }), { code: "CONTROL_ACCESS_DENIED" });
    await assert.rejects(otherRoot.call("setup", { mode: "summary" }), { code: "ROOT_MISMATCH" });
  } finally {
    for (const client of [main, wrongToken, otherRoot]) client.close();
    if (Number.isInteger(pid) && pid > 0) await stopDaemon(env, pid);
  }
}

test("an autostarted daemon gets its identity over stdin and none of it is in the environment the OS keeps for it", async () => {
  await withTemp("acp-id-", async (directory) => {
    // Since 1.8.0 the identity is only in install.json, where the front door reads it.
    const env = isolatedEnv(directory);
    await writeFile(env.ACP_GATEWAY_INSTALL_STATE, JSON.stringify({
      version: 1,
      identity: { token: TOKEN, rootId: ROOT_ID, createdAt: "2026-10-01T00:00:00.000Z" },
      managedMcp: {}
    }), { mode: 0o600 });
    await assertAutostarted(env);
  });
});

test("a front door that carries the identity in its own env still leaves it out of the daemon's", async () => {
  await withTemp("acp-id-env-door-", async (directory) => {
    // An entry registered before 1.8.0: the token and root id are in the front
    // door's env, which the daemon's is built from.
    await assertAutostarted(isolatedEnv(directory, { ACP_GATEWAY_CONTROL_TOKEN: TOKEN, ACP_GATEWAY_ROOT_ID: ROOT_ID }));
  });
});

test("a daemon started with the token in its env takes it from there and never reads stdin", async () => {
  await withTemp("acp-id-env-", async (directory) => {
    // The harness launches as a supervisor would, stdin on /dev/null. The flag
    // set too, a daemon that read stdin anyway would halt: that is no pipe.
    const daemon = await startDaemon({ directory, env: { [DAEMON_IDENTITY_STDIN_ENV]: "1" } });
    const client = new GatewayRpcClient({
      socketPath: daemon.socketPath, statePath: daemon.statePath, token: daemon.token, rootId: daemon.rootId, autoStart: false
    });
    const wrongToken = new GatewayRpcClient({
      socketPath: daemon.socketPath, statePath: daemon.statePath, token: TOKEN, rootId: daemon.rootId, autoStart: false
    });
    try {
      assert.equal((await client.call("setup", { mode: "summary" })).ok, true);
      await assert.rejects(wrongToken.call("setup", { mode: "summary" }), { code: "CONTROL_ACCESS_DENIED" });
      // Its env block still holds the token: this is why the autostart stopped
      // handing it over this way.
      const block = environmentOf(daemon.child.pid);
      if (block) assert.equal(block.count("ACP_GATEWAY_CONTROL_TOKEN"), 1, "the env launch puts the token in the block");
    } finally {
      client.close();
      wrongToken.close();
      await daemon.stop();
    }
  });
});

// The autostart's launch, with what it writes replaced by each way it can go
// wrong: the flag set, no token in the env.
async function startReadingStdin(directory, { stdin = "pipe", feed = null } = {}) {
  const env = isolatedEnv(directory, { [DAEMON_IDENTITY_STDIN_ENV]: "1" });
  const child = spawn(process.execPath, [DAEMON], { env, stdio: [stdin, "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // A daemon that halts closes its end under a write still in flight.
  child.stdin?.on("error", () => {});
  feed?.(child.stdin);
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const [exitCode, signalCode] = await once(child, "close");
  clearTimeout(timer);
  child.stdin?.destroy();
  return { env, exitCode, signalCode, stderr };
}

test("a daemon told to read its identity from stdin halts with a marker when the line is missing or unusable", async () => {
  const secret = "short-secret-token";
  const scenarios = [
    { name: "stdin on /dev/null", stdin: "ignore", reason: /stdin is not a pipe/ },
    { name: "no line before the end", feed: (stdin) => stdin.end(), reason: /stdin closed before a whole line arrived/ },
    { name: "not JSON", feed: (stdin) => stdin.end(`${secret}\n`), reason: /the line on stdin is not JSON/ },
    {
      name: "a short token",
      feed: (stdin) => stdin.end(`${JSON.stringify({ token: secret, rootId: ROOT_ID })}\n`),
      reason: /holds no Control token of at least 24 characters/
    },
    // Never ended: the bound, not the end of the pipe, has to stop it.
    { name: "no line end in 16 KiB", feed: (stdin) => stdin.write("x".repeat(16 * 1024 + 1)), reason: /more than 16384 bytes arrived on stdin without a line end/ }
  ];
  for (const scenario of scenarios) {
    await withTemp("acp-id-bad-", async (directory) => {
      const halted = await startReadingStdin(directory, scenario);
      assert.equal(halted.signalCode, null, scenario.name);
      assert.equal(halted.exitCode, 78, `${scenario.name}: ${halted.stderr}`);
      assert.match(halted.stderr, scenario.reason, scenario.name);
      const marker = JSON.parse(await readFile(statePaths(halted.env.ACP_GATEWAY_STATE).marker, "utf8"));
      assert.equal(marker.errorCode, "DAEMON_IDENTITY_INVALID", scenario.name);
      assert.match(marker.error, scenario.reason, scenario.name);
      assert.equal(`${marker.error}${halted.stderr}`.includes(secret), false, `${scenario.name}: the line is never quoted`);
      // It stopped before the lock and the socket, so the next start is free.
      assert.equal(existsSync(`${halted.env.ACP_GATEWAY_SOCKET}.lock`), false, scenario.name);
      assert.equal(existsSync(halted.env.ACP_GATEWAY_SOCKET), false, scenario.name);
      // A Main is told why, under a stable code.
      const blind = clientFor(halted.env);
      try {
        await assert.rejects(blind.call("setup", { mode: "summary" }), (error) => {
          assert.equal(error.code, "DAEMON_IDENTITY_INVALID");
          assert.match(error.message, /^Gateway could not start: /);
          return true;
        });
      } finally {
        blind.close();
      }
    });
  }
});

test("with neither a token in its env nor the stdin flag, the daemon fails as it always has", async () => {
  await withTemp("acp-id-none-", async (directory) => {
    const env = isolatedEnv(directory);
    const child = spawn(process.execPath, [DAEMON], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, "close");
    assert.equal(exitCode, 1);
    assert.match(stderr, /ACP_GATEWAY_CONTROL_TOKEN must be set to at least 24 characters/);
    assert.equal(existsSync(statePaths(env.ACP_GATEWAY_STATE).marker), false, "no marker on this path, as before");
  });
});

test("the identity line: the env decides when it sets the token, else exactly one bounded line, never quoted back", async () => {
  // The env wins, flag or not, and the stream is never touched.
  const untouched = { on() { throw new Error("stdin was read"); } };
  const env = { ACP_GATEWAY_CONTROL_TOKEN: TOKEN, ACP_GATEWAY_ROOT_ID: ROOT_ID, [DAEMON_IDENTITY_STDIN_ENV]: "1", PATH: "/bin" };
  assert.deepEqual(await takeDaemonIdentity(env, { input: untouched }), { token: TOKEN, rootId: ROOT_ID });
  assert.deepEqual(env, { PATH: "/bin" }, "the flag goes with the identity");

  const fromLine = async (writes, options = {}) => {
    const input = new PassThrough();
    const lineEnv = { [DAEMON_IDENTITY_STDIN_ENV]: "1", PATH: "/bin" };
    const taken = takeDaemonIdentity(lineEnv, { input, ...options });
    assert.deepEqual(lineEnv, { PATH: "/bin" }, "out of the env before anything is read");
    for (const write of writes) write(input);
    return { identity: await taken, input };
  };
  const line = JSON.stringify({ token: TOKEN, rootId: ROOT_ID });
  // However it is split, and whatever follows the line end is never read.
  const split = await fromLine([(input) => input.write(line.slice(0, 9)), (input) => input.write(`${line.slice(9)}\n{"token":"x"}\n`)]);
  assert.deepEqual(split.identity, { token: TOKEN, rootId: ROOT_ID });
  assert.equal(split.input.destroyed, true, "the stream is let go once the line is in");
  assert.deepEqual((await fromLine([(input) => input.end(`${JSON.stringify({ token: TOKEN })}\n`)])).identity, { token: TOKEN, rootId: null });

  const secret = "short-secret-token";
  const refused = (writes, reason, options) => assert.rejects(fromLine(writes, options), (error) => {
    assert.equal(error.code, "DAEMON_IDENTITY_INVALID");
    assert.match(error.message, reason);
    assert.equal(error.message.includes(secret), false, "the line is never quoted");
    return true;
  });
  await refused([(input) => input.end()], /stdin closed before a whole line arrived/);
  await refused([(input) => input.end(`{"token":"${TOKEN}"}`)], /stdin closed before a whole line arrived/);
  await refused([(input) => input.end(`${secret}\n`)], /the line on stdin is not JSON/);
  await refused([(input) => input.end(`${JSON.stringify({ token: secret })}\n`)], /holds no Control token of at least 24 characters/);
  await refused([(input) => input.end("[]\n")], /holds no Control token/);
  await refused([(input) => input.end(`${JSON.stringify({ token: TOKEN, rootId: 7 })}\n`)], /the rootId on stdin is not a non-empty string/);
  await refused([(input) => input.write("x".repeat(65))], /more than 64 bytes arrived on stdin without a line end/, { maxBytes: 64 });
  await refused([], /no line arrived on stdin within 50 ms/, { timeoutMs: 50 });
});
