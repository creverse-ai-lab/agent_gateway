import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { readNdjson } from "../src/ndjson.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { startDaemon, writeMockProviders } from "./helpers/daemon-harness.js";

const capabilityAgent = fileURLToPath(new URL("./mock-capability-agent.js", import.meta.url));

// Answers the handshake and then never answers a prompt: the only way to observe
// what stop() does with requests that are still outstanding.
const HANGING_AGENT = `
const { createInterface } = require("node:readline");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: 1, agentCapabilities: {} });
  else if (message.method === "session/new") reply(message.id, { sessionId: "hang-1" });
});
process.on("SIGTERM", () => {});
`;

const capabilityClient = (directory, options = {}) => new AcpClient(
  { provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "auto_approve" },
  { permissionPolicy: "auto_approve", ...options }
);

async function waitFor(condition, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// The bound the checklist missed: fs/read_text_file has no permission gate, and
// #onLine dispatches every agent request fire-and-forget. 32 reads arrive in one
// stdout chunk, so exactly 16 may be in flight and the rest are refused.
test("a worker cannot hold more than 16 concurrent client requests per session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-inflight-"));
  await writeFile(join(directory, "storm.txt"), "x".repeat(100_000), "utf8");
  const client = capabilityClient(directory);
  try {
    await client.start();
    const session = await client.sessionNew({ cwd: directory, permissionPolicy: "auto_approve" });
    const outcome = await client.sessionPrompt({ sessionId: session.sessionId, prompt: "read-storm:32" });
    assert.equal(outcome.stopReason, "served=16 refused=16");
    // The counter is released, so the next turn gets the full allowance again.
    const again = await client.sessionPrompt({ sessionId: session.sessionId, prompt: "read-storm:8" });
    assert.equal(again.stopReason, "served=8 refused=0");
  } finally {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the concurrency counter is per session, not per client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-inflight-sessions-"));
  await writeFile(join(directory, "storm.txt"), "x".repeat(100_000), "utf8");
  const client = capabilityClient(directory);
  try {
    await client.start();
    const first = await client.sessionNew({ cwd: directory, permissionPolicy: "auto_approve" });
    const second = await client.sessionNew({ cwd: directory, permissionPolicy: "auto_approve" });
    const [left, right] = await Promise.all([
      client.sessionPrompt({ sessionId: first.sessionId, prompt: "read-storm:12" }),
      client.sessionPrompt({ sessionId: second.sessionId, prompt: "read-storm:12" })
    ]);
    assert.equal(left.stopReason, "served=12 refused=0");
    assert.equal(right.stopReason, "served=12 refused=0");
  } finally {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

// G6 / PR2 M7. stop() clears `alive`, so the child's exit will not run #fail; a
// provider that ignores SIGTERM used to leave the prompt promise pending forever.
test("stop rejects outstanding requests synchronously instead of wedging the turn", async () => {
  const client = new AcpClient(
    { provider: "mock", command: process.execPath, args: ["-e", HANGING_AGENT], permissionPolicy: "read_only" },
    { permissionPolicy: "read_only" }
  );
  await client.start();
  const session = await client.sessionNew({ cwd: process.cwd(), permissionPolicy: "read_only" });
  const turn = client.sessionPrompt({ sessionId: session.sessionId, prompt: "never answered" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.pending.size, 1);
  const stopping = client.stop();
  assert.equal(client.pending.size, 0, "the rejection happens before stop() awaits anything");
  await assert.rejects(turn, /ACP client stopped/);
  await stopping;
  client.proc?.kill("SIGKILL");
});

// A reply the agent is blocking on must never be silently dropped: an unsendable
// frame becomes a visible JSON-RPC error instead.
test("a response frame over the cap surfaces to the worker as an error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-frame-cap-"));
  await writeFile(join(directory, "big.txt"), "y".repeat(8_000), "utf8");
  await writeFile(join(directory, "small.txt"), "ok", "utf8");
  const client = capabilityClient(directory, { maxFrameBytes: 2_048 });
  try {
    await client.start();
    const session = await client.sessionNew({ cwd: directory, permissionPolicy: "auto_approve" });
    const refused = JSON.parse(
      (await client.sessionPrompt({ sessionId: session.sessionId, prompt: "read-file:big.txt" })).stopReason
    );
    assert.match(refused.error, /NDJSON frame exceeds 2048 bytes/);
    assert.equal(refused.bytes, null);
    // The connection survives it: the next request is answered normally.
    const served = JSON.parse(
      (await client.sessionPrompt({ sessionId: session.sessionId, prompt: "read-file:small.txt" })).stopReason
    );
    assert.equal(served.error, null);
    assert.equal(served.bytes, 2);
  } finally {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

// End to end over a real daemon socket: every existing subscription test drives a
// stand-in server, so without this the rewritten sender's ordinary delivery path
// would have no coverage at all.
test("a real daemon delivers a live turn's events through the lane channel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-daemon-events-"));
  const providers = await writeMockProviders(directory, { permissionPolicy: "read_only" });
  const daemon = await startDaemon({ directory, env: providers });
  const client = new GatewayRpcClient({
    socketPath: daemon.socketPath,
    token: daemon.token,
    rootId: daemon.rootId,
    statePath: daemon.statePath,
    autoStart: false
  });
  const received = [];
  try {
    const subscription = await client.subscribe({}, (event) => received.push(event));
    assert.equal(typeof subscription.subscriptionId, "string");
    const opened = await client.call("session_open", {
      provider: "mock", cwd: tmpdir(), permissionPolicy: "read_only"
    });
    await client.call("prompt", { sessionId: opened.sessionId, prompt: "hello" });
    await waitFor(() => received.some((event) => event.type === "turn_end"));
    const types = received.map((event) => event.type);
    // Reserved and droppable traffic both arrive, in order, on an uncongested
    // connection: lanes are invisible until there is backpressure.
    assert.ok(types.includes("session_created"));
    assert.ok(types.indexOf("turn_start") < types.indexOf("turn_end"));
    assert.equal(types.includes("subscription_error"), false, "a healthy subscriber is never shed");
    assert.equal(types.includes("subscription_gap"), false, "and nothing is dropped when nothing is queued");
    const sequences = received.filter((event) => Number.isFinite(event.sequence)).map((event) => event.sequence);
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right), "sequences stay monotonic");
  } finally {
    client.close();
    await daemon.stop({ signal: "SIGKILL" });
    await rm(directory, { recursive: true, force: true });
  }
});

