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
  closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, ftruncateSync, linkSync, mkdirSync, openSync,
  readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { removeFile, replaceFile } from "./atomic-json.js";
import { ERROR_CODES, GatewayError } from "./errors.js";
import { GATEWAY_API_VERSION, GATEWAY_VERSION, STATE_SCHEMA_VERSION } from "./version.js";

// Record envelope version. A reader that meets a higher one stops rather than
// guess: an unknown envelope may put the payload somewhere else entirely.
export const WAL_RECORD_VERSION = 1;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// Copies #quarantine sets aside for an operator. Bounded both ways: the newest
// few per file and reason (a daemon autostarted into the same damaged log adds
// one per attempt), and none past an age, because every copy holds task results
// and inbox payloads that retention let go of long ago.
const QUARANTINE_KEEP = 3;
const QUARANTINE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const QUARANTINE_NAME = /^(corrupt|downgraded|gap|cold)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u;
// The halts ACP_GATEWAY_STATE_RECOVERY=cold starts past (#startCold): state
// that is there but cannot be read, or not all of it. Not a version mismatch,
// which a matching Gateway reads as it is.
const COLD_STARTS = new Set([ERROR_CODES.STATE_SNAPSHOT_CORRUPT, ERROR_CODES.STATE_WAL_CORRUPT]);
// A uuid-named temporary says nothing about its writer, so only its age can.
// Any write finishes in milliseconds; this is far past that.
const STALE_TEMPORARY_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// The state locks this process holds, by canonical path. A lock says which
// process holds it, so it cannot tell two stores of one process apart: a
// second store for the same directory would read its own pid and take the
// lock the first still holds.
const LOCKED_HERE = new Set();

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
  // Additive (1.7.0): the creating Main received the terminal result. T1 (no
  // fsync of its own): losing it only makes a delivered task show up as an
  // unread update again, never hides one.
  TASK_SEEN: "task.seen",
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
  if (snapshotVersion === runtimeVersion) {
    return { ok: true, snapshotVersion, runtimeVersion };
  }
  return {
    ok: false,
    snapshotVersion: Number.isFinite(snapshotVersion) ? snapshotVersion : null,
    runtimeVersion,
    error: Number.isFinite(snapshotVersion)
      ? `Gateway state at ${paths.snapshot} is schema v${snapshotVersion}, but this checkout reads v${runtimeVersion}. `
        + "Install a matching Gateway, or move the state directory aside to start fresh."
      : `Gateway state at ${paths.snapshot} has no valid schema version. Move it aside or recover it before updating.`
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
  #lockKey = null;
  // Set when a failed append left part of its record at the end of the log
  // and the log could not be cut back (append): no record may follow those
  // bytes, so none is written until rotate() has replaced the log.
  #walTorn = null;
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
  #lastSnapshotAt = -Infinity;
  // state.json was on disk at open(). It goes once a synced snapshot holds
  // everything it could still contribute.
  #legacyPending = false;
  #lastRecovery = null;
  // taskId -> { ref, result, fallback }: a terminal result that lives in an
  // artifact. result is the very object that was spilled (see #durableBody);
  // fallback is the degraded head recovery serves when the artifact is gone.
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

  // performance.now() of the last snapshot that landed, for the writer's
  // cadence. Monotonic on purpose: the injected clock is business time.
  get lastSnapshotAt() {
    return this.#lastSnapshotAt;
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
    // Under the lock, so no live writer of ours owns any of these. What a dead
    // one left behind is either a torn copy of state (a temporary) or an old
    // forensic copy, and both hold payloads retention has already let go of;
    // or a stale lock a dead starter had claimed (claimStateLock).
    sweepStaleTemporaries(this.paths.snapshot);
    sweepStaleTemporaries(this.paths.state);
    sweepStaleTemporaries(this.paths.lock);
    this.#pruneQuarantine();
    let state;
    try {
      state = this.#recover(recovery);
    } catch (error) {
      if (this.#config.stateRecovery !== "cold" || !COLD_STARTS.has(error?.code)) throw error;
      state = this.#startCold(recovery, error);
    }
    this.#restoreResultRefs(state);
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

  // The state on disk: the snapshot (or a v4 state.json) and the log replayed
  // onto it. Throws to halt.
  #recover(recovery) {
    let snapshot = this.#readSnapshot(recovery);
    const legacy = this.#readLegacyState();
    this.#legacyPending = legacy != null;
    // (c2) Downgrade loop closure. A v4 daemon's persist() writes fixed literals,
    // so it cannot preserve our marker: state.json without a writerVersion but
    // newer than the snapshot means an older gateway ran and the user has been
    // working in state we do not have. Its file wins; ours goes aside.
    if (snapshot && legacy && !legacy.marked && legacy.mtimeMs >= snapshot.mtimeMs) {
      this.#quarantine(this.paths.snapshot, "downgraded", recovery);
      this.#quarantine(this.paths.wal, "downgraded", recovery);
      removeFile(this.paths.snapshot);
      removeFile(this.paths.wal);
      removeFile(this.paths.rotating);
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
    const base = snapshot ? "snapshot" : legacy ? "v4" : null;
    this.#consume(this.paths.rotating, state, baseWalSeq, base, recovery, false);
    this.#consume(this.paths.wal, state, baseWalSeq, base, recovery, true);
    return state;
  }

  // ACP_GATEWAY_STATE_RECOVERY=cold, once the state on disk could not be
  // recovered as it is (error, one of COLD_STARTS): every file of it is set
  // aside and nothing of it is read, so nothing of it comes back, not even what
  // a log or a v4 file still holds of a snapshot dropped here. Each goes as the
  // copies a halt leaves do, a copy beside it under the same limits
  // (#pruneQuarantine) and the file itself through removeFile, and a file that
  // cannot be kept that way halts the start with it still in place.
  #startCold(recovery, error) {
    const stamp = new Date(this.#now()).toISOString().replace(/[:.]/g, "-");
    const aside = [];
    for (const path of [this.paths.snapshot, this.paths.rotating, this.paths.wal, this.paths.state]) {
      const target = `${path}.cold-${stamp}`;
      try {
        copyFileSync(path, target);
      } catch (copyError) {
        if (copyError?.code === "ENOENT") continue;
        throw copyError;
      }
      removeFile(path);
      aside.push(target);
    }
    this.#syncDirectory();
    this.#pruneQuarantine();
    // What the attempt read before it stopped goes with it.
    this.#seq = 0;
    this.#epoch = 0;
    this.#legacyPending = false;
    this.#resultRefs.clear();
    Object.assign(recovery, { source: "cold", replayed: 0, skipped: 0, droppedTail: 0, unknownTypes: 0 });
    if (aside.length) recovery.quarantined = aside.at(-1);
    recovery.alerts.push({
      code: "STATE_COLD_STARTED",
      message: `${error.reason ?? error.message}; started from an empty state (ACP_GATEWAY_STATE_RECOVERY=cold)`
        + (aside.length ? `, with the state files set aside as ${aside.join(", ")}` : "")
    });
    return { sessions: new Map(), tasks: new Map(), inbox: new Map() };
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
    // Since 1.8.0 nothing writes state.json any more, so snapshot-drop falls
    // back to the write-ahead log alone, plus a v4 file only if one is left.
    // cold halts here like no choice at all, and #openLocked starts past it.
    const fail = (reason) => {
      const quarantined = this.#quarantine(this.paths.snapshot, "corrupt", recovery);
      if (this.#config.stateRecovery === "snapshot-drop") {
        recovery.alerts.push({
          code: "STATE_SNAPSHOT_DROPPED",
          message: `${reason}; started from the write-ahead log (and a v4 state.json, if one was left)`
        });
        return null;
      }
      throw recoveryHalt(
        ERROR_CODES.STATE_SNAPSHOT_CORRUPT,
        `Gateway state snapshot is unusable (${reason})`,
        `A copy is at ${quarantined}. Start with ACP_GATEWAY_STATE_RECOVERY=snapshot-drop to start from the `
        + "write-ahead log alone (and a v4 state.json, if one was left), or =cold to start from an empty state."
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
    // Additive in 1.8.0 within schema v5: a task record may carry resultRef
    // (see #durableBody). An older v5 reader drops the key and keeps the
    // degraded head beside it, which is how it already treats a lost artifact.
    if (version !== STATE_SCHEMA_VERSION) {
      // Never guess at either direction: an older snapshot needs an explicit
      // migrator just as much as a newer one needs a newer reader.
      throw new GatewayError(
        ERROR_CODES.STATE_VERSION_UNSUPPORTED,
        `Gateway state snapshot is schema v${version} but this Gateway reads v${STATE_SCHEMA_VERSION}; upgrade the Gateway or move ${this.paths.snapshot} aside`
      );
    }
    if (!Number.isInteger(header?.walSeq) || header.walSeq < 0
      || !Number.isInteger(header?.epoch) || header.epoch < 0
      || !Number.isInteger(header?.bodyBytes) || header.bodyBytes < 0
      || typeof header?.bodySha256 !== "string" || !/^[0-9a-f]{64}$/u.test(header.bodySha256)) {
      return fail("header is missing required integrity fields");
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
    let document;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      throw recoveryHalt(
        ERROR_CODES.STATE_SNAPSHOT_CORRUPT,
        `Legacy Gateway state ${this.paths.state} is not valid JSON: ${error?.message}`
      );
    }
    return { document, mtimeMs, marked: typeof document?.writerVersion === "string" };
  }

  // Scans one log file, applies what is good, and leaves the file safe to append
  // to. `final` marks the file that is still being written: only there is a bad
  // last record the ordinary result of kill -9 rather than a hole in the log.
  // base is what the log goes on from: "snapshot" (through baseWalSeq), "v4"
  // (a state.json, which says no seq) or null.
  #consume(path, state, baseWalSeq, base, recovery, final) {
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
        if (final && isLast && !complete) {
          // Silently discarded and counted: the tail of an un-fsynced write.
          recovery.droppedTail += 1;
          break;
        }
        const quarantined = this.#quarantine(path, "corrupt", recovery);
        if (this.#config.stateRecovery !== "truncate") {
          throw recoveryHalt(
            ERROR_CODES.STATE_WAL_CORRUPT,
            `Gateway write-ahead log ${path} is damaged at byte ${offset} (last good seq ${this.#seq})`,
            `A copy is at ${quarantined}. Restart with ACP_GATEWAY_STATE_RECOVERY=truncate to replay up to `
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
      if (record.seq <= this.#seq) {
        recovery.skipped += 1;
        continue;
      }
      if (record.seq !== this.#seq + 1) this.#discontinuity(path, record.seq, base, recovery);
      this.#seq = record.seq;
      if (this.#apply(state, record)) recovery.replayed += 1;
      else recovery.unknownTypes += 1;
    }
    if (final && good < raw.length) this.#truncate(path, good);
  }

  // A record that does not follow the one before it, or the base. Only a v4
  // file, which says no seq, may be followed by any: a 1.7 Gateway wrote it
  // beside the log, so it held what the log went on from. Anywhere else the
  // records in between are missing. Without any base they are the ones before
  // the log's first, which only a snapshot held once rotation had retired the
  // segments they were in: the snapshot is gone, and the log alone would come
  // back as the whole state without them (since 1.8.0 no state.json covers
  // for it). That one halts too, unless snapshot-drop takes the log as it is.
  #discontinuity(path, seq, base, recovery) {
    if (this.#seq === 0 && base === "v4") return;
    if (this.#seq === 0 && base == null) {
      const before = seq === 2 ? "seq 1" : `seq 1 to ${seq - 1}`;
      if (this.#config.stateRecovery === "snapshot-drop") {
        recovery.alerts.push({
          code: "STATE_WAL_TAIL_REPLAYED",
          message: `The write-ahead log ${path} starts at seq ${seq} with no snapshot under it; replayed from there `
            + `(ACP_GATEWAY_STATE_RECOVERY=snapshot-drop), so what only the snapshot held (${before}) is gone`
        });
        return;
      }
      throw recoveryHalt(
        ERROR_CODES.STATE_SNAPSHOT_CORRUPT,
        `Gateway state snapshot ${this.paths.snapshot} is missing, and the write-ahead log ${path} goes on from it at seq ${seq}`,
        `What was recorded before (${before}) was only in that snapshot. Put it back, or start with `
        + "ACP_GATEWAY_STATE_RECOVERY=snapshot-drop to start from the write-ahead log alone, accepting that loss, "
        + "or =cold to start from an empty state."
      );
    }
    const quarantined = this.#quarantine(path, "gap", recovery);
    throw recoveryHalt(
      ERROR_CODES.STATE_WAL_CORRUPT,
      `Gateway write-ahead log ${path} has a sequence gap ${this.#seq} -> ${seq}`,
      `A copy is at ${quarantined}; refusing to replay incomplete durable state.`
    );
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
        // Additive (1.7.0): kept beside the result, so a result that comes back
        // only as a degraded preview still says how the task was cut short.
        if (payload?.interruption) task.interruption = payload.interruption;
        return true;
      }
      case WAL_TYPES.TASK_SEEN: {
        const task = state.tasks.get(key);
        // First delivery wins, and only a terminal record can have been delivered.
        if (task && !task.seenAt && TERMINAL_STATUSES.has(task.status) && typeof payload?.seenAt === "string") {
          task.seenAt = payload.seenAt;
        }
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
    const fallback = degradedResult(payload?.preview);
    const loaded = this.#loadResultRef(taskId, payload?.ref, fallback);
    return loaded === undefined ? fallback : loaded;
  }

  // The snapshot half of the same rule (#durableBody wrote it). After replay, so
  // a task the log removed is never read back from its artifact. The record
  // already holds the fallback, so a lost artifact leaves it as it is.
  #restoreResultRefs(state) {
    for (const task of state.tasks.values()) {
      if (!Object.hasOwn(task, "resultRef")) continue;
      const ref = task.resultRef;
      delete task.resultRef;
      const loaded = this.#loadResultRef(task.taskId, ref, task.result ?? null);
      if (loaded !== undefined) task.result = loaded;
    }
  }

  // The artifact behind a by-reference result, checked against its digest.
  // undefined when it cannot be used, so each caller keeps its own fallback.
  #loadResultRef(taskId, ref, fallback) {
    if (!ref?.path) return undefined;
    try {
      const raw = readFileSync(ref.path);
      if (createHash("sha256").update(raw).digest("hex") !== ref.sha256) return undefined;
      const result = JSON.parse(raw.toString("utf8"));
      this.#resultRefs.set(taskId, { ref, result, fallback });
      return result;
    } catch {
      return undefined;
    }
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
    // Pruned after the copy, so the one the error message names is the newest
    // and always kept.
    this.#pruneQuarantine();
    return target;
  }

  #pruneQuarantine() {
    const now = this.#now();
    const groups = new Map();
    const names = listDirectory(this.paths.directory);
    for (const path of [this.paths.snapshot, this.paths.wal, this.paths.rotating, this.paths.state]) {
      const prefix = `${basename(path)}.`;
      for (const name of names) {
        // Anchored, so "state.wal.ndjson." never claims the .rot file's copies.
        const match = name.startsWith(prefix) ? QUARANTINE_NAME.exec(name.slice(prefix.length)) : null;
        if (!match) continue;
        const [, reason, day, hours, minutes, seconds, millis] = match;
        const key = `${path}\0${reason}`;
        const group = groups.get(key) ?? [];
        group.push({ name, at: Date.parse(`${day}T${hours}:${minutes}:${seconds}.${millis}Z`) });
        groups.set(key, group);
      }
    }
    for (const group of groups.values()) {
      group.sort((left, right) => right.at - left.at);
      group.forEach((copy, index) => {
        if (index < QUARANTINE_KEEP && !(now - copy.at > QUARANTINE_MAX_AGE_MS)) return;
        try {
          removeFile(join(this.paths.directory, copy.name));
        } catch {
          // Already gone, or not removable by us: the next start tries again.
        }
      });
    }
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
  //
  // A failed write takes nothing: the seq goes to the next record that lands,
  // and the log is cut back to the length it had (#takeBack), so replay never
  // meets a gap or part of a record in the middle of the log.
  append(type, key, payload) {
    // Inert, not failed. Before open() nothing has promised durability yet, and
    // after close() the daemon has already accounted for its final state (§9.12);
    // in both cases a late append has nothing to write and nothing to report. A
    // served request cannot be here: the daemon exits if init() does not complete.
    if (!this.#opened || this.#closed) return true;
    this.#snapshotDirty = true;
    if (!this.#config.wal) return true;
    if (this.#walTorn) return this.#appendFailed(this.#walTorn);
    const seq = this.#seq + 1;
    const line = Buffer.from(encodeRecord({
      v: WAL_RECORD_VERSION,
      seq,
      at: new Date(this.#now()).toISOString(),
      type,
      key,
      payload
    }), "utf8");
    try {
      writeAll(this.#fd, line);
    } catch (error) {
      this.#takeBack(error);
      return this.#appendFailed(error);
    }
    this.#seq = seq;
    this.#walBytes += line.length;
    this.#walRecords += 1;
    this.#pendingFsync = true;
    this.#armGroupCommit();
    return true;
  }

  #appendFailed(error) {
    this.#failures += 1;
    this.#writeError = error;
    this.#onError(error);
    return false;
  }

  // A write can fail after part of its record reached the file (ENOSPC midway).
  // The next record would land right behind those bytes and turn them into a
  // damaged record in the middle of the log, which replay refuses
  // (STATE_WAL_CORRUPT) rather than drop as it drops a torn last line. So the
  // file goes back to the length it had before the write. Where it cannot, the
  // log takes no record until rotate() has replaced it, behind a synced
  // snapshot, with a new one.
  #takeBack(error) {
    if (this.#fd == null || this.#cutTornTail()) return;
    this.#walTorn = new Error(
      `Gateway write-ahead log ${this.paths.wal} could not be cut back after a failed write `
      + `(${error?.message ?? error}); it takes no more records until it is rotated`
    );
  }

  // Cuts the log back to the bytes of its whole records. Not synced: the next
  // barrier syncs the file as it is, and until then a crash leaves at most a
  // torn last line, which replay drops.
  #cutTornTail() {
    if (this.#fd == null) return false;
    try {
      ftruncateSync(this.#fd, this.#walBytes);
    } catch {
      return false;
    }
    this.#walTorn = null;
    return true;
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
      if (this.#snapshotDirty) this.writeSnapshot();
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

  // tmp -> fsync -> rename -> dir fsync, on every path, the debounced one
  // included. Each snapshot replaces the one before it as the base the log
  // replays onto, and once a rotation has retired the segments that base
  // covers, it is the only copy of them: an unsynced replacement could leave
  // power loss with a torn base and a log that only goes on from it. Two
  // fsyncs a write, at most about one write a second with the WAL on.
  writeSnapshot() {
    if (!this.#opened || this.#closed) return null;
    if (this.#config.wal) this.barrier();
    const body = Buffer.from(JSON.stringify(this.#durableBody(this.#snapshotProvider())), "utf8");
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
      this.#fsync(fd);
    } finally {
      closeSync(fd);
    }
    // The snapshot this replaces is emptied, when a hard link still holds it,
    // once the rename stands and is durable (replaceFile): the link would
    // otherwise keep that state, task results and inbox payloads included,
    // beyond the inode check of the state directory. Nothing keeps that file on
    // purpose; a quarantine copy is a copy.
    replaceFile(temporary, this.paths.snapshot, { afterRename: () => this.#syncDirectory() });
    this.#retireLegacyState();
    this.#snapshotDirty = false;
    this.#lastSnapshotAt = performance.now();
    return { bytes: body.length, walSeq: this.#seq, epoch: this.#epoch };
  }

  // A result the WAL holds by reference is held the same way here: its artifact
  // has the envelope, the snapshot the pointer plus the degraded head recovery
  // falls back to (also all a pre-1.8 reader, which ignores resultRef, gets).
  // Only while the record still holds the very object that was spilled: one
  // replaced since (a failed barrier's failure, a corrected verdict) is no
  // longer what the artifact says, and stays inline.
  #durableBody(body) {
    if (!this.#resultRefs.size || !Array.isArray(body?.tasks)) return body;
    return {
      ...body,
      tasks: body.tasks.map((task) => {
        const entry = this.#resultRefs.get(task?.taskId);
        if (!entry || task.result == null || entry.result !== task.result) return task;
        return { ...task, result: entry.fallback, resultRef: entry.ref };
      })
    };
  }

  // The v4 file stopped being written in 1.8.0. Once a synced snapshot holds
  // everything it could still contribute, it is a stale copy of old sessions
  // and inbox payloads that nothing would ever delete. The downgrade check in
  // open() still works without it: a v4 daemon that runs later writes a new one.
  #retireLegacyState() {
    if (!this.#legacyPending) return;
    try {
      removeFile(this.paths.state);
      this.#legacyPending = false;
      this.#syncDirectory();
    } catch {
      // Kept for the next snapshot; the file is only stale, not wrong.
    }
  }

  // Roll, never truncate in place: the old segment keeps its bytes under .rot
  // until a snapshot that covers them is on disk, so every crash point in here
  // leaves one complete story on disk plus at most a replayable duplicate.
  //
  // A retired segment goes through removeFile: emptied first when a hard link
  // still holds it, which would otherwise keep task results and inbox payloads
  // on an inode the state directory's inode check no longer finds.
  rotate() {
    if (!this.#opened || this.#closed) return null;
    if (!this.#config.wal) return this.writeSnapshot();
    this.barrier();
    if (this.#walTorn && !this.#cutTornTail()) return this.#replaceTornWal();
    // A segment left by an interrupted rotation still holds records that no
    // snapshot covers (open() replayed them into memory, nothing has written them
    // down). Fold it into a snapshot before the rename below can overwrite it.
    if (existsSync(this.paths.rotating)) {
      this.writeSnapshot();
      removeFile(this.paths.rotating);
    }
    if (this.#fd != null) closeSync(this.#fd);
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
    const written = this.writeSnapshot();
    removeFile(this.paths.rotating);
    this.#rotatedAt = this.#now();
    this.#failures = 0;
    return written;
  }

  // The rotation of a log that ends in part of a record (#walTorn). It is not
  // rolled aside: replay takes a damaged last record for a crash's torn write
  // only in the live log, and in .rot for corruption. A synced snapshot makes
  // every whole record in it redundant first, and only then does it go and a
  // new log start. A crash before that leaves the torn bytes where replay drops
  // them; one after, that snapshot and no log, or the new one.
  #replaceTornWal() {
    this.#epoch += 1;
    const written = this.writeSnapshot();
    if (this.#fd != null) closeSync(this.#fd);
    this.#fd = null;
    removeFile(this.paths.rotating);
    removeFile(this.paths.wal);
    this.#syncDirectory();
    this.#walTorn = null;
    this.#openWal();
    this.#walRecords = 0;
    this.#writeOpenedMarker();
    this.#rotatedAt = this.#now();
    this.#failures = 0;
    return written;
  }

  rotateIfNeeded() {
    if (!this.#opened || this.#closed || !this.#config.wal) return null;
    // A log that takes no records, torn or not open, is replaced at once.
    const due = this.#walTorn != null || this.#fd == null
      || this.#walBytes >= this.#config.walRotateBytes
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

  // result is the envelope the task record will hold (the snapshot writes it by
  // reference only while that is still so); preview is the head the WAL record
  // carries, the same fallback recovery would serve from either file.
  rememberResultRef(taskId, ref, { result = null, preview = null } = {}) {
    if (ref?.path) this.#resultRefs.set(taskId, { ref, result, fallback: degradedResult(preview) });
    else this.#resultRefs.delete(taskId);
  }

  resultRefPaths() {
    return [...this.#resultRefs.values()].map((entry) => entry.ref.path).filter(Boolean);
  }

  forgetTask(taskId) {
    this.#resultRefs.delete(taskId);
  }

  // Recovery can drop records replay brought back (a TTL that elapsed while the
  // daemon was down). Their references would otherwise pin artifacts for the
  // life of the process.
  retainResultRefs(taskIds) {
    for (const taskId of [...this.#resultRefs.keys()]) {
      if (!taskIds.has(taskId)) this.#resultRefs.delete(taskId);
    }
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
  // has to be exclusive: between processes (claimStateLock), and between two
  // stores of this one, which the pid in the lock cannot tell apart.
  #acquireLock() {
    mkdirSync(this.paths.directory, { recursive: true, mode: 0o700 });
    // Canonical, so two spellings of one directory are one lock.
    const key = join(realpathSync.native(this.paths.directory), basename(this.paths.lock));
    if (LOCKED_HERE.has(key)) {
      throw new GatewayError(
        ERROR_CODES.STATE_DIR_LOCKED,
        `This process already has the Gateway state directory ${this.paths.directory} open`
      );
    }
    this.#lockFd = claimStateLock(this.paths.lock);
    this.#lockKey = key;
    LOCKED_HERE.add(key);
  }

  #releaseLock() {
    if (this.#lockFd == null) return;
    try {
      closeSync(this.#lockFd);
    } catch {
      // Already closed.
    }
    this.#lockFd = null;
    LOCKED_HERE.delete(this.#lockKey);
    this.#lockKey = null;
    if (Number(String(readFileSafe(this.paths.lock) ?? "").trim()) === process.pid) unlinkSafe(this.paths.lock);
  }
}

/**
 * Takes the state lock at path for pid and returns its descriptor, or throws
 * STATE_DIR_LOCKED while a live process holds it. The lock is created with
 * O_EXCL and the pid written right after, so one that names no pid yet is
 * being made and counts as held. One whose process is gone, or that names pid
 * itself (StateStore asks only when no store of this process holds it, so a
 * dead process had the number), is claimed rather than unlinked: two starters
 * that judged the same stale lock would each unlink it by name, the second
 * removing the lock the first had just made, and both go on as its only
 * writer. A claim renames the lock to a name of its own, which only one
 * starter can take a file to, and drops it only when the file taken is the one
 * it judged stale; a lock made since goes back, by link(2), which never
 * replaces one made meanwhile either. Only then is a new lock created. isAlive
 * and beforeClaim, which runs between the judgement and the rename, are test
 * seams. held(path, owner) makes the error for a lock this cannot take: owner
 * is the pid it names, "" while it names none yet, null when claims kept
 * losing races; the installer's lock on install.json says its own.
 */
export function claimStateLock(path, { pid = process.pid, isAlive = processIsAlive, beforeClaim = null, held = lockedBy } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fd = createLock(path, pid);
    if (fd != null) return fd;
    const judged = readLock(path);
    if (judged == null) continue;
    if (!lockIsStale(judged.text, pid, isAlive)) throw held(path, judged.text.trim());
    beforeClaim?.();
    // A pid-named temporary, swept at a later start if this process dies
    // holding it.
    const claimed = `${path}.${pid}.tmp`;
    try {
      renameSync(path, claimed);
    } catch (error) {
      if (error?.code === "ENOENT") continue; // claimed by another starter first
      throw error;
    }
    if (sameLock(readLock(claimed), judged)) unlinkSafe(claimed);
    else restoreLock(claimed, path);
  }
  throw held(path, null);
}

// The lock, created and naming pid; null when one is there already.
function createLock(path, pid) {
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }
  try {
    writeAll(fd, Buffer.from(`${pid}\n`, "utf8"));
    return fd;
  } catch (error) {
    // It never named us (a full disk), and would read as a lock being made
    // for good: taken away while the path still holds it.
    try {
      const created = fstatSync(fd, { bigint: true });
      const current = statSync(path, { bigint: true, throwIfNoEntry: false });
      if (current?.dev === created.dev && current?.ino === created.ino) unlinkSync(path);
    } catch {
      // Left for an operator; the write's own error says why.
    }
    closeSync(fd);
    throw error;
  }
}

// The lock at path as one file: its device, inode, mtime and text, through one
// descriptor. null when it is gone.
function readLock(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const { dev, ino, mtimeNs } = fstatSync(fd, { bigint: true });
    return { dev, ino, mtimeNs, text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}

// Whether two reads of a lock are one lock. Not by inode alone: a file system
// may give the inode number of the stale lock, unlinked by another claim, to
// the lock made right after it (ext4, tmpfs), and only what that one holds,
// a live pid, tells them apart.
function sameLock(left, right) {
  return left != null && right != null && left.dev === right.dev && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs && left.text === right.text;
}

// Whether a lock names no live holder: a process that is gone, pid itself, or
// nothing a process could be. Empty is a lock its maker has not written yet.
function lockIsStale(text, pid, isAlive) {
  const value = text.trim();
  if (value === "") return false;
  const owner = Number(value);
  if (!Number.isSafeInteger(owner) || owner <= 0) return true;
  return owner === pid || !isAlive(owner);
}

function lockedBy(path, owner) {
  return new GatewayError(
    ERROR_CODES.STATE_DIR_LOCKED,
    owner
      ? `Another Gateway (pid=${owner}) is using the state directory ${dirname(path)}`
      : owner === ""
        ? `Another Gateway is taking the state directory ${dirname(path)}`
        : `Could not lock the Gateway state directory ${dirname(path)}`
  );
}

// Puts back a live lock a claim took instead of the stale one it judged. A
// file system without hard links gets the rename back. A lock made in the
// moment its path stood empty (a third starter) stays, and then two hold one:
// what lock files cannot rule out without an OS lock, which Node does not have.
function restoreLock(claimed, path) {
  try {
    linkSync(claimed, path);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      renameSync(claimed, path);
      return;
    }
  }
  unlinkSafe(claimed);
}

function emptyBody() {
  return { sessions: [], tasks: [], inbox: [] };
}

// A startup halt: what is wrong (reason), then what the operator can do about
// it (advice). A cold start past it says the reason alone (#startCold).
function recoveryHalt(code, reason, advice = null) {
  const error = new GatewayError(code, advice ? `${reason}. ${advice}` : reason);
  error.reason = reason;
  return error;
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

// What a by-reference result becomes when its artifact cannot be read.
function degradedResult(preview) {
  return preview == null ? null : { ...safeParsePreview(preview), resultDegraded: true };
}

// Half-finished atomic writes a crashed writer left beside `path`: the
// snapshot writer's `${path}.<pid>.tmp` (the v4 writer and the installer's
// install.json writer use the same form), and updateJsonFile's
// `${path}.<uuid>.tmp` (settings). Only a dead writer's file goes. A pid-named
// one once that process is gone; a uuid-named one only while no writer holds
// the file's lock, and only long after any write could still be running,
// because its name does not say who made it.
export function sweepStaleTemporaries(path, { minAgeMs = STALE_TEMPORARY_MS } = {}) {
  const directory = dirname(path);
  const prefix = `${basename(path)}.`;
  let removed = 0;
  for (const name of listDirectory(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const writer = name.slice(prefix.length, -".tmp".length);
    const file = join(directory, name);
    if (/^\d+$/u.test(writer)) {
      const pid = Number(writer);
      if (pid === process.pid || processIsAlive(pid)) continue;
    } else if (UUID.test(writer)) {
      if (existsSync(`${path}.write.lock`)) continue;
      try {
        if (Date.now() - statSync(file).mtimeMs < minAgeMs) continue;
      } catch {
        continue;
      }
    } else {
      continue;
    }
    try {
      // Emptied first when a hard link holds it: a temporary is a whole copy of
      // what it was written for, state or the Control token.
      if (removeFile(file)) removed += 1;
    } catch {
      // Not ours to remove.
    }
  }
  return removed;
}

function listDirectory(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
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

// Whether the process a lock or temporary file names still runs. One of
// another user counts (EPERM): it exists, it just cannot be signaled.
export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
