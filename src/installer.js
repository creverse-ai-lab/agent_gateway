import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { access, chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { detectProviders } from "./providers.js";
import {
  defaultProviderRegistryPath,
  discoverRegistryAgents,
  installedGlobalNpmPackages,
  loadOfficialRegistry,
  mergeProviderDefinitions,
  providerDefinition,
  selectDistribution
} from "./acp-registry.js";
import { replaceFile } from "./atomic-json.js";
import { BoundedUtf8Text, utf8ByteHead } from "./bounded-utf8.js";
import { childEnv, CONTROL_IDENTITY_ENV } from "./caller.js";
import { GatewayRpcClient } from "./socket-rpc.js";
import { gatewaySocketPath } from "./config.js";
import { GatewaySettings, settingsPaths } from "./settings.js";
import { compareReleases, GATEWAY_VERSION } from "./version.js";

const CONTROL_NAME = "agent-acp";
const GUIDE_NAME = "agent-acp-guide";
const DELEGATOR_SKILL_NAME = "agent-delegator";
const MCP_TARGETS = ["codex", "claude", "grok", "auggie"];
const FRONT_DOOR_TARGETS = new Set(["codex", "claude", "grok"]);
const SUPPORTED_TARGETS = new Set(MCP_TARGETS);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const bundledSkillSource = join(dirname(sourceDirectory), "skills", DELEGATOR_SKILL_NAME);
const NODE_EXECUTABLES = new Set(["node", "nodejs"]);
const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR"]);
// The npm names a Gateway install has had: acp-gateway until 1.7.0, then acp-gateway-daemon.
const GATEWAY_PACKAGE_NAMES = new Set(["acp-gateway", "acp-gateway-daemon"]);
// Captured env values at least this long are also redacted wherever a CLI echoes them.
const MIN_ECHOED_SECRET_LENGTH = 8;
const CONTROL_TOKEN_ENV = "ACP_GATEWAY_CONTROL_TOKEN";
// Why an existing managed entry was left as it is, keyed by repointDecision
// (and updateDecision).
const KEPT_ENTRY_WARNINGS = {
  unknown: "could not verify the registered path; rerun with --force to re-register it",
  foreign: "registered command is not one this installer wrote; rerun with --force to replace it",
  unrecorded: "the entry predates this installer's ownership records, so it cannot tell the entry is still its own and does not update it automatically; rerun with --force once to update it (later updates are automatic)",
  customized: "its env is not the one this installer registered (a variable was added, removed or changed since), so it is left as it is; rerun with --force to re-register it without those changes",
  "other-gateway": "it launches another Gateway install, whose front door may read the Control identity from this entry's env only, so its env is left as it is; rerun with --force to re-register it for this install",
  "keep-stale": "the registered path goes through a symlink to an older gateway; update it with the app that manages that link, or rerun with --force to re-register it",
  "keep-broken-link": "the registered path goes through a broken symlink; fix it with the app that manages it, or rerun with --force to re-register it",
  "keep-link-missing": "the registered path goes through a symlink to a missing script; fix it with the app that manages that link, or rerun with --force to re-register it"
};

export function defaultInstallStatePath() {
  return process.env.ACP_GATEWAY_INSTALL_STATE || join(homedir(), ".acp-gateway", "install.json");
}

// Where `claude mcp add --scope user` records user-scope servers (mcpServers).
function defaultClaudeConfigPath() {
  return join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
}

// The files the agent CLIs keep their user-scope MCP servers in, and so the env
// of each entry the installer adds. Auggie's is not known here.
function defaultAgentConfigPaths(claudeConfigPath) {
  return {
    codex: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"),
    claude: claudeConfigPath,
    grok: join(process.env.GROK_HOME || join(homedir(), ".grok"), "config.toml")
  };
}

export function parseInstallerArgs(argv) {
  let explicitInstallSkill = false;
  let explicitUpdateSkill = false;
  const options = {
    installAdapters: false,
    installAll: false,
    installControl: false,
    installGuide: false,
    installSkill: false,
    updateSkill: false,
    discoverAgents: false,
    registryAgents: [],
    registryAgentsOnly: false,
    offline: false,
    refreshRegistry: false,
    rotateToken: false,
    dryRun: false,
    force: false,
    healthCheck: true,
    showSecrets: false,
    update: false,
    restartDaemon: false,
    agentAutoUpdate: null,
    agentUpdateNotifications: null,
    frontDoor: null,
    allTargets: false,
    targets: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--install-all") {
      options.installAll = true;
      options.installAdapters = true;
      options.installControl = true;
      options.installGuide = true;
      options.installSkill = true;
      options.discoverAgents = true;
    } else if (arg === "--update") {
      options.update = true;
      options.restartDaemon = true;
      options.refreshRegistry = true;
      options.installAdapters = true;
      options.installControl = true;
      options.installGuide = true;
      options.discoverAgents = true;
    } else if (arg === "--install-adapters") {
      options.installAdapters = true;
      options.discoverAgents = true;
    } else if (arg === "--discover-agents") options.discoverAgents = true;
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--refresh-registry") options.refreshRegistry = true;
    else if (arg === "--registry-agent") {
      const id = argv[++index];
      if (!id) throw new Error("--registry-agent requires an ACP registry agent id");
      options.registryAgents.push(id);
      options.discoverAgents = true;
      options.installAdapters = true;
    } else if (arg.startsWith("--registry-agent=")) {
      options.registryAgents.push(arg.slice("--registry-agent=".length));
      options.discoverAgents = true;
      options.installAdapters = true;
    } else if (arg === "--install-control") options.installControl = true;
    else if (arg === "--install-guide") options.installGuide = true;
    else if (arg === "--install-skill") {
      explicitInstallSkill = true;
      options.installSkill = true;
      options.discoverAgents = true;
    } else if (arg === "--update-skill") {
      explicitUpdateSkill = true;
      options.installSkill = true;
      options.updateSkill = true;
    }
    else if (arg === "--rotate-token") {
      options.rotateToken = true;
      options.installControl = true;
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--skip-health-check") options.healthCheck = false;
    else if (arg === "--show-secrets") options.showSecrets = true;
    else if (arg === "--front-door") {
      const target = argv[++index];
      if (!FRONT_DOOR_TARGETS.has(target)) throw new Error("--front-door requires codex, claude, or grok");
      options.frontDoor = target;
    } else if (arg.startsWith("--front-door=")) {
      const target = arg.slice("--front-door=".length);
      if (!FRONT_DOOR_TARGETS.has(target)) throw new Error("--front-door requires codex, claude, or grok");
      options.frontDoor = target;
    }
    else if (arg === "--agent-auto-update") {
      options.agentAutoUpdate = parseOnOff(argv[++index], arg);
      options.restartDaemon = true;
    } else if (arg === "--agent-update-notifications") {
      options.agentUpdateNotifications = parseOnOff(argv[++index], arg);
      options.restartDaemon = true;
    }
    else if (arg === "--target") {
      const target = argv[++index];
      if (!target) throw new Error("--target requires codex, claude, grok, auggie, or all");
      options.targets.push(target);
    } else if (arg.startsWith("--target=")) options.targets.push(arg.slice("--target=".length));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown installer option: ${arg}`);
  }
  if (options.targets.includes("all")) {
    options.allTargets = true;
    options.targets = [...MCP_TARGETS];
  }
  options.targets = [...new Set(options.targets)];
  options.registryAgents = [...new Set(options.registryAgents)];
  for (const id of options.registryAgents) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error(`Invalid ACP registry agent id: ${id || "<empty>"}`);
  }
  for (const target of options.targets) {
    if (!SUPPORTED_TARGETS.has(target)) throw new Error(`Unsupported installer target: ${target}`);
  }
  if (options.frontDoor && !options.installAll) throw new Error("--front-door can only be used with --install-all");
  if (options.frontDoor && options.targets.length) throw new Error("--front-door and --target cannot be combined");
  if (explicitInstallSkill && explicitUpdateSkill) throw new Error("--install-skill and --update-skill cannot be combined");
  if (options.updateSkill && options.installAll) throw new Error("--update-skill cannot be combined with --install-all");
  return options;
}

export async function runInstaller(options, dependencies = {}) {
  const statePath = dependencies.statePath ?? defaultInstallStatePath();
  const detect = dependencies.detectProviders ?? detectProviders;
  const run = dependencies.runCommand ?? runCommand;
  const makeRpc = dependencies.rpcFactory ?? ((config) => new GatewayRpcClient(config));
  const restartGateway = dependencies.restartGateway ?? restartGatewayDaemon;
  const skillSource = dependencies.skillSource ?? bundledSkillSource;
  const registryLoader = dependencies.registryLoader ?? loadOfficialRegistry;
  const registryDiscover = dependencies.registryDiscover ?? discoverRegistryAgents;
  const providerRegistryPath = dependencies.providerRegistryPath ?? defaultProviderRegistryPath();
  const claudeConfigPath = dependencies.claudeConfigPath ?? defaultClaudeConfigPath();
  const agentConfigPaths = { ...defaultAgentConfigPaths(claudeConfigPath), ...dependencies.agentConfigPaths };
  const skillRoots = dependencies.skillRoots ?? {
    codex: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills"),
    claude: join(process.env.CLAUDE_HOME || join(homedir(), ".claude"), "skills"),
    grok: join(process.env.GROK_HOME || join(homedir(), ".grok"), "skills"),
    auggie: join(process.env.AUGMENT_HOME || join(homedir(), ".augment"), "skills"),
    default: join(homedir(), ".agents", "skills")
  };
  const runtime = dependencies.runtime ?? { nodeVersion: process.versions.node, platform: process.platform };
  preflight(runtime);

  const initialProviders = await detect();
  const actions = [];
  const warnings = [];
  let state = await readInstallState(statePath);
  if (options.updateSkill && !Object.keys(state?.managedSkills ?? {}).length) {
    throw new Error("--update-skill requires an installer-managed skill; use --install-skill for the initial installation");
  }
  const configuresAgentUpdates = options.agentAutoUpdate != null || options.agentUpdateNotifications != null;
  if (configuresAgentUpdates && !state && !options.installControl) {
    throw new Error("Install ACP Gateway before configuring the agent update policy");
  }
  let registry = { checked: false, source: null, available: 0, discovered: [], configured: [] };

  if (options.discoverAgents) {
    try {
      const loaded = await registryLoader({
        offline: options.offline,
        refresh: options.refreshRegistry,
        persist: !options.dryRun
      });
      const installedPackages = options.dryRun ? new Set() : await installedGlobalNpmPackages(run);
      const discovered = await registryDiscover(loaded.registry, {
        platform: runtime.platform,
        arch: runtime.arch ?? process.arch,
        installedPackages
      });
      const selected = new Map(discovered.map((item) => [item.registryId, item]));
      for (const id of options.registryAgents) {
        const agent = loaded.registry.agents.find((item) => item.id === id);
        if (!agent) throw new Error(`ACP registry agent not found: ${id}`);
        if (selected.has(id)) continue;
        const distribution = selectDistribution(agent);
        if (!distribution) throw new Error(`${id} has no distribution for this platform`);
        if (distribution.type === "binary") throw new Error(`${id} is binary-only and was not found locally; install its official binary first`);
        selected.set(id, {
          id: id === "claude-acp" ? "claude" : id === "codex-acp" ? "codex" : id === "grok-build" ? "grok" : id,
          registryId: id,
          name: agent.name,
          version: agent.version,
          distribution,
          foundCommand: null,
          packageInstalled: false
        });
      }
      const matches = [...selected.values()].filter(
        (item) => !options.registryAgentsOnly || options.registryAgents.includes(item.registryId)
      );
      const definitions = matches.map(providerDefinition);
      for (const match of matches) {
        const definition = definitions.find((item) => item.registryId === match.registryId);
        actions.push({
          type: "registry-provider",
          provider: definition.id,
          registryId: definition.registryId,
          version: definition.registryVersion,
          distribution: match.distribution.type,
          command: definition.command,
          args: definition.args
        });
        if (options.installAdapters && ["npx", "uvx"].includes(match.distribution.type)) {
          const command = match.distribution.type === "npx" ? "npm" : "uv";
          const args = match.distribution.type === "npx"
            ? ["install", "--global", match.distribution.package]
            : ["tool", "install", "--force", match.distribution.package];
          actions.push({ type: "registry-download", provider: definition.id, command, args });
          if (!options.dryRun) {
            await requireSuccess(run, command, args, `download ${match.registryId} from the ACP registry distribution`);
          }
        }
      }
      if (!options.dryRun && definitions.length) await mergeProviderDefinitions(providerRegistryPath, definitions);
      if (loaded.warning) warnings.push(loaded.warning);
      registry = {
        checked: true,
        source: loaded.source,
        stale: loaded.stale,
        available: loaded.registry.agents.length,
        discovered: matches.map((item) => item.registryId),
        configured: definitions.map((item) => item.id),
        providerRegistryPath
      };
    } catch (error) {
      if (options.registryAgents.length) throw error;
      warnings.push(error.message);
      registry = { ...registry, checked: true, error: error.message };
    }
  }

  if (options.installAdapters) {
    for (const provider of initialProviders) {
      if (registry.configured.includes(provider.id)) continue;
      if (!provider.agentInstalled || provider.adapterInstalled || !provider.install) continue;
      const args = provider.install.split(/\s+/).slice(1);
      actions.push({ type: "adapter", provider: provider.id, command: "npm", args });
      if (!options.dryRun) await requireSuccess(run, "npm", args, `install ${provider.id} ACP adapter`);
    }
  }

  const providers = options.installAdapters && !options.dryRun ? await detect() : initialProviders;
  const availableTargets = MCP_TARGETS.filter(
    (target) => registry.configured.includes(target)
      || providers.some((provider) => provider.id === target && provider.agentInstalled)
  );
  const requestedTargets = options.targets.length
    ? options.targets
    : availableTargets;
  const managedControlTargets = [...new Set(Object.values(state?.managedMcp ?? {})
    .filter((item) => item?.kind === "control" && availableTargets.includes(item.agent))
    .map((item) => item.agent))];
  // An update or a token rotation works on the Control entries this installer
  // manages; a rotation must not add a front door nobody chose.
  const controlTargets = options.installControl
    ? (options.targets.length
        ? requestedTargets
        : options.installAll
          ? [options.frontDoor ?? "codex"]
          : (options.update || options.rotateToken) && managedControlTargets.length
            ? managedControlTargets
            : [availableTargets.includes("codex") ? "codex" : availableTargets[0]].filter(Boolean))
    : [];
  const guideTargets = options.installGuide ? requestedTargets : [];
  const installedProviderIds = new Set([
    ...registry.configured,
    ...providers.filter((provider) => provider.agentInstalled).map((provider) => provider.id)
  ]);
  const managedSkillTargets = [...new Set(Object.values(state?.managedSkills ?? {})
    .filter((item) => item?.name === DELEGATOR_SKILL_NAME && item.agent)
    .map((item) => item.agent))];
  if (options.updateSkill && options.targets.length && !options.allTargets) {
    const unmanaged = requestedTargets.filter((target) => !managedSkillTargets.includes(target));
    if (unmanaged.length) {
      throw new Error(`--update-skill target is not installer-managed: ${unmanaged.join(", ")}; use --install-skill for initial installation`);
    }
  }
  const skillTargets = options.updateSkill
    ? (options.targets.length && !options.allTargets ? requestedTargets : managedSkillTargets)
    : options.installSkill
      ? (options.targets.length && !options.allTargets ? requestedTargets : [...installedProviderIds])
      : [];

  let identity = state?.identity ?? null;
  // The identity existing entries were registered with, which is what tells an
  // entry this installer wrote, even after --rotate-token replaces it below.
  const registeredIdentity = identity;
  if ((options.installControl || options.installGuide || options.installSkill || configuresAgentUpdates) && !state) {
    state = { version: 1, managedMcp: {}, managedSkills: {}, agentUpdates: { autoUpdate: true, notifications: true } };
  }
  if (state) {
    state.agentUpdates ??= { autoUpdate: true, notifications: true };
    if (options.agentAutoUpdate != null) state.agentUpdates.autoUpdate = options.agentAutoUpdate;
    if (options.agentUpdateNotifications != null) state.agentUpdates.notifications = options.agentUpdateNotifications;
    if (configuresAgentUpdates) {
      actions.push({ type: "agent-update-policy", ...state.agentUpdates });
    }
  }
  if (options.installControl) {
    // A first identity is written before any entry is registered: an
    // identity-free entry reads it from this file. A rotated one replaces the
    // previous only once every entry is recorded as this run left it (after
    // the loop below), so a run cut short leaves install.json with the
    // identity the running daemon and every entry still share, and a retry
    // still recognizes the entries that kept it in their env.
    const rotating = Boolean(identity) && options.rotateToken;
    if (!identity || options.rotateToken) identity = createIdentity();
    if (!rotating) state.identity = identity;
    state.managedMcp ??= {};
    state.updatedAt = new Date().toISOString();
    if (!options.dryRun) await writeInstallState(statePath, state);
  }

  const installedSkillDestinations = new Map();
  // migrated counts the entries whose Control token this run took out of an
  // agent config; persist records an entry the moment it is rewritten.
  const mcpContext = {
    options, state, run, actions, warnings, claudeConfigPath, agentConfigPaths,
    migrated: 0,
    persist: () => writeInstallState(statePath, state)
  };
  const specOptions = { registeredIdentity, statePath };
  for (const target of new Set([...controlTargets, ...guideTargets, ...skillTargets])) {
    const provider = providers.find((item) => item.id === target);
    const providerInstalled = provider?.agentInstalled || registry.configured.includes(target);
    const needsMcp = controlTargets.includes(target) || guideTargets.includes(target);
    if (needsMcp && !providerInstalled) {
      warnings.push(`${target} is not installed; MCP registration skipped`);
    } else if (controlTargets.includes(target)) {
      await installMcp(mcpSpec(target, "control", identity, specOptions), mcpContext);
    }
    if (guideTargets.includes(target) && providerInstalled) {
      await installMcp(mcpSpec(target, "guide", identity, specOptions), mcpContext);
    }
    const managedSkill = state?.managedSkills?.[`${target}:${DELEGATOR_SKILL_NAME}`];
    const canManageSkill = installedProviderIds.has(target) || (options.updateSkill && managedSkill?.path);
    if (skillTargets.includes(target) && canManageSkill) {
      const destinationRoot = options.updateSkill && managedSkill?.path
        ? dirname(managedSkill.path)
        : skillRoots[target] ?? skillRoots.default;
      if (!destinationRoot) throw new Error(`No skill installation path is configured for ${target}`);
      const destination = join(destinationRoot, DELEGATOR_SKILL_NAME);
      const shared = installedSkillDestinations.get(destination);
      if (shared) {
        actions.push({
          type: "skill",
          agent: target,
          name: DELEGATOR_SKILL_NAME,
          source: skillSource,
          destination,
          status: "shared",
          sharedWith: shared.agent,
          sharedStatus: shared.status
        });
        if (!options.dryRun && shared.stateSafe && shared.record) {
          state.managedSkills ??= {};
          state.managedSkills[`${target}:${DELEGATOR_SKILL_NAME}`] = {
            ...shared.record,
            agent: target,
            path: destination,
            sharedWith: shared.agent
          };
        }
        continue;
      }
      const installed = await installBundledSkill(target, {
        source: skillSource,
        destinationRoot,
        options,
        state,
        actions,
        warnings
      });
      installedSkillDestinations.set(destination, { agent: target, ...installed });
    } else if (skillTargets.includes(target)) {
      warnings.push(`${target} is not installed; skill installation skipped`);
    }
  }
  // Every entry is recorded as it is now: a rotated identity may take over.
  if (options.installControl) state.identity = identity;
  // Rotating is the user's call, not the migration's: an app such as AgenLynk
  // keeps the identity it read, and a new token would lock it out, as it would
  // every open agent CLI session, whose Control MCP server read the token once,
  // at start.
  if (mcpContext.migrated && !options.rotateToken) {
    const removed = mcpContext.migrated === 1 ? "one MCP registration" : `${mcpContext.migrated} MCP registrations`;
    warnings.push(`The Control token was removed from ${removed}, but copies made before, such as the agent CLIs' config backups (*.bak), may still hold it. To retire it, stop the Gateway when it is idle (acp-gateway-admin shutdown_if_idle), run acp-gateway-bootstrap --rotate-token, restart the agent CLI sessions that are open (each one's Control MCP server reads the token once, at start), and reconnect apps that keep the identity, such as AgenLynk`);
  }

  if (state && !options.dryRun && (options.installControl || options.installGuide || options.installSkill || configuresAgentUpdates)) {
    state.updatedAt = new Date().toISOString();
    await writeInstallState(statePath, state);
  }

  if (configuresAgentUpdates && !options.dryRun) {
    const settings = new GatewaySettings({ ...settingsPaths({ ...process.env, ACP_GATEWAY_INSTALL_STATE: statePath }) });
    settings.update({ expectedRevision: settings.snapshot().revision, values: {
      ...(options.agentAutoUpdate == null ? {} : { agentAutoUpdate: options.agentAutoUpdate }),
      ...(options.agentUpdateNotifications == null ? {} : { agentUpdateNotifications: options.agentUpdateNotifications })
    } });
  }

  let restart = { requested: options.restartDaemon, performed: false, wasRunning: false };
  if (options.restartDaemon) {
    actions.push({ type: "daemon-restart" });
    if (!options.dryRun) {
      restart = {
        requested: true,
        ...await restartGateway({ identity, makeRpc, socketPath: gatewaySocketPath() })
      };
    }
  }

  let health = { checked: false };
  if (options.installControl && options.healthCheck && !options.dryRun) {
    let result = await gatewaySetup(makeRpc, identity);
    if (result?.ok === true && result?.gatewayVersion !== GATEWAY_VERSION && !options.restartDaemon) {
      actions.push({
        type: "daemon-restart",
        reason: "version-mismatch",
        fromVersion: result?.gatewayVersion ?? null,
        toVersion: GATEWAY_VERSION
      });
      restart = {
        requested: false,
        automatic: true,
        ...await restartGateway({ identity, makeRpc, socketPath: gatewaySocketPath() })
      };
      result = await gatewaySetup(makeRpc, identity);
    }
    health = {
      checked: true,
      ok: result?.ok === true && result?.gatewayVersion === GATEWAY_VERSION,
      version: result?.gatewayVersion,
      agentUpdates: result?.agentUpdates ?? null,
      alerts: result?.alerts ?? []
    };
    if (!health.ok) {
      throw new Error(`Gateway health check version mismatch: expected ${GATEWAY_VERSION}, received ${result?.gatewayVersion ?? "unknown"}`);
    }
  }

  return {
    ok: true,
    dryRun: options.dryRun,
    statePath,
    providers,
    targets: { control: controlTargets, guide: guideTargets, skill: skillTargets },
    actions,
    health,
    restart,
    warnings,
    registry,
    identity: identity
      ? {
          rootId: identity.rootId,
          token: options.showSecrets ? identity.token : undefined,
          tokenStored: !options.dryRun,
          rotated: options.rotateToken
        }
      : undefined
  };
}

export function installerHelp() {
  return [
    "Usage: acp-gateway-bootstrap [options]",
    "",
    "  --version, -V          Print the installed ACP Gateway version",
    "  --update               Pull a source checkout (npm/app installs skip Git), preview, update adapters/MCPs, and restart",
    "  --install-all          Install adapters, Control, Guide, and agent-delegator",
    "  --front-door <agent>   Choose codex, claude, or grok as the install-all Control MCP",
    "  --install-adapters     Install missing ACP adapters",
    "  --discover-agents      Match installed AI CLIs with the official ACP registry",
    "  --registry-agent <id>  Install/configure one official registry agent (repeatable)",
    "  --refresh-registry     Refresh the cached official ACP registry",
    "  --offline              Use only the cached ACP registry",
    "  --install-control      Register the Main-only Control MCP",
    "  --install-guide        Register the read-only Guide MCP",
    "  --install-skill        Initially install agent-delegator for discovered agents",
    "  --update-skill         Update unchanged installer-managed agent-delegator copies",
    "  --target <agent>       codex, claude, grok, auggie, or all (repeatable)",
    "  --rotate-token         Replace the Control token and Main ID kept in install.json",
    "  --dry-run              Print planned changes without modifying the system",
    "  --force                Replace unmanaged entries or overwrite customized managed skills",
    "  --skip-health-check    Do not start/connect to the daemon after installation",
    "  --show-secrets         Include the generated Control token in JSON output",
    "  --agent-auto-update <on|off>       Configure automatic ACP adapter updates",
    "  --agent-update-notifications <on|off>  Configure health-check update alerts",
    "  --help                 Show this help"
  ].join("\n");
}

function parseOnOff(value, option) {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`${option} requires on or off`);
}

// No error out of an MCP registration carries a value of the Control identity
// (token and root id), including wherever a CLI echoed it, and after
// --rotate-token the retired one too: a running daemon still accepts it.
async function installMcp(spec, context) {
  try {
    await applyMcp(spec, context);
  } catch (error) {
    throw new Error(redactEnv(redactEnv(error?.message ?? String(error), spec.identityEnv), spec.registeredIdentityEnv));
  }
}

async function applyMcp(spec, context) {
  const { options, state, run, actions, warnings, claudeConfigPath } = context;
  const key = `${spec.agent}:${spec.name}`;
  const action = { type: "mcp", agent: spec.agent, name: spec.name, command: spec.command, args: spec.args };
  actions.push(action);

  const inspected = await inspectEntry(spec, run, key, { dryRun: options.dryRun, claudeConfigPath });
  if (inspected.error) {
    action.status = "unknown";
    warnings.push(`${key}: ${inspected.error}; the dry run could not inspect it`);
    return;
  }
  const { exists, registered } = inspected;
  const record = state?.managedMcp?.[key];
  if (exists && !record && !options.force) {
    throw new Error(`${key} already exists and is not managed by this installer; rerun with --force to replace it`);
  }
  // A token rotation re-registers nothing on its own account: an entry
  // without the identity reads the new one from install.json, and one with it
  // moves only when it is provably this installer's, as on any update.
  let launch = spec.launch;
  if (exists && record && !options.force) {
    const update = await updateDecision(registered, spec, record);
    if (update.kept) {
      action.status = "unchanged";
      const reason = update.kept === "gap"
        ? `could not read the entry fully enough to put it back if the update failed (${update.gap}); rerun with --force to re-register it`
        : KEPT_ENTRY_WARNINGS[update.kept];
      if (reason) warnings.push(`${key}: ${reason}`);
      await warnHeldToken(key, spec, registered, context);
      return;
    }
    launch = update.launch;
    action.status = options.dryRun ? "would-update" : "updated";
    action.args = spec.addArgs(launch, spec.env);
    action.previous = { command: registered.command, args: redactArgs(registered.args) };
    action.next = { command: launch.command, args: redactArgs(launch.args) };
  } else if (options.dryRun) {
    action.status = exists ? "would-replace" : "would-install";
  }
  // By name only, as everywhere: what the replacement leaves out of the env.
  const removedEnv = identityNames(registered?.env);
  if (removedEnv.length) action.removedEnv = removedEnv;
  if (options.dryRun) return;
  await registerMcp(spec, key, exists ? registered : null, run, launch);
  if (removedEnv.includes(CONTROL_TOKEN_ENV)) context.migrated += 1;
  state.managedMcp ??= {};
  state.managedMcp[key] = {
    agent: spec.agent,
    name: spec.name,
    kind: spec.kind,
    installedAt: new Date().toISOString(),
    // What this installer registered, so a later run can tell the entry is
    // still its own. The env is recorded by name only; since 1.8.0 it never
    // names the Control identity, which is how an identity-free entry is
    // recognized as this installer's later.
    launch: { command: launch.command, args: [...launch.args], envKeys: Object.keys(spec.env) }
  };
  // Written now, not at the end of the run: the entry is live as it is, and
  // a later one failing must not leave install.json describing the entry
  // this one replaced.
  await context.persist();
}

// What an update does with an existing entry this installer manages: {launch}
// re-registers it with that launch and this install's env; {kept} leaves it,
// for a KEPT_ENTRY_WARNINGS reason (none for a plain "keep"), or "gap" with
// {gap}. An entry moves only when it is provably still this installer's, and
// either provably stale (repointDecision) or, already launching this install,
// still holding the Control identity in its env: that one is re-registered in
// place, launch unchanged, without the identity. One launching any other
// install keeps its env, since that install's front door may read the
// identity from nowhere else.
async function updateDecision(registered, spec, record) {
  const decision = await repointDecision(registered, spec, record);
  const recorded = recordedLaunch(record);
  let launch;
  if (decision === "repoint") {
    launch = spec.launch;
  } else if (decision === "keep" && identityNames(registered.env).length) {
    if (!recorded) return { kept: "unrecorded" };
    if (!(await samePath(registered.args[0], spec.launch.args[0]))) return { kept: "other-gateway" };
    launch = { command: registered.command, args: [...registered.args] };
  } else {
    return { kept: decision };
  }
  // Replacing means removing first, so an update nobody asked for goes
  // ahead only when the entry could be put back as it was.
  const gap = restoreGap(registered);
  if (gap) return { kept: "gap", gap };
  // Only a recorded launch gets here, and it proves the command and args. The
  // env is part of the entry too: a variable the user added (HTTP_PROXY,
  // NODE_OPTIONS) or an identity value changed since would be lost to the
  // replacement, so such an entry stays as it is.
  const ownValues = { ...spec.registeredIdentityEnv, ...spec.env };
  if (!recorded || !ownEnv(registered.env, { envKeys: recorded.envKeys, ownValues, installEnv: spec.env })) {
    return { kept: "customized" };
  }
  return { launch };
}

// The Control identity variables an entry's env holds, as its CLI reports it.
function identityNames(env) {
  return env ? CONTROL_IDENTITY_ENV.filter((name) => Object.hasOwn(env, name)) : [];
}

// An entry left as it is while its env still holds the Control token: the
// warning says so, and the agent config it sits in becomes readable by its
// owner only (Grok writes its config 0644). After --rotate-token the token is
// the retired one, which the daemon stops accepting once it restarts.
async function warnHeldToken(key, spec, registered, { options, warnings, agentConfigPaths }) {
  const token = registered?.env?.[CONTROL_TOKEN_ENV];
  if (!token) return;
  const path = agentConfigPaths?.[spec.agent];
  const tightened = !options.dryRun && await tightenAgentConfig(path, token);
  const which = options.rotateToken ? "the retired Control token, which stops working once the daemon restarts" : "the Control token";
  warnings.push(`${key}: its env still holds ${which}, and so does ${spec.agent}'s MCP configuration${tightened ? ` (${path} is now readable only by you)` : ""}; rerun with --force to re-register it without the token`);
}

// Makes the file mode 0600 when it is wider, and says whether it did. Only a
// file that holds this very token is touched: a CLI may keep the entry
// elsewhere (another home, a project config), and a file that does not hold
// the token has nothing of the Gateway's to protect.
async function tightenAgentConfig(path, token) {
  if (!path) return false;
  try {
    const info = await stat(path);
    if (!info.isFile() || (info.mode & 0o077) === 0) return false;
    if (!(await readFile(path, "utf8")).includes(token)) return false;
    await chmod(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

// Adds the entry with this install's env, replacing `previous` when there is
// one. The CLIs have no atomic replace, so a failed add after the remove puts
// the previous entry back exactly as it was, with the command, args and env it
// had, rather than leave the agent with no entry; the error reports both
// outcomes. That restore is the one command whose argv may carry a secret: the
// Control token an older registration kept in its env.
async function registerMcp(spec, key, previous, run, launch) {
  const redaction = { env: { ...spec.identityEnv, ...(previous?.env ?? {}) } };
  if (previous) await requireSuccess(run, spec.command, spec.removeArgs, `remove existing ${key}`, redaction);
  const failure = await attemptCommand(run, spec.command, spec.addArgs(launch, spec.env), `install ${key}`, redaction);
  if (!failure) return;
  if (!previous) throw failure;
  if (!previous.command || !previous.args || previous.exact === false) {
    throw new Error(`${failure.message}; the previous ${key} entry was removed and could not be restored because ${spec.agent} did not report its full launch command; re-add it or rerun the installer`);
  }
  const env = previous.env ?? {};
  const restoreFailure = await attemptCommand(run, spec.command, spec.addArgs(previous, env), `restore the previous ${key}`, {
    shown: spec.addArgs(previous, hiddenEnv(env)),
    env: { ...spec.identityEnv, ...env }
  });
  const gap = restoreGap(previous);
  if (!restoreFailure) {
    throw new Error(gap
      ? `${failure.message}; the previous ${key} entry was restored, but not exactly (${gap}); re-add what it needs`
      : `${failure.message}; the previous ${key} entry was restored`);
  }
  const launched = [previous.command, ...redactArgs(previous.args)].join(" ");
  const envNames = Object.keys(env).length ? `, with env ${Object.keys(env).join(", ")}` : "";
  throw new Error(`${failure.message}; ${restoreFailure.message}; ${key} is no longer registered (it launched: ${launched}${envNames}); re-add it or rerun the installer`);
}

// Why an inspected entry could not be added back exactly as it is, or null
// when it could.
function restoreGap(entry) {
  if (!entry?.command || !entry.args || entry.exact === false) return "its full launch command was not reported";
  return entry.gap ?? null;
}

// The command's failure as an Error, or null when it succeeded. `shown` is
// what the message prints for the args; `env` names values to hide in
// whatever the command printed.
async function attemptCommand(run, command, args, operation, redaction) {
  let result;
  try {
    result = await run(command, args);
  } catch (error) {
    const shown = redaction?.shown ?? redactArgs(args);
    return new Error(`${operation} failed (${command} ${shown.join(" ")}): ${redactEnv(error?.message ?? String(error), redaction?.env)}`);
  }
  return result.code === 0 ? null : commandError(command, args, result, operation, redaction);
}

// An entry's inspection: whether it exists and, when it does, what it
// launches and with which env (registeredLaunch).
async function inspectEntry(spec, run, key, { dryRun, claudeConfigPath }) {
  if (spec.agent !== "claude") return inspectWithCli(spec, run, key);
  // A dry run inspects too, but never through a command that starts the
  // server: `claude mcp get` health-checks the entry by launching it, and a
  // launched front door can autostart a daemon. Codex `mcp get` and the Grok
  // and Auggie lists only read configuration.
  if (dryRun) return readClaudeEntry(claudeConfigPath, spec.name);
  const inspected = await inspectWithCli(spec, run, key);
  if (!inspected.exists) return inspected;
  return { exists: true, registered: await withClaudeConfig(inspected.registered, claudeConfigPath, spec.name) };
}

async function inspectWithCli(spec, run, key) {
  const result = await run(spec.command, spec.getArgs);
  const exists = inspectMcpExists(spec, result);
  if (!exists && spec.inspectMode !== "list-json" && !/no mcp server|not found|does not exist/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw commandError(spec.command, spec.getArgs, result, `inspect ${key}`, { env: spec.identityEnv });
  }
  return { exists, registered: exists ? registeredLaunch(spec, result) : null };
}

// Claude's user-scope entry straight from its config file, read-only.
async function readClaudeEntry(path, name) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, registered: null };
    return { error: `could not read ${path}: ${error.message}` };
  }
  const config = parseJson(text);
  if (!config || typeof config !== "object") return { error: `could not parse ${path}` };
  const entry = config.mcpServers?.[name];
  return { exists: Boolean(entry), registered: entry ? entryLaunch(entry, "claude") : null };
}

// `claude mcp get` prints the args joined by spaces and the env as text. The
// user-scope entry in Claude's config file holds both exactly, and is the one
// the installer removes, so it stands in when it launches what the CLI
// reported; otherwise the entry cannot be put back exactly.
async function withClaudeConfig(reported, path, name) {
  const file = await readClaudeEntry(path, name);
  const entry = file.registered;
  if (entry?.command && entry.args && reported.args
    && entry.command === reported.command && entry.args.join(" ") === reported.args.join(" ")) {
    return entry;
  }
  return { ...reported, env: null, gap: file.error ?? `the user-scope ${name} in ${path} is not the entry claude reported` };
}

async function installBundledSkill(agent, { source, destinationRoot, options, state, actions, warnings }) {
  if (!destinationRoot) throw new Error(`No skill installation path is configured for ${agent}`);
  const destination = join(destinationRoot, DELEGATOR_SKILL_NAME);
  const key = `${agent}:${DELEGATOR_SKILL_NAME}`;
  const exists = await pathExists(destination);
  const sourceDigest = await skillTreeDigest(source);
  const existingRecord = state?.managedSkills?.[key]
    ?? Object.values(state?.managedSkills ?? {}).find((item) => item?.path === destination);
  const managedDestination = Boolean(existingRecord);
  let destinationDigest = null;
  let destinationDigestError = null;
  if (exists) {
    try {
      destinationDigest = await skillTreeDigest(destination);
    } catch (error) {
      destinationDigestError = error;
    }
  }
  const action = { type: "skill", agent, name: DELEGATOR_SKILL_NAME, source, destination };
  actions.push(action);

  if (!options.updateSkill && exists && !managedDestination && !options.force) {
    throw new Error(`${key} already exists and is not managed by this installer; rerun with --force to replace it`);
  }

  if (!options.updateSkill && exists && managedDestination && !options.force) {
    action.status = "already-installed";
    warnings.push(`${key} is already installed; use --update-skill to update an unchanged managed copy or --force to replace it`);
    return { status: action.status, record: existingRecord, stateSafe: false };
  }

  if (options.updateSkill && exists && !options.force) {
    if (destinationDigestError) {
      action.status = "customized-or-unsupported";
      warnings.push(`${key} was not updated because its installed tree could not be verified: ${destinationDigestError.message}; rerun with --force to replace it`);
      return { status: action.status, record: existingRecord, stateSafe: false };
    }
    if (!existingRecord?.sourceDigest) {
      action.status = "legacy-unverified";
      warnings.push(`${key} was not updated because its legacy install has no recorded digest; rerun with --force after reviewing local customizations`);
      return { status: action.status, record: existingRecord, stateSafe: false };
    }
    if (destinationDigest === sourceDigest) {
      action.status = "up-to-date";
      const record = skillInstallRecord(agent, destination, existingRecord, sourceDigest);
      if (!options.dryRun) {
        state.managedSkills ??= {};
        state.managedSkills[key] = record;
      }
      return { status: action.status, record, stateSafe: true };
    }
    if (destinationDigest !== existingRecord.sourceDigest) {
      action.status = "customized";
      warnings.push(`${key} was not updated because the installed skill was modified; rerun with --force to overwrite it`);
      return { status: action.status, record: existingRecord, stateSafe: false };
    }
  }

  action.status = exists ? (options.updateSkill ? "updated" : "replaced") : "installed";
  if (options.dryRun) {
    return {
      status: action.status,
      record: skillInstallRecord(agent, destination, existingRecord, sourceDigest),
      stateSafe: true
    };
  }

  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const temporary = `${destination}.tmp-${suffix}`;
  const backup = `${destination}.backup-${suffix}`;
  await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
  let backedUp = false;
  try {
    if (exists) {
      await rename(destination, backup);
      backedUp = true;
    }
    await rename(temporary, destination);
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (backedUp && !(await pathExists(destination))) await rename(backup, destination).catch(() => {});
    throw error;
  }
  state.managedSkills ??= {};
  const record = skillInstallRecord(agent, destination, existingRecord, sourceDigest);
  state.managedSkills[key] = record;
  return { status: action.status, record, stateSafe: true };
}

function skillInstallRecord(agent, path, existing, sourceDigest) {
  const now = new Date().toISOString();
  return {
    ...existing,
    agent,
    name: DELEGATOR_SKILL_NAME,
    path,
    sourceDigest,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now
  };
}

async function skillTreeDigest(root) {
  const hash = createHash("sha256");
  const absoluteRoot = resolve(root);
  const rootStat = await lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`skill root must be a real directory: ${absoluteRoot}`);
  }
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        await visit(path, relative);
      } else if (entry.isFile()) {
        const data = await readFile(path);
        hash.update(`file\0${relative}\0${data.length}\0`);
        hash.update(data);
      } else {
        throw new Error(`unsupported skill entry: ${path}`);
      }
    }
  }
  await visit(absoluteRoot);
  return hash.digest("hex");
}

