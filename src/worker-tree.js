import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { childEnv, GATEWAY_WORKER_ENV } from "./caller.js";
import { gatewaySocketPath } from "./config.js";

// Workers never get the Control. A worker can get it without anyone handing it
// over: its agent CLI loads the user's own MCP config (Codex reads
// ~/.codex/config.toml for the workers the Gateway starts, as it does for the
// Main), that config registers the Control MCP, and the front door finds its
// identity in install.json. So both ends look at where the process runs: the
// front door refuses to start inside a worker's process tree
// (workerTreeReason), and the daemon refuses a request whose caller runs under
// it (callerVerdicts). A Main's front door is never under the daemon, which is
// a detached child of whichever front door started it, never a parent. Neither
// check stops a worker set on getting through, one that can start a process
// outside the daemon's tree; they stop its CLI doing it on its own.

// A real chain is five processes or so (front door, agent CLI, adapter, npm
// exec, daemon). The bound caps what one lookup can cost.
export const MAX_ANCESTRY_DEPTH = 32;
// sysexits EX_NOPERM: the front door's exit status when it refuses to start.
export const WORKER_TREE_EXIT_CODE = 77;
// The daemon's entry script, and the bin that runs it.
const DAEMON_ENTRIES = new Set(["gateway-daemon.js", "acp-gateway-daemon"]);
// A JS runtime as a command line's first word: node however installed
// (node, nodejs, node22, node.exe), or bun.
const JS_RUNTIME = /^(?:node(?:js)?\d*|bun)(?:\.exe)?$/i;
// /bin/ps, not the first ps on PATH: a directory early on PATH may be writable
// by the very worker the lookup is about.
const PS = existsSync("/bin/ps") ? "/bin/ps" : "ps";
const PROC_FS = process.platform === "linux" && existsSync("/proc/self/stat");

/**
 * Whether this platform tells a worker from a Main by process ancestry at all.
 * Windows has neither /proc nor ps, so there every chain reads as unreadable and
 * the marker is the only signal: ancestry is not consulted and an unreadable
 * chain is never failed closed. Everywhere else it is, so the rare broken host
 * (no /proc and ps missing or blocked) fails closed rather than let a worker that
 * cannot be placed pass for a Main. Injectable for tests.
 */
export function canReadAncestry(platform = process.platform) {
  return platform !== "win32";
}

/**
 * {ppid, command} of a running process, or null when it cannot be read: gone,
 * or no /proc and no ps (Windows). Linux reads /proc and starts no process;
 * elsewhere it is one ps per call, a few milliseconds.
 */
export async function readProcessInfo(pid) {
  if (process.platform === "win32") return null;
  return PROC_FS ? readProcFs(pid) : readPs(pid);
}

async function readProcFs(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The name in parentheses can itself hold spaces and parentheses, so the
    // fields are counted from the last ")": state, then the parent pid.
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[1]);
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    return Number.isInteger(ppid) ? { ppid, command: argv.join(" ") } : null;
  } catch {
    return null;
  }
}

function readPs(pid) {
  return new Promise((resolve) => {
    execFile(PS, ["-ww", "-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000, env: childEnv() }, (error, stdout) => {
      const match = error ? null : /^\s*(\d+)[ \t]*(.*)$/m.exec(stdout);
      resolve(match ? { ppid: Number(match[1]), command: match[2].trim() } : null);
    });
  });
}

/**
 * Whether a command line runs the Gateway daemon: a JS runtime, options at
 * most (with their values), then the daemon's entry or bin as the last word,
 * because the daemon takes no arguments. An editor open on the file, or an
 * agent CLI whose prompt ends with its name, is not one.
 */
export function runsGatewayDaemon(command) {
  const words = String(command ?? "").trim().split(/\s+/);
  if (!DAEMON_ENTRIES.has(basename(words.at(-1)))) return false;
  if (words.length > 1 && !JS_RUNTIME.test(basename(words[0]))) return false;
  const middle = words.slice(1, -1);
  return middle.every((word, index) => word.startsWith("-")
    || (index > 0 && middle[index - 1].startsWith("-") && !middle[index - 1].includes("=")));
}

/**
 * The first process, starting at pid and going up through its parents, that
 * is one of pids or whose command line matches, as {pid, command} (command
 * null when it was not read); null when none is within maxDepth or the chain
 * cannot be read. A pid match needs no read, unless verifyPids: then a listed
 * process whose command line can be read must match too, and one that does
 * not has taken the pid of one that is gone (a stale lock), so the walk goes
 * on past it; one whose command line cannot be read still matches. Never
 * throws: a lookup that fails is no evidence either way, and callers treat it
 * as none. pid 1 ends the walk, neither matched nor read: it is the top of
 * every chain, so being under it says nothing. A daemon that is pid 1 (a
 * container's entrypoint) cannot be told apart this way, only by the worker
 * marker.
 */
export async function findAncestor(pid, options = {}) {
  return (await traceAncestry(pid, options)).match;
}

/**
 * The same walk as findAncestor, as {match, unreadable}: unreadable when it was
 * cut short because a process could not be read, so the chain cannot be told to
 * hold the daemon or not. A walk that reaches pid 1, loops, or exhausts maxDepth
 * read everything it looked at and is not unreadable; a match is never
 * unreadable. The front door and the daemon fail closed on unreadable where the
 * host can read ancestry at all (canReadAncestry).
 */
