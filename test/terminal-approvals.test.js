import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { GATEWAY_WORKER_ENV } from "../src/caller.js";
import { GatewayService } from "../src/gateway-service.js";
import {
  detectTerminalSandbox,
  SANDBOX_EXEC,
  sbplString,
  seatbeltSandbox,
  terminalSandboxProfile
} from "../src/terminal-sandbox.js";

// 1.8.0 W3, W4, P7 and P2: what Main is shown for a Gateway-mediated write or
// terminal, what an approval lets through, the OS sandbox Gateway terminals run
// in, the byte budget of operations waiting for Main, and stop().

const permissionAgent = fileURLToPath(new URL("./mock-permission-agent.js", import.meta.url));
const osSandbox = detectTerminalSandbox();
const noOsSandbox = osSandbox ? false : "no terminal sandbox on this platform";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

// Runs the command as given and records what it was asked to wrap.
function standInSandbox(calls = []) {
  return {
    ready: async () => true,
    wrap: (command, args, protectedPaths) => {
      calls.push({ command, args, protectedPaths });
      return { command, args };
    }
  };
}

async function withTemp(prefix, body) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// One worker with one session. run(steps) is a turn of the mock's step script
// (mock-permission-agent.js) and resolves with the outcome of each step;
// requests collects every permission_request the session raised.
async function withClient({ cwd, policy = "ask", agentEnv = {}, ...options }, body) {
  const client = new AcpClient(
    { provider: "mock", command: process.execPath, args: [permissionAgent], env: agentEnv, permissionPolicy: policy },
    options
  );
  try {
    await client.start();
    const { sessionId } = await client.sessionNew({ cwd, permissionPolicy: policy });
    const requests = [];
    client.onSessionUpdate(sessionId, (update) => {
      if (update.sessionUpdate === "permission_request") requests.push(update);
    });
    const run = async (steps) => JSON.parse((await client.sessionPrompt({ sessionId, prompt: JSON.stringify({ steps }) })).stopReason);
    return await body({ client, sessionId, requests, run });
  } finally {
    await client.stop();
  }
}

async function until(predicate, what) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// The count-th permission request of the session, once it is there.
async function request(requests, count) {
  await until(() => requests.length >= count, `permission request ${count}`);
  return requests[count - 1];
}

function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// ------------------------------------------------------------------ W4: display

test("W4: a terminal waiting for Main names its command, args, cwd and env names, never an env value", async () => {
  await withTemp("acp-w4-terminal-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    const script = 'printf %s "$WORKER_TOKEN"';
    const turn = run([{
      terminal: { command: "/bin/sh", args: ["-c", script], env: [{ name: "WORKER_TOKEN", value: "s3cret-value" }] }
    }]);
    const asked = await request(requests, 1);
    assert.deepEqual(asked.toolCall, {
      toolCallId: `client-${asked.requestId}`,
      title: `Run: /bin/sh -c '${script}'`,
      kind: "execute",
      rawInput: { command: "/bin/sh", args: ["-c", script], cwd: directory, env: ["WORKER_TOKEN"] }
    });
    assert.doesNotMatch(JSON.stringify(asked), /s3cret-value/);
    await client.respondPermission(asked.requestId, "allow-once", sessionId);
    const [ran] = await turn;
    assert.equal(ran.output, "s3cret-value", "the value still reaches the terminal");
    assert.deepEqual(ran.exitStatus, { exitCode: 0, signal: null });
  }));
});

test("W4: a write waiting for Main names its file and size, never its content", async () => {
  await withTemp("acp-w4-write-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    const path = join(directory, "notes.txt");
    const content = "hello wörld";
    const bytes = Buffer.byteLength(content);
    const turn = run([{ write: { path, content } }]);
    const asked = await request(requests, 1);
    assert.deepEqual(asked.toolCall, {
      toolCallId: `client-${asked.requestId}`,
      title: `Write ${path} (${bytes} bytes)`,
      kind: "edit",
      locations: [{ path }],
      rawInput: { path, bytes }
    });
    assert.doesNotMatch(JSON.stringify(asked), /hello/);
    await client.respondPermission(asked.requestId, "allow-once", sessionId);
    assert.deepEqual(await turn, ["write-ok"]);
    assert.equal(await readFile(path, "utf8"), content);
  }));
});