function mcpSpec(agent, kind, identity, { registeredIdentity = identity, statePath = defaultInstallStatePath() } = {}) {
  const isControl = kind === "control";
  const name = isControl ? CONTROL_NAME : GUIDE_NAME;
  const script = join(sourceDirectory, isControl ? "index.js" : "guide.js");
  const serverCommand = stableNodeCommand();
  const serverArgs = [script];
  // What the host will launch, as opposed to the CLI call that registers it.
  const launch = { command: serverCommand, args: serverArgs };
  // The env the entry is registered with. Never the Control identity: the
  // front door reads it from install.json (config.js controlIdentity), so
  // neither the agent CLI's config nor the argv that registers the entry holds
  // a secret. An install state away from its default path is named, or the
  // front door, started with the agent CLI's env, would look for it there.
  const installState = resolve(statePath);
  const env = isControl && installState !== join(homedir(), ".acp-gateway", "install.json")
    ? { ACP_GATEWAY_INSTALL_STATE: installState }
    : {};
  // The identity values: hidden from whatever a CLI prints, and for an entry
  // registered before 1.8.0, part of the env this installer gave it
  // (registeredIdentity, the one before any --rotate-token of this run).
  const identityEnvOf = (value) => isControl && value
    ? { ACP_GATEWAY_CONTROL_TOKEN: value.token, ACP_GATEWAY_ROOT_ID: value.rootId }
    : {};
  // addArgs registers any launch under this entry's name with the given env,
  // so a failed replacement can put the previous entry back as it was.
  const pairs = (flag, values) => Object.entries(values).flatMap(([name, value]) => [flag, `${name}=${value}`]);
  const withAdd = (fields, addArgs) => ({
    ...fields,
    env,
    identityEnv: identityEnvOf(identity),
    registeredIdentityEnv: identityEnvOf(registeredIdentity),
    addArgs,
    args: addArgs(launch, env)
  });
  if (agent === "codex") {
    return withAdd({
      agent, kind, name, command: "codex", launch,
      getArgs: ["mcp", "get", name, "--json"],
      removeArgs: ["mcp", "remove", name]
    }, ({ command, args }, env) => ["mcp", "add", ...pairs("--env", env), name, "--", command, ...args]);
  }
  if (agent === "grok") {
    return withAdd({
      agent, kind, name, command: "grok", inspectMode: "list-json", launch,
      getArgs: ["mcp", "list", "--json"],
      removeArgs: ["mcp", "remove", name]
    }, ({ command, args }, env) => ["mcp", "add", "--scope", "user", ...pairs("--env", env), name, "--", command, ...args]);
  }
  if (agent === "auggie") {
    return withAdd({
      agent, kind, name, command: "auggie", inspectMode: "list-json", launch,
      getArgs: ["mcp", "list", "--json"],
      removeArgs: ["mcp", "remove", name]
    }, ({ command, args }, env) => ["mcp", "add-json", name, JSON.stringify({ type: "stdio", command, args, env }), "--replace"]);
  }
  if (agent !== "claude") throw new Error(`MCP registration is not supported for ${agent}`);
  return withAdd({
    agent, kind, name, command: "claude", launch,
    getArgs: ["mcp", "get", name],
    removeArgs: ["mcp", "remove", "--scope", "user", name]
  }, ({ command, args }, env) => ["mcp", "add", "--scope", "user", name, ...pairs("-e", env), "--", command, ...args]);
}

