import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { BoundedUtf8Text, readTextHead, readTextLines } from "./bounded-utf8.js";
import { withoutSessionMarkers } from "./caller.js";
import { ERROR_CODES, GatewayError } from "./errors.js";
import { readNdjson } from "./ndjson.js";
import { LANE_HIGH, LANE_NORMAL, NdjsonChannel } from "./ndjson-channel.js";
import { GATEWAY_VERSION } from "./version.js";
import { ACP_PROTOCOL_VERSION } from "./acp-version.js";

export const PERMISSION_POLICIES = ["ask", "read_only", "auto_approve"];
const READ_ONLY_TOOL_KINDS = new Set(["read", "search", "think", "fetch"]);
// In-flight bounds on the child's stdio, as module constants rather than knobs:
// they are safety valves, not deployment choices (the PR2 precedent).
// Outbound is already self-bounding because per-session work is serialized, so
// this one is a tripwire against a leak, not a scheduling limit.
const MAX_OUTBOUND_INFLIGHT_REQUESTS = 256;
// Inbound is the real hole: fs/read_text_file has no permission gate at all,
// under auto_approve neither do writes or terminals, and #onLine dispatches every
// agent request fire-and-forget. Without this counter one worker can hold an
// unbounded number of concurrent reads open (10k x 500KB is 5GB), and streaming
// the reads does not fix it.
const MAX_CONCURRENT_CLIENT_REQUESTS_PER_SESSION = 16;
const CLIENT_REQUEST_PREFIXES = ["fs/", "terminal/"];
// Not the socket default (4MB): that number belongs to the daemon's control
// connection, where the backlog is events nobody has to answer. Everything queued
// toward a child is a reply to work this gateway already admitted, and an agent is
// blocking on it — it can neither be dropped nor be a reason to kill the provider.
// So the budget is derived from what admission allows: the concurrency cap above
// times the file-read cap, doubled for JSON escaping, is ~16MB of replies, and the
// HIGH lane's derived share is an eighth of this number. What actually ends a child
// that has stopped reading its stdin is the no-progress deadline, not a byte cap.
const CHILD_STDIN_QUEUE_BYTES = 128 * 1024 * 1024;

// Lane C has no droppable traffic. Responses to agent-initiated requests and
// cancels are HIGH because the agent is blocked on them, so a dropped frame is a
// permanent deadlock; only the prompt, which can carry a megabyte, rides NORMAL.
function laneForRequest(method) {
  return method === "session/prompt" ? LANE_NORMAL : LANE_HIGH;
}

export class AcpClient {
  constructor(config, options = {}) {
    this.config = config;
    this.permissionPolicy = options.permissionPolicy ?? config.permissionPolicy;
    this.onExit = options.onExit;
    this.artifactStore = options.artifactStore ?? null;
    this.maxTerminalsPerSession = options.maxTerminalsPerSession ?? 16;
    this.maxPendingRequestsPerSession = options.maxPendingRequestsPerSession ?? 64;
    this.maxInboxItemBytes = options.maxInboxItemBytes ?? 64 * 1024;
    this.maxFrameBytes = options.maxFrameBytes ?? 32 * 1024 * 1024;
    this.maxFileReadBytes = options.maxFileReadBytes ?? 500_000;
    // The clamp that has always been here as a literal, now named. Same default,
    // so no behavior changes with it.
    this.maxTerminalOutputBytes = options.maxTerminalOutputBytes ?? 10_000_000;
    this.maxQueueBytes = options.maxQueueBytes ?? CHILD_STDIN_QUEUE_BYTES;
    // Canonical paths no session may touch, even when a root contains them.
    this.protectedPaths = [...(options.protectedPaths ?? [])];
    this.writeTimeoutMs = options.writeTimeoutMs;
    this.proc = null;
    this.rl = null;
    this.channel = null;
    this.nextId = 1;
    this.pending = new Map();
    this.clientRequests = new Map();
    this.pendingPermissions = new Map();
    this.pendingElicitations = new Map();
    this.pendingOperations = new Map();
    this.sessionOperationGrants = new Map();
    this.sessionHandlers = new Map();
    this.sessionRoots = new Map();
    this.sessionPolicies = new Map();
    this.terminals = new Map();
    this.initResult = null;
    this.stderr = "";
    this.alive = false;
  }

