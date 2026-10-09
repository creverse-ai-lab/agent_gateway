#!/usr/bin/env node

import { authorizeCall, CallerPresence, requireAccess } from "./access.js";
import { normalizeCaller } from "./caller.js";
import { GatewaySettings } from "./settings.js";
import { timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";
import {
  gatewayAgentUpdateConfig, gatewayLifecycleConfig, gatewayObservabilityConfig,
  gatewayPersistenceConfig, gatewaySocketPath, gatewayStatePath, takeDaemonIdentity
} from "./config.js";
import { AgentUpdateManager } from "./agent-updates.js";
import { ERROR_CODES, GatewayError, errorEnvelope } from "./errors.js";
import { checkGatewaySource } from "./gateway-source-monitor.js";
import { GatewayService } from "./gateway-service.js";
import { readNdjson } from "./ndjson.js";
import { listenPrivately, requireTrustedSocketDir } from "./private-socket.js";
import { createSocketSender } from "./socket-flow.js";
import { processIsAlive, statePaths } from "./state-store.js";
import { GATEWAY_VERSION } from "./version.js";
import { callerVerdicts, workerControlDeniedMessage } from "./worker-tree.js";

// A start that dies before it serves is invisible: autostart spawns this
// process with stdout and stderr ignored, so the only thing a Main ever sees is
// a socket that never appears. Recovery failures, an identity the autostart
// failed to hand over, and a socket directory another user could rewrite leave
// their reason in a file the client reads (halt).
const STARTUP_HALT_EXIT_CODE = 78; // EX_CONFIG: operator action required
// Admission bound per control connection, as a module constant (the PR2
// precedent for safety valves). The arithmetic that rules out a smaller number:
// a 120s long poll across maxSessionsPerRoot (64) sessions is 64 legitimately
// parked requests, so 256 is that with room to spare. A naive 64 would break the
// intended usage instead of an abusive one.
const MAX_INFLIGHT_REQUESTS_PER_CONNECTION = 256;
const statePath = gatewayStatePath();
// First, before anything copies the env (GatewaySettings keeps one): from here
// on process.env holds neither the token nor the root id, so no child the
// daemon starts can inherit them, whether or not its spawn scrubs its env. An
// autostarted daemon never had them there: it reads them from stdin.
let identity;
try {
  identity = await takeDaemonIdentity();
} catch (error) {
  if (error?.code !== ERROR_CODES.DAEMON_IDENTITY_INVALID) throw error;
  await halt(error);
}
const { token: expectedToken, rootId: expectedRootId } = identity;
// Then, before anything touches the socket's path (the lock beside it, the
// probe and unlink of a stale socket, the bind): its whole directory chain must
// be this user's own (or root's) and writable by no one else, or another user
// could swap a link into it and stand between a client and us, and the unlink
// could remove a file of theirs. The default paths (a per-user tmpdir on macOS,
// a sticky /tmp on Linux) pass; a hand-set ACP_GATEWAY_SOCKET in a shared
// directory is what this turns away, with a message the operator can act on.
// No other user can change a chain like that, so the proof still holds at the
// bind and at the unlink on shutdown, but only for the canonical path it
// returns, which is the only one used from here on: a link or ".." left in the
// configured spelling would be resolved again at each use, wherever its owner
// had pointed it by then.
let socketPath;
try {
  socketPath = await requireTrustedSocketDir(gatewaySocketPath());
} catch (error) {
  if (error?.code !== ERROR_CODES.SOCKET_UNTRUSTED) throw error;
  await halt(error);
}
const settings = new GatewaySettings();
const gatewayConfig = gatewayLifecycleConfig(settings.activeValues);
const agentUpdateManager = new AgentUpdateManager({ ...gatewayAgentUpdateConfig(settings.activeValues), sourceChecker: checkGatewaySource });
// Which Mains are connected now: a control connection speaks for every caller
// it named until it closes. Only an explicit session_restore asks, before it
// adopts another Main's session (GatewayService isOwnerLive).
const callers = new CallerPresence();
const service = new GatewayService({
  statePath,
  settings,
  agentUpdateManager,
  ...gatewayConfig,
  ...gatewayObservabilityConfig(settings.activeValues),
  persistence: gatewayPersistenceConfig(settings.activeValues),
  isOwnerLive: (owner) => callers.isLive(owner),
  // A Worker's file read never returns this token, wherever a copy of it is:
  // a link that outlived an atomic rewrite of install.json is not protected
  // by inode any more (AcpClient #readTextFile).
  protectedSecrets: [expectedToken]
});
const clients = new Set();
let shutdownPromise = null;
const daemonLock = await acquireDaemonLock(socketPath);
try {
  await service.init();
  await unlink(statePaths(statePath).marker).catch(() => {});
  await removeStaleSocket(socketPath);
} catch (error) {
  await releaseDaemonLock(daemonLock);
  if (typeof error?.code === "string" && error.code.startsWith("STATE_")) await halt(error);
  throw error;
}

const server = createServer((socket) => {
  clients.add(socket);
  socket.once("close", () => clients.delete(socket));
  // A Map now, not a Set: the value carries whether that subscriber opted into
  // gap tolerance, which is what decides between shedding and killing it.
  const subscriptions = new Map();
  const requestAborts = new Map();
  let boundRootId = null;
  let boundAccess = null;
  let inflight = 0;
  // Whether the caller on this connection is a worker's: looked up on the first
  // request that names a caller pid and reused while the pid stays the same; a
  // request that names another pid is looked up on its own (worker-tree.js). The
  // caller is refused when it is or runs under this daemon, or under any process
  // the daemon spawned (a provider or terminal). The spawned-pid set is read live
  // for each lookup, so it reflects spawns and exits since the connection opened;
  // it is what catches a worker when the daemon is pid 1 (F5).
  const callerVerdict = callerVerdicts({ spawnedPids: () => service.spawnedPids() });
  const requireBinding = (rootId, access) => {
    if (boundRootId && rootId !== boundRootId) {
      throw new GatewayError(ERROR_CODES.SOCKET_ALREADY_BOUND, "Socket is already bound to another Main");
    }
    if (boundAccess && boundAccess !== access) throw new GatewayError(ERROR_CODES.SOCKET_ALREADY_BOUND, "Socket access role cannot change");
  };
  const sender = createSocketSender(socket, {
    subscriptions,
    unsubscribe: (subscriptionId) => service.unsubscribe(subscriptionId, { rootId: boundRootId }),
    removeSubscription: (subscriptionId) => subscriptions.delete(subscriptionId),
    maxQueueBytes: gatewayConfig.maxQueueBytes,
    writeTimeoutMs: gatewayConfig.writeTimeoutMs,
    maxFrameBytes: gatewayConfig.maxFrameBytes
  });
  const { send, sendEvent } = sender;
  readNdjson(socket, {
    maxLineBytes: gatewayConfig.maxFrameBytes,
    onOverflow: () => socket.destroy(),
    onLine: async (line) => {
      let request;
      try {
        request = JSON.parse(line);
        const isGuide = request.method === "guide";
        const access = requireAccess(request.access);
        const caller = normalizeCaller(request.caller);
        if (!isGuide) {
          if (!tokenMatches(request.token, expectedToken)) {
            throw new GatewayError(ERROR_CODES.CONTROL_ACCESS_DENIED, "Control access denied");
          }
          if (typeof request.rootId !== "string" || !request.rootId) {
            throw new GatewayError(ERROR_CODES.ROOT_REQUIRED, "rootId is required");
          }
          if (expectedRootId && request.rootId !== expectedRootId) {
            throw new GatewayError(ERROR_CODES.ROOT_MISMATCH, "Control root identity mismatch");
          }
          requireBinding(request.rootId, access);
          authorizeCall(request.method, request.args ?? {}, { access });
        }
        // Refused before dispatch, so an over-limit request costs the round trip
        // and nothing else.
        if (inflight >= MAX_INFLIGHT_REQUESTS_PER_CONNECTION && request.method !== "request_cancel") {
          throw new GatewayError(
            ERROR_CODES.TOO_MANY_INFLIGHT_REQUESTS,
            `Too many in-flight Gateway requests on this connection: ${MAX_INFLIGHT_REQUESTS_PER_CONNECTION}`
          );
        }
        inflight += 1;
        try {
          if (!isGuide) {
            // A Main's front door never runs under this daemon, so a caller
            // that does is a worker's, whatever it holds. Checked before the
            // connection binds, so a refused one never counts as its Main being
            // present. Only a connection that named a caller pid waits here,
            // and a later request on it that names the same pid, or none, waits
            // on the same lookup, in order.
            const verdict = callerVerdict(caller?.pid);
            if (verdict) {
              const deniedReason = await verdict.denied;
              if (deniedReason) {
                throw new GatewayError(
                  ERROR_CODES.WORKER_CONTROL_DENIED,
                  workerControlDeniedMessage(deniedReason, verdict.pid)
                );
              }
              // While it waited the connection may have closed, and its close
              // handler already ran: binding or subscribing now would never be
              // undone. Or another request may have bound it.
              if (socket.destroyed) return;
              requireBinding(request.rootId, access);
            }
            if (!boundRootId) {
              boundRootId = request.rootId;
              boundAccess = access;
              if (access === "control") service.attachRoot(boundRootId);
            }
            // Beside root presence, per Main: the caller of every control
            // request, its subscribe included, is live until this connection
            // closes. An observer's claim is recorded nowhere, here neither.
            if (access === "control" && caller) callers.bind(socket, caller);
          }
          if (request.method === "request_cancel") {
            const requestId = request.args?.requestId;
            if (typeof requestId !== "string" || !requestId) {
              throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "requestId is required");
            }
            requestAborts.get(requestId)?.abort();
            return;
          }
          if (["daemon_shutdown", "shutdown_if_idle"].includes(request.method)) {
            service.prepareShutdown({ force: request.method === "daemon_shutdown" && request.args?.force === true });
            setImmediate(() => void shutdown().finally(() => process.exit(0)));
            send({ id: request.id, ok: true, result: { ok: true, pid: process.pid, version: GATEWAY_VERSION } });
            return;
          }
          if (request.method === "subscribe") {
            // A front-door Main's watch-all subscription covers only what it may
            // see, so its caller rides along as on every other call.
            const context = { rootId: request.rootId, access, ...(access === "control" ? { caller } : {}) };
            const result = service.subscribe(request.args, context, (event) => {
              sendEvent(result.subscriptionId, event);
            });
            // Additive and opt-in: a client that says nothing keeps the old
            // contract, so a vendored one cannot be handed a record it does not
            // understand.
            subscriptions.set(result.subscriptionId, { acceptsGaps: request.args?.acceptsGaps === true });
            send({ id: request.id, ok: true, result });
            return;
          }
          if (request.method === "unsubscribe") {
            const result = service.unsubscribe(request.args?.subscriptionId, { rootId: request.rootId });
            subscriptions.delete(request.args?.subscriptionId);
            send({ id: request.id, ok: true, result });
            return;
          }
          const controller = new AbortController();
          requestAborts.set(request.id, controller);
          try {
            const result = isGuide
              ? await service.guide()
              : await service.call(request.method, request.args, {
                rootId: request.rootId,
                access,
                signal: controller.signal,
                // Only a Main opens and prompts; an observer's claim is not recorded.
                ...(access === "control" ? { caller } : {})
              });
            send({ id: request.id, ok: true, result });
          } finally {
            requestAborts.delete(request.id);
          }
        } finally {
          inflight -= 1;
        }
      } catch (error) {
        // error stays byte-identical for existing callers; errorCode is additive
        // so a Main can branch on a stable code instead of message text.
        //
        // Best effort, and it has to be: the send itself can throw now. A closed
        // or congested channel refuses the write without the socket ever being
        // destroyed, so `!socket.destroyed` is not the guard it reads as, and the
        // throw would escape this async line handler as an unhandled rejection —
        // taking the daemon down over a reply nobody is waiting for any more.
        try {
          if (!socket.destroyed) {
            send({
              id: request?.id ?? null,
              ok: false,
              ...errorEnvelope(error)
            });
          }
        } catch {
          // The connection is already gone or failing; its own close handler and
          // the channel's onFatal own the teardown.
        }
      }
    }
  });
  socket.once("close", () => {
    for (const controller of requestAborts.values()) controller.abort();
    requestAborts.clear();
    sender.destroy();
    service.removeSubscriptions(subscriptions.keys());
    callers.release(socket);
    if (boundRootId && boundAccess === "control") service.detachRoot(boundRootId);
  });
});

