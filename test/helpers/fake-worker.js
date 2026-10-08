import assert from "node:assert/strict";
import { GatewayService } from "../../src/gateway-service.js";

// An in-process Gateway on an injected clock, with a fake worker in place of a
// provider process: what the attention, lineage and per-Main isolation suites
// drive their cases with.
export const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
export const TERMINAL = ["completed", "failed", "cancelled"];

// The smallest worker the service accepts. Turns resolve only when told to.
export class FakeWorker {
  constructor(options) {
    this.options = options;
    this.config = { modelScope: "session" };
    this.alive = false;
    this.initResult = null;
    this.stderr = "";
    this.handlers = new Map();
    this.turns = [];
  }

  async start() {
    this.alive = true;
    this.initResult = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } };
    return this.initResult;
  }

  async sessionNew() {
    FakeWorker.opened += 1;
    return { sessionId: `fake-${FakeWorker.opened}`, configOptions: [] };
  }

  async sessionRestore({ sessionId }) { return { sessionId, configOptions: [] }; }
  onSessionUpdate(sessionId, handler) { this.handlers.set(sessionId, handler); }
  clearSession(sessionId) { this.handlers.delete(sessionId); }
  emit(sessionId, update) { this.handlers.get(sessionId)?.(update); }
  sessionPrompt() { return new Promise((resolve, reject) => this.turns.push({ resolve, reject })); }
  cancelSession() {}
  pendingSessionInput() { return { permissions: 0, elicitations: 0 }; }
  async respondPermission() {}
  respondElicitation() {}
  async setSessionConfigOption() { return { configOptions: [] }; }
  async request() { return {}; }
  async stop() { this.alive = false; }
}
FakeWorker.opened = 0;

export function harness(options = {}) {
  const clock = { now: EPOCH };
  const service = new GatewayService({
    gcIntervalMs: 0,
    now: () => clock.now,
    createClient: (_provider, clientOptions) => new FakeWorker(clientOptions),
    ...options
  });
  return { service, clock };
}

export async function until(predicate, description) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

// Starts a run and returns at once (waitMs 0 is a handoff, never a delivery).
export async function start(service, session, context, extra = {}) {
  const ack = await service.call("run", { sessionId: session.id, prompt: "go", waitMs: 0, ...extra }, context);
  assert.equal(ack.status, "working");
  return ack.taskId;
}

export async function finish(service, worker, taskId) {
  worker.turns.at(-1).resolve({ stopReason: "end_turn" });
  await until(() => TERMINAL.includes(service.taskStore.find(taskId)?.status), `task ${taskId} terminal`);
}

export function permission(worker, session, requestId) {
  worker.emit(session.acpSessionId, {
    sessionUpdate: "permission_request", requestId,
    toolCall: { toolCallId: `t${requestId}`, title: "Edit", kind: "edit" },
    options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }]
  });
}
