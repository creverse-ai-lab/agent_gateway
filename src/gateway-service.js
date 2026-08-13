import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { AcpClient, PERMISSION_POLICIES, requirePermissionPolicy } from "./acp-client.js";
import { ArtifactStore, defaultArtifactRoot } from "./artifacts.js";
import { utf8ByteHead } from "./bounded-utf8.js";
import { ERROR_CODES, GatewayError } from "./errors.js";
import { currentModelId, detectProviders, providerConfig } from "./providers.js";
import { SessionQueue } from "./session-queue.js";
import { publicSession, SessionStore } from "./sessions.js";
import { crashAfter, StateStore, WAL_TYPES } from "./state-store.js";
import { TaskStore, TERMINAL_TASK_STATUSES } from "./task-store.js";
import { GATEWAY_API_VERSION, GATEWAY_VERSION, LEGACY_STATE_SCHEMA_VERSION, STATE_SCHEMA_VERSION } from "./version.js";

const ACTIVE_STATUSES = new Set(["running", "waiting_permission", "waiting_input", "cancelling", "restoring"]);
// The only legal status moves. Every assignment goes through #setStatus, so a
// late callback cannot walk a session backwards into a state its owner already
// left. "closed" is the single true terminal.
const STATUS_TRANSITIONS = {
  idle: new Set(["running", "restoring", "disconnected", "closed"]),
  running: new Set([
    "waiting_permission", "waiting_input", "cancelling", "idle", "cancelled", "error",
    "disconnected", "closed"
  ]),
  waiting_permission: new Set([
    "running", "waiting_input", "cancelling", "idle", "cancelled", "error", "disconnected", "closed"
  ]),
  waiting_input: new Set([
    "running", "waiting_permission", "cancelling", "idle", "cancelled", "error", "disconnected", "closed"
  ]),
  // A cancel that was already notified only moves terminal-ward: see #setStatus
  // for the coerce and drop rules that keep it there.
  cancelling: new Set(["cancelled", "error", "disconnected", "closed"]),
  // Never "running": a turn must not start underneath an in-flight restore.
  restoring: new Set(["idle", "unavailable", "disconnected", "closed"]),
  disconnected: new Set(["restoring", "closed"]),
  unavailable: new Set(["restoring", "disconnected", "closed"]),
  error: new Set(["running", "restoring", "disconnected", "closed"]),
  cancelled: new Set(["running", "restoring", "disconnected", "closed"]),
  closed: new Set()
};
// Only the start of new work closes a message segment. Progress updates
// (tool_call_update), thoughts, and bookkeeping types never do — a boundary
// mid-answer would amputate the text before it, and a trailing one would
// erase the final answer.
const SEGMENT_BOUNDARY_TYPES = new Set(["tool_call", "permission_request", "elicitation_request"]);
const ACTOR_UPDATE_TYPES = new Set(["permission_request", "elicitation_request", "config_option_update"]);
// A normal Main needs only a terminal result or a request it must answer.
// Progress is available through explicit evidence options, but must not make
// every streamed chunk into another frontdoor tool result.
const DEFAULT_POLL_EVENT_TYPES = new Set(["permission_request", "elicitation_request"]);
const EVENT_PAYLOAD_CAP_BYTES = 4000;
const CLOSED_STATUSES = new Set(["closed"]);
// A live client is not enough to start work in these states: the record is
// known to be out of sync with the worker, so it has to be resumed first.
const RESTORE_REQUIRED_STATUSES = new Set(["disconnected", "unavailable"]);
const CONTROL_SERVER_PATTERN = /(?:acp-gateway-control|acp-mcp-bridge|gateway-daemon|control-mcp)/i;
const DURABLE_EVENT_TYPES = new Set([
  "session_created", "session_restored", "session_restore_start", "session_restore_failed",
  "turn_start", "turn_end", "error", "permission_request", "permission_response",
  "elicitation_request", "elicitation_response", "cancel_requested", "orphan_cancel_requested",
  "provider_disconnected", "session_closed", "model_changed", "config_changed"
]);

export class GatewayService {
  constructor({
    statePath,
    maxEvents = 200,
    maxTextBytes = 1_000_000,
    maxInlineResultBytes = 64 * 1024,
    maxArtifactBytes = 100 * 1024 * 1024,
    maxArtifactTotalBytes = 512 * 1024 * 1024,
    maxTerminalsPerSession = 16,
    maxPendingRequestsPerSession = 64,
    maxFrameBytes = 32 * 1024 * 1024,
    artifactRoot = statePath ? join(dirname(statePath), "artifacts") : defaultArtifactRoot(),
    artifactStore = null,
    createClient = null,
    gcIntervalMs = 5 * 60_000,
    idleUnloadMs = 30 * 60_000,
    orphanGraceMs = 24 * 60 * 60_000,
    resultRetentionMs = 24 * 60 * 60_000,
    inboxRetentionMs = 24 * 60 * 60_000,
    sessionRetentionMs = 7 * 24 * 60 * 60_000,
    taskRetentionMs = 24 * 60 * 60_000,
    persistence = {},
    agentUpdateManager = null,
    now = () => Date.now()
  } = {}) {
    this.statePath = statePath;
    this.clients = new Map();
    this.clientStarts = new Map();
    this.stopped = false;
    // Counts transitions the table rejected. Zero is the invariant; the strict
    // env turns each one into a throw for the race suite.
    this.illegalTransitions = 0;
    this.persistChain = Promise.resolve();
    this.persistDirty = false;
    this.persistTimer = null;
    this.persistError = null;
    this.inbox = new Map();
    this.subscriptions = new Map();
    this.rootPresence = new Map();
    this.createClient = createClient;
    this.agentUpdateManager = agentUpdateManager;
    this.now = now;
    // Task semantics (TTL from createdAt, budgets, waiters, keyset pagination)
    // live in the store. Budgets stay module defaults on purpose: they are a
    // safety valve, not a per-deployment knob, so they are not on the wire.
    this.taskStore = new TaskStore({
      now: this.now,
      onChange: (change) => this.#onTaskChange(change)
    });
    // Alerts raised by recovery (downgrade detected, WAL truncated) ride the
    // setup().alerts array that Main already reads.
    this.stateAlerts = [];
    // v5 durability. Absent for the many callers that run without a state path:
    // then every append is a no-op and nothing is fail-closed.
    this.stateStore = statePath
      ? new StateStore({
          statePath,
          now: this.now,
          config: persistence,
          snapshotProvider: () => this.stateSnapshot(),
          onAlert: (alert) => this.recordStateAlert(alert),
          onError: (error) => {
            this.persistError = error?.message ?? String(error);
          }
        })
      : null;
    this.artifactStore = artifactStore ?? new ArtifactStore({
      root: artifactRoot,
      maxFileBytes: maxArtifactBytes,
      maxTotalBytes: maxArtifactTotalBytes
    });
    this.resourceLimits = {
      maxEvents,
      maxTextBytes,
      maxInlineResultBytes,
      maxArtifactBytes,
      maxArtifactTotalBytes,
      maxTerminalsPerSession,
      maxPendingRequestsPerSession,
      maxFrameBytes
    };
    this.lifecycle = {
      gcIntervalMs, idleUnloadMs, orphanGraceMs, resultRetentionMs, inboxRetentionMs,
      sessionRetentionMs, taskRetentionMs
    };
    this.metrics = {
      startedAt: new Date(this.now()).toISOString(),
      pollResponses: 0,
      pollBytes: 0,
      eventBytes: 0,
      resultBytes: 0,
      eventsByType: {}
    };
    this.maintenanceRunning = null;
    this.store = new SessionStore({
      maxEvents,
      maxTextBytes,
      maxInlineResultBytes,
      artifactStore: this.artifactStore,
      onChange: (_session, event) => {
        if (!event || DURABLE_EVENT_TYPES.has(event.type)) this.schedulePersist();
      },
      onEvent: (session, event) => this.publishEvent(session, event)
    });
    this.gcTimer = gcIntervalMs > 0
      ? setInterval(() => void this.runMaintenance().catch((error) => {
          this.persistError = error?.message ?? String(error);
        }), gcIntervalMs)
      : null;
    this.gcTimer?.unref();
  }

  async init() {
    this.agentUpdateManager?.start();
    if (!this.statePath) return;
    // open() repairs, replays and reports. It returns the same {sessions, tasks,
    // inbox} shape the v4 reader produced, so the restart transformations below
    // are untouched — and it throws rather than ever hand back a state it could
    // not read, because a silent empty start is how durable handles disappear.
    const loaded = this.stateStore.open();
    for (const record of loaded.sessions) {
      this.store.create({
        ...record,
        status: record.status === "closed" ? "closed" : "disconnected",
        client: null,
        waiters: new Set(),
        events: [],
        resultText: "",
        thoughtText: "",
        // No worker survived the restart, so no session owns a live handle. The
        // task's own restart conversion below is what the caller observes.
        activeTaskId: null,
        _ownerActivityPersistedAt: Date.parse(record.lastOwnerActivityAt ?? record.updatedAt)
      });
    }
    // The store owns the restart conversion (in-flight -> failed with the
    // legacy message) and drops handles whose TTL elapsed while we were down.
    // Replay has already folded the WAL into these records as plain data.
    this.taskStore.recover(loaded.tasks);
    for (const record of loaded.inbox) {
      const item = { ...record };
      // An ACP permission request is tied to the old worker process. It cannot
      // be answered after a daemon restart, but must remain visible to Main.
      if (item.status === "pending") {
        item.status = "interrupted";
        item.resolution = "Gateway restarted before this worker request was answered";
        item.resolvedAt = new Date(this.now()).toISOString();
      }
      this.inbox.set(item.inboxId, item);
    }
    // Rotate immediately: the snapshot this writes is the first one that contains
    // the restart transformations, and it retires the log that produced them, so
    // a second crash replays nothing instead of re-deriving them.
    this.#rotateState();
    await this.runMaintenance();
  }

  attachRoot(rootId) {
    requireString(rootId, "rootId");
    const presence = this.rootPresence.get(rootId) ?? { connections: 0, disconnectedAt: null };
    const reconnecting = presence.connections === 0 && presence.disconnectedAt != null;
    presence.connections += 1;
    presence.disconnectedAt = null;
    this.rootPresence.set(rootId, presence);
    if (reconnecting) {
      for (const session of this.store.list().filter((item) => item.ownerRootId === rootId)) {
        this.touchSessionOwner(session);
      }
    }
  }

  detachRoot(rootId) {
    const presence = this.rootPresence.get(rootId);
    if (!presence) return;
    presence.connections = Math.max(0, presence.connections - 1);
    if (presence.connections > 0) return;
    const disconnectedAt = new Date(this.now()).toISOString();
    presence.disconnectedAt = disconnectedAt;
    for (const session of this.store.list().filter((item) => item.ownerRootId === rootId && !item.pinned)) {
      session.orphanedAt ??= disconnectedAt;
    }
    this.schedulePersist();
  }

