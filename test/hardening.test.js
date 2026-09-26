import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient, acpRequestError } from "../src/acp-client.js";
import { defaultProviderRegistryPath, providerRegistryReadPath } from "../src/acp-registry.js";
import { gatewayProtectedPaths } from "../src/config.js";
import { ERROR_CODES } from "../src/errors.js";
import { GatewayService } from "../src/gateway-service.js";
import { partialPolicyEnforcement, providerConfig, setProviderEnabled, workerSessionMeta } from "../src/providers.js";
import { prepareGrokSandbox } from "../src/grok-sandbox.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { createSnapshot, removeSnapshot, snapshotDiff } from "../src/workspace.js";

// v1.5.2 hardening: every case below reproduces a defect found by running the
// Gateway against real Claude, Codex and Grok workers (docs/live-usecases.md).

const mockAgent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const permissionAgent = fileURLToPath(new URL("./mock-permission-agent.js", import.meta.url));
const context = { rootId: "main-a" };

function permissionClientFactory(env = {}) {
  return (_provider, options) => new AcpClient(
    { provider: "mock", command: process.execPath, args: [permissionAgent], env, permissionPolicy: "ask" },
    options
  );
}

async function withTemp(prefix, body) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withEnv(values, body) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runPrompt(service, sessionId, prompt) {
  return service.call("run", { sessionId, prompt: typeof prompt === "string" ? prompt : JSON.stringify(prompt), waitMs: 10_000 }, context);
}

// ---------------------------------------------------------------- permissions

test("UC-06: automatic approval checks toolCall paths against the roots and protected paths", async () => {
  await withTemp("acp-perm-", async (directory) => {
    const root = join(directory, "root");
    const outside = join(directory, "outside");
    const guarded = join(root, "guarded");
    await mkdir(guarded, { recursive: true });
    await mkdir(outside);
    const service = new GatewayService({ createClient: permissionClientFactory(), protectedPaths: [guarded] });
    try {
      await service.init();
      const open = async (permissionPolicy) => (await service.call(
        "session_open", { provider: "claude", cwd: root, permissionPolicy }, context
      )).sessionId;
      const readOnly = await open("read_only");
      const stop = async (sessionId, kind, path) => (await runPrompt(service, sessionId, { permission: { kind, path } })).result?.stopReason;

      assert.equal(await stop(readOnly, "read", join(root, "a.txt")), "allow", "read inside the root");
      assert.equal(await stop(readOnly, "read", "relative/b.txt"), "allow", "relative paths resolve against cwd");
      assert.equal(await stop(readOnly, "read", join(outside, "secret")), "reject", "read outside the root");
      assert.equal(await stop(readOnly, "read", join(root, "..", "outside", "secret")), "reject", "dot-dot escape");
      assert.equal(await stop(readOnly, "read", join(guarded, "install.json")), "reject", "protected path inside the root");
      assert.equal(await stop(readOnly, "edit", join(root, "a.txt")), "reject", "read_only still refuses edits");

      const full = await open("auto_approve");
      assert.equal(await stop(full, "edit", join(root, "a.txt")), "allow", "auto_approve inside the root");
      assert.equal(await stop(full, "read", join(guarded, "x")), "reject", "protected beats auto_approve");
      const escalated = await runPrompt(service, full, { permission: { kind: "edit", path: join(outside, "x") } });
      assert.equal(escalated.status, "input_required", "auto_approve outside the roots goes to Main");
      assert.equal(escalated.pending.type, "permission_request");

      const ask = await open("ask");
      assert.equal(await stop(ask, "read", join(guarded, "x")), "reject", "protected is refused without asking");
    } finally {
      await service.shutdown();
    }
  });
});

test("an automatic refusal prefers the option that lets the worker continue", async () => {
  await withTemp("acp-perm-decline-", async (directory) => {
    const service = new GatewayService({ createClient: permissionClientFactory(), protectedPaths: [] });
    try {
      await service.init();
      const { sessionId } = await service.call("session_open", { provider: "claude", cwd: directory, permissionPolicy: "read_only" }, context);
      const refuse = async (options) => (await runPrompt(service, sessionId, {
        permission: { kind: "execute", path: join(directory, "x"), options }
      })).result.stopReason;
      // codex-acp's exec approval: cancel listed before decline, both reject_once.
      assert.equal(await refuse([
        { optionId: "allow_once", name: "Yes, proceed", kind: "allow_once" },
        { optionId: "cancel", name: "No, and tell Codex what to do differently", kind: "reject_once" },
        { optionId: "decline", name: "No, continue without running it", kind: "reject_once" }
      ]), "decline");
      // Only a stopping refusal offered: it is still a refusal, so it is used.
      assert.equal(await refuse([
        { optionId: "accept", name: "Yes", kind: "allow_once" },
        { optionId: "cancel", name: "No, and tell Codex what to do differently", kind: "reject_once" }
      ]), "cancel");
    } finally {
      await service.shutdown();
    }
  });
});

