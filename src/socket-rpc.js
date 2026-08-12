import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { gatewayLifecycleConfig, gatewaySocketPath, gatewayStatePath } from "./config.js";
import { readNdjson } from "./ndjson.js";
import { LANE_HIGH, LANE_NORMAL, NdjsonChannel } from "./ndjson-channel.js";
import { statePaths } from "./state-store.js";

// Lane B has no droppable traffic: every frame here has a pending promise behind
// it. The one thing lanes buy is that a cancel never queues behind a
// megabyte-sized prompt.
const HIGH_LANE_METHODS = new Set([
  "cancel", "permission", "answer", "subscribe", "unsubscribe", "daemon_shutdown", "request_cancel"
]);

// A daemon that halted in state recovery cannot answer, and its stderr went
// nowhere (autostart ignores stdio). The marker file is the only channel it had,
// so a connect failure checks for one and reports the real reason instead of
// "socket not found".
function recoveryError(error, statePath) {
  let marker = null;
  try {
    marker = JSON.parse(readFileSync(statePaths(statePath).marker, "utf8"));
  } catch {
    return error;
  }
  if (!marker?.error) return error;
  const halted = new Error(
    `Gateway could not start: ${marker.error} (recorded ${marker.at}). `
    + "Resolve it, then remove the recovery-required marker file."
  );
  halted.code = marker.errorCode ?? "STATE_RECOVERY_REQUIRED";
  return halted;
}

export class GatewayRpcClient {
  constructor({
    socketPath = gatewaySocketPath(),
    token = null,
    rootId = null,
    autoStart = true,
    // Only used to find the recovery marker a halted daemon left behind.
    statePath = gatewayStatePath()
  } = {}) {
    this.socketPath = socketPath;
    this.statePath = statePath;
    this.token = token;
    this.rootId = rootId;
    this.autoStart = autoStart;
    this.socket = null;
    this.channel = null;
    this.pending = new Map();
    this.subscriptions = new Map();
    this.serverSubscriptions = new Map();
    this.earlyEvents = new Map();
    this.earlySubscriptionErrors = new Map();
    this.connecting = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.closed = false;
    const lifecycle = gatewayLifecycleConfig();
    this.maxFrameBytes = lifecycle.maxFrameBytes;
    this.maxQueueBytes = lifecycle.maxQueueBytes;
    this.writeTimeoutMs = lifecycle.writeTimeoutMs;
  }

  async call(method, args = {}, timeoutMs = 30_000, options = {}) {
    if (options?.signal?.aborted) throw waitAbortedError(method);
    await this.connect();
    if (options?.signal?.aborted) throw waitAbortedError(method);
    return this.#requestConnected(method, args, timeoutMs, options);
  }

  async subscribe(args = {}, onEvent, timeoutMs = 30_000) {
    if (typeof onEvent !== "function") throw new Error("Subscription event handler is required");
    await this.connect();
    // This client understands subscription_gap and lowers its cursor to the start
    // of a reported gap, so it opts into being shed rather than disconnected.
    const subscribeArgs = { ...args, acceptsGaps: true };
    const result = await this.#requestConnected("subscribe", subscribeArgs, timeoutMs);
    const stableId = result.subscriptionId;
    const record = {
      stableId,
      serverId: result.subscriptionId,
      args: structuredClone(subscribeArgs),
      cursors: { ...(args.cursors ?? {}) },
      // Lowest sequence known to be missing per session. Left behind by a gap
      // marker and consumed by the next resubscribe.
      gapFloor: {},
      onEvent,
      timeoutMs
    };
    this.#advanceReplay(record, result.events ?? []);
    this.subscriptions.set(stableId, record);
    this.serverSubscriptions.set(record.serverId, stableId);
    this.#drainEarlyEvents(record);
    return { ...result, subscriptionId: stableId };
  }

  async unsubscribe(subscriptionId, timeoutMs = 30_000) {
    const record = this.subscriptions.get(subscriptionId);
    await this.connect();
    const serverId = record?.serverId ?? subscriptionId;
    const result = await this.#requestConnected("unsubscribe", { subscriptionId: serverId }, timeoutMs);
    if (record) this.serverSubscriptions.delete(record.serverId);
    this.subscriptions.delete(subscriptionId);
    return result;
  }

