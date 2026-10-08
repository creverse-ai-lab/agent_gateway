import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { childEnv } from "./caller.js";

// A terminal the Gateway opens for a Worker (ACP terminal/create) is started by
// the daemon, not by the Worker, so it runs outside every provider sandbox. The
// string checks on its command line cannot see `cd`, a variable or a script the
// Worker wrote, and the daemon's user can read install.json, where the Control
// token lives. On macOS each terminal therefore runs under sandbox-exec
// (Seatbelt) with a profile that allows everything except the Gateway-protected
// paths. sandbox-exec is deprecated but present and working on every supported
// macOS release; Codex runs its own commands under it.
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** An SBPL string literal: backslash and double quote escaped, every other character as is. */
export function sbplString(value) {
  return `"${String(value).replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}

// Seatbelt matches the real path of what is opened, so a path under a symlink
// (/var and /tmp on macOS) only matches in its /private form. One that does not
// exist yet is resolved through its deepest existing ancestor.
function realPath(path) {
  const rest = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

// A directory is denied with everything under it, a file or the socket by its
// own name. A path that is not there (yet) is a subpath, which covers both.
function pathFilter(path) {
  const real = realPath(path);
  let directory = true;
  try {
    directory = statSync(real).isDirectory();
  } catch {
    // Missing: subpath.
  }
  return `(${directory ? "subpath" : "literal"} ${sbplString(real)})`;
}

/** The SBPL profile that denies reads and writes of protectedPaths and allows everything else. */
export function terminalSandboxProfile(protectedPaths) {
  const filters = [...new Set(protectedPaths.map(pathFilter))].join(" ");
  const rules = ["(version 1)", "(allow default)"];
  if (filters) {
    rules.push(
      `(deny file-read* file-write* ${filters})`,
      // A connect() to a unix socket is a network operation to Seatbelt, not a
      // file read: without this the control socket stays reachable.
      `(deny network-outbound ${filters})`
    );
  }
  return rules.join("\n");
}

// Whether sandbox-exec can apply a profile here at all: it cannot inside
// another sandbox (a daemon started from a sandboxed shell), and then every
// terminal would fail. Asked once per executable, by running /usr/bin/true.
const probes = new Map();

function probe(executable) {
  let result = probes.get(executable);
  if (!result) {
    result = new Promise((done) => {
      execFile(
        executable,
        ["-p", "(version 1) (allow default)", "/usr/bin/true"],
        { timeout: 5_000, env: childEnv() },
        (error) => done(!error)
      );
    });
    probes.set(executable, result);
  }
  return result;
}

/**
 * The macOS terminal sandbox. wrap() gives the command and args that run
 * `command args` under sandbox-exec with protectedPaths denied: sandbox-exec
 * execs the command in its own place, so the child's pid, process group, exit
 * status and output are the command's. ready() resolves false when
 * sandbox-exec cannot apply a profile here.
 */
export function seatbeltSandbox(executable = SANDBOX_EXEC) {
  return {
    ready: () => probe(executable),
    wrap: (command, args, protectedPaths) => ({
      command: executable,
      args: ["-p", terminalSandboxProfile(protectedPaths), command, ...args]
    })
  };
}

/** The sandbox this OS gives Gateway terminals, or null where there is none (anything but macOS, or no sandbox-exec). */
export function detectTerminalSandbox({ platform = process.platform, executable = SANDBOX_EXEC } = {}) {
  if (platform !== "darwin") return null;
  try {
    accessSync(executable, constants.X_OK);
  } catch {
    return null;
  }
  return seatbeltSandbox(executable);
}