  // The mailbox is created on first use: sessions built straight through the
  // store (restore-from-disk, tests) must not need to know about it.
  #queueFor(session) {
    session._queue ??= new SessionQueue({ id: session.id });
    return session._queue;
  }

  // Single choke point for session.status. Returns false when the move was
  // refused, so callers can skip the bookkeeping that belonged to it.
  #setStatus(session, next, reason) {
    const from = session.status;
    if (from === next) return true;
    if (STATUS_TRANSITIONS[from]?.has(next)) {
      session.status = next;
      return true;
    }
    // A fire-and-forget finalizer that lost the race stays silent: the session
    // is closed or already gone, which is exactly the outcome it wanted.
    if (from === "closed" || !this.store.get(session.id)) return false;
    // A notified cancel outranks a normal turn end, and a late worker request
    // must not pull it back into an input wait.
    if (from === "cancelling") {
      if (next === "idle") {
        session.status = "cancelled";
        return true;
      }
      if (next === "waiting_permission" || next === "waiting_input") return false;
    }
    session._illegalTransitions = (session._illegalTransitions ?? 0) + 1;
    this.illegalTransitions += 1;
    if (process.env.ACP_GATEWAY_STRICT_FSM) {
      throw new Error(`Illegal session status transition ${from} -> ${next} (${reason})`);
    }
    return false;
  }

  // Claims the current turn for the caller that is finalizing it. Every
  // finalizer seals, so the terminal callback that arrives later is a no-op.
  #sealTurn(session) {
    if (session.turnId == null || session.turnSeal === session.turnId) return false;
    session.turnSeal = session.turnId;
    return true;
  }

  // True while a turn is still this session's outstanding work. Anything that
  // mirrors turn state back onto the record has to ask first, or a finalized
  // turn gets walked back into an active status nobody will ever leave.
  #turnLive(session) {
    return session.turnId != null
      && session.turnSeal !== session.turnId
      && !CLOSED_STATUSES.has(session.status)
      && this.store.get(session.id) != null;
  }

  // A synchronous intent reservation. It closes the window between admitting a
  // command and the command actually changing status, so a second prompt is
  // rejected in the caller's first tick instead of minting a rival turn.
  #reserve(session, intent) {
    session._reserved = intent;
    return session;
  }

  #release(session, intent) {
    if (session._reserved === intent) session._reserved = null;
  }

  async call(method, args = {}, context = {}) {
    this.touchOwnerActivity(args, context);
    const handlers = {
      setup: () => this.setup(args),
      session_open: () => this.sessionOpen(args, context),
      session_restore: () => this.sessionRestore(args, context),
      config: () => this.sessionConfig(args, context),
      prompt: () => this.sessionPrompt(args, context),
      poll: () => this.sessionPoll(args, context),
      permission: () => this.sessionPermission(args, context),
      answer: () => this.sessionAnswer(args, context),
      cancel: () => this.sessionCancel(args, context),
      session: () => this.sessionManage(args, context),
      task_prompt: () => this.taskPrompt(args, context),
      task_get: () => this.taskGet(args, context),
      task_list: () => this.taskList(args, context),
      task_result: () => this.taskResult(args, context),
      task_cancel: () => this.taskCancel(args, context),
      inbox: () => this.inboxManage(args, context)
    };
    const handler = handlers[method];
    if (!handler) {
      throw new GatewayError(ERROR_CODES.UNKNOWN_METHOD, `Unknown gateway method: ${method}`, { method });
    }
    return handler();
  }

  subscribe(args = {}, context = {}, emit) {
    if (typeof emit !== "function") {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "Subscription emitter is required");
    }
    const rootId = requireRoot(context);
    const requested = args.sessionIds;
    if (requested != null && !Array.isArray(requested)) {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "sessionIds must be an array");
    }
    const sessions = requested == null
      ? this.store.list().filter((session) => session.ownerRootId === rootId)
      : requested.map((id) => requireOwnedSession(this.requireSession(id), context));
    for (const session of sessions) this.touchSessionOwner(session);
    const cursors = args.cursors ?? {};
    if (typeof cursors !== "object" || Array.isArray(cursors)) {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "cursors must be an object");
    }
    const subscriptionId = `sub-${randomUUID()}`;
    const subscription = {
      subscriptionId,
      rootId,
      watchAll: requested == null,
      sessionIds: new Set(sessions.map((session) => session.id)),
      includeThoughts: args.includeThoughts === true,
      // Same default as poll: tool events are opt-in on every delivery channel.
      includeToolEvents: args.includeToolEvents === true,
      emit
    };
    this.subscriptions.set(subscriptionId, subscription);
    const events = [];
    const cursorTruncated = {};
    for (const session of sessions) {
      const cursor = requireNonNegativeNumber(cursors[session.id], `cursors.${session.id}`, 0);
      const firstIndex = session.events[0]?.i ?? session.eventSequence;
      cursorTruncated[session.id] = cursor < firstIndex;
      for (const event of session.events.filter((item) => item.i >= Math.max(cursor, firstIndex))) {
        if (shouldDeliverEvent(subscription, event)) events.push(publicEvent(session, event));
      }
    }
    return {
      subscriptionId,
      sessions: sessions.map(publicSession),
      events,
      cursorTruncated
    };
  }

  unsubscribe(subscriptionId, context = {}) {
    requireString(subscriptionId, "subscriptionId");
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return { ok: true, removed: false };
    if (subscription.rootId !== requireRoot(context)) {
      throw new GatewayError(ERROR_CODES.SUBSCRIPTION_NOT_OWNED, "Subscription belongs to another Main");
    }
    this.subscriptions.delete(subscriptionId);
    return { ok: true, removed: true };
  }

  removeSubscriptions(subscriptionIds) {
    for (const subscriptionId of subscriptionIds) this.subscriptions.delete(subscriptionId);
  }

  publishEvent(session, event) {
    for (const subscription of this.subscriptions.values()) {
      const watchesSession = subscription.sessionIds.has(session.id)
        || (subscription.watchAll && subscription.rootId === session.ownerRootId);
      if (!watchesSession || !shouldDeliverEvent(subscription, event)) continue;
      try {
        subscription.emit(publicEvent(session, event));
      } catch {
        this.subscriptions.delete(subscription.subscriptionId);
      }
    }
  }

  async guide() {
    return {
      ok: true,
      role: "worker",
      controlAvailable: false,
      rule: "Only the interactive Main agent may create, resume, prompt, or close ACP sessions.",
      providers: await detectProviders()
    };
  }

  async setup({ provider, refreshAgentUpdates = false } = {}) {
    if (refreshAgentUpdates && this.agentUpdateManager) await this.agentUpdateManager.refresh();
    const detected = await detectProviders();
    const names = provider ? [requireProvider(provider)] : [];
    const agentUpdates = this.agentUpdateManager?.snapshot() ?? null;
    return {
      ok: true,
      gatewayVersion: GATEWAY_VERSION,
      gatewayApiVersion: GATEWAY_API_VERSION,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      // healthy/error keep their names and meaning (AgenLynk branches on them);
      // everything else here is additive diagnostics.
      persistence: {
        healthy: this.persistError == null,
        error: this.persistError,
        ...(this.stateStore?.status() ?? {
          stateSchemaVersion: STATE_SCHEMA_VERSION,
          mode: "disabled",
          walSeq: 0,
          walBytes: 0,
          snapshotEpoch: 0,
          fsyncCount: 0,
          lastRecovery: null
        })
      },
      lifecycle: {
        ...this.lifecycle,
        liveSessions: this.store.list().filter((session) => session.client?.alive).length
      },
      resourceLimits: this.resourceLimits,
      metrics: { ...this.metrics, eventsByType: { ...this.metrics.eventsByType } },
      agentUpdates,
      gatewayUpdate: agentUpdates?.gatewaySource ?? null,
      alerts: [...(agentUpdates?.alerts ?? []), ...this.stateAlerts],
      detected,
      providers: provider ? await Promise.all(
        names.map(async (name) => {
          try {
            const client = await this.getClient(name);
            return {
              provider: name,
              ok: true,
              alive: client.alive,
              protocolVersion: client.initResult?.protocolVersion,
              capabilities: client.initResult?.agentCapabilities ?? {},
              model: currentModelId(client.initResult),
              command: client.config.command
            };
          } catch (error) {
            return { provider: name, ok: false, error: error?.message ?? String(error) };
          }
        })
      ) : detected.map((item) => ({
        provider: item.id,
        ok: item.agentInstalled && item.adapterInstalled,
        started: false
      }))
    };
  }

  async sessionOpen(args, context) {
    const provider = requireProvider(args.provider);
    const cwd = await requireDirectory(args.cwd);
    const requestedModel = optionalString(args.model, "model");
    const client = await this.getClient(provider, requestedModel);
    const permissionPolicy = requirePermissionPolicy(args.permissionPolicy ?? "ask");
    const mcpServers = sanitizeWorkerMcpServers(args.mcpServers ?? []);
    const created = await client.sessionNew({
      cwd,
      mcpServers,
      additionalDirectories: args.additionalDirectories ?? [],
      permissionPolicy
    });
    const configured = await this.configureSessionModel(client, created, requestedModel);
    return this.registerSession({
      args,
      provider,
      cwd,
      client,
      acpSessionId: created.sessionId,
      created: configured.response,
      model: configured.model,
      permissionPolicy,
      ownerRootId: requireRoot(context)
    });
  }

  async sessionRestore(args, context, existing = null) {
    const provider = requireProvider(args.provider ?? existing?.provider);
    const cwd = await requireDirectory(args.cwd ?? existing?.cwd);
    const acpSessionId = args.acpSessionId ?? existing?.acpSessionId;
    requireString(acpSessionId, "acpSessionId");
    const requestedModel = optionalString(args.model ?? existing?.model, "model");
    const client = await this.getClient(provider, requestedModel);
    const permissionPolicy = requirePermissionPolicy(
      args.permissionPolicy ?? existing?.permissionPolicy ?? "ask"
    );
    const method = restoreMethod(client.initResult, args.method ?? "auto");
    const restored = await client.sessionRestore({
      method: `session/${method}`,
      sessionId: acpSessionId,
      cwd,
      mcpServers: sanitizeWorkerMcpServers(args.mcpServers ?? existing?.mcpServers ?? []),
      additionalDirectories: args.additionalDirectories ?? existing?.additionalDirectories ?? [],
      permissionPolicy
    });
    const configured = await this.configureSessionModel(client, restored, requestedModel, acpSessionId);

    if (existing) {
      // The record can disappear while the ACP resume is in flight (close,
      // retention). Re-attaching here would revive a session Main was told is
      // gone, and leave a live ACP session nobody owns.
      if (!this.store.get(existing.id) || CLOSED_STATUSES.has(existing.status)) {
        client.clearSession(acpSessionId);
        throw new GatewayError(ERROR_CODES.SESSION_CLOSED, `Session ${existing.id} is closed`);
      }
      existing.client = client;
      this.#setStatus(existing, "idle", "session_restored");
      existing.error = null;
      existing.permissionPolicy = permissionPolicy;
      existing.model = configured.model;
      existing.capabilities = configured.response;
      if (args.pinned != null) existing.pinned = args.pinned === true;
      existing.orphanedAt = null;
      client.onSessionUpdate(acpSessionId, (update) => this.handleUpdate(existing, update));
      this.store.push(existing, { type: "session_restored", method });
      return { ok: true, ...publicSession(existing), capabilities: configured.response, restoredWith: method };
    }

    return this.registerSession({
      args,
      provider,
      cwd,
      client,
      acpSessionId,
      created: configured.response,
      model: configured.model,
      restoredWith: method,
      permissionPolicy,
      ownerRootId: requireRoot(context)
    });
  }

  registerSession(fields) {
    if (!fields.acpSessionId) {
      throw new GatewayError(ERROR_CODES.GATEWAY_ERROR, "ACP session operation returned no sessionId");
    }
    const duplicate = this.store
      .list()
      .find((item) => item.provider === fields.provider && item.acpSessionId === fields.acpSessionId);
    if (duplicate) {
      throw new GatewayError(
        ERROR_CODES.INVALID_ARGUMENT,
        `ACP session is already registered as ${duplicate.id}`,
        { sessionId: duplicate.id, acpSessionId: fields.acpSessionId }
      );
    }
    const session = this.store.create({
      provider: fields.provider,
      client: fields.client,
      acpSessionId: fields.acpSessionId,
      cwd: fields.cwd,
      title: fields.args.title ?? null,
      permissionPolicy: fields.permissionPolicy,
      model: fields.model ?? null,
      capabilities: fields.created ?? {},
      ownerRootId: fields.ownerRootId,
      mcpServers: sanitizeWorkerMcpServers(fields.args.mcpServers ?? []),
      additionalDirectories: fields.args.additionalDirectories ?? [],
      pinned: fields.args.pinned === true,
      lastOwnerActivityAt: new Date(this.now()).toISOString(),
      _ownerActivityPersistedAt: this.now()
    });
    fields.client.onSessionUpdate(fields.acpSessionId, (update) => this.handleUpdate(session, update));
    this.store.push(session, { type: "session_created" });
    // T1. Losing a registration costs an orphaned child process (a resource leak,
    // not a correctness failure), which is why session_open is not fail-closed.
    this.#appendSessionRegistered(session);
    return {
      ok: true,
      ...publicSession(session),
      capabilities: fields.created ?? {},
      restoredWith: fields.restoredWith
    };
  }

  // Runs inside a session command (R1): it must never touch the mailbox, or the
  // command holding the mailbox would wait on itself.
  ensureConnected(session, context) {
    requireOwnedSession(session, context);
    if (session.client?.alive && !RESTORE_REQUIRED_STATUSES.has(session.status)) return Promise.resolve(session);
    // One resume per session, mirroring the client-start dedupe: two callers
    // must never hand the same ACP session two session/resume requests.
    if (session._restoring) return session._restoring;
    const start = this.#restoreLocked(session, context).finally(() => {
      if (session._restoring === start) session._restoring = null;
    });
    session._restoring = start;
    return start;
  }

  async #restoreLocked(session, context) {
    this.#setStatus(session, "restoring", "session_restore_start");
    this.store.push(session, { type: "session_restore_start" });
    try {
      await this.sessionRestore({}, context, session);
      return session;
    } catch (error) {
      // The record can be gone (closed, retention) by the time the resume
      // fails. Reporting a restore failure on it would push an event for a
      // session Main has already been told is finished.
      if (this.store.get(session.id) && !CLOSED_STATUSES.has(session.status)) {
        this.#setStatus(session, "unavailable", "session_restore_failed");
        session.error = error?.message ?? String(error);
        this.store.push(session, { type: "session_restore_failed", text: session.error });
      }
      throw error;
    }
  }

  async configureSessionModel(client, response, requestedModel, sessionId = response.sessionId) {
    let configOptions = response.configOptions ?? [];
    let model = sessionModelId(configOptions) ?? currentModelId(client.initResult);
    if (requestedModel) {
      if (client.config.modelScope === "process") {
        model = currentModelId(client.initResult) ?? requestedModel;
      } else {
        const modelOption = findModelOption(configOptions);
        if (!modelOption) {
          throw new GatewayError(
            ERROR_CODES.INVALID_ARGUMENT,
            `ACP agent does not advertise a model config option; requested model=${requestedModel}`
          );
        }
        const changed = await client.setSessionConfigOption({
          sessionId,
          configId: modelOption.id,
          value: requestedModel
        });
        configOptions = changed.configOptions ?? configOptions;
        model = sessionModelId(configOptions) ?? requestedModel;
      }
    }
    return { model, response: { ...response, configOptions } };
  }

  async sessionConfig(args, context) {
    const session = requireOwnedSession(this.requireSession(args.sessionId), context);
    if (CLOSED_STATUSES.has(session.status)) {
      throw new GatewayError(ERROR_CODES.SESSION_CLOSED, `Session ${session.id} is closed`);
    }
    const action = args.action ?? "list";
    if (action !== "list" && action !== "set") {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Unknown config action: ${action}`);
    }
    if (action !== "set") {
      return this.#queueFor(session).run("config_list", () => this.#configLocked(session, args, context, action));
    }
    // A queued config set already owns the session: a prompt that arrives now
    // must be refused, not silently applied to a reconfigured worker.
    if (session._reserved || ACTIVE_STATUSES.has(session.status)) {
      throw new GatewayError(ERROR_CODES.SESSION_ACTIVE, `Session ${session.id} is still active`);
    }
    this.#reserve(session, "config");
    try {
      return await this.#queueFor(session).run("config_set", () => this.#configLocked(session, args, context, action));
    } finally {
      this.#release(session, "config");
    }
  }

  async #configLocked(session, args, context, action) {
    if (CLOSED_STATUSES.has(session.status) || !this.store.get(session.id)) {
      throw new GatewayError(ERROR_CODES.SESSION_CLOSED, `Session ${session.id} is closed`);
    }
    await this.ensureConnected(session, context);
    const configOptions = session.capabilities?.configOptions ?? [];
    if (action === "list") {
      return { ok: true, sessionId: session.id, configOptions };
    }

    requireString(args.configId, "configId");
    if (!Object.hasOwn(args, "value")) {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "value is required for config set");
    }
    const option = configOptions.find((item) => item?.id === args.configId);
    if (!option) {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Worker does not advertise config option: ${args.configId}`);
    }
    const value = validateSessionConfigValue(option, args.value);
    if (isModelOption(option) && session.client.config.modelScope === "process" && value !== session.model) {
      throw new GatewayError(
        ERROR_CODES.INVALID_ARGUMENT,
        `Provider ${session.provider} selects model per process; open a new session with model=${value}`
      );
    }
    const response = await session.client.setSessionConfigOption({
      sessionId: session.acpSessionId,
      configId: option.id,
      value,
      type: option.type === "boolean" ? "boolean" : null
    });
    const updatedOptions = Array.isArray(response?.configOptions) ? response.configOptions : configOptions;
    session.capabilities = { ...session.capabilities, configOptions: updatedOptions };
    if (isModelOption(option)) session.model = sessionModelId(updatedOptions) ?? String(value);
    this.store.push(session, {
      type: "config_changed",
      configId: option.id,
      category: option.category ?? null,
      value
    });
    return {
      ok: true,
      sessionId: session.id,
      changed: { configId: option.id, category: option.category ?? null, value },
      configOptions: updatedOptions
    };
  }

  // Admission runs in the caller's first tick, before any await: a rival prompt
  // has to be refused while this one is still only an intention, which is what
  // the reservation records. Every check here reuses its original error.
  #admitTurn(args, context) {
    const session = requireOwnedSession(this.requireSession(args.sessionId), context);
    if (session._reserved || ACTIVE_STATUSES.has(session.status)) {
      throw new GatewayError(ERROR_CODES.SESSION_ACTIVE, `Session ${session.id} is still active`);
    }
    if (CLOSED_STATUSES.has(session.status)) {
      throw new GatewayError(ERROR_CODES.SESSION_CLOSED, `Session ${session.id} is closed`);
    }
    if (typeof args.prompt !== "string" && !Array.isArray(args.prompt)) {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "prompt must be a string or ACP content array");
    }
    return this.#reserve(session, "prompt");
  }

  async sessionPrompt(args, context) {
    const session = this.#admitTurn(args, context);
    try {
      return await this.#queueFor(session).run("prompt", () => this.#promptLocked(session, args, context));
    } finally {
      // Always, including the synchronous-throw path that used to leave the
      // session permanently unpromptable.
      this.#release(session, "prompt");
    }
  }

  // Registers a turn and returns. It must never await the turn itself: that one
  // rule is what keeps the mailbox from being held for a whole worker turn.
  async #promptLocked(session, args, context) {
    if (CLOSED_STATUSES.has(session.status) || !this.store.get(session.id)) {
      throw new GatewayError(ERROR_CODES.SESSION_CLOSED, `Session ${session.id} is closed`);
    }
    await this.ensureConnected(session, context);
    const requestedModel = optionalString(args.model, "model");
    if (requestedModel && requestedModel !== session.model) {
      if (session.client.config.modelScope === "process") {
        throw new GatewayError(
          ERROR_CODES.INVALID_ARGUMENT,
          `Provider ${session.provider} selects model per process; open a new session with model=${requestedModel}`
        );
      }
      const configured = await this.configureSessionModel(
        session.client,
        session.capabilities ?? {},
        requestedModel,
        session.acpSessionId
      );
      session.model = configured.model;
      session.capabilities = configured.response;
      this.store.push(session, { type: "model_changed", model: session.model });
    }
    session.turnId = `turn-${randomUUID()}`;
    session.turnSeal = null;
    this.#setStatus(session, "running", "turn_start");
    session.stopReason = null;
    session.cancelRequested = false;
    session.error = null;
    session.resultText = "";
    session.thoughtText = "";
    // A new turn owns fresh transient state: retention timers keyed to the
    // previous turn must not clear or skip this one.
    session.completedAt = null;
    session.transientClearedAt = null;
    this.store.push(session, { type: "turn_start", turnId: session.turnId });
    // The token freezes which turn this callback may finalize; the ACP read
    // loop hands the outcome to the mailbox instead of applying it inline.
    const token = session.turnId;
    const queue = this.#queueFor(session);
    void session.client
      .sessionPrompt({ sessionId: session.acpSessionId, prompt: args.prompt })
      .then(
        (result) => queue.post("turn_end", () => this.#finishTurn(session, token, { result })),
        (error) => queue.post("turn_fail", () => this.#finishTurn(session, token, { error }))
      );
    return { ok: true, sessionId: session.id, turnId: session.turnId, status: session.status };
  }

  // The single terminal transition for a turn. Four guards, one per way the
  // turn can stop being this callback's business between request and reply.
  #finishTurn(session, token, outcome) {
    if (session.turnId !== token) return;
    if (session.turnSeal === token) return;
    if (CLOSED_STATUSES.has(session.status)) return;
    if (!this.store.get(session.id)) return;
    session.turnSeal = token;
    session.completedAt = new Date(this.now()).toISOString();
    if (outcome.error) {
      this.#setStatus(session, session.client?.alive ? "error" : "disconnected", "turn_failed");
      session.error = outcome.error?.message ?? String(outcome.error);
      this.store.finalizeResult(session);
      this.store.push(session, { type: "error", text: session.error });
      this.finishTaskForSession(session);
      return;
    }
    const stopReason = outcome.result?.stopReason;
    this.#setStatus(
      session,
      session.cancelRequested || stopReason === "cancelled" ? "cancelled" : "idle",
      "turn_end"
    );
    session.stopReason = session.cancelRequested ? "cancelled" : stopReason ?? "end_turn";
    session.cancelRequested = false;
    this.store.finalizeResult(session);
    this.store.push(session, { type: "turn_end", stopReason: session.stopReason });
    this.finishTaskForSession(session);
  }

  async taskPrompt(args, context) {
    const session = this.#admitTurn(args, context);
    // Everything past admission is inside the finally: a budget rejection must
    // release the reservation, or one refused task would leave the session
    // permanently unpromptable.
    try {
      // Fail closed, and only here: a Task handle is a promise that the outcome
      // will still be collectable after a restart, which is a promise an unhealthy
      // store cannot keep. session_open stays open by design (§8.16).
      this.#requireHealthyPersistence();
      const task = this.#storeCall(() => this.taskStore.create({
        sessionId: session.id,
        ownerRootId: requireRoot(context),
        ttl: args.ttl,
        pollInterval: args.pollInterval
      }));
      // The barrier is BEFORE the ACP turn starts. After it, a crash can only
      // lose work that has a durable handle; before it, only work that was never
      // started. The other order manufactures the opposite phantom: real worker
      // activity with no handle to report or cancel it.
      try {
        this.stateStore?.appendDurable(WAL_TYPES.TASK_CREATED, task.taskId, task);
        if (this.stateStore) this.persistError = null;
      } catch (error) {
        // Compensate: the handle described work that will never start.
        this.taskStore.remove(task.taskId);
        this.persistError = error?.message ?? String(error);
        throw new GatewayError(
          ERROR_CODES.PERSISTENCE_UNHEALTHY,
          `Gateway could not durably record this Task before starting it: ${this.persistError}`
        );
      }
      crashAfter("task_create_durable");
      session.activeTaskId = task.taskId;
      try {
        // One command covers starting the turn and recording the handle. Split
        // across two, the turn could already have finished and this bookkeeping
        // would drag a terminal task back to "working", so its result could never
        // be collected. The store enforces that itself now (terminal is final),
        // but the single command is still what keeps turnId and status agreeing.
        return await this.#queueFor(session).run("task_prompt", async () => {
          const started = await this.#promptLocked(session, args, context);
          // The handle can already be gone: ttl=0 expires on the first read after
          // create. The turn is running either way, so the ack reports the handle
          // that was minted instead of failing work that has already started.
          if (!this.taskStore.find(task.taskId)) {
            return this.publicTask({ ...task, turnId: started.turnId });
          }
          this.taskStore.attachTurn(task.taskId, started.turnId);
          const running = this.taskStore.transition(task.taskId, "working", "Prompt running");
          // T1: the turn id is provenance the handle should keep across a restart,
          // but no caller is holding a response for it.
          this.#appendTaskStatus(running);
          return this.publicTask(running);
        });
      } catch (error) {
        if (session.activeTaskId === task.taskId) session.activeTaskId = null;
        this.taskStore.remove(task.taskId);
        throw error;
      }
    } finally {
      this.#release(session, "prompt");
    }
  }

  async taskGet(args, context) {
    const ownerRootId = requireRoot(context);
    return this.publicTask(this.#storeCall(() => this.taskStore.get(args.taskId, { ownerRootId })));
  }

  async taskList(args = {}, context = {}) {
    const ownerRootId = requireRoot(context);
    const paged = args?.cursor != null || args?.limit != null || args?.status != null;
    if (paged) {
      const page = this.#storeCall(() => this.taskStore.listPage({
        ownerRootId,
        cursor: args.cursor ?? null,
        limit: args.limit,
        status: args.status
      }));
      return { tasks: page.tasks.map((task) => this.publicTask(task)), nextCursor: page.nextCursor };
    }
    // No arguments keeps the 1.3.2 contract exactly: the full array for this
    // root, and no nextCursor key at all (AgenLynk's monitor reads it unpaged).
    // Draining the keyset pages leaves ONE ordering and filtering implementation
    // instead of a second full-scan path that could disagree with the paged one.
    const tasks = [];
    let cursor = null;
    do {
      const page = this.#storeCall(() => this.taskStore.listPage({ ownerRootId, cursor, limit: 200 }));
      for (const task of page.tasks) tasks.push(this.publicTask(task));
      cursor = page.nextCursor;
    } while (cursor);
    return { tasks };
  }

  async taskResult(args, context) {
    const ownerRootId = requireRoot(context);
    const task = await this.#storeCallAsync(() => this.taskStore.waitForTerminal(args.taskId, {
      ownerRootId,
      timeoutMs: args.waitMs ?? 120_000,
      signal: context?.signal
    }));
    // The store hands back the stored payload as-is, possibly null, so it never
    // invents an envelope. The legacy fallback is the caller's, and it stays
    // here: agent_acp_run reuses this method, not a second copy.
    return this.#storeCall(() => this.taskStore.result(args.taskId, { ownerRootId }))
      ?? { ok: false, error: task.statusMessage ?? "Task completed without a result" };
  }

  async taskCancel(args, context) {
    const ownerRootId = requireRoot(context);
    const task = this.#storeCall(() => this.taskStore.get(args.taskId, { ownerRootId }));
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Cannot cancel task in terminal status: ${task.status}`);
    }
    await this.sessionCancel({ sessionId: task.sessionId }, context);
    const session = this.store.get(task.sessionId);
    const result = {
      ok: true,
      sessionId: task.sessionId,
      turnId: task.turnId,
      status: "cancelled",
      result: {
        text: session?.resultFinalText ?? session?.resultText ?? "",
        transcriptBytes: Buffer.byteLength(session?.resultText ?? ""),
        artifact: session?.resultArtifact ?? null,
        ...(session?.resultFinalArtifact ? { textArtifact: session.resultFinalArtifact } : {}),
        stopReason: "cancelled"
      }
    };
    const cancelled = this.#commitTaskTerminal(session, task.taskId, "cancelled", "Task cancelled by Main", result);
    if (!cancelled) {
      throw new GatewayError(ERROR_CODES.UNKNOWN_TASK, `Unknown taskId: ${task.taskId}`);
    }
    if (cancelled && cancelled.status !== "cancelled" && cancelled.status !== "failed") {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Cannot cancel task in terminal status: ${cancelled.status}`);
    }
    if (session?.activeTaskId === task.taskId) session.activeTaskId = null;
    return this.publicTask(cancelled);
  }

  // TaskStore is dependency-free and raises plain Errors tagged with a code.
  // Every gateway-facing throw is re-raised as the GatewayError the wire envelope
  // and Main-side branching have always seen, with the message unchanged.
  #storeCall(operation) {
    try {
      return operation();
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      const code = typeof error?.code === "string" && ERROR_CODES[error.code]
        ? ERROR_CODES[error.code]
        : ERROR_CODES.GATEWAY_ERROR;
      throw new GatewayError(code, error?.message ?? String(error));
    }
  }

  async #storeCallAsync(operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      const code = typeof error?.code === "string" && ERROR_CODES[error.code]
        ? ERROR_CODES[error.code]
        : ERROR_CODES.GATEWAY_ERROR;
      throw new GatewayError(code, error?.message ?? String(error));
    }
  }

  inboxManage(args, context) {
    const rootId = requireRoot(context);
    const action = args.action ?? "list";
    if (action === "list") {
      const status = args.status;
      return {
        ok: true,
        items: [...this.inbox.values()]
          .filter((item) => item.ownerRootId === rootId && (!status || item.status === status))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map(publicInboxItem)
      };
    }
    if (action === "get") {
      requireString(args.inboxId, "inboxId");
      const item = this.inbox.get(args.inboxId);
      if (!item) throw new GatewayError(ERROR_CODES.UNKNOWN_INBOX, `Unknown inboxId: ${args.inboxId}`);
      if (item.ownerRootId !== rootId) {
        throw new GatewayError(ERROR_CODES.NOT_INBOX_OWNER, "Inbox item belongs to another Main");
      }
      return { ok: true, item: publicInboxItem(item) };
    }
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Unknown inbox action: ${action}`);
  }

  async sessionPoll(args, context) {
    const session = requireOwnedSession(this.requireSession(args.sessionId), context);
    const cursor = requireNonNegativeNumber(args.cursor, "cursor", 0);
    const waitMs = Math.min(120_000, requireNonNegativeNumber(args.waitMs, "waitMs", 0));
    const maxEvents = Math.min(1000, Math.max(1, requireNonNegativeNumber(args.maxEvents, "maxEvents", 200)));
    const toCursor = args.toCursor == null ? Infinity : requireNonNegativeNumber(args.toCursor, "toCursor");
    const matchesEventType = compileEventTypes(args.eventTypes);
    const firstIndex = session.events[0]?.i ?? session.eventSequence;
    const effectiveCursor = Math.max(cursor, firstIndex);
    const deliverable = (event) => {
      if (event.i < effectiveCursor || event.i >= toCursor) return false;
      if (matchesEventType) return matchesEventType(event.type);
      if (DEFAULT_POLL_EVENT_TYPES.has(event.type)) return true;
      if (args.includeThoughts === true && event.type === "agent_thought_chunk") return true;
      if (args.includeToolEvents === true && event.type.startsWith("tool_call")) return true;
      return false;
    };
    // A bounded window is a retrospective inspection read; only open-ended
    // polls wait, and only for an event the caller would actually receive.
    if (waitMs && toCursor === Infinity && ACTIVE_STATUSES.has(session.status)
      && !session.events.some(deliverable)) {
      const statusAtWait = session.status;
      await this.store.wait(session, waitMs, () =>
        session.status !== statusAtWait || session.events.some(deliverable));
    }
    // maxEvents counts deliverable events; the cursor still advances over the
    // filtered-out ones in between so sparse type reads do not return empty
    // page after empty page.
    const ordered = session.events.filter((event) => event.i >= effectiveCursor && event.i < toCursor);
    const events = [];
    let consumed = 0;
    for (const event of ordered) {
      consumed += 1;
      if (deliverable(event)) {
        events.push(event);
        if (events.length >= maxEvents) break;
      }
    }
    const window = ordered.slice(0, consumed);
    // The result buffer is cumulative; re-sending it on every poll of a running
    // turn multiplies the caller's context cost, so it is opt-in until the turn ends.
    const active = ACTIVE_STATUSES.has(session.status);
    const includeResult = args.includeResult === true || (args.includeResult !== false && !active);
    const response = {
      ok: true,
      ...publicSession(session),
      nextCursor: window.length ? window.at(-1).i + 1 : effectiveCursor,
      cursorTruncated: cursor < firstIndex,
      events,
      // The cursor advances over filtered-out events too; this says how many,
      // so an empty poll with a moving cursor is legible.
      filteredCount: window.length - events.length,
      ...(!includeResult ? {} : {
        result: {
          // After the turn ends, text carries only the final message segment;
          // the full narrated transcript stays readable via session get.
          text: active ? session.resultText : session.resultFinalText ?? session.resultText,
          transcriptBytes: Buffer.byteLength(session.resultText),
          artifact: session.resultArtifact ?? null,
          ...(session.resultFinalArtifact ? { textArtifact: session.resultFinalArtifact } : {}),
          thought: args.includeThoughts === true ? session.thoughtText : undefined,
          stopReason: session.stopReason,
          ...(args.includeInspection === true ? (() => {
            const snapshot = this.store.inspectionSnapshot(session);
            return { inspection: snapshot.segments, inspectionDropped: snapshot.dropped };
          })() : {})
        }
      })
    };
    this.recordPollMetrics(response);
    return response;
  }

  recordPollMetrics(response) {
    const metrics = this.metrics;
    metrics.pollResponses += 1;
    metrics.pollBytes += Buffer.byteLength(JSON.stringify(response));
    if (response.result) metrics.resultBytes += Buffer.byteLength(JSON.stringify(response.result));
    if (response.events.length) {
      metrics.eventBytes += Buffer.byteLength(JSON.stringify(response.events));
      for (const event of response.events) {
        metrics.eventsByType[event.type] = (metrics.eventsByType[event.type] ?? 0) + 1;
      }
    }
  }

  async sessionPermission(args, context) {
    const session = requireOwnedSession(this.requireSession(args.sessionId), context);
    if (session.status !== "waiting_permission") {
      throw new GatewayError(ERROR_CODES.SESSION_NOT_WAITING, "Session is not waiting for permission");
    }
    return this.#queueFor(session).run("permission", () => this.#permissionLocked(session, args));
  }

  async #permissionLocked(session, args) {
    if (CLOSED_STATUSES.has(session.status) || !this.store.get(session.id)) {
      throw new GatewayError(ERROR_CODES.SESSION_CLOSED, `Session ${session.id} is closed`);
    }
    await session.client.respondPermission(Number(args.requestId), args.optionId ?? null, session.acpSessionId);
    this.store.push(session, {
      type: "permission_response",
      requestId: Number(args.requestId),
      optionId: args.optionId ?? null
    });
    this.resolveInbox(session, Number(args.requestId), "answered", "Main sent a permission response");
    this.syncSessionInputState(session);
    return { ok: true, sessionId: session.id, status: session.status };
  }

  async sessionAnswer(args, context) {
    const session = requireOwnedSession(this.requireSession(args.sessionId), context);
    if (session.status !== "waiting_input") {
      throw new GatewayError(ERROR_CODES.SESSION_NOT_WAITING, "Session is not waiting for input");
    }
    return this.#queueFor(session).run("answer", () => this.#answerLocked(session, args));
  }

  #answerLocked(session, args) {
    if (CLOSED_STATUSES.has(session.status) || !this.store.get(session.id)) {
      throw new GatewayError(ERROR_CODES.SESSION_CLOSED, `Session ${session.id} is closed`);
    }
    const requestId = Number(args.requestId);
    const action = args.action ?? "accept";
    const response = action === "accept"
      ? { action, ...(args.content == null ? {} : { content: args.content }) }
      : { action };
    session.client.respondElicitation(requestId, response, session.acpSessionId);
    this.store.push(session, { type: "elicitation_response", requestId, action });
    this.resolveInbox(session, requestId, "answered", `Main sent an elicitation ${action} response`);
    this.syncSessionInputState(session);
    return { ok: true, sessionId: session.id, status: session.status };
  }

  async sessionCancel(args, context) {
    const session = requireOwnedSession(this.requireSession(args.sessionId), context);
    return this.#queueFor(session).run("cancel", () => this.#cancelLocked(session));
  }

  #cancelLocked(session) {
    // Only an unsealed turn on a live worker can be cancelled. Asking a
    // restoring or already-finalized session to cancel used to raise a bare
    // TypeError and leave cancelRequested set, which pre-cancelled the next turn.
    const cancellable = this.#turnLive(session)
      && ACTIVE_STATUSES.has(session.status)
      && session.client?.alive === true;
    if (!cancellable) {
      this.schedulePersist();
      return { ok: true, ...publicSession(session) };
    }
    // Inside the active branch: a cancel that decides to do nothing must not
    // still interrupt Main's outstanding worker requests.
    this.interruptSessionInbox(session, "Main cancelled the worker session");
    session.cancelRequested = true;
    session.client?.cancelSession(session.acpSessionId);
    this.#setStatus(session, "cancelling", "cancel_requested");
    this.store.push(session, { type: "cancel_requested" });
    this.updateTaskForSession(session, "working", "Cancellation requested");
    return { ok: true, ...publicSession(session) };
  }

  async sessionManage(args, context) {
    const root = requireRoot(context);
    if (args.action === "list") {
      return {
        ok: true,
        sessions: this.store.list().filter((item) => item.ownerRootId === root).map(publicSession)
      };
    }
    const session = requireOwnedSession(this.requireSession(args.sessionId), context);
    if (args.action === "get") {
      return {
        ok: true,
        ...publicSession(session),
        // The narrated transcript can be up to maxTextBytes; hand it out only
        // when the caller explicitly asks for it.
        ...(args.includeTranscript === true ? { resultText: session.resultText } : {}),
        transcriptBytes: Buffer.byteLength(session.resultText),
        finalResultText: session.resultFinalText ?? null,
        // Raw event dumps drop the unbounded data field; the capped text
        // preview and dataArtifact pointers stay.
        events: args.includeEvents ? session.events.map(({ data, ...rest }) => rest) : undefined
      };
    }
    if (args.action === "close") {
      await this.closeSession(session);
      return { ok: true, closed: session.id };
    }
    if (args.action === "pin" || args.action === "unpin") {
      session.pinned = args.action === "pin";
      if (session.pinned) session.orphanedAt = null;
      session.updatedAt = new Date(this.now()).toISOString();
      this.schedulePersist();
      return { ok: true, ...publicSession(session) };
    }
    if (args.action === "clean") {
      const closed = [];
      for (const item of this.store.list().filter((candidate) => candidate.ownerRootId === root)) {
        // The list was a snapshot; by the time the n-th session is reached the
        // earlier awaits have let it start a turn or disappear entirely.
        if (!this.store.get(item.id) || ACTIVE_STATUSES.has(item.status) || item.status === "idle") continue;
        if (item._reserved) continue;
        if (await this.closeSession(item)) closed.push(item.id);
      }
      return { ok: true, closed };
    }
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Unknown action: ${args.action}`);
  }

  async closeSession(session) {
    return this.#queueFor(session).run("close", () => this.#closeLocked(session));
  }

  async #closeLocked(session) {
    // Idempotent: a second close must not interrupt the inbox again, push a
    // second session_closed, or delete a record someone else already replaced.
    if (CLOSED_STATUSES.has(session.status) || !this.store.get(session.id)) return false;
    const queue = this.#queueFor(session);
    // Seal before the await. A turn that completes underneath this close would
    // otherwise revive the session to idle and report a turn_end to Main after
    // it had already been told the session was gone.
    if (this.#sealTurn(session)) {
      // The sealed turn's reply will be dropped, so this close owes the task its
      // terminal state; otherwise the handle waits for a result that can never
      // arrive.
      session.completedAt = new Date(this.now()).toISOString();
      this.store.finalizeResult(session);
      this.updateTaskForSession(session, "cancelled", "Session closed before the turn completed", {
        ok: true,
        sessionId: session.id,
        turnId: session.turnId,
        status: "cancelled",
        result: {
          text: session.resultFinalText ?? session.resultText,
          transcriptBytes: Buffer.byteLength(session.resultText),
          artifact: session.resultArtifact ?? null,
          ...(session.resultFinalArtifact ? { textArtifact: session.resultFinalArtifact } : {}),
          stopReason: "cancelled"
        }
      });
    }
    this.interruptSessionInbox(session, "Main closed the worker session");
    const client = session.client;
    if (ACTIVE_STATUSES.has(session.status)) client?.cancelSession(session.acpSessionId);
    try {
      if (client?.alive && client.initResult?.agentCapabilities?.sessionCapabilities?.close) {
        await client.request("session/close", { sessionId: session.acpSessionId }, 30_000);
      }
    } catch {
      // The worker is allowed to die instead of answering. Closing is the
      // gateway's own bookkeeping, so it completes either way.
    }
    client?.clearSession(session.acpSessionId);
    this.#setStatus(session, "closed", "session_closed");
    session.client = null;
    this.store.push(session, { type: "session_closed" });
    this.store.delete(session.id);
    // Replay must not resurrect a session Main was told is gone, even when the
    // registration record is still in the log ahead of this one.
    this.stateStore?.append(WAL_TYPES.SESSION_CLOSED, session.id, {});
    // Anything still queued behind this close was written for a session that
    // now does not exist; waking it up would act on the deleted record.
    queue.closeWith(new GatewayError(ERROR_CODES.SESSION_CLOSED, `Session ${session.id} is closed`));
    return true;
  }

  syncSessionInputState(session) {
    const pending = session.client?.pendingSessionInput?.(session.acpSessionId)
      ?? { permissions: 0, elicitations: 0 };
    if (pending.permissions > 0) {
      if (this.#setStatus(session, "waiting_permission", "input_state_sync")) {
        this.updateTaskForSession(session, "input_required", "Waiting for Main permission");
      }
    } else if (pending.elicitations > 0) {
      if (this.#setStatus(session, "waiting_input", "input_state_sync")) {
        this.updateTaskForSession(session, "input_required", "Waiting for Main input");
      }
    } else if (this.#turnLive(session)) {
      // Mirroring "running" onto a turn that already ended is the one write here
      // that cannot be undone by anything: ACTIVE_STATUSES makes the session
      // skip every retention path and refuse every later prompt, forever.
      this.#setStatus(session, "running", "input_state_sync");
      this.updateTaskForSession(session, "working", "Main response sent");
    }
    // Status changed without an event push; pollers filtering out the
    // response events must still observe the transition.
    this.store.notifyWaiters(session);
  }

  handleUpdate(session, update) {
    const type = update.sessionUpdate ?? update.type ?? "unknown";
    if (ACTOR_UPDATE_TYPES.has(type)) {
      this.#queueFor(session).post(`update:${type}`, () => this.#handleUpdateLocked(session, update, type));
      return;
    }
    this.#handleUpdateLocked(session, update, type);
  }

  #handleUpdateLocked(session, update, type) {
    if (!this.store.get(session.id) || CLOSED_STATUSES.has(session.status)) return;
    // Usage is provider bookkeeping, not an actionable Main event. Some ACP
    // adapters stream it repeatedly, so retaining it would repeatedly wake
    // long polls and turn accounting chatter into frontdoor token usage.
    if (type === "usage_update") return;
    if (type === "agent_message_chunk") {
      const text = extractText(update);
      this.store.appendResultText(session, text);
      this.store.push(session, this.capTextEvent(session, type, text));
      return;
    }
    if (type === "agent_thought_chunk") {
      const text = extractText(update);
      this.store.appendThoughtText(session, text);
      this.store.push(session, this.capTextEvent(session, type, text));
      return;
    }
    if (SEGMENT_BOUNDARY_TYPES.has(type)) this.store.markSegmentBoundary(session, String(type));
    if (type === "permission_request") {
      // A cancel Main has already been notified of outranks a late worker
      // request: the event stays on the record, but it must not pull the session
      // back into an input wait or grow a new obligation Main cannot discharge.
      const admitted = this.#setStatus(session, "waiting_permission", type);
      const cappedToolCall = this.capStructuredField(session, `${type}-toolCall`, "toolCall", update.toolCall);
      // The durable record is created BEFORE the ring push that makes the request
      // pollable. Reversed (as it was through 1.3.2), a poll could hand Main a
      // requestId whose inbox row does not exist yet.
      if (admitted) this.createPermissionInbox(session, update);
      this.store.push(session, {
        type,
        requestId: update.requestId,
        ...cappedToolCall,
        // Main still needs enough of the tool call to answer the request.
        ...(cappedToolCall.toolCallTruncated ? {
          toolCall: {
            toolCallId: update.toolCall?.toolCallId,
            title: update.toolCall?.title,
            kind: update.toolCall?.kind
          }
        } : {}),
        options: update.options
      });
      if (!admitted) return;
      this.updateTaskForSession(session, "input_required", "Waiting for Main permission");
      return;
    }
    if (type === "elicitation_request") {
      const admitted = this.#setStatus(session, "waiting_input", type);
      if (admitted) this.createElicitationInbox(session, update);
      this.store.push(session, {
        type,
        requestId: update.requestId,
        mode: update.mode,
        message: typeof update.message === "string"
          ? utf8ByteHead(update.message, EVENT_PAYLOAD_CAP_BYTES)
          : update.message,
        ...this.capStructuredField(session, `${type}-schema`, "requestedSchema", update.requestedSchema),
        toolCallId: update.toolCallId
      });
      if (!admitted) return;
      this.updateTaskForSession(session, "input_required", "Waiting for Main input");
      return;
    }
    if (type === "config_option_update") {
      session.capabilities = { ...session.capabilities, configOptions: update.configOptions ?? [] };
      session.model = sessionModelId(update.configOptions) ?? session.model;
      this.store.push(session, { type, ...this.capStructuredField(session, type, "data", update) });
      return;
    }
    const serialized = JSON.stringify(update);
    if (Buffer.byteLength(serialized) <= EVENT_PAYLOAD_CAP_BYTES) {
      this.store.push(session, { type: String(type), text: serialized, data: update });
      return;
    }
    // Oversized payloads leave the delivery path but stay readable on disk.
    this.store.push(session, {
      type: String(type),
      text: utf8ByteHead(serialized, EVENT_PAYLOAD_CAP_BYTES),
      dataTruncated: true,
      dataArtifact: this.store.spillText(session.id, `event-${type}`, serialized)
    });
  }

  // Message and thought chunks are usually tiny, but nothing stops a worker
  // from putting megabytes into one chunk; the event copy is capped while the
  // transcript keeps the full text.
  capTextEvent(session, type, text) {
    const capped = utf8ByteHead(text, EVENT_PAYLOAD_CAP_BYTES);
    return capped === text ? { type, text } : { type, text: capped, textTruncated: true };
  }

  // Caps a structured event field by byte size; the durable inbox record keeps
  // the full object for answering, only the delivered event copy is bounded.
  capStructuredField(session, kind, field, value) {
    if (value == null) return { [field]: value };
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) <= EVENT_PAYLOAD_CAP_BYTES) return { [field]: value };
    return {
      [`${field}Truncated`]: true,
      dataArtifact: this.store.spillText(session.id, `event-${kind}`, serialized)
    };
  }

  async getClient(provider, model = null) {
    requireProvider(provider);
    const config = providerConfig(provider, { model });
    const clientKey = config.modelScope === "process" ? `${provider}:${config.expectedModel}` : provider;
    const existing = this.clients.get(clientKey);
    if (existing?.alive && existing.initResult) return existing;
    const starting = this.clientStarts.get(clientKey);
    if (starting) return starting;
    const start = this.#startClient(provider, clientKey, config);
    this.clientStarts.set(clientKey, start);
    try {
      return await start;
    } finally {
      if (this.clientStarts.get(clientKey) === start) this.clientStarts.delete(clientKey);
    }
  }

  async #startClient(provider, clientKey, config) {
    const options = {
      artifactStore: this.artifactStore,
      maxTerminalsPerSession: this.resourceLimits.maxTerminalsPerSession,
      maxPendingRequestsPerSession: this.resourceLimits.maxPendingRequestsPerSession,
      maxFrameBytes: this.resourceLimits.maxFrameBytes,
      onExit: (error) => {
        const text = error?.message ?? String(error);
        // Through each session's mailbox: a close already in flight has to finish
        // its own bookkeeping, otherwise the worker dying mid-close leaves the
        // record stuck at "disconnected" with its inbox already interrupted.
        for (const session of this.store.list().filter((item) => item.client === client)) {
          this.#queueFor(session).post("provider_exit", () => this.#providerExitLocked(session, text));
        }
        this.schedulePersist();
      }
    };
    const client = this.createClient
      ? this.createClient(provider, options, config)
      : new AcpClient(config, options);
    try {
      await client.start();
      const actualModel = currentModelId(client.initResult);
      if (config.expectedModel && actualModel !== config.expectedModel) {
        await client.stop();
        throw new GatewayError(
          ERROR_CODES.INVALID_ARGUMENT,
          `required model=${config.expectedModel}, actual=${actualModel || "<missing>"}`
        );
      }
      this.clients.set(clientKey, client);
      return client;
    } catch (error) {
      if (this.clients.get(clientKey) === client) this.clients.delete(clientKey);
      await client.stop().catch(() => {});
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(
        ERROR_CODES.GATEWAY_ERROR,
        `${provider} ACP setup failed: ${error?.message ?? error}; ${(client.stderr ?? "").slice(-1000)}`
      );
    }
  }

  requireSession(id) {
    requireString(id, "sessionId");
    const session = this.store.get(id);
    if (!session) {
      throw new GatewayError(ERROR_CODES.UNKNOWN_SESSION, `Unknown sessionId: ${id}`, { sessionId: id });
    }
    return session;
  }

  // Legacy alias for the hand-rolled Map that TaskStore replaced. A live view,
  // not a copy: the 1.3.2 characterization tests inject and inspect raw records
  // through it. Production paths go through this.taskStore.
  get tasks() {
    return this.taskStore.records;
  }

  publicTask(task) {
    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      turnId: task.turnId,
      status: task.status,
      ttl: task.ttl,
      pollInterval: task.pollInterval,
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      statusMessage: task.statusMessage
    };
  }

  updateTaskForSession(session, status, statusMessage, result = undefined) {
    const taskId = session.activeTaskId;
    // The handle can be gone (TTL sweep, session retention) by the time a turn
    // callback reports its outcome; that is a silent no-op, as it always was.
    const before = taskId ? this.taskStore.find(taskId) : null;
    if (!before) return;
    if (!TERMINAL_TASK_STATUSES.has(status)) {
      const task = this.taskStore.transition(taskId, status, statusMessage, result === undefined ? {} : { result });
      // The WAL's only unbounded producer is this path (input-state sync fires on
      // every worker request). A move that changed neither status nor message has
      // nothing durable to say, so it does not get a record.
      if (task.status !== before.status || task.statusMessage !== before.statusMessage) {
        this.#appendTaskStatus(task);
      }
      return;
    }
    this.#commitTaskTerminal(session, taskId, status, statusMessage, result);
    // Keyed off the requested status, not the resulting one: a terminal report
    // that lost to an earlier terminal writer still ends this session's claim.
    session.activeTaskId = null;
  }

  #commitTaskTerminal(session, taskId, status, statusMessage, result) {
    const before = this.taskStore.find(taskId);
    if (!before || TERMINAL_TASK_STATUSES.has(before.status)) return before;
    const lastUpdatedAt = new Date(this.now()).toISOString();
    const durable = result === undefined ? null : this.#durableResultRecord(session, taskId, result);
    let provisional = null;
    if (this.stateStore?.mode === "snapshot") {
      provisional = this.taskStore.transition(taskId, status, statusMessage, {
        lastUpdatedAt,
        ...(result === undefined ? {} : { result }),
        deferWaiters: true
      });
    }
    try {
      this.stateStore?.appendDurable(WAL_TYPES.TASK_RESULT_COMMITTED, taskId, {
        status,
        statusMessage,
        lastUpdatedAt,
        ...(durable ?? { result: null })
      });
      if (this.stateStore) this.persistError = null;
    } catch (error) {
      this.persistError = error?.message ?? String(error);
      // Never publish a success that failed its durability barrier. The created
      // record remains recoverable and restart will also make it failed; live
      // waiters receive this explicit failure instead of an unsafe result.
      const failureMessage = `Task result persistence failed: ${this.persistError}`;
      const failure = {
        ok: false,
        sessionId: session?.id ?? before.sessionId,
        turnId: before.turnId,
        status: "failed",
        error: failureMessage
      };
      if (provisional) {
        return this.taskStore.failDeferredTerminal(taskId, failureMessage, failure, { lastUpdatedAt });
      }
      return this.taskStore.transition(taskId, "failed", failureMessage, {
        lastUpdatedAt,
        result: failure
      });
    }
    if (provisional) {
      this.taskStore.flushWaiters(taskId);
      return provisional;
    }
    // Publish only after the WAL barrier. waitForTerminal therefore cannot
    // observe an outcome that a process restart can take back.
    return this.taskStore.transition(taskId, status, statusMessage, {
      lastUpdatedAt,
      ...(result === undefined ? {} : { result })
    });
  }

  // Builds the durable form of one terminal result. Oversized results go to an
  // artifact that is fsynced BEFORE the WAL record names it: the reverse order
  // leaves recovery holding a pointer to a file that never landed.
  #durableResultRecord(session, taskId, result) {
    if (!this.stateStore) return { result: result ?? null };
    const json = JSON.stringify(result ?? null);
    if (this.stateStore.planResult(json).inline) {
      this.stateStore.rememberResultRef(taskId, null);
      return { result: result ?? null };
    }
    const preview = utf8ByteHead(json, this.stateStore.inlineResultBytes);
    const writer = this.artifactStore.create(session?.id ?? taskId, "task-result");
    writer.append(json);
    writer.finalize(null, { sync: true });
    const metadata = writer.metadata();
    if (!metadata?.path || metadata.error || metadata.truncated) {
      // ArtifactWriter records I/O failures instead of throwing, so this check is
      // the only thing between a swallowed ENOSPC and a reference to nothing.
      this.persistError = `Task result artifact failed: ${metadata?.error ?? "result was truncated"}`;
      this.stateStore.rememberResultRef(taskId, null);
      return { preview };
    }
    this.artifactStore.syncDirectory();
    const ref = {
      path: metadata.path,
      bytes: metadata.bytes,
      sha256: createHash("sha256").update(json).digest("hex")
    };
    this.stateStore.rememberResultRef(taskId, ref);
    return { ref, preview };
  }

  #appendTaskStatus(task) {
    this.stateStore?.append(WAL_TYPES.TASK_STATUS_CHANGED, task.taskId, {
      status: task.status,
      statusMessage: task.statusMessage,
      lastUpdatedAt: task.lastUpdatedAt,
      turnId: task.turnId ?? null
    });
  }

  #onTaskChange(change) {
    this.schedulePersist();
    // Without a durable removal, a TTL or retention delete comes back on the next
    // replay: the create record is still in the log, and nothing contradicts it.
    if (change?.type === "removed" && change.taskId) {
      this.stateStore?.forgetTask(change.taskId);
      this.stateStore?.append(WAL_TYPES.TASK_REMOVED, change.taskId, {});
    }
  }

  #requireHealthyPersistence() {
    if (!this.stateStore || this.persistError == null) return;
    throw new GatewayError(
      ERROR_CODES.PERSISTENCE_UNHEALTHY,
      `Gateway persistence is unhealthy, so a durable Task handle cannot be issued: ${this.persistError}`
    );
  }

  #rotateState() {
    if (!this.stateStore) return null;
    try {
      return this.stateStore.rotate();
    } catch (error) {
      // A failed rotation is retried on every gc tick; it must not stop startup
      // or a maintenance pass.
      this.persistError = error?.message ?? String(error);
      return null;
    }
  }

  recordStateAlert(alert) {
    if (!alert) return;
    this.stateAlerts.push(alert);
    if (this.stateAlerts.length > 16) this.stateAlerts.splice(0, this.stateAlerts.length - 16);
  }

  stateSnapshot() {
    return {
      sessions: this.store.checkpoints(),
      // v5 keeps terminal handles and answered inbox items: a completed Task
      // surviving a restart until its TTL is the point of this release.
      tasks: this.taskStore.toPersistedRecords(),
      inbox: [...this.inbox.values()]
    };
  }

  finishTaskForSession(session) {
    if (!session.activeTaskId) return;
    const status = session.status === "cancelled" ? "cancelled" : session.status === "idle" ? "completed" : "failed";
    const message = session.error ?? session.stopReason ?? status;
    this.updateTaskForSession(session, status, message, {
      ok: status === "completed" || status === "cancelled",
      sessionId: session.id,
      turnId: session.turnId,
      status: session.status,
      result: {
        text: session.resultFinalText ?? session.resultText,
        transcriptBytes: Buffer.byteLength(session.resultText),
        artifact: session.resultArtifact ?? null,
        ...(session.resultFinalArtifact ? { textArtifact: session.resultFinalArtifact } : {}),
        stopReason: session.stopReason
      },
      ...(session.error ? { error: session.error } : {})
    });
  }

  createPermissionInbox(session, update) {
    const existing = [...this.inbox.values()].find((item) =>
      item.sessionId === session.id && item.turnId === session.turnId
      && item.requestId === update.requestId && item.type === "permission_request" && item.status === "pending"
    );
    if (existing?.status === "pending") return existing;
    const inboxId = `inbox-${randomUUID()}`;
    const now = new Date(this.now()).toISOString();
    const item = {
      inboxId,
      ownerRootId: session.ownerRootId,
      sessionId: session.id,
      turnId: session.turnId,
      type: "permission_request",
      status: "pending",
      createdAt: now,
      resolvedAt: null,
      resolution: null,
      requestId: update.requestId,
      toolCall: update.toolCall,
      options: update.options
    };
    this.inbox.set(inboxId, item);
    this.#appendInboxCreated(item);
    this.schedulePersist();
    return item;
  }

  createElicitationInbox(session, update) {
    const existing = [...this.inbox.values()].find((item) =>
      item.sessionId === session.id && item.turnId === session.turnId
      && item.requestId === update.requestId && item.type === "worker_question" && item.status === "pending"
    );
    if (existing?.status === "pending") return existing;
    const inboxId = `inbox-${randomUUID()}`;
    const item = {
      inboxId,
      ownerRootId: session.ownerRootId,
      sessionId: session.id,
      turnId: session.turnId,
      type: "worker_question",
      status: "pending",
      createdAt: new Date(this.now()).toISOString(),
      resolvedAt: null,
      resolution: null,
      requestId: update.requestId,
      mode: update.mode,
      message: update.message,
      requestedSchema: update.requestedSchema,
      toolCallId: update.toolCallId
    };
    this.inbox.set(inboxId, item);
    this.#appendInboxCreated(item);
    this.schedulePersist();
    return item;
  }

  resolveInbox(session, requestId, status, resolution) {
    const item = [...this.inbox.values()].find((candidate) =>
      candidate.sessionId === session.id && candidate.turnId === session.turnId
      && candidate.requestId === requestId && candidate.status === "pending"
    );
    if (!item || item.status !== "pending") return;
    item.status = status;
    item.resolution = resolution;
    item.resolvedAt = new Date(this.now()).toISOString();
    this.#appendInboxResolved(item);
    this.schedulePersist();
  }

  // T1 for the whole inbox: a permission request cannot be answered after a
  // restart anyway (its worker is gone and init rewrites it as interrupted), so
  // the durable copy is an audit record, not a promise. Making it T0 would put an
  // fsync on every tool call under an ask policy — the highest-frequency event
  // in the system — to protect a record nobody can act on.
  #appendInboxCreated(item) {
    this.stateStore?.append(WAL_TYPES.INBOX_CREATED, item.inboxId, item);
  }

  #appendInboxResolved(item) {
    this.stateStore?.append(WAL_TYPES.INBOX_RESOLVED, item.inboxId, {
      status: item.status,
      resolution: item.resolution,
      resolvedAt: item.resolvedAt
    });
  }

  #appendSessionRegistered(session) {
    if (!this.stateStore) return;
    const checkpoint = this.store.checkpoints().find((record) => record.id === session.id);
    if (checkpoint) this.stateStore.append(WAL_TYPES.SESSION_REGISTERED, session.id, checkpoint);
  }

  touchOwnerActivity(args, context) {
    const rootId = context?.rootId;
    if (!rootId) return;
    let session = typeof args?.sessionId === "string" ? this.store.get(args.sessionId) : null;
    if (!session && typeof args?.taskId === "string") {
      const task = this.taskStore.find(args.taskId);
      session = task ? this.store.get(task.sessionId) : null;
    }
    if (session?.ownerRootId === rootId) this.touchSessionOwner(session);
  }

  touchSessionOwner(session) {
    const now = this.now();
    const hadOrphanMarker = session.orphanedAt != null;
    session.lastOwnerActivityAt = new Date(now).toISOString();
    if (!session.orphanCancelRequested) session.orphanedAt = null;
    const persistEvery = Math.max(1_000, this.lifecycle.gcIntervalMs);
    if (hadOrphanMarker || !Number.isFinite(session._ownerActivityPersistedAt)
      || session._ownerActivityPersistedAt + persistEvery <= now) {
      session._ownerActivityPersistedAt = now;
      this.schedulePersist();
    }
  }

  runMaintenance(now = this.now()) {
    if (this.maintenanceRunning) return this.maintenanceRunning;
    this.maintenanceRunning = this.#runMaintenance(now).finally(() => {
      this.maintenanceRunning = null;
    });
    return this.maintenanceRunning;
  }

  async #runMaintenance(now) {
    // TTL now bounds a handle's whole lifetime, not just its retention: the sweep
    // commits an over-TTL active task as failed and then removes it.
    let changed = this.taskStore.expireSweep() > 0;
    // Byte retention, separate from the handle's ttl: a record that opted out of
    // expiry (ttl=null, legacy) would otherwise sit in the snapshot forever.
    for (const task of [...this.taskStore.records.values()]) {
      if (!isExpired(task.createdAt, this.lifecycle.taskRetentionMs, now)) continue;
      this.taskStore.remove(task.taskId);
      changed = true;
    }
    // Artifacts still referenced by a live session outlive the age-based
    // prune; they disappear when their session record does.
    const keepPaths = new Set();
    // A task result outlives its session: the handle answers until its TTL, and
    // the artifact behind an oversized result is the answer.
    for (const path of this.stateStore?.resultRefPaths() ?? []) keepPaths.add(path);
    for (const task of this.taskStore.records.values()) {
      const inner = task.result?.result;
      if (inner?.artifact?.path) keepPaths.add(inner.artifact.path);
      if (inner?.textArtifact?.path) keepPaths.add(inner.textArtifact.path);
    }
    for (const session of this.store.list()) {
      if (session.resultArtifact?.path) keepPaths.add(session.resultArtifact.path);
      if (session.resultFinalArtifact?.path) keepPaths.add(session.resultFinalArtifact.path);
      for (const segment of session.resultInspection ?? []) {
        if (segment.artifact?.path) keepPaths.add(segment.artifact.path);
      }
      for (const event of session.events) {
        if (event.dataArtifact?.path) keepPaths.add(event.dataArtifact.path);
      }
    }
    if (this.artifactStore.prune(this.lifecycle.resultRetentionMs, now, keepPaths) > 0) changed = true;

    for (const [id, item] of this.inbox) {
      if (item.status === "pending") continue;
      if (isExpired(item.resolvedAt ?? item.createdAt, this.lifecycle.inboxRetentionMs, now)) {
        this.inbox.delete(id);
        this.stateStore?.append(WAL_TYPES.INBOX_REMOVED, id, {});
        changed = true;
      }
    }

    for (const session of [...this.store.list()]) {
      const presence = this.rootPresence.get(session.ownerRootId);
      const orphanExpired = !session.pinned && session.orphanedAt
        && (presence?.connections ?? 0) === 0
        && isExpired(session.orphanedAt, this.lifecycle.orphanGraceMs, now);
      if (orphanExpired && ACTIVE_STATUSES.has(session.status) && !session.orphanCancelRequested) {
        try {
          if (await this.#queueFor(session).run("orphan_cancel", () => this.#orphanCancelLocked(session))) {
            changed = true;
          }
        } catch {
          // The session closed while this was queued; there is nothing to cancel.
        }
      }

      // Never clear a session whose current turn is still active: completedAt
      // belongs to the previous turn until the prompt path resets it.
      if (!session.pinned && !session.transientClearedAt && session.completedAt
        && !ACTIVE_STATUSES.has(session.status)
        && isExpired(session.completedAt, this.lifecycle.resultRetentionMs, now)) {
        session.resultText = "";
        session.thoughtText = "";
        session.resultArtifact = null;
        session.events = [];
        session.transientClearedAt = new Date(now).toISOString();
        changed = true;
      }

      const idleSince = session.completedAt ?? session.updatedAt;
      if (session.client?.alive && !ACTIVE_STATUSES.has(session.status) && !session.pinned
        && isExpired(idleSince, this.lifecycle.idleUnloadMs, now)) {
        changed = await this.unloadSession(session) || changed;
      }

      const recordSince = session.completedAt ?? session.updatedAt;
      if (!session.pinned && !ACTIVE_STATUSES.has(session.status) && this.#sessionQuiet(session)
        && isExpired(recordSince, this.lifecycle.sessionRetentionMs, now)) {
        // Whatever is queued for this session was written against a record that
        // is about to stop existing.
        session._queue?.closeWith(
          new GatewayError(ERROR_CODES.SESSION_CLOSED, `Session ${session.id} is closed`)
        );
        if (session.client) {
          session.client.clearSession(session.acpSessionId);
          session.client = null;
        }
        this.store.delete(session.id);
        this.stateStore?.append(WAL_TYPES.SESSION_CLOSED, session.id, {});
        // Task handles deliberately survive their session now: a Task's lifetime
        // is its own ttl and taskRetentionMs, not its session's retention. Deleting
        // them here made a completed handle unreadable long before its TTL.
        for (const [id, item] of this.inbox) {
          if (item.sessionId !== session.id) continue;
          this.inbox.delete(id);
          this.stateStore?.append(WAL_TYPES.INBOX_REMOVED, id, {});
        }
        changed = true;
      }
    }

    for (const [provider, client] of [...this.clients]) {
      if (this.store.list().some((session) => session.client === client)) continue;
      await client.stop().catch(() => {});
      if (this.clients.get(provider) === client) this.clients.delete(provider);
      changed = true;
    }

    // The gc tick carries the age-based rotation, and is also where a store that
    // went unhealthy on a failed rotation gets to try again.
    try {
      this.stateStore?.rotateIfNeeded();
    } catch (error) {
      this.persistError = error?.message ?? String(error);
    }
    if (changed) this.schedulePersist();
    return { ok: true, sessions: this.store.list().length, tasks: this.taskStore.size, inbox: this.inbox.size };
  }

  // Main is gone for good, so the gateway stops waiting on the worker and
  // finalizes the turn itself rather than leaving it mid-cancel. Being the
  // finalizer is the point: the real turn end lands later and must be a no-op,
  // or the result gets spilled and reported a second time.
  #orphanCancelLocked(session) {
    if (!this.store.get(session.id) || session.orphanCancelRequested) return false;
    const presence = this.rootPresence.get(session.ownerRootId);
    if (session.pinned || !session.orphanedAt || (presence?.connections ?? 0) > 0
      || !isExpired(session.orphanedAt, this.lifecycle.orphanGraceMs, this.now())) return false;
    if (!ACTIVE_STATUSES.has(session.status) || session.status === "restoring") return false;
    session.orphanCancelRequested = true;
    session.cancelRequested = true;
    session.client?.cancelSession(session.acpSessionId);
    this.store.push(session, { type: "orphan_cancel_requested" });
    this.interruptSessionInbox(session, "Main did not reconnect before the orphan grace period expired");
    this.#sealTurn(session);
    this.#setStatus(session, "cancelled", "orphan_cancelled");
    session.stopReason = "cancelled";
    session.completedAt = new Date(this.now()).toISOString();
    // Snapshot through the result model, not the raw transcript: the task
    // result must honor the final-segment split and the inline cap.
    this.store.finalizeResult(session);
    this.updateTaskForSession(session, "cancelled", "Cancelled after Main disconnect", {
      ok: true,
      sessionId: session.id,
      turnId: session.turnId,
      status: "cancelled",
      result: {
        text: session.resultFinalText ?? session.resultText,
        transcriptBytes: Buffer.byteLength(session.resultText),
        artifact: session.resultArtifact ?? null,
        ...(session.resultFinalArtifact ? { textArtifact: session.resultFinalArtifact } : {}),
        stopReason: "cancelled"
      }
    });
    this.store.push(session, { type: "turn_end", stopReason: "cancelled" });
    return true;
  }

  // The worker process is gone, so this is the last word on any turn it owed.
  #providerExitLocked(session, text) {
    if (CLOSED_STATUSES.has(session.status) || !this.store.get(session.id)) return;
    const finalizing = this.#sealTurn(session);
    session.client = null;
    this.#setStatus(session, "disconnected", "provider_disconnected");
    session.error = text;
    this.store.push(session, { type: "provider_disconnected", text: session.error });
    this.interruptSessionInbox(session, "ACP provider exited before this worker request was answered");
    if (finalizing) {
      session.completedAt = new Date(this.now()).toISOString();
      this.store.finalizeResult(session);
      this.finishTaskForSession(session);
    }
    this.schedulePersist();
  }

  interruptSessionInbox(session, resolution) {
    const resolvedAt = new Date(this.now()).toISOString();
    let interrupted = 0;
    for (const item of this.inbox.values()) {
      if (item.sessionId !== session.id || item.status !== "pending") continue;
      item.status = "interrupted";
      item.resolution = resolution;
      item.resolvedAt = resolvedAt;
      this.#appendInboxResolved(item);
      interrupted += 1;
    }
    // Cancelling a session that has no Task used to leave these marks in memory
    // only: no caller on that path touches the persistence hook.
    if (interrupted > 0) this.schedulePersist();
  }

  // No command owns this session right now, so background work may take its
  // client away without pulling it out from under a caller mid-flight.
  #sessionQuiet(session) {
    return !session._reserved && session._queue?.idle !== false;
  }

  async unloadSession(session) {
    const client = session.client;
    if (!client || !canRestoreSession(client.initResult)) return false;
    if (!this.#sessionQuiet(session)) return false;
    client.clearSession(session.acpSessionId);
    session.client = null;
    this.#setStatus(session, "disconnected", "session_unloaded");
    session.error = null;
    if (!this.store.list().some((item) => item.client === client)) {
      await client.stop().catch(() => {});
      for (const [key, candidate] of this.clients) {
        if (candidate === client) this.clients.delete(key);
      }
    }
    return true;
  }

  schedulePersist() {
    if (!this.statePath) return;
    this.persistDirty = true;
    // After shutdown the final flush is the only writer left. A timer armed here
    // by a late callback would fire against a service that is already gone, and
    // write state back out after the daemon believed it had finished.
    if (this.stopped || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushPersist().catch((error) => {
        this.persistError = error?.message ?? String(error);
      });
    }, 50);
  }

  flushPersist() {
    if (!this.persistDirty || !this.statePath) return this.persistChain;
    this.persistDirty = false;
    this.persistChain = this.persistChain
      .catch(() => {})
      .then(() => this.persist())
      .then(
        () => { this.persistError = null; },
        (error) => {
          this.persistError = error?.message ?? String(error);
          throw error;
        }
      );
    return this.persistChain;
  }

  // flushPersist's body, unchanged in name and meaning: the debounced writer. It
  // barriers the WAL, writes the v5 snapshot (unsynced — same cost the v4 writer
  // always had) or rotates when the log is due, then dual-writes v4.
  async persist() {
    if (this.stateStore) {
      if (!this.stateStore.rotateIfNeeded()) this.stateStore.writeSnapshot({ sync: false });
    }
    await this.persistLegacySnapshot();
  }

  // Downgrade insurance, sunsetting in 1.5.0. Byte-for-byte the 1.3.2 writer plus
  // two marker fields, so a rolled-back daemon reads it and recovers every
  // session; writerVersion is also how the next v5 start can tell that an older
  // daemon wrote here (v4 cannot preserve a field it does not know about).
  async persistLegacySnapshot() {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({
        version: LEGACY_STATE_SCHEMA_VERSION,
        writerVersion: GATEWAY_VERSION,
        epoch: this.stateStore?.status().snapshotEpoch ?? 0,
        sessions: this.store.checkpoints(),
        // v4 shape: terminal handles and answered requests stay out. The v5
        // snapshot is where they survive a restart.
        tasks: this.taskStore.toPersistedRecords({ includeTerminal: false }),
        inbox: [...this.inbox.values()].filter((item) => ["pending", "interrupted"].includes(item.status))
      })}\n`,
      { mode: 0o600 }
    );
    await rename(temporary, this.statePath);
  }

  async shutdown() {
    this.stopped = true;
    await this.agentUpdateManager?.stop();
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = null;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.subscriptions.clear();
    await Promise.allSettled(this.clientStarts.values());
    // Let in-flight commands land before the transport dies. Stopping a client
    // first would strand their callbacks, so the last thing to touch the state
    // file would be a half-applied command. Bounded because no command waits on
    // a worker turn.
    await Promise.allSettled(
      this.store.list().map((session) => session._queue?.drain(5_000) ?? Promise.resolve(true))
    );
    await Promise.all([...this.clients.values()].map((client) => client.stop()));
    await this.flushPersist();
    // Clean shutdown always rotates, so a normal restart replays an empty log.
    // close() is the last writer: appends after it are silent no-ops, which is
    // what makes the clear() below safe.
    this.stateStore?.close();
    // After the final write: a blocked reader must be told the gateway is gone
    // rather than hang on a waiter timer nobody will ever resolve. Clearing
    // before the flush would persist an empty task set instead.
    this.taskStore.clear();
  }
}

function sanitizeWorkerMcpServers(servers) {
  if (!Array.isArray(servers)) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "mcpServers must be an array");
  }
  return servers.map((server) => {
    const serialized = JSON.stringify(server);
    const name = String(server?.name ?? server?.id ?? "");
    if (/^(?:agent-acp|agent-acp-control)$/i.test(name) || CONTROL_SERVER_PATTERN.test(serialized)) {
      throw new GatewayError(
        ERROR_CODES.INVALID_ARGUMENT,
        "Control MCP/Gateway cannot be injected into a worker session"
      );
    }
    return server;
  });
}

function optionalString(value, name) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `${name} must be a non-empty string`);
  }
  return value.trim();
}

function findModelOption(configOptions) {
  if (!Array.isArray(configOptions)) return null;
  return configOptions.find((option) => option?.category === "model")
    ?? configOptions.find((option) => option?.id === "model")
    ?? null;
}

function isModelOption(option) {
  return option?.category === "model" || option?.id === "model";
}

function validateSessionConfigValue(option, value) {
  if (option.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Config option ${option.id} requires a boolean value`);
    }
    return value;
  }
  if (option.type === "select") {
    if (typeof value !== "string" || !value) {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Config option ${option.id} requires a string value`);
    }
    const values = (option.options ?? []).flatMap((item) =>
      Array.isArray(item?.options) ? item.options : [item]
    ).map((item) => item?.value).filter((item) => typeof item === "string");
    if (!values.includes(value)) {
      throw new GatewayError(
        ERROR_CODES.INVALID_ARGUMENT,
        `Invalid value for config option ${option.id}: ${value}; expected one of: ${values.join(", ")}`
      );
    }
    return value;
  }
  throw new GatewayError(
    ERROR_CODES.INVALID_ARGUMENT,
    `Unsupported config option type for ${option.id}: ${option.type ?? "unknown"}`
  );
}

function sessionModelId(configOptions) {
  const option = findModelOption(configOptions);
  return typeof option?.currentValue === "string" ? option.currentValue : null;
}

function requireOwnedSession(session, context) {
  if (session.ownerRootId !== requireRoot(context)) {
    throw new GatewayError(ERROR_CODES.NOT_SESSION_OWNER, "Session belongs to another Main");
  }
  return session;
}

function requireRoot(context) {
  requireString(context.rootId, "rootId");
  return context.rootId;
}

function restoreMethod(initResult, requested) {
  const capabilities = initResult?.agentCapabilities ?? {};
  const canResume = Boolean(capabilities.sessionCapabilities?.resume);
  const canLoad = capabilities.loadSession === true;
  if (requested === "resume" && !canResume) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "ACP agent does not support session/resume");
  }
  if (requested === "load" && !canLoad) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "ACP agent does not support session/load");
  }
  if (requested === "resume" || requested === "load") return requested;
  if (canResume) return "resume";
  if (canLoad) return "load";
  throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "ACP agent does not support session restore");
}

function canRestoreSession(initResult) {
  const capabilities = initResult?.agentCapabilities ?? {};
  return Boolean(capabilities.sessionCapabilities?.resume) || capabilities.loadSession === true;
}

function extractText(update) {
  if (typeof update.content === "string") return update.content;
  if (typeof update.content?.text === "string") return update.content.text;
  return typeof update.text === "string" ? update.text : "";
}

function shouldDeliverEvent(subscription, event) {
  if (!subscription.includeThoughts && event.type === "agent_thought_chunk") return false;
  if (!subscription.includeToolEvents && event.type.startsWith("tool_call")) return false;
  return true;
}

function publicEvent(session, event) {
  return {
    sessionId: session.id,
    turnId: session.turnId,
    sequence: event.i,
    ...event
  };
}

function publicInboxItem(item) {
  return {
    inboxId: item.inboxId,
    sessionId: item.sessionId,
    turnId: item.turnId,
    type: item.type,
    status: item.status,
    createdAt: item.createdAt,
    resolvedAt: item.resolvedAt,
    resolution: item.resolution,
    requestId: item.requestId,
    toolCall: item.toolCall,
    options: item.options,
    mode: item.mode,
    message: item.message,
    requestedSchema: item.requestedSchema,
    toolCallId: item.toolCallId
  };
}

function requireProvider(provider) {
  if (typeof provider !== "string" || !provider.trim()) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "provider is required");
  }
  providerConfig(provider);
  return provider;
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `${name} is required`);
  }
}

function requireNonNegativeNumber(value, name, fallback) {
  if (value == null) {
    if (fallback === undefined) throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `${name} is required`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `${name} must be a non-negative integer`);
  }
  return parsed;
}

// Entries match exactly; a trailing * opts into prefix matching ("tool_call*").
// Exact-by-default keeps a short entry from silently widening the evidence set.
function compileEventTypes(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, "eventTypes must be a non-empty array of strings");
  }
  const matchers = value.map((entry) => {
    if (!entry.endsWith("*")) return { exact: entry };
    const prefix = entry.slice(0, -1);
    if (!prefix) {
      throw new GatewayError(
        ERROR_CODES.INVALID_ARGUMENT,
        "eventTypes wildcard entries need at least one character before *"
      );
    }
    return { prefix };
  });
  return (type) => matchers.some((matcher) =>
    matcher.exact != null ? type === matcher.exact : type.startsWith(matcher.prefix));
}

function isExpired(timestamp, ttl, now) {
  const parsed = Date.parse(timestamp ?? "");
  return Number.isFinite(parsed) && parsed + ttl <= now;
}

function latestTimestamp(...timestamps) {
  const valid = timestamps.filter((value) => Number.isFinite(Date.parse(value ?? "")));
  if (!valid.length) return null;
  return valid.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest);
}

async function requireDirectory(path) {
  requireString(path, "cwd");
  const absolute = resolve(path);
  if (!(await stat(absolute)).isDirectory()) {
    throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Not a directory: ${absolute}`);
  }
  return absolute;
}

export { PERMISSION_POLICIES, sanitizeWorkerMcpServers };
