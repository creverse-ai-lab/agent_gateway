import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AcpClient } from "../src/acp-client.js";
import { agentFromCommand, callerForCall, callerFromProcess, normalizeCaller, withoutSessionMarkers } from "../src/caller.js";
import { GatewayService } from "../src/gateway-service.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { daemonPaths, startDaemon, writeMockProviders } from "./helpers/daemon-harness.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const permissionAgent = fileURLToPath(new URL("./mock-permission-agent.js", import.meta.url));
const frontDoor = fileURLToPath(new URL("../src/index.js", import.meta.url));
const CLAUDE_ID = "625cbd07-50b1-4ffa-b0bd-368891bb5085";
// The normalized shape: what the daemon records for a caller of this build.
const claudeCaller = { provider: "claude", sessionId: CLAUDE_ID, pid: 4242, instanceId: "mcp-a" };
const codexCaller = { provider: "codex", sessionId: null, pid: 5151, instanceId: "mcp-b" };
// What codex-cli 0.155.1 puts in params._meta of every tools/call.
const THREAD = "019a4c7e-5a1b-7c2d-8e3f-0123456789ab";
const TURN = "019a4c7e-5a1b-7c2d-8e3f-0123456789cd";
function codexMeta(thread = THREAD, turn = TURN) {
  return {
    progressToken: 3,
    threadId: thread,
    "x-codex-turn-metadata": { session_id: thread, thread_id: thread, turn_id: turn, sandbox: "workspace-write" }
  };
}

test("the caller is the parent agent CLI and the session id it exported", () => {
  assert.equal(agentFromCommand("/Users/x/.local/bin/claude"), "claude");
  assert.equal(agentFromCommand("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"), "codex");
  assert.equal(agentFromCommand("grok"), "grok");
  assert.equal(agentFromCommand("/usr/bin/python3"), null);

  const claude = callerFromProcess({ env: { CLAUDE_CODE_SESSION_ID: CLAUDE_ID }, ppid: 4242, readCommand: () => "claude" });
  assert.equal(claude.provider, "claude");
  assert.equal(claude.sessionId, CLAUDE_ID);
  assert.equal(claude.pid, 4242);
  assert.match(claude.instanceId, /^mcp-/);
  assert.notEqual(callerFromProcess({ env: {}, ppid: 4242, readCommand: () => "claude" }).instanceId, claude.instanceId,
    "every control server process is its own instance");

  // A grok started from a Claude shell inherits Claude's id: the parent decides.
  const grok = callerFromProcess({
    env: { CLAUDE_CODE_SESSION_ID: CLAUDE_ID, GROK_SESSION_ID: "01a0e5c0-aaaa" }, ppid: 7, readCommand: () => "grok"
  });
  assert.deepEqual([grok.provider, grok.sessionId], ["grok", "01a0e5c0-aaaa"]);

  // Codex exports no thread id: the provider and instance still identify it.
  const codex = callerFromProcess({ env: {}, ppid: 5151, readCommand: () => "codex" });
  assert.deepEqual([codex.provider, codex.sessionId], ["codex", null]);

  // Without a readable parent, one unambiguous marker is enough; two are not.
  assert.equal(callerFromProcess({ env: { GROK_SESSION_ID: "g1" }, ppid: 7, readCommand: () => null }).provider, "grok");
  assert.equal(callerFromProcess({
    env: { CLAUDE_CODE_SESSION_ID: CLAUDE_ID, GROK_SESSION_ID: "g1" }, ppid: 7, readCommand: () => null
  }).provider, null);
});

test("a process name matches a provider by whole token, and an ambiguous one matches none", () => {
  const table = {
    claude: "claude",
    "Claude Helper": "claude",
    codex: "codex",
    "codex-acp": "codex",
    grok: "grok",
    "grok-codex-bridge": null,
    node: null,
    "/opt/homebrew/bin/codex": "codex",
    // Substrings used to match: a name that merely contains a provider is not it.
    claudette: null,
    "": null
  };
  for (const [command, expected] of Object.entries(table)) {
    assert.equal(agentFromCommand(command), expected, JSON.stringify(command));
  }
  assert.equal(callerFromProcess({ env: {}, ppid: 7, readCommand: () => "grok-codex-bridge" }).provider, null);
});

