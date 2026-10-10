import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants, existsSync, openSync, readFileSync, renameSync, statSync, symlinkSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { GATEWAY_WORKER_ENV } from "../src/caller.js";
import { GatewayService } from "../src/gateway-service.js";
import { cwdCheckingLaunch, startInApprovedCwd, TERMINAL_CWD_CHANGED_EXIT_CODE, TERMINAL_CWD_SHELL } from "../src/terminal-cwd.js";
import {
  detectTerminalSandbox,
  SANDBOX_EXEC,
  sbplString,
  seatbeltSandbox,
  terminalSandboxProfile
} from "../src/terminal-sandbox.js";
import { processGone, withTemp } from "./helpers/scratch.js";

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

// ------------------------------------------------------------------ W4: display

// F1: an approval binds to what a command does. The values of the env that
// decide that — the loader names and whatever the command line interpolates —
// are shown to Main; every other value stays hidden, as before. (This replaces
// the earlier assertion that *no* env value was ever shown: hiding the value of
// a variable the command interpolates was exactly how an approval could cover a
// command Main never saw.)
test("W4/F1: a terminal waiting for Main shows the env values that decide what runs and hides the rest", async () => {
  await withTemp("acp-w4-terminal-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    const script = 'printf %s "$WORKER_TOKEN"';
    const turn = run([{
      terminal: {
        command: "/bin/sh",
        args: ["-c", script],
        env: [
          // Interpolated by the command: its value is part of what runs, so shown.
          { name: "WORKER_TOKEN", value: "s3cret-value" },
          // A loader variable: shown.
          { name: "PATH", value: "/custom/bin:/usr/bin" },
          // Neither: a worker-supplied value Main does not decide on, hidden.
          { name: "API_KEY", value: "hidden-key" }
        ]
      }
    }]);
    const asked = await request(requests, 1);
    assert.deepEqual(asked.toolCall, {
      toolCallId: `client-${asked.requestId}`,
      title: `Run: /bin/sh -c '${script}'`,
      kind: "execute",
      rawInput: {
        command: "/bin/sh",
        args: ["-c", script],
        cwd: directory,
        env: [
          { name: "WORKER_TOKEN", value: "s3cret-value" },
          { name: "PATH", value: "/custom/bin:/usr/bin" },
          { name: "API_KEY" }
        ]
      }
    });
    assert.match(JSON.stringify(asked), /s3cret-value/, "the interpolated value is shown");
    assert.match(JSON.stringify(asked), /custom\/bin/, "the loader value is shown");
    assert.doesNotMatch(JSON.stringify(asked), /hidden-key/, "an opaque value is not");
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
        prompt: JSON.stringify({ steps: [{ terminal: { command: "git", args: ["status", "--short"], env: [{ name: "GIT_AUTHOR_NAME", value: "Somebody Elsewhere" }] } }] }),
        waitMs: 10_000
      }, context);
      assert.equal(pending.status, "input_required");
      const [full] = (await service.call("inbox", { action: "list" }, context)).items;
      // GIT_AUTHOR_NAME is data: it makes git load or run nothing, and the
      // command does not interpolate it, so its value stays hidden; the env
      // entry is {name} rather than a bare name.
      assert.deepEqual(full.toolCall.rawInput, { command: "git", args: ["status", "--short"], cwd: directory, env: [{ name: "GIT_AUTHOR_NAME" }] });
      const [summary] = (await service.call("inbox", { action: "list", detail: "summary" }, context)).items;
      assert.equal(summary.toolCall.title, "Run: git status --short", "the summary keeps only the title, so it names the command");
      assert.doesNotMatch(JSON.stringify(full), /Elsewhere/);
    } finally {
      await service.shutdown();
    }
  });
});

// ------------------------------------------------------------------ W4: binding

