import { chmod, lstat } from "node:fs/promises";
import { ERROR_CODES, GatewayError } from "./errors.js";

// The control socket is private to the user the daemon runs as, at both ends:
// the daemon never lets it exist with anyone else's permission bits, and a
// client writes nothing, the token above all, to a socket another user could
// have put at that path. That matters on Linux, where the default path is in
// the shared /tmp and anyone can create it before the daemon does.

/**
 * Binds server to the Unix socket path and leaves it at 0600. The umask is
 * tightened around listen(), which binds synchronously, so the socket is never
 * reachable by group or others, not even until the chmod.
 */
export async function listenPrivately(server, path) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    const umask = process.umask(0o077);
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
 * there is no uid to compare (Windows) nothing is checked.
 */
export async function requireOwnSocket(path, {
  allowMissing = true,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  lstat: lstatPath = lstat
} = {}) {
  if (uid == null) return;
  let info;
  try {
    info = await lstatPath(path);
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
