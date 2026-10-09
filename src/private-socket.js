import { chmod, lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ERROR_CODES, GatewayError } from "./errors.js";

// The control socket is private to the user the daemon runs as, at both ends:
// the daemon never lets it exist with anyone else's permission bits, and a
// client writes nothing, the token above all, to a socket another user could
// have put at that path. That matters on Linux, where the default path is in
// the shared /tmp and anyone can create it before the daemon does.
//
// An lstat of the socket alone rejects a final symlink, not an intermediate
// one: a parent directory a stranger can replace with a link lets the two owner
// checks see this user's own socket while the connect in between reaches a
// foreign one, and the token goes to it. Node cannot read the connected peer's
// uid (LOCAL_PEERCRED/SO_PEERCRED) without a native addon, which the Gateway
// does not ship, so what stands in for authenticating the peer is proving the
// whole path is this user's own: a chain no other user can write is one no
// other user can redirect between the check and the connect.
//
// The proof is of one path only, the canonical one: the socket's name in its
// directory as the kernel resolves it, every link and ".." in it followed, so
// no link is left. It is sound only because everything after the check uses
// the canonical path the check returns: the client's connect and its second
// owner check, the daemon's lock, the probe and unlink of a stale socket, and
// the bind. A link or ".." left in the configured spelling would be resolved
// again by the kernel at each use, and whoever owns that link (a name of their
// own in a sticky /tmp will do) could point it somewhere else after the check.
//
// The canonical path is also the one that has to fit in a Unix socket address,
// and it can be longer than the configured one (on macOS a path in the
// temporary directory gains /private). Some systems take no path past
// sun_path less its NUL, and Node does not refuse a longer one there but cuts
// it short (Node 22 on macOS 14 and on Linux): the daemon would bind its
// socket at another path, and a client find nothing at this one. So a path
// over that is refused, at both ends, before anything is sent or bound.

/** The longest canonical socket path, in UTF-8 bytes: sun_path less the NUL that ends it, 104 bytes on macOS (and the BSDs), 108 on Linux. */
export const SOCKET_PATH_MAX_BYTES = process.platform === "linux" ? 107 : 103;

/**
 * Binds server to the Unix socket path and leaves it at 0600. The umask is
 * tightened around listen(), which binds synchronously, so the socket is born
 * 0600: never reachable by group or others, and never another mode between the
 * bind and the chmod, which only confirms it.
 */
export async function listenPrivately(server, path) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    const umask = process.umask(0o177);
    try {
      server.listen(path, resolve);
    } finally {
      process.umask(umask);
    }
  });
  await chmod(path, 0o600);
}

/**
 * Resolves when path is a socket owned by uid, or with allowMissing when there
 * is nothing at path (the caller's connect then fails as it always did).
 * Anything else throws SOCKET_UNTRUSTED, naming the path and its owner. Where
 * there is no uid to compare (Windows) nothing is checked. The lstat follows
 * any link above the last component, so this proves something only of a
 * canonical path, such as the one requireTrustedSocket returns.
 */
export async function requireOwnSocket(path, {
  allowMissing = true,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  lstat: lstatPath = lstat
} = {}) {
  if (uid == null) return;
  await requireOwnSocketAt(path, path, { allowMissing, uid, lstat: lstatPath });
}

/**
 * Resolves, to the socket's canonical path, when a connect to that path cannot
 * be redirected to another user's socket: the socket there is this user's own
 * (or there is none yet), and every directory from the filesystem root down to
 * the one holding it is this user's own or root's and writable by no one else,
 * unless it is sticky (a shared world-writable /tmp lets only an entry's own
 * owner replace it, so our own socket and directories are safe inside it). A
 * chain like that is immutable to any other user, so nothing in it can be
 * swapped for a link to a foreign socket between this check and the connect,
 * provided the connect goes to the path returned here and not to the one
 * passed in. Throws SOCKET_UNTRUSTED, naming path and the offending component,
 * otherwise. A socket directory that does not exist is not untrusted: nothing
 * can be listening there, so its ENOENT is rethrown as it is, before anything
 * is sent, and the caller takes it as it takes a missing socket (no daemon).
 * Without a uid (Windows) nothing is checked and path comes back as it is. The
 * owner check runs first, so a stranger's socket at the path is still reported
 * as the socket it is before the chain is walked. A canonical path too long
 * for a socket address throws SOCKET_PATH_TOO_LONG before either check.
 */
export async function requireTrustedSocket(path, {
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  lstat: lstatPath = lstat,
  realpath: realpathPath = realpath
} = {}) {
  if (uid == null) return path;
  const { directory, canonical } = await canonicalSocketPath(path, { uid, realpath: realpathPath, allowMissing: true });
  await requireOwnSocketAt(path, canonical, { allowMissing: true, uid, lstat: lstatPath });
  await requireTrustedChain(path, directory, { uid, lstat: lstatPath });
  return canonical;
}

/**
 * The directory half of the check alone, for the daemon, which calls it before
 * it touches anything at the path (its lock, the probe and unlink of a stale
 * socket, the bind): the whole chain above the path must be this user's own
 * (or root's) and writable by no one else, or it refuses to put the socket
 * where another user could swap a link for it. Resolves to the canonical path,
 * the only one to lock, probe, unlink and bind; without a uid (Windows), to
 * path as it is. A directory that does not exist is SOCKET_UNTRUSTED here, as
 * any other that cannot be resolved: the daemon halts on it and records why,
 * which is how an autostart into a missing directory reports it. A canonical
 * path too long for a socket address is SOCKET_PATH_TOO_LONG, and a halt too.
 */
