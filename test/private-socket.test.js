import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ERROR_CODES } from "../src/errors.js";
import { listenPrivately, requireOwnSocket } from "../src/private-socket.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { statePaths } from "../src/state-store.js";
import { startDaemon } from "./helpers/daemon-harness.js";

// W9: the daemon's socket is never reachable by another user, and a client
// writes nothing, the token above all, to a socket another user could have put
// at the path (on Linux the default is in the shared /tmp).

const TOKEN = "t".repeat(32);
const posix = typeof process.getuid === "function";

async function withTemp(run) {
  // Short: a Unix socket path must stay under ~104 bytes.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-sock-")));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withEnv(values, body) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A stand-in daemon that records every connection and every byte it receives,
// and never answers. close() also drops what is still connected, so a failed
// assertion cannot leave the test process waiting on it.
async function recordingServer(path) {
  const seen = { connections: 0, bytes: 0, closed: 0 };
  const sockets = new Set();
  const server = createServer((socket) => {
    seen.connections += 1;
    sockets.add(socket);
    socket.on("data", (chunk) => {
      seen.bytes += chunk.length;
    });
    socket.on("close", () => {
      seen.closed += 1;
      sockets.delete(socket);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  });
  return { server, seen, close };
}

// The process umask, read without changing it for longer than this line.
function currentUmask() {
  const mask = process.umask(0o022);
  process.umask(mask);
  return mask;
}

const untrusted = (expected = {}) => (error) => {
  assert.equal(error.code, ERROR_CODES.SOCKET_UNTRUSTED, error.message);
  for (const [key, value] of Object.entries(expected)) assert.equal(error.details?.[key], value, key);
  assert.match(error.message, /nothing was sent/);
  return true;
};

test("the daemon's socket is bound under umask 077 and left at 0600", { skip: !posix }, async () => {
  await withTemp(async (directory) => {
    const path = join(directory, "g.sock");
    const server = createServer();
    // listen() binds synchronously, so the mode right after it is the mode the
    // socket had before the chmod: the window this closes.
    let modeAtBind = null;
    const listen = server.listen;
    server.listen = function (...args) {
      const result = listen.apply(this, args);
      modeAtBind = lstatSync(path).mode & 0o777;
      return result;
    };
    // The most permissive umask, so only the tightening can explain the bits.
    const umask = process.umask(0);
    try {
      await listenPrivately(server, path);
      assert.equal(currentUmask(), 0, "the process umask is restored after the bind");
      assert.equal(lstatSync(path).mode & 0o777, 0o600);
    } finally {
      process.umask(umask);
      await new Promise((resolve) => server.close(resolve));
    }
    assert.notEqual(modeAtBind, null);
    assert.equal(modeAtBind & 0o077, 0, `bound with mode ${modeAtBind.toString(8)}`);
  });
});

test("a running daemon serves a 0600 socket owned by its user", { skip: !posix }, async () => {
  await withTemp(async (directory) => {
    const daemon = await startDaemon({ directory });
    try {
      const info = lstatSync(daemon.socketPath);
      assert.ok(info.isSocket());
      assert.equal(info.uid, process.getuid());
      assert.equal(info.mode & 0o777, 0o600);
    } finally {
      await daemon.stop();
    }
  });
});

test("the owner check accepts this user's socket and a missing path, and refuses anything else", { skip: !posix }, async () => {
  await withTemp(async (directory) => {
    const uid = process.getuid();
    const path = join(directory, "g.sock");
    await requireOwnSocket(path);
    await assert.rejects(requireOwnSocket(path, { allowMissing: false }), (error) => error.code === "ENOENT");
    const fixture = await recordingServer(path);
    try {
      await requireOwnSocket(path);
      await requireOwnSocket(path, { allowMissing: false });
      // Another user's socket, as lstat would report it.
      const foreign = { isSocket: () => true, isSymbolicLink: () => false, isDirectory: () => false, isFIFO: () => false, isFile: () => false, uid: uid + 1 };
      await assert.rejects(
        requireOwnSocket(path, { lstat: async () => foreign }),
        untrusted({ socketPath: path, type: "socket", ownerUid: uid + 1, uid })
      );
      // A link is never followed to a socket, not even this user's own.
      const link = join(directory, "link.sock");
      await symlink(path, link);
      await assert.rejects(requireOwnSocket(link), untrusted({ type: "symlink", ownerUid: uid }));
      const file = join(directory, "file.sock");
      await writeFile(file, "not a socket");
      await assert.rejects(requireOwnSocket(file), untrusted({ type: "file", ownerUid: uid }));
      // No uid to compare (Windows): nothing is checked, nothing is read.
      await requireOwnSocket(file, { uid: null, lstat: async () => assert.fail("lstat without a uid") });
      assert.equal(fixture.seen.connections, 0, "checking never connects");
    } finally {
      await fixture.close();
    }
  });
});

test("a client never connects to a socket of another user, for any call", { skip: !posix }, async () => {
  await withTemp(async (directory) => {
    const path = join(directory, "g.sock");
    const fixture = await recordingServer(path);
    const getuid = process.getuid;
    const uid = getuid();
    // The socket is this process's; seen from another uid it is a stranger's.
    process.getuid = () => uid + 1;
    const rpc = new GatewayRpcClient({ socketPath: path, token: TOKEN, rootId: "main-x", autoStart: false, statePath: join(directory, "state.json") });
    try {
      await assert.rejects(rpc.call("setup", {}, 2_000), untrusted({ socketPath: path, type: "socket", ownerUid: uid, uid: uid + 1 }));
      // Not "already stopped": a shutdown cannot tell what it would be talking to either.
      await assert.rejects(rpc.call("daemon_shutdown", {}, 2_000), untrusted());
      await assert.rejects(rpc.subscribe({}, () => {}, 2_000), untrusted());
    } finally {
      process.getuid = getuid;
      rpc.close();
      await fixture.close();
    }
    assert.equal(fixture.seen.connections, 0);
    assert.equal(fixture.seen.bytes, 0);
  });
});

test("a connection whose socket changed hands after the first check is dropped before anything is sent", { skip: !posix }, async () => {
  await withTemp(async (directory) => {
    const path = join(directory, "g.sock");
    const fixture = await recordingServer(path);
    const getuid = process.getuid;
    const uid = getuid();
    // The first check sees this user's socket; the one after the connect sees
    // it owned by someone else, as when another user binds the path between
    // the two (it was free at the first one).
    let checks = 0;
    process.getuid = () => (checks++ === 0 ? uid : uid + 1);
    const rpc = new GatewayRpcClient({ socketPath: path, token: TOKEN, rootId: "main-x", autoStart: false, statePath: join(directory, "state.json") });
    try {
      await assert.rejects(rpc.call("setup", {}, 2_000), untrusted({ ownerUid: uid, uid: uid + 1 }));
      process.getuid = getuid;
      for (let attempt = 0; attempt < 100 && fixture.seen.closed < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(fixture.seen.connections, 1, "the connect itself happened");
      assert.equal(fixture.seen.closed, 1, "and was closed by the client");
      assert.equal(fixture.seen.bytes, 0, "without a single byte, the token included");
    } finally {
      process.getuid = getuid;
      rpc.close();
      await fixture.close();
    }
  });
});

test("a file at the socket path is reported as it is: no daemon starts and no recovery marker masks it", { skip: !posix }, async () => {
  await withTemp(async (directory) => {
    const path = join(directory, "g.sock");
    const statePath = join(directory, "state", "state.json");
    await writeFile(path, "not a socket");
    // Isolation in case a regression autostarts a daemon after all.
    await withEnv({
      ACP_GATEWAY_STATE: statePath,
      ACP_GATEWAY_SETTINGS: join(directory, "state", "settings.json"),
      ACP_GATEWAY_INSTALL_STATE: join(directory, "state", "install.json"),
      ACP_GATEWAY_WORKSPACES: join(directory, "workspaces"),
      ACP_GATEWAY_AGENT_AUTO_UPDATE: "false"
    }, async () => {
      const rpc = new GatewayRpcClient({ socketPath: path, token: TOKEN, rootId: "main-x", statePath });
      try {
        await assert.rejects(rpc.call("setup", {}, 5_000), untrusted({ type: "file", socketPath: path }));
        // A marker a halted daemon left behind explains a missing socket, not this.
        const marker = statePaths(statePath).marker;
        await mkdir(dirname(marker), { recursive: true });
        await writeFile(marker, JSON.stringify({ at: new Date().toISOString(), error: "halted", errorCode: "STATE_WAL_CORRUPT" }));
        await assert.rejects(rpc.call("setup", {}, 5_000), untrusted({ type: "file" }));
      } finally {
        rpc.close();
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = existsSync(`${path}.lock`);
    // Should a regression have started one, it does not outlive the test.
    if (started) process.kill(Number(readFileSync(`${path}.lock`, "utf8")), "SIGTERM");
    assert.equal(started, false, "no daemon was started");
    assert.equal(readFileSync(path, "utf8"), "not a socket", "nothing replaced the file");
  });
});
