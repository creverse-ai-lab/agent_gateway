import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { childEnv } from "./caller.js";
import { ERROR_CODES, GatewayError } from "./errors.js";

// A snapshot workspace is a private copy of the session cwd. The worker edits the
// copy; Main reads the difference with session {action:"workspace_diff"} and
// decides what to apply to the real tree. It exists for providers whose own
// tools edit inside the roots without a permission request (Codex), where no
// permission policy can make the real tree edit-proof.
//
// Layout: <root>/ws-<uuid>/tree is the worker's cwd, <root>/ws-<uuid>/base an
// untouched copy taken at the same moment. The diff is base -> tree, so edits the
// user makes to the original afterwards never show up as reversed worker edits.
// Both copies are clonefile/reflink copies where the filesystem supports it.
//
// It deliberately lives outside every Gateway-protected directory: a copy under
// ~/.acp-gateway would be unreadable to the very worker it was made for.
//
// <root>/ws-<uuid>/owner.json names the Gateway state that made the copy. The
// root is shared: every daemon with its own state but the default root (an
// isolated deployment, a test daemon) copies into the same directory, so "no
// session of mine references it" never by itself means "nobody needs it". Only
// a copy marked as this state's is ever reclaimed as an orphan.
export const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
export const MAX_SNAPSHOT_ENTRIES = 200_000;
// All live copies together, in the same unit as MAX_SNAPSHOT_BYTES (bytes of
// the source as measured at copy time; each is stored twice, tree and base).
export const MAX_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_DIFF_BYTES = 64 * 1024 * 1024;
const OWNER_FILE = "owner.json";
const HOME_NAME = /^ws-[0-9a-f-]{36}$/;

export function defaultWorkspaceRoot() {
  return process.env.ACP_GATEWAY_WORKSPACES || join(homedir(), ".cache", "acp-gateway", "workspaces");
}

// protectedPaths: canonical Gateway paths. A snapshot of one is refused outright,
// and one nested under cwd (cwd = the home directory) is left out of the copy:
// the copy sits outside every protected root, so anything copied into it would
// lose its protection.
//
// owner: what to write into owner.json (null writes none). admit(bytes) runs
// synchronously after the size checks and before the first byte is copied, so
// a caller can enforce a budget across copies without racing another open; it
// throws to refuse.
export async function createSnapshot(source, root = defaultWorkspaceRoot(), { protectedPaths = [], owner = null, admit = null } = {}) {
  const canonicalSource = await realpath(source);
  if (protectedPaths.some((item) => isWithin(item, canonicalSource))) {
    throw new GatewayError(ERROR_CODES.WORKSPACE_ERROR, "cwd is inside a Gateway-protected directory and cannot be snapshotted");
  }
  const excluded = protectedPaths.filter((item) => isWithin(canonicalSource, item));
  const usage = await measureTree(canonicalSource, excluded);
  if (usage.bytes > MAX_SNAPSHOT_BYTES || usage.entries > MAX_SNAPSHOT_ENTRIES) {
    throw new GatewayError(
      ERROR_CODES.WORKSPACE_ERROR,
      `cwd is too large to snapshot (${usage.bytes} bytes, ${usage.entries} entries; `
        + `limits ${MAX_SNAPSHOT_BYTES} bytes, ${MAX_SNAPSHOT_ENTRIES} entries)`,
      { bytes: usage.bytes, entries: usage.entries }
    );
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  if (isWithin(canonicalSource, canonicalRoot)) {
    throw new GatewayError(ERROR_CODES.WORKSPACE_ERROR, "cwd contains the snapshot workspace root; choose a narrower cwd");
  }
  admit?.(usage.bytes);
  const home = join(canonicalRoot, `ws-${randomUUID()}`);
  const tree = join(home, "tree");
  const base = join(home, "base");
  try {
    await mkdir(home, { mode: 0o700 });
    // Before the copy, so a crash mid-copy still leaves a copy its owner can
    // recognize and reclaim on the next start.
    if (owner != null) await writeOwner(home, owner);
    const droppedLinks = await copyTree(canonicalSource, tree, excluded);
    await copyTree(canonicalSource, base, excluded);
    return {
      mode: "snapshot",
      source: canonicalSource,
      path: tree,
      base,
      home,
      root: canonicalRoot,
      bytes: usage.bytes,
      ...(droppedLinks.length ? { droppedLinks } : {})
    };
  } catch (error) {
    await rm(home, { recursive: true, force: true }).catch(() => {});
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(ERROR_CODES.WORKSPACE_ERROR, `Could not snapshot cwd: ${error?.message ?? error}`);
  }
}

// Copies with clonefile/reflink when available. Symlinks are never followed.
// A link whose target stays inside the source is rewritten to the same place
// inside the copy (a verbatim absolute link would edit the original); a link that
// leaves the source is dropped, because editing through it would escape the copy.
async function copyTree(source, destination, excluded) {
  const links = [];
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (item) => {
      if (excluded.some((path) => isWithin(path, item))) return false;
      const info = lstatSync(item);
      if (info.isSymbolicLink()) links.push(item);
      return info.isDirectory() || info.isFile() || info.isSymbolicLink();
    }
  });
  const dropped = [];
  for (const original of links) {
    const rel = relative(source, original);
    const copied = join(destination, rel);
    const target = await readlink(original);
    const resolved = resolve(dirname(original), target);
    let physical = null;
    try {
      physical = await realpath(resolved);
    } catch {
      physical = resolved;
    }
    await unlink(copied);
    if (isWithin(source, physical) && !excluded.some((path) => isWithin(path, physical))) {
      await symlink(relative(dirname(copied), join(destination, relative(source, physical))), copied);
    } else {
      dropped.push(rel);
    }
  }
  return dropped;
}

