import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNpmRelease, NPM_UPGRADE_COMMAND } from "./gateway-source-monitor.js";
import { detectInstallMode } from "./install-mode.js";
import { GATEWAY_VERSION } from "./version.js";

// The first half of `acp-gateway-bootstrap --update`, by install mode. Only a
// source checkout (or a tree whose mode is unknown, where Git itself decides)
// is pulled and validated, after which the updated bootstrap is re-executed.
// An npm install or an app-managed runtime is replaced by its owner, never by
// Git: nothing here runs git or npm for them, and the caller goes straight on
// to refresh this install's registrations. An npm install also learns whether
// the registry has a newer release and the command that installs it.
export async function prepareUpdate(root, {
  installMode = detectInstallMode(root),
  run = runSourceCommand,
  updateSource = updateSourceCheckout,
  checkRelease = checkNpmRelease
} = {}) {
  if (installMode === "runtime") {
    return {
      phase: "package-update",
      installMode,
      reexec: false,
      status: "managed",
      currentVersion: GATEWAY_VERSION,
      message: "This ACP Gateway is managed by the app that installed it; update it through that app. Registrations are refreshed for this install."
    };
  }
  if (installMode === "npm") {
    let release;
    try {
      release = await checkRelease();
    } catch (error) {
      return {
        phase: "package-update",
        installMode,
        reexec: false,
        status: "error",
        currentVersion: GATEWAY_VERSION,
        latestVersion: null,
        updateAvailable: null,
        warning: `npm registry check failed: ${error?.message ?? String(error)}`
      };
    }
    return {
      phase: "package-update",
      installMode,
      reexec: false,
      status: "ready",
      currentVersion: GATEWAY_VERSION,
      latestVersion: release.latestVersion,
      updateAvailable: release.updateAvailable,
      ...(release.updateAvailable
        ? {
            command: NPM_UPGRADE_COMMAND,
            message: `ACP Gateway ${release.latestVersion} is available on npm. Run \`${NPM_UPGRADE_COMMAND}\`, then \`acp-gateway-bootstrap --update\` again.`
          }
        : {})
    };
  }
  const source = await updateSource(root, { run });
  return { phase: "source-update", installMode, reexec: true, ...source };
}

// Validate before touching the live checkout. The running daemon and every MCP
// front door execute this very checkout (npm link), so the old order (pull, then
// npm ci, then test) left a half-updated install whenever a step failed. Now new
// upstream commits are installed and tested in a throwaway git worktree first;
// the live checkout only fast-forwards to a commit that already passed, and a
// failed dependency install afterwards is rolled back to the previous commit.
export async function updateSourceCheckout(root, { run = runSourceCommand, makeStagingDir = defaultStagingDir, lock = acquireUpdateLock } = {}) {
  const repository = await requireSuccess(run, "git", ["rev-parse", "--is-inside-work-tree"], root, "locate the Git checkout");
  if (repository.stdout.trim() !== "true") throw new Error("ACP Gateway source is not inside a Git worktree");
  // Two updates at once would each validate, merge and possibly roll back over
  // the other. One at a time, per checkout.
  const release = await lock(root, run);
  try {
    return await updateLocked(root, { run, makeStagingDir });
  } finally {
    await release();
  }
}

