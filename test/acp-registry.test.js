import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverRegistryAgents,
  loadOfficialRegistry,
  mergeProviderDefinitions,
  providerDefinition,
  validateRegistry
} from "../src/acp-registry.js";
import { providerConfig } from "../src/providers.js";

const registry = {
  version: "1.0.0",
  agents: [
    {
      id: "claude-acp",
      name: "Claude Agent",
      version: "1.2.3",
      distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@1.2.3" } }
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      version: "4.5.6",
      distribution: { npx: { package: "@google/gemini-cli@4.5.6", args: ["--acp"] } }
    },
    {
      id: "cursor",
      name: "Cursor",
      version: "7.8.9",
      distribution: {
        binary: {
          "darwin-aarch64": {
            archive: "https://downloads.example.test/cursor.tar.gz",
            cmd: "./dist/cursor-agent",
            args: ["acp"]
          }
        }
      }
    }
  ]
};

test("official ACP registry discovery matches executables and global packages", async () => {
  validateRegistry(registry);
  const matches = await discoverRegistryAgents(registry, {
    platform: "darwin",
    arch: "arm64",
    installedPackages: new Set(["@google/gemini-cli"]),
    executable: async (command) => ["claude", "cursor-agent"].includes(command)
  });
  assert.deepEqual(matches.map((item) => item.registryId), ["claude-acp", "gemini", "cursor"]);
  const claude = providerDefinition(matches[0]);
  assert.equal(claude.id, "claude");
  assert.deepEqual(claude.args, ["--yes", "@agentclientprotocol/claude-agent-acp@1.2.3"]);
  assert.equal(claude.env.CLAUDE_CODE_EXECUTABLE, "claude");
  const cursor = providerDefinition(matches[2]);
  assert.equal(cursor.command, "cursor-agent");
  assert.deepEqual(cursor.args, ["acp"]);
});

test("registry loader caches official data and falls back to the cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-registry-cache-"));
  const cachePath = join(directory, "registry.json");
  try {
    const fresh = await loadOfficialRegistry({
      cachePath,
      now: () => 1000,
      fetchImpl: async () => new Response(JSON.stringify(registry), { status: 200 })
    });
    assert.equal(fresh.source, "network");
    const fallback = await loadOfficialRegistry({
      cachePath,
      refresh: true,
      now: () => 2000,
      fetchImpl: async () => { throw new Error("offline"); }
    });
    assert.equal(fallback.source, "cache");
    assert.equal(fallback.stale, true);
    assert.match(fallback.warning, /offline/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider definitions are merged into a private dynamic registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-provider-registry-"));
  const path = join(directory, "providers.json");
  try {
    await mergeProviderDefinitions(path, [{
      id: "gemini",
      displayName: "Gemini CLI",
      registryId: "gemini",
      registryVersion: "4.5.6",
      command: "npx",
      args: ["--yes", "@google/gemini-cli@4.5.6", "--acp"],
      env: {},
      permissionPolicy: "ask",
      modelScope: "session"
    }]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.providers.gemini.registryVersion, "4.5.6");
    const previous = process.env.ACP_GATEWAY_PROVIDERS;
    process.env.ACP_GATEWAY_PROVIDERS = path;
    try {
      const configured = providerConfig("gemini", { model: "gemini-test" });
      assert.equal(configured.command, "npx");
      // Session-scoped: the model is verified per session, never at process start.
      assert.equal(configured.expectedModel, null);
      assert.equal(configured.modelScope, "session");
    } finally {
      if (previous == null) delete process.env.ACP_GATEWAY_PROVIDERS;
      else process.env.ACP_GATEWAY_PROVIDERS = previous;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registry validation rejects insecure binary archives", () => {
  const invalid = structuredClone(registry);
  invalid.agents[2].distribution.binary["darwin-aarch64"].archive = "http://example.test/cursor.tar.gz";
  assert.throws(() => validateRegistry(invalid), /must use HTTPS/);
});
