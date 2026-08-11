#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CancelTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListTasksRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { controlToken, rootId } from "./config.js";
import { GatewayRpcClient } from "./socket-rpc.js";
import { PERMISSION_POLICIES } from "./acp-client.js";
import { GATEWAY_VERSION } from "./version.js";

const rpc = new GatewayRpcClient({ token: controlToken(), rootId: rootId() });
const tools = controlTools();
const server = new Server(
  { name: "acp-gateway-control", version: GATEWAY_VERSION },
  {
    capabilities: {
      tools: {},
      // Tasks are opt-in: legacy MCP clients keep using prompt + poll.
      tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } }
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const methods = {
    agent_acp_setup: "setup",
    agent_acp_session_open: "session_open",
    agent_acp_session_restore: "session_restore",
    agent_acp_config: "config",
    agent_acp_prompt: "prompt",
    agent_acp_poll: "poll",
    agent_acp_permission: "permission",
    agent_acp_answer: "answer",
    agent_acp_cancel: "cancel",
    agent_acp_session: "session",
    agent_acp_inbox: "inbox"
  };
  try {
    const method = methods[request.params.name];
    if (!method) throw new Error(`Unknown tool: ${request.params.name}`);
    const task = taskOptions(request.params);
    if (task && request.params.name === "agent_acp_prompt") {
      return { task: await rpc.call("task_prompt", { ...(request.params.arguments ?? {}), ...task }) };
    }
    if (task) throw new Error(`Tool ${request.params.name} does not support task execution`);
    const args = request.params.arguments ?? {};
    const timeoutMs = method === "poll"
      ? Math.max(30_000, Number(args.waitMs ?? 0) + 5_000)
      : method === "setup" && args.refreshAgentUpdates === true
        ? 120_000
        : 30_000;
    return toolResult(await rpc.call(method, args, timeoutMs));
  } catch (error) {
    return toolResult({ ok: false, error: error?.message ?? String(error) }, true);
  }
});

server.setRequestHandler(GetTaskRequestSchema, async (request) => {
  return rpc.call("task_get", { taskId: request.params.taskId });
});

server.setRequestHandler(ListTasksRequestSchema, async () => {
  return rpc.call("task_list");
});

server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
  const result = await rpc.call("task_result", { taskId: request.params.taskId });
  return toolResult(result, result.ok === false);
});

server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
  return rpc.call("task_cancel", { taskId: request.params.taskId });
});

process.once("SIGTERM", () => rpc.close());
process.once("SIGINT", () => rpc.close());
await server.connect(new StdioServerTransport());

function toolResult(data, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    isError
  };
}

function taskOptions(params) {
  const task = params.task ?? params._meta?.task;
  if (!task) return null;
  if (typeof task !== "object" || Array.isArray(task)) throw new Error("task must be an object");
  return { ttl: task.ttl, pollInterval: task.pollInterval };
}

