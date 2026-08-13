#!/usr/bin/env node

import { availableParallelism } from "node:os";
import { spawn, spawnSync } from "node:child_process";

const rounds = Number.parseInt(process.env.ACP_GATEWAY_STRESS_ROUNDS ?? "3", 10);
const workers = Number.parseInt(
  process.env.ACP_GATEWAY_STRESS_WORKERS ?? String(Math.max(1, availableParallelism() - 1)),
  10
);
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("ACP_GATEWAY_STRESS_ROUNDS must be a positive integer");
if (!Number.isInteger(workers) || workers < 1) throw new Error("ACP_GATEWAY_STRESS_WORKERS must be a positive integer");

let stopping = false;
const burnerFailures = [];
const burners = Array.from({ length: workers }, (_, index) => {
  const burner = spawn(
    process.execPath,
    ["--eval", "for (;;) Math.sqrt(Math.random())"],
    { stdio: "ignore" }
  );
  burner.on("error", (error) => {
    if (!stopping) burnerFailures.push(`CPU burner ${index} failed to start: ${error.message}`);
  });
  burner.on("exit", (code, signal) => {
    if (!stopping) burnerFailures.push(`CPU burner ${index} exited unexpectedly (code=${code}, signal=${signal})`);
  });
  return burner;
});

function stopBurners() {
  stopping = true;
  for (const burner of burners) burner.kill("SIGTERM");
}

function assertBurnersAlive() {
  if (burnerFailures.length > 0) throw new Error(burnerFailures.join("; "));
  for (const [index, burner] of burners.entries()) {
    if (burner.exitCode != null || burner.signalCode != null) {
      throw new Error(`CPU burner ${index} exited unexpectedly (code=${burner.exitCode}, signal=${burner.signalCode})`);
    }
  }
}

process.once("SIGINT", () => {
  stopBurners();
  process.exit(130);
});
process.once("SIGTERM", () => {
  stopBurners();
  process.exit(143);
});

try {
  for (let round = 1; round <= rounds; round += 1) {
    process.stdout.write(`persistence stress round ${round}/${rounds} with ${workers} CPU workers\n`);
    const result = spawnSync(
      process.execPath,
      ["--test", "test/persistence.test.js", "test/crash-matrix.test.js"],
      {
        stdio: "inherit",
        timeout: 180_000,
        env: { ...process.env, ACP_GATEWAY_DISABLE_DYNAMIC_PROVIDERS: "1" }
      }
    );
    if (result.error) throw result.error;
    assertBurnersAlive();
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    if (process.exitCode) break;
  }
  assertBurnersAlive();
} finally {
  stopBurners();
}

if (!process.exitCode) process.stdout.write("persistence stress passed\n");
