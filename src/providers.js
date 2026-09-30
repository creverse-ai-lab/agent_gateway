import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { access } from "node:fs/promises";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { ERROR_CODES, GatewayError } from "./errors.js";
import { readJsonFile, updateJsonFile } from "./atomic-json.js";
import { providerRegistryReadPath, seedProviderRegistry } from "./acp-registry.js";

const GROK_BIN = process.env.GROK_BIN || join(homedir(), ".grok/bin/grok");
const CLAUDE_ADAPTER_ENTRY = "@agentclientprotocol/claude-agent-acp/dist/index.js";

export const PROVIDERS = ["grok", "claude", "codex"];

export const PROVIDER_MANIFESTS = {
  grok: {
    id: "grok",
    displayName: "Grok",
    agentCommand: GROK_BIN,
    adapter: "built-in",
    install: null
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    // Resolved on every read, so a CLI installed after the daemon started is seen.
    get agentCommand() {
      return claudeCodeExecutable();
    },
    adapter: "@agentclientprotocol/claude-agent-acp",
    install: "npm install -g @agentclientprotocol/claude-agent-acp"
  },
  codex: {
    id: "codex",
    displayName: "Codex CLI",
    agentCommand: process.env.CODEX_PATH || "codex",
    adapter: process.env.CODEX_ACP_BIN || "codex-acp",
    install: "npm install -g @agentclientprotocol/codex-acp"
  }
};

export function providerConfig(provider, { model } = {}) {
  const configured = configuredProviders()[provider];
  if (configured) {
    const modelScope = configured.modelScope ?? "session";
    const requested = optionalModel(model);
    return {
      provider,
      command: configured.command,
      args: [...configured.args],
      env: { ...configured.env },
      permissionPolicy: configured.permissionPolicy ?? "ask",
      // Only a process-scoped provider fixes its model at start. A session-scoped
      // one is verified by configureSessionModel after session/new or resume;
      // checking it here fails every cold start of an adapter whose initialize
      // result names no model (Claude, Codex), and passes only while warm.
      expectedModel: modelScope === "process" ? requested : null,
      modelScope,
      registryVersion: typeof configured.registryVersion === "string" ? configured.registryVersion : null
    };
  }

  if (provider === "grok") {
    const selectedModel = optionalModel(model) ?? "grok-4.5";
    return {
      provider,
      command: GROK_BIN,
      args: [
        "--sandbox",
        "off",
        "--permission-mode",
        "default",
        "agent",
        "--model",
        selectedModel,
        "stdio"
      ],
      permissionPolicy: "ask",
      expectedModel: selectedModel,
      modelScope: "process"
    };
  }

  if (provider === "claude") {
    return {
      provider,
      command: process.execPath,
      args: [fileURLToPath(import.meta.resolve(CLAUDE_ADAPTER_ENTRY))],
      env: {
        CLAUDE_CODE_EXECUTABLE: claudeCodeExecutable()
      },
      permissionPolicy: "ask",
      expectedModel: null,
      modelScope: "session"
    };
  }

  if (provider === "codex") {
    return {
      provider,
      command: process.env.CODEX_ACP_BIN || "codex-acp",
      args: [],
      env: {
        CODEX_PATH: process.env.CODEX_PATH || "codex",
        NO_BROWSER: "1"
      },
      permissionPolicy: "ask",
      expectedModel: null,
      modelScope: "session"
    };
  }

  throw new Error(`provider must be one of: ${providerIds().join(", ")}`);
}

