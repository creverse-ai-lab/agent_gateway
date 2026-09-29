import assert from "node:assert/strict";
import test from "node:test";
import {
  checkGatewaySource,
  gatewayUpdateMessage,
  NPM_LATEST_URL,
  NPM_UPGRADE_COMMAND
} from "../src/gateway-source-monitor.js";
import { GATEWAY_VERSION } from "../src/version.js";

// Always one major ahead of whatever the current version is, so the fixtures
// survive release bumps.
const newerVersion = `${Number(GATEWAY_VERSION.split(".")[0]) + 1}.0.0`;
const noGit = async (_root, args) => {
  throw new Error(`git must not run: git ${args.join(" ")}`);
};
const noFetch = async (url) => {
  throw new Error(`fetch must not run: ${url}`);
};

test("Gateway source monitor reports a newer version on remote main", async () => {
  let requestedUrl;
  const result = await checkGatewaySource({
    installMode: "source",
    run: async () => "https://github.com/creverse-ai-lab/agent_gateway.git\n",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, text: async () => JSON.stringify({ version: newerVersion }) };
    },
    now: () => Date.parse("2026-08-02T00:00:00.000Z")
  });
  assert.equal(requestedUrl, "https://raw.githubusercontent.com/creverse-ai-lab/agent_gateway/main/package.json");
  assert.equal(result.installMode, "source");
  assert.equal(result.currentVersion, GATEWAY_VERSION);
  assert.equal(result.mainVersion, newerVersion);
  assert.equal(result.updateAvailable, true);
});

test("Gateway source monitor does not treat an older main as an update", async () => {
  const result = await checkGatewaySource({
    installMode: "source",
    run: async () => "git@github.com:creverse-ai-lab/agent_gateway.git\n",
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ version: "1.0.0" }) })
  });
  assert.equal(result.updateAvailable, false);
});

test("a failed source check is an error record carrying the install mode", async () => {
  const result = await checkGatewaySource({
    installMode: "source",
    run: async () => { throw new Error("Command failed: git config --get remote.origin.url"); },
    fetchImpl: noFetch
  });
  assert.deepEqual(result, {
    status: "error",
    installMode: "source",
    currentVersion: GATEWAY_VERSION,
    mainVersion: null,
    updateAvailable: false,
    error: "Command failed: git config --get remote.origin.url"
  });
});

test("an npm install compares with the registry's latest and never runs git", async () => {
  let requestedUrl;
  const result = await checkGatewaySource({
    installMode: "npm",
    run: noGit,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, text: async () => JSON.stringify({ name: "acp-gateway-daemon", version: newerVersion }) };
    },
    now: () => Date.parse("2026-09-30T00:00:00.000Z")
  });
  assert.equal(requestedUrl, "https://registry.npmjs.org/acp-gateway-daemon/latest");
  assert.equal(requestedUrl, NPM_LATEST_URL);
  assert.equal(result.status, "ready");
  assert.equal(result.installMode, "npm");
  assert.equal(result.currentVersion, GATEWAY_VERSION);
  assert.equal(result.latestVersion, newerVersion);
  assert.equal(result.mainVersion, null);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.updateCommand, "npm install -g acp-gateway-daemon@latest");
  assert.equal(result.checkedAt, "2026-09-30T00:00:00.000Z");
  assert.equal(
    gatewayUpdateMessage(result),
    `ACP Gateway ${newerVersion} is available on npm. Run \`npm install -g acp-gateway-daemon@latest\`, then \`acp-gateway-bootstrap --update\` when idle.`
  );
});

test("an npm install on the latest release reports no update", async () => {
  const result = await checkGatewaySource({
    installMode: "npm",
    run: noGit,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ version: GATEWAY_VERSION }) })
  });
  assert.equal(result.status, "ready");
  assert.equal(result.updateAvailable, false);
  assert.equal(result.updateCommand, undefined);
});

test("an unreachable npm registry is an error status, not a thrown check", async () => {
  const offline = await checkGatewaySource({
    installMode: "npm",
    run: noGit,
    fetchImpl: async () => { throw new TypeError("fetch failed"); }
  });
  assert.equal(offline.status, "error");
  assert.equal(offline.installMode, "npm");
  assert.equal(offline.updateAvailable, false);
  assert.equal(offline.error, "fetch failed");

  const unpublished = await checkGatewaySource({
    installMode: "npm",
    run: noGit,
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => "{}" })
  });
  assert.equal(unpublished.status, "error");
  assert.equal(unpublished.error, "npm registry returned HTTP 404");
});

test("an app-managed runtime is reported as managed without git or network", async () => {
  const result = await checkGatewaySource({ installMode: "runtime", run: noGit, fetchImpl: noFetch });
  assert.equal(result.status, "managed");
  assert.equal(result.installMode, "runtime");
  assert.equal(result.currentVersion, GATEWAY_VERSION);
  assert.equal(result.updateAvailable, false);
  assert.equal(result.error, undefined);
});

test("an unknown install layout is unsupported, quietly", async () => {
  const result = await checkGatewaySource({ installMode: "unknown", run: noGit, fetchImpl: noFetch });
  assert.equal(result.status, "unsupported");
  assert.equal(result.installMode, "unknown");
  assert.equal(result.updateAvailable, false);
  assert.equal(result.error, undefined);
});

test("the npm upgrade command names the published package", () => {
  assert.equal(NPM_UPGRADE_COMMAND, "npm install -g acp-gateway-daemon@latest");
  assert.equal(
    gatewayUpdateMessage({ mainVersion: "9.9.9" }),
    "ACP Gateway 9.9.9 is available on main. Run acp-gateway-bootstrap --update when ready."
  );
});
