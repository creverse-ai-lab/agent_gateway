import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";

// Who is on the other end of a control connection. The control MCP server is a
// child of the agent CLI that uses it, so its parent process and the session id
// that CLI exports are facts about the caller, not guesses. The Gateway records
// them on the sessions a caller opens and the turns it starts, so a consumer can
// tell two Mains apart without reading either one's transcript (every Main on a
// machine shares one rootId).
//
// instanceId is minted per MCP server process. Codex exports no thread id to its
// MCP servers and one Codex app process hosts many threads, so for Codex the
// instance is the only stable handle: everything one thread did carries the same
// one.

export const CALLER_PROVIDERS = Object.freeze(["claude", "codex", "grok"]);
const SESSION_ENV = Object.freeze({
  claude: "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
  grok: "GROK_SESSION_ID"
});
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The agent CLI a process name belongs to, or null. */
export function agentFromCommand(command) {
  const name = basename(String(command ?? "").trim()).toLowerCase();
  return CALLER_PROVIDERS.find((provider) => name.includes(provider)) ?? null;
}

function readParentCommand(ppid) {
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(ppid)], { encoding: "utf8", timeout: 1_000 }).trim();
  } catch {
    return null;
  }
}

export function callerFromProcess({ env = process.env, ppid = process.ppid, readCommand = readParentCommand } = {}) {
  const pid = Number.isInteger(ppid) && ppid > 1 ? ppid : null;
  // The parent's own name decides the provider. Session markers alone can't:
  // an agent started from another agent's shell inherits its launcher's id too.
  let provider = pid ? agentFromCommand(readCommand(pid)) : null;
  if (!provider) {
    const marked = CALLER_PROVIDERS.filter((candidate) => ID.test(env[SESSION_ENV[candidate]] ?? ""));
    provider = marked.length === 1 ? marked[0] : null;
  }
  const sessionId = provider && ID.test(env[SESSION_ENV[provider]] ?? "") ? env[SESSION_ENV[provider]] : null;
  return normalizeCaller({ provider, sessionId, pid, instanceId: `mcp-${randomUUID()}` });
}

/**
 * The caller a request claims, reduced to known, well-formed fields, or null.
 * Tolerant by design: a malformed caller only loses attribution, never the call.
 */
export function normalizeCaller(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.instanceId !== "string" || !ID.test(value.instanceId)) return null;
  return {
    provider: CALLER_PROVIDERS.includes(value.provider) ? value.provider : null,
    sessionId: typeof value.sessionId === "string" && ID.test(value.sessionId) ? value.sessionId : null,
    pid: Number.isInteger(value.pid) && value.pid > 1 ? value.pid : null,
    instanceId: value.instanceId
  };
}