export async function detectProviders() {
  const builtins = await Promise.all(
    Object.values(PROVIDER_MANIFESTS).map(async (source) => {
      // Reads Claude's agentCommand getter once: the check and the report agree.
      const manifest = { ...source };
      return {
        ...manifest,
        enabled: isProviderEnabled(manifest.id),
        agentInstalled: await executableExists(manifest.agentCommand),
        adapterInstalled:
          manifest.adapter === "built-in" || manifest.id === "claude"
            ? true
            : await executableExists(manifest.adapter)
      };
    })
  );
  const dynamic = await Promise.all(Object.values(configuredProviders()).map(async (definition) => ({
    id: definition.id,
    enabled: isProviderEnabled(definition.id),
    displayName: definition.displayName ?? definition.id,
    agentCommand: definition.command,
    adapter: definition.registryId ?? "registry",
    install: null,
    registryId: definition.registryId,
    registryVersion: definition.registryVersion,
    agentInstalled: await executableExists(definition.command),
    adapterInstalled: await executableExists(definition.command)
  })));
  const configuredById = new Map(dynamic.map((item) => [item.id, item]));
  return [
    ...builtins.map((item) => {
      const configured = configuredById.get(item.id);
      return configured
        ? {
            ...item,
            adapter: configured.adapter,
            adapterInstalled: configured.adapterInstalled,
            registryId: configured.registryId,
            registryVersion: configured.registryVersion
          }
        : item;
    }),
    ...dynamic.filter((item) => !PROVIDERS.includes(item.id))
  ];
}

export function providerIds() {
  return [...new Set([...PROVIDERS, ...Object.keys(configuredProviders())])];
}

function configuredProviders() {
  if (process.env.ACP_GATEWAY_DISABLE_DYNAMIC_PROVIDERS === "1" && !process.env.ACP_GATEWAY_PROVIDERS) return {};
  const path = providerRegistryReadPath();
  try {
    const document = JSON.parse(readFileSync(path, "utf8"));
    if (document?.version !== 1 || !document.providers || typeof document.providers !== "object") return {};
    const result = {};
    for (const [id, value] of Object.entries(document.providers)) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || !value || typeof value !== "object") continue;
      if (typeof value.command !== "string" || !value.command || !Array.isArray(value.args) || value.args.some((item) => typeof item !== "string")) continue;
      if (value.env != null && (typeof value.env !== "object" || Array.isArray(value.env) || Object.values(value.env).some((item) => typeof item !== "string"))) continue;
      result[id] = { ...value, id, args: [...value.args], env: { ...(value.env ?? {}) } };
    }
    return result;
  } catch {
    return {};
  }
}

async function executableExists(command) {
  for (const candidate of executableCandidates(command)) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
}

// Where `command` may live: itself when it is a path, otherwise each PATH entry.
function executableCandidates(command, pathValue = process.env.PATH) {
  if (!command) return [];
  if (command.includes("/")) return [command];
  return (pathValue ?? "").split(":").filter(Boolean).map((directory) => join(directory, command));
}

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The native installer's location, and what every release before 1.7.1 used.
export function legacyClaudeExecutable(home = homedir()) {
  return join(home, ".local/bin/claude");
}

// The node_modules directories this package's own dependencies live in: its
// nested one, and the one the Claude adapter actually resolves from (the same
// directory for a global install, the prefix's for a hoisted one). The Claude
// Agent SDK keeps a bundled Claude Code binary in there, and `npm exec`/`npm run`
// put node_modules/.bin on PATH; neither may pass for the user's CLI.
let ownRoots = null;
export function ownDependencyRoots() {
  if (ownRoots) return ownRoots;
  const roots = new Set([fileURLToPath(new URL("../node_modules", import.meta.url))]);
  try {
    const entry = fileURLToPath(import.meta.resolve(CLAUDE_ADAPTER_ENTRY));
    const marker = `${sep}node_modules${sep}@agentclientprotocol${sep}`;
    const index = entry.lastIndexOf(marker);
    if (index !== -1) roots.add(entry.slice(0, index + `${sep}node_modules`.length));
  } catch {
    // The adapter is not installed; the nested root still applies.
  }
  ownRoots = [...roots];
  return ownRoots;
}

// A Claude Agent SDK platform package's own directory, in any node_modules.
const BUNDLED_CLAUDE_BINARY = /(?:^|[\\/])node_modules[\\/]@anthropic-ai[\\/]claude-agent-sdk-[^\\/]+[\\/]/;

function insideAny(path, roots) {
  return roots.some((root) => {
    const rest = relative(root, path);
    return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
  });
}