// One raw write of every frame, so the daemon reads the burst as a single chunk
// and the admission counter is what decides the outcome.
test("a control connection refuses requests past its in-flight bound without dispatching them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-daemon-inflight-"));
  const daemon = await startDaemon({ directory });
  const socket = createConnection(daemon.socketPath);
  await once(socket, "connect");
  const replies = new Map();
  readNdjson(socket, { onLine: (line) => {
    const message = JSON.parse(line);
    replies.set(message.id, message);
  } });
  try {
    const shots = 300;
    let frames = "";
    for (let index = 0; index < shots; index += 1) {
      frames += `${JSON.stringify({ id: `guide-${index}`, method: "guide" })}\n`;
    }
    socket.write(frames);
    await waitFor(() => replies.size === shots);
    const answered = [...replies.values()].filter((message) => message.ok === true);
    const refused = [...replies.values()].filter(
      (message) => message.errorCode === "TOO_MANY_INFLIGHT_REQUESTS"
    );
    assert.equal(answered.length, 256);
    assert.equal(refused.length, shots - 256);
    assert.match(refused[0].error, /Too many in-flight Gateway requests/);
    // The connection is still usable once the burst clears.
    replies.clear();
    socket.write(`${JSON.stringify({ id: "after", method: "guide" })}\n`);
    await waitFor(() => replies.has("after"));
    assert.equal(replies.get("after").ok, true);
  } finally {
    socket.destroy();
    await daemon.stop({ signal: "SIGKILL" });
    await rm(directory, { recursive: true, force: true });
  }
});
