#!/usr/bin/env node

// Packaged-install smoke test: what `npm install -g acp-gateway-daemon` would
// put on a machine, exercised the way a user would, with each npm a user may
// have. Pack the checkout through scripts/pack-release.js, then for npm 10, 11
// and 12 (the latest of each major, fetched into the temporary directory):
// install the tarball into a temporary prefix, check the installed tree is the
// bundled, locked one, run the installed bins, start the installed daemon and
// call setup through the packaged public client.
//
// The package carries its production dependency tree (bundleDependencies; see
// scripts/pack-release.js), so installing it needs nothing but its own
// tarball. The tarball is installed by name from a loopback registry that
// serves this package exactly as registry.npmjs.org would after publish and
// answers every other request with 404, recording it. Each install must make
// no such request: that is the evidence that npm neither re-resolves the
// bundled tree nor fetches the bundled Claude Agent SDK's missing optional
// platform packages (the Claude Code binary, about 245 MB each; see
// scripts/omit-claude-binary.js). The installed tree must then be exactly
// package-lock.json's production tree, where the lockfile puts it, with no
// Claude platform package, and must still load the Claude adapter.
//
// What is isolated, all under one temporary directory that is removed at the end:
// - npm (fetching the npm CLIs, pack and install): HOME, the npm cache, and
//   the user and global npmrc (each an empty file); every npm_config_*
//   variable from the caller's shell or `npm run` is dropped. Install runs
//   with --ignore-scripts: no package in package-lock.json has an install
//   script (hasInstallScript), so nothing is lost.
// - the installed bins and daemon: HOME, the agent-CLI homes (CODEX_HOME,
//   CLAUDE_CONFIG_DIR, ...), and the Gateway socket, state, artifacts,
//   settings/install record, registry cache and providers file, one set per
//   npm version; every ACP_GATEWAY_* variable from the caller is dropped
//   first. Each daemon is stopped with daemon_shutdown (SIGTERM/SIGKILL as a
//   fallback).
// Not isolated: the network (registry.npmjs.org for the npm CLIs, and the
// daemon's own update checks) and the Node on PATH, which runs every npm.
//
// NPM_SMOKE_VERSIONS (default "10 11 12") picks the npm versions or majors;
// NPM_SMOKE_SHA256_FILE, if set, receives the tested tarball's sha256.
// Needs the npm registry, so it is not part of `npm run ci`.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_VERSION } from "../src/version.js";
import { findClaudePlatformPackages } from "./omit-claude-binary.js";
import { LOCKFILE_NAME, installedTree, packRelease, treeProblems } from "./pack-release.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDocument = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const lockDocument = JSON.parse(await readFile(join(repositoryRoot, LOCKFILE_NAME), "utf8"));
const PACKAGE_NAME = packageDocument.name;
const VERSION = packageDocument.version;
const NPM_VERSIONS = (process.env.NPM_SMOKE_VERSIONS ?? "10 11 12").split(/[\s,]+/).filter(Boolean);
const REQUIRED_ENTRIES = [
  "package.json",
  "LICENSE",
  // Every document the READMEs and changelogs link to, so an installed copy
  // reads the same as the repository.
  "README.md",
  "README.ko.md",
  "README.ja.md",
  "README.zh-CN.md",
  "CHANGELOG.md",
  "CHANGELOG.ko.md",
  "docs/operations.md",
  "docs/operations.ko.md",
  "docs/management-api.md",
  "docs/live-usecases.md",
  "gateway-client/index.js",
  "skills/agent-delegator/SKILL.md",
  "src/install-mode.js",
  ...new Set(Object.values(packageDocument.bin))
];
// node_modules/ is the bundle, which scripts/pack-release.js has checked.
const FORBIDDEN_PREFIXES = ["test/", "scripts/", "config/", "tmp/", "graft/", "build/", ".github/"];

