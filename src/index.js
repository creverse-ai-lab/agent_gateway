#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CancelTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListTasksRequestSchema,
  ListToolsRequestSchema,
  RELATED_TASK_META_KEY
} from "@modelcontextprotocol/sdk/types.js";
import { controlToken, rootId } from "./config.js";
import { errorEnvelope } from "./errors.js";
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
      // No current tool has task semantics yet: agent_acp_prompt returns a start
      // acknowledgement, so advertising it as a Task would change its result.
      tasks: { list: {}, cancel: {} }
    }
  }
);

// The daemon's version, learned from whatever setup or session response ran
// last. The tool array is frozen at module load and this process cannot
// relist it, so a version skew means the schema in the host's cache may
// describe a gateway that is no longer running.
let daemonVersion = null;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const methods = {
    agent_acp_setup: "setup",
    agent_acp_session_open: "session_open",
    agent_acp_session_restore: "session_restore",
    agent_acp_config: "config",
    agent_acp_prompt: "prompt",
    agent_acp_run: "run",
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
    if (task && method === "run") {
      const created = await rpc.call(
        "task_run",
        { ...(request.params.arguments ?? {}), ...task }
      );
      return { task: created, ...relatedTask(created.taskId) };
    }
    if (task) throw new Error(`Tool ${request.params.name} does not support task execution`);
    const args = request.params.arguments ?? {};
    if (method === "run") return await runTool(args, extra);
    const timeoutMs = method === "poll"
      ? Math.max(30_000, Number(args.waitMs ?? 0) + 5_000)
      : method === "setup" && args.refreshAgentUpdates === true
        ? 120_000
        : 30_000;
    return toolResult(withFrontDoorNotice(method, await rpc.call(method, args, timeoutMs)));
  } catch (error) {
    return toolResult({
      ok: false,
      ...errorEnvelope(error)
    }, true);
  }
});

server.setRequestHandler(GetTaskRequestSchema, async (request) => {
  const record = await rpc.call("task_get", { taskId: request.params.taskId });
  return record;
});

server.setRequestHandler(ListTasksRequestSchema, async (request) => {
  // tasks/list carries only a cursor (no page size), so the front door picks the
  // page size itself: without a limit the gateway answers unpaged, which is the
  // contract the direct socket callers depend on but an unbounded reply here.
  // 200 is the store's maximum page, so a host with fewer handles sees exactly
  // what it saw before.
  const cursor = request.params?.cursor;
  const listed = await rpc.call("task_list", { limit: 200, ...(cursor == null ? {} : { cursor }) });
  // ListTasksResultSchema types nextCursor as an optional string, so the last
  // page omits the key rather than sending the gateway's null.
  return {
    tasks: listed.tasks,
    ...(typeof listed.nextCursor === "string" ? { nextCursor: listed.nextCursor } : {})
  };
});

server.setRequestHandler(GetTaskPayloadRequestSchema, async (request, extra) => {
  const result = await rpc.call(
    "task_result",
    { taskId: request.params.taskId, waitMs: 120_000 },
    125_000,
    { signal: extra.signal }
  );
  return toolResult(result, result.ok === false, relatedTask(request.params.taskId));
});

server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
  const record = await rpc.call("task_cancel", { taskId: request.params.taskId });
  return record;
});

process.once("SIGTERM", () => rpc.close());
process.once("SIGINT", () => rpc.close());
await server.connect(new StdioServerTransport());

// agent_acp_run, in two rpc calls on purpose. The first one only admits the work
// and returns the handle; the second one waits. Nothing else can report a taskId
// before a timeout can happen, and a timeout on a single fused call would leave
// the caller holding no handle for work that is definitely running.
const RUN_DEFAULT_WAIT_MS = 55_000;
const RUN_MAX_WAIT_MS = 600_000;

async function runTool(args, extra) {
  const requested = Number(args.waitMs ?? RUN_DEFAULT_WAIT_MS);
  const waitMs = Math.min(RUN_MAX_WAIT_MS, Number.isFinite(requested) ? Math.max(0, requested) : RUN_DEFAULT_WAIT_MS);
  let taskId = typeof args.taskId === "string" ? args.taskId : null;
  if (!taskId) {
    const admitted = await rpc.call("run", { ...args, waitMs: 0 }, 30_000);
    taskId = typeof admitted.taskId === "string" ? admitted.taskId : null;
    await announceTask(extra, taskId);
    if (!taskId || waitMs === 0) return toolResult(admitted, admitted.ok === false, relatedTask(taskId));
  }
  // The rpc budget follows the poll precedent: the caller's wait plus the slack
  // the gateway needs to answer it.
  const waitController = new AbortController();
  const envelope = await raceAbort(
    rpc.call(
      "run",
      { taskId, waitMs },
      Math.max(30_000, waitMs + 5_000),
      { signal: waitController.signal }
    ),
    extra?.signal,
    taskId,
    () => waitController.abort()
  );
  return toolResult(envelope, envelope.ok === false, relatedTask(taskId));
}

