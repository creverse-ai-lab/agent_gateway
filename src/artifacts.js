import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync,
  writeSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const ARTIFACT_PREFIX = "acp-artifact-";
const { O_NOFOLLOW = 0, O_NONBLOCK = 0, O_WRONLY } = constants;
// What a directory sync fails with where the file system cannot sync a
// directory at all (some network and FUSE mounts: EINVAL, ENOTSUP), or where a
// directory cannot be opened or synced to try (Windows: EISDIR, EPERM). A name
// there is as durable as that file system makes it, sync or no sync.
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EPERM"]);

export function defaultArtifactRoot() {
  return process.env.ACP_GATEWAY_ARTIFACTS || join(homedir(), ".acp-gateway", "artifacts");
}

// One file, whatever its name: device and inode of a bigint stat.
function inodeKey(info) {
  return `${info.dev}:${info.ino}`;
}

// Truncates the file at path, through a descriptor opened without following a
// link, when that is still the file info describes.
function emptyFile(path, info) {
  const fd = openSync(path, O_WRONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev === info.dev && opened.ino === info.ino) ftruncateSync(fd, 0);
  } finally {
    closeSync(fd);
  }
}

export class ArtifactStore {
  // The artifact files this store holds, by inodeKey, from the moment it
  // creates one or finds it at startup until it deletes it. An artifact sits a
  // level below the protected directory, deeper than the inode check of a
  // Worker's file request looks (worker-files.js), and keeps transcripts, tool
  // payloads, terminal output and task results of every session; link(2) needs
  // no permission on the file, so a Worker could give one a name inside its
  // roots. isArtifact is what lets that check refuse it there too.
  #inodes = new Set();

  constructor({
    root = defaultArtifactRoot(),
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    // The part of maxTotalBytes only durable writers may fill (create(...,
    // {durable: true})): a durable Task result whose artifact is cut short has
    // nothing but its preview to recover from, so transcripts, terminal output
    // and tool-event spills stop short of it. 0 shares the whole quota.
    durableReserveBytes = 0,
    // The names in a directory, as readdirSync gives them; injectable for tests.
    readdir = readdirSync
  } = {}) {
    this.root = root;
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.durableReserveBytes = Math.max(0, Math.min(durableReserveBytes, maxTotalBytes));
    this.usedBytes = this.#scan(readdir);
    this.activePaths = new Set();
  }

  create(sessionId, kind, { durable = false } = {}) {
    return new ArtifactWriter(this, sessionId, kind, durable);
  }

  /**
   * Whether info, the bigint stat of a file a Worker's request opened, is one
   * of this store's artifacts, under whatever name it was opened. A file the
   * store has deleted is no longer one: a name left on it holds nothing
   * (#delete).
   */
  isArtifact(info) {
    return this.#inodes.has(inodeKey(info));
  }

  // Registers an artifact file the store just created (its bigint fstat).
  remember(info) {
    this.#inodes.add(inodeKey(info));
  }

  // Deletes one finished artifact ahead of age retention, for a caller that
  // knows no reader can have been handed its path. Best effort: a file that
  // cannot be removed now is still reclaimed by prune.
  discard(path) {
    if (typeof path !== "string" || this.activePaths.has(path)) return false;
    if (resolve(dirname(path)) !== resolve(this.root) || !basename(path).startsWith(ARTIFACT_PREFIX)) return false;
    try {
      this.#delete(path);
      return true;
    } catch {
      return false;
    }
  }

