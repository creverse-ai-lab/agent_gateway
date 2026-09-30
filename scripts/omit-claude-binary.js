#!/usr/bin/env node

// The Claude Code CLI ships inside @anthropic-ai/claude-agent-sdk as native
// binaries, one optional package per platform (@anthropic-ai/claude-agent-sdk-<platform>,
// about 245 MB each). The Gateway never runs one: the Claude Worker always gets
// CLAUDE_CODE_EXECUTABLE naming the user's own CLI (src/providers.js), and
// claude-agent-acp resolves that variable before any bundled binary.
//
// So package-lock.json lists none of them, and the SDK's entry does not name
// them as optional dependencies either: with only the packages removed,
// `npm ci` rejects the lockfile as out of sync with package.json. `npm ci`
// installs what the lockfile lists, so a source checkout gets no binary, and
// neither does the npm package: it bundles the tree `npm ci --omit=optional`
// installs (scripts/pack-release.js refuses a tree holding a platform package).
// The same entries cost 1.7.0 all eight binaries (about 2.2 GB): npm 10 and 11
// install a published npm-shrinkwrap.json as written, whatever the platform
// and --omit say.
//
// Run this after anything that rewrites package-lock.json (npm install, the
// dependency sync); scripts/ci-check.js fails until it has been run.

import { readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CLAUDE_PLATFORM_PACKAGE = /^@anthropic-ai\/claude-agent-sdk-[^/]+$/;
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

export function isClaudePlatformPackage(name) {
  return CLAUDE_PLATFORM_PACKAGE.test(name);
}

// "node_modules/a/node_modules/@scope/b" -> "@scope/b"; the root entry "" -> null.
function lockEntryName(path) {
  const index = path.lastIndexOf("node_modules/");
  return index === -1 ? null : path.slice(index + "node_modules/".length);
}

// Every place a lockfile still installs or names a platform binary.
export function claudePlatformBinaryReferences(lockDocument) {
  const references = [];
  for (const [path, entry] of Object.entries(lockDocument?.packages ?? {})) {
    const name = lockEntryName(path);
    if (name && isClaudePlatformPackage(name)) references.push(path);
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependency of Object.keys(entry?.[field] ?? {})) {
        if (isClaudePlatformPackage(dependency)) references.push(`${path || "(root)"} ${field} ${dependency}`);
      }
    }
  }
  return references;
}

// The lockfile without the platform binaries: their package entries go, and so
// do their names among an entry's optional dependencies. A platform binary
// named as a required or peer dependency is left for ci-check to report.
export function withoutClaudePlatformBinaries(lockDocument) {
  const packages = {};
  for (const [path, entry] of Object.entries(lockDocument.packages ?? {})) {
    const name = lockEntryName(path);
    if (name && isClaudePlatformPackage(name)) continue;
    const optional = entry.optionalDependencies;
    if (!optional || !Object.keys(optional).some(isClaudePlatformPackage)) {
      packages[path] = entry;
      continue;
    }
    const kept = Object.fromEntries(Object.entries(optional).filter(([dependency]) => !isClaudePlatformPackage(dependency)));
    const { optionalDependencies: _removed, ...rest } = entry;
    packages[path] = Object.keys(kept).length ? { ...entry, optionalDependencies: kept } : rest;
  }
  return { ...lockDocument, packages };
}

// Platform binary package directories installed anywhere under `root`, as
// root-relative POSIX paths (an installed prefix, a runtime tree).
export function findClaudePlatformPackages(root) {
  const found = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const scoped = basename(directory) === "@anthropic-ai" && basename(dirname(directory)) === "node_modules";
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (scoped && isClaudePlatformPackage(`@anthropic-ai/${entry.name}`)) {
        found.push(relative(root, path).split(sep).join("/"));
      } else if (entry.isDirectory()) {
        visit(path);
      }
    }
  };
  visit(root);
  return found.sort();
}

export async function omitClaudeBinaryFromLockfile(path) {
  const document = JSON.parse(await readFile(path, "utf8"));
  const before = claudePlatformBinaryReferences(document);
  if (!before.length) return [];
  const normalized = withoutClaudePlatformBinaries(document);
  const remaining = claudePlatformBinaryReferences(normalized);
  if (remaining.length) throw new Error(`cannot omit a required Claude platform binary: ${remaining.join(", ")}`);
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  return before;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2] ?? fileURLToPath(new URL("../package-lock.json", import.meta.url)));
  try {
    const removed = await omitClaudeBinaryFromLockfile(path);
    process.stdout.write(removed.length
      ? `omitted from ${path}:\n${removed.map((item) => `  ${item}`).join("\n")}\n`
      : `${path} already lists no Claude platform binary\n`);
  } catch (error) {
    process.stderr.write(`omit-claude-binary: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
