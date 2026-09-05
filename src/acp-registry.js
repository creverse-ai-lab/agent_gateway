import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { updateJsonFile } from "./atomic-json.js";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_REGISTRY_BYTES = 5 * 1024 * 1024;
const KNOWN_COMMANDS = {
  "claude-acp": ["claude", join(homedir(), ".local", "bin", "claude")],
  "codex-acp": ["codex"],
  gemini: ["gemini"],
  "github-copilot-cli": ["copilot"],
  cursor: ["cursor-agent", join(homedir(), ".local", "bin", "cursor-agent"), "/Applications/Cursor.app/Contents/Resources/app/bin/cursor-agent"],
  goose: ["goose"],
  "factory-droid": ["droid"],
  auggie: ["auggie"],
  cline: ["cline"],
  opencode: ["opencode"],
  "grok-build": ["grok", join(homedir(), ".grok", "bin", "grok")]
};

export function defaultRegistryCachePath() {
  return process.env.ACP_GATEWAY_REGISTRY_CACHE || join(homedir(), ".acp-gateway", "registry.json");
}

export function defaultProviderRegistryPath() {
  return process.env.ACP_GATEWAY_PROVIDERS || join(homedir(), ".acp-gateway", "providers.json");
}

export async function loadOfficialRegistry({
  cachePath = defaultRegistryCachePath(),
  fetchImpl = globalThis.fetch,
  refresh = false,
  offline = false,
  persist = true,
  now = () => Date.now(),
  timeoutMs = 15_000
} = {}) {
  let cached = null;
  let cacheWarning = null;
  try {
    cached = await readCache(cachePath);
  } catch (error) {
    cacheWarning = error.message;
  }
  if (!refresh && cached && (offline || now() - cached.fetchedAt < CACHE_TTL_MS)) {
    return { registry: cached.registry, source: "cache", stale: now() - cached.fetchedAt >= CACHE_TTL_MS };
  }
  if (offline) {
    if (!cached) throw new Error(cacheWarning ?? "ACP registry cache is unavailable in offline mode");
    return { registry: cached.registry, source: "cache", stale: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(ACP_REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      redirect: "follow"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_REGISTRY_BYTES) throw new Error("registry response exceeds 5 MiB");
    const registry = validateRegistry(JSON.parse(text));
    if (persist) await writeJson(cachePath, { fetchedAt: now(), registry });
    return { registry, source: "network", stale: false, warning: cacheWarning };
  } catch (error) {
    if (cached) {
      return { registry: cached.registry, source: "cache", stale: true, warning: `registry refresh failed: ${error.message}` };
    }
    throw new Error(`Cannot load the official ACP registry: ${error.message}${cacheWarning ? `; ${cacheWarning}` : ""}`);
  } finally {
    clearTimeout(timer);
  }
}

export function validateRegistry(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.agents)) throw new Error("invalid ACP registry document");
  const ids = new Set();
  for (const agent of value.agents) {
    requireText(agent?.id, "agent.id");
    requireText(agent?.name, `${agent.id}.name`);
    requireText(agent?.version, `${agent.id}.version`);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(agent.id)) throw new Error(`invalid registry agent id: ${agent.id}`);
    if (ids.has(agent.id)) throw new Error(`duplicate registry agent id: ${agent.id}`);
    ids.add(agent.id);
    validateDistribution(agent);
  }
  return value;
}

export async function discoverRegistryAgents(registry, {
  platform = process.platform,
  arch = process.arch,
  path = searchPath(),
  installedPackages = new Set(),
  executable = executableExists
} = {}) {
  const target = platformTarget(platform, arch);
  const results = [];
  for (const agent of registry.agents) {
    const distribution = selectDistribution(agent, target);
    if (!distribution) continue;
    const packageName = distribution.package ? packageNameFromSpec(distribution.package) : null;
    const commands = commandCandidates(agent, distribution);
    let foundCommand = null;
    for (const command of commands) {
      if (await executable(command, path)) {
        foundCommand = command;
        break;
      }
    }
    const packageInstalled = packageName ? installedPackages.has(packageName) : false;
    if (!foundCommand && !packageInstalled) continue;
    results.push({
      id: normalizeProviderId(agent.id),
      registryId: agent.id,
      name: agent.name,
      version: agent.version,
      distribution,
      foundCommand,
      packageInstalled
    });
  }
  return results;
}