// A socket path must stay under the ~104-byte Unix limit, hence the short prefix.
const temporary = await mkdtemp(join(tmpdir(), "acpnpm-"));
const packDirectory = join(temporary, "pack");
const npmHome = join(temporary, "npm-home");
const npmCache = join(temporary, "npm-cache");
const userNpmrc = join(temporary, "user.npmrc");
const globalNpmrc = join(temporary, "global.npmrc");
const token = randomBytes(24).toString("base64url");
let daemon = null;
let registry = null;
// Paths the loopback registry was asked for that are not this package.
const foreignRequests = [];

function step(message) {
  process.stdout.write(`npm-smoke: ${message}\n`);
}

function run(command, args, { cwd = repositoryRoot, env = process.env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}\n${result.stderr || result.stdout}`);
  }
  return result;
}

// Asynchronous, for commands that talk to the loopback registry served by this
// very process: spawnSync would block the event loop that has to answer them.
function runAsync(command, args, { cwd = repositoryRoot, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${output}`));
    });
  });
}

// npm with nothing of the caller's configuration (see the header).
function isolatedNpmEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  return {
    ...env,
    HOME: npmHome,
    USERPROFILE: npmHome,
    npm_config_cache: npmCache,
    npm_config_userconfig: userNpmrc,
    npm_config_globalconfig: globalNpmrc,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    ...extra
  };
}

// The daemon and bins see only one run's temporary tree: every ACP_GATEWAY_*
// and agent-CLI home variable from the caller's shell is dropped first, so a
// live socket, state file or install record can never be picked up.
function isolatedEnv(directory) {
  const home = join(directory, "home");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !(
    key.startsWith("ACP_GATEWAY_")
    || ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_HOME", "GROK_HOME", "AUGMENT_HOME"].includes(key)
  )));
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_HOME: join(home, ".claude"),
    GROK_HOME: join(home, ".grok"),
    AUGMENT_HOME: join(home, ".augment"),
    ACP_GATEWAY_SOCKET: join(directory, "g.sock"),
    ACP_GATEWAY_STATE: join(directory, "state", "state.json"),
    ACP_GATEWAY_ARTIFACTS: join(directory, "artifacts"),
    ACP_GATEWAY_WORKSPACES: join(directory, "workspaces"),
    ACP_GATEWAY_GROK_SANDBOX_DIR: join(directory, "grok-sandbox"),
    ACP_GATEWAY_INSTALL_STATE: join(home, ".acp-gateway", "install.json"),
    ACP_GATEWAY_REGISTRY_CACHE: join(directory, "registry.json"),
    ACP_GATEWAY_PROVIDERS: join(directory, "providers.json"),
    ACP_GATEWAY_DISABLE_DYNAMIC_PROVIDERS: "1",
    ACP_GATEWAY_AGENT_AUTO_UPDATE: "0",
    ACP_GATEWAY_AGENT_UPDATE_NOTIFICATIONS: "0",
    ACP_GATEWAY_CONTROL_TOKEN: token,
    ACP_GATEWAY_ROOT_ID: "main-npm-smoke"
  };
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Apparent size of everything under `path`, symlinks counted as links.
function treeBytes(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path)) total += treeBytes(join(path, entry));
  return total;
}

async function packPackage() {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(npmHome, { recursive: true });
  await writeFile(userNpmrc, "");
  await writeFile(globalNpmrc, "");
  const report = await packRelease({ destination: packDirectory, env: isolatedNpmEnv() });
  const paths = report.files.map((file) => file.path);
  assert.equal(report.name, PACKAGE_NAME);
  assert.equal(report.version, VERSION);
  for (const entry of REQUIRED_ENTRIES) assert.ok(paths.includes(entry), `packed package is missing ${entry}`);
  assert.ok(!paths.includes("npm-shrinkwrap.json"), "the package must not ship a shrinkwrap; npm 12 ignores it");
  const forbidden = paths.filter((path) => FORBIDDEN_PREFIXES.some((start) => path.startsWith(start)));
  assert.deepEqual(forbidden, [], "packed package must not ship development files");
  step(`packed ${report.filename}: ${report.entryCount} files, ${report.size} bytes (${megabytes(report.size)}), `
    + `${report.unpackedSize} unpacked; bundles the ${report.bundledPackages} locked packages; sha256 ${report.sha256}`);
  // For the publish workflow, which checks that it publishes these bytes.
  if (process.env.NPM_SMOKE_SHA256_FILE) await writeFile(process.env.NPM_SMOKE_SHA256_FILE, `${report.sha256}\n`);
  return report;
}

