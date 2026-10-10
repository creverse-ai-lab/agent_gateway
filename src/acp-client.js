import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { BoundedUtf8Text, readTextHead, readTextLines } from "./bounded-utf8.js";
import { workerEnv } from "./caller.js";
import { ERROR_CODES, GatewayError } from "./errors.js";
import { readNdjson } from "./ndjson.js";
import { LANE_HIGH, LANE_NORMAL, NdjsonChannel } from "./ndjson-channel.js";
import { startInApprovedCwd, TERMINAL_CWD_SHELL, terminalCwdChanged, terminalCwdGone } from "./terminal-cwd.js";
import { detectTerminalSandbox } from "./terminal-sandbox.js";
import { GATEWAY_VERSION } from "./version.js";
import { ACP_PROTOCOL_VERSION } from "./acp-version.js";
import { isWithin, openWorkerFile, requireWorkerPath, workerFilePathSync } from "./worker-files.js";

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
// How long a process the Gateway ends gets after SIGTERM before SIGKILL, and
// how long it then gets to be gone before a stop() stops waiting for it.
const KILL_GRACE_MS = 2_000;
// The provider's stderr kept for diagnostics, the newest characters.
const STDERR_TAIL_CHARS = 100_000;
// How many dropped provider frames a client notes in that tail; the rest are
// only counted, so a provider writing garbage in a loop neither crowds its own
// stderr out of the tail nor costs a copy of it per line.
const MAX_NOTED_FRAMES = 16;
// How often a process group being ended, a terminal's or the provider's, is
// checked for a member.
const GROUP_POLL_MS = 25;
// Approvals that wait for their operation, per session. Main has to click each
// one, so this only bounds what a long turn whose worker never consumes them
// (Codex runs its own commands) keeps; the oldest goes first, and a dropped one
// only means Main is asked again.
const MAX_GRANTS_PER_SESSION = 64;

// Lane C has no droppable traffic. Responses to agent-initiated requests and
// cancels are HIGH because the agent is blocked on them, so a dropped frame is a
// permanent deadlock; only the prompt, which can carry a megabyte, rides NORMAL.
function laneForRequest(method) {
  return method === "session/prompt" ? LANE_NORMAL : LANE_HIGH;
}

export class AcpClient {
  // The Gateway credentials no file a Worker reads may carry (the daemon's
  // Control token, through GatewayService). Private, so nothing that prints or
  // serializes a client can show them.
  #protectedSecrets = [];

  constructor(config, options = {}) {
    this.config = config;
    this.permissionPolicy = options.permissionPolicy ?? config.permissionPolicy;
    this.onExit = options.onExit;
    this.artifactStore = options.artifactStore ?? null;
    this.maxTerminalsPerSession = options.maxTerminalsPerSession ?? 16;
    this.maxPendingRequestsPerSession = options.maxPendingRequestsPerSession ?? 64;
    this.maxInboxItemBytes = options.maxInboxItemBytes ?? 64 * 1024;
    // The per-session byte budget of what waits for Main. A write or terminal
    // waiting for approval holds its whole payload (a write can carry most of a
    // 32 MiB frame), so it counts against this the way the inbox counts the
    // permission requests it holds (maxPendingInboxBytesPerSession).
    this.maxPendingInputBytesPerSession = options.maxPendingInputBytesPerSession ?? 512 * 1024;
    this.maxFrameBytes = options.maxFrameBytes ?? 32 * 1024 * 1024;
    this.maxFileReadBytes = options.maxFileReadBytes ?? 500_000;
    // The clamp that has always been here as a literal, now named. Same default,
    // so no behavior changes with it.
    this.maxTerminalOutputBytes = options.maxTerminalOutputBytes ?? 10_000_000;
    this.maxQueueBytes = options.maxQueueBytes ?? CHILD_STDIN_QUEUE_BYTES;
    // Canonical paths no session may touch, even when a root contains them.
    this.protectedPaths = [...(options.protectedPaths ?? [])];
    // An empty one would be in every text.
    this.#protectedSecrets = (options.protectedSecrets ?? []).filter((secret) => typeof secret === "string" && secret !== "");
    // What keeps a Gateway terminal off the protected paths besides the string
    // checks (terminal-sandbox.js): left out, whatever this OS offers; null,
    // none. Without one, auto_approve no longer starts terminals on its own.
    this.terminalSandbox = options.terminalSandbox === undefined ? detectTerminalSandbox() : options.terminalSandbox;
    // SIGTERM to SIGKILL for the provider and terminals, and what signals and
    // checks a terminal's process group, with process.kill's contract.
    // Injectable for tests.
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.killProcess = options.killProcess ?? signalProcess;
    this.writeTimeoutMs = options.writeTimeoutMs;
    // A test seam that runs between a write's approval-path pre-check and opening
    // the descriptor, where a racing worker would swap a parent directory.
    this.beforeWriteOpen = options.beforeWriteOpen ?? null;
    // A test seam that runs right before a terminal is spawned, after its cwd
    // was checked (and on Linux opened), with the cwd and the start about to be
    // spawned, where a racing worker would swap the directory. Synchronous:
    // nothing may come between the check and the spawn.
    this.beforeTerminalSpawn = options.beforeTerminalSpawn ?? null;
    // The shell that checks a starting terminal's cwd where a descriptor cannot
    // be one: dash, or null where there is none and the terminal starts by path
    // (terminal-cwd.js). Injectable for tests.
    this.terminalCwdShell = options.terminalCwdShell === undefined ? TERMINAL_CWD_SHELL : options.terminalCwdShell;
    this.proc = null;
    this.rl = null;
    this.channel = null;
    this.nextId = 1;
    this.pending = new Map();
    this.clientRequests = new Map();
    this.pendingPermissions = new Map();
    this.pendingElicitations = new Map();
    this.pendingOperations = new Map();
    // sessionId -> approvals Main gave a worker's execute or edit request, each
    // bound to the command or the files it named, until the turn ends.
    this.sessionOperationGrants = new Map();
    this.sessionHandlers = new Map();
    this.sessionRoots = new Map();
    this.sessionPolicies = new Map();
    this.terminals = new Map();
    // The pids of this client's provider and terminals, each from its spawn
    // until its exit (#trackSpawned). spawnedProcesses is the set the service
    // hands every client it creates (GatewayService.spawnedPids), kept by the
    // same rule, so it still holds a process after the service has let go of
    // this client; null when there is none.
    this.livePids = new Set();
    this.spawnedProcesses = options.spawnedProcesses ?? null;
    this.initResult = null;
    this.stderr = "";
    // Frames from the provider this client dropped as malformed (#noteDroppedFrame).
    this.droppedFrames = 0;
    this.alive = false;
  }

