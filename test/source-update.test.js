import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareUpdate, updateSourceCheckout } from "../src/source-update.js";
import { GATEWAY_VERSION } from "../src/version.js";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const STAGING = "/tmp/acp-gateway-update-x/staging";
const noLock = async () => async () => {};

// A scripted runner: each step names the command it expects, so a test fails on
// the first out-of-order call instead of on a confusing downstream assertion.
function scripted(steps) {
  const calls = [];
  const run = async (command, args, cwd) => {
    calls.push({ line: [command, ...args].join(" "), cwd });
    const step = steps.shift();
    assert.ok(step, `unexpected call: ${command} ${args.join(" ")}`);
    assert.equal([command, ...args].join(" "), step[0]);
    return { code: step[1] ?? 0, stdout: step[2] ?? "", stderr: step[3] ?? "" };
  };
  return { run, calls, steps };
}

test("source update with no new commits validates the live checkout in place", async () => {
  const { run, calls, steps } = scripted([
    ["git rev-parse --is-inside-work-tree", 0, "true\n"],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    ["git fetch --quiet"],
    ["git rev-parse @{u}", 0, `${OLD}\n`],
    ["npm ci", 0, "installed\n"],
    ["npm run monitor:check", 2, "upstream changes detected\n"],
    ["npm run ci", 0, "84 tests passed\n"]
  ]);
  const result = await updateSourceCheckout("/repo", { run, makeStagingDir: async () => STAGING, lock: noLock });
  assert.equal(steps.length, 0);
  assert.ok(calls.every((call) => call.cwd === "/repo"));
  assert.equal(result.pull, "Already up to date.");
  assert.equal(result.upstream.changesDetected, true);
  assert.equal(result.upstream.maintainerCommand, "npm run update:upstream");
  assert.equal(result.validation, "84 tests passed");
});

test("source update validates new commits in a staging worktree before fast-forwarding", async () => {
  const { run, calls, steps } = scripted([
    ["git rev-parse --is-inside-work-tree", 0, "true\n"],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    ["git fetch --quiet"],
    ["git rev-parse @{u}", 0, `${NEW}\n`],
    [`git worktree add --detach ${STAGING} ${NEW}`],
    ["npm ci", 0, "staged install\n"],
    ["npm run monitor:check", 0, "no upstream changes\n"],
    ["npm run ci", 0, "staged tests passed\n"],
    [`git worktree remove --force ${STAGING}`],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    [`git merge --ff-only ${NEW}`, 0, "Fast-forward\n"],
    ["npm ci", 0, "installed\n"]
  ]);
  const result = await updateSourceCheckout("/repo", { run, makeStagingDir: async () => STAGING, lock: noLock });
  assert.equal(steps.length, 0);
  // Install and validation of the new commit ran in staging, never in the live tree.
  assert.deepEqual(
    calls.filter((call) => call.cwd === STAGING).map((call) => call.line),
    ["npm ci", "npm run monitor:check", "npm run ci"]
  );
  assert.equal(result.previous, OLD);
  assert.equal(result.target, NEW);
  assert.equal(result.validation, "staged tests passed");
  assert.equal(result.upstream.changesDetected, false);
});

test("a staged validation failure leaves the live checkout untouched", async () => {
  const { run, calls } = scripted([
    ["git rev-parse --is-inside-work-tree", 0, "true\n"],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    ["git fetch --quiet"],
    ["git rev-parse @{u}", 0, `${NEW}\n`],
    [`git worktree add --detach ${STAGING} ${NEW}`],
    ["npm ci", 0, "staged install\n"],
    ["npm run monitor:check", 0, ""],
    ["npm run ci", 1, "", "2 tests failed"],
    [`git worktree remove --force ${STAGING}`]
  ]);
  await assert.rejects(
    updateSourceCheckout("/repo", { run, makeStagingDir: async () => STAGING, lock: noLock }),
    /validate the staged update failed: 2 tests failed/
  );
  assert.equal(calls.some((call) => call.line.startsWith("git merge")), false);
  assert.equal(calls.some((call) => call.cwd === "/repo" && call.line === "npm ci"), false);
});

test("a failed dependency install after fast-forward rolls back to the previous commit", async () => {
  const { run, steps } = scripted([
    ["git rev-parse --is-inside-work-tree", 0, "true\n"],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    ["git fetch --quiet"],
    ["git rev-parse @{u}", 0, `${NEW}\n`],
    [`git worktree add --detach ${STAGING} ${NEW}`],
    ["npm ci"],
    ["npm run monitor:check"],
    ["npm run ci", 0, "ok\n"],
    [`git worktree remove --force ${STAGING}`],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    [`git merge --ff-only ${NEW}`],
    ["npm ci", 1, "", "network down"],
    ["git rev-parse HEAD", 0, `${NEW}\n`],
    ["git status --porcelain --untracked-files=no"],
    [`git reset --hard ${OLD}`],
    ["npm ci", 0, "restored\n"]
  ]);
  await assert.rejects(
    updateSourceCheckout("/repo", { run, makeStagingDir: async () => STAGING, lock: noLock }),
    new RegExp(`network down; rolled back to ${OLD}`)
  );
  assert.equal(steps.length, 0);
});

