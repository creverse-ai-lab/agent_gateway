import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GZIP_OS_UNKNOWN,
  PUBLIC_CLIENT_EXPORTS,
  REQUIRED_ALLOWED_ROOTS,
  V140_SOURCE_COMMIT,
  assertBuilderCommit,
  assertPinnedSourceCommit,
  assertRuntimeManifestMetadata,
  assertSymlinkContained,
  assertUnsignedBuildRecord,
  createDeterministicArchive,
  createUnsignedBuildRecord,
  manifestFiles,
  normalizedMode
} from "../scripts/runtime-release-lib.js";

const PINNED = "a1fdb353777337ca6ec481f8563d77efaea55e95";

test("1.5.0 requires a caller-reviewed full source SHA independently of the tag", () => {
  const source = "1".repeat(40);
  assert.throws(() => assertPinnedSourceCommit("v1.5.0", source), /No pinned source commit/);
  assertPinnedSourceCommit("v1.5.0", source, source);
  assert.throws(() => assertPinnedSourceCommit("v1.5.0", "2".repeat(40), source), /refusing a moved tag/);
  assert.throws(() => assertPinnedSourceCommit("v1.4.0", PINNED, source), /historical pin/);
});

test("v1.4.0 is pinned to the accepted source commit and rejects a moved tag", () => {
  assert.equal(V140_SOURCE_COMMIT, PINNED);
  assertPinnedSourceCommit("v1.4.0", PINNED);
  assert.throws(
    () => assertPinnedSourceCommit("v1.4.0", "0".repeat(40)),
    /refusing a moved tag/
  );
  assert.throws(() => assertPinnedSourceCommit("v1.3.2", PINNED), /No pinned source commit/);
});

test("builder commit must be a full lowercase git SHA", () => {
  assertBuilderCommit(PINNED);
  assert.throws(() => assertBuilderCommit("HEAD"), /40-character lowercase hex SHA/);
  assert.throws(() => assertBuilderCommit("A1FDB353777337CA6EC481F8563D77EFAEA55E95"), /40-character lowercase hex SHA/);
  assert.throws(() => assertBuilderCommit("a1fdb35"), /40-character lowercase hex SHA/);
});

test("local metadata is an unsigned build record, not a signed attestation", () => {
  const local = createUnsignedBuildRecord({
    artifact: "acp-gateway-runtime-darwin-arm64.tar.gz",
    digest: "ab".repeat(32),
    sourceTag: "v1.4.0",
    sourceCommit: PINNED,
    builderCommit: PINNED,
    builderDirty: false,
    env: {}
  });
  const actions = createUnsignedBuildRecord({
    artifact: "acp-gateway-runtime-darwin-arm64.tar.gz",
    digest: "ab".repeat(32),
    sourceTag: "v1.4.0",
    sourceCommit: PINNED,
    builderCommit: PINNED,
    builderDirty: false,
    env: { GITHUB_ACTIONS: "true" }
  });
  assert.equal(local.kind, "unsigned-build-record");
  assert.equal(local.signed, false);
  assert.equal(local.origin, "local");
  assert.equal(actions.origin, "github-actions");
  assert.equal(actions.signed, false);
  assert.doesNotMatch(JSON.stringify(local), /in-toto|slsa\.dev\/provenance/);
  assertUnsignedBuildRecord(local, { artifact: local.artifact, digest: local.digest.sha256 });
  assert.throws(
    () => assertUnsignedBuildRecord({ _type: "https://in-toto.io/Statement/v1", signed: true }),
    /unsigned build record/
  );
  assert.throws(
    () => assertUnsignedBuildRecord({ ...local, sourceCommit: "0".repeat(40) }),
    /refusing a moved tag/
  );
});

