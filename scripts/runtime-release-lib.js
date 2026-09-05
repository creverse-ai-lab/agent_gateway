import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export const RUNTIME_ASSET_NAME = "acp-gateway-runtime-darwin-arm64.tar.gz";
export const RUNTIME_ROOT_NAME = "acp-gateway-runtime";
export const BUILD_RECORD_NAME = `${RUNTIME_ASSET_NAME}.build-record.json`;
export const CHECKSUM_NAME = `${RUNTIME_ASSET_NAME}.sha256`;
export const RELEASE_ASSET_NAMES = Object.freeze([RUNTIME_ASSET_NAME, CHECKSUM_NAME, BUILD_RECORD_NAME]);
export const V140_SOURCE_COMMIT = "a1fdb353777337ca6ec481f8563d77efaea55e95";
export const PINNED_SOURCE_COMMITS = Object.freeze({
  "v1.4.0": V140_SOURCE_COMMIT
});
export const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
export const GZIP_OS_UNKNOWN = 255;
export const PUBLIC_CLIENT_EXPORTS = Object.freeze([
  "ERROR_CODES",
  "GATEWAY_API_VERSION",
  "GatewayError",
  "GatewayRpcClient"
]);
export const REQUIRED_ALLOWED_ROOTS = Object.freeze([
  "gateway-client/",
  "node_modules/",
  "skills/",
  "src/",
  "package-lock.json",
  "package.json",
  "runtime-manifest.json"
]);

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function pinnedSourceCommit(tag, expectedCommit) {
  const commit = PINNED_SOURCE_COMMITS[tag] ?? (tag === "v1.5.0" && GIT_COMMIT_PATTERN.test(expectedCommit ?? "") ? expectedCommit : null);
  if (!commit) throw new Error(`No pinned source commit for tag ${tag}`);
  return commit;
}

export function assertPinnedSourceCommit(tag, commit, expectedCommit) {
  const expected = pinnedSourceCommit(tag, expectedCommit);
  if (expectedCommit != null && expectedCommit !== expected) throw new Error("Explicit source commit differs from the historical pin");
  if (commit !== expected) {
    throw new Error(`Tag ${tag} resolved to ${commit}, expected pinned commit ${expected}; refusing a moved tag`);
  }
}

export function assertBuilderCommit(commit) {
  if (!GIT_COMMIT_PATTERN.test(commit)) {
    throw new Error(`builder commit must be a 40-character lowercase hex SHA: ${commit}`);
  }
}

export function buildRecordOrigin(env = process.env) {
  return env.GITHUB_ACTIONS === "true" ? "github-actions" : "local";
}

export function createUnsignedBuildRecord({
  artifact,
  digest,
  sourceTag,
  sourceCommit,
  builderCommit,
  builderDirty,
  env = process.env
}) {
  return {
    schemaVersion: 1,
    kind: "unsigned-build-record",
    origin: buildRecordOrigin(env),
    signed: false,
    artifact,
    digest: { sha256: digest },
    sourceTag,
    sourceCommit,
    builderCommit,
    builderDirty: Boolean(builderDirty),
    platform: "darwin",
    arch: "arm64"
  };
}

export function assertUnsignedBuildRecord(record, { artifact, digest, expectedSourceCommit } = {}) {
  if (record?.kind !== "unsigned-build-record") {
    throw new Error("release metadata must identify itself as an unsigned build record, not a signed attestation");
  }
  if (record.signed !== false) throw new Error("unsigned build record must set signed=false");
  if (record.origin !== "local" && record.origin !== "github-actions") {
    throw new Error(`unsigned build record origin must be local or github-actions: ${record.origin}`);
  }
  if (artifact != null && record.artifact !== artifact) {
    throw new Error(`build record artifact ${record.artifact} does not match ${artifact}`);
  }
  if (digest != null && record.digest?.sha256 !== digest) {
    throw new Error("build record digest does not match");
  }
  assertPinnedSourceCommit(record.sourceTag, record.sourceCommit, expectedSourceCommit);
  assertBuilderCommit(record.builderCommit);
  if (typeof record.builderDirty !== "boolean") throw new Error("unsigned build record builderDirty must be a boolean");
  if (record.platform !== "darwin" || record.arch !== "arm64") {
    throw new Error("unsigned build record platform/arch must be darwin/arm64");
  }
}

