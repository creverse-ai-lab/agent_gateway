// State v5: a checksummed snapshot plus a WAL of critical control transitions.
//
// Why two files. The snapshot is the whole state and costs O(state) bytes to
// write; the WAL record for one task create costs ~450 bytes. Only the WAL is
// cheap enough to fsync inside a request, so the WAL carries exactly the
// transitions whose loss would hand Main a handle to work the gateway forgot,
// and the snapshot carries everything else at debounce/rotation cadence.
//
// Honest threat model (see also the fsync note in ROTATION below): fsync(2) on
// macOS does not flush the drive's own write cache (Node has no F_FULLFSYNC
// binding). Process death is fully covered — the bytes are in the page cache
// before the syscall returns. Power loss is covered only as far as the platform
// takes fsync(2), which for the group-commit window is a 5ms exposure.
import { createHash } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync,
  readFileSync, renameSync, statSync, unlinkSync, writeSync
} from "node:fs";
import { dirname } from "node:path";
import { ERROR_CODES, GatewayError } from "./errors.js";
import { GATEWAY_API_VERSION, GATEWAY_VERSION, STATE_SCHEMA_VERSION } from "./version.js";

// Record envelope version. A reader that meets a higher one stops rather than
// guess: an unknown envelope may put the payload somewhere else entirely.
export const WAL_RECORD_VERSION = 1;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// The complete write-ahead vocabulary. session.owner_changed is deliberately
// absent: ownerRootId is assigned once at registration and never reassigned, so
// there is no emitter. Owner *activity* is snapshot-only (T2) because it fires
// on every call() and would be the highest-frequency append in the system.
export const WAL_TYPES = Object.freeze({
  WAL_OPENED: "wal.opened",
  SESSION_REGISTERED: "session.registered",
  SESSION_CLOSED: "session.closed",
  TASK_CREATED: "task.created",
  TASK_STATUS_CHANGED: "task.status_changed",
  TASK_RESULT_COMMITTED: "task.result_committed",
  TASK_REMOVED: "task.removed",
  INBOX_CREATED: "inbox.created",
  INBOX_RESOLVED: "inbox.resolved",
  INBOX_REMOVED: "inbox.removed"
});
const KNOWN_TYPES = new Set(Object.values(WAL_TYPES));

// The one production crash hook, for the kill-matrix. Frozen and validated at
// module load so a typo fails loudly instead of silently never firing.
export const CRASH_POINTS = Object.freeze(["task_create_durable"]);
const CRASH_AFTER = readCrashPoint();

function readCrashPoint() {
  const requested = process.env.ACP_GATEWAY_CRASH_AFTER;
  if (requested == null || requested === "") return null;
  if (!CRASH_POINTS.includes(requested)) {
    throw new Error(`ACP_GATEWAY_CRASH_AFTER must be one of: ${CRASH_POINTS.join(", ")}`);
  }
  return requested;
}

// abort(), not exit(): exit handlers would run the clean-shutdown path and write
// the very state the test is trying to prove was already durable.
export function crashAfter(point) {
  if (CRASH_AFTER === point) process.abort();
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, "0");
}

export function statePaths(statePath) {
  const stem = statePath.replace(/\.json$/i, "");
  return {
    state: statePath,
    stem,
    directory: dirname(statePath),
    snapshot: `${stem}.snapshot.json`,
    wal: `${stem}.wal.ndjson`,
    rotating: `${stem}.wal.ndjson.rot`,
    lock: `${stem}.lock`,
    marker: `${stem}.recovery-required`
  };
}

