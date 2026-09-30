#!/usr/bin/env node

// Packs acp-gateway-daemon for npm. The only way the package is packed:
// scripts/npm-smoke.js and .github/workflows/publish-npm.yml both call it.
//
// The package pins its dependency tree by carrying it. npm 12 no longer reads
// npm-shrinkwrap.json, neither a project's nor one inside a published tarball,
// so the shrinkwrap that 1.7.0 and 1.7.1 shipped left npm 12 users with freshly
// resolved dependencies plus their platform's Claude Code binary. Instead every
// production dependency is listed in bundleDependencies, and `npm pack` puts
// the installed node_modules tree into the tarball. npm 10, 11 and 12 install a
// bundled tree as shipped and resolve nothing inside it: they fetch no missing
// optional dependency of a bundled package, so the Claude Agent SDK's platform
// packages (@anthropic-ai/claude-agent-sdk-<platform>, about 245 MB each; see
// scripts/omit-claude-binary.js), left out of the bundle, never reach a user.
// scripts/npm-smoke.js shows this against a registry that serves nothing else.
//
// A tarball is only as good as the node_modules it is packed from, so this
// refuses to pack unless node_modules is exactly the production tree of
// package-lock.json: every entry installed where the lockfile puts it, at its
// version, nothing else, and no Claude platform package. Then it unpacks the
// tarball and checks the bundled tree the same way. Pack a release with:
//
//   npm ci --omit=optional
//   node scripts/pack-release.js --pack-destination <dir>
//
// Before packing it deletes node_modules/.package-lock.json, npm's cache of
// the installed tree. While that file is fresh (right after `npm ci`) npm
// packs each bundled package without reading its package.json "files", and
// ships files the current npm would not (measured: which's CHANGELOG.md);
// without it npm reads the packages themselves, so every pack of the same
// tree is the same tarball (byte for byte with npm 10, 11 and 12).
//
// `--check` only checks. `--prepack` checks and deletes that cache; it is the
// package's prepack script, which npm runs before it reads the tree, so a
// plain `npm pack` or `npm publish` from a checkout is checked and packs the
// same files (npm skips it under --ignore-scripts; this script does the same
// itself and then packs with --ignore-scripts).
//
// The lockfile must describe a tree npm bundles in full and the same on every
// machine: `npm pack` leaves peer-only packages out of a bundle, and an
// optional package would be bundled or not depending on where it was packed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudePlatformBinaryReferences, findClaudePlatformPackages } from "./omit-claude-binary.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const LOCKFILE_NAME = "package-lock.json";
export const PREPACK_SCRIPT = "node scripts/pack-release.js --prepack";

// "node_modules/a/node_modules/@scope/b" -> "@scope/b".
function packageNameAt(path) {
  return path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
}

function sameEntries(left = {}, right = {}) {
  const sorted = (object) => JSON.stringify(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return sorted(left) === sorted(right);
}

// The packages a bundle must hold: every non-root, non-dev lockfile entry, as
// path -> { name, version }.
export function lockedProductionTree(lockDocument) {
  const tree = new Map();
  for (const [path, entry] of Object.entries(lockDocument?.packages ?? {})) {
    if (path === "" || entry.dev) continue;
    tree.set(path, { name: entry.name ?? packageNameAt(path), version: entry.version });
  }
  return tree;
}

// Why package.json and package-lock.json cannot be bundled as a pinned tree.
export function lockfileBundleProblems(packageDocument, lockDocument) {
  const problems = [];
  const dependencies = Object.keys(packageDocument.dependencies ?? {}).sort();
  const bundled = Array.isArray(packageDocument.bundleDependencies) ? [...packageDocument.bundleDependencies].sort() : null;
  if (!bundled || JSON.stringify(bundled) !== JSON.stringify(dependencies)) {
    problems.push(`package.json bundleDependencies must list exactly the dependencies (${dependencies.join(", ")})`);
  }
  for (const field of ["optionalDependencies", "peerDependencies"]) {
    if (Object.keys(packageDocument[field] ?? {}).length) problems.push(`package.json ${field} are not bundled; make them exact dependencies`);
  }
  const root = lockDocument?.packages?.[""];
  if (!root) {
    problems.push(`${LOCKFILE_NAME} has no root package entry`);
    return problems;
  }
  if (!sameEntries(root.dependencies, packageDocument.dependencies)) {
    problems.push(`${LOCKFILE_NAME} dependencies differ from package.json; run npm install and node scripts/omit-claude-binary.js`);
  }
  for (const reference of claudePlatformBinaryReferences(lockDocument)) {
    problems.push(`${LOCKFILE_NAME} lists a Claude platform binary (${reference}); run node scripts/omit-claude-binary.js`);
  }
  for (const [path, entry] of Object.entries(lockDocument.packages)) {
    if (path === "" || entry.dev) continue;
    if (entry.link) problems.push(`${path} is a link; a bundle cannot carry it`);
    if (entry.optional || entry.devOptional) problems.push(`${path} is optional, so the bundle would depend on the platform it is packed on`);
    if (entry.peer) problems.push(`${path} is only a peer dependency, which npm pack does not bundle; add ${packageNameAt(path)} as an exact dependency`);
  }
  return problems;
}

// Every package directory under `root`/node_modules, as a lockfile-style path
// -> { name, version, symlink }. Dot entries (.bin, .package-lock.json) are npm's.
export function installedTree(root) {
  const tree = new Map();
  const sortedEntries = (directory) => readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const visitModules = (directory, prefix) => {
    let entries;
    try {
      entries = sortedEntries(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@") && entry.isDirectory()) {
        for (const scoped of sortedEntries(join(directory, entry.name))) {
          if (scoped.name.startsWith(".")) continue;
          visitPackage(join(directory, entry.name, scoped.name), `${prefix}${entry.name}/${scoped.name}`);
        }
      } else {
        visitPackage(join(directory, entry.name), `${prefix}${entry.name}`);
      }
    }
  };
  const visitPackage = (directory, path) => {
    if (lstatSync(directory).isSymbolicLink()) {
      tree.set(path, { symlink: true });
      return;
    }
    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    } catch {
      // Reported as a package without a readable package.json.
    }
    tree.set(path, { name: manifest?.name ?? null, version: manifest?.version ?? null });
    visitModules(join(directory, "node_modules"), `${path}/node_modules/`);
  };
  visitModules(join(root, "node_modules"), "node_modules/");
  return tree;
}

