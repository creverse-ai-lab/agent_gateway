import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

export const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_TASK_STATUSES = new Set(["working", "input_required"]);
const ALL_TASK_STATUSES = new Set([...ACTIVE_TASK_STATUSES, ...TERMINAL_TASK_STATUSES]);

// Terminal states are absent from this table on purpose: a terminal record is
// final, so `transition()` short-circuits before the table is consulted.
const TASK_TRANSITIONS = new Map([
  ["working", new Set(["working", "input_required", "completed", "failed", "cancelled"])],
  ["input_required", new Set(["input_required", "working", "completed", "failed", "cancelled"])]
]);

const RESTART_MESSAGE = "Gateway restarted before this task completed";
const TTL_ELAPSED_MESSAGE = "Task TTL elapsed before completion";
const CANCELLATION_REQUESTED_MESSAGE = "Cancellation requested";
const DEFAULT_STATUS_MESSAGE = "Prompt accepted";

function taskError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw taskError("INVALID_ARGUMENT", `${name} must be a non-empty string`);
  }
  return value;
}

function snapshot(record) {
  // Callers never receive the live record: the store owns every status/TTL
  // invariant, and a leaked reference would let a caller mutate them behind our
  // back. `result` is copied by reference (it is caller-owned payload).
  return { ...record };
}

// Ordering key for both list pages and cursors. `new Date(ms).toISOString()` is
// fixed-width UTC, so plain string comparison is chronological.
function compareRecords(left, right) {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.taskId !== right.taskId) return left.taskId < right.taskId ? -1 : 1;
  return 0;
}