// Bootstrap pre-flight (design 5-c3). The one moment a human is watching: an
// installer that would downgrade the runtime below the on-disk snapshot has to
// say so here, because after the swap the daemon starts detached.
export function preflightStateVersion(statePath, runtimeVersion = STATE_SCHEMA_VERSION) {
  const paths = statePaths(statePath);
  let header = null;
  try {
    header = JSON.parse(readFileSync(paths.snapshot, "utf8").split("\n", 1)[0]);
  } catch {
    return { ok: true, snapshotVersion: null, runtimeVersion };
  }
  const snapshotVersion = Number(header?.version);
  if (!Number.isFinite(snapshotVersion) || snapshotVersion <= runtimeVersion) {
    return { ok: true, snapshotVersion: Number.isFinite(snapshotVersion) ? snapshotVersion : null, runtimeVersion };
  }
  return {
    ok: false,
    snapshotVersion,
    runtimeVersion,
    error: `Gateway state at ${paths.snapshot} is schema v${snapshotVersion}, but this checkout writes v${runtimeVersion}. `
      + "Install a newer Gateway, or move the state directory aside to start fresh."
  };
}

export class StateStore {
  #now;
  #config;
  #snapshotProvider;
  #onAlert;
  #onError;
  #fd = null;
  #lockFd = null;
  #seq = 0;
  #walBytes = 0;
  #walRecords = 0;
  #rotatedAt = 0;
  #epoch = 0;
  #fsyncCount = 0;
  #failures = 0;
  #pendingFsync = false;
  #writeError = null;
  #timer = null;
  #closed = false;
  #opened = false;
  #snapshotDirty = false;
  #lastRecovery = null;
  #resultRefs = new Map();