test("a malformed caller loses attribution, never the call", () => {
  assert.equal(normalizeCaller(null), null);
  assert.equal(normalizeCaller({ provider: "claude" }), null, "no instance, no caller");
  assert.deepEqual(
    normalizeCaller({ provider: "other", sessionId: "bad value", pid: 1, instanceId: "mcp-x", turnId: "t".repeat(129), extra: "dropped" }),
    { provider: null, sessionId: null, pid: null, instanceId: "mcp-x" }
  );
  assert.equal(normalizeCaller({ ...codexCaller, turnId: TURN }).turnId, TURN, "a well-formed turn id is kept");
  assert.equal(normalizeCaller({ ...codexCaller, viaSession: "acp-x" }).viaSession, undefined,
    "viaSession is the Gateway's finding, never a caller's claim");
});

test("each Codex call names its own thread and turn; the process caller is never changed", () => {
  const base = Object.freeze({ ...codexCaller });
  const call = callerForCall(base, codexMeta());
  assert.deepEqual(call, { ...codexCaller, sessionId: THREAD, turnId: TURN });
  assert.deepEqual(normalizeCaller(call), call, "the daemon keeps what the front door sent");
  assert.deepEqual(base, codexCaller, "a copy: the next call from another thread starts from the same base");

  // threadId first, then the turn metadata's thread_id; each validated.
  assert.equal(callerForCall(base, { "x-codex-turn-metadata": { thread_id: THREAD, turn_id: TURN } }).sessionId, THREAD);
  assert.equal(callerForCall(base, { threadId: "bad value", "x-codex-turn-metadata": { thread_id: THREAD } }).sessionId, THREAD);
  assert.deepEqual(callerForCall(base, { threadId: THREAD }), { ...codexCaller, sessionId: THREAD });
  const oversized = "t".repeat(129);
  assert.equal(callerForCall(base, codexMeta(oversized, TURN)), base, "no valid thread: nothing to add");
  assert.equal(callerForCall(base, { threadId: 42, "x-codex-turn-metadata": "thread" }), base);
  assert.equal(Object.hasOwn(callerForCall(base, codexMeta(THREAD, oversized)), "turnId"), false);
  assert.equal(Object.hasOwn(callerForCall(base, codexMeta(THREAD, { id: TURN })), "turnId"), false);
  for (const meta of [undefined, null, "meta", [THREAD], 7]) assert.equal(callerForCall(base, meta), base);
});

test("Codex metadata names the provider only when the parent could not", () => {
  const unknown = { provider: null, sessionId: null, pid: 9, instanceId: "mcp-u" };
  assert.deepEqual(callerForCall(unknown, codexMeta()), { ...unknown, provider: "codex", sessionId: THREAD, turnId: TURN });
  assert.equal(callerForCall(unknown, { threadId: THREAD }), unknown, "a bare threadId is not proof of Codex");
  // Another CLI's parent is a fact; its _meta is not read at all.
  assert.equal(callerForCall(claudeCaller, codexMeta()), claudeCaller);
  assert.equal(callerForCall(claudeCaller, { "claudecode/toolUseId": "toolu_1" }), claudeCaller);
  assert.equal(callerForCall(null, codexMeta()), null);
});

function makeService(directory) {
  return new GatewayService({
    statePath: join(directory, "state.json"),
    createClient: (_provider, clientOptions) =>
      new AcpClient(
        { provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "read_only" },
        clientOptions
      ),
    gcIntervalMs: 0
  });
}

async function waitForIdle(service, sessionId, context) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const poll = await service.call("poll", { sessionId, cursor: 0, waitMs: 100 }, context);
    if (poll.status === "idle") return poll;
  }
  throw new Error("session never became idle");
}

function makePermissionService() {
  return new GatewayService({
    createClient: (_provider, clientOptions) =>
      new AcpClient(
        { provider: "mock", command: process.execPath, args: [permissionAgent], permissionPolicy: "read_only" },
        clientOptions
      ),
    gcIntervalMs: 0
  });
}