async function updateLocked(root, { run, makeStagingDir }) {
  const status = await requireSuccess(run, "git", ["status", "--porcelain"], root, "inspect local source changes");
  if (status.stdout.trim()) {
    throw new Error("ACP Gateway source has local changes; commit or stash them before --update");
  }

  const previous = (await requireSuccess(run, "git", ["rev-parse", "HEAD"], root, "read the current commit")).stdout.trim();
  await requireSuccess(run, "git", ["fetch", "--quiet"], root, "fetch ACP Gateway source");
  const target = (await requireSuccess(run, "git", ["rev-parse", "@{u}"], root, "resolve the upstream branch")).stdout.trim();

  if (target === previous) {
    const install = await requireSuccess(run, "npm", ["ci"], root, "install ACP Gateway dependencies");
    const upstream = await inspectUpstream(run, root);
    const validation = await requireSuccess(run, "npm", ["run", "ci"], root, "validate the ACP Gateway source");
    return {
      root,
      pull: "Already up to date.",
      previous,
      target,
      dependencies: install.stdout.trim() || install.stderr.trim(),
      upstream,
      validation: validation.stdout.trim() || validation.stderr.trim()
    };
  }

  const staging = await makeStagingDir();
  let validation;
  let upstream;
  try {
    await requireSuccess(run, "git", ["worktree", "add", "--detach", staging, target], root, "stage the upstream commit");
    await requireSuccess(run, "npm", ["ci"], staging, "install dependencies for the staged update");
    upstream = await inspectUpstream(run, staging);
    validation = await requireSuccess(run, "npm", ["run", "ci"], staging, "validate the staged update");
  } finally {
    await run("git", ["worktree", "remove", "--force", staging], root).catch(() => {});
  }

  // Staging can take minutes. A change made to the live tree meanwhile would be
  // carried through the merge and then destroyed by a rollback reset.
  const settled = await requireSuccess(run, "git", ["status", "--porcelain"], root, "re-check local source changes");
  if (settled.stdout.trim()) {
    throw new Error("ACP Gateway source changed while the update was being validated; nothing was applied, rerun --update");
  }
  // Compare-and-swap on HEAD: something else moved the checkout during staging.
  const head = (await requireSuccess(run, "git", ["rev-parse", "HEAD"], root, "re-read the current commit")).stdout.trim();
  if (head !== previous) {
    throw new Error(`ACP Gateway source moved from ${previous} to ${head} during validation; nothing was applied, rerun --update`);
  }
  const pull = await requireSuccess(run, "git", ["merge", "--ff-only", target], root, "fast-forward the live checkout");
  let install;
  try {
    install = await requireSuccess(run, "npm", ["ci"], root, "install ACP Gateway dependencies");
  } catch (error) {
    // Back to the commit whose dependencies were installed and working. Each
    // step is checked: claiming a rollback that did not happen is worse than
    // the original failure.
    // Only reset what this update produced: HEAD must still be the target and
    // the tree must still be clean, or the reset would destroy someone's work.
    const now = await run("git", ["rev-parse", "HEAD"], root);
    const dirty = await run("git", ["status", "--porcelain", "--untracked-files=no"], root);
    if (now.stdout?.trim() !== target || dirty.stdout?.trim()) {
      throw new Error(`${error.message}; rollback SKIPPED because the checkout changed after the merge; it is not at ${previous}`);
    }
    const reset = await run("git", ["reset", "--hard", previous], root);
    if (reset.code !== 0) {
      throw new Error(`${error.message}; rollback FAILED at git reset (${(reset.stderr || reset.stdout).trim()}); the checkout is at ${target}`);
    }
    const restored = await run("npm", ["ci"], root);
    if (restored.code !== 0) {
      throw new Error(`${error.message}; rolled back to ${previous} but dependency reinstall FAILED (${(restored.stderr || restored.stdout).trim()}); run npm ci`);
    }
    throw new Error(`${error.message}; rolled back to ${previous}`);
  }
  return {
    root,
    pull: pull.stdout.trim() || pull.stderr.trim(),
    previous,
    target,
    dependencies: install.stdout.trim() || install.stderr.trim(),
    upstream,
    validation: validation.stdout.trim() || validation.stderr.trim()
  };
}

// An exclusive lock file inside the repository's git directory. A lock whose
// owner process is gone is stale and taken over; a live owner is an error.
async function acquireUpdateLock(root, run) {
  const gitDir = (await requireSuccess(run, "git", ["rev-parse", "--absolute-git-dir"], root, "locate the git directory")).stdout.trim();
  const path = join(gitDir, "acp-gateway-update.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => { await unlink(path).catch(() => {}); };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = Number((await readFile(path, "utf8").catch(() => "")).trim());
      if (Number.isInteger(owner) && owner > 0 && processAlive(owner)) {
        throw new Error(`Another ACP Gateway update is running (pid ${owner}); wait for it to finish`);
      }
      await unlink(path).catch(() => {});
    }
  }
  throw new Error(`Could not acquire the update lock at ${path}`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function defaultStagingDir() {
  const parent = await mkdtemp(join(tmpdir(), "acp-gateway-update-"));
  return join(parent, "staging");
}

async function inspectUpstream(run, root) {
  const result = await run("npm", ["run", "monitor:check"], root);
  const output = (result.stdout || result.stderr || "").trim();
  if (result.code === 0 || result.code === 2) {
    return {
      checked: true,
      changesDetected: result.code === 2,
      report: output,
      ...(result.code === 2 ? { maintainerCommand: "npm run update:upstream" } : {})
    };
  }
  return {
    checked: false,
    changesDetected: null,
    warning: output || `monitor:check exited ${result.code}`
  };
}

export function runSourceCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function requireSuccess(run, command, args, cwd, action) {
  const result = await run(command, args, cwd);
  if (result.code === 0) return result;
  throw new Error(`${action} failed: ${(result.stderr || result.stdout || `${command} exited ${result.code}`).trim()}`);
}
