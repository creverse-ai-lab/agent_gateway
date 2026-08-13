import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const pending = new Map();
const sessions = new Map();
let nextId = 1000;
let nextSession = 1;
let sharedTerminalId = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

// One stdout write for a whole batch, so the gateway sees the burst as a single
// chunk and the concurrency bound is measured, not the scheduler.
function requestAll(calls) {
  const promises = [];
  let frames = "";
  for (const [method, params] of calls) {
    const id = nextId++;
    frames += `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    promises.push(new Promise((resolve) => pending.set(id, resolve)));
  }
  process.stdout.write(frames);
  return Promise.all(promises);
}

rl.on("line", async (line) => {
  const message = JSON.parse(line);
  if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || message.error)) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === "session/new") {
    const sessionId = `cap-session-${nextSession++}`;
    sessions.set(sessionId, message.params.cwd);
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    const mode = message.params.prompt?.[0]?.text;
    const cwd = sessions.get(sessionId);
    if (mode === "write") {
      const response = await request("fs/write_text_file", { sessionId, path: `${cwd}/written.txt`, content: "written" });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: response.error ? "rejected" : "end_turn" } });
      return;
    }
    if (mode === "write-parent-symlink") {
      const response = await request("fs/write_text_file", {
        sessionId,
        path: `${cwd}/external-parent/new.txt`,
        content: "escaped"
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: response.error ? "rejected" : "escaped" } });
      return;
    }
    if (mode === "two-writes") {
      const [first, second] = await Promise.all([
        request("fs/write_text_file", { sessionId, path: `${cwd}/first.txt`, content: "first" }),
        request("fs/write_text_file", { sessionId, path: `${cwd}/second.txt`, content: "second" })
      ]);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: first.error || second.error ? "rejected" : "end_turn" }
      });
      return;
    }
    if (mode?.startsWith("read-storm:")) {
      const shots = Number(mode.split(":")[1]);
      const responses = await requestAll(
        Array.from({ length: shots }, () => ["fs/read_text_file", { sessionId, path: `${cwd}/storm.txt` }])
      );
      const refused = responses.filter(
        (response) => response.error?.message?.includes("concurrent client request limit")
      ).length;
      send({ jsonrpc: "2.0", id: message.id, result: {
        stopReason: `served=${responses.length - refused} refused=${refused}`
      } });
      return;
    }
    if (mode?.startsWith("read-file:")) {
      const [, name, line, limit] = mode.split(":");
      const response = await request("fs/read_text_file", {
        sessionId,
        path: `${cwd}/${name}`,
        ...(line ? { line: Number(line) } : {}),
        ...(limit ? { limit: Number(limit) } : {})
      });
      const content = response.result?.content;
      // Reports shape, never the bytes: an oversized stopReason would just be
      // capped again on its way through the event ring.
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: JSON.stringify({
        error: response.error?.message ?? null,
        bytes: content == null ? null : Buffer.byteLength(content, "utf8"),
        head: content?.slice(0, 12) ?? null,
        tail: content?.slice(-12) ?? null,
        meta: response.result?._meta ?? null,
        keys: response.result ? Object.keys(response.result).sort() : null
      }) } });
      return;
    }
    if (mode === "terminal") {
      const created = await request("terminal/create", {
        sessionId,
        command: process.execPath,
        args: ["-e", "process.stdout.write('TERMINAL_OK')"],
        cwd
      });
      if (created.error) {
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "rejected" } });
        return;
      }
      const terminalId = created.result.terminalId;
      await request("terminal/wait_for_exit", { sessionId, terminalId });
      const output = await request("terminal/output", { sessionId, terminalId });
      await request("terminal/release", { sessionId, terminalId });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: output.result.output } });
      return;
    }
    if (mode === "terminal-limit") {
      const first = await request("terminal/create", {
        sessionId,
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 60000)"],
        cwd
      });
      const second = await request("terminal/create", {
        sessionId,
        command: process.execPath,
        args: ["-e", "process.stdout.write('SHOULD_NOT_RUN')"],
        cwd
      });
      if (first.result?.terminalId) {
        await request("terminal/kill", { sessionId, terminalId: first.result.terminalId });
        await request("terminal/release", { sessionId, terminalId: first.result.terminalId });
      }
      send({ jsonrpc: "2.0", id: message.id, result: {
        stopReason: second.error?.message?.includes("terminal limit exceeded") ? "limited" : "not-limited"
      } });
      return;
    }
    if (mode === "terminal-unicode") {
      const created = await request("terminal/create", {
        sessionId,
        command: process.execPath,
        args: ["-e", "process.stdout.write('앞'.repeat(20) + 'END')"],
        cwd,
        outputByteLimit: 16
      });
      const terminalId = created.result.terminalId;
      await request("terminal/wait_for_exit", { sessionId, terminalId });
      const output = await request("terminal/output", { sessionId, terminalId });
      await request("terminal/release", { sessionId, terminalId });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: JSON.stringify(output.result) } });
      return;
    }
    if (mode === "terminal-split-unicode") {
      const created = await request("terminal/create", {
        sessionId,
        command: process.execPath,
        args: ["-e", "process.stdout.write(Buffer.from([0xF0,0x9F]));setTimeout(()=>process.stdout.write(Buffer.from([0x98,0x80])),25)"],
        cwd
      });
      const terminalId = created.result.terminalId;
      await request("terminal/wait_for_exit", { sessionId, terminalId });
      const output = await request("terminal/output", { sessionId, terminalId });
      await request("terminal/release", { sessionId, terminalId });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: output.result.output } });
      return;
    }
    if (mode === "terminal-env") {
      const created = await request("terminal/create", {
        sessionId,
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({explicit:process.env.ACP_TEST_EXPLICIT,token:process.env.ACP_GATEWAY_CONTROL_TOKEN,root:process.env.ACP_GATEWAY_ROOT_ID,socket:process.env.ACP_GATEWAY_SOCKET}))"],
        cwd,
        env: [{ name: "ACP_TEST_EXPLICIT", value: "VISIBLE" }, { name: "ACP_GATEWAY_CONTROL_TOKEN", value: "LEAK" }]
      });
      const terminalId = created.result.terminalId;
      await request("terminal/wait_for_exit", { sessionId, terminalId });
      const output = await request("terminal/output", { sessionId, terminalId });
      await request("terminal/release", { sessionId, terminalId });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: output.result.output } });
      return;
    }
    if (mode === "elicit") {
      const response = await request("elicitation/create", {
        sessionId,
        mode: "form",
        message: "Which implementation should be used?",
        requestedSchema: {
          type: "object",
          properties: { choice: { type: "string", enum: ["socket", "poll"] } },
          required: ["choice"]
        }
      });
      send({ jsonrpc: "2.0", id: message.id, result: {
        stopReason: response.result?.action === "accept" ? response.result.content.choice : response.result?.action ?? "error"
      } });
      return;
    }
    if (mode === "edit-grant-then-terminal") {
      const permission = await request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "edit-before-terminal", title: "Edit", kind: "edit" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      });
      if (permission.result?.outcome?.optionId !== "allow-once") {
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "edit-denied" } });
        return;
      }
      const terminal = await request("terminal/create", {
        sessionId,
        command: process.execPath,
        args: ["-e", "process.stdout.write('SHOULD_NOT_RUN')"],
        cwd
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: terminal.error ? "terminal-denied" : "terminal-ran" } });
      return;
    }
    if (mode === "hold-terminal") {
      const created = await request("terminal/create", {
        sessionId,
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 60000)"],
        cwd
      });
      sharedTerminalId = created.result.terminalId;
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "holding" } });
      return;
    }
    if (mode === "long-terminal") {
      const created = await request("terminal/create", {
        sessionId,
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 60000)"],
        cwd
      });
      const terminalId = created.result.terminalId;
      const exited = await request("terminal/wait_for_exit", { sessionId, terminalId });
      send({ jsonrpc: "2.0", id: message.id, result: {
        stopReason: exited.result?.signal ? "cancelled" : "unexpected_exit"
      } });
      return;
    }
    if (mode === "cross-terminal") {
      const response = await request("terminal/output", { sessionId, terminalId: sharedTerminalId });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: response.error ? "isolated" : "leaked" } });
    }
  }
  if (message.method === "session/cancel" || message.method === "session/close") {
    if (Object.hasOwn(message, "id")) send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
