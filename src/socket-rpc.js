import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { gatewayLifecycleConfig, gatewaySocketPath } from "./config.js";
import { readNdjson } from "./ndjson.js";

export class GatewayRpcClient {
  constructor({ socketPath = gatewaySocketPath(), token = null, rootId = null, autoStart = true } = {}) {
    this.socketPath = socketPath;
    this.token = token;
    this.rootId = rootId;
    this.autoStart = autoStart;
    this.socket = null;
    this.pending = new Map();
    this.subscriptions = new Map();
    this.serverSubscriptions = new Map();
    this.earlyEvents = new Map();
    this.earlySubscriptionErrors = new Map();
    this.connecting = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.closed = false;
    this.maxFrameBytes = gatewayLifecycleConfig().maxFrameBytes;
  }

  async call(method, args = {}, timeoutMs = 30_000) {
    await this.connect();
    return this.#requestConnected(method, args, timeoutMs);
  }

  async subscribe(args = {}, onEvent, timeoutMs = 30_000) {
    if (typeof onEvent !== "function") throw new Error("Subscription event handler is required");
    await this.connect();
    const result = await this.#requestConnected("subscribe", args, timeoutMs);
    const stableId = result.subscriptionId;
    const record = {
      stableId,
      serverId: result.subscriptionId,
      args: structuredClone(args),
      cursors: { ...(args.cursors ?? {}) },
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
      if (!this.autoStart || !["ENOENT", "ECONNREFUSED"].includes(error?.code)) throw error;
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
      if (lastError) throw lastError;
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
        this.socket = socket;
        resolve();
      });
    });
  }

  #requestConnected(method, args, timeoutMs) {
    if (!this.socket || this.socket.destroyed) throw new Error("Gateway socket is not connected");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.socket.write(`${JSON.stringify({ id, method, args, token: this.token, rootId: this.rootId })}\n`);
    });
  }

  async #restoreSubscriptions() {
    this.serverSubscriptions.clear();
    for (const record of this.subscriptions.values()) {
      const result = await this.#requestConnected("subscribe", {
        ...record.args,
        cursors: { ...(record.args.cursors ?? {}), ...record.cursors }
      }, record.timeoutMs);
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
      const stableId = this.serverSubscriptions.get(message.subscriptionId);
      const record = stableId ? this.subscriptions.get(stableId) : null;
      if (record) this.#deliver(record, message.event);
      else {
        const events = this.earlyEvents.get(message.subscriptionId) ?? [];
        if (events.length < 1000) events.push(message.event);
        this.earlyEvents.set(message.subscriptionId, events);
      }
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
      pending.reject(error);
    }
  }

  #deliver(record, event) {
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
