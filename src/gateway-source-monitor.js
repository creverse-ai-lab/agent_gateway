import { execFile } from "node:child_process";
import { detectInstallMode, PACKAGE_ROOT } from "./install-mode.js";
import { GATEWAY_VERSION } from "./version.js";

export const NPM_PACKAGE_NAME = "acp-gateway-daemon";
export const NPM_LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`;
export const NPM_UPGRADE_COMMAND = `npm install -g ${NPM_PACKAGE_NAME}@latest`;

// Where a newer Gateway would come from depends on how this one was installed
// (install-mode.js). Only a Git checkout asks Git; an npm install asks the npm
// registry; an app-managed runtime is the app's to update, so it asks nothing
// and reports "managed" instead of failing on a missing .git. Every outcome,
// including a failed check, is a record carrying installMode.
export async function checkGatewaySource({
  root = PACKAGE_ROOT,
  installMode = detectInstallMode(root),
  run = runGit,
  fetchImpl = globalThis.fetch,
  now = () => Date.now()
} = {}) {
  try {
    if (installMode === "npm") return { ...(await checkNpmRelease({ fetchImpl, now })), installMode };
    if (installMode === "runtime" || installMode === "unknown") {
      return {
        status: installMode === "runtime" ? "managed" : "unsupported",
        installMode,
        currentVersion: GATEWAY_VERSION,
        mainVersion: null,
        updateAvailable: false,
        checkedAt: new Date(now()).toISOString()
      };
    }
    return { ...(await checkGitMain({ root, run, fetchImpl, now })), installMode };
  } catch (error) {
    // The record the update manager builds for a failed check, plus the mode
    // and the running version (known here, unlike there).
    return {
      status: "error",
      installMode,
      currentVersion: GATEWAY_VERSION,
      mainVersion: null,
      updateAvailable: false,
      error: error?.message ?? String(error)
    };
  }
}

// The npm registry's `latest` for this package. Throws when it cannot be read.
export async function checkNpmRelease({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const document = await fetchJson(NPM_LATEST_URL, fetchImpl, "npm registry");
  if (typeof document.version !== "string") throw new Error("npm registry latest version is missing");
  const updateAvailable = isNewerVersion(document.version, GATEWAY_VERSION);
  return {
    status: "ready",
    currentVersion: GATEWAY_VERSION,
    mainVersion: null,
    latestVersion: document.version,
    updateAvailable,
    package: NPM_PACKAGE_NAME,
    url: `https://www.npmjs.com/package/${NPM_PACKAGE_NAME}`,
    ...(updateAvailable ? { updateCommand: NPM_UPGRADE_COMMAND } : {}),
    checkedAt: new Date(now()).toISOString()
  };
}

// The alert text for an available Gateway update, by where it comes from.
export function gatewayUpdateMessage(source) {
  if (source?.installMode === "npm") {
    return `ACP Gateway ${source.latestVersion} is available on npm. Run \`${NPM_UPGRADE_COMMAND}\`, then \`acp-gateway-bootstrap --update\` when idle.`;
  }
  return `ACP Gateway ${source?.mainVersion} is available on main. Run acp-gateway-bootstrap --update when ready.`;
}

async function checkGitMain({ root, run, fetchImpl, now }) {
  const origin = (await run(root, ["config", "--get", "remote.origin.url"])).trim();
  const repository = githubRepository(origin);
  if (!repository) {
    return {
      status: "unsupported",
      currentVersion: GATEWAY_VERSION,
      mainVersion: null,
      updateAvailable: false,
      checkedAt: new Date(now()).toISOString()
    };
  }
  const document = await fetchJson(
    `https://raw.githubusercontent.com/${repository}/main/package.json`,
    fetchImpl,
    "remote main version"
  );
  if (typeof document.version !== "string") throw new Error("remote main package version is missing");
  return {
    status: "ready",
    currentVersion: GATEWAY_VERSION,
    mainVersion: document.version,
    updateAvailable: isNewerVersion(document.version, GATEWAY_VERSION),
    repository,
    url: `https://github.com/${repository}`,
    checkedAt: new Date(now()).toISOString()
  };
}

function githubRepository(origin) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(origin);
  return match?.[1] ?? null;
}

function isNewerVersion(candidate, current) {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return false;
}

async function fetchJson(url, fetchImpl, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error(`${label} document is too large`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
  return match ? match.slice(1).map(Number) : null;
}

function runGit(root, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
