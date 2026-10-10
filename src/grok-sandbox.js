import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readlinkSync, renameSync, unlinkSync, writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
import { ERROR_CODES, GatewayError } from "./errors.js";

// Grok's native tools (grep/rg, list_dir) read files in-process, never through
// ACP fs/read_text_file, so the Gateway's path checks never see them. Grok can
// sandbox its whole process at startup (Seatbelt on macOS, Landlock on Linux)
// from a profile in <process cwd>/.grok/sandbox.toml. One Grok process serves
// every session, so per-session roots cannot be expressed there, but the
// Gateway-protected paths can: they are the same for every session.
export const GROK_SANDBOX_PROFILE = "acp-gateway";

const { O_CREAT, O_EXCL, O_NOFOLLOW = 0, O_WRONLY } = constants;
// macOS refuses a symbolic link anywhere in the path, not only as the last
// component (worker-files.js); it includes O_NOFOLLOW and cannot be combined
// with it.
const O_NOFOLLOW_ANY = 0x20000000;
// More links than this in one path is a loop, as the kernel counts it.
const MAX_LINKS = 40;

export function defaultGrokSandboxDir() {
  return process.env.ACP_GATEWAY_GROK_SANDBOX_DIR || join(homedir(), ".cache", "acp-gateway", "grok-sandbox");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

// Writes the profile and returns the spawn overrides. Rewritten on every start
// so a changed protected-path set takes effect with the next process.
//
// The daemon writes it, and the daemon may write install.json, while a Worker
// runs as the same user and can make a link wherever that user can write: a
// sandbox.toml it turned into a link to install.json, symbolic or hard, or a
// .grok it swapped for a link to ~/.acp-gateway, had a write by path land in
// the Gateway's own files. So the directories are walked first (realDirectory)
// and the profile replaces sandbox.toml by rename (replaceProfile), which
// replaces whatever had that name, a link included, and writes nothing through
// it. Grok starts in the directory as walked, links resolved.
export function prepareGrokSandbox(protectedPaths, directory = defaultGrokSandboxDir()) {
  const cwd = realDirectory(directory);
  const profile = [
    "# Written by ACP Gateway. Denies Gateway-protected paths to the Grok process.",
    `[profiles.${GROK_SANDBOX_PROFILE}]`,
    'extends = "workspace"',
    `deny = [${protectedPaths.map(tomlString).join(", ")}]`,
    ""
  ].join("\n");
  replaceProfile(realDirectory(join(cwd, ".grok")), profile);
  return { cwd, env: { GROK_SANDBOX: GROK_SANDBOX_PROFILE } };
}

// The canonical path of the directory at path, created where it is missing
// (0700, a level at a time) and walked as the kernel resolves it, ".." after a
// link included, refusing what a Worker could have put in the way: every
// component must be a real directory, or a symbolic link only root could have
// made (root's, in a directory of root's no one else may write unless it is
// sticky, such as /var and /tmp on macOS) while this daemon is not root, which
// is followed. The directory itself must be this user's. Without a uid
// (Windows) no link is followed and no owner compared. Throws, naming the
// component, otherwise.
function realDirectory(path, uid = typeof process.getuid === "function" ? process.getuid() : null) {
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  let current = parse(absolute).root;
  let currentInfo = lstatSync(current);
  let rest = components(absolute.slice(current.length));
  let links = 0;
  while (rest.length) {
    const name = rest.shift();
    if (name === "..") {
      current = dirname(current);
      currentInfo = lstatSync(current);
      continue;
    }
    const next = join(current, name);
    let info = lstatSync(next, { throwIfNoEntry: false });
    if (!info) {
      try {
        mkdirSync(next, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      info = lstatSync(next);
    }
    if (info.isSymbolicLink()) {
      if (!rootsLink(info, currentInfo, uid)) throw refused(path, next, "is a symbolic link this user could have made");
      if (++links > MAX_LINKS) throw refused(path, next, "leads through too many symbolic links");
      const target = readlinkSync(next);
      if (isAbsolute(target)) {
        current = parse(target).root;
        currentInfo = lstatSync(current);
      }
      rest = [...components(isAbsolute(target) ? target.slice(current.length) : target), ...rest];
      continue;
    }
    if (!info.isDirectory()) throw refused(path, next, "is not a directory");
    current = next;
    currentInfo = info;
  }
  if (uid != null && currentInfo.uid !== uid) {
    throw refused(path, current, `is owned by uid ${currentInfo.uid}, not this user (uid ${uid})`);
  }
  return current;
}

// A link no process of this user could have put there or changed: root's, in
// a directory of root's that only root can change entries of. None, then, for
// a daemon that runs as root: a Worker of its runs as root as well.
function rootsLink(link, directory, uid) {
  if (uid == null || uid === 0 || link.uid !== 0 || directory.uid !== 0) return false;
  const mode = directory.mode & 0o7777;
  return (mode & 0o022) === 0 || (mode & 0o1000) !== 0;
}

function components(path) {
  return path.split(process.platform === "win32" ? /[\\/]/ : "/").filter((name) => name !== "" && name !== ".");
}

function refused(path, component, why) {
  return new GatewayError(
    ERROR_CODES.GATEWAY_ERROR,
    `Refusing the Grok sandbox directory ${path}: ${component} ${why}, so the profile is not written there`,
    { path, component }
  );
}

// The profile as a file of its own, created in the walked .grok and never
// through a link (O_EXCL and O_NOFOLLOW; on macOS no link anywhere in the
// path, which as walked has none), synced, then renamed over sandbox.toml:
// whatever had that name, a link to install.json included, is replaced and
// not written to, and Grok never reads half a profile. Not replaceFile
// (atomic-json.js), which empties the file that name held when another name
// still holds it: for a hard link a Worker made, that is install.json. On
// Linux a directory swapped for a link between the walk and the open can still
// take the new file, and so a sandbox.toml, wherever it leads; only under that
// name, and only with this profile.
function replaceProfile(directory, text) {
  const temporary = join(directory, `.sandbox.toml.${randomUUID()}.tmp`);
  const fd = openSync(
    temporary,
    O_WRONLY | O_CREAT | O_EXCL | (process.platform === "darwin" ? O_NOFOLLOW_ANY : O_NOFOLLOW),
    0o600
  );
  try {
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(directory, "sandbox.toml"));
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Not there any more; the error is what matters.
    }
    throw error;
  }
}
