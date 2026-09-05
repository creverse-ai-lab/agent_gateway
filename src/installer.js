import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { access, chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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
import { GatewayRpcClient } from "./socket-rpc.js";
import { gatewaySocketPath } from "./config.js";
import { GatewaySettings, settingsPaths } from "./settings.js";
import { GATEWAY_VERSION } from "./version.js";

const CONTROL_NAME = "agent-acp";
const GUIDE_NAME = "agent-acp-guide";
const DELEGATOR_SKILL_NAME = "agent-delegator";
const MCP_TARGETS = ["codex", "claude", "grok", "auggie"];
const FRONT_DOOR_TARGETS = new Set(["codex", "claude", "grok"]);
const SUPPORTED_TARGETS = new Set(MCP_TARGETS);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const bundledSkillSource = join(dirname(sourceDirectory), "skills", DELEGATOR_SKILL_NAME);

export function defaultInstallStatePath() {
  return process.env.ACP_GATEWAY_INSTALL_STATE || join(homedir(), ".acp-gateway", "install.json");
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
  const controlTargets = options.installControl
    ? (options.targets.length
        ? requestedTargets
        : options.installAll
          ? [options.frontDoor ?? "codex"]
          : options.update && managedControlTargets.length
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
    if (!identity || options.rotateToken) identity = createIdentity();
    state.identity = identity;
    state.managedMcp ??= {};
    state.updatedAt = new Date().toISOString();
    if (!options.dryRun) await writeInstallState(statePath, state);
  }

  const installedSkillDestinations = new Map();
  for (const target of new Set([...controlTargets, ...guideTargets, ...skillTargets])) {
    const provider = providers.find((item) => item.id === target);
    const providerInstalled = provider?.agentInstalled || registry.configured.includes(target);
    const needsMcp = controlTargets.includes(target) || guideTargets.includes(target);
    if (needsMcp && !providerInstalled) {
      warnings.push(`${target} is not installed; MCP registration skipped`);
    } else if (controlTargets.includes(target)) {
      const spec = mcpSpec(target, "control", identity);
      await installMcp(spec, { options, state, run, actions });
    }
    if (guideTargets.includes(target) && providerInstalled) {
      const spec = mcpSpec(target, "guide", identity);
      await installMcp(spec, { options, state, run, actions });
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
    "  --update               Pull source, preview, update adapters/MCPs, and restart",
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
    "  --rotate-token         Rotate credentials and update Control MCP entries",
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

async function installMcp(spec, { options, state, run, actions }) {
  const key = `${spec.agent}:${spec.name}`;
  actions.push({ type: "mcp", agent: spec.agent, name: spec.name, command: spec.command, args: redactArgs(spec.args) });
  if (options.dryRun) return;

  const existing = await run(spec.command, spec.getArgs);
  const exists = inspectMcpExists(spec, existing);
  if (!exists && spec.inspectMode !== "list-json" && !/no mcp server|not found|does not exist/i.test(`${existing.stdout}\n${existing.stderr}`)) {
    throw commandError(spec.command, spec.getArgs, existing, `inspect ${key}`);
  }
  if (exists && !state?.managedMcp?.[key] && !options.force) {
    throw new Error(`${key} already exists and is not managed by this installer; rerun with --force to replace it`);
  }
  if (exists && state?.managedMcp?.[key] && !options.force && !options.rotateToken) {
    actions.at(-1).status = "unchanged";
    return;
  }
  if (exists) await requireSuccess(run, spec.command, spec.removeArgs, `remove existing ${key}`);
  await requireSuccess(run, spec.command, spec.args, `install ${key}`);
  state.managedMcp ??= {};
  state.managedMcp[key] = { agent: spec.agent, name: spec.name, kind: spec.kind, installedAt: new Date().toISOString() };
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

function mcpSpec(agent, kind, identity) {
  const isControl = kind === "control";
  const name = isControl ? CONTROL_NAME : GUIDE_NAME;
  const script = join(sourceDirectory, isControl ? "index.js" : "guide.js");
  const serverCommand = stableNodeCommand();
  const serverArgs = [script];
  if (agent === "codex") {
    const envArgs = isControl
      ? ["--env", `ACP_GATEWAY_CONTROL_TOKEN=${identity.token}`, "--env", `ACP_GATEWAY_ROOT_ID=${identity.rootId}`]
      : [];
    return {
      agent, kind, name, command: "codex",
      getArgs: ["mcp", "get", name, "--json"],
      removeArgs: ["mcp", "remove", name],
      args: ["mcp", "add", ...envArgs, name, "--", serverCommand, ...serverArgs]
    };
  }
  if (agent === "grok") {
    const envArgs = isControl
      ? ["--env", `ACP_GATEWAY_CONTROL_TOKEN=${identity.token}`, "--env", `ACP_GATEWAY_ROOT_ID=${identity.rootId}`]
      : [];
    return {
      agent, kind, name, command: "grok", inspectMode: "list-json",
      getArgs: ["mcp", "list", "--json"],
      removeArgs: ["mcp", "remove", name],
      args: ["mcp", "add", "--scope", "user", ...envArgs, name, "--", serverCommand, ...serverArgs]
    };
  }
  if (agent === "auggie") {
    const env = isControl
      ? { ACP_GATEWAY_CONTROL_TOKEN: identity.token, ACP_GATEWAY_ROOT_ID: identity.rootId }
      : {};
    const config = { type: "stdio", command: serverCommand, args: serverArgs, env };
    return {
      agent, kind, name, command: "auggie", inspectMode: "list-json",
      getArgs: ["mcp", "list", "--json"],
      removeArgs: ["mcp", "remove", name],
      args: ["mcp", "add-json", name, JSON.stringify(config), "--replace"]
    };
  }
  if (agent !== "claude") throw new Error(`MCP registration is not supported for ${agent}`);
  const envArgs = isControl
    ? ["-e", `ACP_GATEWAY_CONTROL_TOKEN=${identity.token}`, "-e", `ACP_GATEWAY_ROOT_ID=${identity.rootId}`]
    : [];
  return {
    agent, kind, name, command: "claude",
    getArgs: ["mcp", "get", name],
    removeArgs: ["mcp", "remove", "--scope", "user", name],
    args: ["mcp", "add", "--scope", "user", name, ...envArgs, "--", serverCommand, ...serverArgs]
  };
}

function inspectMcpExists(spec, result) {
  if (spec.inspectMode !== "list-json") return result.code === 0;
  if (result.code !== 0) throw commandError(spec.command, spec.getArgs, result, `inspect ${spec.agent}:${spec.name}`);
  try {
    const parsed = JSON.parse(result.stdout);
    const servers = Array.isArray(parsed) ? parsed : parsed?.servers;
    if (!Array.isArray(servers)) throw new Error("server list is missing");
    return servers.some((item) => item?.name === spec.name);
  } catch (error) {
    throw new Error(`inspect ${spec.agent}:${spec.name} returned invalid JSON: ${error.message}`);
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

async function writeInstallState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function preflight({ nodeVersion, platform }) {
  const major = Number(String(nodeVersion).split(".")[0]);
  if (!Number.isInteger(major) || major < 22) throw new Error(`Node.js 22 or newer is required; found ${nodeVersion}`);
  if (platform === "win32") throw new Error("The local Unix-socket Gateway installer currently supports macOS and Linux only");
}

async function requireSuccess(run, command, args, operation) {
  const result = await run(command, args);
  if (result.code !== 0) throw commandError(command, args, result, operation);
  return result;
}

function commandError(command, args, result, operation) {
  const detail = String(result.stderr || result.stdout || "unknown error").trim();
  return new Error(`${operation} failed (${command} ${redactArgs(args).join(" ")}): ${detail}`);
}

function redactArgs(args) {
  return args.map((arg) => String(arg)
    .replace(/^(ACP_GATEWAY_CONTROL_TOKEN=).+$/, "$1<redacted>")
    .replace(/("ACP_GATEWAY_CONTROL_TOKEN"\s*:\s*")[^"]+("\s*[,}])/g, "$1<redacted>$2"));
}

export function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
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
