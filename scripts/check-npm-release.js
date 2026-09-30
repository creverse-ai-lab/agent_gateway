#!/usr/bin/env node

// Release gate for .github/workflows/publish-npm.yml, run right after checkout
// and before anything is installed. A version is published to npm only from
// its own release tag:
// - the input version is X.Y.Z and equals package.json and GATEWAY_VERSION,
//   and the package is acp-gateway-daemon;
// - the run was dispatched on refs/tags/v<version> (not a branch, not another
//   tag), so the provenance npm records names the release tag;
// - the checked-out commit is the commit that tag points at and the commit the
//   run was dispatched for. actions/checkout fetches a tag ref by name and
//   checks out whatever the tag points at when it runs, which is not
//   GITHUB_SHA if the tag was moved after the dispatch.
//
// Usage (the workflow sets the environment): VERSION=1.7.2 node scripts/check-npm-release.js
// GITHUB_REF and GITHUB_SHA come from GitHub Actions.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_VERSION } from "../src/version.js";

export const NPM_PACKAGE_NAME = "acp-gateway-daemon";
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Every reason the run must not publish; empty when it may.
export function npmReleaseProblems({ version, packageName, packageVersion, gatewayVersion, ref, sha, headCommit, tagCommit }) {
  const problems = [];
  if (!RELEASE_VERSION.test(version ?? "")) {
    problems.push(`input version ${JSON.stringify(version ?? "")} is not X.Y.Z`);
    return problems;
  }
  const tagRef = `refs/tags/v${version}`;
  if (packageName !== NPM_PACKAGE_NAME) problems.push(`package name is ${packageName}, not ${NPM_PACKAGE_NAME}`);
  if (packageVersion !== version) problems.push(`package.json version ${packageVersion} != ${version}`);
  if (gatewayVersion !== version) problems.push(`GATEWAY_VERSION ${gatewayVersion} != ${version}`);
  if (ref !== tagRef) {
    problems.push(`the run must be dispatched on the release tag ${tagRef}, not ${ref || "(no ref)"}; `
      + `run: gh workflow run publish-npm.yml --ref v${version} -f version=${version}`);
    return problems;
  }
  if (!COMMIT.test(sha ?? "")) {
    problems.push(`GITHUB_SHA ${JSON.stringify(sha ?? "")} is not a commit id`);
    return problems;
  }
  if (!tagCommit) problems.push(`tag v${version} is not in the checkout`);
  else if (tagCommit !== sha) problems.push(`tag v${version} now points at ${tagCommit}, but the run was dispatched for ${sha}; the tag was moved`);
  if (headCommit !== sha) problems.push(`checked out ${headCommit || "(nothing)"}, but the run was dispatched for ${sha}`);
  return problems;
}

function commitOf(cwd, revision) {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const packageDocument = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const { VERSION: version, GITHUB_REF: ref, GITHUB_SHA: sha } = process.env;
  const problems = npmReleaseProblems({
    version,
    packageName: packageDocument.name,
    packageVersion: packageDocument.version,
    gatewayVersion: GATEWAY_VERSION,
    ref,
    sha,
    headCommit: commitOf(repositoryRoot, "HEAD"),
    // Only a validated X.Y.Z reaches git, and as one argument.
    tagCommit: RELEASE_VERSION.test(version ?? "") ? commitOf(repositoryRoot, `refs/tags/v${version}`) : null
  });
  if (problems.length) {
    const prefix = process.env.GITHUB_ACTIONS === "true" ? "::error title=Not a release run::" : "";
    for (const problem of problems) process.stderr.write(`${prefix}${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(`publishing ${packageDocument.name}@${version} from ${ref} at ${sha}\n`);
}