test("W4: a long or multi-line command keeps a one-line, bounded title and its exact args", async () => {
  await withTemp("acp-w4-title-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    const script = `echo first\necho ${"x".repeat(400)}`;
    const turn = run([{ terminal: { command: "/bin/sh", args: ["-c", script] } }]);
    const asked = await request(requests, 1);
    assert.match(asked.toolCall.title, /^Run: \/bin\/sh -c 'echo first\\necho x+…$/);
    assert.equal([...asked.toolCall.title].length, "Run: ".length + 200);
    assert.deepEqual(asked.toolCall.rawInput.args, ["-c", script]);
    await client.respondPermission(asked.requestId, "reject-once", sessionId);
    assert.deepEqual(await turn, ["terminal-error: Main rejected ACP operation"]);
  }));
});

test("W4: Main's inbox shows the operation, in full and in the summary", async () => {
  await withTemp("acp-w4-inbox-", async (directory) => {
    const service = new GatewayService({
      protectedPaths: [],
      createClient: (_provider, options) => new AcpClient(
        { provider: "mock", command: process.execPath, args: [permissionAgent], permissionPolicy: "ask" },
        options
      )
    });
    try {
      await service.init();
      const context = { rootId: "main-a" };
      const { sessionId } = await service.call("session_open", { provider: "claude", cwd: directory, permissionPolicy: "ask" }, context);
      const pending = await service.call("run", {
        sessionId,
        prompt: JSON.stringify({ steps: [{ terminal: { command: "git", args: ["status", "--short"], env: [{ name: "GIT_DIR", value: "/elsewhere" }] } }] }),
        waitMs: 10_000
      }, context);
      assert.equal(pending.status, "input_required");
      const [full] = (await service.call("inbox", { action: "list" }, context)).items;
      assert.deepEqual(full.toolCall.rawInput, { command: "git", args: ["status", "--short"], cwd: directory, env: ["GIT_DIR"] });
      const [summary] = (await service.call("inbox", { action: "list", detail: "summary" }, context)).items;
      assert.equal(summary.toolCall.title, "Run: git status --short", "the summary keeps only the title, so it names the command");
      assert.doesNotMatch(JSON.stringify(full), /elsewhere/);
    } finally {
      await service.shutdown();
    }
  });
});

// ------------------------------------------------------------------ W4: binding

test("W4: approving an execute request lets that command through once, wrapped in a shell or not", async () => {
  await withTemp("acp-w4-bind-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    // [what the permission request named, the terminal/create argv that follows].
    // No login shell is run: what a profile prints would be this machine's.
    const cases = [
      ["echo bound", ["echo", "bound"]],
      ["echo   bound", ["sh", "-c", "echo bound"]],
      ["bash -lc 'echo bound'", ["echo", "bound"]],
      ["sh -c \"echo bound\"", ["/bin/bash", "-c", "echo  bound"]],
      [["bash", "-lc", "echo bound"], ["sh", "-c", "echo bound"]],
      [["/bin/zsh", "-l", "-c", "echo bound"], ["echo", "bound"]]
    ];
    for (const [approved, argv] of cases) {
      const before = requests.length;
      const turn = run([
        { permission: { kind: "execute", command: approved } },
        { terminal: { command: argv[0], args: argv.slice(1) } }
      ]);
      const asked = await request(requests, before + 1);
      client.respondPermission(asked.requestId, "allow", sessionId);
      const [permission, terminal] = await turn;
      assert.equal(permission, "allow");
      assert.equal(terminal.output, "bound\n", JSON.stringify(approved));
      assert.equal(requests.length, before + 1, `${JSON.stringify(approved)} ran ${argv.join(" ")} without a second request`);
    }
  }));
});

