import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { AcpClient, PERMISSION_POLICIES, requirePermissionPolicy } from "./acp-client.js";
import { ArtifactStore, defaultArtifactRoot } from "./artifacts.js";
import { utf8ByteHead } from "./bounded-utf8.js";
import { currentModelId, detectProviders, providerConfig } from "./providers.js";
import { publicSession, SessionStore } from "./sessions.js";
import { GATEWAY_VERSION } from "./version.js";

const ACTIVE_STATUSES = new Set(["running", "waiting_permission", "waiting_input", "cancelling", "restoring"]);
// Only the start of new work closes a message segment. Progress updates
// (tool_call_update), thoughts, and bookkeeping types never do — a boundary
// mid-answer would amputate the text before it, and a trailing one would
// erase the final answer.
const SEGMENT_BOUNDARY_TYPES = new Set(["tool_call", "permission_request", "elicitation_request"]);
// A normal Main needs only a terminal result or a request it must answer.
// Progress is available through explicit evidence options, but must not make
// every streamed chunk into another frontdoor tool result.
const DEFAULT_POLL_EVENT_TYPES = new Set(["permission_request", "elicitation_request"]);
const EVENT_PAYLOAD_CAP_BYTES = 4000;
const CLOSED_STATUSES = new Set(["closed"]);
const CONTROL_SERVER_PATTERN = /(?:acp-gateway-control|acp-mcp-bridge|gateway-daemon|control-mcp)/i;
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);
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
    agentUpdateManager = null,
    now = () => Date.now()
  } = {}) {
    this.statePath = statePath;
    this.clients = new Map();
    this.clientStarts = new Map();
    this.persistChain = Promise.resolve();
    this.persistDirty = false;
    this.persistTimer = null;
    this.persistError = null;
    this.tasks = new Map();
    this.inbox = new Map();
    this.subscriptions = new Map();
    this.rootPresence = new Map();
    this.createClient = createClient;
    this.agentUpdateManager = agentUpdateManager;
    this.now = now;
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
    this.lifecycle = { gcIntervalMs, idleUnloadMs, orphanGraceMs, resultRetentionMs, inboxRetentionMs, sessionRetentionMs };
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
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8"));
      for (const record of parsed.sessions ?? []) {
        this.store.create({
          ...record,
          status: record.status === "closed" ? "closed" : "disconnected",
          client: null,
          waiters: new Set(),
          events: [],
          resultText: "",
          thoughtText: "",
          activeTaskId: null,
          _ownerActivityPersistedAt: Date.parse(record.lastOwnerActivityAt ?? record.updatedAt)
        });
      }
      for (const record of parsed.tasks ?? []) {
        // An in-flight ACP request cannot safely survive a daemon restart. Keep
        // the durable handle, but make the restart visible to the caller.
        const task = { ...record };
        if (["working", "input_required"].includes(task.status)) {
          task.status = "failed";
          task.statusMessage = "Gateway restarted before this task completed";
          task.result = { ok: false, error: task.statusMessage };
          task.lastUpdatedAt = new Date(this.now()).toISOString();
        }
        this.tasks.set(task.taskId, task);
      }
      for (const record of parsed.inbox ?? []) {
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
      for (const session of this.store.list()) {
        const task = session.activeTaskId ? this.tasks.get(session.activeTaskId) : null;
        if (task && ["completed", "failed", "cancelled"].includes(task.status)) session.activeTaskId = null;
      }
      await this.runMaintenance();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
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
      task_list: () => this.taskList(context),
      task_result: () => this.taskResult(args, context),
      task_cancel: () => this.taskCancel(args, context),
      inbox: () => this.inboxManage(args, context)
    };
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown gateway method: ${method}`);
    return handler();
  }

  subscribe(args = {}, context = {}, emit) {
    if (typeof emit !== "function") throw new Error("Subscription emitter is required");
    const rootId = requireRoot(context);
    const requested = args.sessionIds;
    if (requested != null && !Array.isArray(requested)) throw new Error("sessionIds must be an array");
    const sessions = requested == null
      ? this.store.list().filter((session) => session.ownerRootId === rootId)
      : requested.map((id) => requireOwnedSession(this.requireSession(id), context));
    for (const session of sessions) this.touchSessionOwner(session);
    const cursors = args.cursors ?? {};
    if (typeof cursors !== "object" || Array.isArray(cursors)) throw new Error("cursors must be an object");
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
    if (subscription.rootId !== requireRoot(context)) throw new Error("Subscription belongs to another Main");
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
      persistence: { healthy: this.persistError == null, error: this.persistError },
      lifecycle: {
        ...this.lifecycle,
        liveSessions: this.store.list().filter((session) => session.client?.alive).length
      },
      resourceLimits: this.resourceLimits,
      metrics: { ...this.metrics, eventsByType: { ...this.metrics.eventsByType } },
      agentUpdates,
      gatewayUpdate: agentUpdates?.gatewaySource ?? null,
      alerts: agentUpdates?.alerts ?? [],
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
      existing.client = client;
      existing.status = "idle";
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
    if (!fields.acpSessionId) throw new Error("ACP session operation returned no sessionId");
    const duplicate = this.store
      .list()
      .find((item) => item.provider === fields.provider && item.acpSessionId === fields.acpSessionId);
    if (duplicate) throw new Error(`ACP session is already registered as ${duplicate.id}`);
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
    return {
      ok: true,
      ...publicSession(session),
      capabilities: fields.created ?? {},
      restoredWith: fields.restoredWith
    };
  }

  async ensureConnected(session, context) {
    requireOwnedSession(session, context);
    if (session.client?.alive && session.status !== "disconnected") return session;
    session.status = "restoring";
    this.store.push(session, { type: "session_restore_start" });
    try {
      await this.sessionRestore({}, context, session);
      return session;
    } catch (error) {
      session.status = "unavailable";
      session.error = error?.message ?? String(error);
      this.store.push(session, { type: "session_restore_failed", text: session.error });
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
          throw new Error(`ACP agent does not advertise a model config option; requested model=${requestedModel}`);
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
    if (CLOSED_STATUSES.has(session.status)) throw new Error(`Session ${session.id} is closed`);
    const action = args.action ?? "list";
    if (action !== "list" && action !== "set") throw new Error(`Unknown config action: ${action}`);
    if (action === "set" && (session.promptStarting || ACTIVE_STATUSES.has(session.status))) {
      throw new Error(`Session ${session.id} is still active`);
    }
    await this.ensureConnected(session, context);
    const configOptions = session.capabilities?.configOptions ?? [];
    if (action === "list") {
      return { ok: true, sessionId: session.id, configOptions };
    }

    requireString(args.configId, "configId");
    if (!Object.hasOwn(args, "value")) throw new Error("value is required for config set");
    const option = configOptions.find((item) => item?.id === args.configId);
    if (!option) throw new Error(`Worker does not advertise config option: ${args.configId}`);
    const value = validateSessionConfigValue(option, args.value);
    if (isModelOption(option) && session.client.config.modelScope === "process" && value !== session.model) {
      throw new Error(`Provider ${session.provider} selects model per process; open a new session with model=${value}`);
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

  async sessionPrompt(args, context) {
    const session = requireOwnedSession(this.requireSession(args.sessionId), context);
    if (session.promptStarting || ACTIVE_STATUSES.has(session.status)) throw new Error(`Session ${session.id} is still active`);
    if (CLOSED_STATUSES.has(session.status)) throw new Error(`Session ${session.id} is closed`);
    if (typeof args.prompt !== "string" && !Array.isArray(args.prompt)) {
      throw new Error("prompt must be a string or ACP content array");
    }
    session.promptStarting = true;
    try {
      await this.ensureConnected(session, context);
      const requestedModel = optionalString(args.model, "model");
      if (requestedModel && requestedModel !== session.model) {
        if (session.client.config.modelScope === "process") {
          throw new Error(`Provider ${session.provider} selects model per process; open a new session with model=${requestedModel}`);
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
    } catch (error) {
      session.promptStarting = false;
      throw error;
    }
    session.turnId = `turn-${randomUUID()}`;
    session.status = "running";
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
    void session.client
      .sessionPrompt({ sessionId: session.acpSessionId, prompt: args.prompt })
      .then((result) => {
        session.status = session.cancelRequested || result?.stopReason === "cancelled" ? "cancelled" : "idle";
        session.stopReason = session.cancelRequested ? "cancelled" : result?.stopReason ?? "end_turn";
        session.completedAt = new Date(this.now()).toISOString();
        session.cancelRequested = false;
        this.store.finalizeResult(session);
        this.store.push(session, { type: "turn_end", stopReason: session.stopReason });
        this.finishTaskForSession(session);
      })
      .catch((error) => {
        session.status = session.client?.alive ? "error" : "disconnected";
        session.error = error?.message ?? String(error);
        session.completedAt = new Date(this.now()).toISOString();
        this.store.finalizeResult(session);
        this.store.push(session, { type: "error", text: session.error });
        this.finishTaskForSession(session);
      });
    session.promptStarting = false;
    return { ok: true, sessionId: session.id, turnId: session.turnId, status: session.status };
  }

  async taskPrompt(args, context) {
    const session = requireOwnedSession(this.requireSession(args.sessionId), context);
    if (session.promptStarting || ACTIVE_STATUSES.has(session.status)) throw new Error(`Session ${session.id} is still active`);
    if (CLOSED_STATUSES.has(session.status)) throw new Error(`Session ${session.id} is closed`);
    const now = new Date(this.now()).toISOString();
    const task = {
      taskId: `task-${randomUUID()}`,
      sessionId: session.id,
      ownerRootId: requireRoot(context),
      turnId: null,
      status: "working",
      ttl: Number.isFinite(args.ttl) ? Math.max(0, args.ttl) : 3_600_000,
      pollInterval: Number.isFinite(args.pollInterval) ? Math.max(100, args.pollInterval) : 1_000,
      createdAt: now,
      lastUpdatedAt: now,
      statusMessage: "Prompt accepted",
      result: null
    };
    this.tasks.set(task.taskId, task);
    this.schedulePersist();
    try {
      session.activeTaskId = task.taskId;
      const started = await this.sessionPrompt(args, context);
      task.turnId = started.turnId;
      this.touchTask(task, "working", "Prompt running");
      return this.publicTask(task);
    } catch (error) {
      if (session.activeTaskId === task.taskId) session.activeTaskId = null;
      this.tasks.delete(task.taskId);
      this.schedulePersist();
      throw error;
    }
  }

  async taskGet(args, context) {
    return this.publicTask(requireOwnedTask(this.requireTask(args.taskId), context));
  }

  async taskList(context) {
    const root = requireRoot(context);
    this.pruneTasks();
    return { tasks: [...this.tasks.values()].filter((task) => task.ownerRootId === root).map((task) => this.publicTask(task)) };
  }

  async taskResult(args, context) {
    const task = requireOwnedTask(this.requireTask(args.taskId), context);
    if (["working", "input_required"].includes(task.status)) {
      throw new Error(`Task ${task.taskId} is not complete; use tasks/get and retry after its pollInterval`);
    }
    return task.result ?? { ok: false, error: task.statusMessage ?? "Task completed without a result" };
  }

  async taskCancel(args, context) {
    const task = requireOwnedTask(this.requireTask(args.taskId), context);
    if (["working", "input_required"].includes(task.status)) {
      await this.sessionCancel({ sessionId: task.sessionId }, context);
      this.touchTask(task, "working", "Cancellation requested");
    }
    return this.publicTask(task);
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
      if (!item) throw new Error(`Unknown inboxId: ${args.inboxId}`);
      if (item.ownerRootId !== rootId) throw new Error("Inbox item belongs to another Main");
      return { ok: true, item: publicInboxItem(item) };
    }
    throw new Error(`Unknown inbox action: ${action}`);
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
    if (session.status !== "waiting_permission") throw new Error("Session is not waiting for permission");
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
    if (session.status !== "waiting_input") throw new Error("Session is not waiting for input");
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
    this.interruptSessionInbox(session, "Main cancelled the worker session");
    if (!ACTIVE_STATUSES.has(session.status)) {
      this.schedulePersist();
      return { ok: true, ...publicSession(session) };
    }
    session.cancelRequested = true;
    session.client.cancelSession(session.acpSessionId);
    session.status = "cancelling";
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
        if (ACTIVE_STATUSES.has(item.status) || item.status === "idle") continue;
        await this.closeSession(item);
        closed.push(item.id);
      }
      return { ok: true, closed };
    }
    throw new Error(`Unknown action: ${args.action}`);
  }

  async closeSession(session) {
    this.interruptSessionInbox(session, "Main closed the worker session");
    if (ACTIVE_STATUSES.has(session.status)) session.client?.cancelSession(session.acpSessionId);
    if (session.client?.alive && session.client.initResult?.agentCapabilities?.sessionCapabilities?.close) {
      await session.client.request("session/close", { sessionId: session.acpSessionId }, 30_000);
    }
    session.client?.clearSession(session.acpSessionId);
    session.status = "closed";
    session.client = null;
    this.store.push(session, { type: "session_closed" });
    this.store.delete(session.id);
  }

  syncSessionInputState(session) {
    const pending = session.client?.pendingSessionInput?.(session.acpSessionId)
      ?? { permissions: 0, elicitations: 0 };
    if (pending.permissions > 0) {
      session.status = "waiting_permission";
      this.updateTaskForSession(session, "input_required", "Waiting for Main permission");
    } else if (pending.elicitations > 0) {
      session.status = "waiting_input";
      this.updateTaskForSession(session, "input_required", "Waiting for Main input");
    } else {
      session.status = "running";
      this.updateTaskForSession(session, "working", "Main response sent");
    }
    // Status changed without an event push; pollers filtering out the
    // response events must still observe the transition.
    this.store.notifyWaiters(session);
  }

  handleUpdate(session, update) {
    const type = update.sessionUpdate ?? update.type ?? "unknown";
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
      session.status = "waiting_permission";
      const cappedToolCall = this.capStructuredField(session, `${type}-toolCall`, "toolCall", update.toolCall);
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
      this.createPermissionInbox(session, update);
      this.updateTaskForSession(session, "input_required", "Waiting for Main permission");
      return;
    }
    if (type === "elicitation_request") {
      session.status = "waiting_input";
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
      this.createElicitationInbox(session, update);
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
        for (const session of this.store.list().filter((item) => item.client === client)) {
          session.client = null;
          session.status = "disconnected";
          session.error = error?.message ?? String(error);
          this.store.push(session, { type: "provider_disconnected", text: session.error });
          for (const item of this.inbox.values()) {
            if (item.sessionId !== session.id || item.status !== "pending") continue;
            item.status = "interrupted";
            item.resolution = "ACP provider exited before this worker request was answered";
            item.resolvedAt = new Date(this.now()).toISOString();
          }
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
        throw new Error(`required model=${config.expectedModel}, actual=${actualModel || "<missing>"}`);
      }
      this.clients.set(clientKey, client);
      return client;
    } catch (error) {
      if (this.clients.get(clientKey) === client) this.clients.delete(clientKey);
      await client.stop().catch(() => {});
      throw new Error(`${provider} ACP setup failed: ${error?.message ?? error}; ${(client.stderr ?? "").slice(-1000)}`);
    }
  }

  requireSession(id) {
    requireString(id, "sessionId");
    const session = this.store.get(id);
    if (!session) throw new Error(`Unknown sessionId: ${id}`);
    return session;
  }

  requireTask(id) {
    requireString(id, "taskId");
    this.pruneTasks();
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown taskId: ${id}`);
    return task;
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

  touchTask(task, status, statusMessage, result = undefined) {
    task.status = status;
    task.statusMessage = statusMessage;
    task.lastUpdatedAt = new Date(this.now()).toISOString();
    if (result !== undefined) task.result = result;
    this.schedulePersist();
  }

  updateTaskForSession(session, status, statusMessage, result = undefined) {
    const task = session.activeTaskId ? this.tasks.get(session.activeTaskId) : null;
    if (!task) return;
    this.touchTask(task, status, statusMessage, result);
    if (["completed", "failed", "cancelled"].includes(status)) session.activeTaskId = null;
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
    this.schedulePersist();
  }

  pruneTasks() {
    const now = this.now();
    let changed = false;
    for (const [id, task] of this.tasks) {
      if (!TERMINAL_TASK_STATUSES.has(task.status) || task.ttl == null) continue;
      if (Date.parse(task.lastUpdatedAt) + task.ttl <= now) {
        this.tasks.delete(id);
        changed = true;
      }
    }
    if (changed) this.schedulePersist();
    return changed;
  }

  touchOwnerActivity(args, context) {
    const rootId = context?.rootId;
    if (!rootId) return;
    let session = typeof args?.sessionId === "string" ? this.store.get(args.sessionId) : null;
    if (!session && typeof args?.taskId === "string") {
      const task = this.tasks.get(args.taskId);
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
    let changed = this.pruneTasks();
    // Artifacts still referenced by a live session outlive the age-based
    // prune; they disappear when their session record does.
    const keepPaths = new Set();
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
        changed = true;
      }
    }

    for (const session of [...this.store.list()]) {
      const abandonmentAt = latestTimestamp(session.orphanedAt, session.lastOwnerActivityAt ?? session.updatedAt);
      const orphanExpired = !session.pinned && abandonmentAt
        && isExpired(abandonmentAt, this.lifecycle.orphanGraceMs, now);
      if (orphanExpired && ACTIVE_STATUSES.has(session.status) && !session.orphanCancelRequested) {
        session.orphanCancelRequested = true;
        session.cancelRequested = true;
        session.client?.cancelSession(session.acpSessionId);
        session.status = "cancelling";
        this.store.push(session, { type: "orphan_cancel_requested" });
        this.interruptSessionInbox(session, "Main did not reconnect before the orphan grace period expired");
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
        changed = true;
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
      if (!session.pinned && !ACTIVE_STATUSES.has(session.status)
        && isExpired(recordSince, this.lifecycle.sessionRetentionMs, now)) {
        if (session.client) {
          session.client.clearSession(session.acpSessionId);
          session.client = null;
        }
        this.store.delete(session.id);
        for (const [id, task] of this.tasks) if (task.sessionId === session.id) this.tasks.delete(id);
        for (const [id, item] of this.inbox) if (item.sessionId === session.id) this.inbox.delete(id);
        changed = true;
      }
    }

    for (const [provider, client] of [...this.clients]) {
      if (this.store.list().some((session) => session.client === client)) continue;
      await client.stop().catch(() => {});
      if (this.clients.get(provider) === client) this.clients.delete(provider);
      changed = true;
    }

    if (changed) this.schedulePersist();
    return { ok: true, sessions: this.store.list().length, tasks: this.tasks.size, inbox: this.inbox.size };
  }

  interruptSessionInbox(session, resolution) {
    const resolvedAt = new Date(this.now()).toISOString();
    for (const item of this.inbox.values()) {
      if (item.sessionId !== session.id || item.status !== "pending") continue;
      item.status = "interrupted";
      item.resolution = resolution;
      item.resolvedAt = resolvedAt;
    }
  }

  async unloadSession(session) {
    const client = session.client;
    if (!client || !canRestoreSession(client.initResult)) return false;
    client.clearSession(session.acpSessionId);
    session.client = null;
    session.status = "disconnected";
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
    if (this.persistTimer) return;
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

  async persist() {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({
        version: 4,
        sessions: this.store.checkpoints(),
        tasks: [...this.tasks.values()].filter((task) => ["working", "input_required"].includes(task.status)),
        inbox: [...this.inbox.values()].filter((item) => ["pending", "interrupted"].includes(item.status))
      })}\n`,
      { mode: 0o600 }
    );
    await rename(temporary, this.statePath);
  }

  async shutdown() {
    await this.agentUpdateManager?.stop();
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = null;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.subscriptions.clear();
    await Promise.allSettled(this.clientStarts.values());
    await Promise.all([...this.clients.values()].map((client) => client.stop()));
    await this.flushPersist();
  }
}

function sanitizeWorkerMcpServers(servers) {
  if (!Array.isArray(servers)) throw new Error("mcpServers must be an array");
  return servers.map((server) => {
    const serialized = JSON.stringify(server);
    const name = String(server?.name ?? server?.id ?? "");
    if (/^(?:agent-acp|agent-acp-control)$/i.test(name) || CONTROL_SERVER_PATTERN.test(serialized)) {
      throw new Error("Control MCP/Gateway cannot be injected into a worker session");
    }
    return server;
  });
}

function optionalString(value, name) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
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
    if (typeof value !== "boolean") throw new Error(`Config option ${option.id} requires a boolean value`);
    return value;
  }
  if (option.type === "select") {
    if (typeof value !== "string" || !value) throw new Error(`Config option ${option.id} requires a string value`);
    const values = (option.options ?? []).flatMap((item) =>
      Array.isArray(item?.options) ? item.options : [item]
    ).map((item) => item?.value).filter((item) => typeof item === "string");
    if (!values.includes(value)) {
      throw new Error(`Invalid value for config option ${option.id}: ${value}; expected one of: ${values.join(", ")}`);
    }
    return value;
  }
  throw new Error(`Unsupported config option type for ${option.id}: ${option.type ?? "unknown"}`);
}

function sessionModelId(configOptions) {
  const option = findModelOption(configOptions);
  return typeof option?.currentValue === "string" ? option.currentValue : null;
}

function requireOwnedSession(session, context) {
  if (session.ownerRootId !== requireRoot(context)) throw new Error("Session belongs to another Main");
  return session;
}

function requireOwnedTask(task, context) {
  if (task.ownerRootId !== requireRoot(context)) throw new Error("Task belongs to another Main");
  return task;
}

function requireRoot(context) {
  requireString(context.rootId, "rootId");
  return context.rootId;
}

function restoreMethod(initResult, requested) {
  const capabilities = initResult?.agentCapabilities ?? {};
  const canResume = Boolean(capabilities.sessionCapabilities?.resume);
  const canLoad = capabilities.loadSession === true;
  if (requested === "resume" && !canResume) throw new Error("ACP agent does not support session/resume");
  if (requested === "load" && !canLoad) throw new Error("ACP agent does not support session/load");
  if (requested === "resume" || requested === "load") return requested;
  if (canResume) return "resume";
  if (canLoad) return "load";
  throw new Error("ACP agent does not support session restore");
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
  if (typeof provider !== "string" || !provider.trim()) throw new Error("provider is required");
  providerConfig(provider);
  return provider;
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
}

function requireNonNegativeNumber(value, name, fallback) {
  if (value == null) {
    if (fallback === undefined) throw new Error(`${name} is required`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

// Entries match exactly; a trailing * opts into prefix matching ("tool_call*").
// Exact-by-default keeps a short entry from silently widening the evidence set.
function compileEventTypes(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("eventTypes must be a non-empty array of strings");
  }
  const matchers = value.map((entry) => {
    if (!entry.endsWith("*")) return { exact: entry };
    const prefix = entry.slice(0, -1);
    if (!prefix) throw new Error("eventTypes wildcard entries need at least one character before *");
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
  if (!(await stat(absolute)).isDirectory()) throw new Error(`Not a directory: ${absolute}`);
  return absolute;
}

export { PERMISSION_POLICIES, sanitizeWorkerMcpServers };