async function traceAncestry(pid, {
  pids = [],
  commandMatches = () => false,
  verifyPids = false,
  readProcess = readProcessInfo,
  maxDepth = MAX_ANCESTRY_DEPTH
} = {}) {
  const seen = new Set();
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) return { match: null, unreadable: false };
    seen.add(pid);
    const listed = pids.includes(pid);
    if (listed && !verifyPids) return { match: { pid, command: null }, unreadable: false };
    let info = null;
    try {
      info = await readProcess(pid);
    } catch {}
    const command = typeof info?.command === "string" && info.command.trim() ? info.command : null;
    if (listed && (command === null || commandMatches(command))) return { match: { pid, command }, unreadable: false };
    if (!info) return { match: null, unreadable: true };
    if (command !== null && commandMatches(command)) return { match: { pid, command }, unreadable: false };
    pid = info.ppid;
  }
  return { match: null, unreadable: false };
}

/** The pid the daemon serving socketPath recorded in its lock file, or null. */
export function daemonLockPid(socketPath = gatewaySocketPath()) {
  try {
    const pid = Number(readFileSync(`${socketPath}.lock`, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Why this process must not serve the Control, or null. It runs inside a
 * worker when its env carries the marker the Gateway puts on workers and their
 * terminals (it arrives only through a CLI that passes its env on, and Codex
 * does not), or when an ancestor is the daemon: the pid in the lock of the
 * socket this front door would use, or a command line that runs
 * gateway-daemon.js (a daemon on another socket, or a CLI that changed TMPDIR
 * on the way). The lock outlives a daemon that dies without removing it, and
 * its pid may since belong to the Main's own CLI or another ancestor, which
 * would then refuse the Main; so the lock pid counts only when its command
 * line runs the daemon, or cannot be read. Run once, at startup.
 */
export async function workerTreeReason({
  env = process.env,
  ppid = process.ppid,
  socketPath = gatewaySocketPath(),
  readProcess = readProcessInfo,
  maxDepth = MAX_ANCESTRY_DEPTH,
  ancestrySupported = canReadAncestry()
} = {}) {
  if (env[GATEWAY_WORKER_ENV] === "1") return `${GATEWAY_WORKER_ENV}=1 is set`;
  const lockPid = daemonLockPid(socketPath);
  const { match: daemon, unreadable } = await traceAncestry(ppid, {
    pids: lockPid ? [lockPid] : [],
    verifyPids: true,
    commandMatches: runsGatewayDaemon,
    readProcess,
    maxDepth
  });
  if (daemon) {
    return daemon.pid === lockPid
      ? `ancestor process ${daemon.pid} holds the Gateway daemon lock ${socketPath}.lock`
      : `ancestor process ${daemon.pid} runs the Gateway daemon: ${daemon.command.slice(0, 200)}`;
  }
  // No daemon above it. If the chain could not be read, and this host can read
  // one at all, a worker could be hiding its daemon by denying the lookup: fail
  // closed. A Main's own front door can always read its parent chain, and the
  // marker already decided before any of this.
  if (unreadable && ancestrySupported) {
    return "its process ancestry cannot be read (no /proc and ps is unavailable or blocked), so a worker cannot be told from a Main";
  }
  return null;
}

/**
 * Whether pid is daemonPid or runs under it. False when that cannot be told,
 * as when the daemon is pid 1.
 */
export async function runsUnder(pid, daemonPid, { readProcess = readProcessInfo, maxDepth = MAX_ANCESTRY_DEPTH } = {}) {
  return (await findAncestor(pid, { pids: [daemonPid], readProcess, maxDepth })) !== null;
}

/**
 * One control connection's verdict on its caller. Called with each request's
 * caller pid, it returns null while the connection has named none, else
 * {pid, denied}: denied a promise of whether that pid is a worker's — it runs
 * under the daemon, or the host cannot read process ancestry at all and so cannot
 * place it, which fails closed the same way the front door does. The verdict is
 * computed for the first pid and reused while the pid stays the same, which it
 * does for a front door, so a connection pays for one lookup; a request that
 * names another pid gets a lookup, and a verdict, of its own. A request with no
 * pid gets the connection's latest verdict, so it waits behind a lookup in flight
 * instead of overtaking the requests before it.
 */
export function callerVerdicts({ daemonPid = process.pid, ancestrySupported = canReadAncestry(), ...options } = {}) {
  let verdict = null;
  return (pid) => {
    if (Number.isInteger(pid) && pid > 1 && pid !== verdict?.pid) {
      verdict = { pid, denied: callerDenied(pid, daemonPid, ancestrySupported, options) };
    }
    return verdict;
  };
}

// Whether a caller pid is a worker's. Under the daemon is the clear case. The
// walk not placing it there is not: unlike the front door, which walks from its
// own live parent, the daemon walks from a caller pid it does not control, and
// that pid may simply be gone — no worker. So a broken host is told from a gone
// pid by reading a process known to be alive, the daemon itself: a read that
// fails there means the host cannot place any caller and fails closed; one that
// succeeds means the caller really runs outside the daemon. Windows, which can
// read no ancestry (ancestrySupported false), stays marker-only.
async function callerDenied(pid, daemonPid, ancestrySupported, options) {
  if (await runsUnder(pid, daemonPid, options)) return true;
  if (!ancestrySupported) return false;
  const readProcess = options.readProcess ?? readProcessInfo;
  try {
    return (await readProcess(daemonPid)) === null;
  } catch {
    return true;
  }
}