test("UC-06: a symlink inside the root cannot carry a permission request outside it", async () => {
  await withTemp("acp-perm-link-", async (directory) => {
    const root = join(directory, "root");
    const outside = join(directory, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "link"));
    const service = new GatewayService({ createClient: permissionClientFactory(), protectedPaths: [] });
    try {
      await service.init();
      const { sessionId } = await service.call("session_open", { provider: "claude", cwd: root, permissionPolicy: "read_only" }, context);
      const result = await runPrompt(service, sessionId, { permission: { kind: "read", path: join(root, "link", "secret") } });
      assert.equal(result.result.stopReason, "reject");
    } finally {
      await service.shutdown();
    }
  });
});

test("Grok review: link/.. is resolved physically, so it cannot fold a protected path into the root", async () => {
  await withTemp("acp-perm-dotdot-", async (directory) => {
    const root = join(directory, "root");
    const home = join(directory, "home");
    const guarded = join(home, ".acp-gateway");
    await mkdir(root);
    await mkdir(guarded, { recursive: true });
    await mkdir(join(home, "sub"));
    // link/.. is then home: the kernel follows the link before applying "..".
    await symlink(join(home, "sub"), join(root, "link"));
    const service = new GatewayService({ createClient: permissionClientFactory(), protectedPaths: [guarded] });
    try {
      await service.init();
      const { sessionId } = await service.call("session_open", { provider: "claude", cwd: root, permissionPolicy: "auto_approve" }, context);
      const stop = async (path) => (await runPrompt(service, sessionId, { permission: { kind: "read", path } })).result?.stopReason;
      // Lexically root/.acp-gateway/install.json; physically home/.acp-gateway/install.json.
      assert.equal(await stop(join(root, "link") + "/../.acp-gateway/install.json"), "reject");
      assert.equal(await stop("link/../.acp-gateway/install.json"), "reject", "relative spelling");
      const escaped = await runPrompt(service, sessionId, { permission: { kind: "read", path: join(root, "link") + "/../other.txt" } });
      assert.equal(escaped.status, "input_required", "link/.. outside the root goes to Main under auto_approve");
    } finally {
      await service.shutdown();
    }
  });
});

test("Grok review: commands naming a protected path are refused, in permission requests and terminal/create", async () => {
  await withTemp("acp-perm-cmd-", async (directory) => {
    const home = join(directory, "home");
    const guarded = join(home, ".acp-gateway");
    await mkdir(guarded, { recursive: true });
    await writeFile(join(guarded, "install.json"), "{}");
    await withEnv({ HOME: home }, async () => {
      const service = new GatewayService({ createClient: permissionClientFactory(), protectedPaths: [guarded] });
      try {
        await service.init();
        const { sessionId } = await service.call("session_open", { provider: "claude", cwd: directory, permissionPolicy: "auto_approve" }, context);
        const stop = async (prompt) => (await runPrompt(service, sessionId, prompt)).result?.stopReason;
        for (const command of [`cat ${guarded}/install.json`, "cat ~/.acp-gateway/install.json", "head \"$HOME/.acp-gateway/install.json\"", "ls ${HOME}/.acp-gateway"]) {
          assert.equal(await stop({ permission: { kind: "execute", command } }), "reject", command);
        }
        assert.equal(await stop({ permission: { kind: "execute", command: "ls ~/.acp-gateway-old" } }), "allow", "a longer name is not the protected directory");
        assert.equal(await stop({ permission: { kind: "execute", command: "rg acp-gateway src" } }), "allow", "mentioning the name is not a path");
        assert.equal(await stop({ terminal: { command: "/bin/cat", args: [join(guarded, "install.json")] } }), "terminal-error");
        // Grok review: a traversal through a symlink never spells the protected path.
        await mkdir(join(home, "sub"));
        await symlink(join(home, "sub"), join(directory, "link"));
        assert.equal(await stop({ terminal: { command: "/bin/sh", args: ["-c", "cat link/../.acp-gateway/install.json"] } }), "terminal-error");
        assert.equal(await stop({ permission: { kind: "execute", command: `cat ${join(directory, "link")}/../.acp-gateway/install.json` } }), "reject");
        assert.equal(await stop({ terminal: { command: "/bin/echo", args: ["ok"] } }), "terminal-ok");
      } finally {
        await service.shutdown();
      }
    });
  });
});