function encodeCursor(record) {
  return Buffer.from(JSON.stringify({ c: record.createdAt, i: record.taskId }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  requireNonEmptyString(cursor, "cursor");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw taskError("INVALID_ARGUMENT", "cursor is not a valid tasks/list cursor");
  }
  if (typeof parsed?.c !== "string" || typeof parsed?.i !== "string") {
    throw taskError("INVALID_ARGUMENT", "cursor is not a valid tasks/list cursor");
  }
  return parsed;
}

// Keyset pagination: only records strictly after the (createdAt, taskId) tuple
// are returned. Deleting or expiring records never shifts the window, and new
// records always sort after the cursor (createdAt comes from a monotonic clock),
// so surviving items are never duplicated or skipped across pages.
function isAfterCursor(record, cursor) {
  if (!cursor) return true;
  if (record.createdAt !== cursor.c) return record.createdAt > cursor.c;
  return record.taskId > cursor.i;
}

function normalizeStatusFilter(status) {
  if (status == null) return null;
  const wanted = Array.isArray(status) ? status : [status];
  if (wanted.length === 0) return null;
  for (const value of wanted) {
    if (!ALL_TASK_STATUSES.has(value)) throw taskError("INVALID_ARGUMENT", `Unsupported task status: ${String(value)}`);
  }
  return new Set(wanted);
}

export class TaskStore {
  #now;
  #defaultTtlMs;
  #maxTaskTtlMs;
  #defaultPollIntervalMs;
  #minPollIntervalMs;
  #maxTasksPerRoot;
  #maxConcurrentTasksPerRoot;
  #maxWaitersPerTask;
  #maxWaitersPerRoot;
  #onChange;
  #tasks = new Map(); // taskId -> plain, JSON-serializable record
  #waiters = new Map(); // taskId -> Set<waiter> (never serialized)
  #sweeping = false;

  constructor(options = {}) {
    const {
      now = () => Date.now(),
      defaultTtlMs = 3_600_000,
      maxTaskTtlMs = 24 * 60 * 60_000,
      defaultPollIntervalMs = 1_000,
      minPollIntervalMs = 100,
      maxTasksPerRoot = 200,
      maxConcurrentTasksPerRoot = 16,
      maxWaitersPerTask = 16,
      maxWaitersPerRoot = 64,
      onChange = () => {}
    } = options ?? {};
    this.#now = now;
    this.#defaultTtlMs = defaultTtlMs;
    this.#maxTaskTtlMs = maxTaskTtlMs;
    this.#defaultPollIntervalMs = defaultPollIntervalMs;
    this.#minPollIntervalMs = minPollIntervalMs;
    this.#maxTasksPerRoot = maxTasksPerRoot;
    this.#maxConcurrentTasksPerRoot = maxConcurrentTasksPerRoot;
    this.#maxWaitersPerTask = maxWaitersPerTask;
    this.#maxWaitersPerRoot = maxWaitersPerRoot;
    this.#onChange = onChange;
  }

  get size() {
    // Reads sweep first so a zombie past its TTL is never counted.
    this.expireSweep();
    return this.#tasks.size;
  }

  create(options = {}) {
    const {
      sessionId,
      ownerRootId,
      turnId = null,
      ttl,
      pollInterval,
      statusMessage = DEFAULT_STATUS_MESSAGE
    } = options ?? {};
    requireNonEmptyString(sessionId, "sessionId");
    requireNonEmptyString(ownerRootId, "ownerRootId");
    if (turnId != null && typeof turnId !== "string") throw taskError("INVALID_ARGUMENT", "turnId must be a string or null");
    if (typeof statusMessage !== "string") throw taskError("INVALID_ARGUMENT", "statusMessage must be a string");
    const normalizedTtl = this.#normalizeTtl(ttl, true);
    const normalizedPollInterval = this.#normalizePollInterval(pollInterval, true);

    // Sweep before inserting (never after): expired records release budget slots,
    // and create() must still return the handle it just minted even when ttl=0
    // makes it expire on the very next read path.
    this.expireSweep();
    let live = 0;
    let active = 0;
    for (const record of this.#tasks.values()) {
      if (record.ownerRootId !== ownerRootId) continue;
      live += 1;
      if (ACTIVE_TASK_STATUSES.has(record.status)) active += 1;
    }
    if (live >= this.#maxTasksPerRoot) {
      throw taskError("TASK_LIMIT_EXCEEDED", `Root ${ownerRootId} holds ${live} tasks (max ${this.#maxTasksPerRoot})`);
    }
    if (active >= this.#maxConcurrentTasksPerRoot) {
      throw taskError(
        "TASK_LIMIT_EXCEEDED",
        `Root ${ownerRootId} has ${active} tasks in flight (max ${this.#maxConcurrentTasksPerRoot})`
      );
    }

    const iso = new Date(this.#now()).toISOString();
    const record = {
      taskId: `task-${randomUUID()}`,
      sessionId,
      ownerRootId,
      turnId,
      status: "working",
      ttl: normalizedTtl,
      pollInterval: normalizedPollInterval,
      createdAt: iso,
      lastUpdatedAt: iso,
      statusMessage,
      result: null
    };
    this.#tasks.set(record.taskId, record);
    this.#emit("created", record);
    return snapshot(record);
  }

  get(taskId, options = {}) {
    return snapshot(this.#requireRecord(taskId, options?.ownerRootId));
  }

  transition(taskId, status, statusMessage, options = {}) {
    if (!ALL_TASK_STATUSES.has(status)) throw taskError("INVALID_ARGUMENT", `Unsupported task status: ${String(status)}`);
    if (statusMessage != null && typeof statusMessage !== "string") {
      throw taskError("INVALID_ARGUMENT", "statusMessage must be a string");
    }
    const record = this.#requireRecord(taskId, options?.ownerRootId);

    // Terminal commits are final AND idempotent. Replaying the same terminal
    // transition — or racing a DIFFERENT terminal target, e.g. turn_end
    // "completed" arriving after cancel already recorded "cancelled" — is a
    // no-op: no status/statusMessage/result write, no lastUpdatedAt bump, no
    // second waiter fan-out. The first terminal writer wins, permanently.
    if (TERMINAL_TASK_STATUSES.has(record.status)) return snapshot(record);

    const allowed = TASK_TRANSITIONS.get(record.status);
    if (!allowed?.has(status)) {
      throw taskError("INVALID_ARGUMENT", `Cannot transition task ${record.taskId} from ${record.status} to ${status}`);
    }
    // Same-status transitions are legal and mean "refresh": statusMessage and
    // lastUpdatedAt move, TTL (createdAt-based) does not.
    record.status = status;
    if (statusMessage != null) record.statusMessage = statusMessage;
    if (options?.result !== undefined) record.result = options.result;
    record.lastUpdatedAt = new Date(this.#now()).toISOString();
    this.#emit("updated", record);
    if (TERMINAL_TASK_STATUSES.has(status)) this.#resolveWaiters(record);
    return snapshot(record);
  }

  async waitForTerminal(taskId, options = {}) {
    const { ownerRootId, timeoutMs = 120_000, signal } = options ?? {};
    const record = this.#requireRecord(taskId, ownerRootId);
    if (TERMINAL_TASK_STATUSES.has(record.status)) return snapshot(record);
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw taskError("INVALID_ARGUMENT", "timeoutMs must be a finite number greater than 0");
    }
    if (signal?.aborted) throw taskError("WAIT_ABORTED", `Wait for task ${record.taskId} was aborted`);

    const perTask = this.#waiters.get(record.taskId)?.size ?? 0;
    if (perTask >= this.#maxWaitersPerTask) {
      throw taskError("TASK_WAITER_LIMIT", `Task ${record.taskId} already has ${perTask} waiters (max ${this.#maxWaitersPerTask})`);
    }
    const perRoot = this.#rootWaiterCount(record.ownerRootId);
    if (perRoot >= this.#maxWaitersPerRoot) {
      throw taskError(
        "TASK_WAITER_LIMIT",
        `Root ${record.ownerRootId} already has ${perRoot} waiters (max ${this.#maxWaitersPerRoot})`
      );
    }

    const taskIdKey = record.taskId;
    return await new Promise((resolve, reject) => {
      const waiter = { taskId: taskIdKey, resolve, reject, timer: null, signal, onAbort: null };
      let set = this.#waiters.get(taskIdKey);
      if (!set) {
        set = new Set();
        this.#waiters.set(taskIdKey, set);
      }
      set.add(waiter);
      // Event-driven only: the timer bounds the wait, nothing polls the record.
      waiter.timer = setTimeout(() => {
        this.#settleWaiter(waiter);
        reject(taskError("WAIT_TIMEOUT", `Timed out after ${timeoutMs}ms waiting for task ${taskIdKey} to finish`));
      }, timeoutMs);
      if (signal) {
        waiter.onAbort = () => {
          this.#settleWaiter(waiter);
          reject(taskError("WAIT_ABORTED", `Wait for task ${taskIdKey} was aborted`));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  result(taskId, options = {}) {
    const record = this.#requireRecord(taskId, options?.ownerRootId);
    if (!TERMINAL_TASK_STATUSES.has(record.status)) {
      throw taskError(
        "TASK_NOT_COMPLETE",
        `Task ${record.taskId} is not complete; use tasks/get and retry after its pollInterval`
      );
    }
    // Returned as stored (possibly null). The legacy "Task completed without a
    // result" fallback stays in the caller so the store never invents payloads.
    return record.result;
  }

  listPage(options = {}) {
    const { ownerRootId, cursor = null, limit = 50, status } = options ?? {};
    // Root scoping is mandatory: there is no "list everything" mode.
    requireNonEmptyString(ownerRootId, "ownerRootId");
    if (limit != null && (typeof limit !== "number" || Number.isNaN(limit))) {
      throw taskError("INVALID_ARGUMENT", "limit must be a number");
    }
    const effectiveLimit = limit == null ? 50 : Math.min(Math.max(1, Math.floor(limit)), 200);
    const wanted = normalizeStatusFilter(status);
    const decoded = cursor == null ? null : decodeCursor(cursor);
    this.expireSweep();

    const matching = [...this.#tasks.values()]
      .filter((record) => record.ownerRootId === ownerRootId && (!wanted || wanted.has(record.status)))
      .sort(compareRecords)
      .filter((record) => isAfterCursor(record, decoded));
    const page = matching.slice(0, effectiveLimit).map(snapshot);
    const nextCursor = matching.length > effectiveLimit ? encodeCursor(page[page.length - 1]) : null;
    return { tasks: page, nextCursor };
  }

  markCancelling(taskId, options = {}) {
    const record = this.#requireRecord(taskId, options?.ownerRootId);
    if (TERMINAL_TASK_STATUSES.has(record.status)) return snapshot(record);
    // Status deliberately unchanged: the real terminal state lands via
    // transition() once the ACP turn actually ends.
    record.statusMessage = CANCELLATION_REQUESTED_MESSAGE;
    record.lastUpdatedAt = new Date(this.#now()).toISOString();
    this.#emit("updated", record);
    return snapshot(record);
  }

  expireSweep() {
    if (this.#sweeping) return 0;
    this.#sweeping = true;
    let removed = 0;
    try {
      const now = this.#now();
      for (const [taskId, record] of this.#tasks) {
        if (record.ttl == null) continue; // recovered records may opt out of TTL
        if (Date.parse(record.createdAt) + record.ttl > now) continue;
        if (ACTIVE_TASK_STATUSES.has(record.status)) {
          // TTL bounds the handle's lifetime, not just its retention: an active
          // task that outlives its TTL is first committed as failed (so the
          // persistence hook sees a real outcome), then removed in this same
          // sweep. After that tasks/get reports the id as unknown.
          record.status = "failed";
          record.statusMessage = TTL_ELAPSED_MESSAGE;
          record.result = { ok: false, error: TTL_ELAPSED_MESSAGE };
          record.lastUpdatedAt = new Date(now).toISOString();
          this.#emit("updated", record);
        }
        this.#rejectWaiters(taskId, () => taskError("TASK_TTL_EXPIRED", `Task ${taskId} expired before completion`));
        this.#tasks.delete(taskId);
        removed += 1;
        this.#emit("removed", record);
      }
    } finally {
      this.#sweeping = false;
    }
    return removed;
  }

  recover(records) {
    if (!Array.isArray(records)) throw taskError("INVALID_ARGUMENT", "recover expects an array of task records");
    const now = this.#now();
    const summary = { loaded: 0, restarted: 0, dropped: 0 };
    for (const raw of records) {
      const record = this.#sanitizePersisted(raw);
      if (!record) {
        summary.dropped += 1;
        continue;
      }
      if (record.ttl != null && Date.parse(record.createdAt) + record.ttl <= now) {
        summary.dropped += 1;
        continue;
      }
      if (ACTIVE_TASK_STATUSES.has(record.status)) {
        // An in-flight ACP request cannot survive a daemon restart. Keep the
        // durable handle, but make the restart visible with the legacy wording.
        record.status = "failed";
        record.statusMessage = RESTART_MESSAGE;
        record.result = { ok: false, error: RESTART_MESSAGE };
        record.lastUpdatedAt = new Date(now).toISOString();
        summary.restarted += 1;
      }
      // Budgets are not enforced here: recovery must never drop a durable handle.
      this.#tasks.set(record.taskId, record);
      summary.loaded += 1;
      this.#emit("recovered", record);
    }
    return summary;
  }

  toPersistedRecords(options = {}) {
    const includeTerminal = options?.includeTerminal ?? true;
    this.expireSweep();
    return [...this.#tasks.values()]
      .filter((record) => includeTerminal || ACTIVE_TASK_STATUSES.has(record.status))
      .sort(compareRecords)
      .map(snapshot);
  }

  clear() {
    for (const taskId of [...this.#waiters.keys()]) {
      this.#rejectWaiters(taskId, () => taskError("TASK_STORE_CLOSED", "TaskStore was cleared while waiting for a result"));
    }
    this.#tasks.clear();
    this.#emit("cleared", null);
  }

  #requireRecord(taskId, ownerRootId) {
    requireNonEmptyString(taskId, "taskId");
    this.expireSweep(); // every read path evaluates expiry lazily first
    const record = this.#tasks.get(taskId);
    if (!record) throw taskError("UNKNOWN_TASK", `Unknown taskId: ${taskId}`);
    if (ownerRootId != null) {
      requireNonEmptyString(ownerRootId, "ownerRootId");
      if (record.ownerRootId !== ownerRootId) throw taskError("NOT_TASK_OWNER", "Task belongs to another Main");
    }
    return record;
  }

  // `strict` distinguishes caller input (reject garbage) from persisted input
  // (repair garbage, because dropping a durable handle is the worse failure).
  #normalizeTtl(ttl, strict) {
    if (ttl == null) return this.#defaultTtlMs;
    if (typeof ttl !== "number" || !Number.isFinite(ttl)) {
      if (strict) throw taskError("INVALID_ARGUMENT", "ttl must be a finite number of milliseconds");
      return this.#defaultTtlMs;
    }
    return Math.min(Math.max(0, ttl), this.#maxTaskTtlMs);
  }

  #normalizePollInterval(pollInterval, strict) {
    if (pollInterval == null) return this.#defaultPollIntervalMs;
    if (typeof pollInterval !== "number" || !Number.isFinite(pollInterval)) {
      if (strict) throw taskError("INVALID_ARGUMENT", "pollInterval must be a finite number of milliseconds");
      return this.#defaultPollIntervalMs;
    }
    return Math.max(this.#minPollIntervalMs, pollInterval);
  }

  #sanitizePersisted(raw) {
    if (!raw || typeof raw !== "object") return null;
    const { taskId, sessionId, ownerRootId, status, createdAt } = raw;
    if (typeof taskId !== "string" || taskId === "") return null;
    if (typeof sessionId !== "string" || typeof ownerRootId !== "string") return null;
    if (!ALL_TASK_STATUSES.has(status)) return null;
    if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) return null;
    return {
      taskId,
      sessionId,
      ownerRootId,
      turnId: typeof raw.turnId === "string" ? raw.turnId : null,
      status,
      // An explicit null ttl is preserved as "never expires" (legacy behaviour);
      // a corrupt ttl falls back to the configured default rather than dropping
      // the handle.
      ttl: raw.ttl === null ? null : this.#normalizeTtl(raw.ttl, false),
      pollInterval: this.#normalizePollInterval(raw.pollInterval, false),
      createdAt,
      lastUpdatedAt: typeof raw.lastUpdatedAt === "string" ? raw.lastUpdatedAt : createdAt,
      statusMessage: typeof raw.statusMessage === "string" ? raw.statusMessage : "",
      result: raw.result ?? null
    };
  }

  #rootWaiterCount(ownerRootId) {
    let total = 0;
    for (const [taskId, set] of this.#waiters) {
      if (this.#tasks.get(taskId)?.ownerRootId === ownerRootId) total += set.size;
    }
    return total;
  }

  #settleWaiter(waiter) {
    const set = this.#waiters.get(waiter.taskId);
    if (set) {
      set.delete(waiter);
      if (set.size === 0) this.#waiters.delete(waiter.taskId);
    }
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.timer = null;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.onAbort = null;
  }

  #resolveWaiters(record) {
    const set = this.#waiters.get(record.taskId);
    if (!set) return;
    for (const waiter of [...set]) {
      this.#settleWaiter(waiter);
      waiter.resolve(snapshot(record));
    }
  }

  #rejectWaiters(taskId, errorFactory) {
    const set = this.#waiters.get(taskId);
    if (!set) return;
    for (const waiter of [...set]) {
      this.#settleWaiter(waiter);
      waiter.reject(errorFactory()); // fresh Error per waiter: stacks stay useful
    }
  }

  #emit(type, record) {
    try {
      this.#onChange({ type, taskId: record?.taskId ?? null, task: record ? snapshot(record) : null });
    } catch {
      // onChange is a notification hook (future persistence scheduler). A failing
      // listener must not corrupt an already-applied in-memory mutation.
    }
  }
}
