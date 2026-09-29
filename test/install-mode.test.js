import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { classifyInstallMode, detectInstallMode, INSTALL_MODES } from "../src/install-mode.js";

test("install mode: a package root with .git is a source checkout", () => {
  assert.equal(classifyInstallMode({ root: "/Users/me/dev/agent_gateway", hasGit: true }), "source");
  // npm link / a folder install is a symlink Node resolves to the checkout, but
  // even a checkout that happens to sit under node_modules is still a checkout.
  assert.equal(classifyInstallMode({ root: "/work/node_modules/acp-gateway-daemon", hasGit: true }), "source");
});

test("install mode: a root inside node_modules without .git is an npm install", () => {
  for (const root of [
    "/usr/local/lib/node_modules/acp-gateway-daemon",
    "/opt/homebrew/lib/node_modules/acp-gateway-daemon",
    // nvm keeps Node under .../versions/node/...: "versions" alone is not a runtime release.
    "/Users/me/.nvm/versions/node/v22.18.0/lib/node_modules/acp-gateway-daemon",
    "/Users/me/Library/pnpm/global/5/node_modules/.pnpm/acp-gateway-daemon@1.7.0/node_modules/acp-gateway-daemon",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\acp-gateway-daemon"
  ]) {
    assert.equal(classifyInstallMode({ root }), "npm", root);
  }
});

test("install mode: an app-managed runtime release layout is runtime", () => {
  // The GitHub runtime release as the desktop app installs it today.
  assert.equal(classifyInstallMode({ root: "/Users/me/.acp-gateway/runtime/versions/1.7.0-0123abcd/gateway" }), "runtime");
  // The npm package installed by the app into its own runtime layout: inside
  // node_modules AND under runtime/versions. The app owns it, so runtime wins
  // over npm (no npm upgrade alert, no `npm install -g` suggestion).
  assert.equal(
    classifyInstallMode({ root: "/Users/me/.acp-gateway/runtime/versions/1.8.0/node_modules/acp-gateway-daemon" }),
    "runtime"
  );
  assert.equal(
    classifyInstallMode({ root: "/Users/me/.acp-gateway/runtime/versions/1.8.0-abc/gateway/node_modules/acp-gateway-daemon" }),
    "runtime"
  );
  // A runtime-manifest.json is written only by the runtime release build.
  assert.equal(classifyInstallMode({ root: "/tmp/extract/acp-gateway-runtime", hasRuntimeManifest: true }), "runtime");
  // runtime/versions itself, with no version below it, is not a release root.
  assert.equal(classifyInstallMode({ root: "/Users/me/.acp-gateway/runtime/versions" }), "unknown");
});

test("install mode: anything else is unknown", () => {
  assert.equal(classifyInstallMode({ root: "/opt/acp-gateway" }), "unknown");
  assert.equal(classifyInstallMode({ root: "" }), "unknown");
  assert.equal(classifyInstallMode(), "unknown");
  assert.deepEqual(INSTALL_MODES, ["source", "npm", "runtime", "unknown"]);
});

test("install mode detection probes .git and runtime-manifest.json under the root", () => {
  const probe = (present) => {
    const seen = [];
    const exists = (path) => {
      seen.push(path);
      return present.includes(path);
    };
    return { seen, exists };
  };
  const npmRoot = "/usr/local/lib/node_modules/acp-gateway-daemon";
  const npm = probe([]);
  assert.equal(detectInstallMode(npmRoot, { exists: npm.exists }), "npm");
  assert.deepEqual(npm.seen, [join(npmRoot, ".git"), join(npmRoot, "runtime-manifest.json")]);

  const checkout = probe([join("/src/gw", ".git")]);
  assert.equal(detectInstallMode("/src/gw", { exists: checkout.exists }), "source");

  const release = probe([join("/tmp/acp-gateway-runtime", "runtime-manifest.json")]);
  assert.equal(detectInstallMode("/tmp/acp-gateway-runtime", { exists: release.exists }), "runtime");
});
