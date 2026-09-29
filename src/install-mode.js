import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// How this copy of the Gateway got onto the machine, which decides who may
// update it: a Git checkout updates itself (--update pulls), an npm install is
// replaced by npm, and a runtime release belongs to the app that installed it.
//   source  - the package root is a Git checkout (.git directory or worktree file)
//   runtime - an app-managed release: under <home>/runtime/versions/<id>/, or a
//             root carrying the runtime-manifest.json that only the runtime
//             release build writes
//   npm     - inside a node_modules directory, with no .git
//   unknown - none of the above (a copied or unpacked tree)
export const INSTALL_MODES = Object.freeze(["source", "npm", "runtime", "unknown"]);

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Pure: the answer from a path and two facts about it. The .git check wins so
// that an `npm link` or folder install (a symlink to a checkout, which Node
// resolves to its real path) is still a checkout.
export function classifyInstallMode({ root, hasGit = false, hasRuntimeManifest = false } = {}) {
  const segments = String(root ?? "").split(/[\\/]+/).filter(Boolean);
  if (hasGit) return "source";
  if (hasRuntimeManifest || underRuntimeVersions(segments)) return "runtime";
  if (segments.includes("node_modules")) return "npm";
  return "unknown";
}

export function detectInstallMode(root = PACKAGE_ROOT, { exists = existsSync } = {}) {
  return classifyInstallMode({
    root,
    hasGit: exists(join(root, ".git")),
    hasRuntimeManifest: exists(join(root, "runtime-manifest.json"))
  });
}

// ".../runtime/versions/<id>/..." with at least the version id below it; a
// bare "versions" (nvm keeps Node in ~/.nvm/versions/node) is not enough.
function underRuntimeVersions(segments) {
  for (let index = 0; index + 2 < segments.length; index += 1) {
    if (segments[index] === "runtime" && segments[index + 1] === "versions") return true;
  }
  return false;
}