  async start() {
    if (this.alive) return this.initResult;

    // Session markers go from the inherited env only: they name the Main that
    // autostarted the daemon, and a worker carrying them would be recorded as
    // that Main. What the provider config sets explicitly is layered on top;
    // CODEX_HOME, CLAUDE_HOME and the other config paths are not markers. The
    // worker marker goes over both: a Control front door the worker's CLI
    // starts from the user's own MCP config sees it and refuses to run.
    // Detached on POSIX, like a terminal: the provider leads a process group of
    // its own, so ending it (endProvider) reaches what it started as well, an
    // adapter a launcher such as npx runs included. On Windows it is not, and
    // only the provider process itself is ended, as before.
    this.proc = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: workerEnv({ ...this.config.env, NO_COLOR: "1" }),
      detached: process.platform !== "win32",
      ...(this.config.cwd ? { cwd: this.config.cwd } : {})
    });
    this.#trackSpawned(this.proc);
    this.alive = true;
    this.proc.once("error", (error) => this.#fail(error));
    this.proc.once("close", (code, signal) => {
      this.#fail(new Error(`${this.config.provider} ACP exited code=${code} signal=${signal}`));
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    this.rl = readNdjson(this.proc.stdout, {
      maxLineBytes: this.maxFrameBytes,
      onLine: (line) => this.#onLine(line),
      // #fail runs the bounded SIGTERM -> SIGKILL teardown; a second SIGTERM
      // here would only race it.
      onOverflow: (error) => this.#fail(error)
    });
    // The write side of the same stdio. A child that stops reading its stdin can
    // no longer make the gateway grow without bound, and ten seconds of no write
    // progress ends the provider through the path that already handles its exit.
    this.channel = new NdjsonChannel(this.proc.stdin, {
      maxFrameBytes: this.maxFrameBytes,
      maxQueueBytes: this.maxQueueBytes,
      writeTimeoutMs: this.writeTimeoutMs,
      // Same as onOverflow: #fail escalates the provider on its own.
      onFatal: (error) => this.#fail(error)
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
    // SIGTERM, then SIGKILL after the grace, and each one waited for (bounded):
    // a provider or a terminal that ignores SIGTERM, or what either started in
    // its process group, must not outlive the stop that unloads them. The
    // references are dropped only after that wait, so the SIGKILL still has a
    // process to reach. The provider usually exits on the stdin EOF first.
    const proc = this.proc;
    proc?.stdin?.end();
    await Promise.all([
      proc ? endProvider(proc, this.killGraceMs) : null,
      ...[...this.terminals.values()].map((terminal) => endTerminal(terminal, this.killGraceMs, this.killProcess))
    ]);
    this.terminals.clear();
    this.proc = null;
    this.initResult = null;
  }

  // The pids of the processes this client spawned, the provider and its
  // terminals, each from its spawn until its exit (#trackSpawned). The daemon
  // refuses a control caller that is or runs under one of them (worker-tree.js,
  // through GatewayService.spawnedPids), which catches a worker even when the
  // daemon is pid 1. No teardown takes a pid out early: not #fail nulling
  // `proc`, not a terminal's record leaving `terminals`, not a stop() that gave
  // up waiting, since a process that ignores SIGTERM runs on until the SIGKILL
  // and what it starts meanwhile is still a worker's. Its exit takes it out at
  // once, even while a record lingers (a terminal's, until the worker releases
  // it): from then on the pid is the kernel's to reuse, and a reused pid must
  // not be taken for the process that had it.
  spawnedPids() {
    return [...this.livePids];
  }

  // A child counts from its spawn until its exit: its pid is added to this
  // client's set, and to the service's when there is one, and removed from both
  // on its "exit", which Node emits as it reaps the child, before the pid can
  // be reused, whatever has become of the handle or of this client by then. A
  // spawn that failed got no pid and is no process.
  #trackSpawned(child) {
    const pid = child.pid;
    if (!Number.isInteger(pid)) return;
    this.livePids.add(pid);
    this.spawnedProcesses?.add(pid);
    child.once("exit", () => {
      this.livePids.delete(pid);
      this.spawnedProcesses?.delete(pid);
    });
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
        sessionId: params?.sessionId ?? null,
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
    // The cancel rides the HIGH lane and the prompt NORMAL, so behind a provider
    // that is not reading its stdin a cancel would go out before its own prompt
    // still queued here, find no turn to stop, and the prompt would then start
    // the turn Main cancelled. Such a prompt never reached the worker: it is
    // taken back and settled as the cancelled turn it is. A prompt already
    // written is ahead of the cancel in the pipe, and the cancel follows it.
    if (this.#retractQueuedPrompt(sessionId) && !this.#promptSent(sessionId)) return;
    this.notify("session/cancel", { sessionId });
  }

  // Takes this session's prompts that are still queued in the channel, not yet
  // written to the provider, out of it, and settles each the way a worker
  // settles a cancelled turn. Whether there was one.
  #retractQueuedPrompt(sessionId) {
    const ids = [];
    this.channel?.dropWhere(LANE_NORMAL, (item) => {
      if (item.message?.method !== "session/prompt" || item.message.params?.sessionId !== sessionId) return false;
      ids.push(item.message.id);
      return true;
    });
    for (const id of ids) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.resolve({ stopReason: "cancelled" });
    }
    return ids.length > 0;
  }

  // Whether a prompt of this session is out with the provider, unanswered.
  #promptSent(sessionId) {
    for (const pending of this.pending.values()) {
      if (pending.method === "session/prompt" && pending.sessionId === sessionId) return true;
    }
    return false;
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
    // Approving an execute or edit request lets the worker carry out that
    // request through the Gateway: the command it named, or the files.
    if (pending.params.grant && optionId && (pending.params.options ?? []).some(
      (option) => option.optionId === optionId && /^allow_/.test(option.kind ?? "")
    )) {
      this.#addOperationGrant(pending.params.sessionId, pending.params.grant);
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

  // Every line the provider writes arrives here, inside its stdout "data"
  // callback, where a throw is an uncaught exception: one bad line would end
  // the daemon and every Main's sessions with it. So nothing a provider sends
  // may throw out of here. The envelope is checked before anything reads it
  // (#dispatch), and what can still fail once it is acted on, a session handler
  // that throws, is caught here.
  #onLine(line) {
    try {
      this.#dispatch(line);
    } catch (error) {
      this.#noteDroppedFrame(`it could not be handled: ${error?.message ?? String(error)}`);
    }
  }

  // A JSON-RPC object whose id, when there is one, is a string or a number,
  // whose method, when there is one, is a string, and whose params, when there
  // are any, are an object, as ACP's are: a request with any of that wrong is
  // answered with an error, since the worker waits on it, and so is an id with
  // no method, result or error, a request that lost its method; anything else
  // malformed is dropped (#noteDroppedFrame). A line that is not JSON at all is
  // ignored, as it always was: an adapter may print a banner.
  #dispatch(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isJsonObject(message)) {
      this.#noteDroppedFrame("it is not a JSON-RPC object");
      return;
    }
    const hasId = Object.hasOwn(message, "id");
    // Nothing to match it to, and nothing to answer it on.
    if (hasId && !isRequestId(message.id)) {
      this.#noteDroppedFrame("its id is neither a string nor a number");
      return;
    }

    if (hasId && (Object.hasOwn(message, "result") || message.error)) {
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

    // An id and nothing else, no method, result or error, is a request that lost
    // its method, and its sender may be waiting on that id; a response went to
    // its request above.
    const bareId = hasId && !["method", "result", "error"].some((key) => Object.hasOwn(message, key));
    const invalid = bareId
      ? { code: -32600, message: "Invalid Request: method is required" }
      : Object.hasOwn(message, "method") && typeof message.method !== "string"
        ? { code: -32600, message: "Invalid Request: method must be a string" }
        : Object.hasOwn(message, "params") && !isJsonObject(message.params)
          ? { code: -32602, message: "Invalid params: params must be an object" }
          : null;
    if (invalid) {
      this.#noteDroppedFrame(invalid.message);
      if (hasId) this.#respondError(message.id, invalid.code, invalid.message);
      return;
    }

    if (message.method === "session/update") {
      const params = message.params ?? {};
      this.sessionHandlers.get(params.sessionId)?.(params.update ?? params);
      return;
    }

    if (message.method && hasId) {
      // Each handler answers its own failures; what can still reject is an
      // answer the transport would not take, whose failure tears the transport
      // down on its own. Unhandled, that rejection would end the daemon.
      this.#handleAgentRequest(message).catch((error) => {
        this.#noteDroppedFrame(`its ${message.method} request failed: ${error?.message ?? String(error)}`);
      });
      return;
    }
    if (!message.method) this.#noteDroppedFrame("it is neither a request, a response nor a notification");
  }

  // A frame from the provider this client could not act on: counted, and the
  // first few noted in the stderr tail, which is where the Gateway shows a
  // provider's own account of itself when it fails to start. Nothing more: a
  // provider that writes garbage costs no more than one whose frames this
  // client ignores (each is bounded by the frame cap and handled as it
  // arrives), and what would cost more, a backlog it does not read or an
  // oversized line, already ends it (onFatal, onOverflow). So garbage, however
  // much, ends neither the provider nor the daemon.
  #noteDroppedFrame(reason) {
    this.droppedFrames += 1;
    if (this.droppedFrames > MAX_NOTED_FRAMES) return;
    const more = this.droppedFrames === MAX_NOTED_FRAMES ? "; any further ones are only counted" : "";
    this.stderr = `${this.stderr}[acp-gateway] dropped a frame from ${this.config.provider}: ${reason}${more}\n`.slice(-STDERR_TAIL_CHARS);
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
            options: (params.options ?? []).map((option) => ({ optionId: option.optionId, kind: option.kind })),
            // Taken now, from what Main is shown, not from a later request.
            grant: this.#grantFor(params)
          };
          this.pendingPermissions.set(id, { rpcId: id, params: retained });
          this.#announcePending(this.pendingPermissions, id, params.sessionId, {
            sessionUpdate: "permission_request",
            requestId: id,
            toolCall: params.toolCall,
            options: params.options
          });
        }
        return;
      }
      if (method === "elicitation/create") {
        if (!params.sessionId) throw new Error("Only session-scoped elicitation is supported");
        if (params.mode !== "form") throw new Error(`Unsupported elicitation mode: ${params.mode}`);
        this.#requirePendingInputCapacity(params.sessionId);
        this.#requirePendingInputBytes(params);
        this.pendingElicitations.set(id, { rpcId: id, params: { sessionId: params.sessionId } });
        this.#announcePending(this.pendingElicitations, id, params.sessionId, {
          sessionUpdate: "elicitation_request",
          requestId: id,
          mode: params.mode,
          message: params.message,
          requestedSchema: params.requestedSchema,
          toolCallId: params.toolCallId ?? null
        });
        return;
      }
      if (method === "fs/read_text_file") {
        this.#respond(id, await this.#readTextFile(params));
        return;
      }
      if (method === "fs/write_text_file") {
        await this.#runProtectedOperation(id, method, params);
        return;
      }
      if (method === "terminal/create") {
        await this.#runProtectedOperation(id, method, params);
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
    // A .acp-gateway path segment that resolves into nothing protected is
    // never decided automatically: auto_approve hands it to Main, read_only
    // refuses it.
    if (this.#namesGatewayDirectory(commandText(params.toolCall?.rawInput))) {
      return policy === "auto_approve" ? null : this.#selectPermission(params, ["reject_once", "reject_always"]);
    }
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
    if (this.#namesProtectedPath(commandText(params.toolCall?.rawInput), roots[0])) return "protected";
    let outside = false;
    for (const requested of requestedPaths(params.toolCall)) {
      const path = canonicalizePhysical(isAbsolute(requested) ? requested : `${roots[0] ?? ""}/${requested}`);
      if (this.protectedPaths.some((item) => isWithin(item, path))) return "protected";
      if (!roots.some((root) => isWithin(root, path))) outside = true;
    }
    return outside ? "outside" : "inside";
  }

  // The string checks on a command line, best effort: a protected path in any
  // spelling the shell would expand, and a word that resolves into one from
  // cwd. What they find is refused under every policy, before Main is asked.
  // Nothing to find when nothing is protected.
  #namesProtectedPath(command, cwd) {
    if (!command || !this.protectedPaths.length) return false;
    return mentionsProtectedPath(command, this.protectedPaths)
      || commandPathsHitProtected(command, cwd, this.protectedPaths);
  }

  // A command word with a .acp-gateway path segment. It may name the
  // directory holding the Control token from a cwd the checks never see
  // (`cd ~ && cat .acp-gateway/install.json`), or be only a search pattern
  // (`grep -rn ".acp-gateway" src`), so it is not refused, but not left to
  // auto_approve either: Main sees it first. Nothing when nothing is protected.
  #namesGatewayDirectory(command) {
    return this.protectedPaths.length > 0 && namesGatewayDirectory(command);
  }

  // The approval a worker's execute or edit permission request would become:
  // the command it names, or the files, in the form a later terminal/create or
  // fs/write_text_file is compared in. Null when it names none, and then
  // approving it lets nothing through on its own.
  #grantFor(params) {
    const kind = grantKindForTool(params.toolCall?.kind);
    if (kind === "terminal") {
      const command = approvedCommand(params.toolCall?.rawInput);
      // A command whose decisive variable the Gateway cannot know ahead of time
      // (indirect or arithmetic expansion names it at runtime) is never bound.
      if (!command || usesDynamicExpansion(command.text)) return null;
      // Bound to the cwd and the whole env Main approved, not the command alone:
      // the same argv in another directory, or with any variable added, removed
      // or changed (PATH, PYTHONPATH, one the command interpolates), may run
      // something Main did not see, so it is asked anew.
      const roots = this.sessionRoots.get(params.sessionId) ?? [];
      return { kind, command, cwd: grantCwd(params.toolCall?.rawInput?.cwd, roots), env: envMap(params.toolCall?.rawInput?.env) };
    }
    if (kind === "write") {
      // A relative path goes on the root as written, as #permissionScope reads
      // it: join() would fold a ".." away before the realpath could follow the
      // link in front of it, which the write it covers does follow.
      const root = this.sessionRoots.get(params.sessionId)?.[0] ?? "";
      const paths = new Set(requestedPaths(params.toolCall).map((path) => grantPath(isAbsolute(path) ? path : `${root}/${path}`)));
      return paths.size ? { kind, paths } : null;
    }
    return null;
  }

  // Truncate, never refuse: the ACP contract has no way to say "too large", and a
  // worker that asked for a file it cannot have would just retry. What changed is
  // that the cap is now bytes rather than UTF-16 code units (a CJK file used to
  // return up to ~1.5MB), and that nothing proportional to the file size is ever
  // allocated — a 2GB file costs the cap.
  async #readTextFile(params) {
    const cap = this.maxFileReadBytes;
    const windowed = params.line != null || params.limit != null;
    // Read through the descriptor that was verified, never by name again.
    const handle = await this.#openWorkerFile(params.sessionId, params.path);
    try {
      const read = windowed
        ? await readTextLines(handle, {
            line: Number(params.line ?? 1),
            limit: params.limit == null ? Infinity : Math.max(0, Number(params.limit)),
            maxBytes: cap
          })
        : await readTextHead(handle, cap);
      // Every check before this one is about names and inodes, and a copy of the
      // token file passes them, as does a hard link that outlived an atomic
      // rewrite of install.json where the installer could not empty the file it
      // replaced (replaceFile, best effort): it keeps the old inode, which is no
      // longer protected, and the same token. So the text itself must not carry
      // a credential the daemon accepts. Refused before anything is returned,
      // and the error says why, never what the file holds.
      if (this.#protectedSecrets.some((secret) => read.text.includes(secret))) {
        throw new Error("File holds a Gateway credential; the Gateway does not return its content");
      }
      // An untruncated answer stays byte-identical to every previous version: no
      // _meta key at all. Truncation used to be silent, which is the actual bug.
      if (!read.truncated) return { content: read.text };
      return {
        content: read.text,
        _meta: {
          "acp-gateway/read": {
            truncated: true,
            bytes: read.bytes,
            fileBytes: (await handle.stat()).size,
            maxBytes: cap,
            ...(windowed ? { line: Number(params.line ?? 1), limit: params.limit ?? null } : {})
          }
        }
      };
    } finally {
      await handle.close();
    }
  }

  // Bound to the file Main approved (approvedPath, the canonical target the
  // operation was shown as), not to params.path again: a worker that repoints a
  // symlink in params.path while the approval waits must not redirect the write
  // to another in-root file. The write opens the approved path directly and
  // refuses if params.path no longer resolves to it; the worker can re-request.
  async #writeTextFile(params, approvedPath, approvedTarget) {
    // Only the approved path is named in the error, never the path the worker
    // steered it to: that resolution skips the root/protected check, so echoing
    // it could report a path under ~/.acp-gateway back to the worker.
    let current;
    try {
      current = workerFilePathSync(params.path, { allowMissing: true });
    } catch {
      throw new Error(`Write target no longer resolves since it was approved: ${approvedPath}`);
    }
    if (current !== approvedPath) {
      throw new Error(`Write target changed since it was approved: ${approvedPath}`);
    }
    await this.beforeWriteOpen?.(approvedPath);
    const handle = await this.#openWorkerFile(params.sessionId, approvedPath, true);
    try {
      if (approvedTarget) {
        // A target that already existed when Main saw it must still be the same
        // file, not a new inode swapped onto the approved path in the meantime.
        const opened = await handle.stat({ bigint: true });
        if (opened.dev !== approvedTarget.dev || opened.ino !== approvedTarget.ino) {
          throw new Error(`Write target changed since it was approved: ${approvedPath}`);
        }
      } else {
        // A new file: openWorkerFile resolves the approved path's parent, so a
        // parent directory swapped for an in-root symlink after the pre-check
        // (O_NOFOLLOW guards only the final component) would have the file created
        // somewhere else in-root. The descriptor must be the approved path itself.
        await this.#requireApprovedNewFile(handle, approvedPath);
      }
      // Emptied only now, once the descriptor passed the check: an open that
      // truncated would already have cut whatever a swapped path led to.
      await handle.truncate(0);
      await handle.writeFile(String(params.content ?? ""), "utf8");
    } finally {
      await handle.close();
    }
  }

  // The descriptor just opened for a new file leads to the approved path and no
  // other. On Linux the descriptor's own name settles it (/proc); without /proc
  // the approved path must realpath to itself and to this very inode, which also
  // rejects a parent symlink swapped back after the open — the file is then not
  // at the approved path at all. The system realpath, as the approved path was
  // resolved with (workerFilePathSync), compared in NFC: HFS+ stores the new
  // name decomposed.
  async #requireApprovedNewFile(handle, approvedPath) {
    const changed = () => new Error(`Write target changed since it was approved: ${approvedPath}`);
    if (process.platform === "linux") {
      const actual = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
      if (actual !== null) {
        if (actual !== approvedPath) throw changed();
        return;
      }
    }
    let resolved;
    try {
      resolved = realpathSync.native(approvedPath);
    } catch {
      throw changed();
    }
    if (resolved.normalize("NFC") !== approvedPath.normalize("NFC")) throw changed();
    const opened = await handle.stat({ bigint: true });
    const onPath = statSync(approvedPath, { bigint: true });
    if (onPath.dev !== opened.dev || onPath.ino !== opened.ino) throw changed();
  }

  // A terminal/create, checked: cwd inside the roots, a command, args that are
  // strings, env entries whose name and value are strings, and no word that
  // names a protected path. Before Main is asked, so Main is never shown a
  // request that cannot run or that names a protected path, and again when the
  // terminal starts, which can be long after: then in approvedCwd, the
  // directory it was approved for, not params.cwd resolved anew
  // (#requireApprovedCwd).
  #terminalRequest(params, approvedCwd = null) {
    const roots = this.sessionRoots.get(params.sessionId) ?? [];
    const cwd = approvedCwd ?? this.#requestedTerminalCwd(params);
    if (!roots.some((root) => isWithin(root, cwd))) throw new Error(`Terminal cwd is outside ACP session roots: ${cwd}`);
    if (typeof params.command !== "string" || !params.command) throw new Error("Terminal command is required");
    const args = params.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new Error("Terminal args must be an array of strings");
    }
    // A value that is not a string (ACP's EnvVariable has a string value) would
    // not be what Main is shown or what a grant compares: spawn passes a null on
    // as "null", and a missing one unsets the variable the daemon has.
    const env = params.env ?? [];
    if (!Array.isArray(env) || env.some((entry) => typeof entry?.name !== "string" || typeof entry.value !== "string")) {
      throw new Error("Terminal env must be an array of {name, value}");
    }
    // A present-but-invalid outputByteLimit is refused here, before the spawn:
    // a non-finite one would otherwise reach BoundedUtf8Text as NaN and throw in
    // the stdout "data" callback, outside this request's try/catch. Absent uses
    // the default (#createTerminal).
    if (params.outputByteLimit != null) {
      const requested = Number(params.outputByteLimit);
      if (!Number.isFinite(requested) || requested < 1) {
        throw new Error("Terminal outputByteLimit must be a finite number of at least 1");
      }
    }
    if (this.#namesProtectedPath([params.command, ...args].join(" "), cwd)) {
      throw new Error("Terminal command names a path protected by the Gateway");
    }
    return { cwd, command: params.command, args, env };
  }

  // The directory a terminal/create names, links resolved the way the kernel
  // will: its cwd, or the session's when it names none. What a request is
  // checked in, and what a starting one is compared with (#requireApprovedCwd).
  // The system realpath with nothing lexical before it, as the session roots and
  // an approval's cwd (grantCwd) are resolved, so all three spell a directory
  // alike: a ".." after a link is applied where the link leads, and on a
  // case-insensitive macOS volume the case is the one on disk.
  #requestedTerminalCwd(params) {
    return realpathSync.native(params.cwd ?? this.sessionRoots.get(params.sessionId)?.[0] ?? process.cwd());
  }

  // The sandbox a terminal of this client runs in, or null: none is needed when
  // nothing is protected, and one that cannot apply a profile here is none.
  async #terminalSandboxReady() {
    if (!this.protectedPaths.length || !this.terminalSandbox) return null;
    try {
      return (await (this.terminalSandbox.ready?.() ?? true)) ? this.terminalSandbox : null;
    } catch {
      return null;
    }
  }

  // A terminal runs in the directory it was approved for, operation.cwd (the
  // canonical cwd Main is shown), only while params.cwd still leads there and
  // the directory there is the one that was there then (operation.cwdIdentity).
  // Bound like a pending write (#writeTextFile): a worker that re-points a
  // symlink in params.cwd, or puts another directory at the path, while Main
  // decides must not move the command into a directory Main never saw, however
  // much it is in-root. Only the approved cwd is named in the error, never
  // where the worker steered it, which no root or protected check has seen. A
  // terminal that starts at once (auto_approve, a grant) passes unless the
  // worker raced it. The start itself is bound to that directory as well, not
  // to its path (startInApprovedCwd), which closes the race between this check
  // and the child's chdir, except on a host with neither /proc nor dash, where
  // this check is the last one.
  #requireApprovedCwd(params, operation) {
    let current;
    let directory;
    try {
      current = this.#requestedTerminalCwd(params);
      directory = statSync(operation.cwd, { bigint: true });
    } catch {
      throw terminalCwdGone(operation.cwd);
    }
    if (current !== operation.cwd
      || directory.dev !== operation.cwdIdentity.dev || directory.ino !== operation.cwdIdentity.ino) {
      throw terminalCwdChanged(operation.cwd);
    }
  }

  async #createTerminal(params, operation) {
    const request = this.#terminalRequest(params, operation.cwd);
    // Before the limit check, which has to stay in one turn with the insert.
    const sandbox = await this.#terminalSandboxReady();
    // A stop() that began meanwhile would not wait for this terminal.
    if (!this.alive) throw new Error("ACP client stopped");
    const activeForSession = [...this.terminals.values()].filter((item) => item.sessionId === params.sessionId).length;
    if (activeForSession >= this.maxTerminalsPerSession) {
      throw new Error(`ACP session terminal limit exceeded: ${this.maxTerminalsPerSession}`);
    }
    // In the same turn as the spawn, after the last await, so a Worker that
    // swapped the directory while Main decided is refused here, with an error;
    // one that races these few synchronous steps meets the start itself, which
    // is bound to the directory and not to its path (startInApprovedCwd): on
    // Linux the child starts in the descriptor held here, elsewhere a dash
    // script refuses to run the command anywhere else, and only a host with
    // neither starts it by path, after this check.
    this.#requireApprovedCwd(params, operation);
    const terminalId = `terminal-${this.nextId++}`;
    // #terminalRequest already refused a present-but-invalid limit, so Number()
    // is finite here; floor keeps it the integer BoundedUtf8Text requires.
    const limit = Math.min(Math.max(Math.floor(Number(params.outputByteLimit ?? 1_000_000)), 1), this.maxTerminalOutputBytes);
    const launch = sandbox ? sandbox.wrap(request.command, request.args, this.protectedPaths) : request;
    const start = startInApprovedCwd(launch, operation.cwd, operation.cwdIdentity, { shell: this.terminalCwdShell });
    let child;
    try {
      this.beforeTerminalSpawn?.(operation.cwd, start);
      // Same scrub and marker as the worker's own env. What the worker asks for
      // explicitly is its own identity, not the Main's, and is kept; the marker
      // is not the worker's to remove.
      child = spawn(start.command, start.args, {
        cwd: start.cwd,
        env: workerEnv(Object.fromEntries(request.env.map(({ name, value }) => [name, value]))),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32"
      });
    } finally {
      start.release();
    }
    this.#trackSpawned(child);
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
    this.#terminate(terminal);
    this.terminals.delete(params.terminalId);
    return {};
  }

  async #waitForTerminalExit(params) {
    const terminal = this.#terminal(params.sessionId, params.terminalId);
    return await terminal.exited;
  }

  #killTerminal(params) {
    const terminal = this.#terminal(params.sessionId, params.terminalId);
    if (!terminal.exitStatus) killChild(terminal.child, params.signal ?? "SIGTERM", this.killProcess);
    return {};
  }

  #terminal(sessionId, terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Unknown terminalId: ${terminalId}`);
    if (terminal.sessionId !== sessionId) throw new Error(`Terminal ${terminalId} belongs to another session`);
    return terminal;
  }

  // The file a Worker's fs/ request names, opened once and verified
  // (worker-files.js); a write creates it when missing. An artifact is refused
  // by inode under any name: it sits deeper in the protected directory than the
  // inode check looks, so a hard link a Worker made to one would pass that
  // check (ArtifactStore#isArtifact).
  #openWorkerFile(sessionId, requestedPath, write = false) {
    const artifacts = this.artifactStore;
    return openWorkerFile(requestedPath, {
      roots: this.sessionRoots.get(sessionId) ?? [],
      protectedPaths: this.protectedPaths,
      isProtectedFile: typeof artifacts?.isArtifact === "function" ? (info) => artifacts.isArtifact(info) : null,
      write
    });
  }

  async #runProtectedOperation(id, method, params) {
    const policy = this.sessionPolicies.get(params.sessionId) ?? this.permissionPolicy;
    if (policy === "read_only") throw new Error("Session permission policy is read_only");
    // Checked before anything is decided: what cannot run is refused here and
    // never reaches Main, and what can is described the way Main will see it.
    const operation = method === "fs/write_text_file"
      ? this.#writeOperation(id, params)
      : this.#terminalOperation(id, params);
    // Built from the operation, so the write carries the canonical target Main
    // approved (operation.path) and the inode it had then (operation.target),
    // and the terminal its canonical cwd and that directory's inode.
    const run = operation.kind === "write"
      ? () => this.#writeTextFile(params, operation.path, operation.target)
      : () => this.#createTerminal(params, operation);
    // auto_approve runs a write, and a terminal the OS keeps off the protected
    // paths (or when nothing is protected). Without that, all that stands
    // between a terminal and install.json is its command line, which a shell
    // can always hide behind cd, a variable or a script, so Main sees it first;
    // as it does one whose command line has a .acp-gateway path segment.
    if (policy === "auto_approve" && (operation.kind === "write"
      || (!operation.namesGatewayDirectory && await this.#terminalConfined()))) {
      this.#respond(id, await run() ?? {});
      return;
    }
    if (this.#consumeGrant(params.sessionId, operation)) {
      this.#respond(id, await run() ?? {});
      return;
    }
    const options = [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" }
    ];
    this.#requirePendingInputCapacity(params.sessionId);
    this.#requirePendingOperationBytes(params.sessionId, operation.bytes);
    await new Promise((done) => {
      this.pendingOperations.set(id, {
        sessionId: params.sessionId,
        operationKind: operation.kind,
        bytes: operation.bytes,
        options,
        run,
        resolve: (result) => { this.#respond(id, result ?? {}); done(); },
        reject: (error) => { this.#respondError(id, -32001, error.message); done(); }
      });
      this.#announcePending(this.pendingOperations, id, params.sessionId, {
        sessionUpdate: "permission_request",
        requestId: id,
        toolCall: operation.toolCall,
        options
      });
    });
  }

  // A fs/write_text_file as Main is asked about it: the file, resolved the way
  // the write will resolve it, and the size. Refused now when the write could
  // not happen anyway (outside the roots, protected, no such directory).
  #writeOperation(id, params) {
    if (typeof params.path !== "string" || !params.path) throw new Error("Write path is required");
    const path = requireWorkerPath(workerFilePathSync(params.path, { allowMissing: true }), {
      roots: this.sessionRoots.get(params.sessionId) ?? [],
      protectedPaths: this.protectedPaths
    });
    // The inode of the target as it is now, when Main is shown this path, so the
    // write can tell an unchanged file apart from one swapped onto the path
    // later. A path with nothing at it yet (a new file) binds to the path alone.
    let target = null;
    try {
      const info = statSync(path, { bigint: true });
      if (info.isFile()) target = { dev: info.dev, ino: info.ino };
    } catch {
      // No pre-existing target.
    }
    const contentBytes = Buffer.byteLength(String(params.content ?? ""), "utf8");
    return {
      kind: "write",
      path,
      target,
      // What waiting for Main actually holds is the whole retained request, so a
      // worker cannot pad it with an unused field it does not pay the budget for.
      bytes: Buffer.byteLength(JSON.stringify(params)),
      toolCall: {
        toolCallId: `client-${id}`,
        title: `Write ${displayText(path)} (${contentBytes} ${contentBytes === 1 ? "byte" : "bytes"})`,
        kind: "edit",
        locations: [{ path }],
        rawInput: { path, bytes: contentBytes }
      }
    };
  }

  // A terminal/create as Main is asked about it: the command, its args, the
  // working directory, and the env it sets. The values of env that decide what
  // runs — the names that make the loader, an interpreter, a shell or a common
  // tool load or run code (PATH, LD_PRELOAD, PYTHONPATH, GIT_SSH_COMMAND, ...)
  // and any the command line interpolates — are shown, because hiding them
  // would let Main approve a command whose behaviour it never saw; every other
  // value stays hidden, as a worker-supplied credential should (a pending
  // request is persisted). cwd and env also ride the operation, so a grant is
  // spent only by a request with the same ones, and so is the inode of the cwd,
  // which the terminal must still find there when it starts.
  #terminalOperation(id, params) {
    const request = this.#terminalRequest(params);
    const argv = [request.command, ...request.args];
    const command = commandForm(argv);
    const decisive = interpolatedEnvNames(command.text);
    const directory = statSync(request.cwd, { bigint: true });
    return {
      kind: "terminal",
      command,
      cwd: request.cwd,
      cwdIdentity: { dev: directory.dev, ino: directory.ino },
      env: envMap(request.env),
      namesGatewayDirectory: this.#namesGatewayDirectory(argv.join(" ")),
      // What waiting for Main actually holds is the whole retained request, so a
      // worker cannot pad it with an unused field it does not pay the budget for.
      bytes: Buffer.byteLength(JSON.stringify(params)),
      toolCall: {
        toolCallId: `client-${id}`,
        title: `Run: ${displayText(displayCommand(request.command, request.args), TITLE_COMMAND_CHARS)}`,
        kind: "execute",
        rawInput: {
          command: request.command,
          args: request.args,
          cwd: request.cwd,
          env: request.env.map((entry) => (
            isExecutionEnvName(entry.name) || decisive.has(entry.name)
              ? { name: entry.name, value: entry.value }
              : { name: entry.name }
          ))
        }
      }
    };
  }

  // Whether a terminal of this client is kept off the protected paths by more
  // than its command line: by the OS sandbox, or because nothing is protected.
  async #terminalConfined() {
    return !this.protectedPaths.length || (await this.#terminalSandboxReady()) !== null;
  }

  #closeSessionTerminals(sessionId) {
    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.sessionId !== sessionId) continue;
      this.#terminate(terminal);
      this.terminals.delete(terminalId);
    }
  }

  // A terminal the Gateway is done with, ended through terminateChild without
  // waiting for it. Only one whose output is still open (endTerminal).
  #terminate(terminal) {
    if (!terminal.exitStatus) void terminateChild(terminal, this.killGraceMs, { kill: this.killProcess });
  }

  #addOperationGrant(sessionId, grant) {
    let grants = this.sessionOperationGrants.get(sessionId);
    if (!grants) {
      grants = [];
      this.sessionOperationGrants.set(sessionId, grants);
    }
    grants.push(grant);
    if (grants.length > MAX_GRANTS_PER_SESSION) grants.shift();
  }

  // Spends the approval that covers this operation, if one does: a terminal
  // whose command is the approved one, a write to an approved file. Each
  // approved file once, the command once. Anything else is asked about anew.
  #consumeGrant(sessionId, operation) {
    const grants = this.sessionOperationGrants.get(sessionId);
    const index = grants?.findIndex((grant) => {
      if (grant.kind !== operation.kind) return false;
      if (operation.kind === "write") return grant.paths.has(operation.path);
      // A terminal grant covers the operation only with the same command form
      // (a literal argv never matches a shell script, nor a login shell a
      // non-login one), the same cwd, and the same explicit env, every name and
      // every value. No list of the variables that make a program load code is
      // complete (PYTHONPATH, RUBYOPT, a git config, a shell's startup file, and
      // whatever a tool reads next), so a variable added, removed or changed is
      // asked about anew, whichever it is. A command using dynamic expansion is
      // never bound, so it never matches.
      if (usesDynamicExpansion(operation.command.text)) return false;
      return sameCommand(grant.command, operation.command)
        && grant.cwd === operation.cwd
        && sameEnv(grant.env, operation.env);
    }) ?? -1;
    if (index === -1) return false;
    const grant = grants[index];
    if (operation.kind === "write" && grant.paths.size > 1) grant.paths.delete(operation.path);
    else grants.splice(index, 1);
    if (!grants.length) this.sessionOperationGrants.delete(sessionId);
    return true;
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

  // What the session's operations waiting for Main hold, with this one. An
  // operation's bytes are released when it leaves pendingOperations, however
  // it ends.
  #requirePendingOperationBytes(sessionId, bytes) {
    let held = 0;
    for (const operation of this.pendingOperations.values()) {
      if (operation.sessionId === sessionId) held += operation.bytes;
    }
    if (held + bytes > this.maxPendingInputBytesPerSession) {
      throw new Error(`ACP session pending input byte budget exceeded (${held + bytes}/${this.maxPendingInputBytesPerSession})`);
    }
  }

  // Tells Main about a request just registered under id in pending, where it
  // waits for Main's answer. A handler that throws takes the registration back
  // with it, and the worker is answered with the error instead.
  #announcePending(pending, id, sessionId, update) {
    try {
      this.sessionHandlers.get(sessionId)?.(update);
    } catch (error) {
      pending.delete(id);
      throw error;
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
    for (const terminal of this.terminals.values()) this.#terminate(terminal);
    this.terminals.clear();
    // The same bounded SIGTERM -> SIGKILL teardown stop() uses, so a provider
    // that ignores SIGTERM on a fatal error is still escalated to SIGKILL rather
    // than leaked: the handle is captured first and dropped only after
    // endProvider has had it, never signalled only once and forgotten. The
    // synchronous rejections above are unchanged — the turn fails now, the reap
    // runs on its own.
    const proc = this.proc;
    this.proc = null;
    if (proc) void endProvider(proc, this.killGraceMs);
    if (wasAlive) this.onExit?.(error);
  }
}

