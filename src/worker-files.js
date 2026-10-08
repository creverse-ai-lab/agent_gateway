import { constants } from "node:fs";
import { open, readlink, realpath, stat } from "node:fs/promises";
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

export function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
  if (!roots.some((root) => isWithin(root, path))) throw new Error(`Path is outside ACP session roots: ${path}`);
  if (protectedPaths.some((item) => isWithin(item, path))) throw new Error(`Path is protected by the Gateway: ${path}`);
  return path;
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
}