test("W4: approving an execute request lets the same command through once, string or argv", async () => {
  await withTemp("acp-w4-bind-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    // [what the permission request named, the terminal/create argv that follows].
    // The grant matches only the SAME command shape, compared argv word for word:
    // a plain command-line string tokenizes to the argv it names, and an argv
    // matches the identical argv. A different shape (a literal argv vs a shell
    // script that happens to run the same thing, or a login shell) is NOT the
    // same command and is re-asked — that is the next test.
    const cases = [
      ["echo bound", ["echo", "bound"]],
      [["echo", "bound"], ["echo", "bound"]],
      ["sh -c \"echo bound\"", ["sh", "-c", "echo bound"]],
      [["sh", "-c", "echo bound"], ["sh", "-c", "echo bound"]]
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

test("F1: a literal argv, a shell-metacharacter script and a login shell are distinct grants, not interchangeable", async () => {
  await withTemp("acp-f1-shell-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    // [approved permission command, the terminal/create that must NOT be covered].
    // A literal argv is what spawn runs verbatim; a shell -c with metacharacters
    // runs a different program; a login shell sources profiles first.
    const notCovered = [
      // The literal args "a;" and "./x" are printed, not run; sh -c would run ./x.
      [["echo", "a; ./x"], { command: "sh", args: ["-c", "echo a; ./x"] }],
      [["echo", "$(./x)"], { command: "sh", args: ["-c", "echo $(./x)"] }],
      // A newline in the script runs a second command; a literal argv never does.
      [["echo", "a"], { command: "sh", args: ["-c", "echo a\nrm -rf x"] }],
      // A quoted-literal script word is not the same word as the bare script.
      [["sh", "-c", "'echo a; ./x'"], { command: "sh", args: ["-c", "echo a; ./x"] }],
      // A `#` comment, and a quote that is not a whole field, make a string
      // grant opaque: it tokenizes to nothing a shell would run, so it covers
      // neither the command before the comment nor the concatenated word.
      ["git commit -m ok # --no-verify", { command: "git", args: ["commit", "-m", "ok"] }],
      ["rm \"a\"b", { command: "rm", args: ["ab"] }],
      // A plain command must not be spent as a login shell.
      ["echo hi", { command: "bash", args: ["-lc", "echo hi"] }],
      [["echo", "hi"], { command: "zsh", args: ["-l", "-c", "echo hi"] }]
    ];
    for (const [approved, terminal] of notCovered) {
      const before = requests.length;
      const turn = run([
        { permission: { kind: "execute", command: approved } },
        { terminal }
      ]);
      client.respondPermission((await request(requests, before + 1)).requestId, "allow", sessionId);
      // The grant does not cover it: the terminal comes back to Main as its own request.
      const asked = await request(requests, before + 2);
      await client.respondPermission(asked.requestId, "reject-once", sessionId);
      assert.deepEqual(await turn, ["allow", "terminal-error: Main rejected ACP operation"], JSON.stringify(approved));
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

// ============================================================================
// 1.8.0 final-review regressions (F1, F2, F3, F8, F9)
// ============================================================================

// ---------------------------------------------------------------- F1: grant env/cwd

test("F1: an execute approval is bound to its cwd; the same command in another directory is asked anew", async () => {
  await withTemp("acp-f1-cwd-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    await mkdir(join(directory, "sub"));
    const turn = run([
      { permission: { kind: "execute", command: "/bin/echo hi" } },
      // Same argv and env, but a different working directory: not the one approved.
      { terminal: { command: "/bin/echo", args: ["hi"], cwd: join(directory, "sub") } },
      // The approved cwd still runs on the one approval.
      { terminal: { command: "/bin/echo", args: ["hi"] } }
    ]);
    client.respondPermission((await request(requests, 1)).requestId, "allow", sessionId);
    const moved = await request(requests, 2);
    assert.equal(moved.toolCall.rawInput.cwd, join(directory, "sub"));
    await client.respondPermission(moved.requestId, "reject-once", sessionId);
    assert.deepEqual(await turn, [
      "allow",
      "terminal-error: Main rejected ACP operation",
      { output: "hi\n", exitStatus: { exitCode: 0, signal: null } }
    ]);
    assert.equal(requests.length, 2, "only the moved command went back to Main");
  }));
});

// One realpath: a Worker's path, an approval and a terminal's cwd are each
// resolved by the system realpath, so on a case-insensitive volume (macOS by
// default) every one of them takes the case on disk, as the session roots
// always did. The JavaScript realpath, which writes and approvals went through,
// kept the case each was spelled in: an approval and the write or terminal it
// covered then compared unequal, and a path spelled in another case than the
// root failed the root check.
const upperTemp = tmpdir().toUpperCase();
const caseInsensitiveTemp = upperTemp !== tmpdir() && existsSync(upperTemp);

test("an approval, the write or terminal it covers and the root check compare one spelling, whatever its letter case", {
  skip: caseInsensitiveTemp ? false : "the temp directory is on a case-sensitive volume"
}, async () => {
  await withTemp("acp-case-", async (directory) => {
    const root = join(directory, "root");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "approved.txt"), "before");
    await withClient({ cwd: root, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
      const turn = run([
        // Approved in one case, written in another: one file, one approval.
        { permission: { kind: "edit", path: join(directory, "ROOT", "Src", "APPROVED.txt") } },
        { write: { path: join(directory, "Root", "SRC", "approved.TXT"), content: "after" } },
        // A new file: its directory takes the case on disk, its name the one asked for.
        { permission: { kind: "edit", path: join(directory, "ROOT", "src", "new.txt") } },
        { write: { path: join(directory, "root", "SRC", "new.txt"), content: "new" } },
        // A terminal approved in one spelling of the root runs in another.
        { permission: { kind: "execute", command: "/bin/echo hi", cwd: join(directory, "ROOT") } },
        { terminal: { command: "/bin/echo", args: ["hi"], cwd: join(directory, "Root") } }
      ]);
      for (const count of [1, 2, 3]) client.respondPermission((await request(requests, count)).requestId, "allow", sessionId);
      assert.deepEqual(await turn, [
        "allow", "write-ok",
        "allow", "write-ok",
        "allow", { output: "hi\n", exitStatus: { exitCode: 0, signal: null } }
      ]);
      assert.equal(requests.length, 3, "each ran on its approval, without a second request");
    });
    assert.equal(await readFile(join(root, "src", "approved.txt"), "utf8"), "after");
    assert.deepEqual((await readdir(join(root, "src"))).sort(), ["approved.txt", "new.txt"]);
  });
});

// N1 (release-gate review): the grant compares the whole explicit env. Before,
// only the execution-affecting and interpolated names were compared, so a
// variable on no list (PYTHONPATH then) rode along on an approval unseen.
test("N1: an execute approval is bound to its whole env; a variable added, removed or changed is asked anew", async () => {
  await withTemp("acp-n1-env-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    const turn = run([
      { permission: { kind: "execute", command: "/bin/echo hi", env: [{ name: "PATH", value: "/safe/bin" }] } },
      // PATH swapped: not the environment the approval named.
      { terminal: { command: "/bin/echo", args: ["hi"], env: [{ name: "PATH", value: "/evil/bin" }] } },
      // LD_PRELOAD added, which the approval never carried.
      { terminal: { command: "/bin/echo", args: ["hi"], env: [{ name: "PATH", value: "/safe/bin" }, { name: "LD_PRELOAD", value: "/x.so" }] } },
      // LD_AUDIT added: the glibc audit interface loads it like LD_PRELOAD.
      { terminal: { command: "/bin/echo", args: ["hi"], env: [{ name: "PATH", value: "/safe/bin" }, { name: "LD_AUDIT", value: "/a.so" }] } },
      // A variable on no list added: asked too, since no list is complete.
      { terminal: { command: "/bin/echo", args: ["hi"], env: [{ name: "PATH", value: "/safe/bin" }, { name: "NOTE", value: "fyi" }] } },
      // The approved PATH left out.
      { terminal: { command: "/bin/echo", args: ["hi"] } },
      // Exactly the approved env: the one approval.
      { terminal: { command: "/bin/echo", args: ["hi"], env: [{ name: "PATH", value: "/safe/bin" }] } }
    ]);
    client.respondPermission((await request(requests, 1)).requestId, "allow", sessionId);
    for (const count of [2, 3, 4, 5, 6]) {
      await client.respondPermission((await request(requests, count)).requestId, "reject-once", sessionId);
    }
    assert.deepEqual(await turn, [
      "allow",
      "terminal-error: Main rejected ACP operation",
      "terminal-error: Main rejected ACP operation",
      "terminal-error: Main rejected ACP operation",
      "terminal-error: Main rejected ACP operation",
      "terminal-error: Main rejected ACP operation",
      { output: "hi\n", exitStatus: { exitCode: 0, signal: null } }
    ]);
    assert.equal(requests.length, 6, "each added, removed or swapped variable went back to Main");
  }));
});

