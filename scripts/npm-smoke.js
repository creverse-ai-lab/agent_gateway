#!/usr/bin/env node

// Packaged-install smoke test: what `npm install -g acp-gateway-daemon` would
// put on a machine, exercised the way a user would. `npm pack` the checkout,
// install the tarball into a temporary prefix, check the installed tree is the
// shrinkwrapped one, run the installed bins, then start the installed daemon
// and call setup through the packaged public client.
//
// What is isolated, all under one temporary directory that is removed at the end:
// - npm (pack and install): HOME, the npm cache, and the user and global
//   npmrc (each an empty file); every npm_config_* variable from the caller's
//   shell or `npm run` is dropped. Install runs with --ignore-scripts: no
//   package in npm-shrinkwrap.json has an install script (hasInstallScript),
//   so nothing is lost, and nothing from the registry executes here.
// - the installed bins and daemon: HOME, the agent-CLI homes (CODEX_HOME,
//   CLAUDE_CONFIG_DIR, ...), and the Gateway socket, state, artifacts,
//   settings/install record, registry cache and providers file; every
//   ACP_GATEWAY_* variable from the caller is dropped first. The daemon is
//   stopped with daemon_shutdown (SIGTERM/SIGKILL as a fallback).
// Not isolated: the network (registry.npmjs.org for the dependencies, and the
// daemon's own update checks) and the Node/npm on PATH.
//
// The tarball is installed by name from a loopback registry, not by path. npm
// honours a dependency's npm-shrinkwrap.json only when the registry marks the
// version `_hasShrinkwrap` (registry.npmjs.org does, from the tarball contents);
// a `file:` tarball install drops that flag and resolves fresh ranges instead,
// so it could not show that users get the tested tree. The loopback registry
// serves this package exactly as npmjs would and passes every other request
// through to registry.npmjs.org unchanged.
//
// The installed tree must hold no Claude Code binary (the Claude Agent SDK's
// optional platform packages, which npm-shrinkwrap.json omits; see
// scripts/omit-claude-binary.js) and must still load the Claude adapter.
//
// Needs the npm registry for the dependencies, so it is not part of `npm run ci`.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { GATEWAY_VERSION } from "../src/version.js";
import { findClaudePlatformPackages } from "./omit-claude-binary.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDocument = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const shrinkwrap = JSON.parse(await readFile(join(repositoryRoot, "npm-shrinkwrap.json"), "utf8"));
const PACKAGE_NAME = packageDocument.name;
const VERSION = packageDocument.version;
const REQUIRED_ENTRIES = [
  "package.json",
  "npm-shrinkwrap.json",
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
const FORBIDDEN_PREFIXES = ["test/", "scripts/", "config/", "tmp/", "graft/", "build/", ".github/", "node_modules/"];

// A socket path must stay under the ~104-byte Unix limit, hence the short prefix.
const temporary = await mkdtemp(join(tmpdir(), "acpnpm-"));
const home = join(temporary, "home");
const prefix = join(temporary, "prefix");
const packDirectory = join(temporary, "pack");
const npmHome = join(temporary, "npm-home");
const npmCache = join(temporary, "npm-cache");
const userNpmrc = join(temporary, "user.npmrc");
const globalNpmrc = join(temporary, "global.npmrc");
const token = randomBytes(24).toString("base64url");
const UPSTREAM_REGISTRY = "https://registry.npmjs.org";
let daemon = null;
let registry = null;

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

// The daemon and bins see only the temporary tree: every ACP_GATEWAY_* and
// agent-CLI home variable from the caller's shell is dropped first, so a live
// socket, state file or install record can never be picked up.
function isolatedEnv() {
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
    ACP_GATEWAY_SOCKET: join(temporary, "g.sock"),
    ACP_GATEWAY_STATE: join(temporary, "state", "state.json"),
    ACP_GATEWAY_ARTIFACTS: join(temporary, "artifacts"),
    ACP_GATEWAY_WORKSPACES: join(temporary, "workspaces"),
    ACP_GATEWAY_GROK_SANDBOX_DIR: join(temporary, "grok-sandbox"),
    ACP_GATEWAY_INSTALL_STATE: join(home, ".acp-gateway", "install.json"),
    ACP_GATEWAY_REGISTRY_CACHE: join(temporary, "registry.json"),
    ACP_GATEWAY_PROVIDERS: join(temporary, "providers.json"),
    ACP_GATEWAY_DISABLE_DYNAMIC_PROVIDERS: "1",
    ACP_GATEWAY_AGENT_AUTO_UPDATE: "0",
    ACP_GATEWAY_AGENT_UPDATE_NOTIFICATIONS: "0",
    ACP_GATEWAY_CONTROL_TOKEN: token,
    ACP_GATEWAY_ROOT_ID: "main-npm-smoke"
  };
}

