import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { AcpClient, PERMISSION_POLICIES, requirePermissionPolicy } from "./acp-client.js";
import { ArtifactStore, defaultArtifactRoot } from "./artifacts.js";
import { utf8ByteHead } from "./bounded-utf8.js";
import { ERROR_CODES, GatewayError } from "./errors.js";
import { currentModelId, detectProviders, providerConfig } from "./providers.js";
import {
  capPendingOptions, compareInboxDesc, decodeInboxCursor, encodeInboxCursor, isAfterInboxCursor,
  projectInboxItem, projectPoll, projectResult, PROFILES, relevantAlerts, requireInboxDetail,
  requireProfile, requireResultBudget, requireResultDelivery
} from "./response-profile.js";
import { SessionQueue } from "./session-queue.js";
import {
  CHUNK_EVENT_TYPES, DURABLE_EVENT_TYPES, normalizeThoughtCapture, publicSession, SessionStore
} from "./sessions.js";
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
// Defined next to the ring that enforces it; re-exported here because the
// transport lane table reads the same closed control-event inventory.
export { DURABLE_EVENT_TYPES } from "./sessions.js";

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
    maxInboxItemBytes = 64 * 1024,
    maxPendingInboxBytesPerSession = 512 * 1024,
    maxPendingInboxBytesPerRoot = 4 * 1024 * 1024,
    maxFrameBytes = 32 * 1024 * 1024,
    // Transport, session and root budgets. Flat numbers on purpose: setup()
    // renders these straight into a Main-side table, and a nested object would
    // print as [object Object].
    maxQueueBytes = 4_000_000,
    writeTimeoutMs = 10_000,
    maxPromptBytes = 1_000_000,
    maxFileReadBytes = 500_000,
    maxTerminalOutputBytes = 10_000_000,
    // The RSS arithmetic behind 64: a live session holds three bounded 1MB text
    // accumulators, so 64 sessions is ~192MB of transcript state per root.
    maxSessionsPerRoot = 64,
    maxInboxHistoryPerRoot = 1_000,
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
    // Gateway-wide default for how much worker reasoning a session retains.
    // Per-session overrides ride session_open/session_restore.
    thoughtCapture = "tail",
    agentUpdateManager = null,
    now = () => Date.now()
  } = {}) {
    this.observability = { thoughtCapture: normalizeThoughtCapture(thoughtCapture) };
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
    // Per-task delivery preferences (profile, budget, usage) captured at prompt
    // time, because finishTaskForSession builds the envelope when no caller is
    // present to state them. Deliberately NOT on the session (a later poll would
    // inherit an unrelated past call's mode) and deliberately NOT persisted: a
    // task that was still in flight at restart is failed, and a terminal one
    // already has its envelope built.
    this.taskDelivery = new Map();
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
      maxInboxItemBytes,
      maxPendingInboxBytesPerSession,
      maxPendingInboxBytesPerRoot,
      maxFrameBytes,
      maxQueueBytes,
      writeTimeoutMs,
      maxPromptBytes,
      maxFileReadBytes,
      maxTerminalOutputBytes,
      maxSessionsPerRoot,
      maxInboxHistoryPerRoot
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
        if (!event || DURABLE_EVENT_TYPES.has(event.type)) {
          this.schedulePersist();
        }
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
        // A checkpoint written before this field existed restores on the current
        // gateway default rather than on a hardcoded one.
        thoughtCapture: normalizeThoughtCapture(record.thoughtCapture, this.observability.thoughtCapture),
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
      const item = compactRecoveredInbox(record, this.resourceLimits.maxInboxItemBytes);
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
      run: () => this.sessionRun(args, context),
      poll: () => this.sessionPoll(args, context),
      permission: () => this.sessionPermission(args, context),
      answer: () => this.sessionAnswer(args, context),
      cancel: () => this.sessionCancel(args, context),
      session: () => this.sessionManage(args, context),
      task_prompt: () => this.taskPrompt(args, context),
      // Task-mode agent_acp_run: same admission and same handle as task_prompt,
      // recorded with the origin that actually minted it.
      task_run: () => this.taskPrompt(args, context, "run"),
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
      // Replay is the ring only: chunks are a live-delivery concern, and a
      // reconnecting monitor re-reading a full stream of them is the burst that
      // makes a slow subscriber slower. It gains the complete control history in
      // exchange, which is the part a cold start actually needs.
      cursorTruncated[session.id] = cursorTruncatedFor(session, cursor);
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

  async setup({ provider, refreshAgentUpdates = false, mode = "full" } = {}) {
    if (mode !== "full" && mode !== "summary") {
      throw new GatewayError(ERROR_CODES.INVALID_ARGUMENT, `Unknown setup mode: ${mode}`);
    }
    if (refreshAgentUpdates && this.agentUpdateManager) await this.agentUpdateManager.refresh();
    const detected = await detectProviders();
    const names = provider ? [requireProvider(provider)] : [];
    const agentUpdates = this.agentUpdateManager?.snapshot() ?? null;
    const alerts = [...(agentUpdates?.alerts ?? []), ...this.stateAlerts];
    const liveSessions = this.store.list().filter((session) => session.client?.alive).length;
    // The omitted blocks are the ones a delegating Main re-reads on every hop
    // without acting on them: `detected` (install-time paths, and the only
    // machine-dependent part of this payload), resourceLimits, lifecycle and
    // metrics. session_open now carries the five limits that can fail a prompt,
    // so nothing actionable is lost by not asking for the full table.
    if (mode === "summary") {
      return {
        ok: true,
        gatewayVersion: GATEWAY_VERSION,
        gatewayApiVersion: GATEWAY_API_VERSION,
        stateSchemaVersion: STATE_SCHEMA_VERSION,
        responseProfiles: [...PROFILES],
        persistence: { healthy: this.persistError == null, error: this.persistError },
        alerts,
        providers: detected.map((item) => ({
          provider: item.id,
          ok: item.agentInstalled && item.adapterInstalled,
          started: false
        })),
        liveSessions
      };
    }
    return {
      ok: true,
      gatewayVersion: GATEWAY_VERSION,
      gatewayApiVersion: GATEWAY_API_VERSION,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      // Declaration-first capability. A gateway without this key is an old one,
      // and probe-by-sending cannot detect that: an unknown argument is silently
      // ignored, so a compact request would come back full with no error.
      responseProfiles: [...PROFILES],
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
      lifecycle: { ...this.lifecycle, liveSessions },
      resourceLimits: this.resourceLimits,
      metrics: { ...this.metrics, eventsByType: { ...this.metrics.eventsByType } },
      agentUpdates,
      gatewayUpdate: agentUpdates?.gatewaySource ?? null,
      alerts,
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
      if (args.thoughtCapture != null) {
        existing.thoughtCapture = normalizeThoughtCapture(args.thoughtCapture, existing.thoughtCapture);
      }
      if (args.pinned != null) existing.pinned = args.pinned === true;
      existing.orphanedAt = null;
      client.onSessionUpdate(acpSessionId, (update) => this.handleUpdate(existing, update));
      this.store.push(existing, { type: "session_restored", method });
      return {
        ok: true,
        ...publicSession(existing),
        capabilities: configured.response,
        restoredWith: method,
        ...this.bindTimeFacts(existing)
      };
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
    // Closed records do not count: they hold no client, no accumulators and cannot
    // be prompted. Their bytes are retention's problem, not admission's.
    const live = this.store
      .list()
      .filter((item) => item.ownerRootId === fields.ownerRootId && !CLOSED_STATUSES.has(item.status)).length;
    if (live >= this.resourceLimits.maxSessionsPerRoot) {
      throw new GatewayError(
        ERROR_CODES.SESSION_LIMIT_EXCEEDED,
        `Session limit for this Main exceeded: ${this.resourceLimits.maxSessionsPerRoot}`
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
      // Additive per-session override of the gateway default; an unknown value
      // falls back rather than failing an otherwise valid open.
      thoughtCapture: normalizeThoughtCapture(
        fields.args.thoughtCapture, this.observability.thoughtCapture
      ),
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
      restoredWith: fields.restoredWith,
      ...this.bindTimeFacts(session)
    };
  }

  // What a Main must know at bind time, delivered on the call it already makes.
  // Every field here exists to remove a setup() round trip from the hot path:
  // the capability list it branches on, the API contract version, the alerts
  // that are about THIS session, and the five limits that can fail a prompt
  // (maxPromptBytes rejects in admission, so learning it afterwards is too late).
  // Persistence health is deliberately absent: it already fails a task closed and
  // raises an alert, and one fact on two channels is how the two drift apart.
  bindTimeFacts(session) {
    const alerts = [...(this.agentUpdateManager?.snapshot()?.alerts ?? []), ...this.stateAlerts];
    return {
      responseProfiles: [...PROFILES],
      gatewayApiVersion: GATEWAY_API_VERSION,
      ...relevantAlerts(alerts, session.provider),
      limits: {
        maxPromptBytes: this.resourceLimits.maxPromptBytes,
        maxInlineResultBytes: this.resourceLimits.maxInlineResultBytes,
        resultRetentionMs: this.lifecycle.resultRetentionMs,
        sessionRetentionMs: this.lifecycle.sessionRetentionMs,
        taskRetentionMs: this.lifecycle.taskRetentionMs
      }
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
    // Refused in admission, so an oversized prompt costs no turn, no reservation
    // and no frame on the wire toward the worker.
    const promptBytes = Buffer.byteLength(
      typeof args.prompt === "string" ? args.prompt : JSON.stringify(args.prompt)
    );
    if (promptBytes > this.resourceLimits.maxPromptBytes) {
      throw new GatewayError(
        ERROR_CODES.PROMPT_TOO_LARGE,
        `prompt exceeds ${this.resourceLimits.maxPromptBytes} bytes: ${promptBytes}`
      );
    }
    // Delivery arguments are validated in admission too, so a mistyped profile
    // costs no turn and no reservation. They only take effect where an envelope
    // is actually built (Task mode); a direct prompt's reader states its own.
    requireProfile(args.responseProfile);
    requireResultBudget(args.resultBudgetBytes);
    requireResultDelivery(args.resultDelivery);
    return this.#reserve(session, "prompt");
  }

  // agent_acp_run. The only tool whose direct return and whose tasks/result are
  // the same CallToolResult — because it is the only one that always has a Task,
  // and both paths end at this.taskResult(). Structural identity, not a copy
  // that has to be kept in step.
  async sessionRun(args, context) {
    const ownerRootId = requireRoot(context);
    const attaching = args.taskId != null;
    if (attaching && (args.prompt !== undefined || args.sessionId !== undefined)) {
      throw new GatewayError(
        ERROR_CODES.INVALID_ARGUMENT,
        "agent_acp_run starts a turn with {sessionId, prompt} or attaches to one with {taskId}, never both"
      );
    }
    // 55s stays under the SDK host's 60s default tool timeout, so an ordinary
    // wait fails on OUR terms (a legible ok:true handoff) rather than as a
    // transport timeout the gateway never gets to explain.
    const waitMs = Math.min(600_000, requireNonNegativeNumber(args.waitMs, "waitMs", 55_000));
    const taskId = attaching
      ? this.#storeCall(() => this.taskStore.get(args.taskId, { ownerRootId })).taskId
      : await this.#startRunTask(args, context);
    if (waitMs === 0) return this.#runHandoff(taskId, context);
    let record;
    try {
      // The TASK waiter, never store.wait: store.wait fires at finalizeResult,
      // which is before the durability barrier, so a crash could take back a
      // result this call had already handed out.
      record = await this.taskStore.waitForTerminal(taskId, {
        ownerRootId,
        timeoutMs: waitMs,
        // Returning control is the only correct answer to input_required: the
        // request cannot be answered from inside the call that is waiting on it.
        stopOn: ["input_required"]
      });
    } catch (error) {
      if (error?.code === "WAIT_TIMEOUT") return this.#runHandoff(taskId, context, { timedOut: true });
      return this.#storeCall(() => { throw error; });
    }
    if (!TERMINAL_TASK_STATUSES.has(record.status)) return this.#runHandoff(taskId, context);
    return this.taskResult({ taskId }, context);
  }

  async #startRunTask(args, context) {
    const session = requireOwnedSession(this.requireSession(args.sessionId), context);
    const existing = this.#idempotentRun(session, args.idempotencyKey);
    if (existing) return existing;
    const created = await this.taskPrompt(args, context, "run");
    this.#rememberRun(session, args.idempotencyKey, created.taskId);
    return created.taskId;
  }

  // Not an error return. A timeout or a pending worker request is a handoff: the
  // work is still running and the handle is still good, so the model is told what
  // to call next. Reporting isError here would make it retry the whole call —
  // which is exactly how one prompt becomes two.
  #runHandoff(taskId, context, { timedOut = false } = {}) {
    const ownerRootId = requireRoot(context);
    const task = this.#storeCall(() => this.taskStore.get(taskId, { ownerRootId }));
    if (TERMINAL_TASK_STATUSES.has(task.status)) return this.taskResult({ taskId }, context);
    if (task.status === "input_required") {
      const pending = this.#pendingInboxRecord(task.sessionId);
      return {
        ok: true,
        status: "input_required",
        taskId,
        sessionId: task.sessionId,
        ...(pending ? { pending } : {}),
        next: {
          answerWith: pending?.type === "worker_question" ? "agent_acp_answer" : "agent_acp_permission",
          thenAttach: { tool: "agent_acp_run", arguments: { taskId } }
        }
      };
    }
    return {
      ok: true,
      status: "working",
      ...(timedOut ? { incomplete: "wait_budget_exceeded" } : {}),
      taskId,
      sessionId: task.sessionId,
      next: {
        attach: { tool: "agent_acp_run", arguments: { taskId } },
        poll: { tool: "agent_acp_poll", arguments: { sessionId: task.sessionId, waitMs: 30_000 } }
      }
    };
  }

  // The newest obligation on this session, as the compact inbox record PR 5
  // already defines. Options are capped here and nowhere else: this is the only
  // response that carries them without a cursor to page with.
  #pendingInboxRecord(sessionId) {
    const rows = [...this.inbox.values()]
      .filter((item) => item.sessionId === sessionId && item.status === "pending")
      .sort(compareInboxDesc);
    return rows.length ? capPendingOptions(publicInboxItem(rows[0])) : null;
  }

  // PR 2's admission covers "retried while running". It cannot cover the window
  // this tool opens: a wait times out, the turn then finishes, the session goes
  // idle, and a retry is admitted — prompting the worker a second time. The key
  // is the only layer that covers that window. Per session, last eight, never
  // persisted (a restart fails the task, so there is nothing to be idempotent
  // about afterwards).
  #idempotentRun(session, key) {
    if (typeof key !== "string" || !key.trim()) return null;
    const taskId = session._runKeys?.get(key);
    return taskId && this.taskStore.find(taskId) ? taskId : null;
  }

  #rememberRun(session, key, taskId) {
    if (typeof key !== "string" || !key.trim()) return;
    session._runKeys ??= new Map();
    session._runKeys.delete(key);
    session._runKeys.set(key, taskId);
    while (session._runKeys.size > 8) session._runKeys.delete(session._runKeys.keys().next().value);
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

  // The single terminal transition for a turn. Five guards, one per way the
  // turn can stop being this callback's business between request and reply.
  #finishTurn(session, token, outcome) {
    // Shutdown does not finalize turns. Stopping a client now rejects its pending
    // requests (PR2 M7), which would otherwise land here and commit "ACP client
    // stopped" as the turn's outcome — overwriting the in-flight record whose
    // conversion on restart is what tells Main the gateway went down under it.
    if (this.stopped) return;
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
    // The turn's token breakdown lives here, not on usage_update: PromptResponse
    // carries a Usage object that this callback consumed the stopReason of and
    // silently discarded. Recorded before the terminal push so a poll that sees
    // turn_end already sees the totals.
    if (outcome.result?.usage) this.store.recordUsage(session, outcome.result.usage, "prompt_response");
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

  // `origin` is a parameter, not an argument: a wire caller must not be able to
  // claim a handle came from agent_acp_run when it came from a prompt.
  async taskPrompt(args, context, origin = "prompt") {
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
        pollInterval: args.pollInterval,
        origin
      }));
      this.#rememberDelivery(task.taskId, args);
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
      session.activeTaskIncludeUsage = args.includeUsage === true;
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
          this.#publishTaskStatus(running);
          return this.publicTask(running);
        });
      } catch (error) {
        if (session.activeTaskId === task.taskId) {
          session.activeTaskId = null;
          session.activeTaskIncludeUsage = false;
        }
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
    return this.#storeCall(() => {
      // The store hands back the stored payload as-is, possibly null, so it never
      // invents an envelope. The legacy fallback is the caller's, and it stays
      // here: agent_acp_run reuses this method, not a second copy.
      const stored = this.taskStore.result(args.taskId, { ownerRootId });
      if (stored == null) {
        return { ok: false, taskId: task.taskId, error: task.statusMessage ?? "Task completed without a result" };
      }
      // Every envelope names its own handle. Envelopes built by this gateway
      // already carry it; this covers the ones recovered from an older snapshot
      // and the degraded previews recovery rebuilds from a WAL head.
      if (typeof stored !== "object" || Array.isArray(stored) || Object.hasOwn(stored, "taskId")) return stored;
      return { taskId: task.taskId, ...stored };
    });
  }

  // Delivery preferences travel with the handle, not with the session: the
  // envelope is built by a turn callback with no caller present, so the only
  // moment to state them is when the work is submitted. An ordinary task stores
  // nothing at all.
  #rememberDelivery(taskId, args) {
    const profile = requireProfile(args.responseProfile);
    const budget = requireResultBudget(args.resultBudgetBytes);
    const delivery = requireResultDelivery(args.resultDelivery);
    const includeUsage = args.includeUsage === true;
    const includeThoughts = args.includeThoughts === true;
    if (profile === "current" && budget == null && delivery === "inline" && !includeUsage && !includeThoughts) return;
    this.taskDelivery.set(taskId, { profile, budget, delivery, includeUsage, includeThoughts });
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
      ...(session?.activeTaskIncludeUsage === true
        ? { usage: this.store.usageSnapshot(session).turn }
        : {}),
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
    if (session?.activeTaskId === task.taskId) {
      session.activeTaskId = null;
      session.activeTaskIncludeUsage = false;
    }
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
      const detail = requireInboxDetail(args.detail);
      // Paged only when the caller actually asked to page. An argument-free list
      // keeps the 1.3.2 contract exactly — {ok, items}, and no nextCursor key at
      // all — because AgenLynk's monitor reads it unpaged.
      const paged = args.cursor != null || args.limit != null;
      const cursor = args.cursor == null ? null : decodeInboxCursor(args.cursor);
      const limit = args.limit == null
        ? 50
        : Math.min(100, Math.max(1, requireNonNegativeNumber(args.limit, "limit")));
      const matching = [...this.inbox.values()]
        .filter((item) => item.ownerRootId === rootId
          && (!status || item.status === status)
          && (args.sessionId == null || item.sessionId === args.sessionId)
          && (args.type == null || item.type === args.type))
        .sort(compareInboxDesc);
      if (!paged) {
        return { ok: true, items: matching.map((item) => projectInboxItem(publicInboxItem(item), detail)) };
      }
      const after = matching.filter((item) => isAfterInboxCursor(item, cursor));
      const page = after.slice(0, limit);
      return {
        ok: true,
        items: page.map((item) => projectInboxItem(publicInboxItem(item), detail)),
        // null, not absent, on the last page: one shape for every page means a
        // caller's loop condition never has to distinguish the two.
        nextCursor: after.length > limit ? encodeInboxCursor(page[page.length - 1]) : null
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
    // Validated before the wait, not after it: a caller that mistyped a profile
    // must not spend its whole waitMs discovering that.
    const profile = requireProfile(args.responseProfile);
    const budget = requireResultBudget(args.resultBudgetBytes);
    const delivery = requireResultDelivery(args.resultDelivery);
    const cursor = requireNonNegativeNumber(args.cursor, "cursor", 0);
    const waitMs = Math.min(120_000, requireNonNegativeNumber(args.waitMs, "waitMs", 0));
    const maxEvents = Math.min(1000, Math.max(1, requireNonNegativeNumber(args.maxEvents, "maxEvents", 200)));
    const toCursor = args.toCursor == null ? Infinity : requireNonNegativeNumber(args.toCursor, "toCursor");
    const matchesEventType = compileEventTypes(args.eventTypes);
    // Raw chunks are available only to an explicitly opted-in live subscriber.
    // Poll reads the retained control/projection ring and never wakes on stream
    // fragments, even if a caller names a chunk type.
    const visible = () => session.events;
    const firstIndex = visible()[0]?.i ?? session.eventSequence;
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
      && !visible().some(deliverable)) {
      const statusAtWait = session.status;
      await this.store.wait(session, waitMs, () =>
        session.status !== statusAtWait || visible().some(deliverable));
    }
    // maxEvents counts deliverable events; the cursor still advances over the
    // filtered-out ones in between so sparse type reads do not return empty
    // page after empty page.
    const ordered = visible().filter((event) => event.i >= effectiveCursor && event.i < toCursor);
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
    const diagnostic = profile === "diagnostic";
    const response = {
      ok: true,
      ...publicSession(session),
      nextCursor: window.length ? window.at(-1).i + 1 : effectiveCursor,
      cursorTruncated: cursorTruncatedFor(session, cursor),
      events,
      // The cursor advances over filtered-out events too; this says how many,
      // so an empty poll with a moving cursor is legible.
      filteredCount: window.length - events.length,
      ...(!includeResult ? {} : {
        // After the turn ends, text carries only the final message segment; the
        // full narrated transcript stays readable via session get. Opt-ins stay
        // opt-in — diagnostic is the profile that asks for all of them at once.
        result: this.projectSessionResult(session, {
          profile,
          active,
          includeThoughts: args.includeThoughts === true,
          includeInspection: args.includeInspection === true || diagnostic,
          includeUsage: args.includeUsage === true || diagnostic,
          budget,
          delivery
        })
      })
    };
    const projected = projectPoll(profile, response, diagnostic ? this.#pollDiagnostics(session) : null);
    // Measured on what actually goes out, so the compact saving shows up in the
    // gateway's own metrics rather than only in the benchmark.
    this.recordPollMetrics(projected);
    return projected;
  }

  // The one call site shape used by poll AND by all three terminal envelopes.
  // Everything the projection needs that lives outside the session record — the
  // usage accumulator, the inspection ring, the artifact spill — is bound here.
  projectSessionResult(session, options = {}) {
    return projectResult(session, {
      ...options,
      inspection: options.includeInspection ? this.store.inspectionSnapshot(session) : null,
      usageSummary: options.includeUsage ? this.store.usageSnapshot(session) : null,
      spill: (text) => this.store.spillText(session.id, "result-final", text)
    });
  }

  // Session-scoped on purpose: a poll asks about one session, and the global
  // counter would report other sessions' problems into this one's response.
  #pollDiagnostics(session) {
    const pending = session.client?.pendingSessionInput?.(session.acpSessionId)
      ?? { permissions: 0, elicitations: 0 };
    return {
      // PR 2's deferred question, answered without touching the status
      // vocabulary: "admitted but not yet running" is a queue fact, not a status.
      queue: { depth: session._queue?.depth ?? 0, reserved: session._reserved ?? null },
      illegalTransitions: session._illegalTransitions ?? 0,
      pending: { permissions: pending.permissions, elicitations: pending.elicitations }
    };
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
    this.#tellWorkerToCancel(session);
    this.#setStatus(session, "cancelling", "cancel_requested");
    this.store.push(session, { type: "cancel_requested" });
    this.updateTaskForSession(session, "working", "Cancellation requested");
    return { ok: true, ...publicSession(session) };
  }

  // Telling the worker is best effort, and it has to be: the notify underneath
  // writes to a bounded channel that can refuse the frame outright — a congested
  // or already-closed child transport throws instead of dropping. Every caller
  // records the cancellation intent before it gets here and owes the session a
  // state transition after it: sealing the turn, finalizing the result, setting a
  // terminal status. Letting the throw out skipped all of that while leaving the
  // guard flag set, so the retry was suppressed forever and the session stayed
  // wedged mid-cancel. A worker that never hears the cancel is a case these paths
  // already handle — one that never gets finalized is not.
  #tellWorkerToCancel(session) {
    try {
      session.client?.cancelSession(session.acpSessionId);
    } catch {
      // The transport is gone or refusing frames. The turn is being finalized by
      // this side either way, and the worker's own exit path reconciles the rest.
    }
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
        // The unpaid-for read: get is already the detail call, and usage is two
        // small objects. turn is this turn, session is everything since the
        // record was created or last cleared.
        usage: this.store.usageSnapshot(session),
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
      this.updateTaskForSession(
        session,
        "cancelled",
        "Session closed before the turn completed",
        this.taskTerminalEnvelope(session, { ok: true, status: "cancelled", stopReason: "cancelled" })
      );
    }
    this.interruptSessionInbox(session, "Main closed the worker session");
    const client = session.client;
    if (ACTIVE_STATUSES.has(session.status)) this.#tellWorkerToCancel(session);
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
    // long polls and turn accounting chatter into frontdoor token usage. It is
    // accumulated instead: still no ring event, no waiter, no publish.
    if (type === "usage_update") {
      this.store.recordUsage(session, update, "usage_update");
      return;
    }
    if (type === "agent_message_chunk") {
      const text = extractText(update);
      this.store.appendResultText(session, text);
      this.store.publishChunk(session, this.capTextEvent(session, type, text));
      return;
    }
    if (type === "agent_thought_chunk") {
      const text = extractText(update);
      this.store.appendThoughtText(session, text);
      this.store.publishChunk(session, this.capTextEvent(session, type, text));
      return;
    }
    if (SEGMENT_BOUNDARY_TYPES.has(type)) this.store.markSegmentBoundary(session, String(type));
    if (type === "permission_request") {
      // A cancel Main has already been notified of outranks a late worker
      // request: the event stays on the record, but it must not pull the session
      // back into an input wait or grow a new obligation Main cannot discharge.
      const admitted = this.#setStatus(session, "waiting_permission", type);
      // Serialized and, if oversized, spilled exactly once. The inbox row points
      // at the same artifact the delivered event does instead of keeping a second
      // full copy of the same tool call.
      const toolCall = this.#capture(session, `${type}-toolCall`, update.toolCall);
      const options = this.#capture(session, `${type}-options`, update.options);
      // The durable record is created BEFORE the ring push that makes the request
      // pollable. Reversed (as it was through 1.3.2), a poll could hand Main a
      // requestId whose inbox row does not exist yet.
      const inboxItem = admitted ? this.createPermissionInbox(session, update, toolCall, options) : null;
      if (admitted && !inboxItem) {
        this.syncSessionInputState(session);
        return;
      }
      this.store.push(session, {
        type,
        requestId: update.requestId,
        // Main still needs enough of the tool call to answer the request.
        ...(toolCall.truncated
          ? { toolCallTruncated: true, dataArtifact: toolCall.artifact, toolCall: toolCallHead(update.toolCall) }
          : { toolCall: toolCall.value }),
        ...(options.truncated
          ? { optionsTruncated: true, optionsBytes: options.bytes, optionsArtifact: options.artifact, options: optionsHead(update.options) }
          : { options: options.value })
      });
      if (!admitted) return;
      this.updateTaskForSession(session, "input_required", "Waiting for Main permission");
      return;
    }
    if (type === "elicitation_request") {
      const admitted = this.#setStatus(session, "waiting_input", type);
      const schema = this.#capture(session, `${type}-schema`, update.requestedSchema);
      const message = typeof update.message === "string"
        ? utf8ByteHead(update.message, EVENT_PAYLOAD_CAP_BYTES)
        : update.message;
      // A worker question Main can read is a bounded one, but the part that was
      // cut has to be somewhere: the durable inbox row keeps a pointer to the full
      // text through the same spill the schema and the tool call already use.
      // Only the oversized case pays for a file, and only an admitted request —
      // an unadmitted one has no row to point at it.
      const messageArtifact = admitted && message !== update.message
        ? this.store.spillText(session.id, `${type}-message`, update.message)
        : null;
      const inboxItem = admitted
        ? this.createElicitationInbox(session, update, { schema, message, messageArtifact })
        : null;
      if (admitted && !inboxItem) {
        this.syncSessionInputState(session);
        return;
      }
      this.store.push(session, {
        type,
        requestId: update.requestId,
        mode: update.mode,
        message,
        ...(schema.truncated
          ? { requestedSchemaTruncated: true, dataArtifact: schema.artifact }
          : { requestedSchema: schema.value }),
        toolCallId: update.toolCallId
      });
      if (!admitted) return;
      this.updateTaskForSession(session, "input_required", "Waiting for Main input");
      return;
    }
    if (type === "config_option_update") {
      session.capabilities = { ...session.capabilities, configOptions: update.configOptions ?? [] };
      session.model = sessionModelId(update.configOptions) ?? session.model;
      this.store.push(session, {
        type: "config_changed",
        source: "worker",
        ...this.capStructuredField(session, type, "data", update)
      });
      return;
    }
    const serialized = JSON.stringify(update);
    const event = Buffer.byteLength(serialized) <= EVENT_PAYLOAD_CAP_BYTES
      ? { type: String(type), text: serialized, data: update }
      // Oversized payloads leave the delivery path but stay readable on disk.
      : {
          type: String(type),
          text: utf8ByteHead(serialized, EVENT_PAYLOAD_CAP_BYTES),
          dataTruncated: true,
          dataArtifact: this.store.spillText(session.id, `event-${type}`, serialized)
        };
    // The lane split. tool_call (the start) stays in the ring uncollapsed: it is
    // a segment boundary and the only record that the call ever began. Only its
    // progress updates are projected down to the newest state per call.
    if (CHUNK_EVENT_TYPES.has(type)) this.store.publishChunk(session, event);
    else if (type === "tool_call_update") this.store.pushToolCallUpdate(session, event, update.toolCallId);
    else this.store.push(session, event);
  }

  // Message and thought chunks are usually tiny, but nothing stops a worker
  // from putting megabytes into one chunk; the event copy is capped while the
  // transcript keeps the full text.
  capTextEvent(session, type, text) {
    const capped = utf8ByteHead(text, EVENT_PAYLOAD_CAP_BYTES);
    return capped === text ? { type, text } : { type, text: capped, textTruncated: true };
  }

  // Caps a structured event field by byte size. Both the delivered event copy and
  // the durable inbox row are built from one capture, so an oversized field is
  // serialized once and spilled to one artifact that both of them reference.
  capStructuredField(session, kind, field, value) {
    const captured = this.#capture(session, kind, value);
    if (!captured.truncated) return { [field]: captured.value };
    return { [`${field}Truncated`]: true, dataArtifact: captured.artifact };
  }

  #capture(session, kind, value) {
    if (value == null) return { value, bytes: 0, truncated: false, artifact: null };
    const serialized = JSON.stringify(value);
    const bytes = Buffer.byteLength(serialized);
    if (bytes <= EVENT_PAYLOAD_CAP_BYTES) return { value, bytes, truncated: false, artifact: null };
    return {
      value,
      bytes,
      truncated: true,
      artifact: this.store.spillText(session.id, `event-${kind}`, serialized)
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
      maxInboxItemBytes: this.resourceLimits.maxInboxItemBytes,
      maxFrameBytes: this.resourceLimits.maxFrameBytes,
      maxFileReadBytes: this.resourceLimits.maxFileReadBytes,
      maxTerminalOutputBytes: this.resourceLimits.maxTerminalOutputBytes,
      writeTimeoutMs: this.resourceLimits.writeTimeoutMs,
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
      statusMessage: task.statusMessage,
      // Which tool minted this handle. A recovered pre-1.4.0 record has no
      // origin and was necessarily a prompt.
      origin: task.origin ?? "prompt"
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
        this.#publishTaskStatus(task);
      }
      return;
    }
    this.#commitTaskTerminal(session, taskId, status, statusMessage, result);
    // Keyed off the requested status, not the resulting one: a terminal report
    // that lost to an earlier terminal writer still ends this session's claim.
    session.activeTaskId = null;
    session.activeTaskIncludeUsage = false;
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
        const failed = this.taskStore.failDeferredTerminal(taskId, failureMessage, failure, { lastUpdatedAt });
        this.#publishTaskStatus(failed);
        return failed;
      }
      const failed = this.taskStore.transition(taskId, "failed", failureMessage, {
        lastUpdatedAt,
        result: failure
      });
      this.#publishTaskStatus(failed);
      return failed;
    }
    if (provisional) {
      this.taskStore.flushWaiters(taskId);
      this.#publishTaskStatus(provisional);
      return provisional;
    }
    // Publish only after the WAL barrier. waitForTerminal therefore cannot
    // observe an outcome that a process restart can take back.
    const committed = this.taskStore.transition(taskId, status, statusMessage, {
      lastUpdatedAt,
      ...(result === undefined ? {} : { result })
    });
    this.#publishTaskStatus(committed);
    return committed;
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

  #publishTaskStatus(task) {
    if (!task) return;
    const session = this.store.get(task.sessionId);
    if (!session || CLOSED_STATUSES.has(session.status)) return;
    this.store.push(session, {
      type: "task_status",
      taskId: task.taskId,
      status: task.status,
      statusMessage: task.statusMessage
    });
  }

  #onTaskChange(change) {
    this.schedulePersist();
    // Without a durable removal, a TTL or retention delete comes back on the next
    // replay: the create record is still in the log, and nothing contradicts it.
    if (change?.type === "removed" && change.taskId) {
      this.taskDelivery.delete(change.taskId);
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
    this.updateTaskForSession(session, status, message, this.taskTerminalEnvelope(session, {
      ok: status === "completed" || status === "cancelled",
      status: session.status,
      error: session.error
    }));
  }

  // One terminal envelope, three producers (turn end, close, orphan cancel).
  // They were three hand-rolled copies that had already drifted: only this one
  // carried usage, and none of them could honour a caller's result budget. The
  // envelope a Task hands back is the same object on every path now, which is
  // also what makes agent_acp_run and tasks/result byte-identical for free.
  taskTerminalEnvelope(session, { ok, status, stopReason, error = null } = {}) {
    const taskId = session.activeTaskId ?? null;
    const delivery = (taskId ? this.taskDelivery.get(taskId) : null) ?? {};
    const diagnostic = delivery.profile === "diagnostic";
    return {
      ok,
      sessionId: session.id,
      turnId: session.turnId,
      ...(taskId ? { taskId } : {}),
      status,
      // Before result on purpose: the durable record keeps a bounded head of this
      // envelope as its preview, and ~200 bytes of totals placed ahead of an
      // unbounded transcript are always inside it.
      ...(delivery.includeUsage === true || diagnostic
        ? { usage: this.store.usageSnapshot(session).turn }
        : {}),
      result: this.projectSessionResult(session, {
        profile: delivery.profile ?? "current",
        ...(stopReason === undefined ? {} : { stopReason }),
        includeThoughts: delivery.includeThoughts === true,
        includeInspection: diagnostic,
        includeUsage: delivery.includeUsage === true || diagnostic,
        budget: delivery.budget ?? null,
        delivery: delivery.delivery ?? "inline"
      }),
      ...(error ? { error } : {})
    };
  }

  // A count bound on inbox history, per root and resolved only. A pending row is
  // an obligation Main has not discharged, so it is never evictable; retention
  // still removes rows by age, this one removes them by depth.
  #evictInboxHistory() {
    const limit = this.resourceLimits.maxInboxHistoryPerRoot;
    const byRoot = new Map();
    for (const item of this.inbox.values()) {
      if (item.status === "pending") continue;
      const rows = byRoot.get(item.ownerRootId) ?? [];
      rows.push(item);
      byRoot.set(item.ownerRootId, rows);
    }
    let changed = false;
    for (const rows of byRoot.values()) {
      if (rows.length <= limit) continue;
      rows.sort((left, right) => inboxAge(left).localeCompare(inboxAge(right)));
      for (const item of rows.slice(0, rows.length - limit)) {
        this.inbox.delete(item.inboxId);
        this.stateStore?.append(WAL_TYPES.INBOX_REMOVED, item.inboxId, {});
        changed = true;
      }
    }
    return changed;
  }

  createPermissionInbox(session, update, toolCall = null, options = null) {
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
      // Under the cap (the ordinary case) the row is exactly what it always was.
      // Over it, the row keeps the head Main needs to recognize the call and points
      // at the artifact the event path already wrote, instead of holding megabytes
      // of tool input that only the artifact is ever read for.
      ...(toolCall?.truncated
        ? {
            toolCall: toolCallHead(update.toolCall),
            toolCallTruncated: true,
            toolCallBytes: toolCall.bytes,
            toolCallArtifact: toolCall.artifact
          }
        : { toolCall: update.toolCall }),
      ...(options?.truncated
        ? {
            options: optionsHead(update.options),
            optionsTruncated: true,
            optionsBytes: options.bytes,
            optionsArtifact: options.artifact
          }
        : { options: update.options })
    };
    if (!this.#admitInboxItem(session, item)) return null;
    this.inbox.set(inboxId, item);
    this.#appendInboxCreated(item);
    this.schedulePersist();
    return item;
  }

  createElicitationInbox(session, update, projection = null) {
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
      // The same capped projection the event carries. A worker question Main can
      // read is a bounded one; the full text stays in the artifact.
      ...(projection && projection.message !== update.message
        ? {
            message: projection.message,
            messageTruncated: true,
            messageBytes: typeof update.message === "string" ? Buffer.byteLength(update.message) : null,
            // Returned as a pointer, never rehydrated, exactly like every other
            // artifact reference the inbox hands out.
            messageArtifact: projection.messageArtifact ?? null
          }
        : { message: update.message }),
      ...(projection?.schema?.truncated
        ? {
            requestedSchemaTruncated: true,
            requestedSchemaBytes: projection.schema.bytes,
            requestedSchemaArtifact: projection.schema.artifact
          }
        : { requestedSchema: update.requestedSchema }),
      toolCallId: update.toolCallId
    };
    if (!this.#admitInboxItem(session, item)) return null;
    this.inbox.set(inboxId, item);
    this.#appendInboxCreated(item);
    this.schedulePersist();
    return item;
  }

  #admitInboxItem(session, item) {
    setStablePayloadBytes(item);
    const pending = [...this.inbox.values()].filter((candidate) => candidate.status === "pending");
    const sessionBytes = pending
      .filter((candidate) => candidate.sessionId === session.id)
      .reduce((total, candidate) => total + inboxPayloadBytes(candidate), 0);
    const rootBytes = pending
      .filter((candidate) => candidate.ownerRootId === session.ownerRootId)
      .reduce((total, candidate) => total + inboxPayloadBytes(candidate), 0);
    const limit = item.payloadBytes > this.resourceLimits.maxInboxItemBytes
      ? `item ${item.payloadBytes}/${this.resourceLimits.maxInboxItemBytes}`
      : sessionBytes + item.payloadBytes > this.resourceLimits.maxPendingInboxBytesPerSession
        ? `session ${sessionBytes + item.payloadBytes}/${this.resourceLimits.maxPendingInboxBytesPerSession}`
        : rootBytes + item.payloadBytes > this.resourceLimits.maxPendingInboxBytesPerRoot
          ? `root ${rootBytes + item.payloadBytes}/${this.resourceLimits.maxPendingInboxBytesPerRoot}`
          : null;
    if (!limit) return true;
    try {
      if (item.type === "permission_request") {
        session.client?.respondPermission(item.requestId, null, session.acpSessionId);
      } else {
        session.client?.respondElicitation(item.requestId, { action: "cancel" }, session.acpSessionId);
      }
    } catch {
      // The provider may have disconnected between admission and rejection.
    }
    this.store.push(session, {
      type: "error",
      errorCode: ERROR_CODES.INBOX_BUDGET_EXCEEDED,
      text: `Inbox byte budget exceeded (${limit})`
    });
    return false;
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
      // The spill-once memo behind a budgeted read: same lifetime as the result
      // it is a pointer to, so it ages out with the session rather than under it.
      if (session.resultBudgetArtifact?.path) keepPaths.add(session.resultBudgetArtifact.path);
      for (const segment of session.resultInspection ?? []) {
        if (segment.artifact?.path) keepPaths.add(segment.artifact.path);
      }
      for (const event of session.events) {
        if (event.dataArtifact?.path) keepPaths.add(event.dataArtifact.path);
      }
    }
    // An inbox row outlives the event it came from: the ring holds 200 events, and
    // a pending request can easily be pushed out of it. Without this, the artifact
    // behind an oversized tool call would be deleted under a request Main has not
    // answered yet.
    for (const item of this.inbox.values()) {
      if (item.toolCallArtifact?.path) keepPaths.add(item.toolCallArtifact.path);
      if (item.optionsArtifact?.path) keepPaths.add(item.optionsArtifact.path);
      if (item.requestedSchemaArtifact?.path) keepPaths.add(item.requestedSchemaArtifact.path);
      if (item.messageArtifact?.path) keepPaths.add(item.messageArtifact.path);
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
    if (this.#evictInboxHistory()) changed = true;

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
        session.chunkEvents = [];
        // The per-turn total went with resultText; the cumulative one is transient
        // state too, and nothing persists either of them.
        this.store.clearSessionUsage(session);
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
    this.#tellWorkerToCancel(session);
    this.store.push(session, { type: "orphan_cancel_requested" });
    this.interruptSessionInbox(session, "Main did not reconnect before the orphan grace period expired");
    this.#sealTurn(session);
    this.#setStatus(session, "cancelled", "orphan_cancelled");
    session.stopReason = "cancelled";
    session.completedAt = new Date(this.now()).toISOString();
    // Snapshot through the result model, not the raw transcript: the task
    // result must honor the final-segment split and the inline cap.
    this.store.finalizeResult(session);
    this.updateTaskForSession(
      session,
      "cancelled",
      "Cancelled after Main disconnect",
      this.taskTerminalEnvelope(session, { ok: true, status: "cancelled", stopReason: "cancelled" })
    );
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

// "At least one event after your cursor is gone." Truncation is a statement about
// storage, never about this caller's filter — what a filter withholds is already
// counted by filteredCount. Ephemeral chunk sequence numbers are intentionally
// absent from the ring, so only an actual ring eviction advances this watermark.
function cursorTruncatedFor(session, cursor) {
  return cursor <= (session.eventsEvictedThrough ?? -1);
}

function publicEvent(session, event) {
  return {
    sessionId: session.id,
    turnId: session.turnId,
    sequence: event.i,
    ...event
  };
}

// Oldest first, by when the row stopped being an obligation.
function inboxAge(item) {
  return item.resolvedAt ?? item.createdAt;
}

// Enough of an oversized tool call to recognize and answer it. The rest is in the
// artifact both the event and the inbox row point at.
function toolCallHead(toolCall) {
  return { toolCallId: toolCall?.toolCallId, title: toolCall?.title, kind: toolCall?.kind };
}

function optionsHead(options) {
  if (!Array.isArray(options)) return [];
  return options.slice(0, 16).map((option) => ({
    optionId: option?.optionId,
    name: option?.name,
    kind: option?.kind
  }));
}

function inboxPayloadBytes(item) {
  return Number.isFinite(item?.payloadBytes)
    ? item.payloadBytes
    : Buffer.byteLength(JSON.stringify(item ?? null));
}

function setStablePayloadBytes(item) {
  let previous = -1;
  while (item.payloadBytes !== previous) {
    previous = item.payloadBytes;
    item.payloadBytes = Buffer.byteLength(JSON.stringify(item));
  }
}

function compactRecoveredInbox(record, maxBytes) {
  const item = { ...record };
  setStablePayloadBytes(item);
  if (item.payloadBytes <= maxBytes) return item;
  const compact = {
    inboxId: item.inboxId,
    ownerRootId: item.ownerRootId,
    sessionId: item.sessionId,
    turnId: item.turnId,
    type: item.type,
    status: item.status,
    createdAt: item.createdAt,
    resolvedAt: item.resolvedAt,
    resolution: item.resolution,
    requestId: item.requestId,
    ...(item.toolCall ? { toolCall: toolCallHead(item.toolCall), toolCallTruncated: true } : {}),
    ...(item.options ? { options: optionsHead(item.options), optionsTruncated: true } : {}),
    ...(item.mode != null ? { mode: item.mode } : {}),
    ...(item.message != null
      ? { message: utf8ByteHead(String(item.message), EVENT_PAYLOAD_CAP_BYTES), messageTruncated: true }
      : {}),
    ...(item.requestedSchema != null ? { requestedSchemaTruncated: true } : {}),
    ...(item.toolCallId != null ? { toolCallId: item.toolCallId } : {}),
    recoveredPayloadTruncated: true
  };
  setStablePayloadBytes(compact);
  if (compact.payloadBytes > maxBytes) {
    delete compact.toolCall;
    delete compact.options;
    delete compact.message;
    setStablePayloadBytes(compact);
  }
  return compact;
}

// Present only when something was actually truncated, so an ordinary row is
// byte-identical to the one 1.3.2 returned. The pointer is returned as a pointer:
// get() does not rehydrate an artifact, exactly like every other dataArtifact.
const INBOX_PROJECTION_KEYS = [
  "toolCallTruncated", "toolCallBytes", "toolCallArtifact",
  "optionsTruncated", "optionsBytes", "optionsArtifact", "payloadBytes",
  "recoveredPayloadTruncated",
  "messageTruncated", "messageBytes", "messageArtifact",
  "requestedSchemaTruncated", "requestedSchemaBytes", "requestedSchemaArtifact"
];

function publicInboxItem(item) {
  const projection = {};
  for (const key of INBOX_PROJECTION_KEYS) {
    if (item[key] !== undefined) projection[key] = item[key];
  }
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
    toolCallId: item.toolCallId,
    ...projection
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