// The review's case: Main approves a python3 -c with no env, and the Worker
// sends the same argv and cwd with PYTHONPATH pointing at a sitecustomize.py of
// its own, which Python would run first. A variable no list names is the same.
test("N1: the same argv and cwd with an interpreter's loader variable, or any other, added is not the approved command", async () => {
  await withTemp("acp-n1-loader-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    const argv = ["python3", "-c", "print('ok')"];
    const injected = join(directory, "injected");
    for (const variable of [{ name: "PYTHONPATH", value: injected }, { name: "WORKER_PLUGIN_DIR", value: injected }]) {
      const before = requests.length;
      const turn = run([
        { permission: { kind: "execute", command: argv } },
        { terminal: { command: argv[0], args: argv.slice(1), env: [variable] } }
      ]);
      client.respondPermission((await request(requests, before + 1)).requestId, "allow", sessionId);
      const asked = await request(requests, before + 2);
      // PYTHONPATH makes Python load code, so Main sees where it points; the
      // other is shown by name only, and asked about all the same.
      assert.deepEqual(asked.toolCall.rawInput.env, [variable.name === "PYTHONPATH" ? variable : { name: variable.name }]);
      await client.respondPermission(asked.requestId, "reject-once", sessionId);
      assert.deepEqual(await turn, ["allow", "terminal-error: Main rejected ACP operation"], variable.name);
    }
  }));
});

test("N1: a pending terminal shows the values of the variables that make a program load or run code, and only the names of the rest", async () => {
  await withTemp("acp-n1-shown-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    const shown = [
      ["PYTHONPATH", "/repo/injected"], ["PERL5OPT", "-Mevil"], ["RUBYOPT", "-revil"], ["NODE_PATH", "/repo/node"],
      ["JAVA_TOOL_OPTIONS", "-javaagent:/repo/a.jar"], ["CLASSPATH", "/repo/classes"], ["LUA_INIT", "@/repo/init.lua"],
      ["ZDOTDIR", "/repo/zsh"], ["ENV", "/repo/env.sh"], ["PROMPT_COMMAND", "./hook"], ["PS4", "$(./hook)"],
      ["HOME", "/repo/home"], ["GIT_DIR", "/repo/fake.git"], ["GIT_SSH_COMMAND", "./ssh"], ["GIT_CONFIG_COUNT", "1"],
      ["GIT_CONFIG_KEY_0", "core.fsmonitor"], ["GIT_CONFIG_VALUE_0", "./monitor"], ["EDITOR", "./edit"],
      ["PAGER", "./page"], ["LESSOPEN", "|./open %s"], ["DYLD_INSERT_LIBRARIES", "/repo/x.dylib"],
      ["BASH_FUNC_ls%%", "() { ./evil; }"]
    ].map(([name, value]) => ({ name, value }));
    const hidden = [{ name: "API_KEY", value: "hidden-key" }, { name: "GITHUB_TOKEN", value: "hidden-token" }];
    const turn = run([{ terminal: { command: "/bin/echo", args: ["hi"], env: [...shown, ...hidden] } }]);
    const asked = await request(requests, 1);
    assert.deepEqual(asked.toolCall.rawInput.env, [...shown, ...hidden.map(({ name }) => ({ name }))]);
    assert.doesNotMatch(JSON.stringify(asked), /hidden-/);
    await client.respondPermission(asked.requestId, "reject-once", sessionId);
    assert.deepEqual(await turn, ["terminal-error: Main rejected ACP operation"]);
  }));
});

// ACP's EnvVariable has a string value. Anything else would not be what Main is
// shown or what a grant compares: spawn passes a null on as "null" (a relative
// PYTHONPATH entry), and a missing value unsets the variable.
test("N1: a terminal env value that is not a string is refused before Main is asked", async () => {
  await withTemp("acp-n1-value-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ requests, run }) => {
    const refused = "terminal-error: Terminal env must be an array of {name, value}";
    assert.deepEqual(await run([
      { terminal: { command: "/bin/echo", args: ["hi"], env: [{ name: "PYTHONPATH", value: null }] } },
      { terminal: { command: "/bin/echo", args: ["hi"], env: [{ name: "PYTHONPATH" }] } },
      { terminal: { command: "/bin/echo", args: ["hi"], env: [{ name: "PYTHONPATH", value: 1 }] } }
    ]), [refused, refused, refused]);
    assert.equal(requests.length, 0);
  }));
});

