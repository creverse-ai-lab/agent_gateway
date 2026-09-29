import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseInstallerArgs, runInstaller } from "../src/installer.js";
import { GATEWAY_VERSION } from "../src/version.js";

const runtime = { nodeVersion: "22.0.0", platform: "darwin" };
const providers = [
  { id: "codex", agentInstalled: true, adapterInstalled: true, install: null },
  { id: "claude", agentInstalled: false, adapterInstalled: true, install: null }
];
const emptyRegistryLoader = async () => ({
  registry: { version: "1.0.0", agents: [] },
  source: "network",
  stale: false
});
// Dry runs now inspect existing entries, so every test that plans MCP entries
// answers the CLI here and points Claude's dry-run read at a temp file.
const nothingRegistered = (calls = []) => async (command, args) => {
  calls.push([command, ...args]);
  if (args[1] === "list") return { code: 0, stdout: command === "grok" ? "[]" : '{"servers":[]}', stderr: "" };
  if (args[1] === "get") return { code: 1, stdout: "", stderr: `No MCP server named '${args[2]}' found` };
  return { code: 0, stdout: "", stderr: "" };
};
const isMutation = (call) => call.includes("add") || call.includes("add-json") || call.includes("remove");
const NODE = "/opt/test/bin/node";
const gatewayScript = (name) => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

// Pins the node command the installer registers, so a fake inspect output can
// describe the entry this install would add.
async function withNode(run) {
  const saved = process.env.ACP_GATEWAY_NODE;
  process.env.ACP_GATEWAY_NODE = NODE;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.ACP_GATEWAY_NODE;
    else process.env.ACP_GATEWAY_NODE = saved;
  }
}

// A gateway install tree elsewhere on disk: src/ with its entry points and,
// unless version is null, the version.js the installer reads.
async function gatewayTree(root, relative, version) {
  const source = join(root, relative, "gateway", "src");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "index.js"), "", "utf8");
  await writeFile(join(source, "guide.js"), "", "utf8");
  if (version !== null) await writeFile(join(source, "version.js"), `export const GATEWAY_VERSION = "${version}";\n`, "utf8");
  return source;
}

// Fake inspect answers for managed entries: codex answers `mcp get --json`
// per name, grok one `mcp list --json` for all of them.
function inspectAnswers(entries) {
  return (command, args) => {
    if (command === "codex" && args[1] === "get") {
      const entry = entries.codex?.[args[2]];
      if (!entry) return { code: 1, stdout: "", stderr: `No MCP server named '${args[2]}' found` };
      return {
        code: 0,
        stdout: JSON.stringify({
          name: args[2],
          enabled: true,
          transport: { type: "stdio", ...entry, env: { ACP_GATEWAY_CONTROL_TOKEN: "old-secret-token" } }
        }),
        stderr: ""
      };
    }
    if (command === "grok" && args[1] === "list") {
      const listed = Object.entries(entries.grok ?? {}).map(([name, entry]) => ({ name, scope: "user", ...entry, enabled: true }));
      return { code: 0, stdout: JSON.stringify(listed), stderr: "" };
    }
    return null;
  };
}