// Only ever removes a directory this module created: a record whose home is not
// a ws-* child of its own root is left alone rather than trusted.
export async function removeSnapshot(workspace) {
  if (!snapshotHome(workspace)) return false;
  await rm(workspace.home, { recursive: true, force: true });
  return true;
}

// Marks a copy a state already references (one made before 1.8.0 has no
// marker), so that once nothing references it any more it can be reclaimed
// like any other. An existing marker is never rewritten: whoever made the copy
// keeps it.
export async function adoptSnapshot(workspace, owner) {
  const home = snapshotHome(workspace);
  if (!home || owner == null) return false;
  try {
    await writeOwner(home, owner);
    return true;
  } catch {
    return false; // marked already, or the copy is gone
  }
}

// The copies under root that owner made, as records removeSnapshot accepts.
// Directories only: lstat-typed, so a link planted under the root is never
// followed. A copy with no marker, or another state's, is not listed.
export async function ownedSnapshots(root, owner) {
  if (owner == null) return [];
  let canonicalRoot;
  let entries;
  try {
    canonicalRoot = await realpath(root);
    entries = await readdir(canonicalRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const owned = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !HOME_NAME.test(entry.name)) continue;
    const home = join(canonicalRoot, entry.name);
    try {
      if (JSON.parse(await readFile(join(home, OWNER_FILE), "utf8"))?.state === owner) {
        owned.push({ mode: "snapshot", home, root: canonicalRoot });
      }
    } catch {
      // No marker, or not one we wrote: not ours to reclaim.
    }
  }
  return owned;
}

function snapshotHome(workspace) {
  if (workspace?.mode !== "snapshot" || typeof workspace.home !== "string" || typeof workspace.root !== "string") return null;
  return HOME_NAME.test(relative(workspace.root, workspace.home)) ? workspace.home : null;
}

// Beside tree and base, never inside them: the worker's cwd and the diff both
// stay exactly the copy of the source.
function writeOwner(home, owner) {
  return writeFile(join(home, OWNER_FILE), `${JSON.stringify({ state: owner })}\n`, { mode: 0o600, flag: "wx" });
}

// Unified diff from the snapshot baseline (a/) to the worker's copy (b/). git is
// only the diff engine (--no-index), so neither tree has to be a repository. It
// runs from the workspace home with relative "base" and "tree" operands, so only
// header paths carry those prefixes and file contents are never rewritten.
export async function snapshotDiff(workspace, { run = runGit, maxBytes = MAX_DIFF_BYTES } = {}) {
  if (workspace?.mode !== "snapshot") {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "Session was not opened with workspace=snapshot");
  }
  const args = ["diff", "--no-index", "--no-color", "--binary", "--no-ext-diff", "base", "tree"];
  const result = await run(args, { cwd: workspace.home, maxBytes });
  if (result.overLimit) {
    throw new GatewayError(
      ERROR_CODES.WORKSPACE_ERROR,
      `workspace diff exceeds ${maxBytes} bytes; inspect ${workspace.path} directly`,
      { maxBytes, workspace: workspace.path }
    );
  }
  // git diff --no-index: 0 = identical, 1 = differences, anything else failed.
  if (result.code !== 0 && result.code !== 1) {
    throw new GatewayError(
      ERROR_CODES.WORKSPACE_ERROR,
      `git diff failed: ${(result.stderr || `exit ${result.code}`).trim()}`
    );
  }
  const patch = relativizeHeaders(result.stdout);
  return { changed: result.code === 1, patch, files: changedFiles(patch) };
}

// Header lines only. git writes "a/base/<path>" and "b/tree/<path>", C-quoted
// ("\"a/base/...\"") when the path has special characters.
const HEADER = /^(diff --git |--- |\+\+\+ |rename from |rename to |copy from |copy to )/;

function relativizeHeaders(patch) {
  return patch.split("\n").map((line) => {
    if (!HEADER.test(line)) return line;
    return line
      .replace(/(^|\s|")a\/base\//g, "$1a/")
      .replace(/(^|\s|")b\/tree\//g, "$1b/")
      .replace(/(^|\s|")a\/tree\//g, "$1a/")
      .replace(/(^|\s|")b\/base\//g, "$1b/")
      .replace(/^(rename from |rename to |copy from |copy to )(base|tree)\//, "$1");
  }).join("\n");
}

function changedFiles(patch) {
  const files = [];
  for (const line of patch.split("\n")) {
    const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
    if (match) files.push(match[2] === "dev/null" ? match[1] : match[2]);
  }
  return files;
}

async function measureTree(root, excluded = []) {
  let bytes = 0;
  let entries = 0;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (excluded.some((item) => isWithin(item, path))) continue;
      entries += 1;
      if (entries > MAX_SNAPSHOT_ENTRIES) return { bytes, entries };
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) {
        bytes += (await lstat(path)).size;
        if (bytes > MAX_SNAPSHOT_BYTES) return { bytes, entries };
      }
    }
  }
  return { bytes, entries };
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Bounded: past maxBytes the child is killed and the result says so, rather than
// buffering a multi-gigabyte patch in the daemon.
function runGit(args, { cwd, maxBytes = MAX_DIFF_BYTES } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: childEnv() });
    const out = [];
    let size = 0;
    let overLimit = false;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (overLimit) return;
      size += chunk.length;
      if (size > maxBytes) {
        overLimit = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.once("error", (error) => reject(new GatewayError(
      ERROR_CODES.WORKSPACE_ERROR, `git is required for workspace_diff: ${error.message}`
    )));
    child.once("close", (code) => resolvePromise({
      code: code ?? 1,
      overLimit,
      stdout: overLimit ? "" : Buffer.concat(out).toString("utf8"),
      stderr
    }));
  });
}