function controlTools() {
  return [
    {
      name: "agent_acp_setup",
      description: "Inspect and start a configured ACP provider through the persistent Gateway. Always surface non-empty health alerts to the user.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", minLength: 1 },
          refreshAgentUpdates: { type: "boolean", description: "Wait for a fresh ACP registry and Gateway main-version check, applying enabled automatic adapter updates." }
        }
      }
    },
    {
      name: "agent_acp_session_open",
      description: "Open a worker ACP session owned by this Main.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", minLength: 1 },
          cwd: { type: "string" },
          model: { type: "string", minLength: 1, description: "Worker model selected by Main. Uses the provider default when omitted." },
          permissionPolicy: { type: "string", enum: PERMISSION_POLICIES },
          title: { type: "string" },
          pinned: { type: "boolean" },
          additionalDirectories: { type: "array", items: { type: "string" } },
          mcpServers: { type: "array", items: { type: "object" } }
        },
        required: ["provider", "cwd"]
      }
    },
    {
      name: "agent_acp_session_restore",
      description: "Restore a worker session through ACP session/resume or session/load.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", minLength: 1 },
          acpSessionId: { type: "string" },
          cwd: { type: "string" },
          model: { type: "string", minLength: 1, description: "Worker model selected by Main. Reuses the stored model when omitted." },
          permissionPolicy: { type: "string", enum: PERMISSION_POLICIES },
          method: { type: "string", enum: ["auto", "resume", "load"] },
          title: { type: "string" },
          pinned: { type: "boolean" },
          additionalDirectories: { type: "array", items: { type: "string" } },
          mcpServers: { type: "array", items: { type: "object" } }
        },
        required: ["provider", "acpSessionId", "cwd"]
      }
    },
    {
      name: "agent_acp_config",
      description: "List or set ACP session configuration options advertised by the Worker, such as model, mode, thought level, or boolean model settings.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "set"] },
          sessionId: { type: "string" },
          configId: { type: "string", minLength: 1 },
          value: { oneOf: [{ type: "string" }, { type: "boolean" }] }
        },
        required: ["action", "sessionId"]
      }
    },
    {
      name: "agent_acp_prompt",
      description: "Start a prompt in an owned worker session. Supports MCP Task execution when the client opts in.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          model: { type: "string", minLength: 1, description: "Optional model for this and following turns. Process-scoped providers require a new session to change it." },
          prompt: { oneOf: [{ type: "string" }, { type: "array", items: { type: "object" } }] }
        },
        required: ["sessionId", "prompt"]
      },
      execution: { taskSupport: "optional" }
    },
    {
      name: "agent_acp_poll",
      description: "Poll status and final results with minimal token use; opt into progress evidence only when needed.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          cursor: { type: "integer", minimum: 0 },
          toCursor: { type: "integer", minimum: 0, description: "Exclusive upper bound for a retrospective range read. Bounded reads never wait." },
          eventTypes: { type: "array", items: { type: "string", minLength: 1 }, description: "Deliver only events whose type matches an entry exactly; a trailing * matches by prefix (e.g. tool_call*). Overrides the minimal default, which emits only permission and elicitation requests." },
          waitMs: { type: "integer", minimum: 0, maximum: 120000 },
          includeThoughts: { type: "boolean", description: "Deliver reasoning chunks. Defaults to false." },
          includeToolEvents: { type: "boolean", description: "Deliver tool_call events. Defaults to false." },
          includeResult: { type: "boolean", description: "Include the result object. Defaults to true only after the turn has finished; pass true to include it while the turn is still active. After the turn ends result.text carries only the final message segment; the full narrated transcript stays readable via agent_acp_session get." },
          includeInspection: { type: "boolean", description: "Include closed narration segments (each preview capped to 4KB of UTF-8; full text via each segment's artifact pointer; inspectionDropped counts evicted segments) inside the result object. Defaults to false." },
          maxEvents: { type: "integer", minimum: 1, maximum: 1000 }
        },
        required: ["sessionId"]
      }
    },
    {
      name: "agent_acp_permission",
      description: "Answer a pending permission request.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          requestId: { type: "integer" },
          optionId: { type: "string" }
        },
        required: ["sessionId", "requestId"]
      }
    },
    {
      name: "agent_acp_answer",
      description: "Answer, decline, or cancel a pending structured worker question.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          requestId: { type: "integer" },
          action: { type: "string", enum: ["accept", "decline", "cancel"] },
          content: { type: "object" }
        },
        required: ["sessionId", "requestId"]
      }
    },
    {
      name: "agent_acp_cancel",
      description: "Request cancellation of the active prompt turn.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"]
      }
    },
    {
      name: "agent_acp_session",
      description: "List, inspect, close, or clean sessions owned by this Main.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "close", "clean", "pin", "unpin"] },
          sessionId: { type: "string" },
          includeEvents: { type: "boolean" },
          includeTranscript: { type: "boolean", description: "Include the narrated transcript (resultText) on get. Defaults to false; transcriptBytes always reports its size. The in-memory copy is bounded (maxTextBytes) - when it overflowed, resultArtifact points at the complete spill." }
        },
        required: ["action"]
      }
    },
    {
      name: "agent_acp_inbox",
      description: "List or inspect durable worker permission requests and questions owned by this Main.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get"] },
          inboxId: { type: "string" },
          status: { type: "string", enum: ["pending", "answered", "interrupted"] }
        },
        required: ["action"]
      }
    }
  ];
}
