import { constants, realpathSync } from "node:fs";
import { open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

// fs/read_text_file and fs/write_text_file act on a file a Worker names: inside
// its session roots, never under a Gateway-protected path. Checking the name and
// then opening it again by name leaves a window in which a Worker that can
// rename or symlink inside its roots swaps the file, or a directory above it,
// and the daemon, which can read install.json, reads or overwrites the target
// for it. So the file is opened once, the descriptor is what gets verified, and
// every read and write goes through that descriptor.

const { O_CREAT, O_DIRECTORY = 0, O_NOFOLLOW = 0, O_NONBLOCK = 0, O_RDONLY, O_WRONLY } = constants;
// macOS 11 and later refuse a symbolic link anywhere in the path, not only as
// its last component (sys/fcntl.h; Node does not export the constant). The path
// opened is canonical, so it holds a link only when one was swapped in after
// the check, and the open itself fails instead of following it. It includes
// O_NOFOLLOW and cannot be combined with it (EINVAL).
const O_NOFOLLOW_ANY = 0x20000000;
// Linux O_PATH, which Node does not export either: the same value on every
// Linux architecture Node supports (openDirectory).
const O_PATH = 0o10000000;

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
// not exist yet resolves through its parent. The system realpath, as for the
// roots and the protected paths it is compared with, and nothing lexical
// before it: resolve() would drop a ".." together with the link in front of
// it, which the kernel follows first, and the JavaScript realpath keeps the
// letter case it is given where a case-insensitive macOS volume has another.
async function checkedPath(requestedPath, { roots, protectedPaths, allowMissing = false }) {
  let path;
  try {
    path = await realpath(requestedPath);
  } catch (error) {
    if (!allowMissing || error?.code !== "ENOENT") throw error;
    path = join(await realpath(dirname(requestedPath)), basename(requestedPath));
  }
  return requireWorkerPath(path, { roots, protectedPaths });
}

/**
 * The file openWorkerFile would act on for requestedPath, resolved the same way
 * as checkedPath (no root or protected check), synchronously: what an approval
 * is bound to and what a pending write is shown as must be decided before the
 * request is registered, without an I/O turn in which a later request could
 * overtake it. The same system realpath, so an approval, the write it covers
 * and the root check compare one spelling of a file. Throws like checkedPath
 * when the path cannot be resolved.
 */
export function workerFilePathSync(requestedPath, { allowMissing = false } = {}) {
  try {
    return realpathSync.native(requestedPath);
  } catch (error) {
    if (!allowMissing || error?.code !== "ENOENT") throw error;
    return join(realpathSync.native(dirname(requestedPath)), basename(requestedPath));
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
 * A write never creates a file outside the checked directory on macOS (the open
 * refuses a link anywhere in the path) or on Linux with /proc (the file is
 * created through a verified descriptor of that directory). Elsewhere, on Linux
 * without /proc and on other systems, the open still follows a link swapped in
 * for a directory above the file, so a refused write can leave a new, empty file
 * where the link points (1.7.2 wrote the whole file there). Nothing is ever
 * unlinked to undo that: Node has no unlinkat, so an unlink goes by name, and
 * the same swap can redirect it onto a file that already existed.
 * isProtectedFile, when given, is asked about the opened file's bigint stat and
 * refuses it, like a protected inode, when it answers true: the Gateway's files
 * that sit deeper in a protected directory than verifyOpened looks, the
 * artifacts (AcpClient asks its ArtifactStore).
 * beforeOpen and afterOpen are test seams that run around the open, where a
 * racing Worker would swap the path, and beforeCreate one that runs on Linux
 * once a write holds the verified parent, right before the file is opened
 * through it; platform picks the OS-level check.
 */
export async function openWorkerFile(requestedPath, {
  roots,
  protectedPaths,
  isProtectedFile = null,
  write = false,
  platform = process.platform,
  beforeOpen = null,
  afterOpen = null,
  beforeCreate = null
}) {
  const path = await checkedPath(requestedPath, { roots, protectedPaths, allowMissing: write });
  await beforeOpen?.(path);
  const handle = await openNoFollow(path, write, platform, beforeCreate);
  try {
    await afterOpen?.(path);
    await verifyOpened(handle, requestedPath, path, { roots, protectedPaths, isProtectedFile, platform });
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function openNoFollow(path, write, platform, beforeCreate) {
  // O_NONBLOCK: opening a FIFO would otherwise park a libuv thread until a
  // writer appears, and four of those stall every file operation of the
  // daemon. It changes nothing for a regular file.
  const flags = (write ? O_WRONLY | O_CREAT : O_RDONLY)
    | (platform === "darwin" ? O_NOFOLLOW_ANY : O_NOFOLLOW)
    | O_NONBLOCK;
  try {
    const created = write && platform === "linux" ? await openInVerifiedParent(path, flags, beforeCreate) : null;
    return created ?? await open(path, flags, 0o666);
  } catch (error) {
    if (error?.code !== "ELOOP") throw error;
    throw new Error(`Path is or goes through a symbolic link the Gateway does not follow: ${path}`, { cause: error });
  }
}

// Linux refuses a link only as the last component, so an O_CREAT open by path
// through a parent swapped for a link would create the file wherever the link
// points, before verifyOpened could refuse it. A write therefore holds the
// checked parent first, requires the descriptor's own path in /proc to be that
// parent, and opens the file as /proc/self/fd/<dirfd>/<name>: the kernel
// resolves that straight to the held directory, whatever has since been swapped
// in at its path (openat, which Node lacks). A parent that is not the checked
// one is refused before anything is created. null when there is no /proc to
// name the descriptor: the caller then opens by path, as on other systems.
async function openInVerifiedParent(path, flags, beforeCreate) {
  const parent = dirname(path);
  const directory = await openDirectory(parent);
  try {
    const held = await descriptorPath(directory, path);
    if (held === null) return null;
    if (held !== parent) throw pathChanged(path);
    await beforeCreate?.(path);
    return await open(`/proc/self/fd/${directory.fd}/${basename(path)}`, flags, 0o666);
  } finally {
    await directory.close().catch(() => {});
  }
}

// The parent a write holds, as an O_PATH descriptor: one that names the
// directory without opening it, so it needs no permission on the directory
// itself, and readlink of /proc/self/fd/<fd> and an open through
// /proc/self/fd/<fd>/<name> both work on it. A parent the daemon may write into
// and search but not list (-wx) thus takes a new file, as it did when a write
// opened the file by path; the create still needs that write and search
// permission. A kernel that refuses the flag (EINVAL) gets the open for
// reading, which needs the directory to be listable too.
async function openDirectory(parent) {
  try {
    return await open(parent, O_PATH | O_DIRECTORY);
  } catch (error) {
    if (error?.code !== "EINVAL") throw error;
    return await open(parent, O_RDONLY | O_DIRECTORY | O_NONBLOCK);
  }
}

// The path Linux names for a descriptor (/proc/self/fd), wherever the walk to
// it went; null only when there is no /proc (ENOENT: the descriptor is ours and
// open, so nothing a Worker does can make its entry vanish). Any other failure
// refuses the open rather than skip the check, since a Worker can cause one:
// /proc names nothing longer than PATH_MAX, so a link to a directory nested
// deeper fails the readlink with ENAMETOOLONG, while a path the check approved
// always resolved and is never that long.
async function descriptorPath(handle, path) {
  try {
    return await readlink(`/proc/self/fd/${handle.fd}`);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw pathChanged(path);
  }
}

function pathChanged(path) {
  return new Error(`Path changed while the Gateway was opening it: ${path}`);
}

async function verifyOpened(handle, requested, path, { roots, protectedPaths, isProtectedFile, platform }) {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isFile()) throw new Error(`Path is not a regular file: ${path}`);
  const changed = () => pathChanged(path);
  // Linux names the file a descriptor holds, wherever the walk to it went: no
  // swap between two calls can fool this one. Skipped only without /proc; a
  // name /proc cannot give refuses (descriptorPath).
  if (platform === "linux") {
    const actual = await descriptorPath(handle, path);
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
  // the file is truncated, so neither reads out nor empties a protected file:
  // one directly inside a protected directory (descriptorIsProtected), or one
  // the caller knows deeper down (isProtectedFile, the artifacts), which the
  // one-level walk does not reach.
  if (isProtectedFile?.(opened) || await descriptorIsProtected(opened, protectedPaths)) {
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
 * new inode is never matched by a stale one. Fails closed: a protected path,
 * directory, or child the Gateway cannot stat or list could be the file the
 * descriptor holds under a mode or a fault that hides it, so it throws rather
 * than wave the open through. Only a path that is genuinely absent (ENOENT)
 * protects nothing and is skipped.
 */
async function descriptorIsProtected(opened, protectedPaths) {
  const sameFile = (info) => info?.isFile() && info.dev === opened.dev && info.ino === opened.ino;
  // stat, treating "not there" as nothing to protect and anything else — a denied
  // or faulting protected path — as a file that cannot be ruled out: fail closed.
  const statOrRefuse = async (path) => {
    try {
      return await stat(path, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error(`Cannot verify a path is not Gateway-protected: ${path}`, { cause: error });
    }
  };
  for (const base of protectedPaths) {
    const info = await statOrRefuse(base);
    if (sameFile(info)) return true;
    if (!info?.isDirectory()) continue;
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`Cannot list a Gateway-protected directory: ${base}`, { cause: error });
    }
    for (const entry of entries) {
      // A dirent of a known other kind is skipped without a stat; an unknown one
      // (some filesystems leave the type out) is settled by the stat.
      if (entry.isDirectory() || entry.isSymbolicLink() || entry.isSocket()
        || entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO()) continue;
      if (sameFile(await statOrRefuse(join(base, entry.name)))) return true;
    }
  }
  return false;
}
