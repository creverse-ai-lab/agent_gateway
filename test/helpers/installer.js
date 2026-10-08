import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstaller as runRealInstaller } from "../../src/installer.js";

// runInstaller as the installer tests call it. Every default the installer
// takes from the developer's home is a real file it may write: install.json
// and providers.json under ~/.acp-gateway, the agent CLIs' MCP configs and
// skill directories, and, through the official registry loader, the registry
// cache beside them (refreshed over the network). A test passes the ones it
// looks at; each one it leaves out points into a directory of its own, removed
// after the run. What would leave the process gets a stand-in: the registry is
// empty, npm lists nothing installed, and any other command, a daemon restart
// or a health check the test did not provide for fails the test instead.
export async function runInstaller(options, dependencies = {}) {
  const directory = await mkdtemp(join(tmpdir(), "acp-installer-defaults-"));
  const claudeConfigPath = dependencies.claudeConfigPath ?? join(directory, ".claude.json");
  try {
    return await runRealInstaller(options, {
      statePath: join(directory, "install.json"),
      providerRegistryPath: join(directory, "providers.json"),
      skillRoots: Object.fromEntries(["codex", "claude", "grok", "auggie", "default"]
        .map((agent) => [agent, join(directory, `${agent}-skills`)])),
      detectProviders: async () => [],
      registryLoader: async () => ({ registry: { version: "1.0.0", agents: [] }, source: "network", stale: false }),
      runCommand: async (command, args) => {
        if (command === "npm" && args[0] === "list") return { code: 0, stdout: "{\"dependencies\":{}}", stderr: "" };
        throw new Error(`the test gave the installer no runCommand for: ${command} ${args.join(" ")}`);
      },
      restartGateway: async () => {
        throw new Error("the test gave the installer no restartGateway: it would restart the real daemon");
      },
      rpcFactory: () => {
        throw new Error("the test gave the installer no rpcFactory: it would call the real daemon");
      },
      ...dependencies,
      claudeConfigPath,
      // Per agent, as the installer merges them: one a test leaves out is a
      // stand-in too, never the real file.
      agentConfigPaths: {
        codex: join(directory, "codex-config.toml"),
        claude: claudeConfigPath,
        grok: join(directory, "grok-config.toml"),
        ...dependencies.agentConfigPaths
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