test("Grok review: a snapshot never copies a Gateway-protected directory", async () => {
  await withTemp("acp-ws-protected-", async (directory) => {
    const home = join(directory, "home");
    const guarded = join(home, ".acp-gateway");
    await mkdir(guarded, { recursive: true });
    await writeFile(join(guarded, "install.json"), "{\"token\":\"secret\"}");
    await writeFile(join(home, "notes.txt"), "hello\n");
    const service = new GatewayService({
      workspaceRoot: join(directory, "workspaces"),
      protectedPaths: [guarded],
      createClient: (_provider, options) => new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" }, options)
    });
    try {
      await service.init();
      await assert.rejects(
        service.call("session_open", { provider: "claude", cwd: guarded, workspace: "snapshot" }, context),
        (error) => error.code === ERROR_CODES.WORKSPACE_ERROR && /protected/.test(error.message)
      );
      const opened = await service.call("session_open", { provider: "claude", cwd: home, workspace: "snapshot" }, context);
      assert.ok(existsSync(join(opened.cwd, "notes.txt")));
      assert.equal(existsSync(join(opened.cwd, ".acp-gateway")), false, "the protected subtree is left out of the copy");
      await service.call("session", { action: "close", sessionId: opened.sessionId }, context);
    } finally {
      await service.shutdown();
    }
  });
});

test("UC-06: fs/read_text_file refuses a protected path even inside the session root", async () => {
  await withTemp("acp-perm-fs-", async (directory) => {
    const guarded = join(directory, "guarded");
    await mkdir(guarded);
    await writeFile(join(guarded, "install.json"), "{\"token\":\"x\"}");
    await writeFile(join(directory, "ok.txt"), "fine");
    const service = new GatewayService({ createClient: permissionClientFactory(), protectedPaths: [guarded] });
    try {
      await service.init();
      const { sessionId } = await service.call("session_open", { provider: "claude", cwd: directory, permissionPolicy: "read_only" }, context);
      assert.equal((await runPrompt(service, sessionId, { read: join(directory, "ok.txt") })).result.stopReason, "read-ok");
      assert.equal((await runPrompt(service, sessionId, { read: join(guarded, "install.json") })).result.stopReason, "read-error");
    } finally {
      await service.shutdown();
    }
  });
});

test("default protected paths cover the token directory, state directory and socket", () => {
  const paths = gatewayProtectedPaths({ statePath: "/tmp/acp-iso/state.json" });
  assert.ok(paths.some((path) => path.endsWith(".acp-gateway")));
  assert.ok(paths.some((path) => path.endsWith("acp-iso")));
  assert.ok(paths.some((path) => path.endsWith(".sock")));
});

// ------------------------------------------------------ Claude session rules

