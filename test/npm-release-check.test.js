import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NPM_PACKAGE_NAME, npmReleaseProblems } from "../scripts/check-npm-release.js";
import { GATEWAY_VERSION } from "../src/version.js";

const SHA = "a".repeat(40);
const script = fileURLToPath(new URL("../scripts/check-npm-release.js", import.meta.url));

function release(overrides = {}) {
  return {
    version: "1.7.2",
    packageName: NPM_PACKAGE_NAME,
    packageVersion: "1.7.2",
    gatewayVersion: "1.7.2",
    ref: "refs/tags/v1.7.2",
    sha: SHA,
    headCommit: SHA,
    tagCommit: SHA,
    ...overrides
  };
}

test("a run on the release tag at the tag's commit may publish", () => {
  assert.deepEqual(npmReleaseProblems(release()), []);
});

test("the input version must be X.Y.Z before anything else is compared", () => {
  for (const version of [undefined, "", "v1.7.2", "1.7", "1.7.2-rc.1", "1.7.2 ", "--help"]) {
    const problems = npmReleaseProblems(release({ version }));
    assert.equal(problems.length, 1, `version ${JSON.stringify(version)}`);
    assert.match(problems[0], /is not X\.Y\.Z/);
  }
});

test("the version must match package.json and GATEWAY_VERSION, and the package name must be acp-gateway-daemon", () => {
  assert.deepEqual(npmReleaseProblems(release({ packageVersion: "1.7.1", gatewayVersion: "1.7.3", packageName: "acp-gateway" })), [
    `package name is acp-gateway, not ${NPM_PACKAGE_NAME}`,
    "package.json version 1.7.1 != 1.7.2",
    "GATEWAY_VERSION 1.7.3 != 1.7.2"
  ]);
});

test("a run dispatched on a branch or another tag is refused", () => {
  for (const ref of ["refs/heads/main", "refs/heads/v1.7.2", "refs/tags/v1.7.1", "refs/tags/1.7.2", "refs/tags/v1.7.2-rc", "", undefined]) {
    const problems = npmReleaseProblems(release({ ref }));
    assert.equal(problems.length, 1, `ref ${ref}`);
    assert.match(problems[0], /must be dispatched on the release tag refs\/tags\/v1\.7\.2/);
    assert.match(problems[0], /gh workflow run publish-npm\.yml --ref v1\.7\.2 -f version=1\.7\.2/);
  }
});

test("the checked-out commit must be the tag's commit and the dispatched commit", () => {
  const other = "b".repeat(40);
  assert.match(npmReleaseProblems(release({ tagCommit: other, headCommit: other }))[0], /the tag was moved/);
  assert.deepEqual(npmReleaseProblems(release({ headCommit: other })), [`checked out ${other}, but the run was dispatched for ${SHA}`]);
  assert.deepEqual(npmReleaseProblems(release({ tagCommit: null })), ["tag v1.7.2 is not in the checkout"]);
  assert.deepEqual(npmReleaseProblems(release({ headCommit: null })), [`checked out (nothing), but the run was dispatched for ${SHA}`]);
});

test("a missing or malformed GITHUB_SHA never matches an equally missing commit", () => {
  for (const sha of [undefined, "", "HEAD", "abc123"]) {
    const problems = npmReleaseProblems(release({ sha, headCommit: sha, tagCommit: sha }));
    assert.equal(problems.length, 1, `sha ${sha}`);
    assert.match(problems[0], /is not a commit id/);
  }
});

test("the gate fails a run that is not on the release tag, with the fix in the message", () => {
  const env = { ...process.env, VERSION: GATEWAY_VERSION, GITHUB_REF: "refs/heads/main", GITHUB_SHA: SHA, GITHUB_ACTIONS: "true" };
  const result = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`^::error title=Not a release run::the run must be dispatched on the release tag refs/tags/v${GATEWAY_VERSION.replaceAll(".", "\\.")}, not refs/heads/main`));
});