function grantKindForTool(toolKind) {
  if (toolKind === "edit" || toolKind === "delete" || toolKind === "move") return "write";
  if (toolKind === "execute") return "terminal";
  return null;
}

// What signals and checks a process group: the provider's always, a terminal's
// unless a test injects its own (killProcess).
function signalProcess(pid, signal) {
  return process.kill(pid, signal);
}

// A terminal is detached, and so is the provider, so each leads a process group
// of its own, and a signal to the group reaches what it started as well.
function killChild(child, signal, kill = signalProcess) {
  try {
    if (process.platform !== "win32" && child.pid) kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

// Whether anything of a terminal's (or the provider's) process group is still
// there, the command or something it started, also after the command itself
// exited. A group id is not reused while the group has a member, so a group
// that answers is this one only until the group has once been found empty.
function groupAlive(child, kill = signalProcess) {
  if (!child.pid) return false;
  if (process.platform === "win32") return !exited(child);
  try {
    kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// SIGTERM to the terminal's group (or the provider's, endProvider) now, SIGKILL
// to whatever of it is left after the grace. Polled meanwhile, because the
// command may exit while what it started has not, and the SIGKILL stays armed
// only while the group still has a member: once the last one is gone its id is
// free, and a group of the same user that takes it before the grace ends is
// not this one. Resolves once the group is gone, or a second grace after the
// SIGKILL; its timers keep the process up only for a caller that waits (hold).
// Never throws or rejects: it runs on teardown paths and from timers.
function terminateChild(terminal, graceMs = KILL_GRACE_MS, { kill = signalProcess, hold = false } = {}) {
  const { child } = terminal;
  const gone = () => !groupAlive(child, kill);
  quietly(() => killChild(child, "SIGTERM", kill));
  return new Promise((done) => {
    if (gone()) {
      done();
      return;
    }
    const timer = (handle) => (hold ? handle : handle.unref());
    let giveUp = null;
    const finish = () => {
      clearInterval(poll);
      clearTimeout(sigkill);
      clearTimeout(giveUp);
      done();
    };
    const poll = timer(setInterval(() => {
      if (gone()) finish();
    }, GROUP_POLL_MS));
    const sigkill = timer(setTimeout(() => {
      if (gone()) {
        finish();
        return;
      }
      quietly(() => killChild(child, "SIGKILL", kill));
      giveUp = timer(setTimeout(finish, graceMs));
    }, graceMs));
  });
}

// stop(): a terminal through terminateChild, and waited for. Only one whose
// output is still open, like every other teardown: a terminal that exited and
// closed it long ago may have left a group id that is free again, and could by
// now be anyone's.
async function endTerminal(terminal, graceMs, kill) {
  if (terminal.exitStatus) return;
  await terminateChild(terminal, graceMs, { kill, hold: true });
}

// stop() and #fail(): the provider, detached like a terminal, through the same
// terminateChild, so the SIGTERM, the grace and the SIGKILL reach its whole
// process group: a launcher that exits on the SIGTERM no longer leaves the
// adapter it started running, deaf to the signal and to its closed stdin.
// Also once the provider itself has exited, as long as its group has a member
// left, since the group id is not reused until it has none. With process.kill,
// not a test's killProcess, which stands in for a terminal's group. On Windows
// the provider process alone, as before (killChild, groupAlive).
async function endProvider(child, graceMs) {
  if (!child.pid) return;
  await terminateChild({ child }, graceMs, { hold: true });
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function quietly(action) {
  try {
    action();
  } catch {
    // Already gone, or not ours to signal: nothing more a teardown can do.
  }
}

// An object as JSON-RPC means it: not null, not an array.
function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A JSON-RPC id that can be matched and answered: ACP's are strings or
// integers. A number past what JSON can carry back (1e999 parses to Infinity)
// would be answered as null.
function isRequestId(value) {
  return typeof value === "string" || Number.isFinite(value);
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
// file) are appended as written. Each one by the system realpath, which the
// roots and protected paths it is compared with were resolved by, so it takes
// the case on disk on a case-insensitive macOS volume as they do.
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
        current = realpathSync.native(next);
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
// literal check above, the .acp-gateway segment that keeps a command from
// auto_approve, the Grok/Claude sandbox rules and the terminal sandbox
// (terminal-sandbox.js) are the other layers.
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
  if (typeof command !== "string") return "";
  return Array.isArray(input.args) ? [command, ...input.args].join(" ") : command;
}

// The directory that holds the Control token. A command word with a path
// segment of this name may point there wherever it resolves from: in
// `cd ~ && cat .acp-gateway/install.json` the path resolves against a cwd the
// checks never see. It is also how a search for the name is spelled, so it
// only sends the command to Main (#namesGatewayDirectory).
const GATEWAY_DIRECTORY = ".acp-gateway";

function namesGatewayDirectory(text) {
  return String(text).replace(/["'\\]/g, "").split(/[\s;|&()<>=`{},:]+/)
    .some((word) => word.split("/").includes(GATEWAY_DIRECTORY));
}

// An approval and the terminal/create that spends it are compared as commands.
// A command is its argv, compared word for word (sameCommand): a literal argv, a
// `sh -c` script, and a login shell are different arrays and never authorize one
// another, so approving `["echo","a; ./x"]` (which spawn runs verbatim) does not
// cover `["sh","-c","echo a; ./x"]`, and the same shell request is spent only by
// the identical one. The Gateway never tries to prove a script equals an argv —
// a different shape is simply re-asked. A bare command-line *string* (some
// providers' execute request) is tokenized to an argv only when it is plain
// words; a line carrying any shell syntax stays opaque and matches nothing, so
// it can never stand in for a tokenized command.
// Shell syntax that makes a line more than its plain words: an operator,
// redirection, expansion, command substitution, glob, brace/tilde, assignment,
// an escape, or a comment. A space and a tab are omitted on purpose — they
// separate words; any OTHER blank (newline, VT, FF, NBSP, …) is rejected in the
// tokenizer, because it is not a word separator a shell would honour.
const SHELL_META = /[;&|<>()$`\\*?[\]{}~=#]/;

// The comparable form of an argv: its exact words, and a flat text used ONLY to
// scan which env names the command interpolates (never for equality).
function commandForm(argv) {
  const words = argv.map(String);
  return { argv: words, text: words.join(" ") };
}

// The comparable form of a bare command-line string: tokenized to an argv when
// it is plain quoted words, so a string approval and a later argv terminal
// compare; otherwise opaque (argv null), an array no request can equal.
function shellCommand(text) {
  const tokens = tokenizePlainLine(text);
  return tokens ? { argv: tokens, text: tokens.join(" ") } : { argv: null, text: String(text) };
}

// A command line split into argv, or null when it carries shell syntax an argv
// cannot faithfully stand for. A field is EITHER a bare run of non-quote
// characters OR one wholly single- or double-quoted word; a quote that is not
// the whole field, an unclosed quote, a bare word containing a quote, or any
// blank that is not a space or tab makes the line opaque. Only space and tab
// separate words.
function tokenizePlainLine(text) {
  const line = String(text);
  // Any whitespace that is not a plain space or tab (newline, VT, FF, NBSP, …)
  // is not a word separator a shell honours, so the line is opaque.
  if (SHELL_META.test(line) || /[^\S \t]/.test(line)) return null;
  const tokens = [];
  const length = line.length;
  let index = 0;
  while (index < length) {
    while (index < length && (line[index] === " " || line[index] === "\t")) index += 1;
    if (index >= length) break;
    const char = line[index];
    if (char === "'" || char === "\"") {
      const end = line.indexOf(char, index + 1);
      if (end === -1) return null;
      const after = line[end + 1];
      if (after !== undefined && after !== " " && after !== "\t") return null;
      tokens.push(line.slice(index + 1, end));
      index = end + 1;
    } else {
      let stop = index;
      while (stop < length && line[stop] !== " " && line[stop] !== "\t") {
        if (line[stop] === "'" || line[stop] === "\"") return null;
        stop += 1;
      }
      tokens.push(line.slice(index, stop));
      index = stop;
    }
  }
  return tokens.length ? tokens : null;
}

// Two commands match only when both are argvs of equal length and equal words;
// an opaque line (argv null) matches nothing.
function sameCommand(a, b) {
  if (!a.argv || !b.argv || a.argv.length !== b.argv.length) return false;
  return a.argv.every((word, index) => word === b.argv[index]);
}

// Indirect (`${!NAME}`) or arithmetic (`$((...))` / `$[...]`) expansion reads a
// variable the Gateway cannot name ahead of time, so a grant is never bound to a
// command that uses it — such a command is asked about every time.
function usesDynamicExpansion(text) {
  return /\$\{!/.test(text) || /\$\(\(/.test(text) || /\$\[/.test(text);
}

// The command an execute permission request names, in comparable form, or null
// when it names none: an array (Codex) or a command with args is an argv, a bare
// string a command line.
function approvedCommand(input) {
  if (!input || typeof input !== "object") return null;
  const command = input.command ?? input.cmd;
  if (Array.isArray(command)) return commandForm(command);
  if (typeof command !== "string") return null;
  return Array.isArray(input.args) ? commandForm([command, ...input.args]) : shellCommand(command);
}

// The file a path names, resolved the way fs/write_text_file resolves it, so an
// approved path and a later write compare as files. One that does not resolve
// stays as written: a write to it fails on its own.
function grantPath(path) {
  try {
    return workerFilePathSync(path, { allowMissing: true });
  } catch {
    return resolve(path);
  }
}

// The cwd an execute approval was given for, canonical, the way #terminalRequest
// resolves a terminal's cwd (#requestedTerminalCwd), so the two compare: the
// request's own cwd, or the session root when it named none.
function grantCwd(rawCwd, roots) {
  const base = rawCwd != null && rawCwd !== "" ? String(rawCwd) : (roots[0] ?? process.cwd());
  try {
    return realpathSync.native(base);
  } catch {
    return resolve(base);
  }
}

// Env vars that change which program runs or make it load or run other code,
// not data a command reads: a pending terminal shows Main their values (a grant
// compares every variable regardless, #consumeGrant). The glibc loader
// injection vars (LD_PRELOAD, LD_AUDIT, LD_LIBRARY_PATH, GCONV_PATH) run
// attacker code at load time as surely as PATH does. An interpreter's search
// paths and startup options, a shell's startup files and hooks, the config
// directories git and most tools take commands from, and the programs a common
// tool starts on its own (an editor, a pager, git's ssh) do the same a step
// later. The common ones, not every one: a value left hidden is still compared.
const EXECUTION_ENV_NAMES = new Set([
  "PATH", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "GCONV_PATH",
  "NODE_OPTIONS", "NODE_PATH",
  "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONUSERBASE",
  "PERL5LIB", "PERLLIB", "PERL5OPT",
  "RUBYLIB", "RUBYOPT", "GEM_HOME", "GEM_PATH", "BUNDLE_GEMFILE",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH",
  "LUA_PATH", "LUA_CPATH", "LUA_INIT",
  "BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS", "PS4",
  "HOME", "XDG_CONFIG_HOME",
  "GIT_DIR", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER", "GIT_PROXY_COMMAND", "GIT_EXTERNAL_DIFF",
  "EDITOR", "VISUAL", "PAGER", "MANPAGER", "LESSOPEN", "LESSCLOSE"
]);
// The same by prefix: the macOS loader's DYLD_*, git's numbered config pairs
// (GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n>), and the functions bash imports
// from the env (BASH_FUNC_<name>%%), which can stand in for any command.
const EXECUTION_ENV_PREFIXES = ["DYLD_", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_", "BASH_FUNC_"];

function isExecutionEnvName(name) {
  return EXECUTION_ENV_NAMES.has(name) || EXECUTION_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// The names a command line interpolates ($NAME or ${NAME}). Their values are
// part of what runs, so Main sees them like the execution-affecting names.
function interpolatedEnvNames(commandLine) {
  const names = new Set();
  const pattern = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
  let match;
  while ((match = pattern.exec(commandLine)) !== null) names.add(match[1]);
  return names;
}

// A worker-set env, as an ACP [{name, value}] array or a plain object, as a
// name -> value map.
function envMap(env) {
  const map = new Map();
  if (Array.isArray(env)) {
    for (const entry of env) if (typeof entry?.name === "string") map.set(entry.name, String(entry.value ?? ""));
  } else if (env && typeof env === "object") {
    for (const [name, value] of Object.entries(env)) map.set(name, String(value ?? ""));
  }
  return map;
}

// Two env maps with the same names, each with the same value.
function sameEnv(a, b) {
  if (a.size !== b.size) return false;
  for (const [name, value] of a) if (b.get(name) !== value) return false;
  return true;
}

// What Main reads in a pending terminal's title: argv as a shell would spell
// it, a word with spaces or shell syntax single-quoted, so `sh -c 'cat "$T"'`
// reads as the three words it is. The exact values are in rawInput.
const TITLE_COMMAND_CHARS = 200;

function displayCommand(command, args) {
  return [command, ...args]
    .map((word) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`)
    .join(" ");
}

// A title stays one line: control characters escaped, and cut at maxChars.
function displayText(text, maxChars = Infinity) {
  const line = String(text).replace(/[\u0000-\u001f\u007f]/g, (character) => (
    character === "\n" ? "\\n" : character === "\t" ? "\\t" : `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`
  ));
  const characters = [...line];
  return characters.length > maxChars ? `${characters.slice(0, maxChars - 1).join("")}…` : line;
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

// The session roots by the system realpath, with nothing lexical before it:
// what every Worker path, approval and terminal cwd is resolved by and compared
// with (worker-files.js).
async function canonicalRoots(cwd, additionalDirectories) {
  return await Promise.all([cwd, ...additionalDirectories].map((path) => realpath(path)));
}

export function requirePermissionPolicy(policy) {
  if (!PERMISSION_POLICIES.includes(policy)) {
    throw new Error(`permissionPolicy must be one of: ${PERMISSION_POLICIES.join(", ")}`);
  }
  return policy;
}