function inspectMcpExists(spec, result) {
  if (spec.inspectMode !== "list-json") return result.code === 0;
  if (result.code !== 0) throw commandError(spec.command, spec.getArgs, result, `inspect ${spec.agent}:${spec.name}`, { env: spec.identityEnv });
  try {
    const parsed = JSON.parse(result.stdout);
    const servers = Array.isArray(parsed) ? parsed : parsed?.servers;
    if (!Array.isArray(servers)) throw new Error("server list is missing");
    return servers.some((item) => item?.name === spec.name);
  } catch (error) {
    throw new Error(`inspect ${spec.agent}:${spec.name} returned invalid JSON: ${error.message}`);
  }
}

// What an existing entry launches and with which env, read from the inspect
// output: {command, args, env, gap}. A null command or args means the output
// does not say; a null env, or a gap, means the entry could not be added back
// exactly as it is, and gap says why. Shapes, per CLI:
//   codex  `mcp get --json`  {transport: {command, args, env (null for none), env_vars, cwd}}
//   grok   `mcp list --json` [{name, scope, command, args, env, cwd}] (empty fields left out)
//   auggie `mcp list --json` {servers: [{name, source, transport: "stdio", command}]} (no args, no env)
//   claude `mcp get`         text lines "  Command: <cmd>" and "  Args: <args joined by spaces>";
//                            the exact args and env come from its config file (withClaudeConfig)
function registeredLaunch(spec, result) {
  if (spec.inspectMode === "list-json") {
    const parsed = parseJson(result.stdout);
    const servers = (Array.isArray(parsed) ? parsed : parsed?.servers ?? []).filter((item) => item?.name === spec.name);
    // A same-named project or registry entry can sit beside the user-scope one this installer adds.
    return entryLaunch(servers.find((item) => item.scope === "user" || item.source === "user") ?? servers[0], spec.agent);
  }
  if (spec.getArgs.includes("--json")) return entryLaunch(parseJson(result.stdout), spec.agent);
  const command = /^[ \t]*Command:[ \t]*(.*?)[ \t]*$/m.exec(result.stdout)?.[1];
  if (!command) return { command: null, args: null, env: null, gap: null };
  // Claude joins args with spaces, so the line is kept whole: the gateway
  // registers exactly one argument, and extra ones then read as a difference.
  // A line with spaces in it cannot be split back, so it is not re-added as is.
  const args = /^[ \t]*Args:[ \t]*(.*?)[ \t]*$/m.exec(result.stdout)?.[1];
  return {
    command,
    args: args == null ? null : args ? [args] : [],
    exact: !/\s/.test(args ?? ""),
    env: null,
    gap: "claude mcp get does not print its env exactly"
  };
}