test("UC-05/06: Claude sessions carry disallowedTools for read_only and protected paths", () => {
  const readOnly = workerSessionMeta("claude", { permissionPolicy: "read_only", protectedPaths: ["/Users/me/.acp-gateway"] });
  const rules = readOnly.claudeCode.options.disallowedTools;
  for (const tool of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.ok(rules.includes(tool), tool);
  assert.ok(rules.includes("Read(//Users/me/.acp-gateway/**)"));
  assert.ok(rules.includes("Grep(//Users/me/.acp-gateway/**)"));

  const ask = workerSessionMeta("claude", { permissionPolicy: "ask", protectedPaths: ["/p"] }).claudeCode.options.disallowedTools;
  assert.equal(ask.includes("Bash"), false, "ask keeps Bash; Claude asks for it");
  assert.ok(ask.includes("Read(//p/**)"));

  assert.equal(workerSessionMeta("codex", { permissionPolicy: "read_only", protectedPaths: ["/p"] }), null);
  assert.equal(workerSessionMeta("grok", { permissionPolicy: "read_only", protectedPaths: ["/p"] }), null);
});

test("UC-05: the Claude rules reach session/new and every session/resume", async () => {
  await withTemp("acp-meta-", async (directory) => {
    const log = join(directory, "params.ndjson");
    const statePath = join(directory, "state.json");
    const make = () => new GatewayService({ statePath, createClient: permissionClientFactory({ ACP_MOCK_PARAMS_LOG: log }), protectedPaths: ["/guarded"] });
    let service = make();
    try {
      await service.init();
      const { sessionId } = await service.call("session_open", { provider: "claude", cwd: directory, permissionPolicy: "read_only" }, context);
      await service.shutdown();
      service = make();
      await service.init();
      await runPrompt(service, sessionId, "{}");
      const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(records.map((record) => record.method), ["session/new", "session/resume"]);
      for (const record of records) {
        const rules = record.params._meta.claudeCode.options.disallowedTools;
        assert.ok(rules.includes("Bash"));
        assert.ok(rules.includes("Read(//guarded/**)"));
      }
    } finally {
      await service.shutdown();
    }
  });
});

// -------------------------------------------------------------- idempotency

test("UC-09: reusing an idempotencyKey for different work is a conflict, also after restart", async () => {
  await withTemp("acp-idem-", async (directory) => {
    const statePath = join(directory, "state.json");
    const make = () => new GatewayService({
      statePath,
      createClient: (_provider, options) => new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" }, options)
    });
    let service = make();
    try {
      await service.init();
      const { sessionId } = await service.call("session_open", { provider: "claude", cwd: process.cwd(), permissionPolicy: "read_only" }, context);
      const first = await service.call("run", { sessionId, prompt: "go", idempotencyKey: "k1", waitMs: 10_000 }, context);
      const retry = await service.call("run", { sessionId, prompt: "go", idempotencyKey: "k1", waitMs: 10_000 }, context);
      assert.equal(retry.taskId, first.taskId, "a true retry attaches");
      const retune = await service.call("run", { sessionId, prompt: "go", idempotencyKey: "k1", waitMs: 5, resultBudgetBytes: 10 }, context);
      assert.equal(retune.taskId, first.taskId, "wait/budget options may change on a retry");
      await assert.rejects(
        service.call("run", { sessionId, prompt: "something else", idempotencyKey: "k1", waitMs: 10_000 }, context),
        (error) => error.code === ERROR_CODES.IDEMPOTENCY_CONFLICT && error.details.taskId === first.taskId
      );
      await service.shutdown();

      service = make();
      await service.init();
      await assert.rejects(
        service.call("run", { sessionId, prompt: "something else", idempotencyKey: "k1", waitMs: 10_000 }, context),
        (error) => error.code === ERROR_CODES.IDEMPOTENCY_CONFLICT
      );
      const again = await service.call("run", { sessionId, prompt: "go", idempotencyKey: "k1", waitMs: 10_000 }, context);
      assert.equal(again.taskId, first.taskId);
    } finally {
      await service.shutdown();
    }
  });
});

// ------------------------------------------------------------- ACP errors

test("UC-13: worker JSON-RPC errors carry a stable code and the worker's details", () => {
  const missing = acpRequestError("session/resume", { code: -32603, message: "Session abc not found" });
  assert.equal(missing.code, ERROR_CODES.UNKNOWN_SESSION);
  assert.equal(missing.message, "ACP error -32603: Session abc not found");
  assert.deepEqual(missing.details, { method: "session/resume", acpCode: -32603, acpMessage: "Session abc not found" });
  assert.equal(acpRequestError("session/load", { code: -32603, message: "Session not found" }).code, ERROR_CODES.UNKNOWN_SESSION);
  // Not about the session: a resumable session must not be reported as gone.
  for (const message of ["Path not found.", "working directory does not exist", "model gpt-x does not exist", "session/resume: working directory does not exist"]) {
    assert.equal(acpRequestError("session/resume", { code: -32603, message }).code, ERROR_CODES.ACP_ERROR, message);
  }

  assert.equal(acpRequestError("session/load", { code: -32002, message: "gone" }).code, ERROR_CODES.UNKNOWN_SESSION);
  const other = acpRequestError("session/prompt", { code: -32603, message: "not found", data: { x: 1 } });
  assert.equal(other.code, ERROR_CODES.ACP_ERROR, "not-found wording only means a missing session on restore");
  assert.deepEqual(other.details.acpData, { x: 1 });
});

// ---------------------------------------------- provider registry isolation

test("UC-01: an isolated state directory reads global providers but writes its own copy", async () => {
  await withTemp("acp-iso-", async (directory) => {
    const home = join(directory, "home");
    const globalFile = join(home, ".acp-gateway", "providers.json");
    await mkdir(join(home, ".acp-gateway"), { recursive: true });
    await writeFile(globalFile, JSON.stringify({ version: 1, providers: { mockreg: { command: "x", args: [] } } }));
    const isolated = join(directory, "iso");
    await withEnv({ HOME: home, ACP_GATEWAY_STATE: join(isolated, "state.json"), ACP_GATEWAY_PROVIDERS: null, ACP_GATEWAY_DISABLE_DYNAMIC_PROVIDERS: null }, async () => {
      assert.equal(defaultProviderRegistryPath(), join(isolated, "providers.json"));
      assert.equal(providerRegistryReadPath(), globalFile, "falls back to the global file until the first write");
      assert.equal(providerConfig("mockreg").command, "x");
      setProviderEnabled("mockreg", false);
      assert.ok(existsSync(join(isolated, "providers.json")));
      const isolatedDocument = JSON.parse(await readFile(join(isolated, "providers.json"), "utf8"));
      assert.deepEqual(isolatedDocument.disabled, ["mockreg"]);
      assert.ok(isolatedDocument.providers.mockreg, "seeded from the global definitions");
      const globalDocument = JSON.parse(await readFile(globalFile, "utf8"));
      assert.equal(globalDocument.disabled, undefined, "the global file is untouched");
    });
    await withEnv({ HOME: home, ACP_GATEWAY_STATE: join(home, ".acp-gateway", "state.json"), ACP_GATEWAY_PROVIDERS: null }, async () => {
      assert.equal(defaultProviderRegistryPath(), globalFile, "the default state directory keeps the global file");
    });
    await withEnv({ HOME: home, ACP_GATEWAY_STATE: join(home, ".acp-gateway", "sub", "..", "state.json"), ACP_GATEWAY_PROVIDERS: null }, async () => {
      assert.equal(defaultProviderRegistryPath(), globalFile, "a dot-dot spelling of the global directory is not isolation");
    });
    await symlink(join(home, ".acp-gateway"), join(directory, "alias"));
    await withEnv({ HOME: home, ACP_GATEWAY_STATE: join(directory, "alias", "state.json"), ACP_GATEWAY_PROVIDERS: null }, async () => {
      assert.equal(defaultProviderRegistryPath(), globalFile, "a symlink to the global directory is not isolation");
    });
  });
});

// ------------------------------------------------ adapter generations/health

test("UC-01: an adapter definition change starts a new generation and retires the old process", async () => {
  await withTemp("acp-gen-", async (directory) => {
    const providersPath = join(directory, "providers.json");
    const definition = (version) => JSON.stringify({
      version: 1,
      providers: { mockreg: { registryVersion: version, command: process.execPath, args: [permissionAgent, `--v=${version}`], env: {}, modelScope: "session" } }
    });
    await writeFile(providersPath, definition("1.0.0"));
    await withEnv({ ACP_GATEWAY_PROVIDERS: providersPath }, async () => {
      const service = new GatewayService({});
      try {
        await service.init();
        const before = await service.call("setup", { mode: "summary" }, context);
        assert.equal(before.providers.find((item) => item.provider === "mockreg").started, false);
        const oldSession = await service.call("session_open", { provider: "mockreg", cwd: process.cwd(), permissionPolicy: "read_only" }, context);
        const running = await service.call("setup", { mode: "summary" }, context);
        assert.equal(running.providers.find((item) => item.provider === "mockreg").started, true, "started reflects the live process");

        await writeFile(providersPath, definition("2.0.0"));
        const newSession = await service.call("session_open", { provider: "mockreg", cwd: process.cwd(), permissionPolicy: "read_only" }, context);
        const oldClient = service.requireSession(oldSession.sessionId).client;
        const newClient = service.requireSession(newSession.sessionId).client;
        assert.notEqual(oldClient, newClient, "new sessions get the new definition");
        assert.equal(oldClient.alive, true, "the old generation keeps serving its session");
        const detail = await service.call("setup", { provider: "mockreg" }, context);
        const row = detail.providers.find((item) => item.provider === "mockreg");
        assert.equal(row.runningVersion, "2.0.0");
        assert.equal(row.retiredProcesses, 1);

        const oldRun = await runPrompt(service, oldSession.sessionId, "{}");
        assert.equal(oldRun.status, "idle");
        await service.call("session", { action: "close", sessionId: oldSession.sessionId }, context);
        await service.runMaintenance();
        assert.equal(oldClient.alive, false, "gc stops a retired process once it serves nothing");
        const after = (await service.call("setup", { provider: "mockreg" }, context)).providers.find((item) => item.provider === "mockreg");
        assert.equal(after.retiredProcesses, 0);
      } finally {
        await service.shutdown();
      }
    });
  });
});

// --------------------------------------------------------- snapshot workspace

test("snapshot workspace: the worker gets a private copy, diff shows its edits, close removes it", async () => {
  await withTemp("acp-ws-", async (directory) => {
    const source = join(directory, "project");
    const workspaceRoot = join(directory, "workspaces");
    const statePath = join(directory, "state", "state.json");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "src", "calc.js"), "for (let i = 0; i <= n; i++) {}\n");
    const make = () => new GatewayService({
      statePath,
      workspaceRoot,
      createClient: (_provider, options) => new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" }, options)
    });
    let service = make();
    try {
      await service.init();
      const opened = await service.call("session_open", { provider: "claude", cwd: source, permissionPolicy: "auto_approve", workspace: "snapshot" }, context);
      assert.equal(opened.workspace.mode, "snapshot");
      assert.equal(opened.workspace.source, source);
      assert.notEqual(opened.cwd, source);
      assert.ok(opened.cwd.startsWith(workspaceRoot));

      const clean = await service.call("session", { action: "workspace_diff", sessionId: opened.sessionId }, context);
      assert.equal(clean.changed, false);
      assert.deepEqual(clean.files, []);

      // Stand in for a worker that edits through its own tools.
      await writeFile(join(opened.cwd, "src", "calc.js"), "for (let i = 0; i < n; i++) {}\n");
      await writeFile(join(opened.cwd, "NEW.md"), "added\n");
      assert.equal(await readFile(join(source, "src", "calc.js"), "utf8"), "for (let i = 0; i <= n; i++) {}\n", "original untouched");

      await service.shutdown();
      service = make();
      await service.init();
      const diff = await service.call("session", { action: "workspace_diff", sessionId: opened.sessionId }, context);
      assert.equal(diff.changed, true, "the workspace survives a restart");
      assert.deepEqual([...diff.files].sort(), ["NEW.md", "src/calc.js"]);
      assert.match(diff.patch, /^diff --git a\/src\/calc\.js b\/src\/calc\.js$/m);
      assert.match(diff.patch, /^\+for \(let i = 0; i < n; i\+\+\) \{\}$/m);
      assert.equal(diff.patch.includes(source), false, "paths are relative to the tree");

      await service.call("session", { action: "close", sessionId: opened.sessionId }, context);
      assert.equal(existsSync(opened.cwd), false, "close removes the copy");
      assert.ok(existsSync(join(source, "src", "calc.js")));
    } finally {
      await service.shutdown();
    }
  });
});