async function packPackage() {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(npmHome, { recursive: true });
  await writeFile(userNpmrc, "");
  await writeFile(globalNpmrc, "");
  const packed = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory], { env: isolatedNpmEnv() });
  const [report] = JSON.parse(packed.stdout);
  const paths = report.files.map((file) => file.path);
  assert.equal(report.name, PACKAGE_NAME);
  assert.equal(report.version, VERSION);
  for (const entry of REQUIRED_ENTRIES) assert.ok(paths.includes(entry), `packed package is missing ${entry}`);
  const forbidden = paths.filter((path) => FORBIDDEN_PREFIXES.some((start) => path.startsWith(start)));
  assert.deepEqual(forbidden, [], "packed package must not ship development files");
  step(`packed ${report.filename}: ${report.entryCount} files, ${report.size} bytes (${report.unpackedSize} unpacked)`);
  return { tarball: join(packDirectory, report.filename), hasShrinkwrap: paths.includes("npm-shrinkwrap.json") };
}

// This package's packument as registry.npmjs.org would serve it after publish,
// plus a byte-for-byte pass-through to the real registry for everything else.
async function startRegistry({ tarball, hasShrinkwrap }) {
  const bytes = await readFile(tarball);
  const tarballPath = `/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${VERSION}.tgz`;
  const server = createServer((request, response) => {
    void serve(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end(String(error?.message ?? error));
    });
  });
  const packument = (origin) => ({
    name: PACKAGE_NAME,
    "dist-tags": { latest: VERSION },
    versions: {
      [VERSION]: {
        ...packageDocument,
        _id: `${PACKAGE_NAME}@${VERSION}`,
        _hasShrinkwrap: hasShrinkwrap,
        dist: {
          tarball: `${origin}${tarballPath}`,
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          shasum: createHash("sha1").update(bytes).digest("hex")
        }
      }
    }
  });
  async function serve(request, response) {
    const origin = `http://${request.headers.host}`;
    const { pathname } = new URL(request.url, origin);
    if (pathname === `/${PACKAGE_NAME}`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(packument(origin)));
      return;
    }
    if (pathname === tarballPath) {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
      response.end(bytes);
      return;
    }
    // fetch() decodes any content-encoding, so only the type is passed on.
    const upstream = await fetch(`${UPSTREAM_REGISTRY}${request.url}`, {
      headers: { accept: request.headers.accept ?? "*/*" },
      redirect: "follow"
    });
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" });
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(response);
    else response.end();
  }
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

async function installPackage(packed) {
  // --ignore-scripts is only faithful while no pinned package needs one.
  const scripted = Object.entries(shrinkwrap.packages).filter(([, entry]) => entry.hasInstallScript).map(([path]) => path);
  assert.deepEqual(scripted, [], "a shrinkwrapped package has an install script; the smoke install uses --ignore-scripts");
  await mkdir(prefix, { recursive: true });
  const registryUrl = await startRegistry(packed);
  try {
    await runAsync("npm", ["install", "--prefix", prefix, "--ignore-scripts", `${PACKAGE_NAME}@${VERSION}`], {
      env: isolatedNpmEnv({ npm_config_registry: registryUrl })
    });
  } finally {
    await stopRegistry();
  }
  const packageRoot = join(prefix, "node_modules", PACKAGE_NAME);
  const installed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(installed.version, VERSION);
  step(`installed ${PACKAGE_NAME}@${installed.version} into ${prefix}`);
  return packageRoot;
}