// The Claude Code CLI the Claude Worker runs, and whether Claude counts as
// installed. One answer serves both, in this order:
// 1. CLAUDE_CODE_EXECUTABLE when set, as given (checked by the caller, as before);
// 2. `claude` on PATH (Homebrew, npm global, the native installer, ...), never
//    one inside this package's own node_modules;
// 3. ~/.local/bin/claude when it exists, for a daemon started without it on PATH;
// 4. null: not installed. The binary bundled with the Claude Agent SDK is never
//    a fallback (from 1.7.1 the Gateway's installs no longer include it).
export function resolveClaudeExecutable({
  env = process.env,
  home = homedir(),
  isExecutable = isExecutableFile,
  excludedRoots = ownDependencyRoots(),
  realpath = realpathSync
} = {}) {
  // Whitespace only counts as unset; a set path is used even when missing.
  const configured = env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (configured) return configured;
  const real = (path) => {
    try {
      return realpath(path);
    } catch {
      return null;
    }
  };
  // Both spellings of each root: a PATH entry or symlink may use either.
  const roots = [...new Set([...excludedRoots, ...excludedRoots.map(real).filter(Boolean)])];
  // Any project's bundled platform binary is refused too, e.g. through another
  // project's node_modules/.bin shim.
  const skip = (candidate) => {
    const resolved = real(candidate) ?? candidate;
    return insideAny(candidate, roots) || insideAny(resolved, roots)
      || BUNDLED_CLAUDE_BINARY.test(candidate) || BUNDLED_CLAUDE_BINARY.test(resolved);
  };
  // Synchronous, unlike executableExists: providerConfig needs the answer inline.
  // Relative PATH entries depend on the daemon's cwd, so they are ignored.
  const onPath = executableCandidates("claude", env.PATH ?? "")
    .find((candidate) => isAbsolute(candidate) && isExecutable(candidate) && !skip(candidate));
  if (onPath) return onPath;
  const legacy = legacyClaudeExecutable(home);
  return isExecutable(legacy) ? legacy : null;
}

// What detection reports and the worker gets as CLAUDE_CODE_EXECUTABLE. When
// nothing is found it is the legacy path, which is no usable CLI: detection says
// not installed, and the adapter fails naming that path instead of falling back
// to a bundled binary, exactly as before.
function claudeCodeExecutable() {
  return resolveClaudeExecutable() ?? legacyClaudeExecutable();
}

// Providers whose own tools can change the workspace without an ACP callback,
// so read_only/ask is enforced only for what does reach the Gateway. codex-acp
// applies patches through its app server inside a workspace-write sandbox, and
// none of its mode presets is a read-only sandbox (checked through 1.13.1).
const PARTIAL_POLICY_PROVIDERS = new Set(["codex"]);
const PARTIAL_POLICY_REGISTRY_IDS = new Set(["codex-acp"]);

// Reads are never mediated for these providers either (measured live in 1.5.2:
// Codex read files outside its roots and inside ~/.acp-gateway under read_only),
// so the alert applies under every policy, auto_approve included.
export function partialPolicyEnforcement(provider, permissionPolicy) {
  const registryId = configuredProviders()[provider]?.registryId;
  if (isGrokProvider(provider)) {
    // Grok's built-in grep/rg reads in-process. Its sandbox profile denies the
    // Gateway-protected paths (grok-sandbox.js), but cannot express per-session
    // roots, so other files outside the roots stay readable through it.
    return {
      level: "warning",
      code: "permission_policy_partial",
      provider,
      scope: ["read_outside_roots"],
      message: `permissionPolicy=${permissionPolicy} is only partially enforced for ${provider}: `
        + "its built-in grep tool can read files outside the session roots without a permission request. "
        + "Gateway-protected paths are denied by the Grok sandbox profile; edits, shell commands and file reads through ACP are enforced."
    };
  }
  if (!PARTIAL_POLICY_PROVIDERS.has(provider) && !PARTIAL_POLICY_REGISTRY_IDS.has(registryId)) return null;
  const edits = permissionPolicy === "auto_approve"
    ? ""
    : "it can edit files and run shell writes inside its session roots without a permission request, and ";
  return {
    level: "warning",
    code: "permission_policy_partial",
    provider,
    scope: permissionPolicy === "auto_approve"
      ? ["read_outside_roots", "read_protected"]
      : ["edit_inside_roots", "shell_write_inside_roots", "read_outside_roots", "read_protected"],
    message: `permissionPolicy=${permissionPolicy} is only partially enforced for ${provider}: `
      + `${edits}it can read files anywhere, including Gateway-protected paths such as ~/.acp-gateway. `
      + "Writes outside the roots, network and escalations still reach the Gateway. "
      + "Use workspace=snapshot when edits must be impossible, and do not hand this worker untrusted input on a machine holding the Control token."
  };
}

