import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Grok's native tools (grep/rg, list_dir) read files in-process, never through
// ACP fs/read_text_file, so the Gateway's path checks never see them. Grok can
// sandbox its whole process at startup (Seatbelt on macOS, Landlock on Linux)
// from a profile in <process cwd>/.grok/sandbox.toml. One Grok process serves
// every session, so per-session roots cannot be expressed there, but the
// Gateway-protected paths can: they are the same for every session.
export const GROK_SANDBOX_PROFILE = "acp-gateway";

export function defaultGrokSandboxDir() {
  return process.env.ACP_GATEWAY_GROK_SANDBOX_DIR || join(homedir(), ".cache", "acp-gateway", "grok-sandbox");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

// Writes the profile and returns the spawn overrides. Rewritten on every start
// so a changed protected-path set takes effect with the next process.
export function prepareGrokSandbox(protectedPaths, directory = defaultGrokSandboxDir()) {
  mkdirSync(join(directory, ".grok"), { recursive: true, mode: 0o700 });
  const profile = [
    "# Written by ACP Gateway. Denies Gateway-protected paths to the Grok process.",
    `[profiles.${GROK_SANDBOX_PROFILE}]`,
    'extends = "workspace"',
    `deny = [${protectedPaths.map(tomlString).join(", ")}]`,
    ""
  ].join("\n");
  writeFileSync(join(directory, ".grok", "sandbox.toml"), profile, { mode: 0o600 });
  return { cwd: directory, env: { GROK_SANDBOX: GROK_SANDBOX_PROFILE } };
}