// Every package the shrinkwrap pins is installed at exactly that version,
// either nested under the package or hoisted into the prefix. Optional
// platform packages for other platforms are legitimately absent.
async function assertShrinkwrappedTree(packageRoot) {
  let matched = 0;
  for (const [path, entry] of Object.entries(shrinkwrap.packages)) {
    if (path === "" || entry.dev) continue;
    const location = [join(packageRoot, path), join(prefix, path)].find((candidate) => existsSync(join(candidate, "package.json")));
    if (!location) {
      assert.ok(entry.optional, `shrinkwrapped dependency ${path} was not installed`);
      continue;
    }
    const installed = JSON.parse(await readFile(join(location, "package.json"), "utf8"));
    assert.equal(installed.version, entry.version, `${path} installed ${installed.version}, shrinkwrap pins ${entry.version}`);
    matched += 1;
  }
  step(`dependency tree matches npm-shrinkwrap.json (${matched} packages)`);
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

async function assertClaudeAdapter(env, packageRoot) {
  const platformPackages = findClaudePlatformPackages(prefix);
  assert.deepEqual(platformPackages, [], "the install must not include the Claude Agent SDK's bundled Claude Code binary");
  const probePath = join(prefix, "claude-probe.mjs");
  await writeFile(probePath, CLAUDE_PROBE);
  const probe = JSON.parse(run(process.execPath, [probePath, join(packageRoot, "src", "providers.js")], { cwd: prefix, env }).stdout);
  const installed = await realpath(prefix);
  assert.ok(probe.entry.startsWith(`${installed}/`), `Claude adapter resolved outside the install: ${probe.entry}`);
  assert.ok(probe.sdk.startsWith(`${installed}/`), `Claude Agent SDK resolved outside the install: ${probe.sdk}`);
  assert.ok(!probe.executable.startsWith(`${installed}/`), `the Claude Worker must run the user's CLI, not ${probe.executable}`);
  // --version loads the adapter's whole module graph (SDK included) and exits
  // before any Claude CLI is needed.
  const adapterVersion = run(process.execPath, [probe.entry, "--version"], { cwd: prefix, env }).stdout.trim();
  const pinned = shrinkwrap.packages["node_modules/@agentclientprotocol/claude-agent-acp"].version;
  assert.equal(adapterVersion, pinned, "installed Claude adapter version differs from the shrinkwrap");
  step(`no Claude Code binary installed; Claude adapter ${adapterVersion} loads (${probe.entry.slice(installed.length + 1)})`);
}

function assertBins(env) {
  const binDirectory = join(prefix, "node_modules", ".bin");
  for (const name of Object.keys(packageDocument.bin)) {
    assert.ok(existsSync(join(binDirectory, name)), `bin ${name} was not linked`);
  }
  const version = run(join(binDirectory, "acp-gateway-bootstrap"), ["--version"], { cwd: temporary, env });
  assert.equal(version.stdout, `acp-gateway-bootstrap ${VERSION}\n`);
  const help = run(join(binDirectory, "acp-gateway-bootstrap"), ["--help"], { cwd: temporary, env });
  assert.match(help.stdout, /^Usage: acp-gateway-bootstrap/);
  step(`bins linked (${Object.keys(packageDocument.bin).join(", ")}); bootstrap --version/--help ok`);
}

async function startDaemon(env) {
  const child = spawn(join(prefix, "node_modules", ".bin", "acp-gateway-daemon"), [], {
    cwd: temporary,
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
    if (existsSync(env.ACP_GATEWAY_SOCKET)) {
      step(`installed daemon listening (pid ${child.pid})`);
      return;
    }
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

async function setupThroughClient(env, packageRoot) {
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
  step(`setup via ${PACKAGE_NAME}/client: gatewayVersion ${report.setup.gatewayVersion}, installMode ${update.installMode}, `
    + `gatewayUpdate ${update.status}${update.latestVersion ? ` (latest ${update.latestVersion})` : ""}${update.error ? ` (${update.error})` : ""}`);
  const exited = await Promise.race([daemon.exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 10_000))]);
  assert.ok(exited, "daemon_shutdown did not stop the installed daemon");
  step("installed daemon stopped by daemon_shutdown");
}

try {
  const packed = await packPackage();
  assert.ok(packed.hasShrinkwrap, "npm-shrinkwrap.json must be in the packed package");
  const packageRoot = await installPackage(packed);
  await assertShrinkwrappedTree(packageRoot);
  await mkdir(home, { recursive: true });
  const env = isolatedEnv();
  assertBins(env);
  await assertClaudeAdapter(env, packageRoot);
  await startDaemon(env);
  await setupThroughClient(env, packageRoot);
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