try {
  // Bound under umask 177, so born 0600: never reachable by another user.
  await listenPrivately(server, socketPath);
} catch (error) {
  await releaseDaemonLock(daemonLock);
  throw error;
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    for (const socket of clients) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    const report = await service.shutdown();
    // Whatever shutdown had to cut short (a hung adapter update) is said where an
    // operator or a supervisor capturing stderr can see it.
    if (report?.agentUpdates) process.stderr.write(`acp-gateway-daemon: ${report.agentUpdates.reason}\n`);
    await unlink(socketPath).catch(() => {});
    await releaseDaemonLock(daemonLock);
  })();
  return shutdownPromise;
}

process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));

async function halt(error) {
  await writeRecoveryMarker(error);
  process.stderr.write(`acp-gateway-daemon: ${error.message}\n`);
  process.exit(STARTUP_HALT_EXIT_CODE);
}

async function writeRecoveryMarker(error) {
  const marker = statePaths(statePath).marker;
  const document = {
    at: new Date().toISOString(),
    pid: process.pid,
    gatewayVersion: GATEWAY_VERSION,
    errorCode: error.code,
    error: error.message
  };
  // An identity halt comes before init(), so on a first start the state
  // directory may not exist yet.
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 }).catch(() => {});
  await writeFile(marker, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function removeStaleSocket(path) {
  const alive = await new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  if (alive) throw new Error(`Gateway is already running at ${path}`);
  await unlink(path).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function acquireDaemonLock(path) {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return { handle, path: lockPath, pid: process.pid };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const ownerPid = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
      if (Number.isInteger(ownerPid) && processIsAlive(ownerPid)) {
        throw new Error(`Gateway is already starting or running at ${path} (pid=${ownerPid})`);
      }
      await unlink(lockPath).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    }
  }
  throw new Error(`Could not acquire Gateway daemon lock at ${lockPath}`);
}

async function releaseDaemonLock(lock) {
  await lock.handle.close().catch(() => {});
  const ownerPid = Number((await readFile(lock.path, "utf8").catch(() => "")).trim());
  if (ownerPid === lock.pid) await unlink(lock.path).catch(() => {});
}
