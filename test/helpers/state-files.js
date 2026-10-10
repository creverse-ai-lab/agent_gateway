import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { decodeRecord, statePaths, WAL_TYPES } from "../../src/state-store.js";
import { STATE_SCHEMA_VERSION } from "../../src/version.js";

// The persisted state a restart reads first: the body of the v5 snapshot next
// to statePath. Since 1.8.0 nothing writes the v4 state.json any more, so tests
// that check what reached disk read this instead.
export async function readSnapshotBody(statePath) {
  const raw = await readFile(statePaths(statePath).snapshot, "utf8");
  return JSON.parse(raw.slice(raw.indexOf("\n") + 1));
}

// What a daemon killed before its next snapshot leaves of a fresh state
// directory, for a test that kept the log (wal, its bytes) across a clean
// shutdown: the snapshot of the directory's first rotation, which holds
// nothing, under the log that rotation started. That snapshot is the base the
// log goes on from, at the seq of its opening record, and since 1.8.0 a log is
// not replayed without its base.
export async function writeFreshBase(statePath, wal) {
  const bytes = Buffer.isBuffer(wal) ? wal : Buffer.from(wal, "utf8");
  const first = decodeRecord(bytes.subarray(0, bytes.indexOf(0x0a)));
  if (first?.type !== WAL_TYPES.WAL_OPENED) throw new Error("the log does not start where a rotation started it");
  const body = JSON.stringify({ sessions: [], tasks: [], inbox: [] });
  const header = {
    version: STATE_SCHEMA_VERSION,
    epoch: 1,
    walSeq: first.seq,
    bodyBytes: Buffer.byteLength(body),
    bodySha256: createHash("sha256").update(body).digest("hex")
  };
  await writeFile(statePaths(statePath).snapshot, `${JSON.stringify(header)}\n${body}\n`, { mode: 0o600 });
}
