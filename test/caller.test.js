import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { agentFromCommand, callerFromProcess, normalizeCaller } from "../src/caller.js";
import { GatewayService } from "../src/gateway-service.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { daemonPaths, startDaemon, writeMockProviders } from "./helpers/daemon-harness.js";

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const CLAUDE_ID = "625cbd07-50b1-4ffa-b0bd-368891bb5085";
const claudeCaller = { provider: "claude", sessionId: CLAUDE_ID, pid: 4242, instanceId: "mcp-a" };
const codexCaller = { provider: "codex", sessionId: null, pid: 5151, instanceId: "mcp-b" };

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

test("a malformed caller loses attribution, never the call", () => {
  assert.equal(normalizeCaller(null), null);
  assert.equal(normalizeCaller({ provider: "claude" }), null, "no instance, no caller");
  assert.deepEqual(
    normalizeCaller({ provider: "other", sessionId: "bad value", pid: 1, instanceId: "mcp-x", extra: "dropped" }),
    { provider: null, sessionId: null, pid: null, instanceId: "mcp-x" }
  );
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

test("a caller that says nothing keeps the old shapes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-caller-none-"));
  const service = makeService(directory);
  try {
    await service.init();
    const context = { rootId: "main-a" };
    const opened = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, context);
    assert.equal("openedBy" in opened, false);
    await service.call("prompt", { sessionId: opened.sessionId, prompt: "narrated-result" }, context);
    await waitForIdle(service, opened.sessionId, context);
    assert.equal("promptedBy" in (await turnStart(service, opened.sessionId, context)), false);
  } finally {
    await service.shutdown();
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

    // A pre-1.6 control server sends no caller: its turn stays unattributed.
    const legacy = connect({});
    const started = await legacy.call("prompt", { sessionId: opened.sessionId, prompt: "narrated-result" });
    const { events } = await legacy.call("poll", { sessionId: opened.sessionId, cursor: 0, eventTypes: ["turn_start"] });
    const turn = events.find((event) => event.turnId === started.turnId);
    assert.equal("promptedBy" in turn, false);
  } finally {
    for (const client of clients) client.close();
    await daemon?.stop?.();
    await rm(directory, { recursive: true, force: true });
  }
});
