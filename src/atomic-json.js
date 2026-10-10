import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  statSync, unlinkSync, writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { ERROR_CODES, GatewayError } from "./errors.js";

const { O_NOFOLLOW = 0, O_NONBLOCK = 0, O_WRONLY } = constants;

// What a directory sync fails with where the file system cannot sync a
// directory at all (some network and FUSE mounts: EINVAL, ENOTSUP), or where a
// directory cannot be opened or synced to try (Windows: EISDIR, EPERM). A name
// there is as durable as that file system makes it, sync or no sync. Any other
// failure (EIO) leaves a rename, a new file or an unlink in that directory in
// doubt (ArtifactStore#syncDirectory, StateStore#syncDirectory).
export const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EPERM"]);

export function readJsonFile(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw new GatewayError(ERROR_CODES.CONFIG_INVALID, `Cannot read ${path}: ${error.message}`);
  }
}

// A synchronous read/modify/rename transaction. Independent daemon/installer
// processes must fail visibly on contention instead of losing another writer.
// A crash leaves a lock requiring operator inspection; never steal a live lock.
export function updateJsonFile(path, fallback, update) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.write.lock`;
  let fd;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new GatewayError(ERROR_CODES.CONFIG_BUSY, `Configuration is locked: ${lock}`);
    throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(fd, `${process.pid}\n`);
    const next = update(readJsonFile(path, fallback));
    let output;
    try {
      output = openSync(temporary, "wx", 0o600);
      writeFileSync(output, `${JSON.stringify(next, null, 2)}\n`);
      fsyncSync(output);
    } finally { if (output != null) closeSync(output); }
    replaceFile(temporary, path, {
      afterRename: () => {
        let directory;
        try { directory = openSync(dirname(path), "r"); fsyncSync(directory); }
        finally { if (directory != null) closeSync(directory); }
      }
    });
    return next;
  } finally {
    closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    unlinkSync(lock);
  }
}

/**
 * Renames temporary over path, then empties the file path named until then if
 * another name still holds it. A rename replaces a name, not a file: under any
 * other name the old file keeps its bytes, and link(2) needs no permission on
 * the file itself, so a hard link a Worker made to install.json, or to the
 * settings or state kept beside it, would go on holding what that held, the
 * Control token included, outside the protected directory and its inode check
 * for good. So the old file is opened before the rename, never through a
 * symbolic link (the rename replaces the link, not what it points to), and
 * truncated through that descriptor only once the rename succeeded, path names
 * another file, and afterRename (the directory fsync that makes the rename
 * durable, where the caller makes one) has run. A failed rename leaves it as it
 * was. Past the rename this is best effort: a file this process cannot open for
 * writing, or a truncate that fails, is replaced without being emptied, and is
 * never an error.
 */
export function replaceFile(temporary, path, { afterRename = null } = {}) {
  const previous = openReplaced(path);
  try {
    renameSync(temporary, path);
    afterRename?.();
    if (previous !== null) emptyReplaced(previous, path);
  } finally {
    if (previous !== null) closeSync(previous);
  }
}

// The regular file at path, open for writing, or null: nothing there yet, a
// symbolic link, or a file this process may not write. O_NONBLOCK: a FIFO there
// would otherwise park the open until a reader appears. Never without
// O_NOFOLLOW (Windows): that open would follow a link at path to a file the
// rename does not replace, and empty it.
function openReplaced(path) {
  if (!O_NOFOLLOW) return null;
  let fd;
  try {
    fd = openSync(path, O_WRONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (fstatSync(fd).isFile()) return fd;
  } catch {
    // Not one this can empty.
  }
  closeSync(fd);
  return null;
}

// Truncates the held file when another name still holds it. One with no name
// left is out of everyone's reach, and is left whole for a reader that opened
// it before the rename, as an atomic replacement promises: install.json is read
// by front doors, apps and the admin CLI whenever they start. Never the file
// path still names: a rename from one name of a file to another of the same
// file succeeds and replaces nothing.
function emptyReplaced(fd, path) {
  try {
    const held = fstatSync(fd, { bigint: true });
    if (held.nlink === 0n) return;
    const current = statSync(path, { bigint: true, throwIfNoEntry: false });
    if (current?.dev === held.dev && current?.ino === held.ino) return;
    ftruncateSync(fd, 0);
  } catch {
    // The replacement stands; only the old file keeps its bytes.
  }
}

/**
 * Unlinks the file at path, emptied first when another name still holds it:
 * what replaceFile does for a file it replaces, for one that goes without a
 * replacement (a retired log segment, a forensic copy, a dead writer's
 * temporary). A hard link made to it would otherwise keep its bytes past the
 * unlink, outside the protected directory and its inode check. Emptied before
 * the unlink, so a crash in between never leaves the link holding them, and
 * through a descriptor opened without following a link and checked to be the
 * file the lstat found. One no other name holds is only unlinked, whole for a
 * reader that has it open. Returns false when nothing was there. Throws when
 * the file cannot be emptied or removed, and then leaves it where it is: under
 * its name in the protected directory, the inode check still refuses a link to
 * it.
 */
export function removeFile(path) {
  let info;
  try {
    info = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (info.isFile() && info.nlink > 1n) {
    const fd = openSync(path, O_WRONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (opened.dev === info.dev && opened.ino === info.ino) ftruncateSync(fd, 0);
    } finally {
      closeSync(fd);
    }
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  return true;
}