// An abort abandons the WAIT, never the turn. The worker keeps working and the
// handle stays collectable, because "I stopped waiting" and "stop the work" are
// different instructions and only agent_acp_cancel means the second one.
function raceAbort(pending, signal, taskId, abandonWait = () => {}) {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abandon);
      callback(value);
    };
    const abandon = () => {
      finish(resolve, {
        ok: true,
        status: "working",
        incomplete: "wait_abandoned",
        taskId,
        next: { attach: { tool: "agent_acp_run", arguments: { taskId } } }
      });
      // Resolve the user-facing handoff first, then cancel only the outstanding
      // wait RPC. The task and worker turn are untouched.
      queueMicrotask(abandonWait);
    };
    pending.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
    if (signal.aborted) abandon();
    else signal.addEventListener("abort", abandon, { once: true });
  });
}

// The handle, delivered before the wait can fail. A host whose transport times
// out mid-run still has the id it needs to attach again — the only mitigation
// available for a timeout we do not own.
async function announceTask(extra, taskId) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken == null || !taskId || typeof extra?.sendNotification !== "function") return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: 0, message: `agent_acp_run accepted; taskId=${taskId}` }
    });
  } catch {
    // Progress is best effort by definition; the wait is what matters.
  }
}

// Version skew is invisible from inside a session: a daemon restart swaps only
// the socket (the rpc client reconnects transparently), the tool array here was
// frozen at module load, and the host caches it. This notice is the one channel
// that reaches the model when its cached schema no longer matches the gateway.
function withFrontDoorNotice(method, result) {
  if (method !== "setup" && method !== "session_open" && method !== "session_restore") return result;
  if (typeof result?.gatewayVersion === "string") daemonVersion = result.gatewayVersion;
  if (!daemonVersion || daemonVersion === GATEWAY_VERSION || !result || typeof result !== "object") return result;
  return {
    ...result,
    staleFrontDoor: {
      frontDoorVersion: GATEWAY_VERSION,
      gatewayVersion: daemonVersion,
      action: "reconnect the agent-acp MCP server"
    }
  };
}

// One place builds a tool envelope. `extra` carries result-level additions such
// as _meta, so the task and non-task paths cannot drift apart.
function toolResult(data, isError = false, extra = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    isError,
    ...extra
  };
}

