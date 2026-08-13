#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_ALLOWED_ROOTS,
  RUNTIME_ASSET_NAME,
  RUNTIME_ROOT_NAME,
  assertBuilderCommit,
  assertPinnedSourceCommit,
  createDeterministicArchive,
  createUnsignedBuildRecord,
  manifestFiles,
  sha256File
} from "./runtime-release-lib.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const arguments_ = process.argv.slice(2);

function option(name, fallback) {
  const index = arguments_.indexOf(name);
  if (index === -1) return fallback;
  if (arguments_[index + 1] == null) throw new Error(`${name} requires a value`);
  return arguments_[index + 1];
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: repositoryRoot, stdio: options.capture ? "pipe" : "inherit", encoding: "utf8" });
}

const sourceTag = option("--source-tag", "v1.4.0");
const outputDirectory = resolve(option("--output-dir", join(repositoryRoot, "dist")));
const allowDirty = arguments_.includes("--allow-dirty");
const sourceCommit = run("git", ["rev-parse", `${sourceTag}^{commit}`], { capture: true }).trim();
const builderCommit = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
assertPinnedSourceCommit(sourceTag, sourceCommit);
assertBuilderCommit(builderCommit);
const dirty = run("git", ["status", "--porcelain"], { capture: true }).trim();
if (dirty && !allowDirty) throw new Error("Refusing a release build from a dirty builder checkout; commit or pass --allow-dirty for local validation");

const temporary = await mkdtemp(join(tmpdir(), "acp-gateway-release-"));
const runtimeRoot = join(temporary, RUNTIME_ROOT_NAME);
const archivePath = join(outputDirectory, RUNTIME_ASSET_NAME);
try {
  await mkdir(runtimeRoot, { recursive: true });
  const sourceArchive = join(temporary, "source.tar");
  run("git", [
    "archive", "--format=tar", `--output=${sourceArchive}`, sourceCommit, "--",
    "src", "skills", "package.json", "package-lock.json"
  ]);
  execFileSync("tar", ["-xf", sourceArchive, "-C", runtimeRoot], { stdio: "inherit" });
  await cp(join(repositoryRoot, "gateway-client"), join(runtimeRoot, "gateway-client"), { recursive: true });

  const packagePath = join(runtimeRoot, "package.json");
  const packageDocument = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(packageDocument.version, "1.4.0", "the v1.4.0 runtime builder only accepts package version 1.4.0");
  packageDocument.files = ["src/", "gateway-client/", "skills/"];
  packageDocument.exports = { ".": "./gateway-client/index.js", "./client": "./gateway-client/index.js" };
  packageDocument.scripts = Object.fromEntries(
    Object.entries(packageDocument.scripts ?? {}).filter(([name]) => ["start", "daemon", "guide", "bootstrap"].includes(name))
  );
  await writeFile(packagePath, `${JSON.stringify(packageDocument, null, 2)}\n`);

  const lockPath = join(runtimeRoot, "package-lock.json");
  const lockDocument = JSON.parse(await readFile(lockPath, "utf8"));
  lockDocument.version = packageDocument.version;
  lockDocument.packages[""].version = packageDocument.version;
  await writeFile(lockPath, `${JSON.stringify(lockDocument, null, 2)}\n`);

  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--os=darwin", "--cpu=arm64"], {
    cwd: runtimeRoot,
    stdio: "inherit",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" }
  });
  await rm(join(runtimeRoot, "node_modules", ".package-lock.json"), { force: true });

  const versionSource = await readFile(join(runtimeRoot, "src/version.js"), "utf8");
  const apiVersion = Number(versionSource.match(/GATEWAY_API_VERSION\s*=\s*(\d+)/)?.[1]);
  assert.equal(apiVersion, 1, "release API major must remain 1");
  const manifest = {
    schemaVersion: 1,
    artifact: RUNTIME_ASSET_NAME,
    runtimeRoot: RUNTIME_ROOT_NAME,
    package: "acp-gateway",
    version: packageDocument.version,
    apiMajor: apiVersion,
    platform: "darwin",
    arch: "arm64",
    publicEntrypoint: "./gateway-client/index.js",
    source: {
      repository: "https://github.com/creverse-ai-lab/agent_gateway.git",
      tag: sourceTag,
      commit: sourceCommit
    },
    builder: { commit: builderCommit, dirty: Boolean(dirty) },
    allowedRoots: [...REQUIRED_ALLOWED_ROOTS],
    files: await manifestFiles(runtimeRoot)
  };
  await writeFile(join(runtimeRoot, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  await mkdir(outputDirectory, { recursive: true });
  await createDeterministicArchive(runtimeRoot, archivePath);
  const digest = await sha256File(archivePath);
  await writeFile(`${archivePath}.sha256`, `${digest}  ${RUNTIME_ASSET_NAME}\n`);
  const buildRecord = createUnsignedBuildRecord({
    artifact: RUNTIME_ASSET_NAME,
    digest,
    sourceTag,
    sourceCommit,
    builderCommit,
    builderDirty: Boolean(dirty)
  });
  await writeFile(`${archivePath}.build-record.json`, `${JSON.stringify(buildRecord, null, 2)}\n`);
  process.stdout.write(`${archivePath}\nsha256 ${digest}\nsource ${sourceTag} ${sourceCommit}\nbuilder ${builderCommit}${dirty ? " (dirty)" : ""}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