function entryLaunch(entry, agent) {
  const holder = typeof entry?.command === "string"
    ? entry
    : entry?.transport && typeof entry.transport === "object" ? entry.transport : null;
  const command = typeof holder?.command === "string" && holder.command ? holder.command : null;
  const args = Array.isArray(holder?.args) && holder.args.every((arg) => typeof arg === "string") ? [...holder.args] : null;
  return { command, args, ...entryEnv(holder, agent) };
}

// The env an entry sets as its CLI reports it, and what else about the entry
// that CLI's add command could not set again.
function entryEnv(holder, agent) {
  if (agent === "auggie") return { env: null, gap: "auggie mcp list does not report its args or env" };
  if (!holder) return { env: null, gap: `${agent} did not report a command it launches` };
  // Codex prints `env: null` for none; Grok and Claude's config leave an empty env out.
  const env = holder.env === null || (holder.env === undefined && agent !== "codex") ? {} : holder.env;
  if (!env || typeof env !== "object" || Array.isArray(env) || !Object.values(env).every((value) => typeof value === "string")) {
    return { env: null, gap: `${agent} did not report its env` };
  }
  if (Object.values(env).some((value) => /^\*{3,}$/.test(value))) {
    return { env: null, gap: `${agent} reported its env values masked` };
  }
  let gap = null;
  if (Array.isArray(holder.env_vars) && holder.env_vars.length) gap = `it forwards env_vars, which ${agent} mcp add cannot set`;
  else if (typeof holder.cwd === "string" && holder.cwd) gap = `it sets a cwd, which ${agent} mcp add cannot set`;
  return { env: { ...env }, gap };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Whether a managed entry should launch this install instead: "repoint",
// "keep", or a reason it stays that KEPT_ENTRY_WARNINGS explains. The install
// state's key only says this installer once wrote an entry by that name: the
// user or another manager (AgenLynk's runtime/current) may have replaced it
// since, with the same shape. So an entry moves only when it is provably
// still this installer's and provably stale, and never to an older gateway.
// Proof of ownership is the launch the state records this installer
// registering (and, checked by updateDecision, the env it registered). A record
// from before launches were recorded leaves only the shape, which a user's
// own older Gateway install has too, so such an entry never moves on its own:
// it stays, "unrecorded", until --force re-registers it and records it.
async function repointDecision(registered, spec, record) {
  const { launch } = spec;
  if (!registered?.command || !registered.args) return "unknown";
  const recorded = recordedLaunch(record);
  if (recorded === null) return "unknown";
  if (recorded && !sameLaunch(registered, recorded)) return "foreign";
  if (registered.args.length !== 1) return "foreign";
  const script = normalizedPath(registered.args[0]);
  // Recorded: exactly what this installer registered. Otherwise only its shape, which anyone can copy.
  const written = Boolean(recorded) || installerWrote(registered, spec);
  let resolved;
  try {
    resolved = await realpath(script);
  } catch (error) {
    // Only a path that is not there is stale; EACCES and the like say nothing.
    if (!MISSING_PATH_CODES.has(error?.code)) return "unknown";
    if (!written) return "foreign";
    const decision = await missingScriptDecision(script);
    return decision === "repoint" && !recorded ? "unrecorded" : decision;
  }
  // A path through a symlink is a pointer someone else moves forward. When it
  // resolves to an older gateway the entry still stays, but says so: the
  // pointer's manager (or --force) has to move it, and an OS alias such as
  // /var -> /private/var must not hide a stale fixed path silently.
  if (resolved !== script) {
    const order = compareReleases(await gatewayVersionAt(dirname(resolved)), GATEWAY_VERSION);
    return order !== null && order < 0 ? "keep-stale" : "keep";
  }
  // Stale, and moved only when the record proves it is this installer's. The
  // package name only picks which warning an unrecorded entry gets.
  const owned = async () => {
    if (recorded) return "repoint";
    if (!written) return "foreign";
    const gateway = await isGatewayPackage(dirname(dirname(script)));
    return gateway === null ? "unknown" : gateway ? "unrecorded" : "foreign";
  };
  if (await samePath(script, launch.args[0])) {
    if (await samePath(registered.command, launch.command)) return "keep";
    return owned();
  }
  const order = compareReleases(await gatewayVersionAt(dirname(script)), GATEWAY_VERSION);
  if (order === null) return "unknown";
  if (order >= 0) return "keep";
  return owned();
}

// The launch a managed record says this installer registered, with the names
// of the env it registered: undefined for a record from before launches were
// recorded, null for one that is unreadable.
function recordedLaunch(record) {
  if (record?.launch === undefined) return undefined;
  const { command, args, envKeys } = record.launch ?? {};
  const strings = (list) => Array.isArray(list) && list.every((item) => typeof item === "string");
  return typeof command === "string" && command && strings(args) && strings(envKeys)
    ? { command, args, envKeys }
    : null;
}

// Whether an entry's env, as its CLI reports it, is still the one this
// installer registered: the recorded names, with the values this installer
// gives them wherever it knows them (the identity it registered before
// 1.8.0, and installEnv, the env it registers now). Two differences from the
// record are the installer's own doing and keep the entry its own: a Control
// identity variable gone, and a variable of installEnv there with exactly its
// value. Each rewrite is recorded at once, but a run killed in between would
// otherwise strand an entry it just moved off the identity. Any other
// difference, a variable added, removed or changed, is the user's, and such
// an entry is never rewritten on its own. A Control identity this installer
// holds no value for is not its own; an env not reported proves nothing.
function ownEnv(env, { envKeys, ownValues, installEnv }) {
  if (!env) return false;
  const recorded = new Set(envKeys);
  if (envKeys.some((name) => !Object.hasOwn(env, name) && !CONTROL_IDENTITY_ENV.includes(name))) return false;
  return Object.keys(env).every((name) => {
    if (!recorded.has(name) && !Object.hasOwn(installEnv, name)) return false;
    if (Object.hasOwn(ownValues, name)) return env[name] === ownValues[name];
    return !CONTROL_IDENTITY_ENV.includes(name);
  });
}

// Whether two launches are the same command and args, compared as normalized
// paths where they are absolute.
function sameLaunch(left, right) {
  return normalizedPath(left.command) === normalizedPath(right.command)
    && left.args.length === right.args.length
    && left.args.every((arg, index) => normalizedPath(arg) === normalizedPath(right.args[index]));
}

function normalizedPath(value) {
  return isAbsolute(value) ? normalize(value) : value;
}

// Whether a directory is the root of a Gateway install, by its package.json
// name; null when that cannot be read for a reason other than its absence.
async function isGatewayPackage(root) {
  let text;
  try {
    text = await readFile(join(root, "package.json"), "utf8");
  } catch (error) {
    return MISSING_PATH_CODES.has(error?.code) ? false : null;
  }
  return GATEWAY_PACKAGE_NAMES.has(parseJson(text)?.name);
}

// Whether a launch has the shape this installer registers: a node executable
// running exactly one normalized absolute path to a gateway's src/index.js
// (Control) or src/guide.js (Guide).
function installerWrote({ command, args: [script] }, { launch }) {
  const node = command === launch.command || (isAbsolute(command) && NODE_EXECUTABLES.has(basename(command)));
  return node
    && isAbsolute(script)
    && normalize(script) === script
    && basename(script) === basename(launch.args[0])
    && basename(dirname(script)) === "src";
}

// Why an installer-shaped script path no longer resolves. A fixed path that
// is simply gone (a deleted checkout, a removed node version) is stale:
// "repoint". A symlink on the way is a pointer whatever manages it will fix:
// "keep-broken-link" when it dangles, "keep-link-missing" when it leads
// somewhere without the script.
async function missingScriptDecision(script) {
  const { root } = parse(script);
  let path = root;
  let linked = false;
  for (const part of script.slice(root.length).split(sep)) {
    path = join(path, part);
    try {
      if (!(await lstat(path)).isSymbolicLink()) continue;
    } catch (error) {
      if (!MISSING_PATH_CODES.has(error?.code)) return "unknown";
      return linked ? "keep-link-missing" : "repoint";
    }
    try {
      await stat(path);
    } catch (error) {
      return MISSING_PATH_CODES.has(error?.code) || error?.code === "ELOOP" ? "keep-broken-link" : "unknown";
    }
    linked = true;
  }
  // Every component is there: the script appeared after realpath looked.
  return "unknown";
}

// The GATEWAY_VERSION of the install a script belongs to, read as text: the
// file is someone else's code, not something to import.
async function gatewayVersionAt(directory) {
  try {
    const source = await readFile(join(directory, "version.js"), "utf8");
    return /\bGATEWAY_VERSION\s*=\s*["']([^"']+)["']/.exec(source)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function samePath(left, right) {
  if (left === right) return true;
  try {
    return await realpath(left) === await realpath(right);
  } catch {
    return false;
  }
}

function stableNodeCommand() {
  if (process.env.ACP_GATEWAY_NODE) return process.env.ACP_GATEWAY_NODE;
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "node");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH for a stable launcher path.
    }
  }
  return process.execPath;
}