// The task association a client uses to tie a response back to a handle. Shape
// and key come from the SDK: RELATED_TASK_META_KEY
// ("io.modelcontextprotocol/related-task") carrying RelatedTaskMetadataSchema
// ({taskId}) inside _meta.
function relatedTask(taskId) {
  return typeof taskId === "string" && taskId ? { _meta: { [RELATED_TASK_META_KEY]: { taskId } } } : {};
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
          refreshAgentUpdates: { type: "boolean", description: "Wait for a fresh ACP registry and Gateway main-version check, applying enabled automatic adapter updates." },
          mode: { type: "string", enum: ["full", "summary"], description: "summary returns versions, response profiles, persistence health, alerts, providers and liveSessions only - roughly a fifth of full. Use full when choosing or installing a provider; the limits a session needs are already on the session_open response." }
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
          mcpServers: { type: "array", items: { type: "object" } },
          thoughtCapture: { type: "string", enum: ["none", "tail", "full"], description: "How much worker reasoning this session retains: none keeps nothing, tail keeps the last 8KB (default), full keeps up to maxTextBytes. Live delivery of thought chunks is unaffected in every mode." }
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
          mcpServers: { type: "array", items: { type: "object" } },
          thoughtCapture: { type: "string", enum: ["none", "tail", "full"], description: "How much worker reasoning this session retains: none keeps nothing, tail keeps the last 8KB (default), full keeps up to maxTextBytes. Keeps the stored setting when omitted." }
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
      description: "Start a prompt in an owned worker session and immediately return its session/turn acknowledgement.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          model: { type: "string", minLength: 1, description: "Optional model for this and following turns. Process-scoped providers require a new session to change it." },
          prompt: { oneOf: [{ type: "string" }, { type: "array", items: { type: "object" } }] }
        },
        required: ["sessionId", "prompt"]
      }
    },
    {
      name: "agent_acp_run",
      description: "Run a prompt in an owned worker session and wait for its outcome, or attach to an already running one with taskId. Always creates a durable Task handle, so the direct return and the MCP Task result are the same object. A wait that runs out is not an error: it returns status working with the taskId to attach to. Never resend the prompt after a failure that is not a validation error - always retry with {taskId}.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Start mode. Mutually exclusive with taskId." },
          prompt: { oneOf: [{ type: "string" }, { type: "array", items: { type: "object" } }], description: "Start mode. Mutually exclusive with taskId." },
          taskId: { type: "string", description: "Attach mode: keep waiting on a run that has already started. Carries no prompt, so a retry cannot start the work twice." },
          model: { type: "string", minLength: 1, description: "Optional model for this and following turns. Process-scoped providers require a new session to change it." },
          waitMs: { type: "integer", minimum: 0, maximum: 600000, description: "How long to wait for a terminal outcome. Defaults to 55000, below the usual 60s host tool timeout. On the first run of a session prefer 25000, then raise it once a turn has completed normally." },
          resultBudgetBytes: { type: "integer", minimum: 0, maximum: 65536, description: "Cap the delivered result.text. Over the cap the result carries a bounded head plus totalBytes, omittedBytes and a textArtifact pointer." },
          resultDelivery: { type: "string", enum: ["inline", "artifact"], description: "artifact delivers an empty text plus a textArtifact pointer regardless of size." },
          responseProfile: { type: "string", enum: ["current", "compact", "diagnostic"], description: "Shape of the result object inside the terminal envelope." },
          includeUsage: { type: "boolean", description: "Include result.usageSummary in the terminal envelope." },
          includeThoughts: { type: "boolean", description: "Include the bounded thought capture in the terminal result." },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 256, description: "Retry-safe start. A repeat with the same key on the same session attaches to the existing durable run instead of prompting the worker again." },
          ttl: { type: "integer", minimum: 0, description: "Milliseconds the Task handle stays collectable, measured from creation." },
          pollInterval: { type: "integer", minimum: 0, description: "Milliseconds the client should wait between status checks." }
        }
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
          includeThoughts: { type: "boolean", description: "Include the bounded captured reasoning in result. Raw reasoning chunks are live-subscription telemetry only. Defaults to false." },
          includeToolEvents: { type: "boolean", description: "Deliver tool_call events. Defaults to false." },
          includeResult: { type: "boolean", description: "Include the result object. Defaults to true only after the turn has finished; pass true to include it while the turn is still active. After the turn ends result.text carries only the final message segment; the full narrated transcript stays readable via agent_acp_session get." },
          includeInspection: { type: "boolean", description: "Include closed narration segments (each preview capped to 4KB of UTF-8; full text via each segment's artifact pointer; inspectionDropped counts evicted segments) inside the result object. Defaults to false." },
          includeUsage: { type: "boolean", description: "Include result.usageSummary: the {turn, session} token, context and cost totals the worker reported. Defaults to false; requires the result object (see includeResult)." },
          maxEvents: { type: "integer", minimum: 1, maximum: 1000 },
          responseProfile: { type: "string", enum: ["current", "compact", "diagnostic"], description: "current (default) is the frozen full response. compact drops the session envelope and every zero-valued paging field, keeping ok, sessionId, turnId, status, nextCursor, events and the terminal result. diagnostic adds queue depth, pending request counts and illegal-transition counters. Per call, never sticky; check setup or session_open responseProfiles before sending one." },
          resultBudgetBytes: { type: "integer", minimum: 0, maximum: 65536, description: "Cap the delivered result.text for this call. Over the cap the result carries a bounded head plus totalBytes, omittedBytes and a textArtifact pointer. totalBytes is the size of the answer; transcriptBytes is the size of the whole narration." },
          resultDelivery: { type: "string", enum: ["inline", "artifact"], description: "artifact delivers an empty text plus a textArtifact pointer regardless of size." }
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
          status: { type: "string", enum: ["pending", "answered", "interrupted"] },
          sessionId: { type: "string", description: "List only rows belonging to one session." },
          type: { type: "string", enum: ["permission_request", "worker_question"], description: "List only one kind of request." },
          detail: { type: "string", enum: ["full", "summary"], description: "summary drops options, message and requestedSchema and reduces toolCall to its id, title and kind. Use get for the full row before answering." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size. Passing limit or cursor switches the response to paged mode, which adds nextCursor (null on the last page). Without either, the response is the unpaged 1.3.x list." },
          cursor: { type: "string", description: "Opaque keyset cursor from a previous page's nextCursor." }
        },
        required: ["action"]
      }
    }
  ];
}
