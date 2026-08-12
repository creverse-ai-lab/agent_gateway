// A mock ACP agent that can be frozen in the middle of a method, so a gateway
// race is reproducible without timing assumptions. Holds are opt-in per method
// (ACP_MOCK_HOLD=prompt,resume,close,config, or the test/hold request) and are
// released explicitly through the child's stdin, which the gateway only ever
// writes to — the production read path (stdout) needs no test hook.
import { createInterface } from "node:readline";

const holds = new Set((process.env.ACP_MOCK_HOLD ?? "").split(",").map((item) => item.trim()).filter(Boolean));
const held = new Map();
const counters = {};
const order = [];
const outgoing = new Map();
const configValues = new Map();
let nextId = 500;
let sessionCounter = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function emit(sessionId, update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function count(name) {
  counters[name] = (counters[name] ?? 0) + 1;
  order.push(name);
}

// Announces that a hold was reached. The type is outside the default poll
// filter and outside DURABLE_EVENT_TYPES, so waiting on it changes neither
// what Main receives nor what the gateway persists.
function marker(sessionId, name) {
  if (sessionId) emit(sessionId, { sessionUpdate: "test_marker", marker: name });
}

function holdOrRun(name, sessionId, run) {
  if (!holds.has(name)) {
    run();
    return;
  }
  const queue = held.get(name) ?? [];
  queue.push(run);
  held.set(name, queue);
  marker(sessionId, `hold:${name}`);
}

function configOptions(sessionId) {
  return [{
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: configValues.get(sessionId) ?? "race-default",
    options: [{ value: "race-default", name: "Default" }, { value: "race-pro", name: "Pro" }]
  }];
}

function runPrompt(message) {
  const { sessionId } = message.params;
  const text = message.params.prompt?.[0]?.text ?? "";
  const finish = () => holdOrRun("prompt", sessionId, () => reply(message.id, { stopReason: "end_turn" }));
  emit(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: text.startsWith("chunk:") ? text.slice(6) : "RACE " }
  });
  if (text.startsWith("permission")) {
    const requestId = nextId++;
    outgoing.set(requestId, finish);
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "race-tool", title: "Edit file", kind: "edit" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      }
    });
    return;
  }
  if (text.startsWith("write:")) {
    const requestId = nextId++;
    outgoing.set(requestId, finish);
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "fs/write_text_file",
      params: { sessionId, path: text.slice(6), content: "race" }
    });
    return;
  }
  finish();
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || message.error)) {
    const resolve = outgoing.get(message.id);
    outgoing.delete(message.id);
    resolve?.(message.result);
    return;
  }
  const { method, params = {} } = message;

  if (method === "test/hold") {
    if (params.on === false) holds.delete(params.hold);
    else holds.add(params.hold);
    reply(message.id, { holds: [...holds] });
    return;
  }
  if (method === "test/release") {
    const queue = held.get(params.hold) ?? [];
    held.set(params.hold, []);
    for (const run of queue) run();
    reply(message.id, { released: queue.length });
    return;
  }
  if (method === "test/counters") {
    reply(message.id, {
      counters: { ...counters },
      order: [...order],
      holding: Object.fromEntries([...held].map(([name, queue]) => [name, queue.length]))
    });
    return;
  }
  if (method === "test/emit") {
    emit(params.sessionId, params.update);
    reply(message.id, { ok: true });
    return;
  }
  // An explicit ordering fence: the reply proves every earlier stdout line has
  // already been written, so a test can wait for "the agent has seen this"
  // without waiting on a clock.
  if (method === "test/marker") {
    marker(params.sessionId, params.marker ?? "fence");
    reply(message.id, { ok: true });
    return;
  }

  if (method === "initialize") {
    count("initialize");
    reply(message.id, {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }
    });
    return;
  }
  if (method === "session/new") {
    count("new");
    const sessionId = `race-session-${++sessionCounter}`;
    reply(message.id, { sessionId, configOptions: configOptions(sessionId) });
    return;
  }
  if (method === "session/resume" || method === "session/load") {
    count("resume");
    holdOrRun("resume", params.sessionId, () =>
      reply(message.id, { sessionId: params.sessionId, configOptions: configOptions(params.sessionId) }));
    return;
  }
  if (method === "session/set_config_option") {
    count("config");
    holdOrRun("config", params.sessionId, () => {
      if (params.configId !== "model" || !["race-default", "race-pro"].includes(params.value)) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "invalid config option" } });
        return;
      }
      configValues.set(params.sessionId, params.value);
      reply(message.id, { configOptions: configOptions(params.sessionId) });
    });
    return;
  }
  if (method === "session/prompt") {
    count("prompt");
    runPrompt(message);
    return;
  }
  if (method === "session/cancel") {
    // Arrival order matters (a cancel must not overtake its own prompt), but a
    // held turn stays held: the gateway must survive the late completion.
    count("cancel");
    return;
  }
  if (method === "session/close") {
    count("close");
    holdOrRun("close", params.sessionId, () => reply(message.id, {}));
    return;
  }
  if (Object.hasOwn(message, "id")) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unsupported: ${method}` } });
  }
});
