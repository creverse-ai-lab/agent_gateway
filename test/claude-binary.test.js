import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claudePlatformBinaryReferences,
  findClaudePlatformPackages,
  isClaudePlatformPackage,
  omitClaudeBinaryFromShrinkwrap,
  withoutClaudePlatformBinaries
} from "../scripts/omit-claude-binary.js";
import { RUNTIME_INSTALL_ARGS } from "../scripts/runtime-release-lib.js";

const SDK = "node_modules/@anthropic-ai/claude-agent-sdk";

function lockfile() {
  return {
    name: "acp-gateway-daemon",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@agentclientprotocol/claude-agent-acp": "0.64.2" } },
      [SDK]: {
        version: "0.3.220",
        optionalDependencies: {
          "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.220",
          "@anthropic-ai/claude-agent-sdk-linux-x64-musl": "0.3.220"
        },
        peerDependencies: { zod: "^4.0.0" }
      },
      [`${SDK}-darwin-arm64`]: { version: "0.3.220", optional: true, os: ["darwin"], cpu: ["arm64"] },
      "node_modules/other/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl": { version: "0.3.220", optional: true },
      "node_modules/fsevents-user": { version: "1.0.0", optionalDependencies: { fsevents: "2.3.3" } },
      "node_modules/fsevents": { version: "2.3.3", optional: true }
    }
  };
}

test("only the Claude Agent SDK's platform packages count as the bundled binary", () => {
  assert.equal(isClaudePlatformPackage("@anthropic-ai/claude-agent-sdk-darwin-arm64"), true);
  assert.equal(isClaudePlatformPackage("@anthropic-ai/claude-agent-sdk-linux-x64-musl"), true);
  assert.equal(isClaudePlatformPackage("@anthropic-ai/claude-agent-sdk"), false);
  assert.equal(isClaudePlatformPackage("@anthropic-ai/sdk"), false);
  assert.equal(isClaudePlatformPackage("claude-agent-sdk-darwin-arm64"), false);
});

test("the shrinkwrap loses the platform binaries and their optional names, nothing else", () => {
  const before = lockfile();
  assert.equal(claudePlatformBinaryReferences(before).length, 4);
  const after = withoutClaudePlatformBinaries(before);
  assert.deepEqual(claudePlatformBinaryReferences(after), []);
  assert.deepEqual(Object.keys(after.packages), ["", SDK, "node_modules/fsevents-user", "node_modules/fsevents"]);
  // npm ci compares the lockfile's own edges: an optional name left behind
  // without its entry is "Missing from lock file".
  assert.equal("optionalDependencies" in after.packages[SDK], false);
  assert.deepEqual(after.packages[SDK], { version: "0.3.220", peerDependencies: { zod: "^4.0.0" } });
  assert.deepEqual(after.packages["node_modules/fsevents-user"], before.packages["node_modules/fsevents-user"]);
  assert.deepEqual(withoutClaudePlatformBinaries(after), after, "idempotent");
  assert.equal(claudePlatformBinaryReferences(before).length, 4, "the input is not modified");
});

test("a platform binary that is a required dependency is refused, not dropped", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "acp-omit-claude-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "npm-shrinkwrap.json");
  const document = lockfile();
  document.packages["node_modules/pinned"] = { dependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.220" } };
  await writeFile(path, JSON.stringify(document));
  await assert.rejects(omitClaudeBinaryFromShrinkwrap(path), /cannot omit a required Claude platform binary: node_modules\/pinned dependencies/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), document, "nothing is written");

  delete document.packages["node_modules/pinned"];
  await writeFile(path, JSON.stringify(document));
  assert.equal((await omitClaudeBinaryFromShrinkwrap(path)).length, 4);
  const written = await readFile(path, "utf8");
  assert.ok(written.endsWith("}\n") && written.includes('\n  "packages": {'), "written like npm writes lockfiles");
  assert.deepEqual(await omitClaudeBinaryFromShrinkwrap(path), [], "a second run changes nothing");
});

test("the committed shrinkwrap pins the SDK but none of its platform binaries", async () => {
  const shrinkwrap = JSON.parse(await readFile(new URL("../npm-shrinkwrap.json", import.meta.url), "utf8"));
  assert.deepEqual(claudePlatformBinaryReferences(shrinkwrap), []);
  assert.match(shrinkwrap.packages[SDK]?.version ?? "", /^\d+\.\d+\.\d+/);
  assert.ok(shrinkwrap.packages["node_modules/@agentclientprotocol/claude-agent-acp"]);
});

test("installed platform binaries are found hoisted or nested, the SDK itself is not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-find-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(findClaudePlatformPackages(root), []);
  await mkdir(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk"), { recursive: true });
  await mkdir(join(root, "node_modules", "@anthropic-ai", "sdk"), { recursive: true });
  await mkdir(join(root, "vendor", "@anthropic-ai", "claude-agent-sdk-darwin-arm64"), { recursive: true });
  assert.deepEqual(findClaudePlatformPackages(root), [], "only node_modules/@anthropic-ai counts");
  await mkdir(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "bin"), { recursive: true });
  await mkdir(join(root, "lib", "node_modules", "gw", "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64"), { recursive: true });
  assert.deepEqual(findClaudePlatformPackages(root), [
    "lib/node_modules/gw/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64",
    "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"
  ]);
});

test("the runtime release installs production dependencies without optional ones", () => {
  assert.deepEqual([...RUNTIME_INSTALL_ARGS], ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--os=darwin", "--cpu=arm64"]);
});
