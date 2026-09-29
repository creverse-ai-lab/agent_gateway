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
// ACP_MOCK_PARAMS_LOG records every session/new|resume params object.
// ACP_MOCK_ENV_LOG receives the environment this worker was started with.
const rl = createInterface({ input: process.stdin });
const pending = new Map();
let nextId = 5000;
let nextSession = 1;
const paramsLog = process.env.ACP_MOCK_PARAMS_LOG || null;
if (process.env.ACP_MOCK_ENV_LOG) writeFileSync(process.env.ACP_MOCK_ENV_LOG, JSON.stringify(process.env));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
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
    if (command.permission) {
      const response = await request("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: `call-${nextId}`,
          kind: command.permission.kind,
          title: `${command.permission.kind} ${command.permission.path ?? command.permission.command}`,
          ...(command.permission.path ? { locations: [{ path: command.permission.path }] } : {}),
          ...(command.permission.command ? { rawInput: { command: command.permission.command } } : {})
        },
        options: command.permission.options ?? [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" }
        ]
      });
      const outcome = response.result?.outcome;
      stopReason = outcome?.outcome === "selected" ? outcome.optionId : "cancelled";
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
