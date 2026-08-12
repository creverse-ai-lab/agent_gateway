#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { chmod, open, readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import {
  controlToken, gatewayAgentUpdateConfig, gatewayLifecycleConfig, gatewayPersistenceConfig,
  gatewaySocketPath, gatewayStatePath
} from "./config.js";
import { AgentUpdateManager } from "./agent-updates.js";
import { ERROR_CODES, GatewayError, errorEnvelope } from "./errors.js";
import { checkGatewaySource } from "./gateway-source-monitor.js";
import { GatewayService } from "./gateway-service.js";
import { readNdjson } from "./ndjson.js";
import { createSocketSender } from "./socket-flow.js";
import { statePaths } from "./state-store.js";
import { GATEWAY_VERSION } from "./version.js";

// A start that dies in init() is invisible: autostart spawns this process with
// stdio ignored, so the only thing a Main ever sees is a socket that never
// appears. Recovery failures leave their reason in a file the client reads.
const STATE_RECOVERY_EXIT_CODE = 78; // EX_CONFIG: operator action required
// Admission bound per control connection, as a module constant (the PR2
// precedent for safety valves). The arithmetic that rules out a smaller number:
// a 120s long poll across maxSessionsPerRoot (64) sessions is 64 legitimately
// parked requests, so 256 is that with room to spare. A naive 64 would break the
// intended usage instead of an abusive one.
const MAX_INFLIGHT_REQUESTS_PER_CONNECTION = 256;
const socketPath = gatewaySocketPath();
const statePath = gatewayStatePath();
const expectedToken = controlToken();
const expectedRootId = process.env.ACP_GATEWAY_ROOT_ID || null;
const gatewayConfig = gatewayLifecycleConfig();
const agentUpdateManager = new AgentUpdateManager({ ...gatewayAgentUpdateConfig(), sourceChecker: checkGatewaySource });
const service = new GatewayService({
  statePath,
  agentUpdateManager,
  ...gatewayConfig,
  persistence: gatewayPersistenceConfig()
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
  if (typeof error?.code === "string" && error.code.startsWith("STATE_")) {
    await writeRecoveryMarker(error);
    process.stderr.write(`acp-gateway-daemon: ${error.message}\n`);
    process.exit(STATE_RECOVERY_EXIT_CODE);
  }
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
  let inflight = 0;
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
          if (boundRootId && request.rootId !== boundRootId) {
            throw new GatewayError(ERROR_CODES.SOCKET_ALREADY_BOUND, "Socket is already bound to another Main");
          }
          if (!boundRootId) {
            boundRootId = request.rootId;
            service.attachRoot(boundRootId);
          }
        }
        // Refused before dispatch, so an over-limit request costs the round trip
        // and nothing else.
        if (inflight >= MAX_INFLIGHT_REQUESTS_PER_CONNECTION) {
          throw new GatewayError(
            ERROR_CODES.TOO_MANY_INFLIGHT_REQUESTS,
            `Too many in-flight Gateway requests on this connection: ${MAX_INFLIGHT_REQUESTS_PER_CONNECTION}`
          );
        }
        inflight += 1;
        try {
          if (request.method === "request_cancel") {
            const requestId = request.args?.requestId;
            if (typeof requestId !== "string" || !requestId) {
              throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "requestId is required");
            }
            requestAborts.get(requestId)?.abort();
            return;
          }
          if (request.method === "daemon_shutdown") {
            send({ id: request.id, ok: true, result: { ok: true, pid: process.pid, version: GATEWAY_VERSION } });
            setImmediate(() => void shutdown().finally(() => process.exit(0)));
            return;
          }
          if (request.method === "subscribe") {
            const result = service.subscribe(request.args, { rootId: request.rootId }, (event) => {
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
              : await service.call(request.method, request.args, { rootId: request.rootId, signal: controller.signal });
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
        if (!socket.destroyed) {
          send({
            id: request?.id ?? null,
            ok: false,
            ...errorEnvelope(error)
          });
        }
      }
    }
  });
  socket.once("close", () => {
    for (const controller of requestAborts.values()) controller.abort();
    requestAborts.clear();
    sender.destroy();
    service.removeSubscriptions(subscriptions.keys());
    if (boundRootId) service.detachRoot(boundRootId);
  });
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
} catch (error) {
  await releaseDaemonLock(daemonLock);
  throw error;
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    for (const socket of clients) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await service.shutdown();
    await unlink(socketPath).catch(() => {});
    await releaseDaemonLock(daemonLock);
  })();
  return shutdownPromise;
}

process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));

async function writeRecoveryMarker(error) {
  const marker = statePaths(statePath).marker;
  const document = {
    at: new Date().toISOString(),
    pid: process.pid,
    gatewayVersion: GATEWAY_VERSION,
    errorCode: error.code,
    error: error.message
  };
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

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
