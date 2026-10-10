import { TERMINAL_TASK_STATUSES } from "./task-store.js";

// How often the front door reads every task it follows, for a status change
// its subscription did not deliver.
export const TASK_HEARTBEAT_MS = 30_000;
const MIN_TASK_HEARTBEAT_MS = 100;
const MAX_TASK_HEARTBEAT_MS = 300_000;
const TASK_GET_TIMEOUT_MS = 30_000;
// A task_get or a resubscribe answering one of these will never report the
// task again: it is gone (its TTL ran out), or no longer this Main's.
const GONE = new Set(["UNKNOWN_TASK", "NOT_TASK_OWNER"]);

/** ACP_GATEWAY_TASK_HEARTBEAT_MS, bounded; the default when unset or invalid. */
export function taskHeartbeatMs(env = process.env) {
  const value = Number(env.ACP_GATEWAY_TASK_HEARTBEAT_MS);
  if (!Number.isInteger(value) || value < MIN_TASK_HEARTBEAT_MS) return TASK_HEARTBEAT_MS;
  return Math.min(value, MAX_TASK_HEARTBEAT_MS);
}

// The tasks this front door's MCP client created through a task-augmented
// tools/call (index.js), followed so each status change reaches that client as
// notifications/tasks/status. Each task is followed twice over: a daemon
// subscription to it by id, which pushes every status it takes, and a
// heartbeat that reads it with task_get, for whatever the push did not
// deliver (a subscription that could not be made or was refused, a daemon
// that does not know taskIds, a frame lost). Following a task ends at its
// terminal status, which is sent exactly once, or when it is gone.
//
// connect() makes the Gateway client, on first use and again after an idle
// spell: with nothing left to follow there is no heartbeat and no connection,
// so no reconnect either. notify(task) sends one notification.
export class TaskFollower {
  #connect;
  #notify;
  #heartbeatMs;
  #client = null;
  #tasks = new Map();
  #timer = null;
  #beating = false;
  #closed = false;

  constructor({ connect, notify, heartbeatMs = TASK_HEARTBEAT_MS }) {
    this.#connect = connect;
    this.#notify = notify;
    this.#heartbeatMs = heartbeatMs;
  }

  // created is the Task the CreateTaskResult carried: the client holds that
  // state already, so only a change from it is sent.
  follow(created) {
    const taskId = created?.taskId;
    if (this.#closed || typeof taskId !== "string" || this.#tasks.has(taskId)) return;
    if (TERMINAL_TASK_STATUSES.has(created.status)) return;
    // heard counts what the subscription delivered, so a read that left
    // before a push can tell it is older.
    const entry = {
      taskId, status: created.status, statusMessage: created.statusMessage, subscriptionId: null, heard: 0
    };
    this.#tasks.set(taskId, entry);
    this.#schedule();
    void this.#subscribe(entry);
  }

  close() {
    this.#closed = true;
    this.#tasks.clear();
    this.#idle();
  }

  #rpc() {
    this.#client ??= this.#connect();
    return this.#client;
  }

  async #subscribe(entry) {
    const heard = entry.heard;
    let client;
    let subscribed;
    try {
      client = this.#rpc();
      // sessionIds: [] so a daemon that ignores taskIds subscribes to nothing,
      // instead of to every session.
      subscribed = await client.subscribe(
        { sessionIds: [], taskIds: [entry.taskId] },
        (event) => this.#onEvent(entry, event)
      );
    } catch (error) {
      // Refused for another reason (the subscription limit, the daemon going
      // down): the heartbeat follows this task alone.
      if (GONE.has(error?.code)) this.#stop(entry);
      return;
    }
    // No taskIds in the reply: a daemon that streams nothing for this task.
    if (!Array.isArray(subscribed.taskIds) || this.#tasks.get(entry.taskId) !== entry) {
      client.unsubscribe(subscribed.subscriptionId).catch(() => {});
      return;
    }
    entry.subscriptionId = subscribed.subscriptionId;
    // The reply says where the task stands now, unless the stream already
    // delivered something newer while the reply was on its way.
    if (entry.heard === heard) for (const event of subscribed.events ?? []) this.#onEvent(entry, event);
  }

  #onEvent(entry, event) {
    if (event?.type === "subscription_error") {
      // The subscription is over (the daemon dropped it, or refused it again
      // after a reconnect). The heartbeat goes on unless the task is gone.
      entry.subscriptionId = null;
      if (GONE.has(event.errorCode)) this.#stop(entry);
      return;
    }
    if (event?.type !== "task_status" || event.taskId !== entry.taskId) return;
    entry.heard += 1;
    this.#observe(entry, event);
  }

  #observe(entry, task) {
    if (this.#tasks.get(entry.taskId) !== entry) return;
    if (task.status === entry.status && task.statusMessage === entry.statusMessage) return;
    entry.status = task.status;
    entry.statusMessage = task.statusMessage;
    // Before the send, so nothing heard after a terminal status is sent again.
    if (TERMINAL_TASK_STATUSES.has(task.status)) this.#stop(entry);
    try {
      Promise.resolve(this.#notify(task)).catch(() => {});
    } catch {
      // Best effort, as the spec makes it: tasks/get still answers.
    }
  }

  #stop(entry) {
    if (this.#tasks.get(entry.taskId) !== entry) return;
    this.#tasks.delete(entry.taskId);
    if (entry.subscriptionId) this.#client?.unsubscribe(entry.subscriptionId).catch(() => {});
    if (this.#tasks.size === 0) this.#idle();
  }

  // Nothing to follow: the connection goes too, taking along any subscription
  // an unsubscribe did not reach.
  #idle() {
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#client?.close();
    this.#client = null;
  }

  #schedule() {
    if (this.#timer || this.#beating || this.#tasks.size === 0) return;
    this.#timer = setTimeout(() => void this.#beat(), this.#heartbeatMs);
    this.#timer.unref?.();
  }

  async #beat() {
    this.#timer = null;
    this.#beating = true;
    try {
      await Promise.all([...this.#tasks.values()].map((entry) => this.#check(entry)));
    } finally {
      this.#beating = false;
      this.#schedule();
    }
  }

  async #check(entry) {
    const heard = entry.heard;
    let task;
    try {
      task = await this.#rpc().call("task_get", { taskId: entry.taskId }, TASK_GET_TIMEOUT_MS);
    } catch (error) {
      if (GONE.has(error?.code)) this.#stop(entry);
      // Anything else (no daemon right now) is asked again at the next beat.
      return;
    }
    // A push that arrived while this read was out is at least as new.
    if (entry.heard === heard) this.#observe(entry, task);
  }
}