  constructor({
    statePath,
    now = () => Date.now(),
    config = {},
    snapshotProvider = () => emptyBody(),
    onAlert = () => {},
    onError = () => {}
  }) {
    if (!statePath) throw new Error("StateStore requires a statePath");
    this.paths = statePaths(statePath);
    this.#now = now;
    this.#config = {
      wal: config.wal !== false,
      walGroupCommitMs: config.walGroupCommitMs ?? 5,
      walRotateBytes: config.walRotateBytes ?? 4 * 1024 * 1024,
      walRotateRecords: config.walRotateRecords ?? 10_000,
      walRotateIntervalMs: config.walRotateIntervalMs ?? 15 * 60_000,
      walInlineResultBytes: config.walInlineResultBytes ?? 4096,
      fsync: config.fsync ?? "normal",
      stateRecovery: config.stateRecovery ?? null
    };
    this.#snapshotProvider = snapshotProvider;
    this.#onAlert = onAlert;
    this.#onError = onError;
  }

  get mode() {
    return this.#config.wal ? "wal" : "snapshot";
  }

  get inlineResultBytes() {
    return this.#config.walInlineResultBytes;
  }

  get walSeq() {
    return this.#seq;
  }

  // ---------------------------------------------------------------- recovery

  // Returns the recovered state in the same shape the v4 reader produced, so the
  // caller's restart transformations are unchanged. Throws to HALT rather than
  // ever returning a silently empty state for files that exist but do not parse.
  open() {
    this.#acquireLock();
    try {
      return this.#openLocked();
    } catch (error) {
      // A halt must not leave the directory locked behind it: the operator is
      // about to fix something in there, and the retry has to be able to start.
      this.#releaseLock();
      throw error;
    }
  }

  #openLocked() {
    const recovery = {
      at: new Date(this.#now()).toISOString(),
      source: "empty",
      replayed: 0,
      skipped: 0,
      droppedTail: 0,
      unknownTypes: 0,
      quarantined: null,
      alerts: []
    };
    let snapshot = this.#readSnapshot(recovery);
    const legacy = this.#readLegacyState();
    // (c2) Downgrade loop closure. A v4 daemon's persist() writes fixed literals,
    // so it cannot preserve our marker: state.json without a writerVersion but
    // newer than the snapshot means an older gateway ran and the user has been
    // working in state we do not have. Its file wins; ours goes aside.
    if (snapshot && legacy && !legacy.marked && legacy.mtimeMs > snapshot.mtimeMs) {
      this.#quarantine(this.paths.snapshot, "downgraded", recovery);
      this.#quarantine(this.paths.wal, "downgraded", recovery);
      unlinkSafe(this.paths.snapshot);
      unlinkSafe(this.paths.wal);
      unlinkSafe(this.paths.rotating);
      snapshot = null;
      recovery.source = "downgrade-remigrated";
      recovery.alerts.push({
        code: "DOWNGRADE_DETECTED",
        message: `An older Gateway wrote ${this.paths.state} after this snapshot; state was re-migrated from v4 and the v5 files were set aside`
      });
    }

    const state = { sessions: new Map(), tasks: new Map(), inbox: new Map() };
    let baseWalSeq = 0;
    if (snapshot) {
      ingest(state, snapshot.body);
      baseWalSeq = Number(snapshot.header.walSeq) || 0;
      this.#epoch = Number(snapshot.header.epoch) || 0;
      if (recovery.source === "empty") recovery.source = "snapshot";
    } else if (legacy) {
      ingest(state, legacy.document);
      if (recovery.source === "empty") recovery.source = "migrated-v4";
    }

    // Repair before append: a torn last line plus a later append would splice a
    // half record into the middle of the log, where truncation is no longer a
    // provably harmless kill -9 artifact.
    this.#seq = baseWalSeq;
    this.#consume(this.paths.rotating, state, baseWalSeq, recovery, false);
    this.#consume(this.paths.wal, state, baseWalSeq, recovery, true);
    this.#rotatedAt = this.#now();
    this.#openWal();
    this.#opened = true;
    this.#writeOpenedMarker();
    this.#lastRecovery = recovery;
    for (const alert of recovery.alerts) this.#onAlert(alert);
    return {
      sessions: [...state.sessions.values()],
      tasks: [...state.tasks.values()].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))),
      inbox: [...state.inbox.values()],
      recovery
    };
  }

  #readSnapshot(recovery) {
    let raw;
    try {
      raw = readFileSync(this.paths.snapshot);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const mtimeMs = statSync(this.paths.snapshot).mtimeMs;
    const split = raw.indexOf(0x0a);
    const fail = (reason) => {
      if (this.#config.stateRecovery === "cold" || this.#config.stateRecovery === "snapshot-drop") {
        this.#quarantine(this.paths.snapshot, "corrupt", recovery);
        recovery.alerts.push({ code: "STATE_SNAPSHOT_DROPPED", message: `${reason}; started from ${this.#config.stateRecovery === "cold" ? "empty state" : "state.json"}` });
        return null;
      }
      const quarantined = this.#quarantine(this.paths.snapshot, "corrupt", recovery);
      throw new GatewayError(
        ERROR_CODES.STATE_SNAPSHOT_CORRUPT,
        `Gateway state snapshot is unusable (${reason}). A copy is at ${quarantined}. `
        + "Start with ACP_GATEWAY_STATE_RECOVERY=snapshot-drop to fall back to the v4 state.json, "
        + "or =cold to start from an empty state."
      );
    };
    if (split < 0) return fail("no header line");
    let header;
    try {
      header = JSON.parse(raw.subarray(0, split).toString("utf8"));
    } catch (error) {
      return fail(`header is not JSON: ${error?.message}`);
    }
    const version = Number(header?.version);
    if (version > STATE_SCHEMA_VERSION) {
      // Never a recoverable condition: a newer writer may have persisted fields
      // whose meaning we would silently drop on the next write.
      throw new GatewayError(
        ERROR_CODES.STATE_VERSION_UNSUPPORTED,
        `Gateway state snapshot is schema v${version} but this Gateway reads v${STATE_SCHEMA_VERSION}; upgrade the Gateway or move ${this.paths.snapshot} aside`
      );
    }
    let body = raw.subarray(split + 1);
    if (body.at(-1) === 0x0a) body = body.subarray(0, body.length - 1);
    // Checksum the exact bytes. Re-serializing after parse cannot reproduce them
    // (V8 reorders integer-like keys), so a re-stringify checksum would be a
    // false-positive generator rather than an integrity check.
    if (Number(header?.bodyBytes) !== body.length) {
      return fail(`body is ${body.length} bytes, header claims ${header?.bodyBytes}`);
    }
    if (createHash("sha256").update(body).digest("hex") !== header?.bodySha256) {
      return fail("body checksum mismatch");
    }
    try {
      return { header, body: JSON.parse(body.toString("utf8")), mtimeMs };
    } catch (error) {
      return fail(`body is not JSON: ${error?.message}`);
    }
  }

  // The v4 file, read as both the migration source and the downgrade detector.
  #readLegacyState() {
    let raw;
    try {
      raw = readFileSync(this.paths.state, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const mtimeMs = statSync(this.paths.state).mtimeMs;
    const document = JSON.parse(raw); // a present-but-unparseable file still halts
    return { document, mtimeMs, marked: typeof document?.writerVersion === "string" };
  }

  // Scans one log file, applies what is good, and leaves the file safe to append
  // to. `final` marks the file that is still being written: only there is a bad
  // last record the ordinary result of kill -9 rather than a hole in the log.
  #consume(path, state, baseWalSeq, recovery, final) {
    let raw;
    try {
      raw = readFileSync(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    let offset = 0;
    let good = 0;
    while (offset < raw.length) {
      const end = raw.indexOf(0x0a, offset);
      const line = end < 0 ? raw.subarray(offset) : raw.subarray(offset, end);
      const complete = end >= 0;
      const record = complete ? decodeRecord(line) : null;
      const isLast = !complete || end + 1 >= raw.length;
      if (!record) {
        if (final && isLast) {
          // Silently discarded and counted: the tail of an un-fsynced write.
          recovery.droppedTail += 1;
          break;
        }
        const quarantined = this.#quarantine(path, "corrupt", recovery);
        if (this.#config.stateRecovery !== "truncate") {
          throw new GatewayError(
            ERROR_CODES.STATE_WAL_CORRUPT,
            `Gateway write-ahead log ${path} is damaged at byte ${offset} (last good seq ${this.#seq}). `
            + `A copy is at ${quarantined}. Restart with ACP_GATEWAY_STATE_RECOVERY=truncate to replay up to `
            + "the last intact record and continue, accepting the loss of everything after it."
          );
        }
        recovery.alerts.push({
          code: "STATE_WAL_TRUNCATED",
          message: `Replay stopped at byte ${offset} of ${path}; records after it were discarded (copy at ${quarantined})`
        });
        break;
      }
      if (record.v !== WAL_RECORD_VERSION) {
        throw new GatewayError(
          ERROR_CODES.STATE_VERSION_UNSUPPORTED,
          `Gateway write-ahead log ${path} holds v${record.v} records but this Gateway reads v${WAL_RECORD_VERSION}`
        );
      }
      good = end + 1;
      offset = end + 1;
      if (record.seq <= baseWalSeq) {
        // Already folded into the snapshot. This is the whole answer to the
        // rotation crash window: a .rot that was renamed but not yet unlinked
        // replays into a snapshot that already contains it, harmlessly.
        recovery.skipped += 1;
        this.#seq = Math.max(this.#seq, record.seq);
        continue;
      }
      if (this.#seq && record.seq > this.#seq + 1) {
        recovery.alerts.push({ code: "STATE_WAL_GAP", message: `seq gap ${this.#seq} -> ${record.seq} in ${path}` });
      }
      this.#seq = Math.max(this.#seq, record.seq);
      if (this.#apply(state, record)) recovery.replayed += 1;
      else recovery.unknownTypes += 1;
    }
    if (final && good < raw.length) this.#truncate(path, good);
  }

  #apply(state, record) {
    const { type, key, payload } = record;
    if (!KNOWN_TYPES.has(type)) return false; // additive vocabulary stays forward-readable
    switch (type) {
      case WAL_TYPES.WAL_OPENED:
        return true; // forensic marker only: it records which writer took the log
      case WAL_TYPES.SESSION_REGISTERED:
        if (payload?.id) state.sessions.set(payload.id, { ...payload });
        return true;
      case WAL_TYPES.SESSION_CLOSED:
        state.sessions.delete(key);
        return true;
      case WAL_TYPES.TASK_CREATED:
        // First create wins: a duplicate replay must not reset a record that
        // later records have already advanced.
        if (!state.tasks.has(key) && payload?.taskId) state.tasks.set(key, { ...payload });
        return true;
      case WAL_TYPES.TASK_STATUS_CHANGED: {
        const task = state.tasks.get(key);
        // Mirrors the store's first-terminal-writer rule. Without it a replayed
        // status change could walk a committed result back to working.
        if (task && !TERMINAL_STATUSES.has(task.status)) Object.assign(task, payload);
        return true;
      }
      case WAL_TYPES.TASK_RESULT_COMMITTED: {
        const task = state.tasks.get(key);
        if (!task) return true;
        if (TERMINAL_STATUSES.has(task.status) && task.result != null) return true;
        task.status = payload?.status ?? task.status;
        task.statusMessage = payload?.statusMessage ?? task.statusMessage;
        task.lastUpdatedAt = payload?.lastUpdatedAt ?? task.lastUpdatedAt;
        task.result = this.#materializeResult(key, payload);
        return true;
      }
      case WAL_TYPES.TASK_REMOVED:
        state.tasks.delete(key);
        this.#resultRefs.delete(key);
        return true;
      case WAL_TYPES.INBOX_CREATED:
        if (!state.inbox.has(key) && payload?.inboxId) state.inbox.set(key, { ...payload });
        return true;
      case WAL_TYPES.INBOX_RESOLVED: {
        const item = state.inbox.get(key);
        if (item && item.status === "pending") Object.assign(item, payload);
        return true;
      }
      case WAL_TYPES.INBOX_REMOVED:
        state.inbox.delete(key);
        return true;
      default:
        return false;
    }
  }

  // inline -> ref file -> preview. A missing or rewritten ref file degrades to
  // the 4KB head rather than losing the fact that the task completed.
  #materializeResult(taskId, payload) {
    if (payload?.result !== undefined) return payload.result;
    const ref = payload?.ref;
    if (ref?.path) {
      try {
        const raw = readFileSync(ref.path);
        if (createHash("sha256").update(raw).digest("hex") === ref.sha256) {
          this.#resultRefs.set(taskId, ref);
          return JSON.parse(raw.toString("utf8"));
        }
      } catch {
        // Fall through to the preview.
      }
    }
    if (payload?.preview == null) return null;
    return { ...safeParsePreview(payload.preview), resultDegraded: true };
  }

  #quarantine(path, reason, recovery) {
    const stamp = new Date(this.#now()).toISOString().replace(/[:.]/g, "-");
    const target = `${path}.${reason}-${stamp}`;
    try {
      copyFileSync(path, target);
    } catch {
      return path;
    }
    recovery.quarantined = target;
    return target;
  }

  #truncate(path, bytes) {
    const fd = openSync(path, "r+");
    try {
      ftruncateSync(fd, bytes);
      this.#fsync(fd);
    } finally {
      closeSync(fd);
    }
  }

  // ------------------------------------------------------------------- append

  // T1. The bytes reach the file immediately and only the fsync is grouped: a
  // record sitting in a userspace buffer dies with the process, while one that
  // reached the page cache survives everything short of power loss. It also keeps
  // seq the single ordering authority, because seq order is then file order.
  //
  // Never throws. A T1 caller is usually a session callback in the middle of
  // applying an ACP update, and failing the durable write must not also break the
  // session. Failures go out through onError (unhealthy) and come back as false.
  append(type, key, payload) {
    // Inert, not failed. Before open() nothing has promised durability yet, and
    // after close() the daemon has already accounted for its final state (§9.12);
    // in both cases a late append has nothing to write and nothing to report. A
    // served request cannot be here: the daemon exits if init() does not complete.
    if (!this.#opened || this.#closed) return true;
    this.#snapshotDirty = true;
    if (!this.#config.wal) return true;
    this.#seq += 1;
    const line = Buffer.from(encodeRecord({
      v: WAL_RECORD_VERSION,
      seq: this.#seq,
      at: new Date(this.#now()).toISOString(),
      type,
      key,
      payload
    }), "utf8");
    try {
      writeAll(this.#fd, line);
      this.#walBytes += line.length;
      this.#walRecords += 1;
      this.#pendingFsync = true;
      this.#armGroupCommit();
      return true;
    } catch (error) {
      this.#failures += 1;
      this.#writeError = error;
      this.#onError(error);
      return false;
    }
  }

  // T0: the caller is holding a response until these bytes survive a crash.
  appendDurable(type, key, payload) {
    if (!this.append(type, key, payload)) {
      throw this.#writeError ?? new Error(`Gateway could not write a ${type} record`);
    }
    this.barrier();
  }

  // The one primitive every durability promise in the gateway is expressed in, so
  // ACP_GATEWAY_WAL=off can honour the same promise with a synchronous snapshot
  // instead of a log record. This one throws: a T0 caller has to hear about it.
  barrier() {
    if (!this.#opened || this.#closed) return;
    if (this.#timer != null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#config.wal) {
      if (this.#snapshotDirty) this.writeSnapshot({ sync: true });
      return;
    }
    if (!this.#pendingFsync) return;
    try {
      this.#fsync(this.#fd);
      this.#pendingFsync = false;
      this.#writeError = null;
      this.#failures = 0;
    } catch (error) {
      this.#failures += 1;
      this.#onError(error);
      throw error;
    }
  }

  #armGroupCommit() {
    if (this.#timer != null || this.#config.walGroupCommitMs <= 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      try {
        this.barrier();
      } catch {
        // Already reported through onError. A group commit has no caller to throw
        // to, and the next barrier retries the fsync anyway.
      }
    }, this.#config.walGroupCommitMs);
    this.#timer.unref?.();
  }

  // --------------------------------------------------------------- snapshot

  // tmp -> (fsync) -> rename -> (dir fsync). Unsynced on the 50ms debounce path
  // for cost parity with the v4 writer; synced when it is the file that makes a
  // WAL rotation safe.
  writeSnapshot({ sync = false } = {}) {
    if (!this.#opened || this.#closed) return null;
    if (this.#config.wal) this.barrier();
    const body = Buffer.from(JSON.stringify(this.#snapshotProvider()), "utf8");
    const header = Buffer.from(`${JSON.stringify({
      version: STATE_SCHEMA_VERSION,
      gatewayApiVersion: GATEWAY_API_VERSION,
      writerVersion: GATEWAY_VERSION,
      writerPid: process.pid,
      createdAt: new Date(this.#now()).toISOString(),
      epoch: this.#epoch,
      walSeq: this.#seq,
      bodyBytes: body.length,
      bodySha256: createHash("sha256").update(body).digest("hex")
    })}\n`, "utf8");
    mkdirSync(this.paths.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.paths.snapshot}.${process.pid}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeAll(fd, Buffer.concat([header, body, Buffer.from("\n", "utf8")]));
      if (sync) this.#fsync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.paths.snapshot);
    if (sync) this.#syncDirectory();
    this.#snapshotDirty = false;
    return { bytes: body.length, walSeq: this.#seq, epoch: this.#epoch };
  }

  // Roll, never truncate in place: the old segment keeps its bytes under .rot
  // until a snapshot that covers them is on disk, so every crash point in here
  // leaves one complete story on disk plus at most a replayable duplicate.
  rotate() {
    if (!this.#opened || this.#closed) return null;
    if (!this.#config.wal) return this.writeSnapshot({ sync: true });
    this.barrier();
    // A segment left by an interrupted rotation still holds records that no
    // snapshot covers (open() replayed them into memory, nothing has written them
    // down). Fold it into a snapshot before the rename below can overwrite it.
    if (existsSync(this.paths.rotating)) {
      this.writeSnapshot({ sync: true });
      unlinkSafe(this.paths.rotating);
    }
    closeSync(this.#fd);
    this.#fd = null;
    try {
      renameSync(this.paths.wal, this.paths.rotating);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.#openWal();
        this.#failures += 1;
        throw error;
      }
    }
    this.#openWal();
    this.#walRecords = 0; // #openWal restat'd the byte count; the record count is ours
    this.#writeOpenedMarker();
    this.#syncDirectory();
    this.#epoch += 1;
    // The snapshot is what makes the rolled-aside segment redundant, so it is
    // written (and fsynced) before that segment is unlinked. A crash in between
    // replays the segment into a snapshot that already covers it.
    const written = this.writeSnapshot({ sync: true });
    unlinkSafe(this.paths.rotating);
    this.#rotatedAt = this.#now();
    this.#failures = 0;
    return written;
  }

  rotateIfNeeded() {
    if (!this.#opened || this.#closed || !this.#config.wal) return null;
    const due = this.#walBytes >= this.#config.walRotateBytes
      || this.#walRecords >= this.#config.walRotateRecords
      || (this.#config.walRotateIntervalMs > 0 && this.#rotatedAt + this.#config.walRotateIntervalMs <= this.#now());
    return due ? this.rotate() : null;
  }

  // ---------------------------------------------------------------- results

  // Decides inline vs ref for one result envelope. The caller writes the ref
  // file (it owns the artifact store) and must fsync it BEFORE the WAL record
  // that names it, or recovery can read a pointer to a file that never landed.
  planResult(json) {
    const bytes = Buffer.byteLength(json, "utf8");
    return { inline: bytes <= this.#config.walInlineResultBytes, bytes };
  }

  rememberResultRef(taskId, ref) {
    if (ref?.path) this.#resultRefs.set(taskId, ref);
    else this.#resultRefs.delete(taskId);
  }

  resultRefPaths() {
    return [...this.#resultRefs.values()].map((ref) => ref.path).filter(Boolean);
  }

  forgetTask(taskId) {
    this.#resultRefs.delete(taskId);
  }

  // ------------------------------------------------------------------ status

  status() {
    return {
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      mode: this.#closed ? "closed" : this.mode,
      walSeq: this.#seq,
      walBytes: this.#walBytes,
      snapshotEpoch: this.#epoch,
      fsyncCount: this.#fsyncCount,
      lastRecovery: this.#lastRecovery
        ? {
            at: this.#lastRecovery.at,
            source: this.#lastRecovery.source,
            replayed: this.#lastRecovery.replayed,
            skipped: this.#lastRecovery.skipped,
            droppedTail: this.#lastRecovery.droppedTail,
            quarantined: this.#lastRecovery.quarantined
          }
        : null
    };
  }

  get consecutiveFailures() {
    return this.#failures;
  }

  // Last writer standing. Everything after this is a silent no-op so a late
  // callback cannot append to a log the daemon has already accounted for.
  close() {
    if (this.#closed || !this.#opened) {
      this.#releaseLock();
      this.#closed = true;
      return;
    }
    try {
      this.rotate();
    } catch {
      // A failing final rotation must not stop the daemon from exiting; the WAL
      // it leaves behind is exactly what recovery is for.
    }
    this.#closed = true;
    if (this.#timer != null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#fd != null) {
      try {
        closeSync(this.#fd);
      } catch {
        // Already gone.
      }
      this.#fd = null;
    }
    this.#releaseLock();
  }

  // -------------------------------------------------------------- internals

  #openWal() {
    mkdirSync(this.paths.directory, { recursive: true, mode: 0o700 });
    if (!this.#config.wal) return;
    this.#fd = openSync(this.paths.wal, "a", 0o600);
    this.#walBytes = fstatSync(this.#fd).size;
  }

  // Forensics, not state: it records which process took the log, so a log two
  // writers shared is legible after the fact (the lock is what prevents it).
  #writeOpenedMarker() {
    this.append(WAL_TYPES.WAL_OPENED, String(process.pid), {
      pid: process.pid,
      writerVersion: GATEWAY_VERSION,
      epoch: this.#epoch
    });
  }

  #fsync(fd) {
    if (this.#config.fsync === "off") return;
    fsyncSync(fd);
    this.#fsyncCount += 1;
  }

  #syncDirectory() {
    if (this.#config.fsync === "off") return;
    let fd = null;
    try {
      fd = openSync(this.paths.directory, "r");
      fsyncSync(fd);
      this.#fsyncCount += 1;
    } catch {
      // Directory fsync is unavailable on some filesystems; the rename itself is
      // still atomic there.
    } finally {
      if (fd != null) closeSync(fd);
    }
  }

  // The daemon lock is keyed to the socket path, so two daemons on different
  // sockets could share one state directory and interleave O_APPEND writes into
  // one WAL. This lock is keyed to the state directory, which is what actually
  // has to be exclusive.
  #acquireLock() {
    mkdirSync(this.paths.directory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.#lockFd = openSync(this.paths.lock, "wx", 0o600);
        writeAll(this.#lockFd, Buffer.from(`${process.pid}\n`, "utf8"));
        return;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const owner = Number(String(readFileSafe(this.paths.lock) ?? "").trim());
        // Same pid means this process already holds the directory (two services
        // in one test process): single-threaded, so there is nothing to serialize.
        if (Number.isInteger(owner) && owner !== process.pid && processIsAlive(owner)) {
          throw new GatewayError(
            ERROR_CODES.STATE_DIR_LOCKED,
            `Another Gateway (pid=${owner}) is using the state directory ${this.paths.directory}`
          );
        }
        unlinkSafe(this.paths.lock);
      }
    }
    throw new GatewayError(ERROR_CODES.STATE_DIR_LOCKED, `Could not lock the Gateway state directory ${this.paths.directory}`);
  }

  #releaseLock() {
    if (this.#lockFd == null) return;
    try {
      closeSync(this.#lockFd);
    } catch {
      // Already closed.
    }
    this.#lockFd = null;
    if (Number(String(readFileSafe(this.paths.lock) ?? "").trim()) === process.pid) unlinkSafe(this.paths.lock);
  }
}

function emptyBody() {
  return { sessions: [], tasks: [], inbox: [] };
}

function ingest(state, document) {
  for (const record of document?.sessions ?? []) if (record?.id) state.sessions.set(record.id, record);
  for (const record of document?.tasks ?? []) if (record?.taskId) state.tasks.set(record.taskId, record);
  for (const record of document?.inbox ?? []) if (record?.inboxId) state.inbox.set(record.inboxId, record);
}

// crc32 covers the exact prefix bytes the writer produced. The reader recovers
// that prefix with lastIndexOf, so no re-serialization (and no normalization
// question) is involved on either side.
export function encodeRecord(record) {
  const body = JSON.stringify(record);
  const prefix = body.slice(0, -1);
  return `${prefix},"crc32":"${crc32(Buffer.from(prefix, "utf8"))}"}\n`;
}

export function decodeRecord(line) {
  if (line.length === 0) return null;
  const text = line.toString("utf8");
  const marker = text.lastIndexOf(',"crc32":"');
  if (marker < 0) return null;
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof record?.type !== "string" || !Number.isInteger(record?.seq)) return null;
  if (crc32(Buffer.from(text.slice(0, marker), "utf8")) !== record.crc32) return null;
  return record;
}

function safeParsePreview(preview) {
  try {
    const parsed = JSON.parse(preview);
    return parsed && typeof parsed === "object" ? parsed : { preview: String(preview) };
  } catch {
    return { preview: String(preview) };
  }
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error("State write made no progress");
    offset += written;
  }
}

function readFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function unlinkSafe(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