test("W4: a different command, a second run or a later turn goes back to Main with the full command", async () => {
  await withTemp("acp-w4-mismatch-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    const turn = run([
      { permission: { kind: "execute", command: "echo bound" } },
      { terminal: { command: "/bin/echo", args: ["other"] } },
      { terminal: { command: "echo", args: ["bound"] } },
      { terminal: { command: "echo", args: ["bound"] } },
      // A word after the script is its $0, not an argument: not the approved command.
      { terminal: { command: "sh", args: ["-c", "echo", "bound"] } }
    ]);
    client.respondPermission((await request(requests, 1)).requestId, "allow", sessionId);
    const other = await request(requests, 2);
    assert.equal(other.toolCall.title, "Run: /bin/echo other");
    assert.deepEqual(other.toolCall.rawInput, { command: "/bin/echo", args: ["other"], cwd: directory, env: [] });
    await client.respondPermission(other.requestId, "reject-once", sessionId);
    const again = await request(requests, 3);
    assert.equal(again.toolCall.title, "Run: echo bound", "the approval was spent by the first echo bound");
    await client.respondPermission(again.requestId, "reject-once", sessionId);
    const shifted = await request(requests, 4);
    assert.equal(shifted.toolCall.title, "Run: sh -c echo bound");
    await client.respondPermission(shifted.requestId, "reject-once", sessionId);
    assert.deepEqual(await turn, [
      "allow",
      "terminal-error: Main rejected ACP operation",
      { output: "bound\n", exitStatus: { exitCode: 0, signal: null } },
      "terminal-error: Main rejected ACP operation",
      "terminal-error: Main rejected ACP operation"
    ]);

    const approve = run([{ permission: { kind: "execute", command: "echo later" } }]);
    client.respondPermission((await request(requests, 5)).requestId, "allow", sessionId);
    assert.deepEqual(await approve, ["allow"]);
    const later = run([{ terminal: { command: "echo", args: ["later"] } }]);
    const expired = await request(requests, 6);
    assert.equal(expired.toolCall.title, "Run: echo later", "an approval ends with its turn");
    await client.respondPermission(expired.requestId, "reject-once", sessionId);
    assert.deepEqual(await later, ["terminal-error: Main rejected ACP operation"]);
  }));
});

test("W4: approving an edit lets writes through to the files it named, each once, and asks about any other", async () => {
  await withTemp("acp-w4-edit-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    await mkdir(join(directory, "src"));
    const approved = join(directory, "src", "approved.txt");
    const other = join(directory, "src", "other.txt");
    const turn = run([
      // Relative to the session root, the way #permissionScope reads it.
      { permission: { kind: "edit", path: "src/approved.txt" } },
      { write: { path: join(directory, "src", "..", "src", "approved.txt"), content: "a" } },
      { write: { path: approved, content: "again" } },
      { write: { path: other, content: "b" } }
    ]);
    client.respondPermission((await request(requests, 1)).requestId, "allow", sessionId);
    const twice = await request(requests, 2);
    assert.equal(twice.toolCall.title, `Write ${approved} (5 bytes)`);
    await client.respondPermission(twice.requestId, "reject-once", sessionId);
    const elsewhere = await request(requests, 3);
    assert.deepEqual(elsewhere.toolCall.locations, [{ path: other }]);
    assert.equal(elsewhere.toolCall.title, `Write ${other} (1 byte)`);
    await client.respondPermission(elsewhere.requestId, "reject-once", sessionId);
    assert.deepEqual(await turn, [
      "allow",
      "write-ok",
      "write-error: Main rejected ACP operation",
      "write-error: Main rejected ACP operation"
    ]);
    assert.equal(await readFile(approved, "utf8"), "a");
    assert.equal(existsSync(other), false);
  }));
});

test("W4: a write Main could not allow is refused before Main is asked", async () => {
  await withTemp("acp-w4-precheck-", async (directory) => {
    const root = join(directory, "root");
    const guarded = join(root, "guarded");
    await mkdir(guarded, { recursive: true });
    await withClient({ cwd: root, protectedPaths: [guarded] }, async ({ requests, run }) => {
      assert.deepEqual(await run([
        { write: { path: join(guarded, "install.json"), content: "{}" } },
        { write: { path: join(directory, "outside.txt"), content: "x" } },
        { terminal: { command: "/bin/cat", args: [join(guarded, "install.json")] } }
      ]), [
        `write-error: Path is protected by the Gateway: ${join(guarded, "install.json")}`,
        `write-error: Path is outside ACP session roots: ${join(directory, "outside.txt")}`,
        "terminal-error: Terminal command names a path protected by the Gateway"
      ]);
      assert.equal(requests.length, 0, "a protected path is never shown to Main");
    });
  });
});

// ------------------------------------------------------------------ W3: sandbox