test("F1: a command that uses indirect or arithmetic expansion is never bound; it is asked about every time", async () => {
  await withTemp("acp-f1-dynamic-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    // ${!CMD} reads whatever CMD holds, and $((i)) evaluates i: the Gateway cannot
    // know which variable decides what runs, so no approval covers a later run.
    const dynamic = [
      ["sh", "-c", "${!CMD}"],
      ["sh", "-c", "echo $((i))"]
    ];
    for (const argv of dynamic) {
      const before = requests.length;
      const turn = run([
        { permission: { kind: "execute", command: argv } },
        { terminal: { command: argv[0], args: argv.slice(1), env: [{ name: "CMD", value: "echo" }, { name: "i", value: "1" }] } }
      ]);
      // Approving the permission grants nothing.
      client.respondPermission((await request(requests, before + 1)).requestId, "allow", sessionId);
      // So the terminal is asked about on its own; reject it (we do not run it).
      const asked = await request(requests, before + 2);
      await client.respondPermission(asked.requestId, "reject-once", sessionId);
      assert.deepEqual(await turn, ["allow", "terminal-error: Main rejected ACP operation"], argv.join(" "));
    }
  }));
});

// ---------------------------------------------------------------- F2: write target binding

test("F2: a write whose symlink is repointed after approval is refused, and both files are untouched", async () => {
  await withTemp("acp-f2-retarget-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    const approved = join(directory, "approved.txt");
    const other = join(directory, "other.txt");
    const link = join(directory, "link");
    await writeFile(approved, "APPROVED");
    await writeFile(other, "OTHER");
    await symlink(approved, link);
    const turn = run([{ write: { path: link, content: "PWNED" } }]);
    const asked = await request(requests, 1);
    // Main is shown the target the link resolves to now.
    assert.deepEqual(asked.toolCall.locations, [{ path: approved }]);
    // While the approval waits, the worker repoints the link at another in-root file.
    await rm(link);
    await symlink(other, link);
    await client.respondPermission(asked.requestId, "allow-once", sessionId);
    const [outcome] = await turn;
    assert.match(outcome, /^write-error: Write target changed since it was approved/);
    assert.equal(await readFile(other, "utf8"), "OTHER", "the retargeted file is untouched");
    assert.equal(await readFile(approved, "utf8"), "APPROVED", "and so is the approved one");
  }));
});

test("F2: a write to an unchanged target still goes through", async () => {
  await withTemp("acp-f2-unchanged-", (directory) => withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
    const approved = join(directory, "approved.txt");
    const link = join(directory, "link");
    await writeFile(approved, "OLD");
    await symlink(approved, link);
    const turn = run([{ write: { path: link, content: "NEW" } }]);
    const asked = await request(requests, 1);
    assert.deepEqual(asked.toolCall.locations, [{ path: approved }]);
    await client.respondPermission(asked.requestId, "allow-once", sessionId);
    assert.deepEqual(await turn, ["write-ok"]);
    assert.equal(await readFile(approved, "utf8"), "NEW");
  }));
});

test("F2: a retarget-changed write reports only the approved path, never the out-of-root path it was steered to", async () => {
  await withTemp("acp-f2-noleak-", async (directory) => {
    const root = join(directory, "root");
    await mkdir(root, { recursive: true });
    const approved = join(root, "approved.txt");
    const link = join(root, "link");
    // A secret outside the roots; its resolution skips the root/protected check.
    const secret = join(directory, "SECRET-OUTSIDE");
    await writeFile(approved, "APPROVED");
    await writeFile(secret, "secret");
    await symlink(approved, link);
    await withClient({ cwd: root, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
      const turn = run([{ write: { path: link, content: "x" } }]);
      const asked = await request(requests, 1);
      await rm(link);
      await symlink(secret, link);
      await client.respondPermission(asked.requestId, "allow-once", sessionId);
      const [outcome] = await turn;
      assert.match(outcome, /^write-error: Write target changed since it was approved/);
      assert.doesNotMatch(outcome, /SECRET-OUTSIDE/, "the steered-to path is not echoed back to the worker");
      assert.equal(await readFile(secret, "utf8"), "secret", "and the secret is untouched");
    });
  });
});

test("F2: a new-file write whose parent is swapped to a symlink after the pre-check is refused on the fd-path check", async () => {
  await withTemp("acp-f2-newfile-", async (directory) => {
    const root = join(directory, "root");
    const sub = join(root, "sub");
    const evil = join(root, "evil");
    await mkdir(sub, { recursive: true });
    await mkdir(evil, { recursive: true });
    const approvedPath = join(sub, "new.txt");
    // Swap sub -> evil between the pre-check (sub still a real dir, so the check
    // passes) and the open, and leave it there (stable through openWorkerFile, so
    // its own recheck is self-consistent). The file then lands in evil, not at the
    // approved path — only the fd-path check catches it.
    let swapped = false;
    const beforeWriteOpen = async () => {
      if (swapped) return;
      swapped = true;
      await rm(sub, { recursive: true });
      await symlink(evil, sub);
    };
    await withClient({ cwd: root, protectedPaths: [], beforeWriteOpen }, async ({ client, sessionId, requests, run }) => {
      const turn = run([{ write: { path: approvedPath, content: "PWNED" } }]);
      const asked = await request(requests, 1);
      assert.deepEqual(asked.toolCall.locations, [{ path: approvedPath }]);
      await client.respondPermission(asked.requestId, "allow-once", sessionId);
      const [outcome] = await turn;
      assert.match(outcome, /^write-error: Write target changed since it was approved/);
      const landed = await readFile(join(evil, "new.txt"), "utf8").catch(() => null);
      assert.notEqual(landed, "PWNED", "the content never reached the swapped-in directory");
    });
  });
});

// ---------------------------------------------------------------- N2: approved cwd

// N2 (release-gate review): a pending terminal resolved its cwd again when
// Main approved it, so a Worker that re-pointed a symlinked cwd while Main
// decided ran the command in a directory Main never saw, inside the roots or
// not. Like a pending write (F2), it is now bound to the canonical cwd Main is
// shown and to the directory that was there.