  async start() {
    if (this.alive) return this.initResult;

    // Session markers go from the inherited env only: they name the Main that
    // autostarted the daemon, and a worker carrying them would be recorded as
    // that Main. What the provider config sets explicitly is layered on top;
    // CODEX_HOME, CLAUDE_HOME and the other config paths are not markers.
    const childEnv = { ...withoutSessionMarkers(process.env), ...this.config.env, NO_COLOR: "1" };
    delete childEnv.ACP_GATEWAY_CONTROL_TOKEN;
    delete childEnv.ACP_GATEWAY_ROOT_ID;
    delete childEnv.ACP_GATEWAY_SOCKET;
    this.proc = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      ...(this.config.cwd ? { cwd: this.config.cwd } : {})
    });
    this.alive = true;
    this.proc.once("error", (error) => this.#fail(error));
    this.proc.once("close", (code, signal) => {
      this.#fail(new Error(`${this.config.provider} ACP exited code=${code} signal=${signal}`));
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-100_000);
    });
    this.rl = readNdjson(this.proc.stdout, {
      maxLineBytes: this.maxFrameBytes,
      onLine: (line) => this.#onLine(line),
      onOverflow: (error) => {
        this.proc?.kill("SIGTERM");
        this.#fail(error);
      }
    });
    // The write side of the same stdio. A child that stops reading its stdin can
    // no longer make the gateway grow without bound, and ten seconds of no write
    // progress ends the provider through the path that already handles its exit.
    this.channel = new NdjsonChannel(this.proc.stdin, {
      maxFrameBytes: this.maxFrameBytes,
      maxQueueBytes: this.maxQueueBytes,
      writeTimeoutMs: this.writeTimeoutMs,
      onFatal: (error) => {
        this.proc?.kill("SIGTERM");
        this.#fail(error);
      }
    });

    this.initResult = await this.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: { name: "acp-gateway", version: GATEWAY_VERSION },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          elicitation: { form: {} },
          session: { configOptions: { boolean: {} } }
        }
      },
      30_000
    );
    return this.initResult;
  }

  async stop() {
    // Best effort, and first because it is the courtesy: a worker blocked on a
    // permission gets an answer before its transport goes away. Each response is
    // a write to a bounded channel that can refuse the frame, and a throw here
    // used to escape stop() entirely — before close, before SIGTERM — leaking the
    // child process for a reply that no longer matters. Stopping must always
    // reach the kill.
    for (const rpcId of this.pendingPermissions.keys()) {
      try {
        this.respondPermission(rpcId, null);
      } catch {
        // The channel is congested or closed; the SIGTERM below is the answer.
      }
    }
    for (const rpcId of this.pendingElicitations.keys()) {
      try {
        this.respondElicitation(rpcId, { action: "cancel" });
      } catch {
        // Same: the process is going away regardless.
      }
    }
    const stopped = new Error("ACP client stopped");
    // Synchronous, and before anything can await: stop() clears `alive`, so the
    // child's own exit will not run #fail, and a provider that ignores SIGTERM
    // would otherwise leave session/prompt pending forever — a turn nobody can
    // finish or cancel. (PR2 M7.)
    for (const pending of this.pending.values()) pending.reject(stopped);
    this.pending.clear();
    for (const operation of this.pendingOperations.values()) operation.reject(stopped);
    this.pendingOperations.clear();
    this.sessionOperationGrants.clear();
    this.clientRequests.clear();
    this.rl?.close();
    // Cleared before the flush so a child that dies while the channel drains is
    // not reported to onExit as a provider failure: this stop is the reason.
    this.alive = false;
    const channel = this.channel;
    this.channel = null;
    await channel?.close({ flushMs: 250 });
    this.proc?.stdin?.end();
    this.proc?.kill("SIGTERM");
    for (const terminal of this.terminals.values()) terminal.child.kill("SIGTERM");
    this.terminals.clear();
    this.proc = null;
    this.initResult = null;
  }

  request(method, params = {}, timeoutMs = null) {
    if (!this.proc?.stdin || !this.channel) throw new Error("ACP process is not running");
    if (this.pending.size >= MAX_OUTBOUND_INFLIGHT_REQUESTS) {
      throw new Error(`ACP outbound request limit exceeded: ${MAX_OUTBOUND_INFLIGHT_REQUESTS}`);
    }
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolvePromise, reject) => {
      // The frame goes out before the pending entry exists, so a write that
      // cannot happen rejects this promise instead of leaving one nobody will
      // ever settle. No reply can be observed in between: the read loop is a
      // separate I/O turn.
      this.channel.write(laneForRequest(method), payload);
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`ACP request timeout after ${timeoutMs}ms: ${method}`));
          }, timeoutMs)
        : null;
      this.pending.set(id, {
        method,
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  notify(method, params = {}) {
    this.#send(LANE_HIGH, { jsonrpc: "2.0", method, params });
  }

  async sessionNew({
    cwd,
    mcpServers = [],
    additionalDirectories = [],
    permissionPolicy = this.permissionPolicy,
    meta = null
  }) {
    const roots = await canonicalRoots(cwd, additionalDirectories);
    const params = { cwd: roots[0], mcpServers };
    if (additionalDirectories.length) params.additionalDirectories = roots.slice(1);
    if (meta) params._meta = meta;
    const result = await this.request("session/new", params, 30_000);
    this.sessionRoots.set(result.sessionId, roots);
    this.sessionPolicies.set(result.sessionId, requirePermissionPolicy(permissionPolicy));
    return result;
  }

  async sessionRestore({
    method,
    sessionId,
    cwd,
    mcpServers = [],
    additionalDirectories = [],
    permissionPolicy = this.permissionPolicy,
    meta = null
  }) {
    const roots = await canonicalRoots(cwd, additionalDirectories);
    const params = { sessionId, cwd: roots[0], mcpServers };
    if (additionalDirectories.length) params.additionalDirectories = roots.slice(1);
    if (meta) params._meta = meta;
    const result = await this.request(method, params, 30_000);
    this.sessionRoots.set(sessionId, roots);
    this.sessionPolicies.set(sessionId, requirePermissionPolicy(permissionPolicy));
    return result;
  }

  sessionPrompt({ sessionId, prompt }) {
    const content = Array.isArray(prompt) ? prompt : [{ type: "text", text: String(prompt) }];
    return this.request("session/prompt", { sessionId, prompt: content })
      .finally(() => this.sessionOperationGrants.delete(sessionId));
  }

  setSessionConfigOption({ sessionId, configId, value, type = null }) {
    const params = { sessionId, configId, value };
    if (type != null) params.type = type;
    return this.request("session/set_config_option", params, 30_000);
  }

  pendingSessionInput(sessionId) {
    let permissions = 0;
    let elicitations = 0;
    for (const pending of this.pendingPermissions.values()) {
      if (pending.params.sessionId === sessionId) permissions += 1;
    }
    for (const pending of this.pendingOperations.values()) {
      if (pending.sessionId === sessionId) permissions += 1;
    }
    for (const pending of this.pendingElicitations.values()) {
      if (pending.params.sessionId === sessionId) elicitations += 1;
    }
    return { permissions, elicitations };
  }

  cancelSession(sessionId) {
    for (const [rpcId, pending] of this.pendingPermissions) {
      if (pending.params.sessionId === sessionId) this.respondPermission(rpcId, null);
    }
    for (const [rpcId, pending] of this.pendingElicitations) {
      if (pending.params.sessionId === sessionId) {
        this.respondElicitation(rpcId, { action: "cancel" }, sessionId);
      }
    }
    this.#rejectSessionOperations(sessionId, new Error("ACP session cancelled"));
    this.#closeSessionTerminals(sessionId);
    this.notify("session/cancel", { sessionId });
  }

  onSessionUpdate(sessionId, handler) {
    this.sessionHandlers.set(sessionId, handler);
  }

  clearSession(sessionId) {
    for (const [rpcId, pending] of this.pendingElicitations) {
      if (pending.params.sessionId === sessionId) {
        this.respondElicitation(rpcId, { action: "cancel" }, sessionId);
      }
    }
    this.#closeSessionTerminals(sessionId);
    this.sessionHandlers.delete(sessionId);
    this.sessionRoots.delete(sessionId);
    this.sessionPolicies.delete(sessionId);
    this.clientRequests.delete(sessionId);
    this.#rejectSessionOperations(sessionId, new Error("ACP session cleared"));
    this.sessionOperationGrants.delete(sessionId);
  }

  respondPermission(rpcId, optionId, expectedSessionId) {
    const operation = this.pendingOperations.get(rpcId);
    if (operation) {
      if (expectedSessionId && operation.sessionId !== expectedSessionId) {
        throw new Error(`Permission request ${rpcId} belongs to another session`);
      }
      this.pendingOperations.delete(rpcId);
      const allowed = operation.options.some(
        (option) => option.optionId === optionId && /^allow_/.test(option.kind)
      );
      if (!allowed) {
        operation.reject(new Error("Main rejected ACP operation"));
        return;
      }
      return Promise.resolve()
        .then(() => operation.run())
        .then(operation.resolve, operation.reject);
    }
    const pending = this.pendingPermissions.get(rpcId);
    if (!pending) throw new Error(`Unknown permission request: ${rpcId}`);
    if (expectedSessionId && pending.params.sessionId !== expectedSessionId) {
      throw new Error(`Permission request ${rpcId} belongs to another session`);
    }
    if (optionId && !(pending.params.options ?? []).some((option) => option.optionId === optionId)) {
      throw new Error(`Invalid permission option: ${optionId}`);
    }
    this.pendingPermissions.delete(rpcId);
    if (!READ_ONLY_TOOL_KINDS.has(pending.params.toolCall?.kind) && optionId && (pending.params.options ?? []).some(
      (option) => option.optionId === optionId && /^allow_/.test(option.kind ?? "")
    )) {
      this.#addOperationGrant(pending.params.sessionId, grantKindForTool(pending.params.toolCall?.kind));
    }
    const outcome = optionId
      ? { outcome: "selected", optionId }
      : { outcome: "cancelled" };
    this.#respond(rpcId, { outcome });
  }

  respondElicitation(rpcId, response, expectedSessionId) {
    const pending = this.pendingElicitations.get(rpcId);
    if (!pending) throw new Error(`Unknown elicitation request: ${rpcId}`);
    if (expectedSessionId && pending.params.sessionId !== expectedSessionId) {
      throw new Error(`Elicitation request ${rpcId} belongs to another session`);
    }
    if (!response || !["accept", "decline", "cancel"].includes(response.action)) {
      throw new Error("Elicitation action must be accept, decline, or cancel");
    }
    if (response.action === "accept" && response.content != null && (
      typeof response.content !== "object" || Array.isArray(response.content)
    )) {
      throw new Error("Accepted elicitation content must be an object");
    }
    this.pendingElicitations.delete(rpcId);
    this.#respond(rpcId, response);
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(acpRequestError(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "session/update") {
      const params = message.params ?? {};
      this.sessionHandlers.get(params.sessionId)?.(params.update ?? params);
      return;
    }

    if (message.method && Object.hasOwn(message, "id")) {
      void this.#handleAgentRequest(message);
    }
  }

  async #handleAgentRequest({ id, method, params = {} }) {
    // Only the handlers that do unbounded I/O are counted. Permission and
    // elicitation requests are already bounded by maxPendingRequestsPerSession.
    const bounded = CLIENT_REQUEST_PREFIXES.some((prefix) => method?.startsWith(prefix));
    if (bounded && !this.#admitClientRequest(params.sessionId)) {
      this.#respondError(
        id,
        -32000,
        `ACP session concurrent client request limit exceeded: ${MAX_CONCURRENT_CLIENT_REQUESTS_PER_SESSION}`
      );
      return;
    }
    try {
      if (method === "session/request_permission") {
        const decision = this.#automaticPermission(params);
        if (decision) this.#respond(id, decision);
        else {
          this.#requirePendingInputCapacity(params.sessionId);
          this.#requirePendingInputBytes(params);
          const retained = {
            sessionId: params.sessionId,
            toolCall: { kind: params.toolCall?.kind },
            options: (params.options ?? []).map((option) => ({ optionId: option.optionId, kind: option.kind }))
          };
          this.pendingPermissions.set(id, { rpcId: id, params: retained });
          try {
            this.sessionHandlers.get(params.sessionId)?.({
              sessionUpdate: "permission_request",
              requestId: id,
              toolCall: params.toolCall,
              options: params.options
            });
          } catch (error) {
            this.pendingPermissions.delete(id);
            throw error;
          }
        }
        return;
      }
      if (method === "elicitation/create") {
        if (!params.sessionId) throw new Error("Only session-scoped elicitation is supported");
        if (params.mode !== "form") throw new Error(`Unsupported elicitation mode: ${params.mode}`);
        this.#requirePendingInputCapacity(params.sessionId);
        this.#requirePendingInputBytes(params);
        this.pendingElicitations.set(id, { rpcId: id, params: { sessionId: params.sessionId } });
        try {
          this.sessionHandlers.get(params.sessionId)?.({
            sessionUpdate: "elicitation_request",
            requestId: id,
            mode: params.mode,
            message: params.message,
            requestedSchema: params.requestedSchema,
            toolCallId: params.toolCallId ?? null
          });
        } catch (error) {
          this.pendingElicitations.delete(id);
          throw error;
        }
        return;
      }
      if (method === "fs/read_text_file") {
        this.#respond(id, await this.#readTextFile(params));
        return;
      }
      if (method === "fs/write_text_file") {
        await this.#runProtectedOperation(id, method, params, () => this.#writeTextFile(params));
        return;
      }
      if (method === "terminal/create") {
        await this.#runProtectedOperation(id, method, params, () => this.#createTerminal(params));
        return;
      }
      if (method === "terminal/output") {
        this.#respond(id, this.#terminalOutput(params));
        return;
      }
      if (method === "terminal/release") {
        this.#respond(id, this.#releaseTerminal(params));
        return;
      }
      if (method === "terminal/wait_for_exit") {
        this.#respond(id, await this.#waitForTerminalExit(params));
        return;
      }
      if (method === "terminal/kill") {
        this.#respond(id, this.#killTerminal(params));
        return;
      }
      this.#respondError(id, -32601, `Unsupported ACP client method: ${method}`);
    } catch (error) {
      this.#respondError(id, -32000, error?.message ?? String(error));
    } finally {
      if (bounded) this.#releaseClientRequest(params.sessionId);
    }
  }

  // A counter of its own, deliberately not pendingSessionInput: that one drives
  // session status (waiting_permission / waiting_input), so folding these in would
  // change what Main sees a session doing. This one only bounds concurrency.
  #admitClientRequest(sessionId) {
    const active = this.clientRequests.get(sessionId) ?? 0;
    if (active >= MAX_CONCURRENT_CLIENT_REQUESTS_PER_SESSION) return false;
    this.clientRequests.set(sessionId, active + 1);
    return true;
  }

  #releaseClientRequest(sessionId) {
    const active = (this.clientRequests.get(sessionId) ?? 0) - 1;
    if (active > 0) this.clientRequests.set(sessionId, active);
    else this.clientRequests.delete(sessionId);
  }

  #automaticPermission(params) {
    const policy = this.sessionPolicies.get(params.sessionId) ?? this.permissionPolicy;
    const scope = this.#permissionScope(params);
    // A protected path is refused under every policy, ask included: Main should
    // not be one mistaken click away from handing a worker the Control token.
    if (scope === "protected") return this.#selectPermission(params, ["reject_once", "reject_always"]);
    if (policy === "ask") return null;
    const readLike = READ_ONLY_TOOL_KINDS.has(params.toolCall?.kind);
    if (scope === "outside") {
      // Nothing outside the declared roots is ever approved automatically.
      // read_only refuses it; auto_approve hands the decision to Main, since it
      // was only ever authorized inside the roots.
      return policy === "auto_approve" ? null : this.#selectPermission(params, ["reject_once", "reject_always"]);
    }
    return this.#selectPermission(
      params,
      policy === "auto_approve" || readLike ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"]
    );
  }

  #selectPermission(params, wantedKinds) {
    const options = params.options ?? [];
    const option = wantedKinds
      .map((kind) => preferContinuing(options.filter((item) => item.kind === kind)))
      .find(Boolean);
    return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
  }

  // Classifies the paths a permission request names in toolCall.locations (and a
  // Read-style rawInput.file_path/path) against the session roots. A request
  // that names no path keeps its old treatment: its kind decides.
  #permissionScope(params) {
    const roots = this.sessionRoots.get(params.sessionId) ?? [];
    // A shell command names its files inside a string. It cannot be parsed
    // reliably, but naming a protected path in any spelling is enough to refuse.
    const command = commandText(params.toolCall?.rawInput);
    if (mentionsProtectedPath(command, this.protectedPaths)
      || commandPathsHitProtected(command, roots[0], this.protectedPaths)) return "protected";
    let outside = false;
    for (const requested of requestedPaths(params.toolCall)) {
      const path = canonicalizePhysical(isAbsolute(requested) ? requested : `${roots[0] ?? ""}/${requested}`);
      if (this.protectedPaths.some((item) => isWithin(item, path))) return "protected";
      if (!roots.some((root) => isWithin(root, path))) outside = true;
    }
    return outside ? "outside" : "inside";
  }

  // Truncate, never refuse: the ACP contract has no way to say "too large", and a
  // worker that asked for a file it cannot have would just retry. What changed is
  // that the cap is now bytes rather than UTF-16 code units (a CJK file used to
  // return up to ~1.5MB), and that nothing proportional to the file size is ever
  // allocated — a 2GB file costs the cap.
  async #readTextFile(params) {
    const path = await this.#sessionPath(params.sessionId, params.path);
    const cap = this.maxFileReadBytes;
    const windowed = params.line != null || params.limit != null;
    const info = await stat(path);
    const read = windowed
      ? await readTextLines(path, {
          line: Number(params.line ?? 1),
          limit: params.limit == null ? Infinity : Math.max(0, Number(params.limit)),
          maxBytes: cap
        })
      : await readTextHead(path, cap);
    // An untruncated answer stays byte-identical to every previous version: no
    // _meta key at all. Truncation used to be silent, which is the actual bug.
    if (!read.truncated) return { content: read.text };
    return {
      content: read.text,
      _meta: {
        "acp-gateway/read": {
          truncated: true,
          bytes: read.bytes,
          fileBytes: info.size,
          maxBytes: cap,
          ...(windowed ? { line: Number(params.line ?? 1), limit: params.limit ?? null } : {})
        }
      }
    };
  }

  async #writeTextFile(params) {
    const path = await this.#sessionPath(params.sessionId, params.path, true);
    await writeFile(path, String(params.content ?? ""), "utf8");
  }

  async #createTerminal(params) {
    const roots = this.sessionRoots.get(params.sessionId) ?? [];
    const cwd = await realpath(resolve(params.cwd ?? roots[0] ?? process.cwd()));
    if (!roots.some((root) => isWithin(root, cwd))) throw new Error(`Terminal cwd is outside ACP session roots: ${cwd}`);
    if (typeof params.command !== "string" || !params.command) throw new Error("Terminal command is required");
    const commandLine = [params.command, ...(params.args ?? [])].join(" ");
    if (mentionsProtectedPath(commandLine, this.protectedPaths) || commandPathsHitProtected(commandLine, cwd, this.protectedPaths)) {
      throw new Error("Terminal command names a path protected by the Gateway");
    }
    const activeForSession = [...this.terminals.values()].filter((item) => item.sessionId === params.sessionId).length;
    if (activeForSession >= this.maxTerminalsPerSession) {
      throw new Error(`ACP session terminal limit exceeded: ${this.maxTerminalsPerSession}`);
    }
    const terminalId = `terminal-${this.nextId++}`;
    const limit = Math.min(Math.max(Number(params.outputByteLimit ?? 1_000_000), 1), this.maxTerminalOutputBytes);
    // Same scrub as the worker's own env. What the worker asks for explicitly is
    // its own identity, not the Main's, and is kept.
    const env = { ...withoutSessionMarkers(process.env), ...Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value])) };
    delete env.ACP_GATEWAY_CONTROL_TOKEN;
    delete env.ACP_GATEWAY_ROOT_ID;
    delete env.ACP_GATEWAY_SOCKET;
    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    const artifactWriter = this.artifactStore?.create(params.sessionId, "terminal") ?? null;
    const outputBuffer = new BoundedUtf8Text(limit, { onTrim: (buffer) => artifactWriter?.append(buffer) });
    const terminal = {
      child,
      sessionId: params.sessionId,
      outputBuffer,
      artifactWriter,
      artifact: null,
      limit,
      truncated: false,
      exitStatus: null,
      exited: null
    };
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    terminal.exited = new Promise((done) => {
      let finished = false;
      const finish = (exitCode, signal) => {
        if (finished) return;
        finished = true;
        terminal.exitStatus = { exitCode, signal };
        done(terminal.exitStatus);
      };
      child.once("close", (exitCode, signal) => {
        append(stdoutDecoder.end());
        append(stderrDecoder.end());
        if (artifactWriter?.active) {
          artifactWriter.finalize(outputBuffer.toString());
          terminal.artifact = artifactWriter.metadata();
        }
        finish(exitCode, signal);
      });
      child.once("error", (error) => {
        append(`\n${error.message}\n`);
        if (artifactWriter?.active) {
          artifactWriter.finalize(outputBuffer.toString());
          terminal.artifact = artifactWriter.metadata();
        }
        finish(null, null);
      });
    });
    const append = (chunk) => {
      outputBuffer.append(chunk);
      if (outputBuffer.trimmedBytes > 0) terminal.truncated = true;
    };
    child.stdout.on("data", (chunk) => append(stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk) => append(stderrDecoder.write(chunk)));
    this.terminals.set(terminalId, terminal);
    return { terminalId };
  }

  #terminalOutput(params) {
    const terminal = this.#terminal(params.sessionId, params.terminalId);
    return {
      output: terminal.outputBuffer.toString(),
      artifact: terminal.artifact ?? terminal.artifactWriter?.metadata() ?? null,
      truncated: terminal.truncated,
      exitStatus: terminal.exitStatus
    };
  }

  #releaseTerminal(params) {
    const terminal = this.#terminal(params.sessionId, params.terminalId);
    if (!terminal.exitStatus) terminateChild(terminal);
    this.terminals.delete(params.terminalId);
    return {};
  }

  async #waitForTerminalExit(params) {
    const terminal = this.#terminal(params.sessionId, params.terminalId);
    return await terminal.exited;
  }

  #killTerminal(params) {
    const terminal = this.#terminal(params.sessionId, params.terminalId);
    if (!terminal.exitStatus) killChild(terminal.child, params.signal ?? "SIGTERM");
    return {};
  }

  #terminal(sessionId, terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Unknown terminalId: ${terminalId}`);
    if (terminal.sessionId !== sessionId) throw new Error(`Terminal ${terminalId} belongs to another session`);
    return terminal;
  }

  async #sessionPath(sessionId, requestedPath, allowMissing = false) {
    const roots = this.sessionRoots.get(sessionId) ?? [];
    const requested = resolve(requestedPath);
    let path;
    try {
      path = await realpath(requested);
    } catch (error) {
      if (!allowMissing || error?.code !== "ENOENT") throw error;
      path = join(await realpath(dirname(requested)), basename(requested));
    }
    if (!roots.some((root) => isWithin(root, path))) throw new Error(`Path is outside ACP session roots: ${path}`);
    if (this.protectedPaths.some((item) => isWithin(item, path))) throw new Error(`Path is protected by the Gateway: ${path}`);
    return path;
  }

  async #runProtectedOperation(id, method, params, run) {
    const policy = this.sessionPolicies.get(params.sessionId) ?? this.permissionPolicy;
    if (policy === "read_only") throw new Error("Session permission policy is read_only");
    if (policy === "auto_approve") {
      this.#respond(id, await run() ?? {});
      return;
    }
    const operationKind = method === "fs/write_text_file" ? "write" : "terminal";
    const sessionGrants = this.sessionOperationGrants.get(params.sessionId);
    const grants = sessionGrants?.get(operationKind) ?? 0;
    if (grants > 0) {
      sessionGrants.set(operationKind, grants - 1);
      this.#respond(id, await run() ?? {});
      return;
    }
    const options = [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" }
    ];
    this.#requirePendingInputCapacity(params.sessionId);
    await new Promise((done) => {
      this.pendingOperations.set(id, {
        sessionId: params.sessionId,
        operationKind,
        options,
        run,
        resolve: (result) => { this.#respond(id, result ?? {}); done(); },
        reject: (error) => { this.#respondError(id, -32001, error.message); done(); }
      });
      this.sessionHandlers.get(params.sessionId)?.({
        sessionUpdate: "permission_request",
        requestId: id,
        toolCall: { toolCallId: `client-${id}`, title: method, kind: method === "fs/write_text_file" ? "edit" : "execute" },
        options
      });
    });
  }

  #closeSessionTerminals(sessionId) {
    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.sessionId !== sessionId) continue;
      if (!terminal.exitStatus) terminateChild(terminal);
      this.terminals.delete(terminalId);
    }
  }

  #addOperationGrant(sessionId, operationKind) {
    if (!operationKind) return;
    let grants = this.sessionOperationGrants.get(sessionId);
    if (!grants) {
      grants = new Map();
      this.sessionOperationGrants.set(sessionId, grants);
    }
    grants.set(operationKind, (grants.get(operationKind) ?? 0) + 1);
  }

  #requirePendingInputCapacity(sessionId) {
    const pending = this.pendingSessionInput(sessionId);
    if (pending.permissions + pending.elicitations >= this.maxPendingRequestsPerSession) {
      throw new Error(`ACP session pending request limit exceeded: ${this.maxPendingRequestsPerSession}`);
    }
  }

  #requirePendingInputBytes(params) {
    const bytes = Buffer.byteLength(JSON.stringify(params ?? null));
    if (bytes > this.maxInboxItemBytes) {
      throw new Error(`ACP pending input payload exceeds ${this.maxInboxItemBytes} bytes`);
    }
  }

  #rejectSessionOperations(sessionId, error) {
    for (const [rpcId, operation] of this.pendingOperations) {
      if (operation.sessionId !== sessionId) continue;
      this.pendingOperations.delete(rpcId);
      operation.reject(error);
    }
  }

  #respond(id, result) {
    this.#send(LANE_HIGH, { jsonrpc: "2.0", id, result }, id);
  }

  #respondError(id, code, message) {
    this.#send(LANE_HIGH, { jsonrpc: "2.0", id, error: { code, message } });
  }

  // TRANSPORT_CLOSED stays swallowed exactly as the old optional-chained writes
  // did: a child that is already gone belongs to the provider-exit path. A frame
  // too large to send is different — the agent is blocking on that reply, so it
  // becomes a visible JSON-RPC error rather than silence. A notification or an
  // error frame has no id to answer on, so those two stay quiet.
  #send(lane, message, requestId = null) {
    try {
      this.channel?.write(lane, message);
      return true;
    } catch (error) {
      if (error?.code === ERROR_CODES.TRANSPORT_CLOSED) return false;
      if (error?.code === ERROR_CODES.FRAME_TOO_LARGE) {
        if (requestId != null) this.#respondError(requestId, -32000, error.message);
        return false;
      }
      throw error;
    }
  }

  #fail(error) {
    const wasAlive = this.alive;
    this.alive = false;
    // Silent teardown: destroy() never calls back into onFatal, which is what
    // keeps a fatal write from re-entering this same path.
    this.channel?.destroy(error);
    this.channel = null;
    this.clientRequests.clear();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.pendingPermissions.clear();
    this.pendingElicitations.clear();
    for (const operation of this.pendingOperations.values()) operation.reject(error);
    this.pendingOperations.clear();
    this.sessionOperationGrants.clear();
    for (const terminal of this.terminals.values()) {
      if (!terminal.exitStatus) terminateChild(terminal);
    }
    this.terminals.clear();
    this.proc = null;
    if (wasAlive) this.onExit?.(error);
  }
}

