import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
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

// A providers.json pointed at the mock ACP agent, so a real daemon can run a
// real task end to end with no worker installed. Returns the env additions.
export async function writeMockProviders(directory, { permissionPolicy = "read_only" } = {}) {
  const providersPath = join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({
    version: 1,
    providers: {
      mock: {
        command: process.execPath,
        args: [fileURLToPath(new URL("../mock-agent.js", import.meta.url))],
        permissionPolicy
      }
    }
  }));
  return { ACP_GATEWAY_PROVIDERS: providersPath };
}

export async function startDaemon({
  directory,
  env = {},
  execArgv = [],
  token = HARNESS_TOKEN,
  rootId = HARNESS_ROOT_ID,
  attempts = 120,
  // Startup failures are a first-class outcome for recovery tests: the daemon is
  // expected to write its marker file and exit instead of serving a socket.
  expectExit = false
} = {}) {
  if (!directory) throw new Error("startDaemon requires a directory");
  await mkdir(directory, { recursive: true });
  const { socketPath, statePath } = daemonPaths(directory);
  const child = spawn(process.execPath, [...execArgv, DAEMON_PATH], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      ACP_GATEWAY_AGENT_AUTO_UPDATE: "0",
      ACP_GATEWAY_AGENT_UPDATE_NOTIFICATIONS: "0",
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
  const handle = {
    socketPath,
    statePath,
    token,
    rootId,
    child,
    stderr: readStderr,
    stop,
    killHard: () => stop({ signal: "SIGKILL" }),
    // Resolves when the daemon process is gone, whether it exited on its own
    // (recovery halt) or was killed from inside (fault injection).
    waitForExit: async () => {
      await exited;
      return { exitCode: child.exitCode, signalCode: child.signalCode, stderr: readStderr() };
    }
  };
  if (expectExit) return handle;
  try {
    await waitForSocket(socketPath, child, readStderr, attempts);
  } catch (error) {
    await stop({ signal: "SIGKILL" }).catch(() => {});
    throw error;
  }
  return handle;
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