// Writes where it ran into ran.txt there, then prints it.
const recordCwd = {
  command: process.execPath,
  args: ["-e", "require('node:fs').writeFileSync('ran.txt', process.cwd()); process.stdout.write(process.cwd())"]
};

test("N2: a pending terminal whose symlinked cwd is re-pointed while Main decides is refused, and runs nowhere", async () => {
  await withTemp("acp-n2-repoint-", async (directory) => {
    const approved = join(directory, "approved");
    const other = join(directory, "other");
    const current = join(directory, "current");
    await mkdir(approved);
    await mkdir(other);
    await symlink(approved, current);
    await withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
      const turn = run([{ terminal: { ...recordCwd, cwd: current } }]);
      const asked = await request(requests, 1);
      assert.equal(asked.toolCall.rawInput.cwd, approved, "Main is shown where the link leads now");
      await rm(current);
      await symlink(other, current);
      await client.respondPermission(asked.requestId, "allow-once", sessionId);
      assert.deepEqual(await turn, [`terminal-error: Terminal cwd changed since it was approved: ${approved}`]);
    });
    assert.equal(existsSync(join(other, "ran.txt")), false, "not in the directory the link was steered to");
    assert.equal(existsSync(join(approved, "ran.txt")), false, "nor anywhere else");
  });
});

test("N2: a pending terminal whose cwd was replaced by another directory at the same path is refused", async () => {
  await withTemp("acp-n2-replaced-", async (directory) => {
    const approved = join(directory, "approved");
    await mkdir(approved);
    await withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
      const turn = run([{ terminal: { ...recordCwd, cwd: approved } }]);
      const asked = await request(requests, 1);
      // The same canonical path, but not the directory Main was shown.
      await rename(approved, `${approved}.seen`);
      await mkdir(approved);
      await client.respondPermission(asked.requestId, "allow-once", sessionId);
      assert.deepEqual(await turn, [`terminal-error: Terminal cwd changed since it was approved: ${approved}`]);
    });
    assert.equal(existsSync(join(approved, "ran.txt")), false);
  });
});

test("N2: the refusal names only the approved cwd, never the directory outside the roots it was steered to", async () => {
  await withTemp("acp-n2-noleak-", async (directory) => {
    const root = join(directory, "root");
    const approved = join(root, "approved");
    const current = join(root, "current");
    const secret = join(directory, "SECRET-OUTSIDE");
    await mkdir(approved, { recursive: true });
    await mkdir(secret);
    await symlink(approved, current);
    await withClient({ cwd: root, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
      const turn = run([{ terminal: { ...recordCwd, cwd: current } }]);
      const asked = await request(requests, 1);
      await rm(current);
      await symlink(secret, current);
      await client.respondPermission(asked.requestId, "allow-once", sessionId);
      const [outcome] = await turn;
      assert.equal(outcome, `terminal-error: Terminal cwd changed since it was approved: ${approved}`);
      assert.doesNotMatch(outcome, /SECRET-OUTSIDE/);
    });
    assert.equal(existsSync(join(secret, "ran.txt")), false);
  });
});

test("N2: an unchanged pending terminal runs in the approved directory; granted and auto-approved ones start at once as before", async () => {
  await withTemp("acp-n2-unchanged-", async (directory) => {
    const approved = join(directory, "approved");
    const current = join(directory, "current");
    await mkdir(approved);
    await symlink(approved, current);
    const ran = { output: approved, exitStatus: { exitCode: 0, signal: null } };
    await withClient({ cwd: directory, protectedPaths: [] }, async ({ client, sessionId, requests, run }) => {
      const pending = run([{ terminal: { ...recordCwd, cwd: current } }]);
      await client.respondPermission((await request(requests, 1)).requestId, "allow-once", sessionId);
      assert.deepEqual(await pending, [ran]);
      // On a grant for the same command and cwd: no second request.
      const granted = run([
        { permission: { kind: "execute", command: [recordCwd.command, ...recordCwd.args], cwd: current } },
        { terminal: { ...recordCwd, cwd: current } }
      ]);
      client.respondPermission((await request(requests, 2)).requestId, "allow", sessionId);
      assert.deepEqual(await granted, ["allow", ran]);
      assert.equal(requests.length, 2);
    });
    await withClient({ cwd: directory, policy: "auto_approve", protectedPaths: [] }, async ({ requests, run }) => {
      assert.deepEqual(await run([{ terminal: { ...recordCwd, cwd: current } }]), [ran]);
      assert.equal(requests.length, 0);
    });
  });
});

// The check above is by path, and the child changed into its cwd by path after
// it, so a Worker that renamed the approved directory and put a link at its
// path in between still moved the command. The start itself is now bound to
// the directory (terminal-cwd.js): on Linux the child starts in a descriptor of
// it, elsewhere a script refuses to run the command anywhere else.

// The three ways a terminal starts, each with the policy it needs: approved by
// Main while it waits, on an approval Main gave the execute request before it,
// and on its own under auto_approve. start() resolves with the outcome of the
// terminal step.
const STARTS = {
  pending: {
    policy: "ask",
    start: async ({ client, sessionId, requests, run }, terminal) => {
      const before = requests.length;
      const turn = run([{ terminal }]);
      await client.respondPermission((await request(requests, before + 1)).requestId, "allow-once", sessionId);
      return (await turn)[0];
    }
  },
  granted: {
    policy: "ask",
    start: async ({ client, sessionId, requests, run }, terminal) => {
      const before = requests.length;
      const turn = run([
        { permission: { kind: "execute", command: [terminal.command, ...terminal.args], cwd: terminal.cwd } },
        { terminal }
      ]);
      client.respondPermission((await request(requests, before + 1)).requestId, "allow", sessionId);
      const [allowed, outcome] = await turn;
      assert.equal(allowed, "allow");
      assert.equal(requests.length, before + 1, "the approval covered the terminal");
      return outcome;
    }
  },
  "auto-approved": {
    policy: "auto_approve",
    start: async ({ run }, terminal) => (await run([{ terminal }]))[0]
  }
};