export function assertRuntimeManifestMetadata(manifest, { artifactName, expectedSourceCommit } = {}) {
  if (manifest?.schemaVersion !== 1) throw new Error("runtime-manifest.json schemaVersion must be 1");
  if (manifest.package !== "acp-gateway") throw new Error("runtime-manifest.json package must be acp-gateway");
  if (!["1.4.0", "1.5.0"].includes(manifest.version)) throw new Error("runtime-manifest.json version must be 1.4.0 or 1.5.0");
  if (manifest.apiMajor !== 1) throw new Error("runtime-manifest.json apiMajor must be 1");
  if (manifest.platform !== "darwin" || manifest.arch !== "arm64") {
    throw new Error("runtime-manifest.json platform/arch must be darwin/arm64");
  }
  if (manifest.runtimeRoot !== RUNTIME_ROOT_NAME) throw new Error("runtime-manifest.json runtimeRoot is incorrect");
  if (manifest.publicEntrypoint !== "./gateway-client/index.js") {
    throw new Error("runtime-manifest.json publicEntrypoint is incorrect");
  }
  if (artifactName != null && manifest.artifact !== artifactName) {
    throw new Error(`runtime-manifest.json artifact ${manifest.artifact} does not match ${artifactName}`);
  }
  if (!Array.isArray(manifest.allowedRoots) || !manifest.allowedRoots.includes("runtime-manifest.json")) {
    throw new Error("runtime-manifest.json must be an explicit allowlisted required root");
  }
  if (manifest.allowedRoots.length !== REQUIRED_ALLOWED_ROOTS.length) {
    throw new Error("runtime-manifest.json allowedRoots must match the fixed runtime allowlist");
  }
  for (const root of REQUIRED_ALLOWED_ROOTS) {
    if (!manifest.allowedRoots.includes(root)) throw new Error(`missing required runtime root: ${root}`);
  }
  if (manifest.source?.repository !== "https://github.com/creverse-ai-lab/agent_gateway.git") {
    throw new Error("runtime-manifest.json source.repository is incorrect");
  }
  if (manifest.source?.tag !== `v${manifest.version}`) throw new Error("runtime-manifest.json source.tag must match its version");
  assertPinnedSourceCommit(manifest.source.tag, manifest.source.commit, expectedSourceCommit);
  assertBuilderCommit(manifest.builder?.commit);
  if (typeof manifest.builder?.dirty !== "boolean") throw new Error("runtime-manifest.json builder.dirty must be a boolean");
  if (!Array.isArray(manifest.files)) throw new Error("runtime-manifest.json files must be an array");
  if (manifest.files.some((file) => file.path === "runtime-manifest.json")) {
    throw new Error("runtime-manifest.json must not recursively hash itself");
  }
  if (manifest.files.some((file) => file.path === "node_modules/.package-lock.json")) {
    throw new Error("node_modules/.package-lock.json is not a runtime-required file");
  }
}

export function normalizedMode(type, mode) {
  if (type === "directory") return 0o755;
  if (type === "symlink") return 0o777;
  if (type === "file") return (mode & 0o111) ? 0o755 : 0o644;
  throw new Error(`Unsupported runtime entry type: ${type}`);
}

