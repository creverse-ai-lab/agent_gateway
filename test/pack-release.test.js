import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PREPACK_SCRIPT,
  installedTree,
  lockedProductionTree,
  lockfileBundleProblems,
  packReport,
  treeProblems
} from "../scripts/pack-release.js";

function documents() {
  const packageDocument = {
    name: "acp-gateway-daemon",
    version: "1.7.2",
    dependencies: { a: "1.0.0", "@s/b": "2.0.0" },
    bundleDependencies: ["a", "@s/b"]
  };
  const lockDocument = {
    name: "acp-gateway-daemon",
    lockfileVersion: 3,
    packages: {
      "": { name: "acp-gateway-daemon", version: "1.7.2", dependencies: { "@s/b": "2.0.0", a: "1.0.0" } },
      "node_modules/a": { version: "1.0.0", inBundle: true, dependencies: { c: "^1.0.0" } },
      "node_modules/@s/b": { version: "2.0.0", inBundle: true },
      "node_modules/c": { version: "1.2.0", inBundle: true },
      "node_modules/a/node_modules/c": { version: "0.9.0", inBundle: true }
    }
  };
  return { packageDocument, lockDocument };
}

async function install(root, path, name, version) {
  await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, path, "package.json"), JSON.stringify({ name, version }));
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "acp-pack-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await install(root, "node_modules/a", "a", "1.0.0");
  await install(root, "node_modules/@s/b", "@s/b", "2.0.0");
  await install(root, "node_modules/c", "c", "1.2.0");
  await install(root, "node_modules/a/node_modules/c", "c", "0.9.0");
  await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(root, "node_modules", ".package-lock.json"), "{}");
  return root;
}

test("a lockfile of plain production packages bundles as is", () => {
  const { packageDocument, lockDocument } = documents();
  assert.deepEqual(lockfileBundleProblems(packageDocument, lockDocument), []);
  assert.deepEqual([...lockedProductionTree(lockDocument)], [
    ["node_modules/a", { name: "a", version: "1.0.0" }],
    ["node_modules/@s/b", { name: "@s/b", version: "2.0.0" }],
    ["node_modules/c", { name: "c", version: "1.2.0" }],
    ["node_modules/a/node_modules/c", { name: "c", version: "0.9.0" }]
  ]);
});

test("the bundle must cover every dependency, and only a tree npm bundles in full", () => {
  const { packageDocument, lockDocument } = documents();
  assert.match(
    lockfileBundleProblems({ ...packageDocument, bundleDependencies: ["a"] }, lockDocument).join("\n"),
    /bundleDependencies must list exactly the dependencies/
  );
  assert.match(lockfileBundleProblems({ ...packageDocument, bundleDependencies: true }, lockDocument).join("\n"), /bundleDependencies/);
  assert.match(
    lockfileBundleProblems({ ...packageDocument, optionalDependencies: { d: "1.0.0" } }, lockDocument).join("\n"),
    /optionalDependencies are not bundled/
  );
  const drifted = structuredClone(lockDocument);
  drifted.packages[""].dependencies.a = "1.0.1";
  assert.match(lockfileBundleProblems(packageDocument, drifted).join("\n"), /dependencies differ from package\.json/);

  const flagged = structuredClone(lockDocument);
  flagged.packages["node_modules/c"].peer = true;
  flagged.packages["node_modules/@s/b"].optional = true;
  flagged.packages["node_modules/a"].optionalDependencies = { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.220" };
  flagged.packages["node_modules/dev-only"] = { version: "1.0.0", dev: true, optional: true };
  const problems = lockfileBundleProblems(packageDocument, flagged).join("\n");
  assert.match(problems, /node_modules\/c is only a peer dependency, which npm pack does not bundle; add c as an exact dependency/);
  assert.match(problems, /node_modules\/@s\/b is optional/);
  assert.match(problems, /lists a Claude platform binary/);
  assert.doesNotMatch(problems, /dev-only/, "dev packages are never bundled");
});

test("node_modules must be exactly the locked production tree", async (t) => {
  const root = await fixture(t);
  const { lockDocument } = documents();
  assert.deepEqual(treeProblems(root, lockDocument), []);
  assert.deepEqual([...installedTree(root).keys()].sort(), [
    "node_modules/@s/b", "node_modules/a", "node_modules/a/node_modules/c", "node_modules/c"
  ], "npm's dot entries are not packages");

  await install(root, "node_modules/a/node_modules/c", "c", "1.2.0");
  await install(root, "node_modules/extra", "extra", "1.0.0");
  await install(root, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64", "@anthropic-ai/claude-agent-sdk-linux-x64", "0.3.220");
  await rm(join(root, "node_modules/@s/b"), { recursive: true });
  await symlink(join(root, "node_modules/c"), join(root, "node_modules/@s/b"));
  assert.deepEqual(treeProblems(root, lockDocument, { label: "tree" }), [
    "tree: node_modules/@s/b is a symlink",
    "tree: node_modules/a/node_modules/c is c@1.2.0, locked c@0.9.0",
    "tree: node_modules/@anthropic-ai/claude-agent-sdk-linux-x64@0.3.220 is not in the locked production tree",
    "tree: node_modules/extra@1.0.0 is not in the locked production tree",
    "tree: node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 is a Claude platform binary package"
  ]);
  await rm(join(root, "node_modules/c"), { recursive: true });
  assert.ok(treeProblems(root, lockDocument).includes("node_modules: node_modules/c is missing (locked 1.2.0)"));
  await rm(join(root, "node_modules"), { recursive: true });
  assert.deepEqual(treeProblems(root, lockDocument), ["node_modules: no packages installed (4 locked)"]);
});

test("a locked dev package may sit in a checkout but never in the bundle", async (t) => {
  const root = await fixture(t);
  const { lockDocument } = documents();
  lockDocument.packages["node_modules/tool"] = { version: "3.0.0", dev: true };
  await install(root, "node_modules/tool", "tool", "3.0.0");
  assert.deepEqual(treeProblems(root, lockDocument), []);
  assert.deepEqual(treeProblems(root, lockDocument, { exact: true, label: "tarball" }), [
    "tarball: node_modules/tool@3.0.0 is not in the locked production tree"
  ]);
});

test("npm pack --json is read in the npm 10/11 and npm 12 shapes", () => {
  const report = { name: "acp-gateway-daemon", filename: "acp-gateway-daemon-1.7.2.tgz", files: [] };
  assert.deepEqual(packReport(JSON.stringify([report])), report);
  assert.deepEqual(packReport(JSON.stringify({ "acp-gateway-daemon": report })), report);
  assert.throws(() => packReport("[]"), /unexpected npm pack --json output/);
});

test("the package bundles its dependencies and packs only through the checked path", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const packageDocument = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lockDocument = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  assert.deepEqual(lockfileBundleProblems(packageDocument, lockDocument), []);
  assert.equal(packageDocument.scripts.prepack, PREPACK_SCRIPT);
  const publish = await readFile(join(root, ".github/workflows/publish-npm.yml"), "utf8");
  assert.match(publish, /^\s+- run: npm ci --omit=optional$/m, "the release tree is installed without optional packages");
  assert.match(publish, /node scripts\/pack-release\.js --pack-destination "\$directory"/);
  assert.doesNotMatch(publish, /npm pack\b/, "the publish workflow must not pack around the checks");
  const smoke = await readFile(join(root, "scripts/npm-smoke.js"), "utf8");
  assert.match(smoke, /packRelease\(/);
  assert.doesNotMatch(smoke, /"pack",/, "the smoke test must not pack around the checks");
});