test("W3: the terminal sandbox is sandbox-exec on macOS and none elsewhere; one that cannot start is not ready", async () => {
  assert.equal(detectTerminalSandbox({ platform: "linux" }), null);
  assert.equal(detectTerminalSandbox({ platform: "darwin", executable: "/nonexistent/sandbox-exec" }), null);
  if (existsSync(SANDBOX_EXEC)) {
    assert.equal(detectTerminalSandbox({ platform: "darwin" }).wrap("ls", [], []).command, SANDBOX_EXEC);
  }
  assert.equal(await seatbeltSandbox("/nonexistent/sandbox-exec").ready(), false);
  assert.equal(await seatbeltSandbox("/usr/bin/false").ready(), false, "a sandbox-exec that cannot apply a profile");
});

test("W3: the profile denies each protected path in its real form, escaped, and nothing else", async () => {
  await withTemp("acp-w3-profile-", async (directory) => {
    const dir = join(directory, "dir");
    await mkdir(dir);
    const socket = join(directory, "gateway.sock");
    await writeFile(socket, "");
    const missing = join(directory, "missing", "deeper");
    const quoted = join(directory, "we\"ird\\name");
    await mkdir(quoted);
    // tmpdir() is a symlink into /private on macOS: the profile has to name the
    // real path, which is all Seatbelt ever matches.
    const viaLink = join(tmpdir(), basename(directory), "dir");
    const profile = terminalSandboxProfile([viaLink, socket, missing, quoted, dir]);
    const filters = [
      `(subpath ${sbplString(dir)})`,
      `(literal ${sbplString(socket)})`,
      `(subpath ${sbplString(missing)})`,
      `(subpath ${sbplString(quoted)})`
    ].join(" ");
    assert.equal(profile, [
      "(version 1)",
      "(allow default)",
      `(deny file-read* file-write* ${filters})`,
      `(deny network-outbound ${filters})`
    ].join("\n"));
    assert.equal(sbplString("a\"b\\c"), "\"a\\\"b\\\\c\"");
    assert.equal(terminalSandboxProfile([]), "(version 1)\n(allow default)");
    assert.deepEqual(
      seatbeltSandbox("/x/sandbox-exec").wrap("cat", ["a b"], []),
      { command: "/x/sandbox-exec", args: ["-p", "(version 1)\n(allow default)", "cat", "a b"] }
    );
  });
});

test("W3: the escaped profile is one sandbox-exec applies", { skip: noOsSandbox }, async () => {
  await withTemp("acp-w3-escape-", async (directory) => {
    const quoted = join(directory, "we\"ird\\name");
    await mkdir(quoted);
    await writeFile(join(quoted, "canary"), "CANARY");
    await writeFile(join(directory, "normal"), "NORMAL");
    const { command, args } = osSandbox.wrap("/bin/cat", [join(quoted, "canary")], [quoted]);
    const denied = spawnSync(command, args, { encoding: "utf8" });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /Operation not permitted/);
    const normal = osSandbox.wrap("/bin/cat", [join(directory, "normal")], [quoted]);
    assert.equal(spawnSync(normal.command, normal.args, { encoding: "utf8" }).stdout, "NORMAL");
  });
});

test("W3: on macOS a Gateway terminal cannot read, write or connect into a protected path its command never names", { skip: noOsSandbox }, async () => {
  await withTemp("acp-w3-sandbox-", async (directory) => {
    const guarded = join(directory, "guarded");
    await mkdir(guarded);
    const canary = join(guarded, "canary.txt");
    await writeFile(canary, "CANARY-SECRET");
    const normal = join(directory, "normal.txt");
    await writeFile(normal, "NORMAL-CONTENT");
    const socketPath = join(guarded, "g.sock");
    const server = createServer((socket) => socket.end("CONNECTED"));
    await new Promise((done) => server.listen(socketPath, done));
    const connect = "const s=require('net').connect(process.env.SOCK);"
      + "s.on('data',(d)=>{process.stdout.write(String(d));process.exit(0)});"
      + "s.on('error',(e)=>{process.stdout.write(e.code);process.exit(3)})";
    const sh = (script, env) => ({ terminal: { command: "/bin/sh", args: ["-c", script], env } });
    try {
      await withClient({ cwd: directory, policy: "auto_approve", protectedPaths: [guarded] }, async ({ requests, run }) => {
        // The string checks pass every one of these: the path is in a variable.
        const [read, readNormal, write, socket, marker, killed] = await run([
          sh("cat \"$T\"", [{ name: "T", value: canary }]),
          sh("cat \"$T\"", [{ name: "T", value: normal }]),
          sh("echo pwned > \"$T\"", [{ name: "T", value: join(guarded, "new.txt") }]),
          { terminal: { command: process.execPath, args: ["-e", connect], env: [{ name: "SOCK", value: socketPath }] } },
          sh(`printf %s "$${GATEWAY_WORKER_ENV}"`, []),
          { terminal: { command: "/bin/sleep", args: ["30"], kill: true } }
        ]);
        assert.equal(requests.length, 0, "auto_approve still runs a sandboxed terminal itself");
        assert.doesNotMatch(read.output, /CANARY-SECRET/);
        assert.match(read.output, /Operation not permitted/);
        assert.notEqual(read.exitStatus.exitCode, 0, "the exit status is the command's");
        assert.deepEqual(readNormal, { output: "NORMAL-CONTENT", exitStatus: { exitCode: 0, signal: null } });
        assert.notEqual(write.exitStatus.exitCode, 0);
        assert.equal(existsSync(join(guarded, "new.txt")), false);
        assert.equal(socket.output, "EPERM", "the control socket is a network operation to Seatbelt, and denied too");
        assert.equal(marker.output, "1", "the env passes through the sandbox");
        assert.deepEqual(killed.exitStatus, { exitCode: null, signal: "SIGTERM" }, "terminal/kill reaches the sandboxed command");
      });
    } finally {
      server.close();
    }
  });
});