// Each requested npm (a version or a major), installed from registry.npmjs.org
// into the temporary directory and run with the Node on PATH.
function fetchNpm(requested) {
  const directory = join(temporary, "npm", requested);
  mkdirSync(directory, { recursive: true });
  run("npm", ["install", "--prefix", directory, "--no-save", "--ignore-scripts", `npm@${requested}`], { cwd: temporary, env: isolatedNpmEnv() });
  const cli = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
  const version = run(process.execPath, [cli, "--version"], { cwd: temporary, env: isolatedNpmEnv() }).stdout.trim();
  return { requested, cli, version };
}

// This package's packument as registry.npmjs.org would serve it after publish;
// every other path is answered 404 and recorded.
async function startRegistry(packed) {
  const bytes = await readFile(packed.tarball);
  const tarballPath = `/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${VERSION}.tgz`;
  const server = createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    const { pathname } = new URL(request.url, origin);
    if (pathname === `/${PACKAGE_NAME}`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        name: PACKAGE_NAME,
        "dist-tags": { latest: VERSION },
        versions: {
          [VERSION]: {
            ...packed.manifest,
            _id: `${PACKAGE_NAME}@${VERSION}`,
            _hasShrinkwrap: false,
            dist: {
              tarball: `${origin}${tarballPath}`,
              integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
              shasum: createHash("sha1").update(bytes).digest("hex")
            }
          }
        }
      }));
      return;
    }
    if (pathname === tarballPath) {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
      response.end(bytes);
      return;
    }
    foreignRequests.push(decodeURIComponent(pathname));
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  registry = server;
  return `http://127.0.0.1:${server.address().port}/`;
}

async function stopRegistry() {
  if (!registry) return;
  registry.closeAllConnections?.();
  await new Promise((resolve) => registry.close(resolve));
  registry = null;
}

async function installPackage(npm, registryUrl, directory) {
  const prefix = join(directory, "prefix");
  await mkdir(prefix, { recursive: true });
  foreignRequests.length = 0;
  await runAsync(process.execPath, [npm.cli, "install", "--prefix", prefix, "--ignore-scripts", `${PACKAGE_NAME}@${VERSION}`], {
    cwd: directory,
    env: isolatedNpmEnv({ npm_config_registry: registryUrl, npm_config_cache: join(directory, "npm-cache") })
  });
  assert.deepEqual([...new Set(foreignRequests)], [], `npm ${npm.version} fetched packages besides ${PACKAGE_NAME}`);
  const packageRoot = join(prefix, "node_modules", PACKAGE_NAME);
  const installed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(installed.version, VERSION);
  return { prefix, packageRoot };
}

// The installed tree is the bundle as packed: every locked production package
// at its lockfile path under the package, at its locked version, and nothing
// else, neither inside the package nor hoisted beside it.
function assertBundledTree(npm, { prefix, packageRoot }) {
  assert.deepEqual(treeProblems(packageRoot, lockDocument, { exact: true, label: `npm ${npm.version}` }), [],
    "the installed dependency tree differs from package-lock.json");
  const beside = [...installedTree(prefix).keys()].filter((path) => !path.startsWith(`node_modules/${PACKAGE_NAME}/`));
  assert.deepEqual(beside, [`node_modules/${PACKAGE_NAME}`], "npm installed packages beside the bundle");
  assert.deepEqual(findClaudePlatformPackages(prefix), [], "the install must not include the Claude Agent SDK's bundled Claude Code binary");
  const packages = installedTree(packageRoot).size;
  return { packages, bytes: treeBytes(join(prefix, "node_modules")) };
}

// Resolved through the installed package's own providers.js, as the daemon
// does: the adapter entry the Claude Worker runs, the SDK it imports, and the
// CLI it would be pointed at.
const CLAUDE_PROBE = `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const { providerConfig } = await import(pathToFileURL(process.argv[2]).href);
const config = providerConfig("claude");
const entry = config.args[0];
const sdk = createRequire(entry).resolve("@anthropic-ai/claude-agent-sdk");
await import(pathToFileURL(sdk).href);
process.stdout.write(JSON.stringify({ entry, sdk, executable: config.env.CLAUDE_CODE_EXECUTABLE }));
`;

