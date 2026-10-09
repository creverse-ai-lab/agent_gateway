import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import { ERROR_CODES, GatewayError } from "../src/errors.js";
import {
  listenPrivately, requireOwnSocket, requireTrustedSocket, requireTrustedSocketDir, SOCKET_PATH_MAX_BYTES
} from "../src/private-socket.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { statePaths } from "../src/state-store.js";
import { GATEWAY_VERSION } from "../src/version.js";
import { startDaemon } from "./helpers/daemon-harness.js";
import { withEnv, withTemp } from "./helpers/scratch.js";

// W9: the daemon's socket is never reachable by another user, and a client
// writes nothing, the token above all, to a socket another user could have put
// at the path (on Linux the default is in the shared /tmp).

const TOKEN = "t".repeat(32);
const posix = typeof process.getuid === "function";
// Short: a Unix socket path must stay under ~104 bytes.
const SOCKET_DIR = "acp-sock-";

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
  await withTemp(SOCKET_DIR, async (directory) => {
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
  await withTemp(SOCKET_DIR, async (directory) => {
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
  await withTemp(SOCKET_DIR, async (directory) => {
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
  await withTemp(SOCKET_DIR, async (directory) => {
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
  await withTemp(SOCKET_DIR, async (directory) => {
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
  await withTemp(SOCKET_DIR, async (directory) => {
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

// F7 (1.8.0 review): an lstat of the final socket rejects a last-component
// symlink, not an intermediate one. A parent directory a stranger can replace
// with a link lets the two owner checks see this user's own socket while the
// connect in between reaches a foreign one. Node cannot read the connected
// peer's uid without a native addon, so the trust check proves the whole path
// chain is this user's own instead: a chain no other user can write is one no
// other user can redirect between the check and the connect. That holds only
// for the canonical path the check walked (its directory resolved by the
// kernel, links and ".." included), so the check returns it and the connect,
// the bind and every later check use it, never the spelling they were given.

const CHAIN_UID = 4242;
const SOCK = "/trusted/run/g.sock";
const SOCK_DIR = "/trusted/run";
// Stats as lstat would return them, so a chain is described without touching disk.
const dirStat = (uid, mode) => ({
  isDirectory: () => true, isSymbolicLink: () => false, isSocket: () => false,
  isFIFO: () => false, isFile: () => false, uid, mode: 0o040000 | mode
});
const linkStat = (uid) => ({
  isDirectory: () => false, isSymbolicLink: () => true, isSocket: () => false,
  isFIFO: () => false, isFile: () => false, uid, mode: 0o120777
});
const socketStat = (uid) => ({
  isDirectory: () => false, isSymbolicLink: () => false, isSocket: () => true,
  isFIFO: () => false, isFile: () => false, uid, mode: 0o140600
});
// realpath resolves the parent as spelled (SOCK_DIR unless told otherwise) to
// SOCK_DIR; lstat answers from a table of paths, noting each one it is asked.
const injected = (entries, { parent = SOCK_DIR, seen = [] } = {}) => ({
  realpath: async (path) => { assert.equal(path, parent); return SOCK_DIR; },
  lstat: async (path) => {
    seen.push(path);
    if (!(path in entries)) assert.fail(`unexpected lstat ${path}`);
    return entries[path];
  }
});
const trustedChain = (overrides = {}) => ({
  [SOCK]: socketStat(CHAIN_UID),
  [SOCK_DIR]: dirStat(CHAIN_UID, 0o700),
  "/trusted": dirStat(CHAIN_UID, 0o755),
  "/": dirStat(0, 0o755),
  ...overrides
});

test("the trust check accepts a chain this user owns down to the root", { skip: !posix }, async () => {
  assert.equal(await requireTrustedSocket(SOCK, { uid: CHAIN_UID, ...injected(trustedChain()) }), SOCK);
  assert.equal(await requireTrustedSocketDir(SOCK, { uid: CHAIN_UID, ...injected(trustedChain()) }), SOCK);
});

test("the trust check checks and returns the canonical path, never the spelling it was given", { skip: !posix }, async () => {
  // realpath gets the parent exactly as spelled, ".." included: a lexical
  // resolve first would drop the ".." together with the link in front of it,
  // which the kernel follows before it.
  for (const [spelled, parent] of [["/spelled/run/g.sock", "/spelled/run"], ["/spelled/link/../g.sock", "/spelled/link/.."]]) {
    const seen = [];
    assert.equal(await requireTrustedSocket(spelled, { uid: CHAIN_UID, ...injected(trustedChain(), { parent, seen }) }), SOCK);
    assert.deepEqual(seen, [SOCK, SOCK_DIR, "/trusted", "/"], "the owner check, then the chain, of the canonical path only");
    seen.length = 0;
    assert.equal(await requireTrustedSocketDir(spelled, { uid: CHAIN_UID, ...injected(trustedChain(), { parent, seen }) }), SOCK);
    assert.deepEqual(seen, [SOCK_DIR, "/trusted", "/"]);
    // A refusal still names the path as configured.
    const naming = (expected) => (error) => {
      assert.equal(error.code, ERROR_CODES.SOCKET_UNTRUSTED, error.message);
      assert.ok(error.message.startsWith(`Refusing Gateway socket ${spelled}: `), error.message);
      for (const [key, value] of Object.entries(expected)) assert.equal(error.details?.[key], value, key);
      return true;
    };
    await assert.rejects(
      requireTrustedSocket(spelled, { uid: CHAIN_UID, ...injected(trustedChain({ [SOCK]: socketStat(CHAIN_UID + 1) }), { parent }) }),
      naming({ socketPath: spelled, type: "socket", ownerUid: CHAIN_UID + 1 })
    );
    await assert.rejects(
      requireTrustedSocketDir(spelled, { uid: CHAIN_UID, ...injected(trustedChain({ "/trusted": dirStat(CHAIN_UID, 0o777) }), { parent }) }),
      naming({ socketPath: spelled, dir: "/trusted" })
    );
  }
  // No uid to compare (Windows): the path comes back as given, nothing is read.
  const untouched = { uid: null, realpath: async () => assert.fail("realpath without a uid"), lstat: async () => assert.fail("lstat without a uid") };
  assert.equal(await requireTrustedSocket("/spelled/link/../g.sock", untouched), "/spelled/link/../g.sock");
  assert.equal(await requireTrustedSocketDir("/spelled/link/../g.sock", untouched), "/spelled/link/../g.sock");
});

test("the trust check refuses a group- or other-writable intermediate directory", { skip: !posix }, async () => {
  const entries = trustedChain({ "/trusted": dirStat(CHAIN_UID, 0o777) });
  const refused = (error) => {
    assert.equal(error.code, ERROR_CODES.SOCKET_UNTRUSTED);
    assert.equal(error.details.dir, "/trusted");
    assert.match(error.message, /writable by group or others/);
    return true;
  };
  // The connect path (socket present) and the daemon's pre-bind path both refuse it.
  await assert.rejects(requireTrustedSocket(SOCK, { uid: CHAIN_UID, ...injected(entries) }), refused);
  await assert.rejects(requireTrustedSocketDir(SOCK, { uid: CHAIN_UID, ...injected(entries) }), refused);
});

test("the trust check allows a sticky world-writable directory such as /tmp", { skip: !posix }, async () => {
  // Sticky (01000) lets only an entry's own owner replace it, so our own socket
  // and directories are safe inside a shared /tmp.
  await requireTrustedSocket(SOCK, { uid: CHAIN_UID, ...injected(trustedChain({ "/trusted": dirStat(0, 0o1777) })) });
});

test("the trust check refuses a directory in the chain owned by another user", { skip: !posix }, async () => {
  await assert.rejects(
    requireTrustedSocket(SOCK, { uid: CHAIN_UID, ...injected(trustedChain({ [SOCK_DIR]: dirStat(CHAIN_UID + 1, 0o700) })) }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.SOCKET_UNTRUSTED);
      assert.equal(error.details.dir, SOCK_DIR);
      assert.equal(error.details.ownerUid, CHAIN_UID + 1);
      assert.match(error.message, /owned by uid 4243, not this user/);
      return true;
    }
  );
});

test("the trust check refuses a component that is no longer a directory", { skip: !posix }, async () => {
  // A component swapped for a symlink in the very window after realpath: lstat
  // sees the link, not a directory, and it is refused on that alone.
  await assert.rejects(
    requireTrustedSocket(SOCK, { uid: CHAIN_UID, ...injected(trustedChain({ [SOCK_DIR]: linkStat(CHAIN_UID) })) }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.SOCKET_UNTRUSTED);
      assert.equal(error.details.type, "symlink");
      assert.match(error.message, /not a directory/);
      return true;
    }
  );
});

test("the trust check names a foreign final socket before it walks the chain", { skip: !posix }, async () => {
  // The owner check runs first, so a stranger's socket at the path is reported
  // as the socket it is, even though the chain above it is this user's own.
  await assert.rejects(
    requireTrustedSocket(SOCK, { uid: CHAIN_UID, ...injected(trustedChain({ [SOCK]: socketStat(CHAIN_UID + 1) })) }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.SOCKET_UNTRUSTED);
      assert.equal(error.details.type, "socket");
      assert.equal(error.details.ownerUid, CHAIN_UID + 1);
      return true;
    }
  );
});

test("the directory trust check refuses a real group-writable directory and accepts it once tightened", { skip: !posix }, async () => {
  await withTemp(SOCKET_DIR, async (directory) => {
    const shared = join(directory, "shared");
    await mkdir(shared);
    const path = join(shared, "g.sock");
    await chmod(shared, 0o777);
    await assert.rejects(requireTrustedSocketDir(path), (error) => {
      assert.equal(error.code, ERROR_CODES.SOCKET_UNTRUSTED);
      assert.match(error.message, /writable by group or others/);
      return true;
    });
    await chmod(shared, 0o700);
    await requireTrustedSocketDir(path);
  });
});

test("the trust check follows a link before the '..' after it, as the kernel does", { skip: !posix }, async () => {
  await withTemp(SOCKET_DIR, async (directory) => {
    const real = join(directory, "real");
    await mkdir(join(real, "sub"), { recursive: true });
    await symlink(join(real, "sub"), join(directory, "link"));
    await chmod(real, 0o777);
    await chmod(directory, 0o700);
    // Not join(), which drops the ".." as resolve() would: the kernel parent
    // is real, the open one, where lexically it would be the private directory.
    const path = `${directory}/link/../g.sock`;
    const realDir = await realpath(real);
    const refused = (error) => {
      assert.equal(error.code, ERROR_CODES.SOCKET_UNTRUSTED, error.message);
      assert.equal(error.details.dir, realDir);
      assert.ok(error.message.includes(realDir), error.message);
      assert.match(error.message, /writable by group or others/);
      return true;
    };
    await assert.rejects(requireTrustedSocketDir(path), refused);
    await assert.rejects(requireTrustedSocket(path), refused);
    await chmod(real, 0o700);
    assert.equal(await requireTrustedSocketDir(path), join(realDir, "g.sock"));
    assert.equal(await requireTrustedSocket(path), join(realDir, "g.sock"));
  });
});

test("the daemon refuses to bind its socket in an untrusted directory and records the reason", { skip: !posix }, async () => {
  await withTemp(SOCKET_DIR, async (directory) => {
    const shared = join(directory, "shared");
    await mkdir(shared);
    await chmod(shared, 0o777);
    const socketPath = join(shared, "g.sock");
    const daemon = await startDaemon({ directory, expectExit: true, env: { ACP_GATEWAY_SOCKET: socketPath } });
    const { exitCode, stderr } = await daemon.waitForExit();
    assert.equal(exitCode, 78, `operator-action halt expected; stderr: ${stderr}`);
    assert.match(stderr, /Refusing Gateway socket/);
    assert.match(stderr, /writable by group or others/);
    assert.equal(existsSync(socketPath), false, "no socket was bound in the untrusted directory");
  });
});

test("the daemon checks the directory before it touches anything at the path", { skip: !posix }, async () => {
  await withTemp(SOCKET_DIR, async (directory) => {
    const shared = join(directory, "shared");
    await mkdir(shared);
    await chmod(shared, 0o777);
    const socketPath = join(shared, "g.sock");
    // A stale socket's probe and unlink would remove this, whoever's it is.
    await writeFile(socketPath, "someone else's");
    const daemon = await startDaemon({ directory, expectExit: true, env: { ACP_GATEWAY_SOCKET: socketPath } });
    const { exitCode, stderr } = await daemon.waitForExit();
    assert.equal(exitCode, 78, `operator-action halt expected; stderr: ${stderr}`);
    assert.equal(JSON.parse(readFileSync(statePaths(daemon.statePath).marker, "utf8")).errorCode, ERROR_CODES.SOCKET_UNTRUSTED);
    assert.equal(readFileSync(socketPath, "utf8"), "someone else's", "the file at the path was left alone");
    assert.deepEqual(readdirSync(shared), ["g.sock"], "and no lock was created beside it");
  });
});

test("the daemon binds, locks and removes, and a client connects to, the canonical path of a socket spelled through a link", { skip: !posix }, async () => {
  await withTemp(SOCKET_DIR, async (directory) => {
    const real = join(directory, "real");
    const other = join(directory, "other");
    await mkdir(real, { mode: 0o700 });
    await mkdir(other, { mode: 0o700 });
    const link = join(directory, "link");
    await symlink(real, link);
    const spelled = join(link, "gateway.sock");
    const canonical = join(await realpath(real), "gateway.sock");
    // Only the socket is spelled through the link: the harness keeps the state
    // in, and waits for the socket at, the real directory.
    const daemon = await startDaemon({ directory: real, env: { ACP_GATEWAY_SOCKET: spelled } });
    const rpc = new GatewayRpcClient({ socketPath: spelled, token: daemon.token, rootId: daemon.rootId, autoStart: false, statePath: daemon.statePath });
    try {
      assert.equal((await rpc.call("setup", {}, 5_000)).gatewayVersion, GATEWAY_VERSION);
      assert.ok(lstatSync(canonical).isSocket(), "bound at the canonical path");
      assert.ok(lstatSync(`${canonical}.lock`).isFile(), "and locked there");
      // Pointed elsewhere, as the link's owner could: what the daemon removes
      // when it stops is its own socket and lock, not what the spelling reaches.
      await unlink(link);
      await symlink(other, link);
    } finally {
      rpc.close();
      await daemon.stop();
    }
    assert.deepEqual(readdirSync(real).filter((name) => name.startsWith("gateway.sock")), []);
    assert.deepEqual(readdirSync(other), []);
  });
});

// R3 (1.8.0 release review): a socket directory that does not exist failed the
// client's trust check with SOCKET_UNTRUSTED, so daemon_shutdown and
// shutdown_if_idle reported that instead of alreadyStopped, and no client would
// start a daemon there. Nothing can be listening in a directory that is not
// there, so the client rethrows the ENOENT as it is, before anything is sent;
// the daemon, which would have to bind there, still halts on it.

test("a socket directory that does not exist is ENOENT to the client's check and untrusted to the daemon's", { skip: !posix }, async () => {
  await withTemp(SOCKET_DIR, async (directory) => {
    const path = join(directory, "missing", "g.sock");
    await assert.rejects(requireTrustedSocket(path), (error) => {
      assert.equal(error.code, "ENOENT", error.message);
      assert.equal(error instanceof GatewayError, false, "the realpath's own error");
      return true;
    });
    await assert.rejects(requireTrustedSocketDir(path), (error) => {
      assert.equal(error.code, ERROR_CODES.SOCKET_UNTRUSTED, error.message);
      assert.equal(error.details.dir, dirname(path));
      assert.match(error.message, /its directory cannot be resolved/);
      return true;
    });
  });
  // Rethrown as it is, and only for ENOENT: a directory that cannot be resolved
  // for any other reason is still refused.
  const missing = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  const failing = (error) => ({ realpath: async () => { throw error; }, lstat: async () => assert.fail("nothing is checked past the realpath") });
  await assert.rejects(requireTrustedSocket(SOCK, { uid: CHAIN_UID, ...failing(missing) }), (error) => error === missing);
  for (const code of ["ENOTDIR", "EACCES", "ELOOP"]) {
    await assert.rejects(requireTrustedSocket(SOCK, { uid: CHAIN_UID, ...failing(Object.assign(new Error(code), { code })) }), (error) => {
      assert.equal(error.code, ERROR_CODES.SOCKET_UNTRUSTED, code);
      assert.equal(error.details.dir, SOCK_DIR);
      return true;
    });
  }
  await assert.rejects(requireTrustedSocketDir(SOCK, { uid: CHAIN_UID, ...failing(missing) }), (error) => error.code === ERROR_CODES.SOCKET_UNTRUSTED);
});

test("with its socket directory missing a shutdown finds the Gateway already stopped, and an autostart reports the daemon's halt", { skip: !posix, timeout: 60_000 }, async () => {
  await withTemp(SOCKET_DIR, async (directory) => {
    const path = join(directory, "missing", "g.sock");
    const statePath = join(directory, "state", "state.json");
    // The daemon a call autostarts inherits this environment: keep it isolated.
    await withEnv({
      ACP_GATEWAY_STATE: statePath,
      ACP_GATEWAY_SETTINGS: join(directory, "state", "settings.json"),
      ACP_GATEWAY_INSTALL_STATE: join(directory, "state", "install.json"),
      ACP_GATEWAY_WORKSPACES: join(directory, "workspaces"),
      ACP_GATEWAY_AGENT_AUTO_UPDATE: "false"
    }, async () => {
      const rpc = new GatewayRpcClient({ socketPath: path, token: TOKEN, rootId: "main-x", statePath });
      const observer = new GatewayRpcClient({ socketPath: path, token: TOKEN, rootId: "main-x", statePath, autoStart: false });
      try {
        assert.deepEqual(await rpc.call("daemon_shutdown", {}, 5_000), { ok: true, alreadyStopped: true });
        assert.deepEqual(await rpc.call("shutdown_if_idle", {}, 5_000), { ok: true, alreadyStopped: true });
        await assert.rejects(observer.call("setup", {}, 5_000), (error) => error.code === "ENOENT");
        assert.equal(existsSync(dirname(statePath)), false, "no daemon was started, so none halted");
        // Any other call starts a daemon, as for a missing socket. That daemon
        // cannot resolve the directory either: it halts (exit 78) and leaves its
        // reason in the recovery marker, which is what clients report from then on.
        await assert.rejects(rpc.call("setup", {}, 20_000));
        const marker = statePaths(statePath).marker;
        for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(JSON.parse(readFileSync(marker, "utf8")).errorCode, ERROR_CODES.SOCKET_UNTRUSTED);
        await assert.rejects(observer.call("setup", {}, 5_000), (error) => {
          assert.equal(error.code, ERROR_CODES.SOCKET_UNTRUSTED, error.message);
          assert.match(error.message, /^Gateway could not start: Refusing Gateway socket .*: its directory cannot be resolved/);
          return true;
        });
      } finally {
        rpc.close();
        observer.close();
      }
    });
    assert.equal(existsSync(dirname(path)), false, "nothing created the socket's directory");
  });
});

// The canonical path is the one bound and connected, and it can be longer than
// the configured one (on macOS a temporary directory resolves under /private).
// Some systems take no socket path past sun_path less its NUL, and Node did not
// refuse a longer one there but cut it short (Node 22 on macOS 14, and Linux),
// so the daemon bound another path and a client found nothing. Both ends now
// refuse such a path before anything is sent or bound.

const tooLong = (expected = {}) => (error) => {
  assert.equal(error.code, ERROR_CODES.SOCKET_PATH_TOO_LONG, error.message);
  assert.equal(error.details?.limitBytes, SOCKET_PATH_MAX_BYTES);
  for (const [key, value] of Object.entries(expected)) assert.equal(error.details?.[key], value, key);
  assert.ok(error.message.includes(`${error.details.bytes} bytes, over the ${SOCKET_PATH_MAX_BYTES}-byte limit`), error.message);
  return true;
};

// A directory under base (canonical, as a withTemp directory is), nested as
// deep as it takes, in which name makes a path of exactly bytes.
async function socketDirectoryOf(base, name, bytes) {
  let directory = base;
  let remaining = bytes - Buffer.byteLength(join(base, name));
  assert.ok(remaining === 0 || remaining >= 2, `${base} cannot make a ${bytes}-byte socket path`);
  while (remaining > 0) {
    // A separator and a name; the last one takes what is left.
    const segment = remaining - 1 <= 40 ? remaining - 1 : 30;
    directory = join(directory, "d".repeat(segment));
    remaining -= segment + 1;
  }
  await mkdir(directory, { recursive: true });
  return directory;
}

test("the trust checks refuse a canonical path over the socket path limit, counted in UTF-8, before anything at it is checked", { skip: !posix }, async () => {
  assert.equal(SOCKET_PATH_MAX_BYTES, process.platform === "linux" ? 107 : 103);
  const spelled = "/spelled/g.sock";
  // The parent as configured resolves to directory, so the canonical path is
  // directory/g.sock: exactly the limit, then a byte over, in ASCII and with a
  // two-byte character that keeps it at the limit in characters.
  const atLimit = `/${"d".repeat(SOCKET_PATH_MAX_BYTES - "/g.sock".length - 1)}`;
  const resolvingTo = (directory, lstat) => ({ uid: CHAIN_UID, realpath: async () => directory, lstat });
  const chain = {
    [`${atLimit}/g.sock`]: socketStat(CHAIN_UID),
    [atLimit]: dirStat(CHAIN_UID, 0o700),
    "/": dirStat(0, 0o755)
  };
  const lstat = async (path) => chain[path] ?? assert.fail(`unexpected lstat ${path}`);
  assert.equal(await requireTrustedSocket(spelled, resolvingTo(atLimit, lstat)), `${atLimit}/g.sock`);
  assert.equal(await requireTrustedSocketDir(spelled, resolvingTo(atLimit, lstat)), `${atLimit}/g.sock`);
  const untouched = async () => assert.fail("nothing is checked at a path too long to connect to");
  for (const directory of [`${atLimit}d`, `${atLimit.slice(0, -1)}é`]) {
    const canonicalPath = `${directory}/g.sock`;
    const expected = { socketPath: spelled, canonicalPath, bytes: SOCKET_PATH_MAX_BYTES + 1 };
    await assert.rejects(requireTrustedSocket(spelled, resolvingTo(directory, untouched)), tooLong(expected));
    await assert.rejects(requireTrustedSocketDir(spelled, resolvingTo(directory, untouched)), tooLong(expected));
  }
  // No uid (Windows pipes): no limit, nothing measured.
  const long = `/${"d".repeat(200)}/g.sock`;
  assert.equal(await requireTrustedSocket(long, { uid: null, realpath: untouched, lstat: untouched }), long);
  assert.equal(await requireTrustedSocketDir(long, { uid: null, realpath: untouched, lstat: untouched }), long);
});

test("a client refuses a socket path over the limit for every call and starts no daemon; a shutdown is not alreadyStopped", { skip: !posix }, async () => {
  await withTemp(SOCKET_DIR, async (directory) => {
    const deep = await socketDirectoryOf(directory, "g.sock", SOCKET_PATH_MAX_BYTES + 1);
    const path = join(deep, "g.sock");
    const statePath = join(directory, "state", "state.json");
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
        const expected = { socketPath: path, canonicalPath: path, bytes: SOCKET_PATH_MAX_BYTES + 1 };
        await assert.rejects(rpc.call("setup", {}, 5_000), tooLong(expected));
        // Nothing can be told about a daemon there, so a shutdown says so too.
        await assert.rejects(rpc.call("daemon_shutdown", {}, 5_000), tooLong(expected));
        await assert.rejects(rpc.call("shutdown_if_idle", {}, 5_000), tooLong(expected));
        await assert.rejects(rpc.subscribe({}, () => {}, 5_000), tooLong(expected));
      } finally {
        rpc.close();
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(readdirSync(deep), [], "no daemon was started: no lock, no socket");
    assert.equal(existsSync(dirname(statePath)), false, "and none halted");
  });
});

test("the daemon refuses a socket path over the limit and records why; at the limit daemon and client work", { skip: !posix, timeout: 60_000 }, async () => {
  await withTemp(SOCKET_DIR, async (directory) => {
    // A byte over: halted before it locks, probes, unlinks or binds anything.
    const over = await socketDirectoryOf(join(directory, "o"), "gateway.sock", SOCKET_PATH_MAX_BYTES + 1);
    const halted = await startDaemon({ directory: over, expectExit: true });
    const { exitCode, stderr } = await halted.waitForExit();
    assert.equal(exitCode, 78, `operator-action halt expected; stderr: ${stderr}`);
    assert.match(stderr, /Refusing Gateway socket .*: its canonical path .* is \d+ bytes, over the \d+-byte limit/);
    assert.equal(JSON.parse(readFileSync(statePaths(halted.statePath).marker, "utf8")).errorCode, ERROR_CODES.SOCKET_PATH_TOO_LONG);
    assert.deepEqual(readdirSync(over).filter((name) => name.startsWith("gateway.so")), [], "no socket, cut short or not, and no lock");
    // A client finds the path too long itself, before any marker could explain it.
    const observer = new GatewayRpcClient({ socketPath: halted.socketPath, token: halted.token, rootId: halted.rootId, autoStart: false, statePath: halted.statePath });
    try {
      await assert.rejects(observer.call("setup", {}, 5_000), (error) => {
        assert.ok(tooLong({ socketPath: halted.socketPath })(error));
        assert.match(error.message, /^Refusing Gateway socket /);
        return true;
      });
    } finally {
      observer.close();
    }

    // At the limit: bound at the path itself, and served.
    const at = await socketDirectoryOf(join(directory, "a"), "gateway.sock", SOCKET_PATH_MAX_BYTES);
    const daemon = await startDaemon({ directory: at });
    const rpc = new GatewayRpcClient({ socketPath: daemon.socketPath, token: daemon.token, rootId: daemon.rootId, autoStart: false, statePath: daemon.statePath });
    try {
      assert.equal(Buffer.byteLength(daemon.socketPath), SOCKET_PATH_MAX_BYTES);
      assert.equal((await rpc.call("setup", {}, 5_000)).gatewayVersion, GATEWAY_VERSION);
      assert.ok(lstatSync(daemon.socketPath).isSocket());
    } finally {
      rpc.close();
      await daemon.stop();
    }
  });
});