test("snapshot workspace: diff on a direct session and a cwd containing the workspace root are refused", async () => {
  await withTemp("acp-ws-refuse-", async (directory) => {
    const service = new GatewayService({
      workspaceRoot: join(directory, "inside", "workspaces"),
      createClient: (_provider, options) => new AcpClient({ provider: "mock", command: process.execPath, args: [mockAgent], permissionPolicy: "ask" }, options)
    });
    try {
      await service.init();
      const direct = await service.call("session_open", { provider: "claude", cwd: directory, permissionPolicy: "read_only" }, context);
      assert.equal(direct.workspace, undefined, "the default shape is unchanged");
      await assert.rejects(
        service.call("session", { action: "workspace_diff", sessionId: direct.sessionId }, context),
        (error) => error.code === ERROR_CODES.INVALID_ARGUMENT
      );
      await assert.rejects(
        service.call("session_open", { provider: "claude", cwd: directory, workspace: "snapshot" }, context),
        (error) => error.code === ERROR_CODES.WORKSPACE_ERROR
      );
      await assert.rejects(
        service.call("session_open", { provider: "claude", cwd: directory, workspace: "bogus" }, context),
        (error) => error.code === ERROR_CODES.INVALID_ARGUMENT
      );
    } finally {
      await service.shutdown();
    }
  });
});