function createIdentity() {
  return {
    token: randomBytes(32).toString("base64url"),
    rootId: `main-${randomBytes(8).toString("hex")}`,
    createdAt: new Date().toISOString()
  };
}

async function readInstallState(path) {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    if (state?.version !== 1 || typeof state.managedMcp !== "object") throw new Error("unsupported install state format");
    if (state.identity && (typeof state.identity.token !== "string" || state.identity.token.length < 24)) {
      throw new Error("invalid stored Control identity");
    }
    if (state.agentUpdates && (
      typeof state.agentUpdates !== "object"
      || typeof state.agentUpdates.autoUpdate !== "boolean"
      || typeof state.agentUpdates.notifications !== "boolean"
    )) throw new Error("invalid stored agent update policy");
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot read installer state ${path}: ${error.message}`);
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

// Every write of install.json goes through here: the first identity, each
// entry recorded as it is rewritten, a rotation and the end of a run. The file
// it replaces is emptied once the rename succeeded when a hard link still holds
// it (replaceFile), so a link a Worker made keeps no Control token, the retired
// one included.
async function writeInstallState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  replaceFile(temporary, path);
  await chmod(path, 0o600);
}

function preflight({ nodeVersion, platform }) {
  const major = Number(String(nodeVersion).split(".")[0]);
  if (!Number.isInteger(major) || major < 22) throw new Error(`Node.js 22 or newer is required; found ${nodeVersion}`);
  if (platform === "win32") throw new Error("The local Unix-socket Gateway installer currently supports macOS and Linux only");
}

async function requireSuccess(run, command, args, operation, redaction) {
  const result = await run(command, args);
  if (result.code !== 0) throw commandError(command, args, result, operation, redaction);
  return result;
}

function commandError(command, args, result, operation, redaction) {
  const detail = redactEnv(String(result.stderr || result.stdout || "unknown error").trim(), redaction?.env);
  return new Error(`${operation} failed (${command} ${(redaction?.shown ?? redactArgs(args)).join(" ")}): ${detail}`);
}

function redactArgs(args) {
  return args.map((arg) => redactText(arg));
}

// Control token values out of text: the KEY=value, KEY: value and JSON
// "KEY": "value" forms, for the token and any other named key, and any known
// secret value wherever it appears.
function redactText(text, secrets = [], keys = []) {
  let redacted = String(text);
  for (const key of new Set(["ACP_GATEWAY_CONTROL_TOKEN", ...keys])) {
    const name = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(new RegExp(`(${name}"?\\s*[=:]\\s*"?)[^\\s"',}]+`, "g"), "$1<redacted>");
  }
  // Longest first, so a secret that contains another is hidden whole.
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join("<redacted>");
  }
  return redacted;
}