// How the tree under `root` differs from the lockfile's production tree. With
// `exact`, packages the lockfile marks dev are extraneous too (a bundle holds
// none); without it they may be installed (a checkout with devDependencies).
export function treeProblems(root, lockDocument, { exact = false, label = "node_modules" } = {}) {
  const expected = lockedProductionTree(lockDocument);
  const installed = installedTree(root);
  if (!installed.size && expected.size) return [`${label}: no packages installed (${expected.size} locked)`];
  const problems = [];
  for (const [path, want] of expected) {
    const have = installed.get(path);
    if (!have) problems.push(`${label}: ${path} is missing (locked ${want.version})`);
    else if (have.symlink) problems.push(`${label}: ${path} is a symlink`);
    else if (have.name !== want.name || have.version !== want.version) {
      problems.push(`${label}: ${path} is ${have.name ?? "?"}@${have.version ?? "?"}, locked ${want.name}@${want.version}`);
    }
  }
  for (const [path, have] of installed) {
    if (expected.has(path)) continue;
    if (!exact && lockDocument.packages?.[path]?.dev) continue;
    problems.push(`${label}: ${path}${have.version ? `@${have.version}` : ""} is not in the locked production tree`);
  }
  for (const path of findClaudePlatformPackages(join(root, "node_modules"))) {
    problems.push(`${label}: node_modules/${path} is a Claude platform binary package`);
  }
  return problems;
}

async function readDocuments(root) {
  const packageDocument = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lockDocument = JSON.parse(await readFile(join(root, LOCKFILE_NAME), "utf8"));
  return { packageDocument, lockDocument };
}

export async function checkPackableTree(root = repositoryRoot) {
  const { packageDocument, lockDocument } = await readDocuments(root);
  const problems = [...lockfileBundleProblems(packageDocument, lockDocument), ...treeProblems(root, lockDocument)];
  return { problems, packages: lockedProductionTree(lockDocument).size };
}

// npm's cache of the installed tree; see the header.
export async function dropHiddenLockfile(root = repositoryRoot) {
  await rm(join(root, "node_modules", ".package-lock.json"), { force: true });
}

// `npm pack --json` prints an array of reports up to npm 11 and an object
// keyed by package name from npm 12.
export function packReport(stdout) {
  const parsed = JSON.parse(stdout);
  const reports = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
  if (reports.length !== 1 || !reports[0]?.filename) throw new Error(`unexpected npm pack --json output: ${stdout.slice(0, 200)}`);
  return reports[0];
}

function refusal(problems) {
  return new Error(
    `refusing to pack:\n${problems.map((problem) => `  ${problem}`).join("\n")}\n`
    + "Install the locked production tree with `npm ci --omit=optional`, then pack with "
    + "`node scripts/pack-release.js --pack-destination <dir>`."
  );
}

// Checks, packs with `npm pack --ignore-scripts`, then unpacks the tarball and
// checks the bundled tree. Returns npm's pack report plus the packed manifest.
export async function packRelease({ destination, root = repositoryRoot, env = process.env }) {
  const { problems, packages } = await checkPackableTree(root);
  if (problems.length) throw refusal(problems);
  await dropHiddenLockfile(root);
  const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error(`npm pack exited ${packed.status}\n${packed.stderr || packed.stdout}`);
  const report = packReport(packed.stdout);
  const tarball = join(destination, report.filename);
  const bytes = await readFile(tarball);
  const unpacked = await mkdtemp(join(tmpdir(), "acp-pack-"));
  try {
    const extracted = spawnSync("tar", ["-xzf", tarball, "-C", unpacked], { encoding: "utf8" });
    if (extracted.status !== 0) throw new Error(`cannot unpack ${tarball}: ${extracted.stderr}`);
    const packageRoot = join(unpacked, "package");
    const { lockDocument } = await readDocuments(root);
    const bundleProblems = treeProblems(packageRoot, lockDocument, { exact: true, label: "tarball" });
    if (bundleProblems.length) throw new Error(`the packed bundle is not the locked production tree\n${bundleProblems.map((problem) => `  ${problem}`).join("\n")}`);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    return {
      ...report,
      tarball,
      manifest,
      bundledPackages: packages,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--check") || args.includes("--prepack")) {
      const { problems, packages } = await checkPackableTree();
      if (problems.length) throw refusal(problems);
      if (args.includes("--prepack")) await dropHiddenLockfile();
      process.stdout.write(`pack-release: node_modules is the locked production tree (${packages} packages, no Claude platform binary)\n`);
    } else {
      const index = args.indexOf("--pack-destination");
      if (index === -1 || !args[index + 1]) throw new Error("usage: node scripts/pack-release.js --pack-destination <dir> | --check | --prepack");
      const report = await packRelease({ destination: resolve(args[index + 1]) });
      process.stdout.write(`${report.tarball}\n`
        + `bundled ${report.bundledPackages} locked packages; ${report.entryCount} files, ${report.size} bytes (${report.unpackedSize} unpacked)\n`
        + `sha256 ${report.sha256}\n`);
    }
  } catch (error) {
    process.stderr.write(`pack-release: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