// The approved directory and another one under base, and where the approved
// one goes when a racing Worker moves it.
async function raceDirectories(base) {
  const dirs = { approved: join(base, "approved"), moved: join(base, "moved"), other: join(base, "other") };
  await mkdir(dirs.approved, { recursive: true });
  await mkdir(dirs.other);
  return dirs;
}

// What that Worker does once every check has passed, right before the first
// spawn: the approved directory goes elsewhere, and a link to the other one
// takes its path.
function swapBeforeSpawn({ approved, moved, other }) {
  let swaps = 0;
  return {
    beforeTerminalSpawn: () => {
      if (swaps++ > 0) return;
      renameSync(approved, moved);
      symlinkSync(other, approved);
    },
    swaps: () => swaps
  };
}

const procFd = process.platform === "linux" && existsSync("/proc/self/fd");
const linuxProc = procFd ? false : "Linux with /proc only";
const macOnly = process.platform === "darwin" ? false : "macOS only";

test("N2: on Linux a terminal starts in the approved directory itself, though its path is swapped right before the spawn", { skip: linuxProc }, async () => {
  await withTemp("acp-n2-procfd-", async (directory) => {
    for (const [way, { policy, start }] of Object.entries(STARTS)) {
      const dirs = await raceDirectories(join(directory, way));
      const race = swapBeforeSpawn(dirs);
      await withClient({ cwd: directory, policy, protectedPaths: [], beforeTerminalSpawn: race.beforeTerminalSpawn }, async (session) => {
        // Its cwd is named by the name the directory has now.
        assert.deepEqual(await start(session, { ...recordCwd, cwd: dirs.approved }), {
          output: dirs.moved,
          exitStatus: { exitCode: 0, signal: null }
        }, way);
      });
      assert.equal(race.swaps(), 1, way);
      assert.equal(readFileSync(join(dirs.moved, "ran.txt"), "utf8"), dirs.moved, `${way}: it ran in the approved directory`);
      assert.equal(existsSync(join(dirs.other, "ran.txt")), false, `${way}: not where the link leads`);
    }
  });
});

test("N2: on macOS a terminal whose path is swapped right before the spawn runs nothing and exits with the script's status", { skip: macOnly }, async () => {
  await withTemp("acp-n2-script-race-", async (directory) => {
    for (const [way, { policy, start }] of Object.entries(STARTS)) {
      const dirs = await raceDirectories(join(directory, way));
      const race = swapBeforeSpawn(dirs);
      await withClient({ cwd: directory, policy, protectedPaths: [], beforeTerminalSpawn: race.beforeTerminalSpawn }, async (session) => {
        assert.deepEqual(await start(session, { ...recordCwd, cwd: dirs.approved }), {
          output: `Terminal cwd changed since it was approved: ${dirs.approved}\n`,
          exitStatus: { exitCode: TERMINAL_CWD_CHANGED_EXIT_CODE, signal: null }
        }, way);
      });
      assert.equal(race.swaps(), 1, way);
      assert.equal(existsSync(join(dirs.other, "ran.txt")), false, `${way}: not where the link leads`);
      assert.equal(existsSync(join(dirs.moved, "ran.txt")), false, `${way}: nor anywhere else`);
    }
  });
});

test("N2: on macOS the script runs outside the terminal sandbox and execs sandbox-exec, so the command is what is sandboxed", { skip: noOsSandbox }, async () => {
  await withTemp("acp-n2-script-sandbox-", async (directory) => {
    const guarded = join(directory, "guarded");
    await mkdir(guarded);
    const dirs = await raceDirectories(join(directory, "race"));
    const race = swapBeforeSpawn(dirs);
    await withClient({ cwd: directory, policy: "auto_approve", protectedPaths: [guarded], beforeTerminalSpawn: race.beforeTerminalSpawn }, async ({ requests, run }) => {
      const [swapped, unswapped, missing] = await run([
        { terminal: { ...recordCwd, cwd: dirs.approved } },
        { terminal: { ...recordCwd, cwd: dirs.moved } },
        { terminal: { command: "acp-gateway-no-such-command", args: [] } }
      ]);
      assert.equal(requests.length, 0, "sandboxed, so started without Main");
      assert.deepEqual(swapped, {
        output: `Terminal cwd changed since it was approved: ${dirs.approved}\n`,
        exitStatus: { exitCode: TERMINAL_CWD_CHANGED_EXIT_CODE, signal: null }
      });
      assert.deepEqual(unswapped, { output: dirs.moved, exitStatus: { exitCode: 0, signal: null } });
      // A command that cannot start is still sandbox-exec's to report, as before.
      assert.equal(missing.exitStatus.exitCode, 71);
      assert.match(missing.output, /execvp\(\) of 'acp-gateway-no-such-command' failed/);
    });
    assert.equal(existsSync(join(dirs.other, "ran.txt")), false);
  });
});

const noDash = TERMINAL_CWD_SHELL && process.platform !== "win32" ? false : "no /bin/dash on this host";