test("runtime-manifest.json is a required root and must not hash itself", () => {
  assert.ok(REQUIRED_ALLOWED_ROOTS.includes("runtime-manifest.json"));
  const manifest = {
    schemaVersion: 1,
    artifact: "acp-gateway-runtime-darwin-arm64.tar.gz",
    runtimeRoot: "acp-gateway-runtime",
    package: "acp-gateway",
    version: "1.4.0",
    apiMajor: 1,
    platform: "darwin",
    arch: "arm64",
    publicEntrypoint: "./gateway-client/index.js",
    source: {
      repository: "https://github.com/creverse-ai-lab/agent_gateway.git",
      tag: "v1.4.0",
      commit: PINNED
    },
    builder: { commit: PINNED, dirty: false },
    allowedRoots: [...REQUIRED_ALLOWED_ROOTS],
    files: []
  };
  assertRuntimeManifestMetadata(manifest, { artifactName: manifest.artifact });
  assert.throws(
    () => assertRuntimeManifestMetadata({
      ...manifest,
      files: [{ path: "runtime-manifest.json", type: "file" }]
    }),
    /must not recursively hash itself/
  );
  assert.throws(
    () => assertRuntimeManifestMetadata({
      ...manifest,
      allowedRoots: REQUIRED_ALLOWED_ROOTS.filter((root) => root !== "runtime-manifest.json")
    }),
    /allowlisted required root/
  );
  assert.throws(
    () => assertRuntimeManifestMetadata({
      ...manifest,
      allowedRoots: [...REQUIRED_ALLOWED_ROOTS, "unexpected/"]
    }),
    /fixed runtime allowlist/
  );
  assert.throws(
    () => assertRuntimeManifestMetadata({
      ...manifest,
      source: { ...manifest.source, commit: "0".repeat(40) }
    }),
    /refusing a moved tag/
  );
  assert.throws(
    () => assertRuntimeManifestMetadata({
      ...manifest,
      builder: { commit: "HEAD", dirty: false }
    }),
    /40-character lowercase hex SHA/
  );
});

test("entry modes are normalized independently of umask bits", () => {
  assert.equal(normalizedMode("directory", 0o700), 0o755);
  assert.equal(normalizedMode("symlink", 0o755), 0o777);
  assert.equal(normalizedMode("file", 0o600), 0o644);
  assert.equal(normalizedMode("file", 0o640), 0o644);
  assert.equal(normalizedMode("file", 0o700), 0o755);
  assert.equal(normalizedMode("file", 0o755), 0o755);
});

test("every runtime symlink must stay inside the runtime root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-runtime-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/index.js"), "ok\n");
  await symlink("index.js", join(root, "src/ok-link"));
  const files = await manifestFiles(root);
  assert.equal(files.find((file) => file.path === "src/ok-link")?.target, "index.js");
  assert.doesNotThrow(() => assertSymlinkContained(root, "src/ok-link", "index.js"));
  assert.throws(() => assertSymlinkContained(root, "src/escape", "../../outside"), /outside/);
  assert.throws(() => assertSymlinkContained(root, "src/abs", "/etc/passwd"), /Unsafe symlink/);
  await symlink("../../outside", join(root, "src/escape"));
  await assert.rejects(() => manifestFiles(root), /outside/);
});

test("deterministic archives pin gzip OS and ignore checkout modes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-runtime-archive-"));
  const output = await mkdtemp(join(tmpdir(), "acp-runtime-output-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(output, { recursive: true, force: true })
  ]));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "src/index.js"), "ok\n", { mode: 0o600 });
  await writeFile(join(root, "node_modules/.package-lock.json"), "{}\n");
  await writeFile(join(root, "runtime-manifest.json"), "{}\n");
  const first = join(output, "one.tar.gz");
  const second = join(output, "two.tar.gz");
  await createDeterministicArchive(root, first);
  await chmod(join(root, "src/index.js"), 0o640);
  await createDeterministicArchive(root, second);
  const left = await readFile(first);
  const right = await readFile(second);
  assert.deepEqual(left, right);
  assert.equal(left[0], 0x1f);
  assert.equal(left[1], 0x8b);
  assert.equal(left[9], GZIP_OS_UNKNOWN);
  const files = await manifestFiles(root);
  assert.equal(files.find((file) => file.path === "src/index.js")?.mode, "0644");
  assert.ok(!files.some((file) => file.path === "runtime-manifest.json"));
  assert.ok(!files.some((file) => file.path === "node_modules/.package-lock.json"));
});

test("public client export key set is the frozen consumer contract", () => {
  assert.deepEqual([...PUBLIC_CLIENT_EXPORTS], [
    "ERROR_CODES",
    "GATEWAY_API_VERSION",
    "GatewayError",
    "GatewayRpcClient"
  ]);
});

test("verifier rejects --provenance so local files are not treated as attestations", () => {
  const verifier = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts/verify-runtime-release.js");
  const result = spawnSync(process.execPath, [verifier, "--provenance", "x"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /unsigned build record/);
});