function grantKindForTool(toolKind) {
  if (toolKind === "edit" || toolKind === "delete" || toolKind === "move") return "write";
  if (toolKind === "execute") return "terminal";
  return null;
}

function killChild(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function terminateChild(terminal) {
  killChild(terminal.child, "SIGTERM");
  const timer = setTimeout(() => {
    if (!terminal.exitStatus) killChild(terminal.child, "SIGKILL");
  }, 2_000);
  timer.unref();
}

// The message keeps its historical "ACP error <code>: <message>" text. What is new
// is the stable code: a restore of a session the worker does not know is
// UNKNOWN_SESSION, anything else the worker refused is ACP_ERROR, and the worker's
// own code and message always travel in details for the caller to inspect.
const RESTORE_METHODS = new Set(["session/load", "session/resume"]);
// Only an error that is about the session itself: ACP resourceNotFound (-32002)
// or wording that names the session. A missing cwd, model or file ("Path not
// found.", "working directory does not exist") stays ACP_ERROR, because a caller
// that sees UNKNOWN_SESSION may discard a session that is still resumable.
const SESSION_NOT_FOUND_PATTERN = /\bsession(?: [\w.:-]+)?(?: was)? (?:not[\s_-]*found|does not exist)\b|\b(?:no such|unknown) session\b/i;

export function acpRequestError(method, error) {
  const acpCode = error?.code ?? null;
  const acpMessage = String(error?.message ?? "");
  const notFound = RESTORE_METHODS.has(method) && (acpCode === -32002 || SESSION_NOT_FOUND_PATTERN.test(acpMessage));
  return new GatewayError(
    notFound ? ERROR_CODES.UNKNOWN_SESSION : ERROR_CODES.ACP_ERROR,
    `ACP error ${acpCode ?? ""}: ${acpMessage}`,
    { method, acpCode, acpMessage, ...(error?.data === undefined ? {} : { acpData: error.data }) }
  );
}

// Several options can share one kind. codex-acp offers two reject_once options
// for the same request: "decline" (continue without running it) and "cancel"
// (stop and wait for new instructions). An automatic refusal must not end the
// whole turn, so among same-kind options one that lets the worker continue wins;
// a stopping option is used only when it is the only refusal offered.
const STOPPING_OPTION = /\b(cancel|abort|stop)\b|tell .* what to do differently/i;
const CONTINUING_OPTION = /\b(decline|deny|continue|skip)\b/i;

function preferContinuing(candidates) {
  if (candidates.length <= 1) return candidates[0];
  const describe = (item) => `${item.optionId ?? ""} ${item.name ?? ""}`;
  return candidates.find((item) => CONTINUING_OPTION.test(describe(item)) && !STOPPING_OPTION.test(describe(item)))
    ?? candidates.find((item) => !STOPPING_OPTION.test(describe(item)))
    ?? candidates[0];
}

const PATH_INPUT_KEYS = ["file_path", "path", "notebook_path", "filePath"];

function requestedPaths(toolCall) {
  const paths = [];
  for (const location of Array.isArray(toolCall?.locations) ? toolCall.locations : []) {
    if (typeof location?.path === "string" && location.path) paths.push(location.path);
  }
  const input = toolCall?.rawInput;
  if (input && typeof input === "object") {
    for (const key of PATH_INPUT_KEYS) if (typeof input[key] === "string" && input[key]) paths.push(input[key]);
  }
  return paths;
}

// Resolves the path the way the kernel will: segment by segment, following each
// existing symlink before the next ".." is applied. path.resolve() would fold
// "root/link/../x" into "root/x" lexically, while the kernel opens
// "<link target>/../x" — anywhere the link points. Synchronous because a
// permission decision cannot wait on I/O; segments that do not exist yet (a new
// file) are appended as written.
function canonicalizePhysical(path) {
  let current = "/";
  let physical = true;
  for (const segment of String(path).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    if (physical) {
      try {
        current = realpathSync(next);
        continue;
      } catch {
        physical = false;
      }
    }
    current = next;
  }
  return current;
}

// Path-looking words of a command line, resolved physically against the working
// directory: catches "cat link/../.acp-gateway/install.json" where the literal
// never names the protected directory. Best effort, like any shell parsing; the
// literal check above and the Grok/Claude sandbox rules are the other layers.
function commandPathsHitProtected(text, cwd, protectedPaths) {
  if (!text || !protectedPaths.length) return false;
  const words = String(text).replace(/["'\\]/g, "").split(/[\s;|&()<>=]+/);
  for (const word of words) {
    if (!word.includes("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) continue;
    const path = canonicalizePhysical(word.startsWith("/") ? word : `${cwd ?? ""}/${word}`);
    if (protectedPaths.some((item) => isWithin(item, path))) return true;
  }
  return false;
}

function commandText(input) {
  if (!input || typeof input !== "object") return "";
  const command = input.command ?? input.cmd;
  if (Array.isArray(command)) return command.join(" ");
  return typeof command === "string" ? command : "";
}

// Every spelling a shell would expand to a protected path: the canonical path,
// its /private-less form on macOS, and ~ / $HOME / ${HOME} forms under the home
// directory. A match must end at a path boundary so "/x/.acp-gateway-old" is not
// mistaken for "/x/.acp-gateway".
function mentionsProtectedPath(raw, protectedPaths) {
  if (!raw) return false;
  // Quotes and backslash escapes do not change which file a shell opens:
  // "$HOME"/.acp-gateway and $HOME/.acp-gateway are the same path.
  const text = String(raw).replace(/["'\\]/g, "");
  const home = process.env.HOME ?? "";
  for (const path of protectedPaths) {
    const forms = new Set([path, path.replace(/^\/private(?=\/)/, "")]);
    for (const form of [...forms]) {
      if (home && (form === home || form.startsWith(`${home}/`))) {
        const rel = form.slice(home.length);
        for (const prefix of ["~", "$HOME", "${HOME}"]) forms.add(`${prefix}${rel}`);
      }
    }
    for (const form of forms) {
      let index = text.indexOf(form);
      while (index !== -1) {
        const after = text[index + form.length];
        if (after === undefined || /[\s/'"`;:|&)]/.test(after)) return true;
        index = text.indexOf(form, index + 1);
      }
    }
  }
  return false;
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function canonicalRoots(cwd, additionalDirectories) {
  return await Promise.all([cwd, ...additionalDirectories].map((path) => realpath(resolve(path))));
}

export function requirePermissionPolicy(policy) {
  if (!PERMISSION_POLICIES.includes(policy)) {
    throw new Error(`permissionPolicy must be one of: ${PERMISSION_POLICIES.join(", ")}`);
  }
  return policy;
}
