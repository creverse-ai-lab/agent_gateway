import { closeSync, constants, existsSync, fstatSync, openSync, statSync } from "node:fs";

// A Gateway terminal runs in the directory it was approved for: the canonical
// cwd Main is shown, and the directory that was there then (its device and
// inode). AcpClient checks both right before the start (#requireApprovedCwd),
// but a child changes into its cwd by path, after that check, so a Worker that
// renames the directory and puts a link at its path in between would still
// move the command. So the start itself is bound to the directory, not to its
// path:
// - On Linux with /proc the daemon opens the directory, requires the
//   descriptor to be the approved directory, and starts the child in
//   /proc/self/fd/<fd>: the child changes into its inherited copy of that
//   descriptor before it execs the command, which is that directory whatever
//   is at its path by then. The descriptor is closed once spawn returns.
// - Elsewhere (macOS, and Linux without /proc) a descriptor cannot be a cwd:
//   spawn into /dev/fd/<fd> fails with ENOTDIR on macOS. The child is a short
//   fixed sh script instead (SCRIPT): it changes into the path, compares the
//   directory it is then in, ".", held by inode and not by name, with the
//   approved device and inode, and only then execs the command, which keeps
//   the pid, the process group, the output and the exit status. On a mismatch
//   it runs nothing, writes one line to stderr and exits with
//   TERMINAL_CWD_CHANGED_EXIT_CODE. The cwd, its identity, the command and its
//   args are the script's positional parameters, never part of it. On macOS
//   it runs outside the terminal sandbox and execs sandbox-exec, so what is
//   sandboxed is the command, as before.
// - On Windows the check by path is all there is.

/** The exit status of a terminal whose cwd was not the approved directory when it started (EX_TEMPFAIL). */
export const TERMINAL_CWD_CHANGED_EXIT_CODE = 75;

// Linux's O_PATH, which fs.constants leaves out: a descriptor that only names
// the directory, so it opens without read permission on it, as a cwd needs
// only search permission.
const O_PATH = 0o10000000;

// dash where there is one (macOS, Debian, Ubuntu), since the script reads the
// terminal's environment, the Worker's to choose, and on macOS runs outside
// the sandbox: dash takes no code from it. /bin/sh is bash on macOS, which
// imports functions (BASH_FUNC_cd%%) and options (SHELLOPTS=xtrace, with a PS4
// that runs a command) from the environment. dash passes the environment on to
// the command as it is, except variables whose names are not shell names
// (BASH_FUNC_name%%, a name with a dot), which it drops, and PWD and OLDPWD,
// which it sets.
export const TERMINAL_CWD_SHELL = existsSync("/bin/dash") ? "/bin/dash" : "/bin/sh";

// The device and inode of ".", as Node's stat gives them: BSD stat on macOS,
// GNU or busybox stat on Linux, by absolute path so the terminal's PATH cannot
// pick another.
const STAT_IDENTITY = process.platform === "linux"
  ? `${existsSync("/usr/bin/stat") ? "/usr/bin/stat" : "/bin/stat"} -c %d:%i .`
  : "/usr/bin/stat -f %d:%i .";

// A command can be named like an option ("-c"). dash's exec takes no options
// and runs it as the command, and would take a "--" for the command too;
// another sh's exec needs the "--", or bash would take "-c" for its own option
// and run the next word, in an empty environment.
const EXEC = TERMINAL_CWD_SHELL === "/bin/dash" ? 'exec "$@"' : 'exec -- "$@"';

// $1 the approved cwd, $2 its "dev:ino", then the command and its args.
const SCRIPT = [
  `if cd -P -- "$1" 2>/dev/null && [ "$(${STAT_IDENTITY} 2>/dev/null)" = "$2" ]; then`,
  "  shift 2",
  `  ${EXEC}`,
  "fi",
  `printf '%s\\n' "Terminal cwd changed since it was approved: $1" >&2`,
  `exit ${TERMINAL_CWD_CHANGED_EXIT_CODE}`
].join("\n");

/** The error a terminal gets when the directory at its approved cwd is not the one approved. */
export function terminalCwdChanged(cwd) {
  return new Error(`Terminal cwd changed since it was approved: ${cwd}`);
}

/** The error a terminal gets when its approved cwd cannot be resolved or opened any more. */
export function terminalCwdGone(cwd) {
  return new Error(`Terminal cwd no longer resolves since it was approved: ${cwd}`);
}

/**
 * The script's start of launch ({command, args}) in cwd, as {command, args,
 * cwd} for spawn: it runs launch there only while the directory at cwd is the
 * one identity ({dev, ino}) names. Exported for tests; startInApprovedCwd
 * chooses it.
 */
export function cwdCheckingLaunch(launch, cwd, identity) {
  return {
    command: TERMINAL_CWD_SHELL,
    args: ["-c", SCRIPT, "sh", cwd, `${identity.dev}:${identity.ino}`, launch.command, ...launch.args],
    // Anywhere that is always there, so the spawn itself cannot fail on it.
    cwd: "/"
  };
}

/**
 * How to start launch ({command, args}) so that it runs in the directory
 * identity ({dev, ino}) names, at cwd: {command, args, cwd} for spawn, and
 * release(), to call once spawn has returned or thrown. On Linux with /proc
 * throws, naming only cwd, when the directory there is no longer that one or
 * cannot be opened; elsewhere the started script refuses it.
 */
export function startInApprovedCwd(launch, cwd, identity) {
  if (process.platform === "win32") return { ...launch, cwd, release() {} };
  const fd = process.platform === "linux" ? holdApprovedDirectory(cwd, identity) : null;
  if (fd !== null) return { ...launch, cwd: `/proc/self/fd/${fd}`, release: () => closeSync(fd) };
  return { ...cwdCheckingLaunch(launch, cwd, identity), release() {} };
}

// A descriptor of the directory at cwd, once it is the approved one, or null
// where /proc cannot lead a child to it: /proc/self/fd/<fd> must lead to the
// very directory held.
function holdApprovedDirectory(cwd, identity) {
  let fd;
  try {
    fd = openSync(cwd, O_PATH | constants.O_DIRECTORY);
  } catch {
    throw terminalCwdGone(cwd);
  }
  let held = false;
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== identity.dev || opened.ino !== identity.ino) throw terminalCwdChanged(cwd);
    let viaProc = null;
    try {
      viaProc = statSync(`/proc/self/fd/${fd}`, { bigint: true });
    } catch {
      // No /proc.
    }
    held = viaProc?.dev === opened.dev && viaProc.ino === opened.ino;
  } finally {
    if (!held) closeSync(fd);
  }
  return held ? fd : null;
}
