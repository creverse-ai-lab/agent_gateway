import assert from "node:assert/strict";
import { access, chmod, link, mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { replaceFile } from "../src/atomic-json.js";
import { parseInstallerArgs } from "../src/installer.js";
import { GATEWAY_VERSION } from "../src/version.js";
// The installer with every default path a test leaves out in a temp directory.
import { runInstaller } from "./helpers/installer.js";

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
async function withNode(run, node = NODE) {
  const saved = process.env.ACP_GATEWAY_NODE;
  process.env.ACP_GATEWAY_NODE = node;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.ACP_GATEWAY_NODE;
    else process.env.ACP_GATEWAY_NODE = saved;
  }
}

// A gateway install tree elsewhere on disk: src/ with its entry points and,
// unless version is null, the version.js the installer reads; beside src/, a
// package.json with that npm name unless packageName is null.
async function gatewayTree(root, relative, version, packageName = "acp-gateway-daemon") {
  const source = join(root, relative, "gateway", "src");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "index.js"), "", "utf8");
  await writeFile(join(source, "guide.js"), "", "utf8");
  if (version !== null) await writeFile(join(source, "version.js"), `export const GATEWAY_VERSION = "${version}";\n`, "utf8");
  if (packageName !== null) {
    await writeFile(join(dirname(source), "package.json"), JSON.stringify({ name: packageName, version: version ?? "0.0.0" }), "utf8");
  }
  return source;
}