// Text a CLI printed while it was handed a captured env, with every value of
// that env out of it: by key in the forms redactText knows, and as a bare
// value wherever it is long enough to be told from ordinary words.
function redactEnv(text, env = {}) {
  const values = Object.values(env).filter((value) => value.length >= MIN_ECHOED_SECRET_LENGTH);
  return redactText(text, values, Object.keys(env));
}

// An env with every value replaced, for printing the command that passes it.
function hiddenEnv(env) {
  return Object.fromEntries(Object.keys(env).map((name) => [name, "<redacted>"]));
}

// Every command the installer runs gets a deadline and a bounded capture. Both
// are generous on purpose: `npm install --global` or `uv tool install` over a
// slow network legitimately takes minutes, and an `npm list --json` is parsed
// whole. What they stop is a command that never ends, or never stops printing,
// which in the daemon held an automatic update, and with it every shutdown,
// forever.
const COMMAND_TIMEOUT_MS = 10 * 60_000;
// Per stream. Past it the first and last halves are kept around a marker.
const COMMAND_OUTPUT_BYTES = 1024 * 1024;
// SIGTERM first, so npm can stop the lifecycle scripts it runs; SIGKILL if the
// command is still there after this.
const COMMAND_KILL_GRACE_MS = 2_000;

// Agent CLIs, and npm and uv installing adapters (their packages' lifecycle
// scripts run too): none of them gets the Control token, the socket or a
// session marker, whether the installer runs from a shell or in the daemon.
// A command still running past timeoutMs, or when its signal aborts, is killed
// and rejects with code COMMAND_TIMEOUT or COMMAND_ABORTED. One that has already
// exited on its own by then resolves with its own status and output, even while
// a grandchild still holds its pipes. The child stays in the installer's
// process group, so Ctrl-C at a terminal still reaches it.
export function runCommand(command, args, {
  timeoutMs = COMMAND_TIMEOUT_MS,
  maxOutputBytes = COMMAND_OUTPUT_BYTES,
  signal = null
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(commandStopped(command, "COMMAND_ABORTED", `was not started: ${stopReason(signal)}`));
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
    const stdout = boundedOutput(maxOutputBytes);
    const stderr = boundedOutput(maxOutputBytes);
    // Decoded as a stream, so a character split across two reads stays whole.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    // stopped: the error for a command this call killed while it still ran.
    // exitStatus: how the command exited, killed or on its own.
    let stopped = null;
    let exitStatus = null;
    let settled = false;
    let killTimer = null;
    const settle = () => {
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (code) => {
      settle();
      const truncated = stdout.omittedBytes > 0 || stderr.omittedBytes > 0;
      resolve({ code: code ?? 1, stdout: stdout.text(), stderr: stderr.text(), ...(truncated ? { outputTruncated: true } : {}) });
    };
    // Once the command has exited, waiting for "close" as well would wait on any
    // grandchild still holding its pipes, such as a lifecycle script npm
    // started, which is the very hang the deadline is for. Whatever ends the
    // wait after the exit drops the pipes and settles at once.
    const dropPipes = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finishStopped = () => {
      settle();
      dropPipes();
      reject(stopped);
    };
    const stop = (error) => {
      if (stopped || settled) return;
      if (exitStatus) {
        // It finished on its own and only its pipes are still open (a
        // grandchild holds them, or "close" is a turn away): there is nothing
        // left to stop, and the status it exited with stands.
        dropPipes();
        finish(exitStatus.code);
        return;
      }
      stopped = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), COMMAND_KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => stop(commandStopped(
          command, "COMMAND_TIMEOUT", `did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`
        )), timeoutMs)
      : null;
    deadline?.unref?.();
    const onAbort = () => stop(commandStopped(command, "COMMAND_ABORTED", `was stopped: ${stopReason(signal)}`));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("exit", (code, exitSignal) => {
      exitStatus = { code, signal: exitSignal };
      // stopped is only ever set while the command still ran, so a command
      // this call killed is reported as stopped, whatever status it exited with.
      if (stopped) finishStopped();
    });
    child.once("close", (code) => {
      if (!settled) finish(code);
    });
  });
}

