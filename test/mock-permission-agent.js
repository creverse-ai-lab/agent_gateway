import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Drives the Gateway's permission path directly. A prompt is a JSON line:
//   {"permission": {"kind": "read", "path": "/abs/or/relative"}}  -> session/request_permission
//   {"permission": {"kind": "execute", "command": "cat ~/x"}}      -> request with rawInput.command
//   {"read": "/path"}                                              -> fs/read_text_file
//   {"terminal": {"command": "/bin/cat", "args": ["/path"]}}      -> terminal/create
//     (an optional "env": [{name, value}] rides along as the worker's own request)
// The turn's stopReason reports what the Gateway decided (the selected optionId,
// "cancelled", "read-ok" or "read-error"), so a test asserts on the outcome.
//   {"steps": [step, ...]} runs each step in turn and reports every outcome as
//   a JSON array in stopReason. A step is one of:
//     {"permission": {...}}  as above (a "command" may also be an array)
//     {"terminal": {..., "cwd"?, "hold"?, "release"?, "kill"?}}
//                                        -> {output, exitStatus}, or
//                                           "terminal-error: <message>";
//                                           hold: "terminal-held" without waiting;
//                                           release: terminal/release without
//                                           waiting, "terminal-released";
//                                           kill: terminal/kill before the wait
//     {"write": {"path", "content" | "bytes"}} -> "write-ok" | "write-error: <message>"
//     {"parallel": [step, ...]}             -> the steps at once, their outcomes
// ACP_MOCK_PARAMS_LOG records every session/new|resume params object.
// ACP_MOCK_ENV_LOG receives the environment this worker was started with.
// ACP_MOCK_IGNORE_SIGTERM=1 makes this worker ignore SIGTERM and stay up after
// its stdin closes, as a stuck adapter would.
const rl = createInterface({ input: process.stdin });
const pending = new Map();
let nextId = 5000;
let nextSession = 1;
const paramsLog = process.env.ACP_MOCK_PARAMS_LOG || null;
if (process.env.ACP_MOCK_ENV_LOG) writeFileSync(process.env.ACP_MOCK_ENV_LOG, JSON.stringify(process.env));
if (process.env.ACP_MOCK_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

async function askPermission(sessionId, permission) {
  const response = await request("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: `call-${nextId}`,
      kind: permission.kind,
      title: `${permission.kind} ${permission.path ?? permission.command}`,
      ...(permission.path ? { locations: [{ path: permission.path }] } : {}),
      ...(permission.command ? { rawInput: { command: permission.command } } : {})
    },
    options: permission.options ?? [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" }
    ]
  });
  const outcome = response.result?.outcome;
  return outcome?.outcome === "selected" ? outcome.optionId : "cancelled";
}

async function runStep(sessionId, step) {
  if (step.permission) return askPermission(sessionId, step.permission);
  if (step.parallel) return Promise.all(step.parallel.map((inner) => runStep(sessionId, inner)));
  if (step.write) {
    const content = step.write.content ?? "x".repeat(step.write.bytes ?? 0);
    const response = await request("fs/write_text_file", { sessionId, path: step.write.path, content });
    return response.error ? `write-error: ${response.error.message}` : "write-ok";
  }
  if (step.terminal) {
    const created = await request("terminal/create", {
      sessionId,
      command: step.terminal.command,
      args: step.terminal.args ?? [],
      ...(step.terminal.cwd ? { cwd: step.terminal.cwd } : {}),
      ...(step.terminal.env ? { env: step.terminal.env } : {})
    });
    if (created.error) return `terminal-error: ${created.error.message}`;
    const { terminalId } = created.result;
    if (step.terminal.hold) return "terminal-held";
    if (step.terminal.release) {
      const released = await request("terminal/release", { sessionId, terminalId });
      return released.error ? `terminal-error: ${released.error.message}` : "terminal-released";
    }
    if (step.terminal.kill) await request("terminal/kill", { sessionId, terminalId });
    const exited = await request("terminal/wait_for_exit", { sessionId, terminalId });
    const output = await request("terminal/output", { sessionId, terminalId });
    await request("terminal/release", { sessionId, terminalId });
    return { output: output.result?.output ?? null, exitStatus: exited.result ?? null };
  }
  return "unknown-step";
}

rl.on("line", async (line) => {
  const message = JSON.parse(line);
  if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || message.error)) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } } });
    return;
  }
  if (message.method === "session/new" || message.method === "session/resume") {
    if (paramsLog) appendFileSync(paramsLog, `${JSON.stringify({ method: message.method, params: message.params })}\n`);
    const sessionId = message.method === "session/new" ? `perm-${process.pid}-${nextSession++}` : message.params.sessionId;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    const { sessionId } = message.params;
    let command = {};
    try {
      command = JSON.parse(message.params.prompt?.[0]?.text ?? "{}");
    } catch {}
    let stopReason = "end_turn";
    if (command.steps) {
      const outcomes = [];
      for (const step of command.steps) outcomes.push(await runStep(sessionId, step));
      stopReason = JSON.stringify(outcomes);
    } else if (command.permission) {
      stopReason = await askPermission(sessionId, command.permission);
    } else if (command.terminal) {
      const created = await request("terminal/create", {
        sessionId,
        command: command.terminal.command,
        args: command.terminal.args ?? [],
        ...(command.terminal.env ? { env: command.terminal.env } : {})
      });
      if (created.error) stopReason = "terminal-error";
      else {
        await request("terminal/wait_for_exit", { sessionId, terminalId: created.result.terminalId });
        await request("terminal/release", { sessionId, terminalId: created.result.terminalId });
        stopReason = "terminal-ok";
      }
    } else if (command.read) {
      const response = await request("fs/read_text_file", { sessionId, path: command.read });
      stopReason = response.error ? "read-error" : "read-ok";
    }
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason } });
  }
});
