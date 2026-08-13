import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const ARTIFACT_PREFIX = "acp-artifact-";

export function defaultArtifactRoot() {
  return process.env.ACP_GATEWAY_ARTIFACTS || join(homedir(), ".acp-gateway", "artifacts");
}

export class ArtifactStore {
  constructor({
    root = defaultArtifactRoot(),
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES
  } = {}) {
    this.root = root;
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.usedBytes = directoryBytes(root);
  }

  create(sessionId, kind) {
    return new ArtifactWriter(this, sessionId, kind);
  }

  prune(retentionMs, now = Date.now(), keepPaths = null) {
    if (retentionMs < 0) return 0;
    let removed = 0;
    for (const entry of safeEntries(this.root)) {
      if (!entry.isFile() || !entry.name.startsWith(ARTIFACT_PREFIX)) continue;
      const path = join(this.root, entry.name);
      if (keepPaths?.has(path)) continue;
      try {
        const info = statSync(path);
        if (info.mtimeMs + retentionMs > now) continue;
        unlinkSync(path);
        this.usedBytes = Math.max(0, this.usedBytes - info.size);
        removed += 1;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return removed;
  }

  // Makes the directory entry itself durable. A file whose name a WAL record
  // points at is only reachable after its parent directory is on disk.
  syncDirectory() {
    let fd = null;
    try {
      fd = openSync(this.root, "r");
      fsyncSync(fd);
      return true;
    } catch {
      return false;
    } finally {
      if (fd != null) closeSync(fd);
    }
  }

  reserve(requested, fileBytes) {
    return Math.max(0, Math.min(
      requested,
      this.maxFileBytes - fileBytes,
      this.maxTotalBytes - this.usedBytes
    ));
  }
}

class ArtifactWriter {
  constructor(store, sessionId, kind) {
    this.store = store;
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
    let accepted = this.store.reserve(buffer.length, this.bytes);
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

function directoryBytes(path) {
  let bytes = 0;
  for (const entry of safeEntries(path)) {
    if (!entry.isFile()) continue;
    try {
      bytes += statSync(join(path, entry.name)).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return bytes;
}

function safeName(value) {
  return String(value ?? "artifact").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "artifact";
}
