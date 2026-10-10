import { isSameCaller } from "./attention.js";
import { normalizeCaller } from "./caller.js";

// Where each Main stands, for a management view (1.9.0): main_list and the
// main_status event. AgenLynk renders every front door with its Workers, and a
// Main asleep in agent_acp_wait is waiting on those Workers, not idle. One entry
// per caller a control connection named, keyed as CallerPresence keys it (its
// session id and its front door's instance id), so a front-door process is one
// entry and a Codex one is an entry per thread it served. In memory only: a
// daemon restart ends every connection, and with them every Main.
//
// waiting_tasks while at least one wait of the Main blocks, active while a
// connection that named it is open and none does. Once neither holds the entry
// is gone, which only its last event says.
export const MAIN_STATUSES = Object.freeze(["active", "waiting_tasks"]);
// Past this many callers a connection lists no more of them: a Codex front door
// names one per thread. CallerPresence bounds a connection the same way.
const MAX_MAINS_PER_CONNECTION = 1_024;

export class MainRegistry {
  #mains = new Map(); // key -> entry
  #connections = new Map(); // connection -> Set(key)
  // Grows with every change of any entry. An event and a main_list reply can
  // overtake each other on the wire (replies ride ahead of events), so a
  // consumer keeps, per Main, whichever it read with the higher revision.
  #revision = 0;
  #now;
  #onChange;

  // onChange(rootId, main) gets the entry as list() reads it, or {caller,
  // status: "gone", since, revision} once it is gone.
  constructor({ now = () => Date.now(), onChange = () => {} } = {}) {
    this.#now = now;
    this.#onChange = onChange;
  }

  /** A control request on `connection` named `caller`: that Main is connected until the connection closes. */
  attach(connection, rootId, caller) {
    const normalized = normalizeCaller(caller);
    if (!normalized || typeof rootId !== "string" || !rootId) return;
    const key = mainKey(rootId, normalized);
    const keys = this.#connections.get(connection) ?? new Set();
    if (keys.has(key) || keys.size >= MAX_MAINS_PER_CONNECTION) return;
    keys.add(key);
    this.#connections.set(connection, keys);
    this.#entry(key, rootId, normalized).connections += 1;
    this.#settle(key);
  }

  /** The connection closed: a Main it named is gone unless another connection or a wait still holds it. */
  detach(connection) {
    const keys = this.#connections.get(connection);
    if (!keys) return;
    this.#connections.delete(connection);
    for (const key of keys) {
      const entry = this.#mains.get(key);
      if (!entry) continue;
      entry.connections -= 1;
      this.#settle(key);
    }
  }

  /**
   * A wait of `caller` blocks on `taskIds`. Returns the handle updateWait and
   * endWait take, or null for a requester that is no Main.
   */
  startWait(rootId, caller, taskIds) {
    const normalized = normalizeCaller(caller);
    if (!normalized || typeof rootId !== "string" || !rootId) return null;
    const handle = { key: mainKey(rootId, normalized) };
    this.#entry(handle.key, rootId, normalized).waits.set(handle, [...taskIds]);
    this.#settle(handle.key);
    return handle;
  }

  /** The tasks a blocked wait still watches changed (one of them went away). */
  updateWait(handle, taskIds) {
    const entry = handle ? this.#mains.get(handle.key) : null;
    if (!entry?.waits.has(handle)) return;
    entry.waits.set(handle, [...taskIds]);
    this.#settle(handle.key);
  }

  endWait(handle) {
    const entry = handle ? this.#mains.get(handle.key) : null;
    if (!entry?.waits.delete(handle)) return;
    this.#settle(handle.key);
  }

  /** The Mains of a root: every one for requester null (management, observer), else the requester's own. */
  list(rootId, requester = null) {
    return [...this.#mains.values()]
      .filter((entry) => entry.rootId === rootId && (requester == null || isSameCaller(entry.caller, requester)))
      .map((entry) => ({ ...publicMain(entry), revision: entry.revision }));
  }

  #entry(key, rootId, caller) {
    let entry = this.#mains.get(key);
    if (!entry) {
      // The identity only: a Codex caller's turnId is the call's, not the Main's.
      const { provider, sessionId, pid, instanceId } = caller;
      entry = {
        rootId, caller: { provider, sessionId, pid, instanceId }, connections: 0, waits: new Map(),
        status: null, since: null, shown: null, revision: 0
      };
      this.#mains.set(key, entry);
    }
    return entry;
  }

  // Where the entry stands now; reported only when what list() reads changed.
  #settle(key) {
    const entry = this.#mains.get(key);
    if (!entry) return;
    const status = entry.waits.size > 0 ? "waiting_tasks" : entry.connections > 0 ? "active" : null;
    const at = new Date(this.#now()).toISOString();
    if (!status) {
      this.#mains.delete(key);
      this.#emit(entry.rootId, { caller: { ...entry.caller }, status: "gone", since: at, revision: ++this.#revision });
      return;
    }
    if (status !== entry.status) {
      entry.status = status;
      entry.since = at;
    }
    const main = publicMain(entry);
    const shown = JSON.stringify(main);
    if (shown === entry.shown) return;
    entry.shown = shown;
    entry.revision = ++this.#revision;
    this.#emit(entry.rootId, { ...main, revision: entry.revision });
  }

  #emit(rootId, main) {
    try {
      this.#onChange(rootId, main);
    } catch {
      // A notification hook: a failing listener must not undo the bookkeeping.
    }
  }
}

function mainKey(rootId, caller) {
  return `${rootId}\u0000${caller.sessionId ?? ""}\u0000${caller.instanceId}`;
}

// The tasks are those its blocked waits still watch, each once.
function publicMain(entry) {
  const taskIds = entry.status === "waiting_tasks" ? [...new Set([...entry.waits.values()].flat())] : null;
  return {
    caller: { ...entry.caller },
    status: entry.status,
    since: entry.since,
    ...(taskIds ? { taskIds, count: taskIds.length } : {})
  };
}
