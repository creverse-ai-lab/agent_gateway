import { readFile } from "node:fs/promises";
import { statePaths } from "../../src/state-store.js";

// The persisted state a restart reads first: the body of the v5 snapshot next
// to statePath. Since 1.8.0 nothing writes the v4 state.json any more, so tests
// that check what reached disk read this instead.
export async function readSnapshotBody(statePath) {
  const raw = await readFile(statePaths(statePath).snapshot, "utf8");
  return JSON.parse(raw.slice(raw.indexOf("\n") + 1));
}
