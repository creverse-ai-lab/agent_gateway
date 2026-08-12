import { AsyncLocalStorage } from "node:async_hooks";
import { ERROR_CODES, GatewayError } from "./errors.js";

// Every mutating session command runs through one mailbox per session, so a
// command always observes the state its predecessor committed instead of a
// half-applied interleaving. The bound is a module constant on purpose: it is a
// safety valve against a runaway caller, not a tuning knob on the wire.
export const SESSION_QUEUE_LIMIT = 32;

// Tracks which queue owns the current async context. Awaiting the same queue
// from inside one of its own commands would deadlock forever, so it throws
// loudly instead of hanging: a silent deadlock at the only serialization point
// is the worst failure mode this module can have.
const RUNNING = new AsyncLocalStorage();

export class SessionQueue {
  constructor({ id, limit = SESSION_QUEUE_LIMIT } = {}) {
    this.id = id;
    this.limit = limit;
    this.items = [];
    this.running = null;
    this.closedError = null;
    this.drainWaiters = new Set();
  }

  get depth() {
    return this.items.length + (this.running == null ? 0 : 1);
  }

  get idle() {
    return this.running == null && this.items.length === 0;
  }

  // Awaited command: the caller gets the body's value or its original error
  // object, so existing message contracts survive the extra hop.
  run(kind, fn) {
    if (RUNNING.getStore() === this) {
      throw new Error(
        `Session queue ${this.id} re-entered by ${kind} from inside command ${this.running}`
      );
    }
    return this.#submit(kind, fn);
  }

  // Fire-and-forget command (turn callbacks, provider exit, orphan cancel).
  // There is no caller to reject to, and a closed queue must not turn into an
  // unhandled rejection, so the outcome is swallowed by design.
  post(kind, fn) {
    void this.#submit(kind, fn).catch(() => {});
  }

  // Rejects everything still waiting. A command queued behind a close would
  // otherwise wake up and act on a session that no longer exists.
  closeWith(error) {
    this.closedError = error;
    for (const item of this.items.splice(0)) item.reject(error);
    this.#settleDrain();
  }

  // Resolves true once the mailbox is empty, false when the cap is hit first.
  drain(timeoutMs = 0) {
    if (this.idle) return Promise.resolve(true);
    return new Promise((done) => {
      let timer = null;
      const waiter = (value) => {
        if (!this.drainWaiters.delete(waiter)) return;
        if (timer) clearTimeout(timer);
        done(value);
      };
      this.drainWaiters.add(waiter);
      if (timeoutMs > 0) {
        timer = setTimeout(() => waiter(false), timeoutMs);
        timer.unref?.();
      }
    });
  }

  #submit(kind, fn) {
    if (this.closedError) return Promise.reject(this.closedError);
    // The cap counts everything outstanding, the running command included, so
    // the bound is on work this session still owes rather than on how much of
    // it happens to be waiting at this instant.
    if (this.depth >= this.limit) {
      return Promise.reject(new GatewayError(
        ERROR_CODES.SESSION_ACTIVE,
        `Session ${this.id} has too many queued commands`
      ));
    }
    return new Promise((resolve, reject) => {
      this.items.push({ kind, fn, resolve, reject });
      if (this.running == null) void this.#pump();
    });
  }

  async #pump() {
    while (this.items.length) {
      const item = this.items.shift();
      this.running = item.kind;
      try {
        item.resolve(await RUNNING.run(this, () => item.fn()));
      } catch (error) {
        // Per-command settlement: one failing command must not poison the pump.
        item.reject(error);
      }
    }
    this.running = null;
    this.#settleDrain();
  }

  #settleDrain() {
    if (!this.idle) return;
    for (const waiter of [...this.drainWaiters]) waiter(true);
  }
}