async function assertClaudeAdapter(env, { prefix, packageRoot }) {
  const probePath = join(prefix, "claude-probe.mjs");
  await writeFile(probePath, CLAUDE_PROBE);
  const probe = JSON.parse(run(process.execPath, [probePath, join(packageRoot, "src", "providers.js")], { cwd: prefix, env }).stdout);
  const installed = await realpath(packageRoot);
  assert.ok(probe.entry.startsWith(`${installed}/node_modules/`), `Claude adapter resolved outside the bundle: ${probe.entry}`);
  assert.ok(probe.sdk.startsWith(`${installed}/node_modules/`), `Claude Agent SDK resolved outside the bundle: ${probe.sdk}`);
  assert.ok(!probe.executable.startsWith(`${await realpath(prefix)}/`), `the Claude Worker must run the user's CLI, not ${probe.executable}`);
  // --version loads the adapter's whole module graph (SDK included) and exits
  // before any Claude CLI is needed.
  const adapterVersion = run(process.execPath, [probe.entry, "--version"], { cwd: prefix, env }).stdout.trim();
  const pinned = lockDocument.packages["node_modules/@agentclientprotocol/claude-agent-acp"].version;
  assert.equal(adapterVersion, pinned, "installed Claude adapter version differs from package-lock.json");
  return adapterVersion;
}

function assertBins(env, { prefix }) {
  const binDirectory = join(prefix, "node_modules", ".bin");
  for (const name of Object.keys(packageDocument.bin)) {
    assert.ok(existsSync(join(binDirectory, name)), `bin ${name} was not linked`);
  }
  const version = run(join(binDirectory, "acp-gateway-bootstrap"), ["--version"], { cwd: prefix, env });
  assert.equal(version.stdout, `acp-gateway-bootstrap ${VERSION}\n`);
  const help = run(join(binDirectory, "acp-gateway-bootstrap"), ["--help"], { cwd: prefix, env });
  assert.match(help.stdout, /^Usage: acp-gateway-bootstrap/);
}

async function startDaemon(env, { prefix }) {
  const child = spawn(join(prefix, "node_modules", ".bin", "acp-gateway-daemon"), [], {
    cwd: prefix,
    env,
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "close");
  daemon = { child, exited, stderr: () => stderr };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode != null || child.signalCode != null) break;
    if (existsSync(env.ACP_GATEWAY_SOCKET)) return child.pid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`installed daemon did not start\n${stderr}`);
}

async function stopDaemon() {
  if (!daemon) return;
  const { child, exited } = daemon;
  if (child.exitCode == null && child.signalCode == null) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  }
  daemon = null;
}

// Runs inside the prefix, so the bare specifier resolves the installed package
// through its exports map exactly as a consumer's would.
const PROBE = `
import { pathToFileURL } from "node:url";
import { GatewayRpcClient, GATEWAY_API_VERSION } from ${JSON.stringify(`${PACKAGE_NAME}/client`)};
let privateImport = "imported";
try {
  await import(${JSON.stringify(`${PACKAGE_NAME}/src/socket-rpc.js`)});
} catch (error) {
  privateImport = error.code;
}
const { detectInstallMode } = await import(pathToFileURL(process.argv[2]).href);
const client = new GatewayRpcClient({
  socketPath: process.env.ACP_GATEWAY_SOCKET,
  token: process.env.ACP_GATEWAY_CONTROL_TOKEN,
  rootId: process.env.ACP_GATEWAY_ROOT_ID,
  autoStart: false
});
try {
  // refreshAgentUpdates waits for one full check, so gatewayUpdate is filled in.
  const setup = await client.call("setup", { refreshAgentUpdates: true }, 90_000);
  const shutdown = await client.call("daemon_shutdown", {}, 10_000);
  process.stdout.write(JSON.stringify({
    apiVersion: GATEWAY_API_VERSION,
    privateImport,
    detectedMode: detectInstallMode(),
    setup: {
      ok: setup.ok,
      gatewayVersion: setup.gatewayVersion,
      runtimeRoot: setup.runtimeRoot,
      gatewayUpdate: setup.gatewayUpdate,
      alerts: setup.alerts
    },
    shutdown
  }));
} finally {
  client.close();
}
`;