  prune(retentionMs, now = Date.now(), keepPaths = null) {
    if (retentionMs < 0) return 0;
    let removed = 0;
    for (const entry of safeEntries(this.root)) {
      if (!entry.isFile() || !entry.name.startsWith(ARTIFACT_PREFIX)) continue;
      const path = join(this.root, entry.name);
      if (keepPaths?.has(path) || this.activePaths.has(path)) continue;
      try {
        if (statSync(path).mtimeMs + retentionMs > now) continue;
        this.#delete(path);
        removed += 1;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return removed;
  }

  // Unlinks an artifact, emptied first when it has another name: a hard link
  // made to it elsewhere keeps the inode, and would keep the bytes, outside this
  // directory and no longer registered. Emptied before the unlink, so a crash
  // between the two never leaves the link holding them. One with no other name
  // is only unlinked, as before, whole for a reader that has it open. It leaves
  // the registry once it is gone. Throws like the unlink did when the file
  // cannot be emptied or removed, and then stays registered.
  #delete(path) {
    const info = lstatSync(path, { bigint: true });
    if (info.isFile() && info.nlink > 1n) emptyFile(path, info);
    unlinkSync(path);
    this.usedBytes = Math.max(0, this.usedBytes - Number(info.size));
    this.#inodes.delete(inodeKey(info));
  }

  // What the directory already holds: every regular file counts against the
  // quota, and each artifact among them is registered like one the store
  // creates. Each name is lstat'd here, whatever type the listing could have
  // reported: a file system that reports none (DT_UNKNOWN, as some NFS and
  // virtiofs mounts do) has Node's typed listing lstat every entry itself, and
  // one entry gone by then fails that whole listing, which would read as no
  // directory and leave every artifact in it uncharged and unregistered. A
  // name gone by the lstat here is skipped alone.
  #scan(readdir) {
    let names;
    try {
      names = readdir(this.root);
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
    let bytes = 0;
    for (const name of names) {
      try {
        const info = lstatSync(join(this.root, name), { bigint: true });
        if (!info.isFile()) continue;
        bytes += Number(info.size);
        if (name.startsWith(ARTIFACT_PREFIX)) this.remember(info);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return bytes;
  }

  // Makes the directory entry itself durable. A file whose name a WAL record
  // points at is only reachable after its parent directory is on disk. Returns
  // null once it is, or where the file system cannot sync a directory at all
  // (DIRECTORY_SYNC_UNSUPPORTED), else the error: a sync that failed (EIO)
  // leaves the name to a power loss, and the caller must not count on it.
  syncDirectory() {
    let fd = null;
    try {
      fd = openSync(this.root, "r");
      fsyncSync(fd);
      return null;
    } catch (error) {
      return DIRECTORY_SYNC_UNSUPPORTED.has(error?.code) ? null : error;
    } finally {
      if (fd != null) closeSync(fd);
    }
  }

  reserve(requested, fileBytes, durable = false) {
    const ceiling = durable ? this.maxTotalBytes : this.maxTotalBytes - this.durableReserveBytes;
    return Math.max(0, Math.min(
      requested,
      this.maxFileBytes - fileBytes,
      ceiling - this.usedBytes
    ));
  }

  markActive(path) {
    this.activePaths.add(path);
  }

  markInactive(path) {
    if (path) this.activePaths.delete(path);
  }
}

class ArtifactWriter {
  constructor(store, sessionId, kind, durable = false) {
    this.store = store;
    this.durable = durable === true;
    this.sessionId = safeName(sessionId);
    this.kind = safeName(kind);
    this.path = null;
    this.fd = null;
    this.bytes = 0;
    this.truncated = false;
    this.complete = false;
    this.error = null;
  }

  get started() {
    return this.path != null;
  }

  get active() {
    return this.started || this.truncated || this.error != null;
  }

  append(value) {
    if (this.complete || this.error != null || value == null || value.length === 0) return;
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    let accepted = this.store.reserve(buffer.length, this.bytes, this.durable);
    if (accepted > 0 && accepted < buffer.length) {
      // Never end a truncated text artifact mid-character.
      while (accepted > 0 && (buffer[accepted] & 0xc0) === 0x80) accepted -= 1;
    }
    if (accepted <= 0) {
      this.truncated = true;
      return;
    }
    try {
      this.#open();
      let offset = 0;
      while (offset < accepted) {
        const written = writeSync(this.fd, buffer, offset, accepted - offset);
        if (written <= 0) throw new Error("Artifact write made no progress");
        offset += written;
        this.bytes += written;
        this.store.usedBytes += written;
      }
      if (accepted < buffer.length) this.truncated = true;
    } catch (error) {
      this.truncated = true;
      this.error = error?.message ?? String(error);
      this.#close();
    }
  }

  // sync is for the durable path only (a WAL record that names this file): the
  // fsync must happen before the close, and the caller must then inspect
  // metadata().error, because append() records I/O failures instead of throwing.
  finalize(tail = null, { sync = false } = {}) {
    if (this.complete) return;
    if (this.started && tail != null) this.append(tail);
    this.#close({ sync });
    this.complete = true;
  }

  metadata() {
    if (!this.active) return null;
    return {
      path: this.path,
      bytes: this.bytes,
      complete: this.complete,
      truncated: this.truncated,
      ...(this.error ? { error: this.error } : {})
    };
  }

  #open() {
    if (this.fd != null) return;
    mkdirSync(this.store.root, { recursive: true, mode: 0o700 });
    const path = join(this.store.root, `${ARTIFACT_PREFIX}${this.sessionId}-${this.kind}-${randomUUID()}.txt`);
    this.fd = openSync(path, "wx", 0o600);
    this.path = path;
    this.store.markActive(path);
    // Before a byte is written, so no content of it is ever unregistered.
    this.store.remember(fstatSync(this.fd, { bigint: true }));
  }

  #close({ sync = false } = {}) {
    if (this.fd == null) return;
    // A failed fsync must still close the descriptor: the error belongs on the
    // record, not in a leaked fd.
    if (sync) {
      try {
        fsyncSync(this.fd);
      } catch (error) {
        this.truncated = true;
        this.error ??= error?.message ?? String(error);
      }
    }
    try {
      closeSync(this.fd);
    } catch (error) {
      this.truncated = true;
      this.error ??= error?.message ?? String(error);
    }
    this.fd = null;
    this.store.markInactive(this.path);
  }
}

function safeEntries(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function safeName(value) {
  return String(value ?? "artifact").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "artifact";
}