// The message names the command, never its args or what it printed: this
// error also travels paths that do not redact (requireSuccess).
function commandStopped(command, code, what) {
  const error = new Error(`${command} ${what}`);
  error.code = code;
  return error;
}

function stopReason(signal) {
  const reason = signal?.reason;
  return reason?.message ?? (reason == null ? "aborted" : String(reason));
}

// The head and the tail of what a command printed: the head says what it was
// doing, the tail why it stopped. What fell in between is counted and marked,
// never silently dropped.
function boundedOutput(maxBytes) {
  const headLimit = Math.floor(maxBytes / 2);
  const tail = new BoundedUtf8Text(maxBytes - headLimit);
  let head = "";
  let headBytes = 0;
  let headOpen = headLimit > 0;
  return {
    append(text) {
      if (headOpen) {
        const taken = utf8ByteHead(text, headLimit - headBytes);
        head += taken;
        headBytes += Buffer.byteLength(taken);
        if (taken.length === text.length) return;
        headOpen = false;
        text = text.slice(taken.length);
      }
      tail.append(text);
    },
    get omittedBytes() {
      return tail.trimmedBytes;
    },
    text() {
      const omitted = tail.trimmedBytes;
      return omitted > 0
        ? `${head}\n[... ${omitted} bytes of output omitted ...]\n${tail.toString()}`
        : head + tail.toString();
    }
  };
}