export async function requireTrustedSocketDir(path, {
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  lstat: lstatPath = lstat,
  realpath: realpathPath = realpath
} = {}) {
  if (uid == null) return path;
  const { directory, canonical } = await canonicalSocketPath(path, { uid, realpath: realpathPath });
  await requireTrustedChain(path, directory, { uid, lstat: lstatPath });
  return canonical;
}

// The owner check of the socket at canonical, reported under path, the
// spelling the operator configured.
async function requireOwnSocketAt(path, canonical, { allowMissing, uid, lstat: lstatPath }) {
  let info;
  try {
    info = await lstatPath(canonical);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return;
    throw error;
  }
  if (info.isSocket() && info.uid === uid) return;
  const type = fileType(info);
  throw new GatewayError(
    ERROR_CODES.SOCKET_UNTRUSTED,
    `Refusing Gateway socket ${path}: it is ${FILE_TYPE_NAMES[type]} of uid ${info.uid}, not a socket of this user `
      + `(uid ${uid}), so nothing was sent to it. Remove it if it is stale; on a shared /tmp, set `
      + "ACP_GATEWAY_SOCKET to a path in a directory only you can write",
    { socketPath: path, type, ownerUid: info.uid, uid }
  );
}

// The socket's directory resolved by realpath, which follows links and ".." in
// the order the kernel meets them, and the socket's name inside it. Nothing
// lexical comes first: resolve() would drop a ".." together with the link in
// front of it, which the kernel follows before it, and so name a directory the
// connect never goes through. So the realpath is the system's (fs/promises):
// the JavaScript fs.realpath and fs.realpathSync resolve() the path first.
// With allowMissing a directory that is not there throws its ENOENT as it is.
// A canonical path too long for a socket address is SOCKET_PATH_TOO_LONG.
async function canonicalSocketPath(path, { uid, realpath: realpathPath, allowMissing = false }) {
  const parent = dirname(path);
  let directory;
  try {
    directory = await realpathPath(parent);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") throw error;
    throw untrustedChain(path, parent, "its directory cannot be resolved", { uid, reason: error.message });
  }
  const canonical = join(directory, basename(path));
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > SOCKET_PATH_MAX_BYTES) {
    throw new GatewayError(
      ERROR_CODES.SOCKET_PATH_TOO_LONG,
      `Refusing Gateway socket ${path}: its canonical path ${canonical} is ${bytes} bytes, over the `
        + `${SOCKET_PATH_MAX_BYTES}-byte limit of a Unix socket path here, past which Node can cut it short and use another `
        + "path, so nothing was sent to it or bound there. Set ACP_GATEWAY_SOCKET to a shorter path",
      { socketPath: path, canonicalPath: canonical, bytes, limitBytes: SOCKET_PATH_MAX_BYTES }
    );
  }
  return { directory, canonical };
}

// Walks the socket's real directory up to the filesystem root, refusing on the
// first component another user could rewrite. realpath removed the links, so
// each component is lstat'd (not followed): one swapped for a link in this very
// window is no longer a directory and is refused on that alone, over and above
// owning none of them.
async function requireTrustedChain(path, directory, { uid, lstat: lstatPath }) {
  for (const dir of chainToRoot(directory)) {
    let info;
    try {
      info = await lstatPath(dir);
    } catch (error) {
      throw untrustedChain(path, dir, "a directory in its path cannot be read", { uid, reason: error.message });
    }
    requireTrustedDir(path, dir, info, uid);
  }
}

function requireTrustedDir(path, dir, info, uid) {
  const refuse = (why, details) => {
    throw untrustedChain(path, dir, why, { uid, ...details });
  };
  if (!info.isDirectory()) refuse("a component of its path is not a directory", { type: fileType(info) });
  if (info.uid !== uid && info.uid !== 0) {
    refuse(`a directory in its path is owned by uid ${info.uid}, not this user (uid ${uid}) or root`, { ownerUid: info.uid });
  }
  const mode = info.mode & 0o7777;
  // Group- or other-writable and not sticky: a stranger can replace entries in
  // it. The sticky bit (/tmp) limits that to an entry's own owner, so it is safe.
  if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
    refuse(`a directory in its path is writable by group or others (mode ${mode.toString(8)}) and is not sticky`, { mode });
  }
}

function untrustedChain(path, dir, why, details) {
  return new GatewayError(
    ERROR_CODES.SOCKET_UNTRUSTED,
    `Refusing Gateway socket ${path}: ${why} (${dir}), so another user could swap it for a link to a foreign `
      + "socket and receive the Control token. Set ACP_GATEWAY_SOCKET to a path in a directory only you can write",
    { socketPath: path, dir, ...details }
  );
}

// The directory and every ancestor up to the filesystem root, inclusive.
function* chainToRoot(dir) {
  let current = dir;
  for (;;) {
    yield current;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

const FILE_TYPE_NAMES = {
  socket: "a socket",
  symlink: "a symbolic link",
  directory: "a directory",
  fifo: "a FIFO",
  file: "a regular file",
  other: "a special file"
};

function fileType(info) {
  if (info.isSocket()) return "socket";
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  if (info.isFIFO()) return "fifo";
  if (info.isFile()) return "file";
  return "other";
}