// Claude Code enforces its own permission rules and auto-allows commands it
// judges safe, so a read_only session could still run Bash and read any file
// without a permission request ever reaching the Gateway. claude-agent-acp takes
// SDK options per session through _meta.claudeCode.options; its disallowedTools
// uses Claude Code rule syntax, where "//" starts an absolute path.
const CLAUDE_REGISTRY_IDS = new Set(["claude-acp"]);
const CLAUDE_MUTATING_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"];
const CLAUDE_PATH_TOOLS = ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep"];

const GROK_REGISTRY_IDS = new Set(["grok-build"]);

export function isGrokProvider(provider) {
  return provider === "grok" || GROK_REGISTRY_IDS.has(configuredProviders()[provider]?.registryId);
}

export function isClaudeProvider(provider) {
  return provider === "claude" || CLAUDE_REGISTRY_IDS.has(configuredProviders()[provider]?.registryId);
}

export function workerSessionMeta(provider, { permissionPolicy, protectedPaths = [] } = {}) {
  if (!isClaudeProvider(provider)) return null;
  const disallowedTools = [];
  if (permissionPolicy === "read_only") disallowedTools.push(...CLAUDE_MUTATING_TOOLS);
  for (const path of protectedPaths) {
    const rulePath = `/${path.replace(/\/+$/, "")}/**`;
    for (const tool of CLAUDE_PATH_TOOLS) disallowedTools.push(`${tool}(${rulePath})`);
  }
  if (!disallowedTools.length) return null;
  return { claudeCode: { options: { disallowedTools } } };
}

export function currentModelId(initResult) {
  return initResult?._meta?.modelState?.currentModelId ?? null;
}

function optionalModel(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error("model must be a non-empty string");
  return value.trim();
}

export function isProviderEnabled(provider) {
  if (process.env.ACP_GATEWAY_DISABLE_DYNAMIC_PROVIDERS === "1" && !process.env.ACP_GATEWAY_PROVIDERS) return true;
  const document = readJsonFile(providerRegistryReadPath(), { version: 1, providers: {}, disabled: [] });
  if (document.version !== 1 || (document.disabled != null && (!Array.isArray(document.disabled) || document.disabled.some(id => typeof id !== "string")))) {
    throw new GatewayError(ERROR_CODES.CONFIG_INVALID, "Invalid provider policy document");
  }
  return !(document.disabled ?? []).includes(provider);
}

export function assertProviderEnabled(provider) {
  if (!isProviderEnabled(provider)) throw new GatewayError(ERROR_CODES.PROVIDER_DISABLED, `Provider ${provider} is disabled`, { provider });
}

export function setProviderEnabled(provider, enabled) {
  if (typeof provider !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(provider) || typeof enabled !== "boolean") {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "provider and boolean enabled are required");
  }
  updateJsonFile(seedProviderRegistry(), { version: 1, providers: {}, disabled: [] }, document => {
    if (document.version !== 1 || (document.disabled != null && (!Array.isArray(document.disabled) || document.disabled.some(id => typeof id !== "string")))) throw new GatewayError(ERROR_CODES.CONFIG_INVALID, "Invalid provider policy document");
    const disabled = new Set(document.disabled ?? []);
    if (enabled) disabled.delete(provider); else disabled.add(provider);
    return { ...document, disabled: [...disabled].sort() };
  });
  return { ok: true, provider, enabled };
}
