#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  PUBLIC_CLIENT_EXPORTS,
  RUNTIME_ROOT_NAME,
  assertRuntimeManifestMetadata,
  assertUnsignedBuildRecord,
  manifestFiles,
  readJson,
  sha256File
} from "./runtime-release-lib.js";

const arguments_ = process.argv.slice(2);

function option(name) {
  const index = arguments_.indexOf(name);
  if (index === -1 || arguments_[index + 1] == null) throw new Error(`${name} is required`);
  return resolve(arguments_[index + 1]);
}

if (arguments_.includes("--provenance")) {
  throw new Error("local release metadata is an unsigned build record; pass --build-record, not --provenance");
}

const sourceIndex = arguments_.indexOf("--source-commit");
const expectedSourceCommit = sourceIndex < 0 ? undefined : arguments_[sourceIndex + 1];
const archivePath = option("--archive");
const checksumPath = option("--sha256");
const buildRecordPath = option("--build-record");
const expectedChecksum = (await readFile(checksumPath, "utf8")).trim().split(/\s+/)[0];
assert.match(expectedChecksum, /^[a-f0-9]{64}$/);
assert.equal(await sha256File(archivePath), expectedChecksum, "archive SHA-256 does not match");

const buildRecord = await readJson(buildRecordPath);
assertUnsignedBuildRecord(buildRecord, { artifact: basename(archivePath), digest: expectedChecksum, expectedSourceCommit });

const temporary = await mkdtemp(join(tmpdir(), "acp-gateway-verify-"));
try {
  execFileSync("tar", ["-xzf", archivePath, "-C", temporary], { stdio: "inherit" });
  const runtimeRoot = join(temporary, RUNTIME_ROOT_NAME);
  const manifest = await readJson(join(runtimeRoot, "runtime-manifest.json"));
  assertRuntimeManifestMetadata(manifest, { artifactName: basename(archivePath), expectedSourceCommit });
  assert.equal(buildRecord.sourceTag, manifest.source.tag, "build record source tag differs from manifest");
  assert.equal(buildRecord.sourceCommit, manifest.source.commit, "build record source commit differs from manifest");
  assert.equal(buildRecord.builderCommit, manifest.builder.commit, "build record builder commit differs from manifest");
  assert.equal(buildRecord.builderDirty, manifest.builder.dirty, "build record dirty state differs from manifest");
  assert.deepEqual(await manifestFiles(runtimeRoot), manifest.files, "runtime payload differs from its manifest");

  for (const file of manifest.files) {
    const root = file.path.split("/", 1)[0] + (file.path.includes("/") ? "/" : "");
    assert.ok(manifest.allowedRoots.includes(root), `unexpected runtime root: ${file.path}`);
  }

  const consumer = join(temporary, "consumer");
  const modules = join(consumer, "node_modules");
  await mkdir(modules, { recursive: true });
  await symlink(runtimeRoot, join(modules, "acp-gateway"), "dir");
  const expectedExports = [...PUBLIC_CLIENT_EXPORTS].sort().join(",");
  const publicProbe = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `import('acp-gateway/client').then(m => { const keys = Object.keys(m).sort().join(','); if (keys !== ${JSON.stringify(expectedExports)} || m.GATEWAY_API_VERSION !== 1) process.exit(2); })`],
    { cwd: consumer, encoding: "utf8" }
  );
  assert.equal(publicProbe.status, 0, publicProbe.stderr || "public client import failed");
  const privateProbe = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", "import('acp-gateway/src/socket-rpc.js')"],
    { cwd: consumer, encoding: "utf8" }
  );
  assert.notEqual(privateProbe.status, 0, "private package subpath unexpectedly imported");
  assert.match(privateProbe.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/, "private import failed for an unexpected reason");
  process.stdout.write(`verified ${archivePath}\nsha256 ${expectedChecksum}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