async function restartGatewayDaemon({ identity, makeRpc, socketPath }) {
  if (!identity) throw new Error("Cannot restart Gateway without a stored Control identity");
  const rpc = makeRpc({ token: identity.token, rootId: identity.rootId, autoStart: false });
  let wasRunning = true;
  let graceful = true;
  try {
    await rpc.call("daemon_shutdown", {}, 5_000);
    await waitForDaemonExit(socketPath);
  } catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes(error?.code)) {
      wasRunning = false;
    } else if (/Unknown gateway method: daemon_shutdown/.test(error?.message ?? "")) {
      const pid = Number((await readFile(`${socketPath}.lock`, "utf8")).trim());
      if (!Number.isInteger(pid) || pid <= 1) throw new Error("Gateway daemon lock contains an invalid pid");
      process.kill(pid, "SIGTERM");
      await waitForDaemonExit(socketPath);
      graceful = false;
    } else {
      throw error;
    }
  } finally {
    rpc.close();
  }

  const starter = makeRpc({ token: identity.token, rootId: identity.rootId, autoStart: true });
  try {
    const setup = await starter.call("setup", {}, 10_000);
    if (setup?.ok !== true || setup?.gatewayVersion !== GATEWAY_VERSION) {
      throw new Error(`Updated Gateway version mismatch: expected ${GATEWAY_VERSION}, received ${setup?.gatewayVersion ?? "unknown"}`);
    }
    return { performed: true, wasRunning, graceful, version: setup.gatewayVersion };
  } finally {
    starter.close();
  }
}

async function gatewaySetup(makeRpc, identity) {
  const rpc = makeRpc({ token: identity.token, rootId: identity.rootId });
  try {
    return await rpc.call("setup", {}, 10_000);
  } finally {
    rpc.close();
  }
}

async function waitForDaemonExit(socketPath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await pathExists(socketPath)) && !(await pathExists(`${socketPath}.lock`))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Gateway daemon did not stop within 5 seconds");
}
