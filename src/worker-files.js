import { constants, realpathSync } from "node:fs";
import { open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

// fs/read_text_file and fs/write_text_file act on a file a Worker names: inside
// its session roots, never under a Gateway-protected path. Checking the name and
// then opening it again by name leaves a window in which a Worker that can
// rename or symlink inside its roots swaps the file, or a directory above it,
// and the daemon, which can read install.json, reads or overwrites the target
// for it. So the file is opened once, the descriptor is what gets verified, and
// every read and write goes through that descriptor.

const { O_CREAT, O_NOFOLLOW = 0, O_NONBLOCK = 0, O_RDONLY, O_WRONLY } = constants;
// macOS 11 and later refuse a symbolic link anywhere in the path, not only as
// its last component (sys/fcntl.h; Node does not export the constant). The path
// opened is canonical, so it holds a link only when one was swapped in after
// the check, and the open itself fails instead of following it. It includes
// O_NOFOLLOW and cannot be combined with it (EINVAL).
const O_NOFOLLOW_ANY = 0x20000000;

/** Whether path is root or under it: lexical, so both must already be canonical. */
export function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** path (canonical) when it is inside one of roots and under none of protectedPaths; throws otherwise. */
export function requireWorkerPath(path, { roots, protectedPaths }) {
  if (!roots.some((root) => isWithin(root, path))) throw new Error(`Path is outside ACP session roots: ${path}`);
  if (protectedPaths.some((item) => isWithin(item, path))) throw new Error(`Path is protected by the Gateway: ${path}`);
  return path;
}

// The canonical path of requestedPath when it is inside one of roots and under
// none of protectedPaths; throws otherwise. With allowMissing a file that does
// not exist yet resolves through its parent.
async function checkedPath(requestedPath, { roots, protectedPaths, allowMissing = false }) {
  const requested = resolve(requestedPath);
  let path;
  try {
    path = await realpath(requested);
  } catch (error) {
    if (!allowMissing || error?.code !== "ENOENT") throw error;
    path = join(await realpath(dirname(requested)), basename(requested));
  }
  return requireWorkerPath(path, { roots, protectedPaths });
}

/**
 * The file openWorkerFile would act on for requestedPath, resolved the same way
 * as checkedPath (no root or protected check), synchronously: what an approval
 * is bound to and what a pending write is shown as must be decided before the
 * request is registered, without an I/O turn in which a later request could
 * overtake it. Throws like checkedPath when the path cannot be resolved.
 */
export function workerFilePathSync(requestedPath, { allowMissing = false } = {}) {
  const requested = resolve(requestedPath);
  try {
    return realpathSync(requested);
  } catch (error) {
    if (!allowMissing || error?.code !== "ENOENT") throw error;
    return join(realpathSync(dirname(requested)), basename(requested));
  }
}

/**
 * A FileHandle on the file requestedPath names, for reading or (write) for
 * writing, verified to be the file the path check approved; the caller closes
 * it. A write creates a missing file (0o666 before the umask, as writeFile
 * always did) but truncates nothing: emptying the file is the caller's step,
 * after this check. Refused: a symbolic link as the last component (one that
 * dangles would otherwise create its target wherever it points), anything but
 * a regular file, and a path that no longer leads to the opened file.
 * beforeOpen and afterOpen are test seams that run around the open, where a
 * racing Worker would swap the path; platform picks the OS-level check.
 */
export async function openWorkerFile(requestedPath, {
  roots,
  protectedPaths,
  write = false,
  platform = process.platform,
  beforeOpen = null,
  afterOpen = null
}) {
  const requested = resolve(requestedPath);
  const path = await checkedPath(requested, { roots, protectedPaths, allowMissing: write });
  await beforeOpen?.(path);
  const handle = await openNoFollow(path, write, platform);
  try {
    await afterOpen?.(path);
    await verifyOpened(handle, requested, path, { roots, protectedPaths, platform });
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function openNoFollow(path, write, platform) {
  // O_NONBLOCK: opening a FIFO would otherwise park a libuv thread until a
  // writer appears, and four of those stall every file operation of the
  // daemon. It changes nothing for a regular file.
  const flags = (write ? O_WRONLY | O_CREAT : O_RDONLY)
    | (platform === "darwin" ? O_NOFOLLOW_ANY : O_NOFOLLOW)
    | O_NONBLOCK;
  try {
    return await open(path, flags, 0o666);
  } catch (error) {
    if (error?.code !== "ELOOP") throw error;
    throw new Error(`Path is or goes through a symbolic link the Gateway does not follow: ${path}`, { cause: error });
  }
}

async function verifyOpened(handle, requested, path, { roots, protectedPaths, platform }) {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isFile()) throw new Error(`Path is not a regular file: ${path}`);
  const changed = () => new Error(`Path changed while the Gateway was opening it: ${path}`);
  // Linux names the file a descriptor holds, wherever the walk to it went: no
  // swap between two calls can fool this one. Without /proc it is skipped.
  if (platform === "linux") {
    const actual = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
    if (actual !== null && actual !== path) throw changed();
  }
  // Everywhere: resolved again, the path is still allowed, still the one that
  // was checked (in NFC: HFS+ stores a new name decomposed), and leads to the
  // file the descriptor holds. Alone this narrows the window rather than
  // closing it, since a swap can land between the realpath and the stat; the
  // open above already refused links on macOS, and /proc settled it on Linux.
  let again;
  try {
    again = await checkedPath(requested, { roots, protectedPaths });
  } catch {
    throw changed();
  }
  if (again.normalize("NFC") !== path.normalize("NFC")) throw changed();
  const current = await stat(again, { bigint: true }).catch(() => null);
  if (current?.dev !== opened.dev || current?.ino !== opened.ino) throw changed();
  // Every check so far is about the name, and a hard link is a second name for
  // one inode: link(2) needs no read permission on its target, so a Worker can
  // name a protected file inside its roots (ln ~/.acp-gateway/install.json
  // ./notes). The name is in-root and under no protected path, /proc and the
  // realpath above both show that in-root name, and the stat finds the
  // descriptor's inode through it, so nothing above tells the two names apart.
  // The inode does. Reads and writes both reach here before a byte is read or
  // the file is truncated, so neither reads out nor empties a protected file.
  if (await descriptorIsProtected(opened, protectedPaths)) {
    throw new Error(`Path is a hard link to a Gateway-protected file: ${path}`);
  }
}

/**
 * Whether the opened descriptor (its bigint stat) is one of the regular files a
 * Worker must never reach by inode, not only by name: the regular files directly
 * inside gatewayProtectedPaths() (the token in install.json, and the engine
 * settings and state kept beside it) and a protected path that is itself a file.
 * A directory cannot be hard-linked and the socket is not a regular file, so
 * comparing regular files is enough, and the walk stays one level deep: those
 * files sit directly in the directory, and recursing would stat the snapshot and
 * workspace trees on every read. Resolved per call, so a file recreated with a
 * new inode is never matched by a stale one.
 */
async function descriptorIsProtected(opened, protectedPaths) {
  const sameFile = (info) => info?.isFile() && info.dev === opened.dev && info.ino === opened.ino;
  for (const base of protectedPaths) {
    const info = await stat(base, { bigint: true }).catch(() => null);
    if (sameFile(info)) return true;
    if (!info?.isDirectory()) continue;
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // A dirent of a known other kind is skipped without a stat; an unknown one
      // (some filesystems leave the type out) is settled by the stat.
      if (entry.isDirectory() || entry.isSymbolicLink() || entry.isSocket()
        || entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO()) continue;
      if (sameFile(await stat(join(base, entry.name), { bigint: true }).catch(() => null))) return true;
    }
  }
  return false;
}
