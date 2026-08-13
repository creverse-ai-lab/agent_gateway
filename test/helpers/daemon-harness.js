import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Chaos tests need a real daemon process they can kill without warning. Every
// daemon started here owns its own socket, state file, registry cache and
// install policy so a SIGKILL can never touch the developer's Gateway.
export const HARNESS_TOKEN = "acp-gateway-harness-control-token";
export const HARNESS_ROOT_ID = "main-harness";

const DAEMON_PATH = fileURLToPath(new URL("../../src/gateway-daemon.js", import.meta.url));

// Exported so a test can pre-seed state.json before the daemon reads it.
export function daemonPaths(directory) {
  return {
    socketPath: join(directory, "gateway.sock"),
    statePath: join(directory, "state.json")
  };
}

export async function startDaemon({
  directory,
  env = {},
  token = HARNESS_TOKEN,
  rootId = HARNESS_ROOT_ID,
  attempts = 120
} = {}) {
  if (!directory) throw new Error("startDaemon requires a directory");
  await mkdir(directory, { recursive: true });
  const { socketPath, statePath } = daemonPaths(directory);
  const child = spawn(process.execPath, [DAEMON_PATH], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      ACP_GATEWAY_SOCKET: socketPath,
      ACP_GATEWAY_STATE: statePath,
      ACP_GATEWAY_CONTROL_TOKEN: token,
      ACP_GATEWAY_ROOT_ID: rootId,
      ACP_GATEWAY_REGISTRY_CACHE: join(directory, "registry.json"),
      ACP_GATEWAY_INSTALL_STATE: join(directory, "install.json"),
      ...env
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const readStderr = () => stderr;
  const exited = once(child, "close");
  const stop = async ({ signal = "SIGTERM" } = {}) => {
    if (child.exitCode == null && child.signalCode == null) child.kill(signal);
    await exited;
    return { exitCode: child.exitCode, signalCode: child.signalCode };
  };
  try {
    await waitForSocket(socketPath, child, readStderr, attempts);
  } catch (error) {
    await stop({ signal: "SIGKILL" }).catch(() => {});
    throw error;
  }
  return {
    socketPath,
    statePath,
    token,
    rootId,
    child,
    stderr: readStderr,
    stop,
    killHard: () => stop({ signal: "SIGKILL" })
  };
}

async function waitForSocket(socketPath, child, readStderr, attempts) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(`Gateway daemon exited with ${child.exitCode ?? child.signalCode}: ${readStderr()}`);
    }
    try {
      await connectOnce(socketPath);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Gateway daemon socket never accepted a connection: ${lastError?.message}; ${readStderr()}`);
}

function connectOnce(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}