// Fake inspect answers for managed entries: codex answers `mcp get --json`
// per name, grok one `mcp list --json` for all of them. A codex Control entry
// carries an old Control token unless it says otherwise, as one registered
// before 1.8.0 does; a Guide entry never had one (env null, as codex prints
// none). env: undefined leaves the field out, as a codex that does not report
// env would.
function inspectAnswers(entries) {
  return (command, args) => {
    if (command === "codex" && args[1] === "get") {
      const entry = entries.codex?.[args[2]];
      if (!entry) return { code: 1, stdout: "", stderr: `No MCP server named '${args[2]}' found` };
      const env = args[2] === "agent-acp" ? { ACP_GATEWAY_CONTROL_TOKEN: "old-secret-token" } : null;
      return {
        code: 0,
        stdout: JSON.stringify({
          name: args[2],
          enabled: true,
          transport: { type: "stdio", env, env_vars: [], cwd: null, ...entry }
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

// The agent configs a run may tighten, in the test's directory: never the real
// ~/.codex, ~/.claude.json or ~/.grok.
const agentConfigsIn = (directory) => ({
  codex: join(directory, "codex-config.toml"),
  claude: join(directory, ".claude.json"),
  grok: join(directory, "grok-config.toml")
});

function updateDependencies(statePath, directory, answer, calls) {
  return {
    statePath,
    runtime,
    agentConfigPaths: agentConfigsIn(directory),
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

// The Control identity writeManagedState stores, as the env the installer
// registers it under.
const identityEnv = { ACP_GATEWAY_CONTROL_TOKEN: "test-control-token-at-least-24-characters", ACP_GATEWAY_ROOT_ID: "main-test" };

// Managed records as [agent, name, kind, launch]: without a launch, a record
// from before the installer recorded what it registered.
async function writeManagedState(statePath, entries) {
  await writeFile(statePath, JSON.stringify({
    version: 1,
    identity: { token: identityEnv.ACP_GATEWAY_CONTROL_TOKEN, rootId: identityEnv.ACP_GATEWAY_ROOT_ID },
    managedMcp: Object.fromEntries(entries.map(([agent, name, kind, launch]) => [
      `${agent}:${name}`,
      { agent, name, kind, ...(launch ? { launch: { envKeys: [], ...launch } } : {}) }
    ])),
    managedSkills: {},
    agentUpdates: { autoUpdate: true, notifications: true }
  }), "utf8");
}

// The record of a Control entry registered before 1.8.0, with the identity in its env.
const recordedControl = (command, script) => ({
  command,
  args: [script],
  envKeys: ["ACP_GATEWAY_CONTROL_TOKEN", "ACP_GATEWAY_ROOT_ID"]
});

// The record of a Control entry registered since: no identity, only where the
// install state is, since a test's is never at the default path.
const identityFreeControl = (command, script) => ({ command, args: [script], envKeys: ["ACP_GATEWAY_INSTALL_STATE"] });

// What the installer registers a Control entry with when its state is at statePath.
const installStateEnv = (statePath) => ({ ACP_GATEWAY_INSTALL_STATE: statePath });

// The warning for an entry left with the Control token in its env.
const heldToken = (key, { retired = false, tightened = null } = {}) => {
  const [agent] = key.split(":");
  const which = retired ? "the retired Control token, which stops working once the daemon restarts" : "the Control token";
  return `${key}: its env still holds ${which}, and so does ${agent}'s MCP configuration${tightened ? ` (${tightened} is now readable only by you)` : ""}; rerun with --force to re-register it without the token`;
};

// The agent CLIs as a fake that keeps what each add registered, so a later run
// inspects what an earlier one wrote: codex and grok, through inspectAnswers.
// failAdds[cli] adds of that CLI fail first, leaving its entries as they are.
function rememberingClis(initial, { failAdds = {} } = {}) {
  const entries = structuredClone(initial);
  const failing = { ...failAdds };
  const answer = (command, args) => {
    if (!["codex", "grok"].includes(command)) return null;
    if (args[1] === "add" && failing[command] > 0) {
      failing[command] -= 1;
      return { code: 1, stdout: "", stderr: "config is locked" };
    }
    if (args[1] === "add") {
      const at = args.indexOf("--");
      const env = Object.fromEntries(args.filter((_, index) => args[index - 1] === "--env")
        .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
      entries[command] = { ...entries[command], [args[at - 1]]: { command: args[at + 1], args: args.slice(at + 2), env } };
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "remove") {
      delete entries[command]?.[args.at(-1)];
      return { code: 0, stdout: "", stderr: "" };
    }
    return inspectAnswers(entries)(command, args);
  };
  answer.entries = entries;
  return answer;
}

// A file's permission bits.
const modeOf = async (path) => (await stat(path)).mode & 0o777;

// The one warning a run that took the token out of agent configs ends with.
const rotateAdvice = (count) => `The Control token was removed from ${count === 1 ? "one MCP registration" : `${count} MCP registrations`}, but copies made before, such as the agent CLIs' config backups (*.bak), may still hold it. To retire it, stop the Gateway when it is idle (acp-gateway-admin shutdown_if_idle), run acp-gateway-bootstrap --rotate-token, restart the agent CLI sessions that are open (each one's Control MCP server reads the token once, at start), and reconnect apps that keep the identity, such as AgenLynk`;

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
    // Stored once, registered nowhere: the front door reads it from install.json,
    // and the registration only says where that file is.
    const identityValues = [firstState.identity.token, firstState.identity.rootId];
    assert.equal(calls.some((call) => call.some((arg) => identityValues.some((value) => arg.includes(value)))), false);
    assert.ok(calls.some((call) => call.includes(`ACP_GATEWAY_INSTALL_STATE=${statePath}`)));
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
    const adds = calls.filter((call) => ["add", "add-json"].includes(call[2]));
    assert.deepEqual(adds.find((call) => call[0] === "grok" && call[3] === "--scope").slice(1, 8), [
      "mcp", "add", "--scope", "user", "--env", `ACP_GATEWAY_INSTALL_STATE=${statePath}`, "agent-acp"
    ]);
    const auggie = (name) => JSON.parse(adds.find((call) => call[0] === "auggie" && call[3] === name)[4]);
    assert.deepEqual(auggie("agent-acp").env, installStateEnv(statePath));
    assert.deepEqual(auggie("agent-acp-guide").env, {});
    const state = JSON.parse(await readFile(statePath, "utf8"));
    // No registration carries the Control identity, in argv or in what the actions print.
    for (const printed of [JSON.stringify(calls), JSON.stringify(result.actions)]) {
      for (const value of ["ACP_GATEWAY_CONTROL_TOKEN", "ACP_GATEWAY_ROOT_ID", state.identity.token, state.identity.rootId]) {
        assert.equal(printed.includes(value), false, value);
      }
    }
    assert.deepEqual(state.managedMcp["grok:agent-acp"].launch.envKeys, ["ACP_GATEWAY_INSTALL_STATE"]);
    assert.deepEqual(state.managedMcp["grok:agent-acp-guide"].launch.envKeys, []);
    assert.deepEqual(state.managedMcp["auggie:agent-acp"].launch.envKeys, ["ACP_GATEWAY_INSTALL_STATE"]);
    assert.deepEqual(state.managedMcp["auggie:agent-acp-guide"].launch.envKeys, []);
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
    // The one variable registered is where the install state is, not the identity in it.
    assert.equal(add[add.indexOf("-e") + 1], `ACP_GATEWAY_INSTALL_STATE=${statePath}`);
    assert.equal(add.filter((arg) => arg === "-e").length, 1);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(add.some((arg) => arg.includes(state.identity.token) || arg.includes(state.identity.rootId)), false);
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
    // Each record but the last holds the launch this installer registered, which is what lets it move.
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control", recordedControl(NODE, join(pinned, "index.js"))],
      // A gone script moves only because the state records writing exactly this launch.
      ["codex", "agent-acp-guide", "guide", { command: NODE, args: [gone] }],
      ["grok", "agent-acp", "control", recordedControl("/usr/bin/node", gatewayScript("index.js"))],
      // From before launches were recorded, and already this install: nothing to do.
      ["grok", "agent-acp-guide", "guide"]
    ]);
    // Each with the env it was registered with: the identity for Control, none for Guide.
    const answer = inspectAnswers({
      codex: {
        "agent-acp": { command: NODE, args: [join(pinned, "index.js")], env: identityEnv },
        "agent-acp-guide": { command: NODE, args: [gone], env: null }
      },
      grok: {
        "agent-acp": { command: "/usr/bin/node", args: [gatewayScript("index.js")], env: identityEnv },
        "agent-acp-guide": { command: NODE, args: [gatewayScript("guide.js")] }
      }
    });
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--update", "--target", "codex", "--target", "grok"]),
      updateDependencies(statePath, directory, answer, calls)
    ));
    assert.deepEqual(statusOf(result), {
      // A fixed path into an older gateway package.
      "codex:agent-acp": "updated",
      // A recorded script that no longer exists.
      "codex:agent-acp-guide": "updated",
      // This install's own script under another node.
      "grok:agent-acp": "updated",
      "grok:agent-acp-guide": "unchanged"
    });
    const control = result.actions.find((action) => action.agent === "codex" && action.name === "agent-acp");
    assert.deepEqual(control.previous, { command: NODE, args: [join(pinned, "index.js")] });
    assert.deepEqual(control.next, { command: NODE, args: [gatewayScript("index.js")] });
    // Repointed Control entries also leave the identity behind, and say so by name.
    assert.deepEqual(control.removedEnv, ["ACP_GATEWAY_CONTROL_TOKEN", "ACP_GATEWAY_ROOT_ID"]);
    const mutations = calls.filter(isMutation);
    assert.deepEqual(mutations.map((call) => call.slice(0, 3).concat(call.includes("agent-acp-guide") ? "guide" : "control")), [
      ["codex", "mcp", "remove", "control"],
      ["codex", "mcp", "add", "control"],
      ["codex", "mcp", "remove", "guide"],
      ["codex", "mcp", "add", "guide"],
      ["grok", "mcp", "remove", "control"],
      ["grok", "mcp", "add", "control"]
    ]);
    assert.deepEqual(mutations[1], ["codex", "mcp", "add", "--env", `ACP_GATEWAY_INSTALL_STATE=${statePath}`, "agent-acp", "--", NODE, gatewayScript("index.js")]);
    assert.equal(JSON.stringify(result.actions).includes(identityEnv.ACP_GATEWAY_CONTROL_TOKEN), false);
    assert.equal(JSON.stringify(calls).includes(identityEnv.ACP_GATEWAY_CONTROL_TOKEN), false);
    // The only warning: two tokens came out of agent configs, and older copies may hold them.
    assert.deepEqual(result.warnings, [rotateAdvice(2)]);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.match(state.managedMcp["codex:agent-acp"].installedAt, /^\d{4}-/);
    // Each registration records what it registered, the env by name only.
    assert.deepEqual(state.managedMcp["codex:agent-acp"].launch, identityFreeControl(NODE, gatewayScript("index.js")));
    assert.deepEqual(state.managedMcp["codex:agent-acp-guide"].launch, { command: NODE, args: [gatewayScript("guide.js")], envKeys: [] });
    assert.deepEqual(state.managedMcp["grok:agent-acp"].launch, identityFreeControl(NODE, gatewayScript("index.js")));
    assert.equal(state.managedMcp["grok:agent-acp-guide"].launch, undefined);
    assert.equal(JSON.stringify(state.managedMcp).includes(state.identity.token), false);
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
      // Kept, so it keeps the token an older installer gave it, and says so.
      heldToken("codex:agent-acp"),
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
        claudeConfigPath: join(directory, ".claude.json"),
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
    { id: "auggie", agentInstalled: true, adapterInstalled: true, install: null },
    { id: "grok", agentInstalled: true, adapterInstalled: true, install: null }
  ];
  try {
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control"],
      ["codex", "agent-acp-guide", "guide"],
      ["auggie", "agent-acp", "control"],
      ["auggie", "agent-acp-guide", "guide"],
      ["grok", "agent-acp", "control"],
      ["grok", "agent-acp-guide", "guide"]
    ]);
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--install-control", "--install-guide", "--target", "codex", "--target", "auggie", "--target", "grok", "--skip-health-check"]),
      {
        statePath,
        runtime,
        detectProviders: async () => codexAndAuggie,
        runCommand: async (command, args) => {
          calls.push([command, ...args]);
          // An older codex without JSON output: the entry exists, its path is unreadable.
          if (command === "codex" && args[1] === "get") return { code: 0, stdout: `${args[2]}\n  enabled: true\n`, stderr: "" };
          // Remote servers under the managed names launch no command at all.
          if (command === "grok" && args[1] === "list") {
            return {
              code: 0,
              stdout: JSON.stringify(["agent-acp", "agent-acp-guide"].map((name) => ({ name, scope: "user", url: "http://127.0.0.1:9/mcp", enabled: true }))),
              stderr: ""
            };
          }
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
      "auggie:agent-acp-guide": "unchanged",
      "grok:agent-acp": "unchanged",
      "grok:agent-acp-guide": "unchanged"
    });
    assert.deepEqual(result.warnings, ["codex:agent-acp", "codex:agent-acp-guide", "auggie:agent-acp", "auggie:agent-acp-guide", "grok:agent-acp", "grok:agent-acp-guide"]
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
      { name: "agent-acp", scope: "user", command: NODE, args: [join(pinned, "index.js")], env: identityEnv, enabled: true }
    ];
    await writeFile(claudeConfigPath, JSON.stringify({
      numStartups: 3,
      mcpServers: { "agent-acp": { type: "stdio", command: NODE, args: [join(pinned, "index.js")], env: identityEnv } }
    }), "utf8");
    const dependencies = {
      statePath,
      runtime,
      claudeConfigPath,
      agentConfigPaths: agentConfigsIn(directory),
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
    const pinnedControl = recordedControl(NODE, join(pinned, "index.js"));
    await writeManagedState(statePath, [["grok", "agent-acp", "control", pinnedControl], ["claude", "agent-acp", "control", pinnedControl]]);
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
    assert.deepEqual(control.removedEnv, ["ACP_GATEWAY_CONTROL_TOKEN", "ACP_GATEWAY_ROOT_ID"]);
    // Nothing was taken out yet, so nothing to rotate: that advice comes with the real run.
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(calls, [["grok", "mcp", "list", "--json"], ["grok", "mcp", "list", "--json"]]);
    assert.equal(await readFile(statePath, "utf8"), before);

    // A rotation moves the same owned entry, with the identity it was registered with gone too.
    const rotated = await withNode(() => runInstaller(
      parseInstallerArgs(["--rotate-token", "--dry-run", "--target", "grok", "--skip-health-check"]),
      dependencies
    ));
    assert.equal(rotated.actions.find((action) => action.type === "mcp").status, "would-update");
    // The dry run's planned command holds no identity, stored or freshly rotated.
    assert.deepEqual(rotated.actions.find((action) => action.type === "mcp").args, [
      "mcp", "add", "--scope", "user", "--env", `ACP_GATEWAY_INSTALL_STATE=${statePath}`,
      "agent-acp", "--", NODE, gatewayScript("index.js")
    ]);
    assert.equal(JSON.stringify(rotated.actions).includes(rotated.identity.rootId), false);
    assert.equal(JSON.stringify(result.actions).includes("main-test"), false);

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

test("installer update leaves an entry the user replaced, whatever the install state says", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-foreign-")));
  const statePath = join(directory, "install.json");
  const calls = [];
  try {
    // The state still lists all four as managed; each entry was replaced since, and none of their scripts exist.
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control"],
      ["codex", "agent-acp-guide", "guide"],
      ["grok", "agent-acp", "control"],
      ["grok", "agent-acp-guide", "guide"]
    ]);
    const answer = inspectAnswers({
      codex: {
        // A package runner with a bare package name.
        "agent-acp": { command: "/usr/local/bin/uvx", args: ["my-acp-server"] },
        // Node, but a script this installer never registers.
        "agent-acp-guide": { command: NODE, args: [join(directory, "fork/lib/guide-server.js")] }
      },
      grok: {
        // The gateway's file name under another runtime.
        "agent-acp": { command: "/opt/custom/bin/deno", args: [join(directory, "gone/gateway/src/index.js")] },
        // More than the one argument this installer writes.
        "agent-acp-guide": { command: "/usr/local/bin/npx", args: ["-y", "my-guide-mcp"] }
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
    const foreign = (key) => `${key}: registered command is not one this installer wrote; rerun with --force to replace it`;
    assert.deepEqual(result.warnings, [
      foreign("codex:agent-acp"),
      // Codex's Control entry still holds an older token (inspectAnswers), and is left with it.
      heldToken("codex:agent-acp"),
      foreign("codex:agent-acp-guide"),
      foreign("grok:agent-acp"),
      foreign("grok:agent-acp-guide")
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer update keeps a missing script behind another manager's symlink and repoints a fixed one", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-broken-link-")));
  const statePath = join(directory, "install.json");
  const calls = [];
  try {
    await mkdir(join(directory, "runtime/versions/1.6.0-partial/gateway"), { recursive: true });
    // A dangling pointer mid-update, and a live one to a runtime without the script.
    await symlink("versions/1.6.0-removed", join(directory, "runtime/current"));
    await symlink("versions/1.6.0-partial", join(directory, "runtime/previous"));
    // A node version removed by its version manager, taking its global packages along;
    // the state records this installer registering that launch.
    const removed = join(directory, "nvm/versions/node/v22.1.0");
    const removedLaunch = recordedControl(join(removed, "bin/node"), join(removed, "lib/node_modules/acp-gateway-daemon/src/index.js"));
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control"],
      ["codex", "agent-acp-guide", "guide"],
      ["grok", "agent-acp", "control", removedLaunch],
      ["grok", "agent-acp-guide", "guide"]
    ]);
    const answer = inspectAnswers({
      codex: {
        "agent-acp": { command: join(directory, "runtime/current/node/bin/node"), args: [join(directory, "runtime/current/gateway/src/index.js")] },
        "agent-acp-guide": { command: NODE, args: [join(directory, "runtime/previous/gateway/src/guide.js")] }
      },
      grok: {
        "agent-acp": { command: removedLaunch.command, args: removedLaunch.args, env: identityEnv },
        "agent-acp-guide": { command: NODE, args: [gatewayScript("guide.js")] }
      }
    });
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--update", "--target", "codex", "--target", "grok"]),
      updateDependencies(statePath, directory, answer, calls)
    ));
    assert.deepEqual(statusOf(result), {
      "codex:agent-acp": "unchanged",
      "codex:agent-acp-guide": "unchanged",
      "grok:agent-acp": "updated",
      "grok:agent-acp-guide": "unchanged"
    });
    assert.deepEqual(result.warnings, [
      "codex:agent-acp: the registered path goes through a broken symlink; fix it with the app that manages it, or rerun with --force to re-register it",
      heldToken("codex:agent-acp"),
      "codex:agent-acp-guide: the registered path goes through a symlink to a missing script; fix it with the app that manages that link, or rerun with --force to re-register it",
      // The repointed Grok entry gave up its token.
      rotateAdvice(1)
    ]);
    const mutations = calls.filter(isMutation);
    assert.deepEqual(mutations.map((call) => call.slice(0, 3)), [["grok", "mcp", "remove"], ["grok", "mcp", "add"]]);
    assert.deepEqual(mutations[1].slice(-3), ["--", NODE, gatewayScript("index.js")]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer keeps a managed entry whose script it may not look at", {
  skip: process.getuid?.() === 0 ? "root can search any directory" : false
}, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-eacces-")));
  const statePath = join(directory, "install.json");
  const locked = join(directory, "locked");
  const calls = [];
  try {
    await gatewayTree(directory, "locked", "1.0.0");
    await chmod(locked, 0o000);
    await writeManagedState(statePath, [["codex", "agent-acp", "control"]]);
    const answer = inspectAnswers({ codex: { "agent-acp": { command: NODE, args: [join(locked, "gateway/src/index.js")] } } });
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--install-control", "--target", "codex", "--skip-health-check"]),
      updateDependencies(statePath, directory, answer, calls)
    ));
    assert.deepEqual(statusOf(result), { "codex:agent-acp": "unchanged" });
    assert.deepEqual(calls.filter(isMutation), []);
    assert.deepEqual(result.warnings, [
      "codex:agent-acp: could not verify the registered path; rerun with --force to re-register it",
      heldToken("codex:agent-acp")
    ]);
  } finally {
    await chmod(locked, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer update never moves an entry recorded before launches were, and --force takes it over once", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-unproven-")));
  const statePath = join(directory, "install.json");
  const calls = [];
  try {
    // Records from before the installer recorded its launches: the key alone proves nothing.
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control"],
      ["codex", "agent-acp-guide", "guide"],
      ["grok", "agent-acp", "control"],
      ["grok", "agent-acp-guide", "guide"]
    ]);
    const bare = await gatewayTree(directory, "custom/1.4.0", "1.4.0", null);
    const fork = await gatewayTree(directory, "fork/1.4.0", "1.4.0", "my-gateway-fork");
    const legacyName = await gatewayTree(directory, "runtime/versions/1.4.0-legacy", "1.4.0", "acp-gateway");
    const answer = inspectAnswers({
      codex: {
        // The user's own server in the gateway's shape, whose script is not there.
        "agent-acp": { command: "/usr/bin/node", args: [join(directory, "custom/src/index.js")] },
        // A working older gateway-looking tree with no package.json to say what it is.
        "agent-acp-guide": { command: NODE, args: [join(bare, "guide.js")] }
      },
      grok: {
        // A package that is not the Gateway.
        "agent-acp": { command: NODE, args: [join(fork, "index.js")] },
        // A working older Gateway under its pre-1.7 npm name: this installer's
        // from before 1.7.2, or one the user pointed the entry at since. Nothing tells which.
        "agent-acp-guide": { command: NODE, args: [join(legacyName, "guide.js")], env: {} }
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
    const unrecorded = (key) => `${key}: the entry predates this installer's ownership records, so it cannot tell the entry is still its own and does not update it automatically; rerun with --force once to update it (later updates are automatic)`;
    assert.deepEqual(result.warnings, [
      unrecorded("codex:agent-acp"),
      // Unproven, so its token is not taken out either.
      heldToken("codex:agent-acp"),
      "codex:agent-acp-guide: registered command is not one this installer wrote; rerun with --force to replace it",
      "grok:agent-acp: registered command is not one this installer wrote; rerun with --force to replace it",
      unrecorded("grok:agent-acp-guide")
    ]);
    assert.deepEqual(calls.filter(isMutation), []);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.managedMcp["codex:agent-acp"].launch, undefined);
    assert.equal(state.managedMcp["grok:agent-acp-guide"].launch, undefined);

    // --force is the way to take them over, and it registers without the token.
    const forced = await withNode(() => runInstaller(
      parseInstallerArgs(["--install-control", "--install-guide", "--force", "--dry-run", "--target", "codex"]),
      updateDependencies(statePath, directory, answer, [])
    ));
    assert.deepEqual(statusOf(forced), { "codex:agent-acp": "would-replace", "codex:agent-acp-guide": "would-replace" });
    assert.deepEqual(forced.actions.find((action) => action.name === "agent-acp").removedEnv, ["ACP_GATEWAY_CONTROL_TOKEN"]);
    const forcedCalls = [];
    const takenOver = await withNode(() => runInstaller(
      parseInstallerArgs(["--install-guide", "--force", "--target", "grok", "--skip-health-check"]),
      updateDependencies(statePath, directory, answer, forcedCalls)
    ));
    assert.deepEqual(takenOver.warnings, []);
    assert.deepEqual(forcedCalls.filter(isMutation).map((call) => call.slice(0, 3).concat(call.at(-1))), [
      ["grok", "mcp", "remove", "agent-acp-guide"],
      ["grok", "mcp", "add", gatewayScript("guide.js")]
    ]);
    // Recorded now, so the next update moves it on its own.
    const after = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(after.managedMcp["grok:agent-acp-guide"].launch, { command: NODE, args: [gatewayScript("guide.js")], envKeys: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer update trusts the launch it recorded, and only that launch", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-recorded-")));
  const statePath = join(directory, "install.json");
  const calls = [];
  try {
    // The installer's own older checkout: no package.json needed, the record proves it.
    const older = await gatewayTree(directory, "checkouts/1.7.2", "1.4.0", null);
    const another = await gatewayTree(directory, "runtime/versions/1.4.0-another", "1.4.0");
    const newer = await gatewayTree(directory, "checkouts/next", "99.0.0", null);
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control", recordedControl(NODE, join(older, "index.js"))],
      ["codex", "agent-acp-guide", "guide", { command: NODE, args: [join(older, "guide.js")] }],
      ["grok", "agent-acp", "control", recordedControl(NODE, join(older, "index.js"))],
      ["grok", "agent-acp-guide", "guide", { command: NODE, args: [join(newer, "guide.js")] }]
    ]);
    const answer = inspectAnswers({
      codex: {
        // The recorded launch, spelled with a doubled slash, with the env it was registered with.
        "agent-acp": { command: NODE, args: [`${older}//index.js`], env: identityEnv },
        // The recorded script under a node the installer did not register.
        "agent-acp-guide": { command: "/usr/bin/node", args: [join(older, "guide.js")] }
      },
      grok: {
        // A provable Gateway install, but not the launch the state records.
        "agent-acp": { command: NODE, args: [join(another, "index.js")] },
        // The recorded launch of a newer gateway: never downgraded.
        "agent-acp-guide": { command: NODE, args: [join(newer, "guide.js")] }
      }
    });
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--update", "--target", "codex", "--target", "grok"]),
      updateDependencies(statePath, directory, answer, calls)
    ));
    assert.deepEqual(statusOf(result), {
      "codex:agent-acp": "updated",
      "codex:agent-acp-guide": "unchanged",
      "grok:agent-acp": "unchanged",
      "grok:agent-acp-guide": "unchanged"
    });
    assert.deepEqual(result.warnings, [
      ...["codex:agent-acp-guide", "grok:agent-acp"].map((key) => `${key}: registered command is not one this installer wrote; rerun with --force to replace it`),
      rotateAdvice(1)
    ]);
    assert.deepEqual(calls.filter(isMutation).map((call) => call.slice(0, 3)), [["codex", "mcp", "remove"], ["codex", "mcp", "add"]]);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(state.managedMcp["codex:agent-acp"].launch, identityFreeControl(NODE, gatewayScript("index.js")));
    assert.deepEqual(state.managedMcp["grok:agent-acp"].launch, recordedControl(NODE, join(older, "index.js")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer update leaves a recorded entry whose env changed since it registered it", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-customized-env-")));
  const statePath = join(directory, "install.json");
  const calls = [];
  const proxy = "http://proxy.internal:3128";
  const otherToken = "another-control-token-value";
  try {
    const older = await gatewayTree(directory, "runtime/versions/1.4.0-older", "1.4.0");
    const control = { command: NODE, args: [join(older, "index.js")] };
    const guide = { command: NODE, args: [join(older, "guide.js")] };
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control", recordedControl(control.command, control.args[0])],
      ["codex", "agent-acp-guide", "guide", guide],
      ["grok", "agent-acp", "control", recordedControl(control.command, control.args[0])],
      ["grok", "agent-acp-guide", "guide", guide]
    ]);
    const answer = inspectAnswers({
      codex: {
        // A variable the user added to each.
        "agent-acp": { ...control, env: { ...identityEnv, HTTP_PROXY: proxy } },
        "agent-acp-guide": { ...guide, env: { NODE_OPTIONS: "--max-old-space-size=4096" } }
      },
      grok: {
        // The recorded names, but a token this install does not hold.
        "agent-acp": { ...control, env: { ...identityEnv, ACP_GATEWAY_CONTROL_TOKEN: otherToken } },
        // Exactly as registered: the one that moves.
        "agent-acp-guide": guide
      }
    });
    const before = JSON.parse(await readFile(statePath, "utf8")).managedMcp;
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--update", "--target", "codex", "--target", "grok"]),
      updateDependencies(statePath, directory, answer, calls)
    ));
    assert.deepEqual(statusOf(result), {
      "codex:agent-acp": "unchanged",
      "codex:agent-acp-guide": "unchanged",
      "grok:agent-acp": "unchanged",
      "grok:agent-acp-guide": "updated"
    });
    const customized = (key) => `${key}: its env is not the one this installer registered (a variable was added, removed or changed since), so it is left as it is; rerun with --force to re-register it without those changes`;
    // Both Control entries keep a token in their env; the Guide never had one.
    assert.deepEqual(result.warnings, [
      customized("codex:agent-acp"),
      heldToken("codex:agent-acp"),
      customized("codex:agent-acp-guide"),
      customized("grok:agent-acp"),
      heldToken("grok:agent-acp")
    ]);
    assert.deepEqual(calls.filter(isMutation).map((call) => call.slice(0, 3).concat(call.at(-1))), [
      ["grok", "mcp", "remove", "agent-acp-guide"],
      ["grok", "mcp", "add", gatewayScript("guide.js")]
    ]);
    // No env value is compared into a message or stored.
    const printed = JSON.stringify(result);
    for (const value of [proxy, otherToken, identityEnv.ACP_GATEWAY_CONTROL_TOKEN]) assert.equal(printed.includes(value), false);
    const after = JSON.parse(await readFile(statePath, "utf8")).managedMcp;
    for (const key of ["codex:agent-acp", "codex:agent-acp-guide", "grok:agent-acp"]) assert.deepEqual(after[key], before[key]);
    assert.equal(JSON.stringify(after).includes(proxy), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer declines an update it could not undo", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-no-undo-")));
  const statePath = join(directory, "install.json");
  const claudeConfigPath = join(directory, ".claude.json");
  const calls = [];
  const everyAgent = ["codex", "grok", "claude"].map((id) => ({ id, agentInstalled: true, adapterInstalled: true, install: null }));
  try {
    const older = await gatewayTree(directory, "runtime/versions/1.4.0-older", "1.4.0");
    // Recorded launches, so each would move but for what its CLI cannot report.
    await writeManagedState(statePath, ["codex", "grok", "claude"].flatMap((agent) => [
      [agent, "agent-acp", "control", recordedControl(NODE, join(older, "index.js"))],
      [agent, "agent-acp-guide", "guide", { command: NODE, args: [join(older, "guide.js")] }]
    ]));
    const inspect = inspectAnswers({
      codex: {
        "agent-acp": { command: NODE, args: [join(older, "index.js")], env_vars: ["HOME"] },
        "agent-acp-guide": { command: NODE, args: [join(older, "guide.js")], env: undefined }
      },
      grok: {
        "agent-acp": { command: NODE, args: [join(older, "index.js")], cwd: "/srv/gateway" },
        "agent-acp-guide": { command: NODE, args: [join(older, "guide.js")], env: { ACP_GATEWAY_CONTROL_TOKEN: "********" } }
      }
    });
    // Claude's config file has no agent-acp, and an agent-acp-guide that is not what `claude mcp get` reports.
    await writeFile(claudeConfigPath, JSON.stringify({
      mcpServers: { "agent-acp-guide": { type: "stdio", command: NODE, args: [join(older, "index.js")], env: {} } }
    }), "utf8");
    const answer = (command, args) => command === "claude" && args[1] === "get"
      ? { code: 0, stdout: claudeGetOutput(args[2], NODE, [join(older, args[2] === "agent-acp" ? "index.js" : "guide.js")]), stderr: "" }
      : inspect(command, args);
    const dependencies = {
      ...updateDependencies(statePath, directory, answer, calls),
      claudeConfigPath,
      detectProviders: async () => everyAgent
    };
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--install-control", "--install-guide", "--target", "codex", "--target", "grok", "--target", "claude", "--skip-health-check"]),
      dependencies
    ));
    assert.deepEqual(Object.values(statusOf(result)), Array(6).fill("unchanged"));
    assert.deepEqual(calls.filter(isMutation), []);
    const declined = (key, gap) => `${key}: could not read the entry fully enough to put it back if the update failed (${gap}); rerun with --force to re-register it`;
    assert.deepEqual(result.warnings, [
      declined("codex:agent-acp", "it forwards env_vars, which codex mcp add cannot set"),
      heldToken("codex:agent-acp"),
      declined("codex:agent-acp-guide", "codex did not report its env"),
      declined("grok:agent-acp", "it sets a cwd, which grok mcp add cannot set"),
      declined("grok:agent-acp-guide", "grok reported its env values masked"),
      declined("claude:agent-acp", `the user-scope agent-acp in ${claudeConfigPath} is not the entry claude reported`),
      declined("claude:agent-acp-guide", `the user-scope agent-acp-guide in ${claudeConfigPath} is not the entry claude reported`)
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer loads install state from before launches were recorded", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-legacy-state-")));
  const statePath = join(directory, "install.json");
  const token = "legacy-control-token-at-least-24-characters";
  try {
    const older = await gatewayTree(directory, "runtime/versions/1.4.0-older", "1.4.0");
    // A 1.7.1 state: no launches, no skills, no update policy; one record whose launch is unreadable.
    await writeFile(statePath, JSON.stringify({
      version: 1,
      identity: { token, rootId: "main-legacy", createdAt: "2026-01-01T00:00:00.000Z" },
      managedMcp: {
        "codex:agent-acp": { agent: "codex", name: "agent-acp", kind: "control", installedAt: "2026-01-01T00:00:00.000Z" },
        "codex:agent-acp-guide": { agent: "codex", name: "agent-acp-guide", kind: "guide", launch: "not a launch" }
      }
    }), "utf8");
    let registered = {};
    const answer = (command, args) => {
      if (command !== "codex") return null;
      if (args[1] === "get") {
        const entry = args[2] === "agent-acp-guide" ? { command: NODE, args: [join(older, "guide.js")] } : registered[args[2]];
        return inspectAnswers({ codex: entry ? { [args[2]]: entry } : {} })(command, args);
      }
      if (args[1] === "add") {
        // What codex would now report: the launch and the env the add gave it.
        const env = Object.fromEntries(args.filter((_, index) => args[index - 1] === "--env")
          .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
        registered = { ...registered, [args[args.indexOf("--") - 1]]: { command: args.at(-2), args: [args.at(-1)], env } };
      }
      return null;
    };
    const options = parseInstallerArgs(["--install-control", "--install-guide", "--target", "codex", "--skip-health-check"]);
    const first = await withNode(() => runInstaller(options, updateDependencies(statePath, directory, answer, [])));
    assert.deepEqual(statusOf(first), { "codex:agent-acp": undefined, "codex:agent-acp-guide": "unchanged" });
    assert.deepEqual(first.warnings, ["codex:agent-acp-guide: could not verify the registered path; rerun with --force to re-register it"]);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.identity.token, token);
    assert.deepEqual(state.managedMcp["codex:agent-acp"].launch, identityFreeControl(NODE, gatewayScript("index.js")));
    assert.equal(state.managedMcp["codex:agent-acp-guide"].launch, "not a launch");
    assert.equal(JSON.stringify(state.managedMcp).includes(token), false);

    // The recorded launch and env are what the CLI now reports: nothing to do, nothing to warn about.
    const calls = [];
    const second = await withNode(() => runInstaller(options, updateDependencies(statePath, directory, answer, calls)));
    assert.deepEqual(statusOf(second), { "codex:agent-acp": "unchanged", "codex:agent-acp-guide": "unchanged" });
    assert.deepEqual(calls.filter(isMutation), []);
    assert.deepEqual(second.warnings, first.warnings);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer restores the previous entry exactly when its replacement cannot be added", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-restore-")));
  const statePath = join(directory, "install.json");
  const claudeConfigPath = join(directory, ".claude.json");
  const token = "test-control-token-at-least-24-characters";
  const allInstalled = ["codex", "claude", "grok", "auggie"].map((id) => ({ id, agentInstalled: true, adapterInstalled: true, install: null }));
  // Adds fail while `failures` lasts, with that stderr (or what a function makes of the args); everything else succeeds.
  const dependencies = (calls, answer, failures) => ({
    statePath,
    runtime,
    claudeConfigPath,
    agentConfigPaths: agentConfigsIn(directory),
    detectProviders: async () => allInstalled,
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      const answered = answer(command, args);
      if (answered) return answered;
      if (["add", "add-json"].includes(args[1]) && failures.length) {
        const failure = failures.shift();
        return { code: 1, stdout: "", stderr: typeof failure === "function" ? failure(command, args) : failure };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  const identityOf = async () => JSON.parse(await readFile(statePath, "utf8")).identity;
  // The identity an entry registered before 1.8.0 carries, which only a restore puts back.
  const codexEnv = ["--env", `ACP_GATEWAY_CONTROL_TOKEN=${token}`, "--env", "ACP_GATEWAY_ROOT_ID=main-test"];
  // The replacement carries none.
  const ownEnv = ["--env", `ACP_GATEWAY_INSTALL_STATE=${statePath}`];
  const addFailure = `install codex:agent-acp failed (codex mcp add ${ownEnv.join(" ")} agent-acp -- ${NODE} ${gatewayScript("index.js")}): config is locked`;
  const envPairs = (flag, env) => Object.entries(env).flatMap(([name, value]) => [flag, `${name}=${value}`]);
  const setting = "kept-exactly-as-it-was";
  // The same older launch after the user changed its env: an older token and a setting of their own.
  const olderEnv = { ACP_GATEWAY_CONTROL_TOKEN: "older-control-token-value", ACP_GATEWAY_ROOT_ID: "main-test", EXTRA_SETTING: setting };
  try {
    const older = join(await gatewayTree(directory, "runtime/versions/1.4.0-older", "1.4.0"), "index.js");
    await writeManagedState(statePath, [["codex", "agent-acp", "control", recordedControl(NODE, older)], ["grok", "agent-acp", "control"], ["claude", "agent-acp", "control"]]);
    const codexOptions = parseInstallerArgs(["--install-control", "--target", "codex", "--skip-health-check"]);
    const codexForce = parseInstallerArgs(["--install-control", "--force", "--target", "codex", "--skip-health-check"]);
    // A working older Gateway, still with the launch and env this installer recorded registering.
    const codexAnswer = inspectAnswers({ codex: { "agent-acp": { command: NODE, args: [older], env: identityEnv } } });
    const customizedAnswer = inspectAnswers({ codex: { "agent-acp": { command: NODE, args: [older], env: olderEnv } } });

    // An ordinary upgrade that fails: the older entry goes back with its own command, args and env.
    const restoredCalls = [];
    await assert.rejects(
      withNode(() => runInstaller(codexOptions, dependencies(restoredCalls, codexAnswer, ["config is locked"]))),
      (error) => {
        assert.equal(error.message, `${addFailure}; the previous codex:agent-acp entry was restored`);
        return true;
      }
    );
    assert.deepEqual(restoredCalls, [
      ["codex", "mcp", "get", "agent-acp", "--json"],
      ["codex", "mcp", "remove", "agent-acp"],
      ["codex", "mcp", "add", ...ownEnv, "agent-acp", "--", NODE, gatewayScript("index.js")],
      ["codex", "mcp", "add", ...codexEnv, "agent-acp", "--", NODE, older]
    ]);
    const kept = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(kept.managedMcp["codex:agent-acp"], { agent: "codex", name: "agent-acp", kind: "control", launch: recordedControl(NODE, older) });

    // --force over the entry the user customized since: it goes back exactly as it was,
    // the older token and the setting included, and not with the current identity over it.
    const customizedCalls = [];
    await assert.rejects(
      withNode(() => runInstaller(codexForce, dependencies(customizedCalls, customizedAnswer, ["config is locked"]))),
      (error) => {
        assert.equal(error.message, `${addFailure}; the previous codex:agent-acp entry was restored`);
        return true;
      }
    );
    assert.deepEqual(customizedCalls.filter(isMutation).at(-1), [
      "codex", "mcp", "add", ...envPairs("--env", olderEnv), "agent-acp", "--", NODE, older
    ]);

    // Both failures surface with what the entry launched, and no env value reaches the
    // message, not even from a CLI that echoes what it was given.
    const echoRestore = (command, args) => `rejected ${command} ${args.join(" ")}; value ${setting}`;
    const lostCalls = [];
    await assert.rejects(
      withNode(() => runInstaller(codexForce, dependencies(lostCalls, customizedAnswer, ["config is locked", echoRestore]))),
      (error) => {
        const shown = `codex mcp add --env ACP_GATEWAY_CONTROL_TOKEN=<redacted> --env ACP_GATEWAY_ROOT_ID=<redacted> --env EXTRA_SETTING=<redacted> agent-acp -- ${NODE} ${older}`;
        assert.equal(error.message, [
          addFailure,
          `restore the previous codex:agent-acp failed (${shown}): rejected ${shown}; value <redacted>`,
          `codex:agent-acp is no longer registered (it launched: ${NODE} ${older}, with env ACP_GATEWAY_CONTROL_TOKEN, ACP_GATEWAY_ROOT_ID, EXTRA_SETTING); re-add it or rerun the installer`
        ].join("; "));
        return true;
      }
    );
    assert.equal(lostCalls.filter(isMutation).length, 3);

    // The same for a launch the state records, whatever its package says.
    const recordedOlder = join(await gatewayTree(directory, "checkouts/1.4.0", "1.4.0", null), "index.js");
    await writeManagedState(statePath, [["grok", "agent-acp", "control", recordedControl(NODE, recordedOlder)], ["claude", "agent-acp", "control"]]);
    const recordedCalls = [];
    await assert.rejects(
      withNode(() => runInstaller(
        parseInstallerArgs(["--install-control", "--target", "grok", "--skip-health-check"]),
        dependencies(recordedCalls, inspectAnswers({ grok: { "agent-acp": { command: NODE, args: [recordedOlder], env: identityEnv } } }), ["config is locked"])
      )),
      /: config is locked; the previous grok:agent-acp entry was restored$/
    );
    assert.deepEqual(recordedCalls.filter(isMutation).at(-1), [
      "grok", "mcp", "add", "--scope", "user", ...envPairs("--env", identityEnv), "agent-acp", "--", NODE, recordedOlder
    ]);

    // Claude, forced: its config file holds the exact args and env that `claude mcp get` only prints.
    await writeFile(claudeConfigPath, JSON.stringify({
      mcpServers: { "agent-acp": { type: "stdio", command: NODE, args: [older], env: olderEnv } }
    }), "utf8");
    const claudeCalls = [];
    const claudeOlder = (command, args) => command === "claude" && args[1] === "get"
      ? { code: 0, stdout: claudeGetOutput(args[2], NODE, [older]), stderr: "" }
      : null;
    await assert.rejects(
      withNode(() => runInstaller(
        parseInstallerArgs(["--install-control", "--force", "--target", "claude", "--skip-health-check"]),
        dependencies(claudeCalls, claudeOlder, ["config is locked"])
      )),
      (error) => {
        assert.match(error.message, /: config is locked; the previous claude:agent-acp entry was restored$/);
        assert.equal(error.message.includes(token), false);
        return true;
      }
    );
    assert.deepEqual(claudeCalls.filter(isMutation).at(-1), [
      "claude", "mcp", "add", "--scope", "user", "agent-acp", ...envPairs("-e", olderEnv), "--", NODE, older
    ]);

    // A token rotation shares the path: this install's own launch, still holding the identity
    // it was registered with, moves to an identity-free entry in place. When that fails, it goes
    // back exactly as it was, with the identity it had, and install.json keeps that identity
    // too: the rotation is not committed, so the entry and the running daemon still agree.
    await writeManagedState(statePath, [["grok", "agent-acp", "control", recordedControl(NODE, gatewayScript("index.js"))], ["claude", "agent-acp", "control"]]);
    const rotateCalls = [];
    const grokAnswer = inspectAnswers({ grok: { "agent-acp": { command: NODE, args: [gatewayScript("index.js")], env: identityEnv } } });
    await assert.rejects(
      withNode(() => runInstaller(
        parseInstallerArgs(["--rotate-token", "--target", "grok", "--skip-health-check"]),
        dependencies(rotateCalls, grokAnswer, ["config is locked"])
      )),
      /: config is locked; the previous grok:agent-acp entry was restored$/
    );
    assert.deepEqual(await identityOf(), { token, rootId: "main-test" });
    assert.deepEqual(rotateCalls.filter(isMutation), [
      ["grok", "mcp", "remove", "agent-acp"],
      ["grok", "mcp", "add", "--scope", "user", ...ownEnv, "agent-acp", "--", NODE, gatewayScript("index.js")],
      ["grok", "mcp", "add", "--scope", "user", ...envPairs("--env", identityEnv), "agent-acp", "--", NODE, gatewayScript("index.js")]
    ]);
    // The one token any argv carried is the one the entry had: never the new one.
    const tokensOnArgv = rotateCalls.flat().filter((arg) => arg.startsWith("ACP_GATEWAY_CONTROL_TOKEN="));
    assert.deepEqual(tokensOnArgv, [`ACP_GATEWAY_CONTROL_TOKEN=${token}`]);

    // --force over someone else's command, or a look-alike of this installer's: each goes
    // back with the env it had, and never with the Control identity it did not have.
    const foreignSecret = "sk-foreign-secret-0123456789";
    const uvx = { command: "/usr/local/bin/uvx", args: ["my-acp-server"], env: { API_KEY: foreignSecret } };
    const lookalike = { command: join(directory, "evil/node"), args: [join(directory, "evil/src/index.js")], env: {} };
    const lookalikeWithToken = { ...lookalike, env: { ACP_GATEWAY_CONTROL_TOKEN: "lookalike-own-token-value" } };
    const force = parseInstallerArgs(["--install-control", "--force", "--target", "grok", "--skip-health-check"]);
    for (const previous of [uvx, lookalike, lookalikeWithToken]) {
      const foreignCalls = [];
      await assert.rejects(
        withNode(() => runInstaller(force, dependencies(foreignCalls, inspectAnswers({ grok: { "agent-acp": previous } }), ["config is locked"]))),
        (error) => {
          assert.match(error.message, /: config is locked; the previous grok:agent-acp entry was restored$/);
          assert.equal(error.message.includes(token), false);
          return true;
        }
      );
      const restore = foreignCalls.filter(isMutation).at(-1);
      assert.deepEqual(restore, ["grok", "mcp", "add", "--scope", "user", ...envPairs("--env", previous.env), "agent-acp", "--", previous.command, ...previous.args]);
      assert.equal(restore.includes(`ACP_GATEWAY_CONTROL_TOKEN=${token}`), false);
      assert.equal(restore.some((arg) => arg.startsWith("ACP_GATEWAY_ROOT_ID=")), false);
      assert.equal(foreignCalls.filter(isMutation).length, 3);
    }
    // Its own secret stays out of the message when the restore fails too.
    const echoAll = (command, args) => `rejected ${command} ${args.join(" ")}`;
    const foreignError = await withNode(() => runInstaller(
      force,
      dependencies([], inspectAnswers({ grok: { "agent-acp": uvx } }), ["config is locked", echoAll])
    )).then(() => assert.fail("the grok replacement should fail"), (error) => error);
    assert.equal(foreignError.message.includes(foreignSecret), false);
    assert.match(foreignError.message, /restore the previous grok:agent-acp failed \(grok mcp add --scope user --env API_KEY=<redacted> agent-acp -- \/usr\/local\/bin\/uvx my-acp-server\): rejected grok mcp add --scope user --env API_KEY=<redacted> /);
    assert.match(foreignError.message, /it launched: \/usr\/local\/bin\/uvx my-acp-server, with env API_KEY\)/);

    // --force over an entry whose env codex does not report: it goes back without one, and the error says so.
    const unreportedCalls = [];
    await assert.rejects(
      withNode(() => runInstaller(
        parseInstallerArgs(["--install-control", "--force", "--target", "codex", "--skip-health-check"]),
        dependencies(unreportedCalls, inspectAnswers({ codex: { "agent-acp": { command: uvx.command, args: uvx.args, env: undefined } } }), ["config is locked"])
      )),
      /: config is locked; the previous codex:agent-acp entry was restored, but not exactly \(codex did not report its env\); re-add what it needs$/
    );
    assert.deepEqual(unreportedCalls.filter(isMutation).at(-1), ["codex", "mcp", "add", "agent-acp", "--", uvx.command, ...uvx.args]);

    // Claude: the restore is the one command whose argv carries a token, the one the entry
    // had, and a CLI that echoes it, as text or as JSON, never gets it into the message.
    const oldClaudeEnv = { ACP_GATEWAY_CONTROL_TOKEN: "old-secret-token", ACP_GATEWAY_ROOT_ID: "main-old-claude-root" };
    await writeFile(claudeConfigPath, JSON.stringify({
      mcpServers: { "agent-acp": { type: "stdio", command: NODE, args: [gatewayScript("index.js")], env: oldClaudeEnv } }
    }), "utf8");
    const claudeForceCalls = [];
    const claudeAnswer = (command, args) => command === "claude" && args[1] === "get"
      ? { code: 0, stdout: claudeGetOutput(args[2], NODE, [gatewayScript("index.js")]), stderr: "" }
      : null;
    const echo = (command, args) => {
      const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.split("=")[1] ?? "none";
      const secret = value("ACP_GATEWAY_CONTROL_TOKEN");
      return `error: ${command} ${args.join(" ")}\n{"env":{"ACP_GATEWAY_CONTROL_TOKEN":"${secret}"}}\ntoken ${secret} was rejected for root ${value("ACP_GATEWAY_ROOT_ID")}`;
    };
    const claudeError = await withNode(() => runInstaller(
      parseInstallerArgs(["--install-control", "--force", "--target", "claude", "--skip-health-check"]),
      dependencies(claudeForceCalls, claudeAnswer, [echo, echo])
    )).then(() => assert.fail("the claude replacement should fail"), (error) => error);
    const current = await identityOf();
    for (const value of [current.token, current.rootId, ...Object.values(oldClaudeEnv)]) {
      assert.equal(claudeError.message.includes(value), false, value);
    }
    const shownOwnEnv = `-e ACP_GATEWAY_INSTALL_STATE=${statePath}`;
    assert.ok(claudeError.message.startsWith(`install claude:agent-acp failed (claude mcp add --scope user agent-acp ${shownOwnEnv} -- `));
    assert.match(claudeError.message, /restore the previous claude:agent-acp failed \(claude mcp add --scope user agent-acp -e ACP_GATEWAY_CONTROL_TOKEN=<redacted> -e ACP_GATEWAY_ROOT_ID=<redacted> -- /);
    assert.match(claudeError.message, /\{"env":\{"ACP_GATEWAY_CONTROL_TOKEN":"<redacted>"\}\}\ntoken <redacted> was rejected for root <redacted>; claude:agent-acp is no longer registered \(it launched: /);
    assert.deepEqual(claudeForceCalls.filter(isMutation), [
      ["claude", "mcp", "remove", "--scope", "user", "agent-acp"],
      ["claude", "mcp", "add", "--scope", "user", "agent-acp", "-e", `ACP_GATEWAY_INSTALL_STATE=${statePath}`, "--", NODE, gatewayScript("index.js")],
      ["claude", "mcp", "add", "--scope", "user", "agent-acp", ...envPairs("-e", oldClaudeEnv), "--", NODE, gatewayScript("index.js")]
    ]);

    // --force over an entry whose launch the CLI does not fully report: nothing to restore from, and it says so.
    const forceCalls = [];
    const auggieAnswer = (command, args) => command === "auggie" && args[1] === "list"
      ? { code: 0, stdout: JSON.stringify({ servers: [{ name: "agent-acp", transport: "stdio", command: NODE, source: "user" }] }), stderr: "" }
      : null;
    const auggieError = await withNode(() => runInstaller(
      parseInstallerArgs(["--install-control", "--force", "--target", "auggie", "--skip-health-check"]),
      dependencies(forceCalls, auggieAnswer, ["config is locked"])
    )).then(() => assert.fail("the auggie replacement should fail"), (error) => error);
    assert.ok(auggieError.message.startsWith(`install auggie:agent-acp failed (auggie mcp add-json agent-acp ${JSON.stringify({
      type: "stdio", command: NODE, args: [gatewayScript("index.js")], env: installStateEnv(statePath)
    })} --replace): config is locked; `));
    assert.match(auggieError.message, /; the previous auggie:agent-acp entry was removed and could not be restored because auggie did not report its full launch command; re-add it or rerun the installer$/);
    assert.equal(auggieError.message.includes((await identityOf()).token), false);
    assert.deepEqual(forceCalls.filter(isMutation).map((call) => call.slice(0, 3)), [["auggie", "mcp", "remove"], ["auggie", "mcp", "add-json"]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ------------------------------------------- the Control token out of agent configs (W5, W10)

test("W10: the Control MCP is registered without the token or Main ID, on argv and in the agent config", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-identity-free-")));
  // HOME is this test's directory, so the install state sits at its default path.
  const statePath = join(home, ".acp-gateway", "install.json");
  const calls = [];
  const everyAgent = ["codex", "claude", "grok", "auggie"].map((id) => ({ id, agentInstalled: true, adapterInstalled: true, install: null }));
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const result = await withNode(() => runInstaller(
      parseInstallerArgs(["--install-control", "--install-guide", "--target", "all", "--skip-health-check"]),
      {
        statePath,
        runtime,
        claudeConfigPath: join(home, ".claude.json"),
        agentConfigPaths: agentConfigsIn(home),
        detectProviders: async () => everyAgent,
        runCommand: nothingRegistered(calls)
      }
    ));
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const adds = calls.filter((call) => ["add", "add-json"].includes(call[2]));
    assert.equal(adds.length, 8);
    // No env at all: the front door reads the identity from install.json, at its default path.
    const control = (agent) => adds.find((call) => call[0] === agent && call.includes("agent-acp"));
    assert.deepEqual(control("codex"), ["codex", "mcp", "add", "agent-acp", "--", NODE, gatewayScript("index.js")]);
    assert.deepEqual(control("claude"), ["claude", "mcp", "add", "--scope", "user", "agent-acp", "--", NODE, gatewayScript("index.js")]);
    assert.deepEqual(control("grok"), ["grok", "mcp", "add", "--scope", "user", "agent-acp", "--", NODE, gatewayScript("index.js")]);
    assert.deepEqual(JSON.parse(control("auggie")[4]), { type: "stdio", command: NODE, args: [gatewayScript("index.js")], env: {} });
    for (const value of ["ACP_GATEWAY_CONTROL_TOKEN", "ACP_GATEWAY_ROOT_ID", "ACP_GATEWAY_INSTALL_STATE", state.identity.token, state.identity.rootId]) {
      assert.equal(JSON.stringify(calls).includes(value), false, value);
      assert.equal(JSON.stringify(result.actions).includes(value), false, value);
    }
    for (const agent of ["codex", "claude", "grok", "auggie"]) {
      assert.deepEqual(state.managedMcp[`${agent}:agent-acp`].launch, { command: NODE, args: [gatewayScript("index.js")], envKeys: [] });
    }
    assert.deepEqual(result.warnings, []);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("W5: entries the installer owns lose the Control token in place, and stay its own afterwards", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-migrate-")));
  const statePath = join(directory, "install.json");
  const claudeConfigPath = join(directory, ".claude.json");
  const everyAgent = ["codex", "grok", "claude"].map((id) => ({ id, agentInstalled: true, adapterInstalled: true, install: null }));
  try {
    // This install through a link the state records registering, as a pinned path would be.
    await symlink(dirname(gatewayScript("index.js")), join(directory, "current"));
    const linked = join(directory, "current", "index.js");
    // 1.7.2 registrations, each with the identity in its env and recorded that way.
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control", recordedControl(NODE, gatewayScript("index.js"))],
      ["grok", "agent-acp", "control", recordedControl(NODE, linked)],
      ["claude", "agent-acp", "control", recordedControl(NODE, gatewayScript("index.js"))]
    ]);
    const clis = rememberingClis({
      codex: { "agent-acp": { command: NODE, args: [gatewayScript("index.js")], env: identityEnv } },
      grok: { "agent-acp": { command: NODE, args: [linked], env: identityEnv } }
    });
    await writeFile(claudeConfigPath, JSON.stringify({
      mcpServers: { "agent-acp": { type: "stdio", command: NODE, args: [gatewayScript("index.js")], env: identityEnv } }
    }), "utf8");
    const answer = (command, args) => command === "claude" && args[1] === "get"
      ? { code: 0, stdout: claudeGetOutput(args[2], NODE, [gatewayScript("index.js")]), stderr: "" }
      : clis(command, args);
    const run = (argv, calls) => withNode(() => runInstaller(parseInstallerArgs(argv), {
      ...updateDependencies(statePath, directory, answer, calls),
      claudeConfigPath,
      detectProviders: async () => everyAgent
    }));
    const calls = [];
    const result = await run(["--install-control", "--target", "codex", "--target", "grok", "--target", "claude", "--skip-health-check"], calls);
    // Each already launches this install, so only the env changes; the launch stays as registered.
    assert.deepEqual(statusOf(result), { "codex:agent-acp": "updated", "grok:agent-acp": "updated", "claude:agent-acp": "updated" });
    for (const action of result.actions) {
      assert.deepEqual(action.removedEnv, ["ACP_GATEWAY_CONTROL_TOKEN", "ACP_GATEWAY_ROOT_ID"]);
      assert.deepEqual(action.next, action.previous);
    }
    assert.deepEqual(calls.filter(isMutation), [
      ["codex", "mcp", "remove", "agent-acp"],
      ["codex", "mcp", "add", "--env", `ACP_GATEWAY_INSTALL_STATE=${statePath}`, "agent-acp", "--", NODE, gatewayScript("index.js")],
      ["grok", "mcp", "remove", "agent-acp"],
      ["grok", "mcp", "add", "--scope", "user", "--env", `ACP_GATEWAY_INSTALL_STATE=${statePath}`, "agent-acp", "--", NODE, linked],
      ["claude", "mcp", "remove", "--scope", "user", "agent-acp"],
      ["claude", "mcp", "add", "--scope", "user", "agent-acp", "-e", `ACP_GATEWAY_INSTALL_STATE=${statePath}`, "--", NODE, gatewayScript("index.js")]
    ]);
    assert.equal(JSON.stringify(calls).includes(identityEnv.ACP_GATEWAY_CONTROL_TOKEN), false);
    // Old copies of the configs still hold the token: rotating it is recommended once, never done.
    assert.deepEqual(result.warnings, [rotateAdvice(3)]);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.identity.token, identityEnv.ACP_GATEWAY_CONTROL_TOKEN);
    assert.deepEqual(state.managedMcp["codex:agent-acp"].launch, identityFreeControl(NODE, gatewayScript("index.js")));
    assert.deepEqual(state.managedMcp["grok:agent-acp"].launch, identityFreeControl(NODE, linked));
    assert.deepEqual(state.managedMcp["claude:agent-acp"].launch, identityFreeControl(NODE, gatewayScript("index.js")));

    // The next run finds what it registered: nothing to do or say.
    const again = [];
    const second = await run(["--install-control", "--target", "codex", "--target", "grok", "--skip-health-check"], again);
    assert.deepEqual(statusOf(second), { "codex:agent-acp": "unchanged", "grok:agent-acp": "unchanged" });
    assert.deepEqual(again.filter(isMutation), []);
    assert.deepEqual(second.warnings, []);

    // An identity-free entry is still provably its own: gone stale, it is repointed like any
    // other, with nothing to take out. One still holding the token that launches another
    // Gateway keeps it: that install's front door may know no other place to read it from.
    const older = await gatewayTree(directory, "runtime/versions/1.4.0-older", "1.4.0");
    const newer = await gatewayTree(directory, "checkouts/next", "99.0.0", null);
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control", identityFreeControl(NODE, join(older, "index.js"))],
      ["grok", "agent-acp", "control", recordedControl(NODE, join(newer, "index.js"))]
    ]);
    clis.entries.codex["agent-acp"] = { command: NODE, args: [join(older, "index.js")], env: installStateEnv(statePath) };
    clis.entries.grok["agent-acp"] = { command: NODE, args: [join(newer, "index.js")], env: identityEnv };
    const later = [];
    const third = await run(["--install-control", "--target", "codex", "--target", "grok", "--skip-health-check"], later);
    assert.deepEqual(statusOf(third), { "codex:agent-acp": "updated", "grok:agent-acp": "unchanged" });
    assert.equal(third.actions.find((action) => action.agent === "codex").removedEnv, undefined);
    assert.deepEqual(later.filter(isMutation), [
      ["codex", "mcp", "remove", "agent-acp"],
      ["codex", "mcp", "add", "--env", `ACP_GATEWAY_INSTALL_STATE=${statePath}`, "agent-acp", "--", NODE, gatewayScript("index.js")]
    ]);
    assert.deepEqual(third.warnings, [
      "grok:agent-acp: it launches another Gateway install, whose front door may read the Control identity from this entry's env only, so its env is left as it is; rerun with --force to re-register it for this install",
      heldToken("grok:agent-acp")
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("W5: entries the installer cannot prove are its own keep the token, with a warning, and their agent config becomes private", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-unowned-token-")));
  const statePath = join(directory, "install.json");
  const configs = agentConfigsIn(directory);
  const everyAgent = ["codex", "grok", "claude"].map((id) => ({ id, agentInstalled: true, adapterInstalled: true, install: null }));
  const token = identityEnv.ACP_GATEWAY_CONTROL_TOKEN;
  try {
    await writeManagedState(statePath, [
      // Recorded, but its env changed since.
      ["codex", "agent-acp", "control", recordedControl(NODE, gatewayScript("index.js"))],
      // From before ownership records: nothing proves it is this installer's.
      ["grok", "agent-acp", "control"],
      // Recorded, but someone else's server now.
      ["claude", "agent-acp", "control", recordedControl(NODE, gatewayScript("index.js"))]
    ]);
    const claudeEntry = { type: "stdio", command: "/usr/local/bin/uvx", args: ["my-acp-server"], env: { ACP_GATEWAY_CONTROL_TOKEN: token } };
    // Grok and Claude keep the token in files others can read. This codex config is
    // readable too, but the entry codex reports lives elsewhere: it holds no such token.
    await writeFile(configs.grok, `[mcp_servers.agent-acp]\nenv = { ACP_GATEWAY_CONTROL_TOKEN = "${token}" }\n`, "utf8");
    await writeFile(configs.claude, JSON.stringify({ mcpServers: { "agent-acp": claudeEntry } }), "utf8");
    await writeFile(configs.codex, "[mcp_servers.other]\ncommand = \"other\"\n", "utf8");
    for (const path of Object.values(configs)) await chmod(path, 0o644);
    const inspect = inspectAnswers({
      codex: { "agent-acp": { command: NODE, args: [gatewayScript("index.js")], env: { ...identityEnv, HTTP_PROXY: "http://proxy.internal:3128" } } },
      grok: { "agent-acp": { command: NODE, args: [gatewayScript("index.js")], env: identityEnv } }
    });
    const answer = (command, args) => command === "claude" && args[1] === "get"
      ? { code: 0, stdout: claudeGetOutput(args[2], claudeEntry.command, claudeEntry.args), stderr: "" }
      : inspect(command, args);
    const run = (argv, calls) => withNode(() => runInstaller(parseInstallerArgs(argv), {
      ...updateDependencies(statePath, directory, answer, calls),
      claudeConfigPath: configs.claude,
      detectProviders: async () => everyAgent
    }));
    const argv = ["--install-control", "--target", "codex", "--target", "grok", "--target", "claude", "--skip-health-check"];
    const reasons = (tightened) => [
      "codex:agent-acp: its env is not the one this installer registered (a variable was added, removed or changed since), so it is left as it is; rerun with --force to re-register it without those changes",
      heldToken("codex:agent-acp"),
      "grok:agent-acp: the entry predates this installer's ownership records, so it cannot tell the entry is still its own and does not update it automatically; rerun with --force once to update it (later updates are automatic)",
      heldToken("grok:agent-acp", { tightened: tightened && configs.grok }),
      "claude:agent-acp: registered command is not one this installer wrote; rerun with --force to replace it",
      heldToken("claude:agent-acp", { tightened: tightened && configs.claude })
    ];

    // A dry run says so and changes nothing, permissions included.
    const planned = await run([...argv, "--dry-run"], []);
    assert.deepEqual(Object.values(statusOf(planned)), ["unchanged", "unchanged", "unchanged"]);
    assert.deepEqual(planned.warnings, reasons(false));
    for (const path of Object.values(configs)) assert.equal(await modeOf(path), 0o644);

    const calls = [];
    const result = await run(argv, calls);
    assert.deepEqual(Object.values(statusOf(result)), ["unchanged", "unchanged", "unchanged"]);
    assert.deepEqual(calls.filter(isMutation), []);
    // Nothing was taken out, so there is nothing to rotate for.
    assert.deepEqual(result.warnings, reasons(true));
    assert.equal(await modeOf(configs.grok), 0o600);
    assert.equal(await modeOf(configs.claude), 0o600);
    assert.equal(await modeOf(configs.codex), 0o644, "a config that does not hold the token is not the installer's to change");
    assert.equal(JSON.stringify(result).includes(token), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("W5: --rotate-token re-registers nothing that reads install.json, and warns about entries still holding a token", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-rotate-")));
  const statePath = join(directory, "install.json");
  const claudeConfigPath = join(directory, ".claude.json");
  const configs = agentConfigsIn(directory);
  const everyAgent = ["codex", "grok", "claude"].map((id) => ({ id, agentInstalled: true, adapterInstalled: true, install: null }));
  try {
    // Grok is identity-free already, Claude still holds the identity it was registered with,
    // and Codex is installed but has no Control entry.
    await writeManagedState(statePath, [
      ["grok", "agent-acp", "control", identityFreeControl(NODE, gatewayScript("index.js"))],
      ["claude", "agent-acp", "control", recordedControl(NODE, gatewayScript("index.js"))]
    ]);
    const clis = rememberingClis({ grok: { "agent-acp": { command: NODE, args: [gatewayScript("index.js")], env: installStateEnv(statePath) } } });
    await writeFile(claudeConfigPath, JSON.stringify({
      mcpServers: { "agent-acp": { type: "stdio", command: NODE, args: [gatewayScript("index.js")], env: identityEnv } }
    }), "utf8");
    const answer = (command, args) => command === "claude" && args[1] === "get"
      ? { code: 0, stdout: claudeGetOutput(args[2], NODE, [gatewayScript("index.js")]), stderr: "" }
      : clis(command, args);
    const run = (argv, calls) => withNode(() => runInstaller(parseInstallerArgs(argv), {
      ...updateDependencies(statePath, directory, answer, calls),
      claudeConfigPath,
      detectProviders: async () => everyAgent
    }));
    const calls = [];
    const result = await run(["--rotate-token", "--skip-health-check"], calls);
    const rotated = JSON.parse(await readFile(statePath, "utf8")).identity;
    assert.notEqual(rotated.token, identityEnv.ACP_GATEWAY_CONTROL_TOKEN);
    // The entries it manages, and no new front door on Codex.
    assert.deepEqual(result.targets.control, ["grok", "claude"]);
    assert.equal(calls.some((call) => call[0] === "codex"), false);
    // Grok reads the new identity from install.json as it is; Claude, provably this
    // installer's, gives up the retired one. Neither ever sees the new token.
    assert.deepEqual(statusOf(result), { "grok:agent-acp": "unchanged", "claude:agent-acp": "updated" });
    assert.deepEqual(calls.filter(isMutation), [
      ["claude", "mcp", "remove", "--scope", "user", "agent-acp"],
      ["claude", "mcp", "add", "--scope", "user", "agent-acp", "-e", `ACP_GATEWAY_INSTALL_STATE=${statePath}`, "--", NODE, gatewayScript("index.js")]
    ]);
    for (const value of [rotated.token, rotated.rootId, identityEnv.ACP_GATEWAY_CONTROL_TOKEN]) {
      assert.equal(JSON.stringify(calls).includes(value), false);
    }
    // A rotation already retires the old token: no advice to rotate again.
    assert.deepEqual(result.warnings, []);

    // An entry it cannot prove is its own keeps the token it had, which no longer works once
    // the daemon restarts with the new one, and is made private where it is world-readable.
    await writeManagedState(statePath, [["codex", "agent-acp", "control"]]);
    clis.entries.codex = { "agent-acp": { command: NODE, args: [gatewayScript("index.js")], env: identityEnv } };
    await writeFile(configs.codex, `[mcp_servers.agent-acp.env]\nACP_GATEWAY_CONTROL_TOKEN = "${identityEnv.ACP_GATEWAY_CONTROL_TOKEN}"\n`, "utf8");
    await chmod(configs.codex, 0o644);
    const leftCalls = [];
    const left = await run(["--rotate-token", "--skip-health-check"], leftCalls);
    assert.deepEqual(statusOf(left), { "codex:agent-acp": "unchanged" });
    assert.deepEqual(leftCalls.filter(isMutation), []);
    assert.deepEqual(left.warnings, [
      "codex:agent-acp: the entry predates this installer's ownership records, so it cannot tell the entry is still its own and does not update it automatically; rerun with --force once to update it (later updates are automatic)",
      heldToken("codex:agent-acp", { retired: true, tightened: configs.codex })
    ]);
    assert.equal(await modeOf(configs.codex), 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Astra I14: with no installer-managed Control entry (an app-managed install
// keeps only the identity), a rotation fell through to Codex, or the first CLI
// found, and registered a Control front door nobody had asked for.
test("--rotate-token registers no Control entry where the installer manages none, dry run included", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-rotate-unmanaged-")));
  const statePath = join(directory, "install.json");
  try {
    await writeManagedState(statePath, []);
    for (const dryRun of [true, false]) {
      const calls = [];
      const argv = ["--rotate-token", "--skip-health-check", ...(dryRun ? ["--dry-run"] : [])];
      const result = await withNode(() => runInstaller(parseInstallerArgs(argv), updateDependencies(statePath, directory, () => null, calls)));
      const label = dryRun ? "dry run" : "run";
      assert.deepEqual(result.targets.control, [], label);
      assert.deepEqual(result.actions.filter((action) => action.type === "mcp"), [], label);
      assert.deepEqual(calls.filter((call) => ["codex", "claude", "grok"].includes(call[0])), [], label);
    }
    // The rotation itself is install.json's alone.
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.notEqual(state.identity.token, identityEnv.ACP_GATEWAY_CONTROL_TOKEN);
    assert.deepEqual(state.managedMcp, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ------------------------------------------- install.json always says what is live

test("W5: each entry is recorded as soon as it is rewritten, so a later failure cannot strand it", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-record-at-once-")));
  const statePath = join(directory, "install.json");
  const nextNode = "/opt/test/next/bin/node";
  try {
    const older = await gatewayTree(directory, "runtime/versions/1.4.0-older", "1.4.0");
    // Two front doors registered by 1.7.2 with the identity in their env: Codex on an older install.
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control", recordedControl(NODE, join(older, "index.js"))],
      ["grok", "agent-acp", "control", recordedControl(NODE, gatewayScript("index.js"))]
    ]);
    // Grok refuses its first add: its replacement fails after Codex's went through.
    const clis = rememberingClis({
      codex: { "agent-acp": { command: NODE, args: [join(older, "index.js")], env: identityEnv } },
      grok: { "agent-acp": { command: NODE, args: [gatewayScript("index.js")], env: identityEnv } }
    }, { failAdds: { grok: 1 } });
    const options = parseInstallerArgs(["--install-control", "--target", "codex", "--target", "grok", "--skip-health-check"]);
    await assert.rejects(
      withNode(() => runInstaller(options, updateDependencies(statePath, directory, clis, []))),
      /: config is locked; the previous grok:agent-acp entry was restored$/
    );
    // install.json says what each CLI holds now: Codex moved here without its identity, Grok as it was.
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(clis.entries.codex["agent-acp"], { command: NODE, args: [gatewayScript("index.js")], env: installStateEnv(statePath) });
    assert.deepEqual(state.managedMcp["codex:agent-acp"].launch, identityFreeControl(NODE, gatewayScript("index.js")));
    assert.deepEqual(clis.entries.grok["agent-acp"], { command: NODE, args: [gatewayScript("index.js")], env: identityEnv });
    assert.deepEqual(state.managedMcp["grok:agent-acp"].launch, recordedControl(NODE, gatewayScript("index.js")));

    // The next run, under another node, proves both its own: both move to that node, and Grok
    // gives up its identity too.
    const calls = [];
    const next = await withNode(() => runInstaller(options, updateDependencies(statePath, directory, clis, calls)), nextNode);
    assert.deepEqual(statusOf(next), { "codex:agent-acp": "updated", "grok:agent-acp": "updated" });
    assert.deepEqual(calls.filter((call) => call[2] === "add"), [
      ["codex", "mcp", "add", "--env", `ACP_GATEWAY_INSTALL_STATE=${statePath}`, "agent-acp", "--", nextNode, gatewayScript("index.js")],
      ["grok", "mcp", "add", "--scope", "user", "--env", `ACP_GATEWAY_INSTALL_STATE=${statePath}`, "agent-acp", "--", nextNode, gatewayScript("index.js")]
    ]);
    assert.deepEqual(next.warnings, [rotateAdvice(1)]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("W5: a rotation cut short keeps the identity the live entries share, and a retry completes it", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-rotate-retry-")));
  const statePath = join(directory, "install.json");
  const retired = { token: identityEnv.ACP_GATEWAY_CONTROL_TOKEN, rootId: identityEnv.ACP_GATEWAY_ROOT_ID };
  const identityIn = (state) => ({ token: state.identity.token, rootId: state.identity.rootId });
  try {
    // Two front doors this installer registered with the identity in their env, both on this install.
    await writeManagedState(statePath, [
      ["codex", "agent-acp", "control", recordedControl(NODE, gatewayScript("index.js"))],
      ["grok", "agent-acp", "control", recordedControl(NODE, gatewayScript("index.js"))]
    ]);
    const clis = rememberingClis({
      codex: { "agent-acp": { command: NODE, args: [gatewayScript("index.js")], env: identityEnv } },
      grok: { "agent-acp": { command: NODE, args: [gatewayScript("index.js")], env: identityEnv } }
    }, { failAdds: { grok: 1 } });
    const rotate = parseInstallerArgs(["--rotate-token", "--skip-health-check"]);
    await assert.rejects(
      withNode(() => runInstaller(rotate, updateDependencies(statePath, directory, clis, []))),
      /: config is locked; the previous grok:agent-acp entry was restored$/
    );
    // Codex now reads install.json and Grok still holds the identity in its env. install.json keeps
    // that same identity, the one the running daemon accepts, so both front doors keep working.
    let state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(identityIn(state), retired);
    assert.deepEqual(clis.entries.codex["agent-acp"].env, installStateEnv(statePath));
    assert.deepEqual(state.managedMcp["codex:agent-acp"].launch, identityFreeControl(NODE, gatewayScript("index.js")));
    assert.deepEqual(clis.entries.grok["agent-acp"].env, identityEnv);
    assert.deepEqual(state.managedMcp["grok:agent-acp"].launch, recordedControl(NODE, gatewayScript("index.js")));

    // A retry still knows Grok as its own, moves it, and commits the new identity.
    const calls = [];
    const retried = await withNode(() => runInstaller(rotate, updateDependencies(statePath, directory, clis, calls)));
    assert.deepEqual(statusOf(retried), { "codex:agent-acp": "unchanged", "grok:agent-acp": "updated" });
    assert.deepEqual(retried.warnings, []);
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.notEqual(state.identity.token, retired.token);
    assert.notEqual(state.identity.rootId, retired.rootId);
    assert.equal(JSON.stringify(calls).includes(state.identity.token), false);
    assert.deepEqual(clis.entries.grok["agent-acp"].env, installStateEnv(statePath));
    assert.deepEqual(state.managedMcp["grok:agent-acp"].launch, identityFreeControl(NODE, gatewayScript("index.js")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("W5: a record a cut-short run left behind still proves an entry that only lost its identity, never a customized one", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-self-heal-")));
  const statePath = join(directory, "install.json");
  const customized = (key) => `${key}: its env is not the one this installer registered (a variable was added, removed or changed since), so it is left as it is; rerun with --force to re-register it without those changes`;
  try {
    const older = await gatewayTree(directory, "runtime/versions/1.4.0-older", "1.4.0");
    const launch = { command: NODE, args: [join(older, "index.js")] };
    // What a 1.7.2 registration recorded: the launch, with the identity in its env.
    const stale = recordedControl(launch.command, launch.args[0]);
    const run = (targets, entries, calls) => withNode(() => runInstaller(
      parseInstallerArgs(["--install-control", ...targets.flatMap((target) => ["--target", target]), "--skip-health-check"]),
      updateDependencies(statePath, directory, rememberingClis(entries), calls)
    ));

    // Both lost the identity in place, by a run killed before it recorded them: the records
    // still name the identity. Codex carries this installer's install-state variable, Grok,
    // registered from the default path, nothing. Both are still its own, and move when stale.
    await writeManagedState(statePath, [["codex", "agent-acp", "control", stale], ["grok", "agent-acp", "control", stale]]);
    const healed = await run(["codex", "grok"], {
      codex: { "agent-acp": { ...launch, env: installStateEnv(statePath) } },
      grok: { "agent-acp": { ...launch, env: {} } }
    }, []);
    assert.deepEqual(statusOf(healed), { "codex:agent-acp": "updated", "grok:agent-acp": "updated" });
    assert.deepEqual(healed.warnings, []);
    const records = JSON.parse(await readFile(statePath, "utf8")).managedMcp;
    assert.deepEqual(records["codex:agent-acp"].launch, identityFreeControl(NODE, gatewayScript("index.js")));
    assert.deepEqual(records["grok:agent-acp"].launch, identityFreeControl(NODE, gatewayScript("index.js")));

    // Any other difference is the user's, and such an entry is left as it is: a variable
    // added, a value changed, a recorded variable removed.
    await writeManagedState(statePath, [["codex", "agent-acp", "control", stale], ["grok", "agent-acp", "control", stale]]);
    const changedCalls = [];
    const changed = await run(["codex", "grok"], {
      codex: { "agent-acp": { ...launch, env: { HTTP_PROXY: "http://proxy.internal:3128" } } },
      grok: { "agent-acp": { ...launch, env: { ACP_GATEWAY_INSTALL_STATE: join(directory, "elsewhere.json") } } }
    }, changedCalls);
    assert.deepEqual(statusOf(changed), { "codex:agent-acp": "unchanged", "grok:agent-acp": "unchanged" });
    assert.deepEqual(changed.warnings, [customized("codex:agent-acp"), customized("grok:agent-acp")]);
    assert.deepEqual(changedCalls.filter(isMutation), []);

    await writeManagedState(statePath, [["codex", "agent-acp", "control", identityFreeControl(launch.command, launch.args[0])]]);
    const removedCalls = [];
    const removed = await run(["codex"], { codex: { "agent-acp": { ...launch, env: {} } } }, removedCalls);
    assert.deepEqual(removed.warnings, [customized("codex:agent-acp")]);
    assert.deepEqual(removedCalls.filter(isMutation), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ------------------------------------- a replaced install.json keeps no identity

// The installer replaces install.json by rename, and a rename replaces a name,
// not a file: a hard link a Worker made to install.json (link(2) needs no
// permission on the file) went on naming the old file, out of the protected
// directory and its inode check, with the identity it held. Every write now
// empties the file it replaced (replaceFile), and only once the rename succeeded.
test("a hard link to install.json holds nothing once the installer replaces the file, rotating or not", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-wipe-")));
  const statePath = join(directory, "install.json");
  try {
    await writeManagedState(statePath, [["codex", "agent-acp", "control", identityFreeControl(NODE, gatewayScript("index.js"))]]);
    const clis = rememberingClis({ codex: { "agent-acp": { command: NODE, args: [gatewayScript("index.js")], env: installStateEnv(statePath) } } });
    const run = (argv) => withNode(() => runInstaller(parseInstallerArgs(argv), updateDependencies(statePath, directory, clis, [])));

    // A run that keeps the identity writes the same token into a new file.
    const kept = join(directory, "kept.json");
    await link(statePath, kept);
    const result = await run(["--install-control", "--target", "codex", "--skip-health-check"]);
    assert.deepEqual(statusOf(result), { "codex:agent-acp": "unchanged" });
    assert.equal(await readFile(kept, "utf8"), "", "the link names the file that was replaced, now empty");
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).identity.token, identityEnv.ACP_GATEWAY_CONTROL_TOKEN, "install.json is whole");
    assert.equal(await modeOf(statePath), 0o600);

    // A rotation: the replaced file keeps neither the retired token nor the new one.
    const retired = join(directory, "retired.json");
    await link(statePath, retired);
    await run(["--rotate-token", "--skip-health-check"]);
    assert.equal(await readFile(retired, "utf8"), "");
    const rotated = JSON.parse(await readFile(statePath, "utf8")).identity;
    assert.notEqual(rotated.token, identityEnv.ACP_GATEWAY_CONTROL_TOKEN);
    assert.ok(rotated.token.length >= 24, "install.json holds the new identity");
    assert.equal(await modeOf(statePath), 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replacement of install.json empties only a replaced file another name holds, and never on a failed rename", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-installer-wipe-failed-")));
  const statePath = join(directory, "install.json");
  try {
    await writeManagedState(statePath, []);
    const before = await readFile(statePath, "utf8");
    const notes = join(directory, "notes.json");
    await link(statePath, notes);
    // A rename the kernel refuses: a directory cannot take the name of a file.
    const temporary = `${statePath}.4242.tmp`;
    await mkdir(temporary);
    assert.throws(() => replaceFile(temporary, statePath), (error) => ["ENOTDIR", "EISDIR"].includes(error.code));
    assert.equal(await readFile(statePath, "utf8"), before, "install.json is as it was");
    assert.equal(await readFile(notes, "utf8"), before, "and the file was never emptied");

    // A rename from one name of the file to another succeeds and replaces
    // nothing: install.json still names the file that was held, which stays whole.
    await rm(temporary, { recursive: true });
    await link(statePath, temporary);
    replaceFile(temporary, statePath);
    assert.equal(await readFile(statePath, "utf8"), before);

    // A symbolic link at the path is what a rename replaces, not the file it
    // leads to, which keeps its bytes.
    const kept = join(directory, "elsewhere.json");
    await writeFile(kept, before);
    const linked = join(directory, "linked.json");
    await symlink(kept, linked);
    await writeFile(`${linked}.4242.tmp`, "{}\n");
    replaceFile(`${linked}.4242.tmp`, linked);
    assert.equal(await readFile(linked, "utf8"), "{}\n");
    assert.equal(await readFile(kept, "utf8"), before);

    // A replaced file no other name holds is out of everyone's reach and is left
    // whole: a reader that opened it before the rename reads all of it, as an
    // atomic replacement promises (front doors and apps read install.json).
    const alone = join(directory, "alone.json");
    await writeFile(alone, before);
    const reader = await open(alone, "r");
    try {
      await writeFile(`${alone}.4242.tmp`, "{}\n");
      replaceFile(`${alone}.4242.tmp`, alone);
      assert.equal(await reader.readFile("utf8"), before);
    } finally {
      await reader.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