test("a live-tree change during staging aborts before anything is applied", async () => {
  const { run, calls, steps } = scripted([
    ["git rev-parse --is-inside-work-tree", 0, "true\n"],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    ["git fetch --quiet"],
    ["git rev-parse @{u}", 0, `${NEW}\n`],
    [`git worktree add --detach ${STAGING} ${NEW}`],
    ["npm ci"],
    ["npm run monitor:check"],
    ["npm run ci", 0, "ok\n"],
    [`git worktree remove --force ${STAGING}`],
    ["git status --porcelain", 0, " M README.md\n"]
  ]);
  await assert.rejects(updateSourceCheckout("/repo", { run, makeStagingDir: async () => STAGING, lock: noLock }), /changed while the update was being validated/);
  assert.equal(steps.length, 0);
  assert.equal(calls.some((call) => call.line.startsWith("git merge")), false);
});

test("a failed rollback is reported as failed, never as rolled back", async () => {
  const { run } = scripted([
    ["git rev-parse --is-inside-work-tree", 0, "true\n"],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    ["git fetch --quiet"],
    ["git rev-parse @{u}", 0, `${NEW}\n`],
    [`git worktree add --detach ${STAGING} ${NEW}`],
    ["npm ci"],
    ["npm run monitor:check"],
    ["npm run ci", 0, "ok\n"],
    [`git worktree remove --force ${STAGING}`],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    [`git merge --ff-only ${NEW}`],
    ["npm ci", 1, "", "network down"],
    ["git rev-parse HEAD", 0, `${NEW}\n`],
    ["git status --porcelain --untracked-files=no"],
    [`git reset --hard ${OLD}`, 128, "", "index.lock exists"]
  ]);
  await assert.rejects(
    updateSourceCheckout("/repo", { run, makeStagingDir: async () => STAGING, lock: noLock }),
    (error) => /rollback FAILED/.test(error.message) && !/; rolled back to/.test(error.message)
  );
});