async function turnStart(service, sessionId, context) {
  const { events } = await service.call("poll", { sessionId, cursor: 0, eventTypes: ["turn_start"] }, context);
  return events.find((event) => event.type === "turn_start");
}

test("a session records who opened it and each turn who started it, across a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-caller-"));
  const opener = { rootId: "main-a", caller: claudeCaller };
  const prompter = { rootId: "main-a", caller: codexCaller };
  let sessionId = null;
  try {
    const first = makeService(directory);
    try {
      await first.init();
      const opened = await first.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, opener);
      sessionId = opened.sessionId;
      assert.deepEqual(opened.openedBy, claudeCaller);
      assert.equal(Object.hasOwn(opened, "attribution"), false, "an attributed session is unchanged");

      await first.call("prompt", { sessionId, prompt: "narrated-result" }, prompter);
      await waitForIdle(first, sessionId, opener);
      assert.deepEqual((await turnStart(first, sessionId, opener)).promptedBy, codexCaller,
        "the reply belongs to the Main that prompted");

      const [listed] = (await first.call("session", { action: "list" }, opener)).sessions;
      assert.deepEqual(listed.openedBy, claudeCaller, "opening is history: a later prompter does not rewrite it");
      assert.deepEqual(listed.promptedBy, codexCaller);
    } finally {
      await first.shutdown();
    }

    const second = makeService(directory);
    try {
      await second.init();
      const [restored] = (await second.call("session", { action: "list" }, { rootId: "main-a" })).sessions;
      assert.equal(restored.sessionId, sessionId);
      assert.deepEqual(restored.openedBy, claudeCaller);
      assert.deepEqual(restored.promptedBy, codexCaller);
    } finally {
      await second.shutdown();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a caller that says nothing keeps the old shapes, plus attribution none outside poll", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-caller-none-"));
  const context = { rootId: "main-a" };
  let sessionId = null;
  try {
    const service = makeService(directory);
    try {
      await service.init();
      const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, context);
      sessionId = opened.sessionId;
      assert.equal("openedBy" in opened, false);
      assert.equal(opened.attribution, "none");
      const ack = await service.call("prompt", { sessionId, prompt: "narrated-result" }, context);
      assert.equal("promptedBy" in ack, false, "no caller, nothing to echo");
      await waitForIdle(service, sessionId, context);
      assert.equal("promptedBy" in (await turnStart(service, sessionId, context)), false);
      // Quiet: no poll profile grows.
      for (const responseProfile of [undefined, "current", "compact", "diagnostic"]) {
        const poll = await service.call("poll", { sessionId, cursor: 0, ...(responseProfile ? { responseProfile } : {}) }, context);
        assert.equal(Object.hasOwn(poll, "attribution"), false, responseProfile ?? "default");
      }
      assert.equal((await service.call("session", { action: "get", sessionId }, context)).attribution, "none");
      assert.equal((await service.call("session", { action: "list" }, context)).sessions[0].attribution, "none");
      assert.equal(service.legacyControlRequests, 0, "an embedded caller is not a front door");
    } finally {
      await service.shutdown();
    }

    // A record written without openedBy (here, or by a pre-1.6 Gateway) reads
    // back the same way.
    const restarted = makeService(directory);
    try {
      await restarted.init();
      const [restored] = (await restarted.call("session", { action: "list" }, context)).sessions;
      assert.equal(restored.sessionId, sessionId);
      assert.equal(restored.attribution, "none");
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prompt, run and task acknowledgements echo the caller the turn is recorded under", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-caller-echo-"));
  const service = makeService(directory);
  const main = { rootId: "main-a", caller: claudeCaller };
  try {
    await service.init();
    const { sessionId } = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "ask" }, main);

    const ack = await service.call("prompt", { sessionId, prompt: "narrated-result" }, main);
    assert.deepEqual(ack.promptedBy, claudeCaller);
    assert.deepEqual((await turnStart(service, sessionId, main)).promptedBy, claudeCaller,
      "turn_start carries the same object, instanceId included");
    await waitForIdle(service, sessionId, main);

    const task = await service.call("task_prompt", { sessionId, prompt: "narrated-result" }, main);
    assert.deepEqual(task.promptedBy, claudeCaller);
    await waitForIdle(service, sessionId, main);

    // The default mock prompt waits on a permission, so this run cannot finish
    // before its start acknowledgement is built.
    const started = await service.call("run", { sessionId, prompt: "hold", waitMs: 0 }, main);
    assert.ok(["working", "input_required"].includes(started.status), started.status);
    assert.deepEqual(started.promptedBy, claudeCaller);
    const attached = await service.call("run", { taskId: started.taskId, waitMs: 2_000 }, main);
    assert.equal(attached.status, "input_required");
    assert.equal(Object.hasOwn(attached, "promptedBy"), false, "an attach started nothing");
    await service.call("permission", { sessionId, requestId: attached.pending.requestId, optionId: "allow-once" }, main);
    const finished = await service.call("run", { taskId: started.taskId, waitMs: 10_000 }, main);
    assert.equal(finished.result.text, "DONE");
    assert.equal(Object.hasOwn(finished, "promptedBy"), false, "the terminal envelope is tasks/result's, untouched");
  } finally {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a worker acting as a Main is marked viaSession while its session is open", async () => {
  const service = makePermissionService();
  const main = { rootId: "main-a", caller: claudeCaller };
  try {
    await service.init();
    const worker = await service.call("session_open", { provider: "claude", cwd: tmpdir(), permissionPolicy: "read_only" }, main);
    assert.equal(Object.hasOwn(worker.openedBy, "viaSession"), false);
    // The worker's own control server reports its ACP session id as its session.
    const asWorker = {
      rootId: "main-a",
      caller: { provider: "claude", sessionId: worker.acpSessionId, pid: 777, instanceId: "mcp-worker" }
    };
    const child = await service.call("session_open", { provider: "claude", cwd: tmpdir(), permissionPolicy: "read_only" }, asWorker);
    assert.deepEqual(child.openedBy, { ...asWorker.caller, viaSession: worker.sessionId });
    const ack = await service.call("prompt", { sessionId: child.sessionId, prompt: "{}" }, asWorker);
    assert.equal(ack.promptedBy.viaSession, worker.sessionId);
    await waitForIdle(service, child.sessionId, main);
    const [listed] = (await service.call("session", { action: "list" }, main)).sessions.filter((item) => item.sessionId === child.sessionId);
    assert.equal(listed.openedBy.viaSession, worker.sessionId, "recorded, not recomputed");

    const otherRoot = await service.call("session_open", { provider: "claude", cwd: tmpdir(), permissionPolicy: "read_only" },
      { rootId: "main-b", caller: asWorker.caller });
    assert.equal(Object.hasOwn(otherRoot.openedBy, "viaSession"), false, "another root's sessions are not looked at");

    const stranger = { rootId: "main-a", caller: { ...asWorker.caller, sessionId: "not-one-of-ours" } };
    assert.equal(Object.hasOwn((await service.call("prompt", { sessionId: child.sessionId, prompt: "{}" }, stranger)).promptedBy, "viaSession"), false);
    await waitForIdle(service, child.sessionId, main);

    await service.call("session", { action: "close", sessionId: worker.sessionId }, main);
    const after = await service.call("prompt", { sessionId: child.sessionId, prompt: "{}" }, asWorker);
    assert.equal(Object.hasOwn(after.promptedBy, "viaSession"), false, "a closed session is no longer anyone's worker");
    await waitForIdle(service, child.sessionId, main);
  } finally {
    await service.shutdown();
  }
});

