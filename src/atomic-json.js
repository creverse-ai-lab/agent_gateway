import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ERROR_CODES, GatewayError } from "./errors.js";

export function readJsonFile(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw new GatewayError(ERROR_CODES.CONFIG_INVALID, `Cannot read ${path}: ${error.message}`);
  }
}

// A synchronous read/modify/rename transaction. Independent daemon/installer
// processes must fail visibly on contention instead of losing another writer.
// A crash leaves a lock requiring operator inspection; never steal a live lock.
export function updateJsonFile(path, fallback, update) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.write.lock`;
  let fd;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new GatewayError(ERROR_CODES.CONFIG_BUSY, `Configuration is locked: ${lock}`);
    throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(fd, `${process.pid}\n`);
    const next = update(readJsonFile(path, fallback));
    let output;
    try {
      output = openSync(temporary, "wx", 0o600);
      writeFileSync(output, `${JSON.stringify(next, null, 2)}\n`);
      fsyncSync(output);
    } finally { if (output != null) closeSync(output); }
    renameSync(temporary, path);
    let directory;
    try { directory = openSync(dirname(path), "r"); fsyncSync(directory); }
    finally { if (directory != null) closeSync(directory); }
    return next;
  } finally {
    closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    unlinkSync(lock);
  }
}