function updateDependencies(statePath, directory, answer, calls) {
  return {
    statePath,
    runtime,
    skillRoots: { default: join(directory, "shared-skills") },
    detectProviders: async () => [
      { id: "codex", agentInstalled: true, adapterInstalled: true, install: null },
      { id: "grok", agentInstalled: true, adapterInstalled: true, install: null }
    ],
    registryLoader: emptyRegistryLoader,
    registryDiscover: async () => [],
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      const answered = answer(command, args);
      if (answered) return answered;
      if (args.includes("--json")) return { code: 0, stdout: "{\"dependencies\":{}}", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    restartGateway: async () => ({ performed: true, wasRunning: true, graceful: true, version: GATEWAY_VERSION }),
    rpcFactory: () => ({ async call() { return { ok: true, gatewayVersion: GATEWAY_VERSION }; }, close() {} })
  };
}

const statusOf = (result) => Object.fromEntries(result.actions
  .filter((action) => action.type === "mcp")
  .map((action) => [`${action.agent}:${action.name}`, action.status]));

async function writeManagedState(statePath, entries) {
  await writeFile(statePath, JSON.stringify({
    version: 1,
    identity: { token: "test-control-token-at-least-24-characters", rootId: "main-test" },
    managedMcp: Object.fromEntries(entries.map(([agent, name, kind]) => [`${agent}:${name}`, { agent, name, kind }])),
    managedSkills: {},
    agentUpdates: { autoUpdate: true, notifications: true }
  }), "utf8");
}

function claudeGetOutput(name, command, args) {
  return [
    `${name}:`,
    "  Scope: User config (available in all your projects)",
    "  Status: \u2713 Connected",
    "  Type: stdio",
    `  Command: ${command}`,
    `  Args: ${args.join(" ")}`,
    "  Environment:",
    "    ACP_GATEWAY_CONTROL_TOKEN=old-secret-token",
    "",
    `To remove this server, run: claude mcp remove "${name}" -s user`,
    ""
  ].join("\n");
}

test("installer parses a complete targeted installation", () => {
  const options = parseInstallerArgs(["--install-all", "--target", "codex", "--skip-health-check"]);
  assert.equal(options.installAdapters, true);
  assert.equal(options.installAll, true);
  assert.equal(options.installControl, true);
  assert.equal(options.installGuide, true);
  assert.equal(options.installSkill, true);
  assert.deepEqual(options.targets, ["codex"]);
  assert.equal(options.healthCheck, false);
  assert.throws(() => parseInstallerArgs(["--target", "unknown"]), /Unsupported installer target/);
});

test("installer update preserves user-customized skills while refreshing runtime components", () => {
  const options = parseInstallerArgs(["--update"]);
  assert.equal(options.update, true);
  assert.equal(options.refreshRegistry, true);
  assert.equal(options.installAdapters, true);
  assert.equal(options.installControl, true);
  assert.equal(options.installGuide, true);
  assert.equal(options.installSkill, false);
  assert.equal(options.discoverAgents, true);
  assert.equal(options.restartDaemon, true);
});

test("installer parses standalone managed skill updates", () => {
  const options = parseInstallerArgs(["--update-skill", "--target", "codex", "--dry-run"]);
  assert.equal(options.installSkill, true);
  assert.equal(options.updateSkill, true);
  assert.equal(options.discoverAgents, false);
  assert.equal(options.installAdapters, false);
  assert.equal(options.restartDaemon, false);
  assert.throws(
    () => parseInstallerArgs(["--install-skill", "--update-skill"]),
    /cannot be combined/
  );
  assert.throws(
    () => parseInstallerArgs(["--install-all", "--update-skill"]),
    /cannot be combined/
  );
});

test("installer update preserves the previously installed front door", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-update-front-door-"));
  const statePath = join(directory, "install.json");
  const allProviders = providers.map((provider) => ({ ...provider, agentInstalled: true }));
  try {
    await writeFile(statePath, JSON.stringify({
      version: 1,
      identity: { token: "test-control-token-at-least-24-characters", rootId: "main-test" },
      managedMcp: {
        "claude:agent-acp": { agent: "claude", name: "agent-acp", kind: "control" },
        "codex:agent-acp-guide": { agent: "codex", name: "agent-acp-guide", kind: "guide" }
      },
      managedSkills: {},
      agentUpdates: { autoUpdate: true, notifications: true }
    }), "utf8");
    const result = await runInstaller(parseInstallerArgs(["--update", "--dry-run"]), {
      statePath,
      runtime,
      runCommand: nothingRegistered(),
      claudeConfigPath: join(directory, ".claude.json"),
      detectProviders: async () => allProviders,
      registryLoader: emptyRegistryLoader
    });
    assert.deepEqual(result.targets.control, ["claude"]);
    assert.deepEqual(result.targets.guide, ["codex", "claude"]);
    assert.deepEqual(result.targets.skill, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer parses persistent ACP update policy controls", () => {
  const options = parseInstallerArgs([
    "--agent-auto-update", "off",
    "--agent-update-notifications", "on",
    "--dry-run"
  ]);
  assert.equal(options.agentAutoUpdate, false);
  assert.equal(options.agentUpdateNotifications, true);
  assert.equal(options.restartDaemon, true);
  assert.throws(() => parseInstallerArgs(["--agent-auto-update", "sometimes"]), /requires on or off/);
});

test("installer persists and reuses its Control identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-identity-"));
  const statePath = join(directory, "install.json");
  const calls = [];
  let installed = false;
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("get")) {
      return installed
        ? { code: 0, stdout: "existing", stderr: "" }
        : { code: 1, stdout: "", stderr: "No MCP server named test found" };
    }
    if (args.includes("add")) installed = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  const options = parseInstallerArgs(["--install-control", "--target", "codex", "--skip-health-check"]);
  try {
    const first = await runInstaller(options, { statePath, runtime, runCommand, detectProviders: async () => providers });
    const firstState = JSON.parse(await readFile(statePath, "utf8"));
    const second = await runInstaller(options, { statePath, runtime, runCommand, detectProviders: async () => providers });
    const secondState = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(firstState.identity.token, secondState.identity.token);
    assert.equal(firstState.identity.rootId, secondState.identity.rootId);
    assert.equal(first.identity.token, undefined);
    assert.equal(second.health.checked, false);
    assert.ok(calls.some((call) => call.includes("ACP_GATEWAY_CONTROL_TOKEN=" + firstState.identity.token)));
    assert.equal(calls.filter((call) => call.includes("add")).length, 1);
    assert.equal(second.actions[0].status, "unchanged");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer refuses to replace an unmanaged MCP entry without force", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-collision-"));
  const statePath = join(directory, "install.json");
  const runCommand = async (_command, args) => args.includes("get")
    ? { code: 0, stdout: "existing", stderr: "" }
    : { code: 0, stdout: "", stderr: "" };
  const options = parseInstallerArgs(["--install-control", "--target", "codex", "--skip-health-check"]);
  try {
    await assert.rejects(
      runInstaller(options, { statePath, runtime, runCommand, detectProviders: async () => providers }),
      /not managed by this installer/
    );
    await assert.rejects(
      runInstaller({ ...options, dryRun: true }, { statePath, runtime, runCommand, detectProviders: async () => providers }),
      /not managed by this installer/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer dry-run only inspects and does not create state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-dry-run-"));
  const statePath = join(directory, "install.json");
  const calls = [];
  const options = parseInstallerArgs(["--install-all", "--target", "codex", "--dry-run"]);
  try {
    const result = await runInstaller(options, {
      statePath,
      runtime,
      runCommand: nothingRegistered(calls),
      detectProviders: async () => providers,
      registryLoader: emptyRegistryLoader,
      skillRoots: { codex: join(directory, "codex-skills") }
    });
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.targets, { control: ["codex"], guide: ["codex"], skill: ["codex"] });
    assert.deepEqual(calls, [
      ["codex", "mcp", "get", "agent-acp", "--json"],
      ["codex", "mcp", "get", "agent-acp-guide", "--json"]
    ]);
    assert.deepEqual(
      result.actions.filter((action) => action.type === "mcp").map((action) => action.status),
      ["would-install", "would-install"]
    );
    await assert.rejects(access(statePath), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("install-all uses one selected front door while Guide reaches every agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-main-boundary-"));
  const statePath = join(directory, "install.json");
  const allProviders = [
    ...providers.map((provider) => ({ ...provider, agentInstalled: true })),
    { id: "grok", agentInstalled: true, adapterInstalled: true, install: null }
  ];
  try {
    const result = await runInstaller(parseInstallerArgs(["--install-all", "--front-door", "claude", "--dry-run"]), {
      statePath,
      runtime,
      runCommand: nothingRegistered(),
      claudeConfigPath: join(directory, ".claude.json"),
      detectProviders: async () => allProviders,
      registryLoader: emptyRegistryLoader,
      skillRoots: {
        codex: join(directory, "codex-skills"),
        claude: join(directory, "claude-skills"),
        grok: join(directory, "grok-skills")
      }
    });
    assert.deepEqual(result.targets, {
      control: ["claude"],
      guide: ["codex", "claude", "grok"],
      skill: ["codex", "claude", "grok"]
    });
    assert.equal(result.actions.filter((action) => action.name === "agent-acp").length, 1);
    assert.equal(result.actions.filter((action) => action.name === "agent-acp-guide").length, 3);
    assert.equal(result.actions.filter((action) => action.type === "skill").length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("install-all front door validation is explicit", () => {
  assert.equal(parseInstallerArgs(["--install-all", "--front-door", "grok"]).frontDoor, "grok");
  assert.throws(() => parseInstallerArgs(["--install-all", "--front-door", "auggie"]), /requires codex, claude, or grok/);
  assert.throws(() => parseInstallerArgs(["--front-door", "claude"]), /only be used with --install-all/);
  assert.throws(
    () => parseInstallerArgs(["--install-all", "--front-door", "claude", "--target", "codex"]),
    /cannot be combined/
  );
});

test("installer keeps reinstall separate from managed skill updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-skill-"));
  const statePath = join(directory, "install.json");
  const skillSource = join(directory, "source-skill");
  const codexSkillRoot = join(directory, "codex-skills");
  const skillDirectory = join(codexSkillRoot, "agent-delegator");
  const destination = join(skillDirectory, "SKILL.md");
  const options = parseInstallerArgs(["--install-skill", "--target", "codex"]);
  try {
    await mkdir(skillSource);
    await writeFile(join(skillSource, "SKILL.md"), "version-one\n", "utf8");
    const dependencies = {
      statePath,
      skillSource,
      skillRoots: { codex: codexSkillRoot },
      runtime,
      detectProviders: async () => providers
    };
    await runInstaller(options, dependencies);
    assert.equal(await readFile(destination, "utf8"), "version-one\n");
    const unchanged = await runInstaller(parseInstallerArgs(["--update-skill", "--target", "codex"]), dependencies);
    assert.equal(unchanged.actions.find((action) => action.type === "skill").status, "up-to-date");
    await writeFile(join(skillSource, "SKILL.md"), "version-two\n", "utf8");
    const reinstall = await runInstaller(options, dependencies);
    assert.equal(await readFile(destination, "utf8"), "version-one\n");
    assert.equal(reinstall.actions.find((action) => action.type === "skill").status, "already-installed");
    assert.match(reinstall.warnings.join("\n"), /--update-skill/);

    const updated = await runInstaller(parseInstallerArgs(["--update-skill", "--target", "codex"]), dependencies);
    assert.equal(await readFile(destination, "utf8"), "version-two\n");
    assert.equal(updated.actions.find((action) => action.type === "skill").status, "updated");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.managedSkills["codex:agent-delegator"].path, skillDirectory);
    assert.match(state.managedSkills["codex:agent-delegator"].sourceDigest, /^[a-f0-9]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed skill updates preserve local customization unless forced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-skill-custom-"));
  const statePath = join(directory, "install.json");
  const skillSource = join(directory, "source-skill");
  const codexSkillRoot = join(directory, "codex-skills");
  const destination = join(codexSkillRoot, "agent-delegator", "SKILL.md");
  try {
    await mkdir(skillSource);
    await writeFile(join(skillSource, "SKILL.md"), "version-one\n", "utf8");
    const dependencies = {
      statePath,
      skillSource,
      skillRoots: { codex: codexSkillRoot },
      runtime,
      detectProviders: async () => providers
    };
    await runInstaller(parseInstallerArgs(["--install-skill", "--target", "codex"]), dependencies);
    await writeFile(destination, "local-customization\n", "utf8");
    await writeFile(join(skillSource, "SKILL.md"), "version-two\n", "utf8");

    const preserved = await runInstaller(parseInstallerArgs(["--update-skill"]), dependencies);
    assert.equal(await readFile(destination, "utf8"), "local-customization\n");
    assert.equal(preserved.actions.find((action) => action.type === "skill").status, "customized");

    const forced = await runInstaller(parseInstallerArgs(["--update-skill", "--force"]), dependencies);
    assert.equal(await readFile(destination, "utf8"), "version-two\n");
    assert.equal(forced.actions.find((action) => action.type === "skill").status, "updated");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed skill updates require recorded state and protect legacy installs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-skill-legacy-"));
  const statePath = join(directory, "install.json");
  const skillSource = join(directory, "source-skill");
  const codexSkillRoot = join(directory, "codex-skills");
  const skillDirectory = join(codexSkillRoot, "agent-delegator");
  const destination = join(skillDirectory, "SKILL.md");
  const dependencies = {
    statePath,
    skillSource,
    skillRoots: { codex: codexSkillRoot },
    runtime,
    detectProviders: async () => providers
  };
  try {
    await mkdir(skillSource);
    await writeFile(join(skillSource, "SKILL.md"), "version-two\n", "utf8");
    await assert.rejects(
      runInstaller(parseInstallerArgs(["--update-skill"]), dependencies),
      /requires an installer-managed skill/
    );

    await mkdir(skillDirectory, { recursive: true });
    await writeFile(destination, "version-two\n", "utf8");
    await writeFile(statePath, JSON.stringify({
      version: 1,
      managedMcp: {},
      managedSkills: {
        "codex:agent-delegator": {
          agent: "codex",
          name: "agent-delegator",
          path: skillDirectory,
          installedAt: "2026-01-01T00:00:00.000Z"
        }
      },
      agentUpdates: { autoUpdate: true, notifications: true }
    }), "utf8");

    const protectedLegacy = await runInstaller(parseInstallerArgs(["--update-skill"]), dependencies);
    assert.equal(await readFile(destination, "utf8"), "version-two\n");
    assert.equal(protectedLegacy.actions.find((action) => action.type === "skill").status, "legacy-unverified");

    await writeFile(destination, "legacy-copy\n", "utf8");
    await runInstaller(parseInstallerArgs(["--update-skill", "--force"]), dependencies);
    assert.equal(await readFile(destination, "utf8"), "version-two\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer health check authenticates through the Gateway client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-health-"));
  const statePath = join(directory, "install.json");
  let rpcConfig;
  let rpcCall;
  const options = parseInstallerArgs(["--install-control", "--target", "codex"]);
  try {
    const result = await runInstaller(options, {
      statePath,
      runtime,
      skillRoots: { codex: join(directory, "codex-skills"), default: join(directory, "shared-skills") },
      detectProviders: async () => providers,
      runCommand: async (_command, args) => args.includes("get")
        ? { code: 1, stdout: "", stderr: "No MCP server named test found" }
        : { code: 0, stdout: "", stderr: "" },
      rpcFactory: (config) => {
        rpcConfig = config;
        return {
          async call(method, args) { rpcCall = { method, args }; return { ok: true, gatewayVersion: GATEWAY_VERSION }; },
          close() {}
        };
      }
    });
    assert.equal(result.health.ok, true);
    assert.equal(result.health.version, GATEWAY_VERSION);
    assert.ok(rpcConfig.token.length >= 24);
    assert.match(rpcConfig.rootId, /^main-/);
    assert.deepEqual(rpcCall, { method: "setup", args: {} });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("install-all replaces an older daemon when health reports a version mismatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-version-upgrade-"));
  const statePath = join(directory, "install.json");
  const setupVersions = ["0.2.0", GATEWAY_VERSION];
  let restartCalls = 0;
  try {
    const result = await runInstaller(
      parseInstallerArgs(["--install-all", "--target", "codex"]),
      {
        statePath,
        runtime,
        skillRoots: { codex: join(directory, "codex-skills"), default: join(directory, "shared-skills") },
        detectProviders: async () => providers,
        registryLoader: emptyRegistryLoader,
        registryDiscover: async () => [],
        runCommand: async (_command, args) => {
          if (args.includes("get")) return { code: 1, stdout: "", stderr: "not found" };
          if (args.includes("--json")) return { code: 0, stdout: "{\"dependencies\":{}}", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        },
        restartGateway: async () => {
          restartCalls += 1;
          return { performed: true, wasRunning: true, graceful: false, version: GATEWAY_VERSION };
        },
        rpcFactory: () => ({
          async call(method) {
            assert.equal(method, "setup");
            return { ok: true, gatewayVersion: setupVersions.shift() };
          },
          close() {}
        })
      }
    );
    assert.equal(restartCalls, 1);
    assert.equal(result.restart.automatic, true);
    assert.equal(result.restart.graceful, false);
    assert.equal(result.health.version, GATEWAY_VERSION);
    assert.equal(result.health.ok, true);
    assert.equal(setupVersions.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer update invokes daemon replacement before version health", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-update-"));
  const statePath = join(directory, "install.json");
  let restartCalls = 0;
  let healthCalls = 0;
  try {
    const result = await runInstaller(parseInstallerArgs(["--update", "--target", "codex"]), {
      statePath,
      runtime,
      skillRoots: { codex: join(directory, "codex-skills"), default: join(directory, "shared-skills") },
      detectProviders: async () => providers,
      registryLoader: emptyRegistryLoader,
      registryDiscover: async () => [],
      runCommand: async (_command, args) => {
        if (args.includes("get")) return { code: 1, stdout: "", stderr: "not found" };
        if (args.includes("--json")) return { code: 0, stdout: "{\"dependencies\":{}}", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      restartGateway: async () => {
        restartCalls += 1;
        return { performed: true, wasRunning: true, graceful: true, version: GATEWAY_VERSION };
      },
      rpcFactory: () => ({
        async call(method) {
          assert.equal(method, "setup");
          healthCalls += 1;
          return { ok: true, gatewayVersion: GATEWAY_VERSION };
        },
        close() {}
      })
    });
    assert.equal(restartCalls, 1);
    assert.equal(healthCalls, 1);
    assert.equal(result.restart.version, GATEWAY_VERSION);
    assert.equal(result.health.ok, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer downloads and registers an explicitly selected official ACP agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-registry-"));
  const statePath = join(directory, "install.json");
  const providerRegistryPath = join(directory, "providers.json");
  const calls = [];
  const officialRegistry = {
    version: "1.0.0",
    agents: [{
      id: "gemini",
      name: "Gemini CLI",
      version: "0.53.0",
      distribution: { npx: { package: "@google/gemini-cli@0.53.0", args: ["--acp"] } }
    }]
  };
  try {
    const result = await runInstaller(
      parseInstallerArgs(["--registry-agent", "gemini", "--skip-health-check"]),
      {
        statePath,
        providerRegistryPath,
        runtime: { ...runtime, arch: "arm64" },
        detectProviders: async () => providers,
        registryLoader: async () => ({ registry: officialRegistry, source: "network", stale: false }),
        registryDiscover: async () => [],
        runCommand: async (command, args) => {
          calls.push([command, ...args]);
          if (args.includes("--json")) return { code: 0, stdout: "{\"dependencies\":{}}", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        }
      }
    );
    assert.deepEqual(result.registry.configured, ["gemini"]);
    assert.ok(calls.some((call) => call.join(" ") === "npm install --global @google/gemini-cli@0.53.0"));
    const saved = JSON.parse(await readFile(providerRegistryPath, "utf8"));
    assert.deepEqual(saved.providers.gemini.args, ["--yes", "@google/gemini-cli@0.53.0", "--acp"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer plans the delegation skill for every discovered agent and deduplicates shared roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-all-skills-"));
  const statePath = join(directory, "install.json");
  const sharedRoot = join(directory, "shared-skills");
  const discovered = [
    {
      id: "auggie",
      registryId: "auggie",
      name: "Auggie",
      version: "1.0.0",
      distribution: { type: "npx", package: "auggie@1.0.0", args: ["--acp"], env: {} },
      foundCommand: "auggie",
      packageInstalled: true
    },
    {
      id: "other-agent",
      registryId: "other-agent",
      name: "Other Agent",
      version: "1.0.0",
      distribution: { type: "npx", package: "other-agent@1.0.0", args: [], env: {} },
      foundCommand: "other-agent",
      packageInstalled: true
    },
    {
      id: "second-agent",
      registryId: "second-agent",
      name: "Second Agent",
      version: "1.0.0",
      distribution: { type: "npx", package: "second-agent@1.0.0", args: [], env: {} },
      foundCommand: "second-agent",
      packageInstalled: true
    }
  ];
  try {
    const result = await runInstaller(parseInstallerArgs(["--install-skill", "--target", "all", "--dry-run"]), {
      statePath,
      runtime,
      detectProviders: async () => providers,
      registryLoader: async () => ({ registry: { version: "1.0.0", agents: [] }, source: "network", stale: false }),
      registryDiscover: async () => discovered,
      skillRoots: {
        codex: join(directory, "codex-skills"),
        auggie: join(directory, "augment-skills"),
        default: sharedRoot
      }
    });
    assert.deepEqual(result.targets.skill, ["auggie", "other-agent", "second-agent", "codex"]);
    const skills = result.actions.filter((action) => action.type === "skill");
    assert.equal(skills.length, 4);
    assert.equal(skills.find((item) => item.agent === "auggie").destination, join(directory, "augment-skills", "agent-delegator"));
    assert.equal(skills.find((item) => item.agent === "second-agent").status, "shared");
    assert.equal(skills.find((item) => item.agent === "second-agent").sharedWith, "other-agent");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer registers Control and Guide MCPs for Grok and Auggie", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-extra-mcp-"));
  const statePath = join(directory, "install.json");
  const calls = [];
  const extraProviders = [
    { id: "codex", agentInstalled: false, adapterInstalled: false, install: null },
    { id: "claude", agentInstalled: false, adapterInstalled: false, install: null },
    { id: "grok", agentInstalled: true, adapterInstalled: true, install: null },
    { id: "auggie", agentInstalled: true, adapterInstalled: true, install: null }
  ];
  try {
    const result = await runInstaller(
      parseInstallerArgs(["--install-control", "--install-guide", "--target", "all", "--skip-health-check"]),
      {
        statePath,
        runtime,
        detectProviders: async () => extraProviders,
        runCommand: async (command, args) => {
          calls.push([command, ...args]);
          if (args.join(" ") === "mcp list --json") {
            return {
              code: 0,
              stdout: command === "grok" ? "[]" : '{"servers":[]}',
              stderr: ""
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        }
      }
    );
    assert.deepEqual(result.targets.control, ["codex", "claude", "grok", "auggie"]);
    assert.ok(calls.some((call) => call[0] === "grok" && call.slice(1, 5).join(" ") === "mcp add --scope user"));
    assert.ok(calls.some((call) => call[0] === "auggie" && call[1] === "mcp" && call[2] === "add-json"));
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(JSON.stringify(result.actions).includes(state.identity.token), false);
    assert.match(JSON.stringify(result.actions), /<redacted>/);
    assert.ok(state.managedMcp["grok:agent-acp"]);
    assert.ok(state.managedMcp["grok:agent-acp-guide"]);
    assert.ok(state.managedMcp["auggie:agent-acp"]);
    assert.ok(state.managedMcp["auggie:agent-acp-guide"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer places the Claude MCP name before variadic environment arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-claude-mcp-"));
  const statePath = join(directory, "install.json");
  const calls = [];
  const claudeProviders = providers.map((provider) => ({
    ...provider,
    agentInstalled: provider.id === "claude"
  }));
  try {
    await runInstaller(
      parseInstallerArgs(["--install-control", "--target", "claude", "--skip-health-check"]),
      {
        statePath,
        runtime,
        detectProviders: async () => claudeProviders,
        runCommand: async (command, args) => {
          calls.push([command, ...args]);
          if (args.slice(0, 2).join(" ") === "mcp get") {
            return { code: 1, stdout: "", stderr: "No MCP server named agent-acp found" };
          }
          return { code: 0, stdout: "", stderr: "" };
        }
      }
    );
    const add = calls.find((call) => call[0] === "claude" && call[1] === "mcp" && call[2] === "add");
    assert.ok(add);
    assert.deepEqual(add.slice(1, 6), ["mcp", "add", "--scope", "user", "agent-acp"]);
    assert.ok(add.indexOf("agent-acp") < add.indexOf("-e"));
    assert.match(add[add.indexOf("-e") + 1], /^ACP_GATEWAY_CONTROL_TOKEN=.+/);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.ok(add.includes(`ACP_GATEWAY_ROOT_ID=${state.identity.rootId}`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer update repoints a managed entry only when it is provably stale", async () => {
  // realpath: the rule tells fixed paths from symlinked ones, and macOS tmpdir is itself a symlink.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-repoint-")));
  const statePath = join(directory, "install.json");
  const calls = [];
  try {
    const pinned = await gatewayTree(directory, "runtime/versions/1.4.0-12e879fe6e1343c2", "1.4.0");
    const gone = join(directory, "runtime/versions/1.3.2-064904011f25b3f3/gateway/src/guide.js");
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control"],
      ["codex", "agent-acp-guide", "guide"],
      ["grok", "agent-acp", "control"],
      ["grok", "agent-acp-guide", "guide"]
    ]);
    const answer = inspectAnswers({
      codex: {
        "agent-acp": { command: NODE, args: [join(pinned, "index.js")] },
        "agent-acp-guide": { command: NODE, args: [gone] }
      },
      grok: {
        "agent-acp": { command: "/usr/bin/node", args: [gatewayScript("index.js")] },
        "agent-acp-guide": { command: NODE, args: [gatewayScript("guide.js")] }
      }
    });
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--update", "--target", "codex", "--target", "grok"]),
      updateDependencies(statePath, directory, answer, calls)
    ));
    assert.deepEqual(statusOf(result), {
      // A fixed path into an older gateway.
      "codex:agent-acp": "updated",
      // A script that no longer exists.
      "codex:agent-acp-guide": "updated",
      // This install's own script under another node.
      "grok:agent-acp": "updated",
      "grok:agent-acp-guide": "unchanged"
    });
    const control = result.actions.find((action) => action.agent === "codex" && action.name === "agent-acp");
    assert.deepEqual(control.previous, { command: NODE, args: [join(pinned, "index.js")] });
    assert.deepEqual(control.next, { command: NODE, args: [gatewayScript("index.js")] });
    const mutations = calls.filter(isMutation);
    assert.deepEqual(mutations.map((call) => call.slice(0, 3).concat(call.includes("agent-acp-guide") ? "guide" : "control")), [
      ["codex", "mcp", "remove", "control"],
      ["codex", "mcp", "add", "control"],
      ["codex", "mcp", "remove", "guide"],
      ["codex", "mcp", "add", "guide"],
      ["grok", "mcp", "remove", "control"],
      ["grok", "mcp", "add", "control"]
    ]);
    assert.deepEqual(mutations[1].slice(-3), ["--", NODE, gatewayScript("index.js")]);
    assert.equal(JSON.stringify(result.actions).includes("old-secret-token"), false);
    assert.deepEqual(result.warnings, []);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.match(state.managedMcp["codex:agent-acp"].installedAt, /^\d{4}-/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer update leaves pointers another manager owns and never downgrades", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-keep-")));
  const statePath = join(directory, "install.json");
  const calls = [];
  try {
    // runtime/current -> a foreign, even older, runtime: its manager moves it, not this installer.
    await gatewayTree(directory, "runtime/versions/1.4.0-foreign", "1.4.0");
    await symlink("versions/1.4.0-foreign", join(directory, "runtime/current"));
    // A pointer at this very install, registered with another node.
    await symlink(dirname(gatewayScript("guide.js")), join(directory, "this"));
    const newer = await gatewayTree(directory, "runtime/versions/99.0.0-next", "99.0.0");
    const unversioned = await gatewayTree(directory, "loose", null);
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control"],
      ["codex", "agent-acp-guide", "guide"],
      ["grok", "agent-acp", "control"],
      ["grok", "agent-acp-guide", "guide"]
    ]);
    const answer = inspectAnswers({
      codex: {
        "agent-acp": { command: join(directory, "runtime/current/node/bin/node"), args: [join(directory, "runtime/current/gateway/src/index.js")] },
        "agent-acp-guide": { command: "/usr/bin/node", args: [join(directory, "this", "guide.js")] }
      },
      grok: {
        "agent-acp": { command: NODE, args: [join(newer, "index.js")] },
        "agent-acp-guide": { command: NODE, args: [join(unversioned, "guide.js")] }
      }
    });
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--update", "--target", "codex", "--target", "grok"]),
      updateDependencies(statePath, directory, answer, calls)
    ));
    assert.deepEqual(statusOf(result), {
      "codex:agent-acp": "unchanged",
      "codex:agent-acp-guide": "unchanged",
      "grok:agent-acp": "unchanged",
      "grok:agent-acp-guide": "unchanged"
    });
    assert.deepEqual(calls.filter(isMutation), []);
    assert.deepEqual(result.warnings, [
      "codex:agent-acp: the registered path goes through a symlink to an older gateway; update it with the app that manages that link, or rerun with --force to re-register it",
      "grok:agent-acp-guide: could not verify the registered path; rerun with --force to re-register it"
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer leaves a managed entry that already launches this install, through a symlink too", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-same-path-"));
  const statePath = join(directory, "install.json");
  // Like runtime/current: a link to the directory this installer resolves to.
  const current = join(directory, "current");
  const calls = [];
  const claudeProviders = providers.map((provider) => ({ ...provider, agentInstalled: provider.id === "claude" }));
  try {
    await symlink(dirname(gatewayScript("index.js")), current);
    await writeManagedState(statePath, [["claude", "agent-acp", "control"], ["claude", "agent-acp-guide", "guide"]]);
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--install-control", "--install-guide", "--target", "claude", "--skip-health-check"]),
      {
        statePath,
        runtime,
        detectProviders: async () => claudeProviders,
        runCommand: async (command, args) => {
          calls.push([command, ...args]);
          if (args[1] !== "get") return { code: 0, stdout: "", stderr: "" };
          const script = args[2] === "agent-acp" ? gatewayScript("index.js") : join(current, "guide.js");
          return { code: 0, stdout: claudeGetOutput(args[2], NODE, [script]), stderr: "" };
        }
      }
    ));
    assert.deepEqual(result.actions.map((action) => action.status), ["unchanged", "unchanged"]);
    assert.deepEqual(calls.filter(isMutation), []);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer keeps an entry whose registered path it cannot read, and warns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-unverified-"));
  const statePath = join(directory, "install.json");
  const calls = [];
  const codexAndAuggie = [
    { id: "codex", agentInstalled: true, adapterInstalled: true, install: null },
    { id: "auggie", agentInstalled: true, adapterInstalled: true, install: null }
  ];
  try {
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control"],
      ["codex", "agent-acp-guide", "guide"],
      ["auggie", "agent-acp", "control"],
      ["auggie", "agent-acp-guide", "guide"]
    ]);
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--install-control", "--install-guide", "--target", "codex", "--target", "auggie", "--skip-health-check"]),
      {
        statePath,
        runtime,
        detectProviders: async () => codexAndAuggie,
        runCommand: async (command, args) => {
          calls.push([command, ...args]);
          // An older codex without JSON output: the entry exists, its path is unreadable.
          if (command === "codex" && args[1] === "get") return { code: 0, stdout: `${args[2]}\n  enabled: true\n`, stderr: "" };
          if (command === "auggie" && args[1] === "list") {
            // auggie lists the command but never the args, so there is no script to judge,
            // and a node difference alone is not a reason to rewrite an entry.
            return {
              code: 0,
              stdout: JSON.stringify({
                servers: [
                  { name: "agent-acp", transport: "stdio", command: NODE, enabled: true, source: "user" },
                  { name: "agent-acp-guide", transport: "stdio", command: "/usr/bin/node", enabled: true, source: "user" }
                ]
              }),
              stderr: ""
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        }
      }
    ));
    assert.deepEqual(statusOf(result), {
      "codex:agent-acp": "unchanged",
      "codex:agent-acp-guide": "unchanged",
      "auggie:agent-acp": "unchanged",
      "auggie:agent-acp-guide": "unchanged"
    });
    assert.deepEqual(result.warnings, ["codex:agent-acp", "codex:agent-acp-guide", "auggie:agent-acp", "auggie:agent-acp-guide"]
      .map((key) => `${key}: could not verify the registered path; rerun with --force to re-register it`));
    assert.deepEqual(calls.filter(isMutation), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer dry-run previews a stale entry without touching it or starting a front door", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-dry-run-update-")));
  const statePath = join(directory, "install.json");
  const claudeConfigPath = join(directory, ".claude.json");
  const calls = [];
  const grokAndClaude = [
    { id: "grok", agentInstalled: true, adapterInstalled: true, install: null },
    { id: "claude", agentInstalled: true, adapterInstalled: true, install: null }
  ];
  try {
    const pinned = await gatewayTree(directory, "runtime/versions/1.4.0-12e879fe6e1343c2", "1.4.0");
    const listed = [
      // A same-named project entry must not hide the user-scope one the installer owns.
      { name: "agent-acp", scope: "project", command: NODE, args: [gatewayScript("index.js")], enabled: true },
      { name: "agent-acp", scope: "user", command: NODE, args: [join(pinned, "index.js")], env: { ACP_GATEWAY_CONTROL_TOKEN: "old-secret-token" }, enabled: true }
    ];
    await writeFile(claudeConfigPath, JSON.stringify({
      numStartups: 3,
      mcpServers: { "agent-acp": { type: "stdio", command: NODE, args: [join(pinned, "index.js")], env: { ACP_GATEWAY_CONTROL_TOKEN: "old-secret-token" } } }
    }), "utf8");
    const dependencies = {
      statePath,
      runtime,
      claudeConfigPath,
      detectProviders: async () => grokAndClaude,
      registryLoader: emptyRegistryLoader,
      registryDiscover: async () => [],
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        if (command === "grok" && args[1] === "list") return { code: 0, stdout: JSON.stringify(listed), stderr: "" };
        // `claude mcp get` launches the entry to health-check it; a dry run must never get here.
        throw new Error(`dry run executed ${command} ${args.join(" ")}`);
      },
      restartGateway: async () => { throw new Error("dry run restarted the daemon"); }
    };
    await writeManagedState(statePath, [["grok", "agent-acp", "control"], ["claude", "agent-acp", "control"]]);
    const before = await readFile(statePath, "utf8");
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--update", "--dry-run", "--target", "grok", "--target", "claude"]),
      dependencies
    ));
    assert.deepEqual(statusOf(result), {
      "grok:agent-acp": "would-update",
      "grok:agent-acp-guide": "would-install",
      "claude:agent-acp": "would-update",
      "claude:agent-acp-guide": "would-install"
    });
    const control = result.actions.find((action) => action.agent === "claude" && action.name === "agent-acp");
    assert.deepEqual(control.previous, { command: NODE, args: [join(pinned, "index.js")] });
    assert.deepEqual(control.next, { command: NODE, args: [gatewayScript("index.js")] });
    assert.deepEqual(calls, [["grok", "mcp", "list", "--json"], ["grok", "mcp", "list", "--json"]]);
    assert.equal(await readFile(statePath, "utf8"), before);

    const rotated = await withNode(() => runInstaller(
      parseInstallerArgs(["--rotate-token", "--dry-run", "--target", "grok", "--skip-health-check"]),
      dependencies
    ));
    assert.equal(rotated.actions.find((action) => action.type === "mcp").status, "would-replace");

    // An unreadable Claude config is reported, never worked around by asking the CLI.
    await writeFile(claudeConfigPath, "{ not json", "utf8");
    const unreadable = await withNode(() => runInstaller(
      parseInstallerArgs(["--install-control", "--dry-run", "--target", "claude", "--skip-health-check"]),
      dependencies
    ));
    assert.equal(unreadable.actions.find((action) => action.type === "mcp").status, "unknown");
    assert.deepEqual(unreadable.warnings, [`claude:agent-acp: could not parse ${claudeConfigPath}; the dry run could not inspect it`]);
    assert.equal(calls.some((call) => call[0] === "claude"), false);
    assert.deepEqual(calls.filter(isMutation), []);
    assert.equal(await readFile(statePath, "utf8"), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
