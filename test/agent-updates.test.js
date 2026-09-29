import assert from "node:assert/strict";
import test from "node:test";
import { AgentUpdateManager, updateCandidates } from "../src/agent-updates.js";

const registry = {
  version: "1.0.0",
  agents: [{
    id: "claude-acp",
    name: "Claude ACP",
    version: "0.64.0",
    distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@0.64.0" } }
  }]
};

test("agent updater applies registry adapters and exposes a health alert", async () => {
  let version = "0.60.0";
  let applyCalls = 0;
  const manager = new AgentUpdateManager({
    intervalMs: 60_000,
    registryLoader: async () => ({ registry, source: "network", stale: false }),
    detect: async () => [{ id: "claude", registryId: "claude-acp", registryVersion: version, agentInstalled: true }],
    applyUpdates: async () => { applyCalls += 1; version = "0.64.0"; }
  });
  try {
    const result = await manager.refresh();
    assert.equal(applyCalls, 1);
    assert.equal(result.status, "ready");
    assert.equal(result.available.length, 0);
    assert.equal(result.lastApplied[0].latestVersion, "0.64.0");
    assert.equal(result.alerts[0].code, "acp_agents_auto_updated");
  } finally {
    manager.stop();
  }
});

test("disabled agent updater reports an available update without applying it", async () => {
  let applyCalls = 0;
  const manager = new AgentUpdateManager({
    enabled: false,
    registryLoader: async () => ({ registry, source: "network", stale: false }),
    detect: async () => [{ id: "claude", registryId: "claude-acp", registryVersion: "0.60.0", agentInstalled: true }],
    applyUpdates: async () => { applyCalls += 1; }
  });
  const result = await manager.refresh();
  assert.equal(applyCalls, 0);
  assert.equal(result.available[0].latestVersion, "0.64.0");
  assert.equal(result.alerts[0].code, "acp_agent_updates_available");
});

test("binary ACP updates remain manual", () => {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const target = `${platform}-${arch}`;
  const binaryRegistry = {
    version: "1.0.0",
    agents: [{
      id: "binary-agent",
      name: "Binary Agent",
      version: "2.0.0",
      distribution: {
        binary: {
          [target]: {
            archive: "https://example.com/agent.tar.gz",
            cmd: "agent"
          }
        }
      }
    }]
  };
  const updates = updateCandidates(binaryRegistry, [{
    id: "binary-agent",
    registryId: "binary-agent",
    registryVersion: "1.0.0",
    agentInstalled: true
  }]);
  assert.equal(updates[0].automatic, false);
  assert.equal(updates[0].distribution, "binary");
});

test("agent updater never applies stale registry data or downgrades", async () => {
  let applyCalls = 0;
  const staleManager = new AgentUpdateManager({
    registryLoader: async () => ({ registry, source: "cache", stale: true }),
    detect: async () => [{ id: "claude", registryId: "claude-acp", registryVersion: "0.60.0", agentInstalled: true }],
    applyUpdates: async () => { applyCalls += 1; }
  });
  const stale = await staleManager.refresh();
  assert.equal(applyCalls, 0);
  assert.equal(stale.stale, true);
  assert.equal(stale.alerts[0].code, "acp_registry_stale");

  const downgrade = updateCandidates(registry, [{
    id: "claude",
    registryId: "claude-acp",
    registryVersion: "0.65.0",
    agentInstalled: true
  }]);
  assert.equal(downgrade[0].automatic, false);
  assert.equal(downgrade[0].reason, "local_version_newer");
});

test("agent updater exposes a notification without changing Gateway source", async () => {
  const manager = new AgentUpdateManager({
    enabled: false,
    registryLoader: async () => ({ registry, source: "network", stale: false }),
    detect: async () => [{ id: "claude", registryId: "claude-acp", registryVersion: "0.64.0", agentInstalled: true }],
    sourceChecker: async () => ({
      status: "ready",
      currentVersion: "1.1.0",
      mainVersion: "1.2.0",
      updateAvailable: true
    })
  });
  const result = await manager.refresh();
  assert.equal(result.gatewaySource.mainVersion, "1.2.0");
  assert.equal(result.alerts[0].code, "gateway_source_update_available");
});

test("an npm install is told to update through npm, not main", async () => {
  const manager = new AgentUpdateManager({
    enabled: false,
    registryLoader: async () => ({ registry, source: "network", stale: false }),
    detect: async () => [],
    sourceChecker: async () => ({
      status: "ready",
      installMode: "npm",
      currentVersion: "1.7.0",
      mainVersion: null,
      latestVersion: "1.8.0",
      updateAvailable: true
    })
  });
  const result = await manager.refresh();
  assert.equal(result.gatewaySource.installMode, "npm");
  assert.deepEqual(result.alerts, [{
    level: "info",
    code: "gateway_source_update_available",
    message: "ACP Gateway 1.8.0 is available on npm. Run `npm install -g acp-gateway-daemon@latest`, then `acp-gateway-bootstrap --update` when idle."
  }]);
});

test("a managed runtime or a failed Gateway check raises no alert", async () => {
  for (const gatewaySource of [
    { status: "managed", installMode: "runtime", currentVersion: "1.7.0", mainVersion: null, updateAvailable: false },
    { status: "error", installMode: "npm", currentVersion: null, mainVersion: null, updateAvailable: false, error: "fetch failed" }
  ]) {
    const manager = new AgentUpdateManager({
      enabled: false,
      registryLoader: async () => ({ registry, source: "network", stale: false }),
      detect: async () => [],
      sourceChecker: async () => gatewaySource
    });
    const result = await manager.refresh();
    assert.equal(result.status, "ready");
    assert.deepEqual(result.gatewaySource, gatewaySource);
    assert.deepEqual(result.alerts, []);
  }
});