test("W3: where no sandbox is available, auto_approve sends a terminal to Main with its full command; writes stay automatic", async () => {
  await withTemp("acp-w3-fallback-", async (directory) => {
    const guarded = join(directory, "guarded");
    await mkdir(guarded);
    await withClient({ cwd: directory, policy: "auto_approve", protectedPaths: [guarded], terminalSandbox: null }, async ({ client, sessionId, requests, run }) => {
      const turn = run([
        { terminal: { command: "echo", args: ["fallback"] } },
        { write: { path: join(directory, "w.txt"), content: "w" } }
      ]);
      const asked = await request(requests, 1);
      assert.equal(asked.toolCall.title, "Run: echo fallback");
      assert.deepEqual(asked.toolCall.rawInput, { command: "echo", args: ["fallback"], cwd: directory, env: [] });
      await client.respondPermission(asked.requestId, "allow-once", sessionId);
      const [terminal, write] = await turn;
      assert.equal(terminal.output, "fallback\n");
      assert.equal(write, "write-ok");
      assert.equal(requests.length, 1);
    });
    // A sandbox-exec that cannot apply a profile here counts as none, and is not used.
    const wrapped = [];
    const broken = { ready: async () => false, wrap: (...call) => wrapped.push(call) };
    await withClient({ cwd: directory, policy: "auto_approve", protectedPaths: [guarded], terminalSandbox: broken }, async ({ client, sessionId, requests, run }) => {
      const turn = run([{ terminal: { command: "echo", args: ["unconfined"] } }]);
      await client.respondPermission((await request(requests, 1)).requestId, "allow-once", sessionId);
      assert.equal((await turn)[0].output, "unconfined\n");
      assert.equal(wrapped.length, 0);
    });
    // With nothing protected there is nothing to keep it from.
    await withClient({ cwd: directory, policy: "auto_approve", protectedPaths: [], terminalSandbox: null }, async ({ requests, run }) => {
      assert.equal((await run([{ terminal: { command: "echo", args: ["unprotected"] } }]))[0].output, "unprotected\n");
      assert.equal(requests.length, 0);
    });
  });
});

test("W3: every Gateway terminal runs in the sandbox, auto-approved or approved by Main", async () => {
  await withTemp("acp-w3-wrap-", async (directory) => {
    const guarded = join(directory, "guarded");
    await mkdir(guarded);
    const calls = [];
    const sandbox = standInSandbox(calls);
    await withClient({ cwd: directory, policy: "auto_approve", protectedPaths: [guarded], terminalSandbox: sandbox }, async ({ requests, run }) => {
      assert.equal((await run([{ terminal: { command: "echo", args: ["auto"] } }]))[0].output, "auto\n");
      assert.equal(requests.length, 0);
    });
    await withClient({ cwd: directory, policy: "ask", protectedPaths: [guarded], terminalSandbox: sandbox }, async ({ client, sessionId, requests, run }) => {
      const turn = run([{ terminal: { command: "echo", args: ["asked"] } }]);
      await client.respondPermission((await request(requests, 1)).requestId, "allow-once", sessionId);
      assert.equal((await turn)[0].output, "asked\n");
    });
    assert.deepEqual(calls, [
      { command: "echo", args: ["auto"], protectedPaths: [guarded] },
      { command: "echo", args: ["asked"], protectedPaths: [guarded] }
    ]);
  });
});

