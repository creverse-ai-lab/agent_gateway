import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { ERROR_CODES, GatewayError } from "./errors.js";
import { readJsonFile, updateJsonFile } from "./atomic-json.js";
import { defaultProviderRegistryPath } from "./acp-registry.js";

const GROK_BIN = process.env.GROK_BIN || join(homedir(), ".grok/bin/grok");

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
    agentCommand: process.env.CLAUDE_CODE_EXECUTABLE || join(homedir(), ".local/bin/claude"),
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
    return {
      provider,
      command: configured.command,
      args: [...configured.args],
      env: { ...configured.env },
      permissionPolicy: configured.permissionPolicy ?? "ask",
      expectedModel: optionalModel(model),
      modelScope: configured.modelScope ?? "session"
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
      args: [
        fileURLToPath(
          import.meta.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")
        )
      ],
      env: {
        CLAUDE_CODE_EXECUTABLE:
          process.env.CLAUDE_CODE_EXECUTABLE || join(homedir(), ".local/bin/claude")
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
    Object.values(PROVIDER_MANIFESTS).map(async (manifest) => ({
      ...manifest,
      enabled: isProviderEnabled(manifest.id),
      agentInstalled: await executableExists(manifest.agentCommand),
      adapterInstalled:
        manifest.adapter === "built-in" || manifest.id === "claude"
          ? true
          : await executableExists(manifest.adapter)
    }))
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
  const path = defaultProviderRegistryPath();
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
  if (!command) return false;
  if (command.includes("/")) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const paths = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const directory of paths) {
    try {
      await access(join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
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
  const document = readJsonFile(defaultProviderRegistryPath(), { version: 1, providers: {}, disabled: [] });
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
  updateJsonFile(defaultProviderRegistryPath(), { version: 1, providers: {}, disabled: [] }, document => {
    if (document.version !== 1 || (document.disabled != null && (!Array.isArray(document.disabled) || document.disabled.some(id => typeof id !== "string")))) throw new GatewayError(ERROR_CODES.CONFIG_INVALID, "Invalid provider policy document");
    const disabled = new Set(document.disabled ?? []);
    if (enabled) disabled.delete(provider); else disabled.add(provider);
    return { ...document, disabled: [...disabled].sort() };
  });
  return { ok: true, provider, enabled };
}