test("an embedded caller is normalized before it is recorded: nothing forged survives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-caller-forged-"));
  const forged = { rootId: "main-a", caller: { ...claudeCaller, viaSession: "acp-forged", admin: true } };
  try {
    const first = makeService(directory);
    try {
      await first.init();
      const opened = await first.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, forged);
      assert.deepEqual(opened.openedBy, claudeCaller);
      const ack = await first.call("prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, forged);
      assert.deepEqual(ack.promptedBy, claudeCaller);
      await waitForIdle(first, opened.sessionId, forged);
      assert.deepEqual((await turnStart(first, opened.sessionId, forged)).promptedBy, claudeCaller);
    } finally {
      await first.shutdown();
    }
    const second = makeService(directory);
    try {
      await second.init();
      const [restored] = (await second.call("session", { action: "list" }, { rootId: "main-a" })).sessions;
      assert.deepEqual(restored.openedBy, claudeCaller, "the persisted record carries only allowlisted keys");
      assert.deepEqual(restored.promptedBy, claudeCaller);
    } finally {
      await second.shutdown();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the caller rides the control socket; an observer's claim is not recorded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-caller-daemon-"));
  let daemon = null;
  const clients = [];
  const connect = (options) => {
    const client = new GatewayRpcClient({
      socketPath: daemon.socketPath,
      token: daemon.token,
      rootId: daemon.rootId,
      statePath: daemonPaths(directory).statePath,
      autoStart: false,
      ...options
    });
    clients.push(client);
    return client;
  };
  try {
    daemon = await startDaemon({ directory, env: await writeMockProviders(directory) });
    const main = connect({ caller: claudeCaller });
    const opened = await main.call("session_open", { provider: "mock", cwd: tmpdir(), permissionPolicy: "read_only" });
    assert.deepEqual(opened.openedBy, claudeCaller);

    const observer = connect({ access: "observer", caller: codexCaller });
    const [seen] = (await observer.call("session", { action: "list" })).sessions;
    assert.deepEqual(seen.openedBy, claudeCaller, "an observer sees who opened it");

    // Neither an identified Main nor any observer is a legacy front door.
    const quietObserver = connect({ access: "observer" });
    await quietObserver.call("session", { action: "list" });
    await quietObserver.call("poll", { sessionId: opened.sessionId, cursor: 0 });
    const clean = await quietObserver.call("setup", { mode: "summary" });
    assert.equal(clean.legacyControlRequests, 0);
    assert.equal(clean.alerts.some((alert) => alert.code === "front_door_without_caller"), false);

    // A pre-1.6 control server sends no caller: its turn stays unattributed.
    const legacy = connect({});
    assert.equal((await legacy.call("setup", { mode: "summary" })).legacyControlRequests, 0,
      "management calls (admin CLI, installer) are not front doors");
    const started = await legacy.call("prompt", { sessionId: opened.sessionId, prompt: "narrated-result" });
    assert.equal("promptedBy" in started, false);
    const { events } = await legacy.call("poll", { sessionId: opened.sessionId, cursor: 0, eventTypes: ["turn_start"] });
    const turn = events.find((event) => event.turnId === started.turnId);
    assert.equal("promptedBy" in turn, false);

    const summary = await main.call("setup", { mode: "summary" });
    assert.equal(summary.legacyControlRequests, 1);
    const alert = summary.alerts.find((item) => item.code === "front_door_without_caller");
    assert.equal(alert.level, "warning");
    assert.match(alert.message, /pre-1\.6/);
    assert.equal((await main.call("setup", {})).legacyControlRequests, 1, "full setup carries the same count");
  } finally {
    for (const client of clients) client.close();
    await daemon?.stop?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("through the real front door, a Codex call's _meta becomes that call's caller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-caller-frontdoor-"));
  let daemon = null;
  let mcpClient = null;
  try {
    const providers = await writeMockProviders(directory);
    daemon = await startDaemon({ directory, env: providers });
    mcpClient = new Client({ name: "w1-codex", version: "1.0.0" });
    await mcpClient.connect(new StdioClientTransport({
      command: process.execPath,
      args: [frontDoor],
      stderr: "pipe",
      env: {
        // The runner may itself be inside an agent CLI; its markers would name
        // the provider before _meta could.
        ...withoutSessionMarkers(process.env),
        ACP_GATEWAY_SOCKET: daemon.socketPath,
        ACP_GATEWAY_CONTROL_TOKEN: daemon.token,
        ACP_GATEWAY_ROOT_ID: daemon.rootId,
        ...providers
      }
    }));
    const call = async (name, args, meta) =>
      (await mcpClient.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })).structuredContent;

    // The parent here is node: only the Codex metadata can say who this is.
    const opened = await call("agent_acp_session_open", { provider: "mock", cwd: directory, permissionPolicy: "read_only" }, codexMeta());
    assert.deepEqual(
      [opened.openedBy.provider, opened.openedBy.sessionId, opened.openedBy.turnId],
      ["codex", THREAD, TURN]
    );
    const { instanceId } = opened.openedBy;

    // No _meta on this call: the process caller, not whichever thread came last.
    const ran = await call("agent_acp_run", { sessionId: opened.sessionId, prompt: "narrated-result", waitMs: 20_000 });
    assert.equal(ran.result.text, "FINAL ANSWER");
    const got = await call("agent_acp_session", { action: "get", sessionId: opened.sessionId });
    assert.deepEqual(
      [got.promptedBy.provider, got.promptedBy.sessionId, Object.hasOwn(got.promptedBy, "turnId"), got.promptedBy.instanceId],
      [null, null, false, instanceId]
    );
    assert.equal(Object.hasOwn(got, "attribution"), false);

    const other = "019a4c7e-5a1b-7c2d-8e3f-0123456789ef";
    const ack = await call("agent_acp_prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, codexMeta(other, "turn-2"));
    assert.deepEqual(
      [ack.promptedBy.provider, ack.promptedBy.sessionId, ack.promptedBy.turnId, ack.promptedBy.instanceId],
      ["codex", other, "turn-2", instanceId],
      "two threads of one Codex process, told apart per call"
    );
    assert.equal((await call("agent_acp_setup", { mode: "summary" })).legacyControlRequests, 0);
  } finally {
    await mcpClient?.close().catch(() => {});
    await daemon?.stop?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("overlapping front-door calls from one Codex process each keep their own thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-caller-overlap-"));
  let daemon = null;
  let mcpClient = null;
  try {
    // The permission mock mints a distinct ACP session id per session/new, so
    // several opens on one provider can be in flight together.
    const providersPath = join(directory, "providers.json");
    await writeFile(providersPath, JSON.stringify({
      version: 1,
      providers: { mockperm: { command: process.execPath, args: [permissionAgent], permissionPolicy: "read_only" } }
    }));
    const providers = { ACP_GATEWAY_PROVIDERS: providersPath };
    daemon = await startDaemon({ directory, env: providers });
    mcpClient = new Client({ name: "w1-overlap", version: "1.0.0" });
    await mcpClient.connect(new StdioClientTransport({
      command: process.execPath,
      args: [frontDoor],
      stderr: "pipe",
      env: {
        ...withoutSessionMarkers(process.env),
        ACP_GATEWAY_SOCKET: daemon.socketPath,
        ACP_GATEWAY_CONTROL_TOKEN: daemon.token,
        ACP_GATEWAY_ROOT_ID: daemon.rootId,
        ...providers
      }
    }));
    const call = async (name, args, meta) =>
      (await mcpClient.callTool({ name, arguments: args, _meta: meta })).structuredContent;
    const threads = [1, 2, 3, 4].map((index) => `019a4c7e-5a1b-7c2d-8e3f-00000000000${index}`);

    // All four requests are sent before any answer comes back.
    const opened = await Promise.all(threads.map((thread, index) =>
      call("agent_acp_session_open", { provider: "mockperm", cwd: directory, permissionPolicy: "read_only" }, codexMeta(thread, `open-${index}`))));
    opened.forEach((session, index) => {
      assert.equal(session.ok, true, JSON.stringify(session));
      assert.deepEqual([session.openedBy.sessionId, session.openedBy.turnId], [threads[index], `open-${index}`]);
    });
    assert.equal(new Set(opened.map((session) => session.openedBy.instanceId)).size, 1, "one MCP process");

    // Rotated, so a thread never lines up with the session it opened.
    const acks = await Promise.all(opened.map((session, index) => {
      const thread = threads[(index + 1) % threads.length];
      return call("agent_acp_prompt", { sessionId: session.sessionId, prompt: "{}" }, codexMeta(thread, `prompt-${index}`));
    }));
    acks.forEach((ack, index) => {
      assert.equal(ack.ok, true, JSON.stringify(ack));
      assert.deepEqual([ack.promptedBy.sessionId, ack.promptedBy.turnId], [threads[(index + 1) % threads.length], `prompt-${index}`]);
    });
  } finally {
    await mcpClient?.close().catch(() => {});
    await daemon?.stop?.();
    await rm(directory, { recursive: true, force: true });
  }
});
