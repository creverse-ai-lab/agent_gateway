import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Hash the actual executable engine sources, not a caller-supplied environment
// value. The identity is cached for this process, surviving a checkout update.
const hash = createHash("sha256");
for (const name of readdirSync(join(runtimeRoot, "src")).filter(n => n.endsWith(".js")).sort()) {
  hash.update(name).update("\0").update(readFileSync(join(runtimeRoot, "src", name)));
}
let sourceCommit = null;
try { sourceCommit = JSON.parse(readFileSync(join(runtimeRoot, "runtime-manifest.json"), "utf8")).source?.commit ?? null; } catch {}
export const RUNTIME_IDENTITY = Object.freeze({ runtimeRoot, gatewayBuildId: hash.digest("hex"), sourceCommit, instanceId: randomUUID() });

export const MANAGEMENT_CAPABILITIES = Object.freeze({
  version: 1, observer: true, gatewayConfig: true, providerPolicy: true,
  retentionPreview: true, safeShutdown: true, runtimeIdentity: true,
  settingsApply: "restart", replayCompleteness: true, resultRecovery: "task_result"
});