async function setupThroughClient(env, { prefix, packageRoot }) {
  const probePath = join(prefix, "probe.mjs");
  await writeFile(probePath, PROBE);
  const result = run(process.execPath, [probePath, join(packageRoot, "src", "install-mode.js")], { cwd: prefix, env });
  const report = JSON.parse(result.stdout);
  assert.equal(report.apiVersion, 1);
  assert.equal(report.privateImport, "ERR_PACKAGE_PATH_NOT_EXPORTED", "private package subpaths must stay unexported");
  assert.equal(report.detectedMode, "npm");
  assert.equal(report.setup.ok, true);
  assert.equal(report.setup.gatewayVersion, VERSION);
  assert.equal(report.setup.gatewayVersion, GATEWAY_VERSION);
  assert.equal(report.setup.runtimeRoot, await realpath(packageRoot), "setup must come from the installed package");
  const update = report.setup.gatewayUpdate;
  assert.ok(update, "setup did not report gatewayUpdate");
  assert.equal(update.installMode, "npm");
  assert.equal(update.currentVersion, VERSION);
  // "error" until this version is on the registry (404) or when offline; never git.
  assert.ok(["ready", "error"].includes(update.status), `unexpected gatewayUpdate status ${update.status}`);
  assert.doesNotMatch(update.error ?? "", /\bgit\b/, "an npm install must not consult git");
  assert.equal(report.shutdown?.ok, true);
  const exited = await Promise.race([daemon.exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 10_000))]);
  assert.ok(exited, "daemon_shutdown did not stop the installed daemon");
  daemon = null;
  return `gatewayUpdate ${update.status}${update.latestVersion ? ` (latest ${update.latestVersion})` : ""}${update.error ? ` (${update.error})` : ""}`;
}

async function smokeWith(npm, registryUrl, index) {
  const directory = join(temporary, `n${index}`);
  await mkdir(join(directory, "home"), { recursive: true });
  const install = await installPackage(npm, registryUrl, directory);
  const tree = assertBundledTree(npm, install);
  step(`npm ${npm.version}: installed with no request besides ${PACKAGE_NAME}; ${tree.packages} bundled packages at their `
    + `${LOCKFILE_NAME} paths and versions, nothing hoisted, no Claude platform binary; ${megabytes(tree.bytes)} installed`);
  const env = isolatedEnv(directory);
  assertBins(env, install);
  const adapterVersion = await assertClaudeAdapter(env, install);
  const pid = await startDaemon(env, install);
  const update = await setupThroughClient(env, install);
  step(`npm ${npm.version}: bins run, Claude adapter ${adapterVersion} and SDK load from the bundle, `
    + `daemon (pid ${pid}) set up via ${PACKAGE_NAME}/client (${update}) and stopped by daemon_shutdown`);
}

try {
  // --ignore-scripts is only faithful while no locked package needs one.
  const scripted = Object.entries(lockDocument.packages).filter(([, entry]) => entry.hasInstallScript).map(([path]) => path);
  assert.deepEqual(scripted, [], "a locked package has an install script; the smoke install uses --ignore-scripts");
  const packed = await packPackage();
  const npms = NPM_VERSIONS.map(fetchNpm);
  step(`installing with npm ${npms.map((npm) => npm.version).join(", ")} on Node ${process.version}`);
  const registryUrl = await startRegistry(packed);
  for (const [index, npm] of npms.entries()) await smokeWith(npm, registryUrl, index);
  step("passed");
} catch (error) {
  if (daemon) process.stderr.write(`daemon stderr:\n${daemon.stderr()}\n`);
  process.stderr.write(`npm-smoke: FAILED ${error?.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  await stopDaemon();
  await stopRegistry();
  await rm(temporary, { recursive: true, force: true });
}