test("W3: a .acp-gateway path segment goes to Main under ask and auto_approve; only a resolved protected path is refused unasked", async () => {
  await withTemp("acp-w3-segment-", async (directory) => {
    const guarded = join(directory, "home", ".acp-gateway");
    await mkdir(guarded, { recursive: true });
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src", "paths.js"), "const directory = \".acp-gateway\";\n");
    const execute = (command) => ({ permission: { kind: "execute", command } });
    // A .acp-gateway segment, relative or absolute, that resolved from the
    // session root reaches nothing protected.
    const segments = [
      "cd ~ && cat .acp-gateway/install.json",
      "cat ../../.acp-gateway/install.json",
      "T=.acp-gateway/install.json; cat \"$T\"",
      ["bash", "-lc", "cd ~; cat .acp-gateway/install.json"],
      "cd .acp-gateway && cat install.json",
      "grep -rn \".acp-gateway\" src"
    ];
    for (const policy of ["ask", "auto_approve"]) {
      await withClient({ cwd: directory, policy, protectedPaths: [guarded], terminalSandbox: standInSandbox() }, async ({ client, sessionId, requests, run }) => {
        // A word that resolves into a protected path, literally or from the
        // root, is an error and never shown to Main.
        assert.deepEqual(await run([
          execute(`cat ${join(guarded, "install.json")}`),
          execute("cat home/.acp-gateway/install.json"),
          { terminal: { command: "/bin/cat", args: ["home/.acp-gateway/install.json"] } }
        ]), ["reject", "reject", "terminal-error: Terminal command names a path protected by the Gateway"], policy);
        assert.equal(requests.length, 0, `${policy}: a protected path is never shown to Main`);

        // A segment alone is a normal prompt, with the command the worker named.
        const asked = run(segments.map(execute));
        for (const [index, command] of segments.entries()) {
          const pending = await request(requests, index + 1);
          assert.deepEqual(pending.toolCall.rawInput, { command }, `${policy}: ${JSON.stringify(command)}`);
          client.respondPermission(pending.requestId, "reject", sessionId);
        }
        assert.deepEqual(await asked, segments.map(() => "reject"), policy);

        // A terminal too, with its full command, and what Main allows runs.
        const terminals = run([
          { terminal: { command: "grep", args: ["-rn", ".acp-gateway", "src"] } },
          { terminal: { command: "/bin/sh", args: ["-c", "cd ~ && cat .acp-gateway/install.json"] } }
        ]);
        const grep = await request(requests, segments.length + 1);
        assert.equal(grep.toolCall.title, "Run: grep -rn .acp-gateway src", policy);
        assert.deepEqual(grep.toolCall.rawInput, { command: "grep", args: ["-rn", ".acp-gateway", "src"], cwd: directory, env: [] });
        await client.respondPermission(grep.requestId, "allow-once", sessionId);
        const cat = await request(requests, segments.length + 2);
        assert.equal(cat.toolCall.title, "Run: /bin/sh -c 'cd ~ && cat .acp-gateway/install.json'", policy);
        await client.respondPermission(cat.requestId, "reject-once", sessionId);
        const [searched, refused] = await terminals;
        assert.match(searched.output, /^src\/paths\.js:1:.*\.acp-gateway/, policy);
        assert.equal(refused, "terminal-error: Main rejected ACP operation", policy);
      });
    }

    // Without the segment auto_approve still decides on its own.
    await withClient({ cwd: directory, policy: "auto_approve", protectedPaths: [guarded], terminalSandbox: standInSandbox() }, async ({ requests, run }) => {
      const [rg, longer, grep] = await run([
        execute("rg acp-gateway src"),
        execute("ls ~/.acp-gateway-old"),
        { terminal: { command: "grep", args: ["-rn", "acp-gateway", "src"] } }
      ]);
      assert.deepEqual([rg, longer], ["allow", "allow"]);
      assert.match(grep.output, /^src\/paths\.js:1:/);
      assert.equal(requests.length, 0);
    });

    // read_only cannot ask Main, so it refuses one, even a search.
    await withClient({ cwd: directory, policy: "read_only", protectedPaths: [guarded], terminalSandbox: standInSandbox() }, async ({ requests, run }) => {
      assert.deepEqual(await run([
        { permission: { kind: "search", command: "grep -rn \".acp-gateway\" src" } },
        { permission: { kind: "search", command: "grep -rn acp-gateway src" } },
        execute("cd ~ && cat .acp-gateway/install.json"),
        { terminal: { command: "grep", args: ["-rn", ".acp-gateway", "src"] } }
      ]), ["reject", "allow", "reject", "terminal-error: Session permission policy is read_only"]);
      assert.equal(requests.length, 0);
    });
  });
});