test("HEAD moved by someone else during staging aborts before the merge", async () => {
  const { run, calls, steps } = scripted([
    ["git rev-parse --is-inside-work-tree", 0, "true\n"],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    ["git fetch --quiet"],
    ["git rev-parse @{u}", 0, `${NEW}\n`],
    [`git worktree add --detach ${STAGING} ${NEW}`],
    ["npm ci"],
    ["npm run monitor:check"],
    ["npm run ci", 0, "ok\n"],
    [`git worktree remove --force ${STAGING}`],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${"3".repeat(40)}\n`]
  ]);
  await assert.rejects(updateSourceCheckout("/repo", { run, makeStagingDir: async () => STAGING, lock: noLock }), /moved from .* during validation/);
  assert.equal(steps.length, 0);
  assert.equal(calls.some((call) => call.line.startsWith("git merge")), false);
});

test("a rollback never resets a checkout that changed after the merge", async () => {
  const { run, calls } = scripted([
    ["git rev-parse --is-inside-work-tree", 0, "true\n"],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    ["git fetch --quiet"],
    ["git rev-parse @{u}", 0, `${NEW}\n`],
    [`git worktree add --detach ${STAGING} ${NEW}`],
    ["npm ci"],
    ["npm run monitor:check"],
    ["npm run ci", 0, "ok\n"],
    [`git worktree remove --force ${STAGING}`],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    [`git merge --ff-only ${NEW}`],
    ["npm ci", 1, "", "network down"],
    ["git rev-parse HEAD", 0, `${NEW}\n`],
    ["git status --porcelain --untracked-files=no", 0, " M src/local.js\n"]
  ]);
  await assert.rejects(updateSourceCheckout("/repo", { run, makeStagingDir: async () => STAGING, lock: noLock }), /rollback SKIPPED/);
  assert.equal(calls.some((call) => call.line.startsWith("git reset")), false);
});

test("updates are serialized by the lock and the lock is released on failure", async () => {
  const events = [];
  const lock = async () => {
    events.push("acquire");
    return async () => events.push("release");
  };
  const { run } = scripted([
    ["git rev-parse --is-inside-work-tree", 0, "true\n"],
    ["git status --porcelain", 0, " M dirty\n"]
  ]);
  await assert.rejects(updateSourceCheckout("/repo", { run, lock }), /commit or stash/);
  assert.deepEqual(events, ["acquire", "release"]);
});

test("source update reports an unavailable upstream check but still requires local validation", async () => {
  const { run } = scripted([
    ["git rev-parse --is-inside-work-tree", 0, "true\n"],
    ["git status --porcelain"],
    ["git rev-parse HEAD", 0, `${OLD}\n`],
    ["git fetch --quiet"],
    ["git rev-parse @{u}", 0, `${OLD}\n`],
    ["npm ci"],
    ["npm run monitor:check", 1, "", "rate limited"],
    ["npm run ci", 0, "validated\n"]
  ]);
  const result = await updateSourceCheckout("/repo", { run, makeStagingDir: async () => STAGING, lock: noLock });
  assert.equal(result.upstream.checked, false);
  assert.match(result.upstream.warning, /rate limited/);
  assert.equal(result.validation, "validated");
});

test("source update refuses to overwrite local changes", async () => {
  const { run, steps } = scripted([
    ["git rev-parse --is-inside-work-tree", 0, "true\n"],
    ["git status --porcelain", 0, " M src/file.js\n"]
  ]);
  await assert.rejects(updateSourceCheckout("/repo", { run, lock: noLock }), /commit or stash/);
  assert.equal(steps.length, 0);
});

test("a real update lock held by a live process refuses a second update", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acp-update-lock-")));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8" }).trim();
    await writeFile(join(gitDir, "acp-gateway-update.lock"), `${process.pid}\n`);
    await assert.rejects(updateSourceCheckout(root), /Another ACP Gateway update is running/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--update on an npm install runs no git and names the npm upgrade", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(" "));
    return { code: 0, stdout: "", stderr: "" };
  };
  const newer = await prepareUpdate("/usr/local/lib/node_modules/acp-gateway-daemon", {
    run,
    checkRelease: async () => ({ latestVersion: "9.0.0", updateAvailable: true })
  });
  assert.deepEqual(calls, [], "no git or npm command may run for an npm install");
  assert.equal(newer.installMode, "npm");
  assert.equal(newer.phase, "package-update");
  assert.equal(newer.reexec, false);
  assert.equal(newer.updateAvailable, true);
  assert.equal(newer.command, "npm install -g acp-gateway-daemon@latest");
  assert.equal(
    newer.message,
    "ACP Gateway 9.0.0 is available on npm. Run `npm install -g acp-gateway-daemon@latest`, then `acp-gateway-bootstrap --update` again."
  );

  const current = await prepareUpdate("/usr/local/lib/node_modules/acp-gateway-daemon", {
    installMode: "npm",
    run,
    checkRelease: async () => ({ latestVersion: GATEWAY_VERSION, updateAvailable: false })
  });
  assert.equal(current.updateAvailable, false);
  assert.equal(current.command, undefined);

  const offline = await prepareUpdate("/usr/local/lib/node_modules/acp-gateway-daemon", {
    installMode: "npm",
    run,
    checkRelease: async () => { throw new Error("fetch failed"); }
  });
  assert.equal(offline.reexec, false, "a registry failure must not block the registration refresh");
  assert.equal(offline.updateAvailable, null);
  assert.equal(offline.warning, "npm registry check failed: fetch failed");
  assert.deepEqual(calls, []);
});

test("--update on an app-managed runtime runs no git and asks no registry", async () => {
  const run = async (command, args) => assert.fail(`unexpected ${command} ${args.join(" ")}`);
  for (const root of [
    "/Users/me/.acp-gateway/runtime/versions/1.7.0-0123abcd/gateway",
    "/Users/me/.acp-gateway/runtime/versions/1.8.0/node_modules/acp-gateway-daemon"
  ]) {
    const result = await prepareUpdate(root, {
      run,
      checkRelease: async () => assert.fail("the app updates a runtime install; npm is not asked")
    });
    assert.equal(result.installMode, "runtime", root);
    assert.equal(result.status, "managed");
    assert.equal(result.reexec, false);
    assert.equal(result.command, undefined);
  }
});

test("--update on a source checkout still pulls through git and re-executes", async () => {
  const run = async () => assert.fail("the stubbed source update runs the commands");
  let received;
  const result = await prepareUpdate("/repo", {
    installMode: "source",
    run,
    checkRelease: async () => assert.fail("a checkout is not compared with npm"),
    updateSource: async (root, options) => {
      received = { root, run: options.run };
      return { root, pull: "Already up to date." };
    }
  });
  assert.equal(received.root, "/repo");
  assert.equal(received.run, run, "the injected runner reaches the Git update");
  assert.equal(result.phase, "source-update");
  assert.equal(result.installMode, "source");
  assert.equal(result.reexec, true);
  assert.equal(result.pull, "Already up to date.");

  // An unknown layout takes the same path, and Git itself refuses a non-checkout.
  const { run: gitRun, calls } = scripted([
    ["git rev-parse --is-inside-work-tree", 0, "false\n"]
  ]);
  await assert.rejects(prepareUpdate("/copied-tree", { installMode: "unknown", run: gitRun }), /not inside a Git worktree/);
  assert.deepEqual(calls.map((call) => call.line), ["git rev-parse --is-inside-work-tree"]);
});
