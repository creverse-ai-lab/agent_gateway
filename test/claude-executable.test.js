import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  detectProviders,
  legacyClaudeExecutable,
  ownDependencyRoots,
  providerConfig,
  resolveClaudeExecutable
} from "../src/providers.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function executable(path, mode = 0o755) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, mode);
  return path;
}

// One machine's worth of places a `claude` can be: Homebrew, an npm global
// install (a bin symlink into that prefix's node_modules), the native installer,
// this package's own node_modules (.bin and the SDK's bundled binary), plus a
// non-executable file and a directory that only look like one.
async function machine(t) {
  const root = await mkdtemp(join(tmpdir(), "acp-claude-exe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    root,
    home: join(root, "home"),
    brew: join(root, "brew", "bin"),
    npmGlobal: join(root, "npm-global", "bin"),
    own: join(root, "gateway", "node_modules"),
    shim: join(root, "shim"),
    noexec: join(root, "noexec"),
    directory: join(root, "directory"),
    empty: join(root, "empty")
  };
  await executable(join(paths.brew, "claude"));
  const npmClaude = await executable(join(root, "npm-global", "lib", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  await mkdir(paths.npmGlobal, { recursive: true });
  await symlink(npmClaude, join(paths.npmGlobal, "claude"));
  await executable(join(paths.own, ".bin", "claude"));
  const bundled = await executable(join(paths.own, "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "claude"));
  await mkdir(paths.shim, { recursive: true });
  await symlink(bundled, join(paths.shim, "claude"));
  await executable(join(paths.noexec, "claude"), 0o644);
  await mkdir(join(paths.directory, "claude"), { recursive: true });
  await mkdir(paths.empty, { recursive: true });
  return paths;
}

function resolve(paths, env, extra = {}) {
  return resolveClaudeExecutable({ env, home: paths.home, excludedRoots: [paths.own], ...extra });
}

test("CLAUDE_CODE_EXECUTABLE wins as given, even over PATH and when it does not exist", async (t) => {
  const paths = await machine(t);
  await executable(legacyClaudeExecutable(paths.home));
  assert.equal(resolve(paths, { CLAUDE_CODE_EXECUTABLE: "/opt/custom/claude", PATH: paths.brew }), "/opt/custom/claude");
});

test("a whitespace-only CLAUDE_CODE_EXECUTABLE counts as unset", async (t) => {
  const paths = await machine(t);
  assert.equal(resolve(paths, { CLAUDE_CODE_EXECUTABLE: " \t ", PATH: paths.brew }), join(paths.brew, "claude"));
  assert.equal(resolve(paths, { CLAUDE_CODE_EXECUTABLE: "", PATH: paths.brew }), join(paths.brew, "claude"));
  assert.equal(resolve(paths, { CLAUDE_CODE_EXECUTABLE: " /opt/custom/claude\n", PATH: paths.brew }), "/opt/custom/claude");
});

test("relative PATH entries are ignored", async (t) => {
  const paths = await machine(t);
  const relativeBrew = relative(process.cwd(), paths.brew);
  assert.equal(relativeBrew.startsWith("/"), false);
  assert.equal(resolve(paths, { PATH: relativeBrew }), null, "resolvable from this cwd, still skipped");
  assert.equal(resolve(paths, { PATH: [relativeBrew, paths.npmGlobal].join(":") }), join(paths.npmGlobal, "claude"));
});

test("any project's bundled platform binary is refused, not only this package's", async (t) => {
  const paths = await machine(t);
  const foreign = join(paths.root, "other-project", "node_modules");
  const bundled = await executable(join(foreign, "@anthropic-ai", "claude-agent-sdk-linux-x64", "claude"));
  await mkdir(join(foreign, ".bin"), { recursive: true });
  await symlink(bundled, join(foreign, ".bin", "claude"));
  assert.equal(resolve(paths, { PATH: join(foreign, ".bin") }), null, "a .bin shim into it");
  assert.equal(resolve(paths, { PATH: dirname(bundled) }), null, "its own directory on PATH");
  assert.equal(resolve(paths, { PATH: [join(foreign, ".bin"), paths.brew].join(":") }), join(paths.brew, "claude"));
});

test("a claude on PATH outside ~/.local/bin is found, first match first", async (t) => {
  const paths = await machine(t);
  const PATH = [paths.noexec, paths.directory, paths.brew, paths.npmGlobal].join(":");
  assert.equal(resolve(paths, { PATH }), join(paths.brew, "claude"), "non-executable files and directories are skipped");
  // An npm global CLI lives in its prefix's node_modules; only this package's own tree is excluded.
  assert.equal(resolve(paths, { PATH: [paths.npmGlobal, paths.brew].join(":") }), join(paths.npmGlobal, "claude"));
});

test("PATH comes before the legacy ~/.local/bin/claude, which is used when PATH has none", async (t) => {
  const paths = await machine(t);
  const legacy = await executable(legacyClaudeExecutable(paths.home));
  assert.equal(resolve(paths, { PATH: paths.brew }), join(paths.brew, "claude"));
  assert.equal(resolve(paths, { PATH: paths.empty }), legacy);
  assert.equal(resolve(paths, {}), legacy, "no PATH at all");
  // The usual native install: ~/.local/bin is on PATH, so PATH finds the same file.
  assert.equal(resolve(paths, { PATH: [dirname(legacy), paths.brew].join(":") }), legacy);
});

test("nothing inside this package's own node_modules counts as the user's CLI", async (t) => {
  const paths = await machine(t);
  const PATH = [join(paths.own, ".bin"), paths.shim].join(":");
  assert.equal(resolve(paths, { PATH }), null, "a .bin entry and a symlink to the bundled binary are both skipped");
  assert.equal(resolve(paths, { PATH: [PATH, paths.brew].join(":") }), join(paths.brew, "claude"));
  const legacy = await executable(legacyClaudeExecutable(paths.home));
  assert.equal(resolve(paths, { PATH }), legacy);
});

test("no CLI anywhere resolves to null", async (t) => {
  const paths = await machine(t);
  assert.equal(resolve(paths, { PATH: [paths.empty, paths.noexec, paths.directory].join(":") }), null);
  assert.equal(resolve(paths, { PATH: paths.brew }, { isExecutable: () => false }), null, "the file check is injectable");
});

test("the package's own dependency trees are excluded by default", () => {
  assert.ok(ownDependencyRoots().includes(join(repositoryRoot, "node_modules")));
});

test("detection and the Claude worker env use the same resolved CLI", async (t) => {
  const paths = await machine(t);
  const saved = Object.fromEntries(
    ["PATH", "HOME", "CLAUDE_CODE_EXECUTABLE", "ACP_GATEWAY_DISABLE_DYNAMIC_PROVIDERS", "ACP_GATEWAY_PROVIDERS"]
      .map((key) => [key, process.env[key]])
  );
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.ACP_GATEWAY_DISABLE_DYNAMIC_PROVIDERS = "1";
  delete process.env.ACP_GATEWAY_PROVIDERS;
  delete process.env.CLAUDE_CODE_EXECUTABLE;
  process.env.HOME = paths.home;

  async function bothSites() {
    const worker = providerConfig("claude").env.CLAUDE_CODE_EXECUTABLE;
    const detected = (await detectProviders()).find((item) => item.id === "claude");
    assert.equal(detected.agentCommand, worker, "detection and the worker must name the same CLI");
    return { worker, installed: detected.agentInstalled };
  }

  process.env.PATH = [paths.brew, paths.npmGlobal].join(":");
  assert.deepEqual(await bothSites(), { worker: join(paths.brew, "claude"), installed: true });

  // Not installed: the worker still gets an explicit path (the legacy one, which
  // does not exist) so the adapter never falls back to a bundled binary.
  process.env.PATH = paths.empty;
  assert.deepEqual(await bothSites(), { worker: legacyClaudeExecutable(paths.home), installed: false });

  const legacy = await executable(legacyClaudeExecutable(paths.home));
  assert.deepEqual(await bothSites(), { worker: legacy, installed: true }, "a CLI installed after startup is seen");

  process.env.CLAUDE_CODE_EXECUTABLE = join(paths.root, "missing", "claude");
  assert.deepEqual(await bothSites(), { worker: process.env.CLAUDE_CODE_EXECUTABLE, installed: false });
  process.env.CLAUDE_CODE_EXECUTABLE = join(paths.npmGlobal, "claude");
  assert.deepEqual(await bothSites(), { worker: join(paths.npmGlobal, "claude"), installed: true });
});