// ------------------------------------------------------------------ P7

test("P7: a write or terminal waiting for Main counts its payload against the session's pending byte budget", async () => {
  await withTemp("acp-p7-", (directory) => withClient({
    cwd: directory,
    protectedPaths: [],
    maxPendingInputBytesPerSession: 4096
  }, async ({ client, sessionId, requests, run }) => {
    const first = join(directory, "first.txt");
    const second = join(directory, "second.txt");
    const budget = /byte budget exceeded \(\d+\/4096\)$/;
    // Over the budget on its own: refused before Main is asked.
    assert.match((await run([{ write: { path: first, bytes: 5_000 } }]))[0], budget);
    assert.equal(requests.length, 0);
    // Each fits alone, not both: the second is refused while the first holds its bytes.
    const turn = run([{ parallel: [{ write: { path: first, bytes: 3_000 } }, { write: { path: second, bytes: 3_000 } }] }]);
    const held = await request(requests, 1);
    assert.equal(held.toolCall.rawInput.bytes, 3_000);
    await client.respondPermission(held.requestId, "allow-once", sessionId);
    const [[written, refused]] = await turn;
    assert.equal(written, "write-ok");
    assert.match(refused, budget);
    assert.equal(requests.length, 1);
    // Released once answered: the same write fits again.
    const again = run([{ write: { path: second, bytes: 3_000 } }]);
    await client.respondPermission((await request(requests, 2)).requestId, "reject-once", sessionId);
    assert.deepEqual(await again, ["write-error: Main rejected ACP operation"]);
    // A terminal's whole request counts too.
    assert.match((await run([{ terminal: { command: "echo", args: ["y".repeat(5_000)] } }]))[0], budget);
    assert.equal(requests.length, 2);
  }));
});

// ------------------------------------------------------------------ P2

test("P2: stop() ends a provider and terminals that ignore SIGTERM, process groups included, and waits for them", async () => {
  await withTemp("acp-p2-", async (directory) => {
    const ignoreTerm = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    // A terminal that starts a child ignoring SIGTERM, outside its pipes, and
    // writes both pids to pidFile; stubborn: it ignores SIGTERM itself as well.
    const terminalScript = (pidFile, stubborn) => [
      stubborn ? ignoreTerm : "setInterval(() => {}, 1000);",
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(ignoreTerm)}], { stdio: 'ignore' });`,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));`
    ].join("\n");
    // Unsandboxed, and on macOS also inside sandbox-exec, where the sandboxed
    // command is the child the Gateway signals.
    for (const terminalSandbox of osSandbox ? [null, osSandbox] : [null]) {
      const pidFiles = [join(directory, "stubborn.json"), join(directory, "leaves-a-child.json")];
      const client = new AcpClient(
        { provider: "mock", command: process.execPath, args: [permissionAgent], env: { ACP_MOCK_IGNORE_SIGTERM: "1" }, permissionPolicy: "auto_approve" },
        { protectedPaths: terminalSandbox ? [join(directory, "guarded")] : [], terminalSandbox, killGraceMs: 300 }
      );
      let survivors = [];
      try {
        await client.start();
        const provider = client.proc.pid;
        const { sessionId } = await client.sessionNew({ cwd: directory, permissionPolicy: "auto_approve" });
        const hold = (pidFile, stubborn) => ({ terminal: { command: process.execPath, args: ["-e", terminalScript(pidFile, stubborn)], hold: true } });
        const held = await client.sessionPrompt({
          sessionId,
          prompt: JSON.stringify({ steps: [hold(pidFiles[0], true), hold(pidFiles[1], false)] })
        });
        assert.deepEqual(JSON.parse(held.stopReason), ["terminal-held", "terminal-held"]);
        // A file can be there before its content is: wait until both parse.
        const pidsIn = async (file) => {
          try {
            return JSON.parse(await readFile(file, "utf8"));
          } catch {
            return null;
          }
        };
        await until(async () => (await Promise.all(pidFiles.map(pidsIn))).every(Boolean), "the terminals to start their children");
        const terminals = (await Promise.all(pidFiles.map(pidsIn))).flat();
        survivors = [provider, ...terminals];
        const started = Date.now();
        await client.stop();
        const took = Date.now() - started;
        for (const pid of survivors) assert.equal(processGone(pid), true, `pid ${pid} outlived stop()`);
        assert.ok(took >= 300, `SIGTERM alone ended them in ${took}ms`);
        assert.ok(took < 5_000, `stop() took ${took}ms`);
      } finally {
        await client.stop().catch(() => {});
        for (const pid of survivors) if (!processGone(pid)) process.kill(pid, "SIGKILL");
        for (const file of pidFiles) await rm(file, { force: true });
      }
    }
  });
});