// ------------------------------------------------------------- shutdown

test("shutdown calls never autostart a daemon", async () => {
  await withTemp("acp-noauto-", async (directory) => {
    const socketPath = join(directory, "g.sock");
    const rpc = new GatewayRpcClient({ socketPath, token: "t".repeat(32), rootId: "main-x", statePath: join(directory, "state.json") });
    try {
      assert.deepEqual(await rpc.call("daemon_shutdown", {}), { ok: true, alreadyStopped: true });
      assert.deepEqual(await rpc.call("shutdown_if_idle", {}), { ok: true, alreadyStopped: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(existsSync(socketPath), false, "no daemon was spawned");
    } finally {
      rpc.close();
    }
  });
});

test("a concurrent autostart call is not poisoned by a shutdown's no-autostart attempt", async () => {
  await withTemp("acp-noauto-race-", async (directory) => {
    const socketPath = join(directory, "g.sock");
    const statePath = join(directory, "state", "state.json");
    // The autostarted daemon inherits this environment: keep it fully isolated.
    await withEnv({
      ACP_GATEWAY_STATE: statePath,
      ACP_GATEWAY_SETTINGS: join(directory, "state", "settings.json"),
      ACP_GATEWAY_INSTALL_STATE: join(directory, "state", "install.json"),
      ACP_GATEWAY_WORKSPACES: join(directory, "workspaces"),
      ACP_GATEWAY_AGENT_AUTO_UPDATE: "false"
    }, async () => {
      const rpc = new GatewayRpcClient({ socketPath, token: "t".repeat(32), rootId: "main-x", statePath });
      try {
        const [shutdown, setup] = await Promise.allSettled([
          rpc.call("shutdown_if_idle", {}),
          rpc.call("setup", { mode: "summary" }, 20_000)
        ]);
        assert.equal(setup.status, "fulfilled", `setup inherited the shutdown failure: ${setup.reason?.message}`);
        assert.equal(setup.value.ok, true);
        assert.equal(shutdown.status, "fulfilled");
      } finally {
        await rpc.call("daemon_shutdown", { force: true }).catch(() => {});
        rpc.close();
      }
    });
  });
});

test("Codex review: snapshot links are rewritten inside the copy or dropped, never left pointing at the original", async () => {
  await withTemp("acp-ws-links-", async (directory) => {
    const source = join(directory, "project");
    const elsewhere = join(directory, "elsewhere");
    await mkdir(join(source, "config"), { recursive: true });
    await mkdir(elsewhere);
    await writeFile(join(source, "config", "app.json"), "{}\n");
    await writeFile(join(elsewhere, "shared.txt"), "outside\n");
    await symlink(join(source, "config"), join(source, "abs-link"));
    await symlink("config/app.json", join(source, "rel-link"));
    await symlink(join(elsewhere, "shared.txt"), join(source, "out-link"));
    const workspace = await createSnapshot(source, join(directory, "workspaces"));
    try {
      assert.deepEqual(workspace.droppedLinks, ["out-link"]);
      assert.equal(existsSync(join(workspace.path, "out-link")), false);
      // Editing through the rewritten link changes the copy, not the original.
      await writeFile(join(workspace.path, "abs-link", "app.json"), "{\"edited\":true}\n");
      await writeFile(join(workspace.path, "rel-link"), "{\"edited\":2}\n");
      assert.equal(await readFile(join(source, "config", "app.json"), "utf8"), "{}\n");
      assert.equal(await readFile(join(workspace.path, "config", "app.json"), "utf8"), "{\"edited\":2}\n");
    } finally {
      await removeSnapshot(workspace);
    }
  });
});

test("Codex review: diff is against the snapshot baseline, keeps hunk bodies intact and is bounded", async () => {
  await withTemp("acp-ws-baseline-", async (directory) => {
    const source = join(directory, "project");
    await mkdir(source);
    await writeFile(join(source, "a.txt"), "x=1\n");
    await writeFile(join(source, "doc.md"), "old\n");
    const workspace = await createSnapshot(source, join(directory, "workspaces"));
    try {
      // The user keeps working on the original; the worker never touches a.txt.
      await writeFile(join(source, "a.txt"), "x=2\n");
      await writeFile(join(workspace.path, "doc.md"), "see a/base/x and b/tree/y\n");
      const diff = await snapshotDiff(workspace);
      assert.deepEqual(diff.files, ["doc.md"], "the user's own change is not reported as a worker revert");
      assert.match(diff.patch, /^\+see a\/base\/x and b\/tree\/y$/m, "file content is not rewritten");
      assert.match(diff.patch, /^--- a\/doc\.md$/m);
      assert.match(diff.patch, /^\+\+\+ b\/doc\.md$/m);
      await assert.rejects(snapshotDiff(workspace, { maxBytes: 10 }), (error) => error.code === ERROR_CODES.WORKSPACE_ERROR && /exceeds 10 bytes/.test(error.message));
    } finally {
      await removeSnapshot(workspace);
    }
    assert.equal(existsSync(workspace.home), false);
  });
});

test("Codex review: a quoted $HOME spelling of a protected path is still refused", async () => {
  await withTemp("acp-perm-quote-", async (directory) => {
    const home = join(directory, "home");
    const guarded = join(home, ".acp-gateway");
    await mkdir(guarded, { recursive: true });
    await withEnv({ HOME: home }, async () => {
      const service = new GatewayService({ createClient: permissionClientFactory(), protectedPaths: [guarded] });
      try {
        await service.init();
        const { sessionId } = await service.call("session_open", { provider: "claude", cwd: directory, permissionPolicy: "auto_approve" }, context);
        for (const command of ['cat "$HOME"/.acp-gateway/install.json', "cat '~/.acp-gateway/install.json'", "cat ~/.acp\\-gateway/install.json"]) {
          const result = await runPrompt(service, sessionId, { permission: { kind: "execute", command } });
          assert.equal(result.result.stopReason, "reject", command);
        }
      } finally {
        await service.shutdown();
      }
    });
  });
});

test("Grok gets a process-wide sandbox profile denying the protected paths", async () => {
  await withTemp("acp-grok-sbx-", async (directory) => {
    const overrides = prepareGrokSandbox(["/Users/me/.acp-gateway", "/tmp/state \"q\""], directory);
    assert.deepEqual(overrides, { cwd: directory, env: { GROK_SANDBOX: "acp-gateway" } });
    const profile = await readFile(join(directory, ".grok", "sandbox.toml"), "utf8");
    assert.match(profile, /^\[profiles\.acp-gateway\]$/m);
    assert.match(profile, /^extends = "workspace"$/m, "off cannot be extended; workspace keeps ACP-mediated edits working");
    assert.match(profile, /^deny = \["\/Users\/me\/\.acp-gateway", "\/tmp\/state \\"q\\""\]$/m, "TOML-quoted");

    const configs = [];
    const service = new GatewayService({
      grokSandbox: true,
      grokSandboxDir: directory,
      protectedPaths: ["/guarded"],
      createClient: (_provider, options, config) => {
        configs.push(config);
        return new AcpClient({ provider: "mock", command: process.execPath, args: [permissionAgent], permissionPolicy: "ask" }, options);
      }
    });
    try {
      await service.init();
      await service.getClient("claude");
      await service.getClient("grok").catch(() => {});
      const grok = configs.find((config) => config.provider === "grok");
      const claude = configs.find((config) => config.provider === "claude");
      assert.equal(grok.cwd, directory);
      assert.equal(grok.env.GROK_SANDBOX, "acp-gateway");
      assert.equal(claude.cwd, undefined, "only Grok is sandboxed this way");
    } finally {
      await service.shutdown();
    }
  });
});

test("partial-enforcement alerts carry the exact scope a Main can rely on", () => {
  const grok = partialPolicyEnforcement("grok", "read_only");
  assert.deepEqual(grok.scope, ["read_outside_roots"]);
  const codex = partialPolicyEnforcement("codex", "read_only");
  assert.deepEqual(codex.scope, ["edit_inside_roots", "shell_write_inside_roots", "read_outside_roots", "read_protected"]);
  assert.deepEqual(partialPolicyEnforcement("codex", "auto_approve").scope, ["read_outside_roots", "read_protected"]);
  assert.equal(partialPolicyEnforcement("claude", "read_only"), null);
});
