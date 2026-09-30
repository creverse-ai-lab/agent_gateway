#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { validateMonitorConfig, validateSnapshot } from "./acp-upstream-monitor.js";
import { omitClaudeBinaryFromShrinkwrap } from "./omit-claude-binary.js";

const root = new URL("../", import.meta.url);

try {
  const config = JSON.parse(await readFile(new URL("config/acp-monitor.json", root), "utf8"));
  const snapshot = JSON.parse(await readFile(new URL("config/acp-upstream.snapshot.json", root), "utf8"));
  const packageDocument = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  validateMonitorConfig(config);
  validateSnapshot(snapshot, config);
  const updates = [];

  for (const [agentId, packageName] of Object.entries(config.managedNpmAdapters ?? {})) {
    const agent = snapshot.registry?.agents?.[agentId];
    const packageSpec = agent?.distribution?.npx?.package;
    const expectedSpec = `${packageName}@${agent?.version ?? ""}`;
    if (packageSpec !== expectedSpec) {
      throw new Error(`${agentId} registry distribution does not match ${expectedSpec}`);
    }
    const installed = packageDocument.dependencies?.[packageName];
    if (installed !== agent.version) updates.push({ agentId, packageName, before: installed, after: agent.version });
  }

  if (!updates.length) {
    process.stdout.write("Managed ACP npm adapters already match the upstream snapshot\n");
  } else {
    const specs = updates.map((item) => `${item.packageName}@${item.after}`);
    await run("npm", ["install", "--save-exact", ...specs]);
    // npm writes the new Claude Agent SDK's platform binaries back in.
    const omitted = await omitClaudeBinaryFromShrinkwrap(new URL("npm-shrinkwrap.json", root));
    if (omitted.length) process.stdout.write(`npm-shrinkwrap.json: omitted ${omitted.length} Claude platform binary references\n`);
    for (const update of updates) {
      process.stdout.write(`${update.agentId}: ${update.before ?? "missing"} -> ${update.after}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`sync-acp-dependencies: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? 1}`));
    });
  });
}