function searchPath() {
  return [
    process.env.PATH ?? "",
    join(homedir(), ".local", "bin"),
    join(homedir(), ".cargo", "bin"),
    join(homedir(), ".npm-global", "bin"),
    join(homedir(), ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ].filter(Boolean).join(delimiter);
}

export function selectDistribution(agent, target = platformTarget()) {
  const distribution = agent.distribution ?? {};
  if (distribution.npx) return normalizedRunner("npx", distribution.npx);
  if (distribution.uvx) return normalizedRunner("uvx", distribution.uvx);
  const binary = distribution.binary?.[target];
  if (!binary) return null;
  return {
    type: "binary",
    archive: binary.archive,
    checksum: binary.sha256 ?? binary.checksum ?? null,
    command: binary.cmd,
    args: stringArray(binary.args),
    env: stringRecord(binary.env)
  };
}

export function providerDefinition(match) {
  const common = {
    id: match.id,
    displayName: match.name,
    registryId: match.registryId,
    registryVersion: match.version,
    permissionPolicy: "ask",
    modelScope: "session"
  };
  if (match.distribution.type === "npx") {
    return { ...common, command: "npx", args: ["--yes", match.distribution.package, ...match.distribution.args], env: providerEnvironment(match) };
  }
  if (match.distribution.type === "uvx") {
    return { ...common, command: "uvx", args: [match.distribution.package, ...match.distribution.args], env: providerEnvironment(match) };
  }
  if (!match.foundCommand) throw new Error(`${match.registryId} has no installed executable for its binary distribution`);
  return { ...common, command: match.foundCommand, args: match.distribution.args, env: providerEnvironment(match) };
}

function providerEnvironment(match) {
  const env = { ...match.distribution.env };
  if (match.registryId === "claude-acp" && match.foundCommand) env.CLAUDE_CODE_EXECUTABLE = match.foundCommand;
  if (match.registryId === "codex-acp" && match.foundCommand) {
    env.CODEX_PATH = match.foundCommand;
    env.NO_BROWSER = "1";
  }
  return env;
}

export async function mergeProviderDefinitions(path, definitions) {
  return updateJsonFile(path, { version: 1, providers: {} }, document => {
    if (document.version !== 1 || !document.providers || typeof document.providers !== "object") throw new Error("Invalid provider registry");
    const providers = { ...document.providers };
    for (const definition of definitions) providers[definition.id] = definition;
    return { ...document, version: 1, providers };
  });
}

export async function installedGlobalNpmPackages(run) {
  try {
    const result = await run("npm", ["list", "--global", "--depth=0", "--json"]);
    if (result.code !== 0 && !result.stdout) return new Set();
    return new Set(Object.keys(JSON.parse(result.stdout).dependencies ?? {}));
  } catch {
    return new Set();
  }
}

function validateDistribution(agent) {
  const distribution = agent.distribution;
  if (!distribution || typeof distribution !== "object") throw new Error(`${agent.id} has no distribution`);
  if (!distribution.npx && !distribution.uvx && !distribution.binary) throw new Error(`${agent.id} has no supported distribution`);
  for (const key of ["npx", "uvx"]) {
    if (!distribution[key]) continue;
    requireText(distribution[key].package, `${agent.id}.distribution.${key}.package`);
    stringArray(distribution[key].args);
    stringRecord(distribution[key].env);
  }
  if (distribution.binary) {
    if (typeof distribution.binary !== "object" || Array.isArray(distribution.binary)) throw new Error(`${agent.id}.distribution.binary must be an object`);
    for (const [target, item] of Object.entries(distribution.binary)) {
      requireText(item?.archive, `${agent.id}.${target}.archive`);
      requireText(item?.cmd, `${agent.id}.${target}.cmd`);
      const url = new URL(item.archive);
      if (url.protocol !== "https:") throw new Error(`${agent.id}.${target}.archive must use HTTPS`);
      stringArray(item.args);
      stringRecord(item.env);
    }
  }
}

function normalizedRunner(type, value) {
  return { type, package: value.package, args: stringArray(value.args), env: stringRecord(value.env) };
}

function commandCandidates(agent, distribution) {
  const values = new Set(KNOWN_COMMANDS[agent.id] ?? []);
  if (distribution.command) values.add(basename(distribution.command.replaceAll("\\", "/")));
  if (distribution.type === "binary") return [...values].filter(Boolean);
  if (distribution.package) {
    const packageBase = basename(packageNameFromSpec(distribution.package));
    values.add(packageBase);
    values.add(packageBase.replace(/-(?:acp|cli|agent)$/, ""));
  }
  values.add(agent.id);
  values.add(agent.id.replace(/-(?:acp|cli|agent)$/, ""));
  return [...values].filter(Boolean);
}

function normalizeProviderId(id) {
  if (id === "claude-acp") return "claude";
  if (id === "codex-acp") return "codex";
  if (id === "grok-build") return "grok";
  return id;
}

function packageNameFromSpec(spec) {
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);
    return secondAt === -1 ? spec : spec.slice(0, secondAt);
  }
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

function platformTarget(platform = process.platform, arch = process.arch) {
  const platformName = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : platform;
  const archName = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return `${platformName}-${archName}`;
}

async function executableExists(command, path) {
  if (!command) return false;
  const candidates = command.includes("/") ? [command] : path.split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Continue searching.
    }
  }
  return false;
}

async function readCache(path) {
  try {
    const cached = JSON.parse(await readFile(path, "utf8"));
    if (!Number.isFinite(cached.fetchedAt)) throw new Error("missing fetchedAt");
    return { fetchedAt: cached.fetchedAt, registry: validateRegistry(cached.registry) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot read ACP registry cache ${path}: ${error.message}`);
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function stringArray(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("distribution args must be strings");
  return [...value];
}

function stringRecord(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error("distribution env values must be strings");
  }
  return { ...value };
}

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
}