  async connect() {
    if (this.closed) throw new Error("Gateway client is closed");
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connecting = this.#connectAndRestore().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async #connectAndRestore() {
    try {
      await this.#connectOnce();
    } catch (error) {
      if (!this.autoStart || !["ENOENT", "ECONNREFUSED"].includes(error?.code)) throw recoveryError(error, this.statePath);
      this.#startDaemon();
      let lastError = error;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((done) => setTimeout(done, 50));
        try {
          await this.#connectOnce();
          lastError = null;
          break;
        } catch (retryError) {
          lastError = retryError;
        }
      }
      if (lastError) throw recoveryError(lastError, this.statePath);
    }
    await this.#restoreSubscriptions();
    this.reconnectAttempt = 0;
  }

  #connectOnce() {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const onError = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        socket.on("error", (error) => this.#disconnect(error, socket));
        socket.on("close", () => this.#disconnect(new Error("Gateway socket closed"), socket));
        readNdjson(socket, {
          maxLineBytes: this.maxFrameBytes,
          onLine: (line) => this.#onLine(line),
          onOverflow: (overflowError) => socket.destroy(overflowError)
        });
        this.channel = new NdjsonChannel(socket, {
          maxFrameBytes: this.maxFrameBytes,
          maxQueueBytes: this.maxQueueBytes,
          writeTimeoutMs: this.writeTimeoutMs,
          // The existing disconnect machine is the recovery: it rejects every
          // pending call and reconnects with the subscription cursors intact.
          onFatal: (error) => this.#disconnect(error, socket)
        });
        this.socket = socket;
        resolve();
      });
    });
  }

  #requestConnected(method, args, timeoutMs, options = {}) {
    if (!this.socket || this.socket.destroyed || !this.channel) {
      throw new Error("Gateway socket is not connected");
    }
    const id = randomUUID();
    const signal = options?.signal;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback(value);
      };
      const cancelRemote = () => {
        if (!this.socket || this.socket.destroyed || !this.channel) return;
        try {
          this.channel.write(LANE_HIGH, {
            method: "request_cancel",
            args: { requestId: id },
            token: this.token,
            rootId: this.rootId
          });
        } catch {
          // The original wait is already being rejected. Channel fatal handling
          // owns any transport teardown caused by a cancellation write failure.
        }
      };
      const onAbort = () => {
        this.pending.delete(id);
        cancelRemote();
        finish(reject, waitAbortedError(method));
      };
      // Registered only after the frame is on its way. A write that throws must
      // reject this promise rather than orphan a pending entry that no response
      // will ever arrive for.
      this.channel.write(
        HIGH_LANE_METHODS.has(method) ? LANE_HIGH : LANE_NORMAL,
        { id, method, args, token: this.token, rootId: this.rootId }
      );
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cancelRemote();
        finish(reject, new Error(`Gateway request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error)
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async #restoreSubscriptions() {
    this.serverSubscriptions.clear();
    for (const record of this.subscriptions.values()) {
      const cursors = { ...(record.args.cursors ?? {}), ...record.cursors };
      // The replay does the real repair work: rewinding to the gap floor asks the
      // ring for everything from the first dropped sequence on. Outside the ring
      // the existing cursorTruncated path reports it, as it always has.
      for (const [sessionId, floor] of Object.entries(record.gapFloor ?? {})) {
        const rewound = Math.min(cursors[sessionId] ?? Infinity, floor);
        cursors[sessionId] = rewound;
        // The local delivery filter has to move with it, or #deliver would discard
        // the very replay this asked for. Some events therefore arrive twice:
        // at-least-once is the right trade against losing them silently.
        record.cursors[sessionId] = rewound;
      }
      const result = await this.#requestConnected("subscribe", { ...record.args, cursors }, record.timeoutMs);
      // Cleared only once the resubscribe carrying it succeeded.
      record.gapFloor = {};
      record.serverId = result.subscriptionId;
      this.serverSubscriptions.set(record.serverId, record.stableId);
      const truncated = Object.entries(result.cursorTruncated ?? {})
        .filter(([, value]) => value)
        .map(([sessionId]) => sessionId);
      if (truncated.length) {
        record.onEvent({ type: "subscription_replay_truncated", sessionIds: truncated });
      }
      for (const event of result.events ?? []) this.#deliver(record, event);
      this.#drainEarlyEvents(record);
    }
  }

  #startDaemon() {
    const daemon = fileURLToPath(new URL("./gateway-daemon.js", import.meta.url));
    const child = spawn(process.execPath, [daemon], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ACP_GATEWAY_SOCKET: this.socketPath,
        ...(this.token ? { ACP_GATEWAY_CONTROL_TOKEN: this.token } : {}),
        ...(this.rootId ? { ACP_GATEWAY_ROOT_ID: this.rootId } : {})
      }
    });
    child.unref();
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "event" && message.subscriptionId) {
      this.#route(message.subscriptionId, message.event);
      return;
    }
    // A gap marker is a record about the subscription rather than a session event,
    // so it arrives as its own frame. It travels the same delivery path because it
    // has to be seen in order relative to the events around it.
    if (message.type === "subscription_gap" && message.subscriptionId) {
      this.#route(message.subscriptionId, message);
      return;
    }
    if (message.type === "subscription_error" && message.subscriptionId) {
      const stableId = this.serverSubscriptions.get(message.subscriptionId);
      const record = stableId ? this.subscriptions.get(stableId) : null;
      if (record) {
        this.#failSubscription(record, message.error);
      } else this.earlySubscriptionErrors.set(message.subscriptionId, message.error);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error || "Gateway request failed");
      // Carry the Gateway's stable error code across the socket so callers can
      // branch on it instead of matching message text.
      if (typeof message.errorCode === "string" && message.errorCode) error.code = message.errorCode;
      if (Object.hasOwn(message, "details")) error.details = message.details;
      pending.reject(error);
    }
  }

  // Events can arrive before the subscribe response has been awaited, so an
  // unknown subscription buffers instead of discarding.
  #route(serverId, event) {
    const stableId = this.serverSubscriptions.get(serverId);
    const record = stableId ? this.subscriptions.get(stableId) : null;
    if (record) {
      this.#deliver(record, event);
      return;
    }
    const events = this.earlyEvents.get(serverId) ?? [];
    if (events.length < 1000) events.push(event);
    this.earlyEvents.set(serverId, events);
  }

  #deliver(record, event) {
    // A gap marker carries no sequence on purpose, so it can never advance a
    // cursor. What it does is pull the resubscribe cursor back to the start of
    // what was dropped: without this the events the daemon shed would be lost
    // silently forever, which is worse than the noisy error it replaced.
    if (event?.type === "subscription_gap" && event.sessionId != null && Number.isFinite(event.fromSequence)) {
      const floor = record.gapFloor ??= {};
      floor[event.sessionId] = Math.min(floor[event.sessionId] ?? Infinity, event.fromSequence);
      // Reported under the id the caller subscribed with, never the server's.
      record.onEvent({ ...event, subscriptionId: record.stableId });
      return;
    }
    if (event?.sessionId && Number.isFinite(event.sequence)) {
      const cursor = record.cursors[event.sessionId] ?? 0;
      if (event.sequence < cursor) return;
      record.cursors[event.sessionId] = event.sequence + 1;
    }
    record.onEvent(event);
  }

  #advanceReplay(record, events) {
    for (const event of events) {
      if (event?.sessionId && Number.isFinite(event.sequence)) {
        record.cursors[event.sessionId] = Math.max(record.cursors[event.sessionId] ?? 0, event.sequence + 1);
      }
    }
  }

  #drainEarlyEvents(record) {
    const events = this.earlyEvents.get(record.serverId) ?? [];
    this.earlyEvents.delete(record.serverId);
    for (const event of events) this.#deliver(record, event);
    if (this.earlySubscriptionErrors.has(record.serverId)) {
      const error = this.earlySubscriptionErrors.get(record.serverId);
      this.earlySubscriptionErrors.delete(record.serverId);
      this.#failSubscription(record, error);
    }
  }

  #failSubscription(record, error) {
    this.serverSubscriptions.delete(record.serverId);
    this.subscriptions.delete(record.stableId);
    record.onEvent({ type: "subscription_error", error });
  }

  #disconnect(error, socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.channel?.destroy(error);
    this.channel = null;
    // A congested or stalled socket is still open here: nothing will drain it, so
    // the reconnect needs the old one actually gone.
    socket.destroy();
    this.serverSubscriptions.clear();
    this.earlyEvents.clear();
    this.earlySubscriptionErrors.clear();
    for (const record of this.subscriptions.values()) record.serverId = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.closed || this.reconnectTimer || this.subscriptions.size === 0) return;
    const delay = Math.min(30_000, 100 * (2 ** this.reconnectAttempt++));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.#scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref();
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.channel?.destroy();
    this.channel = null;
    this.socket?.end();
    this.socket = null;
    this.serverSubscriptions.clear();
    this.earlyEvents.clear();
    this.earlySubscriptionErrors.clear();
    this.subscriptions.clear();
    for (const pending of this.pending.values()) pending.reject(new Error("Gateway client closed"));
    this.pending.clear();
  }
}

function waitAbortedError(method) {
  const error = new Error(`Gateway request aborted: ${method}`);
  error.code = "WAIT_ABORTED";
  return error;
}