test("P2: once a terminal's group is found gone its SIGKILL is disarmed, and that group id is never signalled again", async () => {
  const graceMs = 100;
  const sleep = (how) => ({ terminal: { command: "/bin/sleep", args: ["30"], [how]: true } });
  // Each way the Gateway ends a running terminal: the turn that starts it, and
  // what ends it then.
  const endings = [
    ["terminal/release", [sleep("release")], async () => {}],
    ["cancel", [sleep("hold")], async ({ client, sessionId }) => client.cancelSession(sessionId)],
    ["provider exit", [sleep("hold")], async ({ client }) => {
      client.proc.kill("SIGKILL");
      await until(() => !client.alive, "the provider exit");
    }],
    ["stop()", [sleep("hold")], async ({ client }) => client.stop()]
  ];
  await withTemp("acp-p2-disarm-", async (directory) => {
    for (const [ending, steps, end] of endings) {
      // What the client signals and checks the terminal's group with. A check
      // finds a member left the first time and none the second; after that the
      // id answers as if another group of this user had taken it. Only the
      // SIGTERM is really sent, so the terminal still ends.
      let group = null;
      let checks = 0;
      const signals = [];
      const killProcess = (pid, signal) => {
        if (group === null && pid < 0) group = -pid;
        if (pid !== -group) return process.kill(pid, signal);
        signals.push(signal);
        if (signal === "SIGTERM") return process.kill(pid, signal);
        if (signal !== 0) return true;
        checks += 1;
        if (checks === 2) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        return true;
      };
      await withClient({ cwd: directory, policy: "auto_approve", protectedPaths: [], killGraceMs: graceMs, killProcess }, async (session) => {
        await session.run(steps);
        await end(session);
        await until(() => checks >= 2 || signals.includes("SIGKILL"), `${ending}: the group found gone`);
        await delay(graceMs * 3);
        assert.deepEqual(signals, ["SIGTERM", 0, 0], `${ending}: nothing reaches the id once its group was found gone`);
        await until(() => processGone(group), `${ending}: the terminal to end`);
      });
    }
  });
});

test("P2: a terminal's group that keeps a member through the grace still gets the SIGKILL", async () => {
  await withTemp("acp-p2-armed-", async (directory) => {
    // Every check of the group finds a member left; only the SIGTERM is sent.
    const signals = [];
    let group = null;
    const killProcess = (pid, signal) => {
      if (group === null && pid < 0) group = -pid;
      if (pid !== -group) return process.kill(pid, signal);
      signals.push(signal);
      return signal === "SIGTERM" ? process.kill(pid, signal) : true;
    };
    await withClient({ cwd: directory, policy: "auto_approve", protectedPaths: [], killGraceMs: 100, killProcess }, async ({ run }) => {
      assert.deepEqual(await run([{ terminal: { command: "/bin/sleep", args: ["30"], release: true } }]), ["terminal-released"]);
      await until(() => signals.includes("SIGKILL"), "the SIGKILL");
      assert.equal(signals[0], "SIGTERM");
      assert.ok(signals.slice(1, signals.indexOf("SIGKILL")).every((signal) => signal === 0), "checked until then");
      // A grace (100 ms) after the SIGKILL the checks stop as well.
      await delay(500);
      const settled = signals.length;
      await delay(150);
      assert.equal(signals.length, settled, "and left alone a grace after the SIGKILL");
      assert.equal(signals.filter((signal) => signal === "SIGKILL").length, 1);
      await until(() => processGone(group), "the terminal to end");
    });
  });
});
