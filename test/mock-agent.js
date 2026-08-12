import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
// Crash-matrix evidence for P4 ("a turn that was never made durable was never
// started"). Off unless a test asks for it, so no existing behaviour changes.
const promptLog = process.env.ACP_MOCK_PROMPT_LOG || null;
let nextId = 100;
const pending = new Map();
const sessionConfigs = new Map();

function configValues(sessionId) {
  if (!sessionConfigs.has(sessionId)) {
    sessionConfigs.set(sessionId, {
      model: "mock-default",
      thought_level: "medium",
      auto_compact: false
    });
  }
  return sessionConfigs.get(sessionId);
}

function configOptions(sessionId) {
  const values = configValues(sessionId);
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: values.model,
      options: [
        { value: "mock-default", name: "Mock Default" },
        { value: "mock-pro", name: "Mock Pro" }
      ]
    },
    {
      type: "select",
      id: "thought_level",
      name: "Thought level",
      category: "thought_level",
      currentValue: values.thought_level,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" }
      ]
    },
    {
      type: "boolean",
      id: "auto_compact",
      name: "Auto compact",
      category: "model_config",
      currentValue: values.auto_compact
    }
  ];
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || message.error)) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }
      }
    });
    return;
  }
  if (message.method === "session/new") {
    sessionConfigs.delete("mock-session");
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "mock-session", configOptions: configOptions("mock-session") } });
    return;
  }
  if (message.method === "session/resume") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params.sessionId, configOptions: configOptions(message.params.sessionId) } });
    return;
  }
  if (message.method === "session/set_config_option") {
    const { sessionId, configId, type, value } = message.params;
    const values = configValues(sessionId);
    const valid =
      (configId === "model" && ["mock-default", "mock-pro"].includes(value))
      || (configId === "thought_level" && ["low", "medium", "high"].includes(value))
      || (configId === "auto_compact" && type === "boolean" && typeof value === "boolean");
    if (!valid) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "invalid config option" } });
      return;
    }
    values[configId] = value;
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: configOptions(sessionId) } });
    return;
  }
  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    const prompt = message.params.prompt?.[0]?.text;
    if (promptLog) appendFileSync(promptLog, `${JSON.stringify({ prompt, at: Date.now() })}\n`);
    if (prompt === "large-result") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "가나다".repeat(32) } }
        }
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt === "tool-events") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "tool-small", title: "Read file", kind: "read" }
        }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-large",
            status: "completed",
            // 3,000 chars but 9,000 UTF-8 bytes: catches caps that measure
            // string length instead of bytes.
            rawOutput: "가".repeat(3_000)
          }
        }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "TOOLS DONE" } }
        }
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt === "narrated-result") {
      const updates = [
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it. " } },
        { sessionUpdate: "tool_call", toolCallId: "tool-a", title: "Read file", kind: "read" },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Still checking. " } },
        { sessionUpdate: "tool_call", toolCallId: "tool-b", title: "Search docs", kind: "fetch" },
        { sessionUpdate: "tool_call_update", toolCallId: "tool-b", status: "completed" },
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FINAL " } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ANSWER" } },
        { sessionUpdate: "usage_update", usage: { inputTokens: 1200, outputTokens: 340 } }
      ];
      for (const update of updates) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: message.params.sessionId, update }
        });
      }
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt === "multi-narration-tool-end") {
      const updates = [
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Part A important. " } },
        { sessionUpdate: "tool_call", toolCallId: "tool-m1", title: "Read file", kind: "read" },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Part B progress." } },
        { sessionUpdate: "tool_call", toolCallId: "tool-m2", title: "Write file", kind: "edit" }
      ];
      for (const update of updates) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: message.params.sessionId, update }
        });
      }
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (prompt === "tool-then-end") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ONLY NARRATION" } }
        }
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "tool-b", title: "Write file", kind: "edit" }
        }
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "READY " } }
      }
    });
    const permissionId = nextId++;
    pending.set(permissionId, (result) => {
      const allowed = ["allow-once", "allow-always"].includes(result?.outcome?.optionId);
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: allowed ? "DONE" : "DENIED" }
          }
        }
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    });
    send({
      jsonrpc: "2.0",
      id: permissionId,
      method: "session/request_permission",
      params: {
        sessionId: message.params.sessionId,
        toolCall: { toolCallId: "tool-1", title: "Edit file", kind: "edit" },
        options: prompt === "allow-always-only"
          ? [{ optionId: "allow-always", name: "Always allow", kind: "allow_always" }]
          : [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" }
            ]
      }
    });
  }
});
