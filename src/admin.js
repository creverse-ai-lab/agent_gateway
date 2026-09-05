#!/usr/bin/env node
// CLI and GUI use the same public management RPC. No independent policy here.
import { readFileSync } from "node:fs";
import { GatewayRpcClient } from "../gateway-client/index.js";
import { settingsPaths } from "./settings.js";

const allowed = new Set(["setup", "gateway_config", "provider", "retention_preview", "shutdown_if_idle"]);
const [method = "setup", argument = "{}"] = process.argv.slice(2);
let rpc;
try {
  if (!allowed.has(method)) throw new Error(`Usage: acp-gateway-admin <${[...allowed].join("|")}> '<JSON arguments>'`);
  const args = JSON.parse(argument);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be a JSON object");
  let identity = {};
  try { identity = JSON.parse(readFileSync(settingsPaths().legacy, "utf8")).identity ?? {}; }
  catch (error) { if (!process.env.ACP_GATEWAY_CONTROL_TOKEN || !process.env.ACP_GATEWAY_ROOT_ID) throw error; }
  rpc = new GatewayRpcClient({ token: process.env.ACP_GATEWAY_CONTROL_TOKEN ?? identity.token,
    rootId: process.env.ACP_GATEWAY_ROOT_ID ?? identity.rootId, autoStart: false });
  const result = await rpc.call(method, args, method === "provider" && args.action === "install" ? 600_000 : 30_000);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error.code ?? "GATEWAY_ERROR", message: error.message, details: error.details } })}\n`);
  process.exitCode = 1;
} finally { rpc?.close(); }