test("N2: the cwd-checking script runs the command only in the approved directory and takes nothing else from its input", { skip: noDash }, async () => {
  await withTemp("acp-n2-script-", async (directory) => {
    const approved = join(directory, "approved");
    await mkdir(approved);
    const info = statSync(approved, { bigint: true });
    const identity = { dev: info.dev, ino: info.ino };
    const marker = join(directory, "ran");
    const touch = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`] };
    const script = (launch, { cwd = approved, as = identity, env = {} } = {}) => {
      const start = cwdCheckingLaunch(launch, cwd, as);
      return spawnSync(start.command, start.args, { cwd: start.cwd, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
    };
    const changed = (cwd) => [TERMINAL_CWD_CHANGED_EXIT_CODE, "", `Terminal cwd changed since it was approved: ${cwd}\n`];

    // The approved directory: the command runs there, its args as they are.
    const literal = ["$1", "`id`", "$(id)", "a b", "'q'", "-c"];
    const report = "process.stdout.write(JSON.stringify([process.cwd(), process.argv.slice(1)]))";
    const ran = script({ command: process.execPath, args: ["-e", report, ...literal] });
    assert.deepEqual([ran.status, JSON.parse(ran.stdout), ran.stderr], [0, [approved, literal], ""]);
    // Another directory's identity, or a cwd that is gone: nothing runs.
    const other = script(touch, { as: { dev: identity.dev, ino: identity.ino + 1n } });
    assert.deepEqual([other.status, other.stdout, other.stderr], changed(approved));
    const gone = script(touch, { cwd: join(directory, "gone") });
    assert.deepEqual([gone.status, gone.stdout, gone.stderr], changed(join(directory, "gone")));
    // A command named like an option is a command, not an option of the
    // shell's exec (bash's -c would run the next word).
    assert.equal(script({ command: "-c", args: [touch.command, ...touch.args] }).status, 127);
    assert.equal(existsSync(marker), false);

    // On macOS the script runs outside the sandbox, so it must take no code
    // from the terminal's environment, which the Worker chooses: dash takes
    // neither functions nor shell options from it, where bash would.
    const injected = script({ command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"] }, {
      env: { "BASH_FUNC_cd%%": "() { builtin cd /; }", SHELLOPTS: "xtrace", PS4: `$(${touch.command} -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")')` }
    });
    assert.deepEqual([injected.status, injected.stdout, injected.stderr], [0, approved, ""]);
    assert.equal(existsSync(marker), false);
  });
});

// Without dash the script is never run under another shell: bash, /bin/sh on
// macOS, Fedora and RHEL, would take functions and options, and with them
// commands, from the Worker's environment, outside the sandbox on macOS. Such a
// host starts the terminal by path right after the check by path, as before the
// binding, unless it can hold the directory (Linux with /proc). macOS ships
// dash, so there the script always runs.
test("N2: the script runs only under dash; without it a terminal starts by path, or in a held descriptor on Linux", async () => {
  if (process.platform === "darwin") assert.equal(TERMINAL_CWD_SHELL, "/bin/dash");
  assert.ok(TERMINAL_CWD_SHELL === "/bin/dash" || TERMINAL_CWD_SHELL === null, String(TERMINAL_CWD_SHELL));
  await withTemp("acp-n2-start-", async (directory) => {
    const approved = join(directory, "approved");
    await mkdir(approved);
    const info = statSync(approved, { bigint: true });
    const identity = { dev: info.dev, ino: info.ino };
    const launch = { command: "/bin/echo", args: ["hi"] };
    const byPath = { ...launch, cwd: approved };
    const startOf = (options) => {
      const start = startInApprovedCwd(launch, approved, identity, options);
      start.release();
      return { command: start.command, args: start.args, cwd: start.cwd };
    };
    assert.deepEqual(startOf({ platform: "darwin", shell: "/bin/dash" }), cwdCheckingLaunch(launch, approved, identity, "/bin/dash"));
    assert.deepEqual(startOf({ platform: "darwin", shell: null }), byPath, "no dash: by path, no script");
    assert.deepEqual(startOf({ platform: "win32", shell: "/bin/dash" }), byPath, "Windows: by path");

    // A kernel that refuses O_PATH (EINVAL) gets the directory opened for
    // reading instead; one that cannot be read then is left to the other
    // starts; anything else is a directory that is not there.
    const failing = (...codes) => {
      const flags = [];
      const open = (path, flag) => {
        flags.push(flag);
        const code = codes.shift();
        if (code) throw Object.assign(new Error(code), { code });
        return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
      };
      return { flags, open };
    };
    const retried = failing("EINVAL");
    const held = startOf({ platform: "linux", shell: null, open: retried.open });
    assert.equal(retried.flags.length, 2);
    assert.equal(retried.flags[1], constants.O_RDONLY | constants.O_DIRECTORY);
    if (procFd) assert.match(held.cwd, /^\/proc\/self\/fd\/\d+$/);
    else assert.deepEqual(held, byPath, "no /proc to lead a child to it: by path");
    assert.deepEqual(startOf({ platform: "linux", shell: "/bin/dash", open: failing("EINVAL", "EACCES").open }),
      cwdCheckingLaunch(launch, approved, identity, "/bin/dash"), "a directory it may enter but not read: the script");
    for (const codes of [["ENOENT"], ["EACCES"], ["EINVAL", "ENOENT"]]) {
      assert.throws(() => startOf({ platform: "linux", shell: "/bin/dash", open: failing(...codes).open }), {
        message: `Terminal cwd no longer resolves since it was approved: ${approved}`
      }, codes.join(" then "));
    }
  });
});

test("N2: with no dash injected, a terminal starts without the script and still in the approved directory", async () => {
  await withTemp("acp-n2-nodash-", async (directory) => {
    const approved = join(directory, "approved");
    await mkdir(approved);
    const starts = [];
    const beforeTerminalSpawn = (cwd, start) => starts.push({ cwd, command: start.command, startCwd: start.cwd });
    await withClient({ cwd: directory, policy: "auto_approve", protectedPaths: [], terminalCwdShell: null, beforeTerminalSpawn }, async ({ run }) => {
      assert.deepEqual(await run([{ terminal: { ...recordCwd, cwd: approved } }]), [{ output: approved, exitStatus: { exitCode: 0, signal: null } }]);
    });
    assert.equal(starts.length, 1);
    assert.equal(starts[0].cwd, approved);
    assert.equal(starts[0].command, recordCwd.command, "the command itself, not a shell around it");
    if (procFd) assert.match(starts[0].startCwd, /^\/proc\/self\/fd\/\d+$/);
    else assert.equal(starts[0].startCwd, approved, "by path, after the check by path");
    assert.equal(readFileSync(join(approved, "ran.txt"), "utf8"), approved);
  });
});

