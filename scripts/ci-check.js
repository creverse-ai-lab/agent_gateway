#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseInstallerArgs } from "../src/installer.js";
import { CRASH_POINTS } from "../src/state-store.js";
import { GATEWAY_VERSION } from "../src/version.js";
import { ACP_PROTOCOL_VERSION } from "../src/acp-version.js";
import { compareSnapshots, validateMonitorConfig, validateSnapshot } from "./acp-upstream-monitor.js";

const packageDocument = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lockDocument = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const monitorConfig = JSON.parse(await readFile(new URL("../config/acp-monitor.json", import.meta.url), "utf8"));
const upstreamSnapshot = JSON.parse(await readFile(new URL("../config/acp-upstream.snapshot.json", import.meta.url), "utf8"));

assert.equal(packageDocument.version, GATEWAY_VERSION, "package and Gateway versions must match");
assert.equal(lockDocument.version, GATEWAY_VERSION, "lockfile and Gateway versions must match");
assert.equal(lockDocument.packages[""].version, GATEWAY_VERSION, "lockfile root package version must match");
assert.deepEqual(
  packageDocument.exports,
  { ".": "./gateway-client/index.js", "./client": "./gateway-client/index.js" },
  "only the public client entrypoint may be imported as a package subpath"
);
// The README title is the version a user reads before installing, and the
// installer gates on an exact match with the running gateway. Three places,
// one number, checked here so a release cannot ship two of the three.
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
assert.equal(
  readme.split("\n", 1)[0],
  `# ACP Gateway v${GATEWAY_VERSION}`,
  "README title and Gateway versions must match"
);
validateMonitorConfig(monitorConfig);
validateSnapshot(upstreamSnapshot, monitorConfig);
assert.deepEqual(
  monitorConfig.supportedWireVersions,
  [ACP_PROTOCOL_VERSION],
  "runtime ACP protocol version and monitor config must match"
);
for (const [agentId, packageName] of Object.entries(monitorConfig.managedNpmAdapters)) {
  const upstreamVersion = upstreamSnapshot.registry.agents[agentId]?.version;
  assert.equal(
    packageDocument.dependencies?.[packageName],
    upstreamVersion,
    `${packageName} must match the monitored ${agentId} version`
  );
}

const reorderedSnapshot = structuredClone(upstreamSnapshot);
const sampleAgent = monitorConfig.watchedAgents[0];
const sampleDistribution = reorderedSnapshot.registry.agents[sampleAgent].distribution;
reorderedSnapshot.registry.agents[sampleAgent].distribution = Object.fromEntries(
  Object.entries(sampleDistribution).reverse()
);
assert.deepEqual(
  compareSnapshots(upstreamSnapshot, reorderedSnapshot, monitorConfig),
  [],
  "distribution object key order must not create a false upstream change"
);

// The single production crash hook is only defensible while the matrix actually
// exercises every point it accepts, so the name set and the matrix must agree.
const crashMatrix = await readFile(new URL("../test/crash-matrix.test.js", import.meta.url), "utf8");
assert.deepEqual(CRASH_POINTS, ["task_create_durable"], "a new crash point needs a matrix case and a review");
for (const point of CRASH_POINTS) {
  assert.ok(
    crashMatrix.includes(`ACP_GATEWAY_CRASH_AFTER: "${point}"`),
    `crash point ${point} has no case in test/crash-matrix.test.js`
  );
}

const install = parseInstallerArgs(["--install-all"]);
assert.equal(install.installSkill, true, "first install must include the delegation skill");
const update = parseInstallerArgs(["--update"]);
assert.equal(update.installSkill, false, "updates must preserve customized skills");
assert.equal(update.restartDaemon, true, "updates must restart the daemon");
const skillUpdate = parseInstallerArgs(["--update-skill"]);
assert.equal(skillUpdate.updateSkill, true, "skill updates must use the managed-copy update path");
assert.equal(skillUpdate.update, false, "skill updates must not pull or update runtime components");
assert.equal(skillUpdate.restartDaemon, false, "skill-only updates must not restart the daemon");

process.stdout.write("ACP Gateway CI checks passed\n");
