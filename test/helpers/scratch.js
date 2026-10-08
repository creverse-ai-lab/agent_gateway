import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What a test holds for the length of one body and puts back after, and how it
// tells that a process it started is gone.

/**
 * body(directory) in a fresh temp directory, removed after. Canonical, since
 * the Gateway compares real paths (on macOS the temp directory is under a
 * symlink, /var into /private/var).
 */
export async function withTemp(prefix, body) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** body() with process.env set from values (null unsets), then restored. */
export async function withEnv(values, body) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}