// ---------------------------------------------------------------- F3: output byte limit

test("F3: an invalid outputByteLimit is refused without crashing the daemon; a valid one still works", async () => {
  await withTemp("acp-f3-", (directory) => withClient({ cwd: directory, policy: "auto_approve", protectedPaths: [] }, async ({ requests, run }) => {
    const [bad, zero, negative, ok, defaulted] = await run([
      { terminal: { command: "echo", args: ["x"], outputByteLimit: "not-a-number" } },
      { terminal: { command: "echo", args: ["x"], outputByteLimit: 0 } },
      { terminal: { command: "echo", args: ["x"], outputByteLimit: -5 } },
      // A small valid limit truncates but runs, proving the daemon is still alive.
      { terminal: { command: "echo", args: ["ok"], outputByteLimit: 4 } },
      { terminal: { command: "echo", args: ["fine"] } }
    ]);
    const invalid = /^terminal-error: Terminal outputByteLimit must be a finite number of at least 1$/;
    assert.match(bad, invalid);
    assert.match(zero, invalid);
    assert.match(negative, invalid);
    assert.equal(ok.exitStatus.exitCode, 0);
    assert.equal(ok.output, "ok\n");
    assert.equal(defaulted.output, "fine\n", "the daemon kept running after the invalid requests");
    assert.equal(requests.length, 0);
  }));
});

// ---------------------------------------------------------------- F8: pending byte budget

test("F8: a pending operation holds its whole payload against the budget, not only the fields it uses", async () => {
  await withTemp("acp-f8-", (directory) => withClient({
    cwd: directory, protectedPaths: [], maxPendingInputBytesPerSession: 4096
  }, async ({ requests, run }) => {
    const path = join(directory, "small.txt");
    // Small content, but a large unused field the pending closure would retain.
    const [outcome] = await run([{ write: { path, content: "hi", pad: 8192 } }]);
    assert.match(outcome, /byte budget exceeded \(\d+\/4096\)$/);
    assert.equal(requests.length, 0, "refused before Main is asked");
  }));
});

// ---------------------------------------------------------------- F9: fatal provider teardown

test("F9: a provider that ignores SIGTERM is SIGKILLed on a fatal error, and the handle is released", async () => {
  const client = new AcpClient(
    { provider: "mock", command: process.execPath, args: [permissionAgent], env: { ACP_MOCK_IGNORE_SIGTERM: "1" }, permissionPolicy: "auto_approve" },
    { maxFrameBytes: 4096, killGraceMs: 300 }
  );
  let providerPid = null;
  try {
    await client.start();
    providerPid = client.proc.pid;
    assert.equal(processGone(providerPid), false);
    // A frame from the provider larger than maxFrameBytes is a fatal read
    // overflow: it tears the client down through #fail while the provider is
    // still alive and, here, deaf to SIGTERM.
    client.proc.stdout.emit("data", Buffer.alloc(5_000, 0x78));
    await until(() => !client.alive, "the fatal transport error");
    await until(() => processGone(providerPid), "the provider to be SIGKILLed after it ignored SIGTERM");
    assert.equal(client.proc, null, "the kill handle is released only after the bounded teardown");
  } finally {
    await client.stop().catch(() => {});
    if (providerPid && !processGone(providerPid)) process.kill(providerPid, "SIGKILL");
  }
});

// ---------------------------------------------------------------- I10: provider process groups

// A provider started through a launcher, as npx starts an adapter: the launcher
// exits on SIGTERM, and the adapter it started (here with the provider's own
// stdio) ignores both the SIGTERM and its closed stdin. Only the launcher used
// to be signalled, so the adapter went on running after every teardown. The
// provider leads a process group of its own now, and the whole group is ended.
test("I10: stop() and a fatal error end the provider's whole process group, the adapter its launcher started included", { skip: process.platform === "win32" }, async () => {
  await withTemp("acp-i10-", async (directory) => {
    for (const ending of ["stop", "fatal"]) {
      const pidFile = join(directory, `${ending}.pid`);
      const launcher = [
        "const { spawn } = require('node:child_process');",
        `const adapter = spawn(process.execPath, [${JSON.stringify(permissionAgent)}], { stdio: 'inherit', env: { ...process.env, ACP_MOCK_IGNORE_SIGTERM: '1' } });`,
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(adapter.pid));`
      ].join("\n");
      const client = new AcpClient(
        { provider: "mock", command: process.execPath, args: ["-e", launcher], permissionPolicy: "auto_approve" },
        { maxFrameBytes: 4096, killGraceMs: 300 }
      );
      let adapter = null;
      try {
        await client.start();
        const leader = client.proc.pid;
        await until(async () => {
          adapter = Number(await readFile(pidFile, "utf8").catch(() => "")) || null;
          return adapter !== null;
        }, "the launcher to record its adapter's pid");
        assert.notEqual(adapter, leader, "the adapter is the launcher's child, not the process the client spawned");
        assert.deepEqual(client.spawnedPids(), [leader], "the spawned pid tracked is the group leader's");
        await client.sessionNew({ cwd: directory, permissionPolicy: "auto_approve" });
        if (ending === "stop") {
          await client.stop();
          assert.equal(processGone(adapter), true, "stop() waits until the whole group is gone");
        } else {
          client.proc.stdout.emit("data", Buffer.alloc(5_000, 0x78));
          await until(() => !client.alive, "the fatal transport error");
          await until(() => processGone(adapter), "the adapter to be SIGKILLed with its group");
        }
        assert.equal(processGone(leader), true);
      } finally {
        await client.stop().catch(() => {});
        if (adapter && !processGone(adapter)) process.kill(adapter, "SIGKILL");
      }
    }
  });
});