export function assertSymlinkContained(root, linkPath, target) {
  if (target == null || target === "") throw new Error(`Empty symlink target: ${linkPath}`);
  if (isAbsolute(target) || target.includes("\0")) {
    throw new Error(`Unsafe symlink target: ${linkPath} -> ${target}`);
  }
  assertInside(root, resolve(dirname(join(root, linkPath)), target));
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function runtimeEntries(root, { includeManifest = false } = {}) {
  const entries = [];

  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => comparePath(left.name, right.name));
    for (const child of children) {
      const absolute = join(directory, child.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (!includeManifest && path === "runtime-manifest.json") continue;
      if (path === "node_modules/.package-lock.json") continue;
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        entries.push({ path: `${path}/`, absolute, type: "directory", mode: normalizedMode("directory", stat.mode), bytes: 0 });
        await visit(absolute);
      } else if (stat.isSymbolicLink()) {
        const target = await readlink(absolute);
        assertSymlinkContained(root, path, target);
        entries.push({ path, absolute, type: "symlink", mode: normalizedMode("symlink", stat.mode), bytes: 0, target });
      } else if (stat.isFile()) {
        entries.push({ path, absolute, type: "file", mode: normalizedMode("file", stat.mode), bytes: stat.size });
      } else {
        throw new Error(`Unsupported runtime entry: ${path}`);
      }
    }
  }

  await visit(root);
  return entries.sort((left, right) => comparePath(left.path, right.path));
}

export async function manifestFiles(root) {
  const result = [];
  for (const entry of await runtimeEntries(root)) {
    const record = {
      path: entry.path,
      type: entry.type,
      mode: entry.mode.toString(8).padStart(4, "0"),
      bytes: entry.bytes
    };
    if (entry.type === "file") record.sha256 = await sha256File(entry.absolute);
    if (entry.type === "symlink") record.target = entry.target;
    result.push(record);
  }
  return result;
}

function writeString(header, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`Tar field is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new Error(`Tar numeric field is too large: ${value}`);
  writeString(header, offset, length, `${encoded}\0`);
}

function tarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const separators = [...path.matchAll(/\//g)].map((match) => match.index).reverse();
  for (const index of separators) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Runtime path cannot be represented in ustar: ${path}`);
}

function tarHeader(entry, archivePath) {
  const header = Buffer.alloc(512);
  const { name, prefix } = tarPath(archivePath);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.type === "file" ? entry.bytes : 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, entry.type === "directory" ? "5" : entry.type === "symlink" ? "2" : "0");
  if (entry.type === "symlink") writeString(header, 157, 100, entry.target);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "root");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

export async function createDeterministicArchive(root, outputPath) {
  const entries = await runtimeEntries(root, { includeManifest: true });
  async function* blocks() {
    yield tarHeader({ type: "directory", mode: 0o755, bytes: 0 }, `${RUNTIME_ROOT_NAME}/`);
    for (const entry of entries) {
      yield tarHeader(entry, `${RUNTIME_ROOT_NAME}/${entry.path}`);
      if (entry.type !== "file") continue;
      for await (const chunk of createReadStream(entry.absolute)) yield chunk;
      const padding = (512 - (entry.bytes % 512)) % 512;
      if (padding > 0) yield Buffer.alloc(padding);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(
    Readable.from(blocks()),
    createGzip({ level: 9, mtime: 0 }),
    pinGzipOs(GZIP_OS_UNKNOWN),
    createWriteStream(outputPath, { mode: 0o644 })
  );
}

function pinGzipOs(osByte) {
  let header = Buffer.alloc(0);
  let pinned = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (pinned) {
        callback(null, chunk);
        return;
      }
      header = Buffer.concat([header, chunk]);
      if (header.length < 10) {
        callback();
        return;
      }
      header[9] = osByte;
      pinned = true;
      const output = header;
      header = Buffer.alloc(0);
      callback(null, output);
    },
    flush(callback) {
      if (!pinned && header.length > 0) {
        if (header.length >= 10) header[9] = osByte;
        this.push(header);
      }
      callback();
    }
  });
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function assertInside(parent, child) {
  const path = relative(parent, child);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== "..")) return;
  throw new Error(`${child} is outside ${parent}`);
}
