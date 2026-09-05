import { loadOfficialRegistry, selectDistribution } from "./acp-registry.js";
import { parseInstallerArgs, runInstaller } from "./installer.js";
import { detectProviders } from "./providers.js";

const REGISTRY_IDS = {
  auggie: "auggie",
  claude: "claude-acp",
  codex: "codex-acp",
  grok: "grok-build"
};

export class AgentUpdateManager {
  constructor({
    enabled = true,
    notifications = true,
    intervalMs = 24 * 60 * 60_000,
    registryLoader = loadOfficialRegistry,
    detect = detectProviders,
    applyUpdates = defaultApplyUpdates,
    sourceChecker = null,
    now = () => Date.now()
  } = {}) {
    this.enabled = enabled;
    this.notifications = notifications;
    this.intervalMs = intervalMs;
    this.registryLoader = registryLoader;
    this.detect = detect;
    this.applyUpdates = applyUpdates;
    this.sourceChecker = sourceChecker;
    this.now = now;
    this.timer = null;
    this.running = null;
    this.state = {
      status: "pending",
      lastCheckedAt: null,
      nextCheckAt: null,
      source: null,
      stale: false,
      available: [],
      lastApplied: [],
      appliedAt: null,
      error: null,
      gatewaySource: null
    };
  }

  start() {
    if (this.timer || (!this.enabled && !this.notifications)) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  refresh() {
    if (this.running) return this.running;
    this.running = this.#refresh().finally(() => { this.running = null; });
    return this.running;
  }

  snapshot() {
    const alerts = [];
    if (this.notifications) {
      if (this.state.error) {
        alerts.push({
          level: "warning",
          code: "acp_agent_update_failed",
          message: `ACP agent update check failed: ${this.state.error}`
        });
      }
      if (this.state.stale) {
        alerts.push({
          level: "warning",
          code: "acp_registry_stale",
          message: "ACP registry refresh failed; automatic adapter changes were skipped and cached version information is being shown."
        });
      }
      if (this.state.lastApplied.length) {
        alerts.push({
          level: "info",
          code: "acp_agents_auto_updated",
          message: `ACP agent adapters were automatically updated: ${formatUpdates(this.state.lastApplied)}`
        });
      }
      if (this.state.available.length) {
        alerts.push({
          level: "warning",
          code: "acp_agent_updates_available",
          message: `ACP agent updates still require attention: ${formatUpdates(this.state.available)}`
        });
      }
      if (this.state.gatewaySource?.updateAvailable) {
        alerts.push({
          level: "info",
          code: "gateway_source_update_available",
          message: `ACP Gateway ${this.state.gatewaySource.mainVersion} is available on main. Run acp-gateway-bootstrap --update when ready.`
        });
      }
    }
    return {
      enabled: this.enabled,
      notifications: this.notifications,
      ...structuredClone(this.state),
      alerts
    };
  }

  async #refresh() {
    this.state.status = "checking";
    this.state.error = null;
    if (this.sourceChecker) {
      try {
        this.state.gatewaySource = await this.sourceChecker();
      } catch (error) {
        this.state.gatewaySource = {
          status: "error",
          currentVersion: null,
          mainVersion: null,
          updateAvailable: false,
          error: error?.message ?? String(error)
        };
      }
    }
    try {
      const loaded = await this.registryLoader({ refresh: true });
      this.state.source = loaded.source;
      this.state.stale = loaded.stale === true;
      const detected = await this.detect();
      const candidates = updateCandidates(loaded.registry, detected);
      this.state.available = candidates;
      const automatic = loaded.stale ? [] : candidates.filter((item) => item.automatic);
      const manual = loaded.stale ? candidates : candidates.filter((item) => !item.automatic);

      if (this.enabled && automatic.length) {
        await this.applyUpdates(automatic);
        const verified = updateCandidates(loaded.registry, await this.detect());
        const appliedIds = new Set(automatic.map((item) => item.registryId));
        const unresolvedAutomatic = verified.filter((item) => appliedIds.has(item.registryId));
        if (unresolvedAutomatic.length) {
          throw new Error(`updated adapter versions could not be verified: ${formatUpdates(unresolvedAutomatic)}`);
        }
        this.state.lastApplied = automatic;
        this.state.appliedAt = new Date(this.now()).toISOString();
        this.state.available = verified.filter((item) => !item.automatic);
      } else {
        this.state.available = [...automatic, ...manual];
      }
      this.state.status = "ready";
    } catch (error) {
      this.state.status = "error";
      this.state.error = error?.message ?? String(error);
    } finally {
      const checkedAt = this.now();
      this.state.lastCheckedAt = new Date(checkedAt).toISOString();
      this.state.nextCheckAt = new Date(checkedAt + this.intervalMs).toISOString();
    }
    return this.snapshot();
  }
}

export function updateCandidates(registry, detected) {
  const agents = new Map(registry.agents.map((agent) => [agent.id, agent]));
  const updates = [];
  for (const provider of detected) {
    if (!provider.agentInstalled) continue;
    const registryId = provider.registryId ?? REGISTRY_IDS[provider.id];
    const agent = agents.get(registryId);
    if (!agent || provider.registryVersion === agent.version) continue;
    const distribution = selectDistribution(agent);
    const direction = updateDirection(provider.registryVersion, agent.version);
    updates.push({
      provider: provider.id,
      registryId,
      currentVersion: provider.registryVersion ?? "unknown",
      latestVersion: agent.version,
      automatic: distribution != null && ["npx", "uvx"].includes(distribution.type) && direction === "upgrade",
      distribution: distribution?.type ?? "unsupported",
      reason: direction === "upgrade" ? null : direction
    });
  }
  return updates.sort((left, right) => left.registryId.localeCompare(right.registryId));
}

function updateDirection(current, latest) {
  if (current == null) return "upgrade";
  const currentVersion = parseVersion(current);
  const latestVersion = parseVersion(latest);
  if (!currentVersion || !latestVersion) return "uncomparable_version";
  for (let index = 0; index < 3; index += 1) {
    if (latestVersion.parts[index] > currentVersion.parts[index]) return "upgrade";
    if (latestVersion.parts[index] < currentVersion.parts[index]) return "local_version_newer";
  }
  if (currentVersion.prerelease && !latestVersion.prerelease) return "upgrade";
  return "uncomparable_version";
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value));
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), prerelease: match[4] ?? null };
}

async function defaultApplyUpdates(updates) {
  const options = parseInstallerArgs([
    "--install-adapters",
    "--refresh-registry",
    "--skip-health-check"
  ]);
  options.registryAgents = updates.map((item) => item.registryId);
  options.registryAgentsOnly = true;
  return runInstaller(options);
}

function formatUpdates(updates) {
  return updates.map((item) => `${item.registryId} ${item.currentVersion} -> ${item.latestVersion}`).join(", ");
}
