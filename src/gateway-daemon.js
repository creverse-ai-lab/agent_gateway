#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { chmod, open, readFile, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { controlToken, gatewayAgentUpdateConfig, gatewayLifecycleConfig, gatewaySocketPath, gatewayStatePath } from "./config.js";
import { AgentUpdateManager } from "./agent-updates.js";
import { ERROR_CODES, GatewayError } from "./errors.js";
import { checkGatewaySource } from "./gateway-source-monitor.js";
import { GatewayService } from "./gateway-service.js";
import { readNdjson } from "./ndjson.js";
import { createSocketSender } from "./socket-flow.js";
import { GATEWAY_VERSION } from "./version.js";

const socketPath = gatewaySocketPath();
const expectedToken = controlToken();
const expectedRootId = process.env.ACP_GATEWAY_ROOT_ID || null;
const gatewayConfig = gatewayLifecycleConfig();
const agentUpdateManager = new AgentUpdateManager({ ...gatewayAgentUpdateConfig(), sourceChecker: checkGatewaySource });
const service = new GatewayService({ statePath: gatewayStatePath(), agentUpdateManager, ...gatewayConfig });
const clients = new Set();
let shutdownPromise = null;
const daemonLock = await acquireDaemonLock(socketPath);
try {
  await service.init();
  await removeStaleSocket(socketPath);
} catch (error) {
  await releaseDaemonLock(daemonLock);
  throw error;
}

const server = createServer((socket) => {
  clients.add(socket);
  socket.once("close", () => clients.delete(socket));
  const subscriptions = new Set();
  let boundRootId = null;
  const sender = createSocketSender(socket, {
    unsubscribe: (subscriptionId) => service.unsubscribe(subscriptionId, { rootId: boundRootId }),
    removeSubscription: (subscriptionId) => subscriptions.delete(subscriptionId)
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
        if (request.method === "daemon_shutdown") {
          send({ id: request.id, ok: true, result: { ok: true, pid: process.pid, version: GATEWAY_VERSION } });
          setImmediate(() => void shutdown().finally(() => process.exit(0)));
          return;
        }
        if (request.method === "subscribe") {
          const result = service.subscribe(request.args, { rootId: request.rootId }, (event) => {
            sendEvent(result.subscriptionId, event);
          });
          subscriptions.add(result.subscriptionId);
          send({ id: request.id, ok: true, result });
          return;
        }
        if (request.method === "unsubscribe") {
          const result = service.unsubscribe(request.args?.subscriptionId, { rootId: request.rootId });
          subscriptions.delete(request.args?.subscriptionId);
          send({ id: request.id, ok: true, result });
          return;
        }
        const result = isGuide ? await service.guide() : await service.call(request.method, request.args, { rootId: request.rootId });
        send({ id: request.id, ok: true, result });
      } catch (error) {
        // error stays byte-identical for existing callers; errorCode is additive
        // so a Main can branch on a stable code instead of message text.
        if (!socket.destroyed) {
          send({
            id: request?.id ?? null,
            ok: false,
            error: error?.message ?? String(error),
            ...(typeof error?.code === "string" && error.code ? { errorCode: error.code } : {})
          });
        }
      }
    }
  });
  socket.once("close", () => {
    service.removeSubscriptions(subscriptions);
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
