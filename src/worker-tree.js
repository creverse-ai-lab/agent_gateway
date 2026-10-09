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
 * cut short because a process could not be read, so the rest of the chain cannot
 * be told to hold the daemon or not. A walk that reaches pid 1, loops, or
 * exhausts maxDepth read everything it looked at and is not unreadable; a match
 * is never unreadable. The front door fails closed on unreadable only where the
 * host can read ancestry at all (canReadAncestry) and this process cannot read
 * even its own entry (workerTreeReason).
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

// workerTreeReason's reason when this process cannot read even its own entry:
// no worker was found, but none could be ruled out either.
export const WORKER_TREE_ANCESTRY_UNREADABLE = "its process ancestry cannot be read (no /proc, and ps is missing or blocked)";

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
 * line runs the daemon, or cannot be read. A walk cut short by a process it
 * cannot read is no daemon above, unless this process cannot read its own entry
 * either: then it cannot tell (WORKER_TREE_ANCESTRY_UNREADABLE). pid and ppid
 * are this process's and its parent's, injectable for tests. Run once, at
 * startup.
 */
export async function workerTreeReason({
  env = process.env,
  pid = process.pid,
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
  // No daemon above, as far as the walk could read. A walk cut short by a
  // process it could not read fails closed only where this process cannot read
  // its own entry either, the probe callerDenied makes of the daemon's: that
  // host (no /proc, and ps missing or blocked) can place nothing, and a worker
  // could hide its daemon by denying the lookup. Anywhere else the walk ends
  // there, no daemon above. With /proc mounted hidepid=1 or 2 a user cannot see
  // another user's processes, so a Main started over SSH stops at the
  // root-owned sshd above its login shell. Nothing is lost: the daemon runs as
  // this user, so the chain from a worker's CLI up to it is this user's own
  // processes, which hidepid never hides; and a worker can leave the daemon's
  // tree anyway (a double fork, at, systemd-run --user). This check is for a
  // worker CLI that starts the Control MCP as its own descendant (Codex does),
  // and the marker, checked first, is the other signal.
  if (unreadable && ancestrySupported && !(await canReadProcess(pid, readProcess))) {
    return WORKER_TREE_ANCESTRY_UNREADABLE;
  }
  return null;
}

/** The line the front door writes to stderr when it refuses to start for reason. */
export function workerTreeRefusalMessage(reason) {
  return reason === WORKER_TREE_ANCESTRY_UNREADABLE
    ? `acp-gateway-control: refusing to start: it cannot tell whether it runs inside a Gateway worker, because ${reason}. `
      + "Workers never get the Control, so it starts only once /proc or ps is available."
    : `acp-gateway-control: refusing to start inside a Gateway worker (${reason}). `
      + "Only a Main's agent CLI may run the Control MCP; workers never get it.";
}

// Whether pid, a process known to be alive (this one, or the daemon itself),
// can be read: a read that fails there is a host that can read no process at
// all, not a process that is gone or hidden.
async function canReadProcess(pid, readProcess) {
  try {
    return (await readProcess(pid)) !== null;
  } catch {
    return false;
  }
}

/**
 * Whether pid is daemonPid or runs under it. False when that cannot be told,
 * as when the daemon is pid 1.
 */
export async function runsUnder(pid, daemonPid, { readProcess = readProcessInfo, maxDepth = MAX_ANCESTRY_DEPTH } = {}) {
  return (await findAncestor(pid, { pids: [daemonPid], readProcess, maxDepth })) !== null;
}

// Why callerVerdicts refuses a caller: it is or runs under the daemon, or under
// a process the daemon spawned (a provider or one of its terminals), so it is a
// worker's; or this process cannot read ancestry on the host and so cannot place
// it, which is refused as unverifiable rather than mislabelled a worker. The
// spawned-process signal is the one that still holds when the daemon is pid 1 (a
// container entrypoint), where no ancestor can be matched to the daemon's own pid
// because pid 1 ends every chain (F5).
export const WORKER_CALLER_UNDER_DAEMON = "under_daemon";
export const WORKER_CALLER_UNDER_SPAWNED = "under_spawned";
export const WORKER_CALLER_ANCESTRY_UNVERIFIABLE = "ancestry_unverifiable";

/** The WORKER_CONTROL_DENIED message for a callerVerdicts refusal reason. */
export function workerControlDeniedMessage(reason, pid) {
  // Both worker signals — under the daemon, or under a process it spawned — read
  // the same to the caller: it is a worker's, and never gets the Control.
  return reason === WORKER_CALLER_ANCESTRY_UNVERIFIABLE
    ? `Control access denied: caller process ${pid} ancestry cannot be verified on this host`
    : `Control access denied: caller process ${pid} runs inside a Gateway worker`;
}

/**
 * One control connection's verdict on its caller. Called with each request's
 * caller pid, it returns null while the connection has named none, else
 * {pid, denied}: denied a promise of the reason that pid is refused — it runs
 * under the daemon (a worker's), or the host cannot read ancestry and so cannot
 * place it — or null when it is allowed. The verdict is computed for the first
 * pid and reused while the pid stays the same, which it does for a front door, so
 * a connection pays for one lookup; a request that names another pid gets a
 * lookup, and a verdict, of its own. A request with no pid gets the connection's
 * latest verdict, so it waits behind a lookup in flight instead of overtaking the
 * requests before it. spawnedPids is read afresh for each lookup (a function, or
 * a set/array of the live provider/terminal pids), so a pid removed when its
 * child exits no longer refuses a later process that reuses it; it is injectable
 * for tests.
 */
export function callerVerdicts({ daemonPid = process.pid, ancestrySupported = canReadAncestry(), spawnedPids = () => [], ...options } = {}) {
  let verdict = null;
  return (pid) => {
    if (Number.isInteger(pid) && pid > 1 && pid !== verdict?.pid) {
      verdict = { pid, denied: callerDenied(pid, daemonPid, ancestrySupported, spawnedPids, options) };
    }
    return verdict;
  };
}

// The reason a caller pid is refused, or null. One walk up the caller's ancestry
// matches both the daemon's own pid and the live pids of the processes it spawned
// (its providers and their terminals): a caller that is, or runs under, any of
// them is a worker's, whatever token it holds. The spawned-pid match is the
// signal that still catches a worker when the daemon is pid 1 — the daemon-pid
// walk stops at the top of the tree without matching it, because pid 1 ends every
// chain, but a provider or terminal is a real child the caller descends from,
// never pid 1. A pid gone from the set (its child exited) no longer matches, so a
// reused pid is not mistaken for it. The walk not placing the caller is not proof
// it is a Main: unlike the front door, which walks from its own live parent, the
// daemon walks from a caller pid it does not control, and that pid may simply be
// gone — no worker. So a broken host is told from a gone pid by reading a process
// known to be alive, the daemon itself: a read that fails there means the host
// cannot place any caller (unverifiable); one that succeeds means the caller
// really runs outside. Windows, which can read no ancestry (ancestrySupported
// false), stays marker-only.
async function callerDenied(pid, daemonPid, ancestrySupported, spawnedPids, options) {
  const spawned = (typeof spawnedPids === "function" ? spawnedPids() : spawnedPids) ?? [];
  const match = await findAncestor(pid, { ...options, pids: [daemonPid, ...spawned] });
  if (match) return match.pid === daemonPid ? WORKER_CALLER_UNDER_DAEMON : WORKER_CALLER_UNDER_SPAWNED;
  if (!ancestrySupported) return null;
  return (await canReadProcess(daemonPid, options.readProcess ?? readProcessInfo)) ? null : WORKER_CALLER_ANCESTRY_UNVERIFIABLE;
}
