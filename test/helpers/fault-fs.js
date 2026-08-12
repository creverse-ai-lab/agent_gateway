// Test-only filesystem fault injection, loaded into a daemon with
// `--import ./test/helpers/fault-fs.js`. It exists so the crash matrix needs no
// production hooks: the gateway's state store calls plain node:fs sync
// functions, and this preload wraps them before the daemon's module graph is
// evaluated (patching the CJS fs exports first is what makes the ESM named
// imports in src/ resolve to these wrappers).
//
// Rules come from ACP_GATEWAY_FAULT_FS as a JSON array:
//   { call, path?, contains?, nth?, action, code? }
//   call     - "writeSync" | "fsyncSync" | "ftruncateSync" | "renameSync"
//              | "unlinkSync" | "copyFileSync" | "openSync"
//   path     - substring of the target path (fd calls resolve the fd's open path)
//   contains - substring of the bytes being written (writeSync only)
//   nth      - 1-based match count that fires the action (default 1)
//   action   - "kill"            die before the syscall happens
//              "half-then-kill"  write half the bytes, then die
//              "kill-after"      let the syscall finish, then die
//              "error"           throw a synthetic errno error instead
//
// SIGKILL to self, not abort(): it is the exact signal the matrix is named for,
// it runs no exit handler, and it leaves no core dump behind in CI.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("fs");

const rules = JSON.parse(process.env.ACP_GATEWAY_FAULT_FS ?? "[]").map((rule) => ({ ...rule, hits: 0 }));
const openPaths = new Map();

if (rules.length > 0) {
  const originals = {};
  for (const name of ["writeSync", "fsyncSync", "ftruncateSync", "renameSync", "unlinkSync", "copyFileSync", "openSync"]) {
    originals[name] = fs[name];
  }

  // apply() returns whatever the real call returned, so this must not call the
  // original a second time: an "wx" open that ran twice would create the file and
  // then fail on its own handiwork.
  fs.openSync = function openSync(path, ...rest) {
    const fd = apply("openSync", { path: String(path) }, originals.openSync, this, [path, ...rest]);
    if (typeof fd === "number") openPaths.set(fd, String(path));
    return fd;
  };

  const closeSync = fs.closeSync;
  fs.closeSync = function patchedCloseSync(fd, ...rest) {
    openPaths.delete(fd);
    return closeSync.call(this, fd, ...rest);
  };

  fs.writeSync = function writeSync(fd, data, ...rest) {
    const offset = typeof rest[0] === "number" ? rest[0] : 0;
    const length = typeof rest[1] === "number"
      ? rest[1]
      : (Buffer.isBuffer(data) ? data.length - offset : Buffer.byteLength(String(data)));
    const text = Buffer.isBuffer(data)
      ? data.subarray(offset, offset + length).toString("utf8")
      : String(data);
    return apply(
      "writeSync",
      { path: openPaths.get(fd) ?? "", text, fd, data, offset, length },
      originals.writeSync,
      this,
      [fd, data, ...rest]
    );
  };

  fs.fsyncSync = function fsyncSync(fd) {
    return apply("fsyncSync", { path: openPaths.get(fd) ?? "" }, originals.fsyncSync, this, [fd]);
  };

  fs.ftruncateSync = function ftruncateSync(fd, ...rest) {
    return apply("ftruncateSync", { path: openPaths.get(fd) ?? "" }, originals.ftruncateSync, this, [fd, ...rest]);
  };

  for (const name of ["renameSync", "unlinkSync", "copyFileSync"]) {
    fs[name] = function patched(path, ...rest) {
      return apply(name, { path: String(path) }, originals[name], this, [path, ...rest]);
    };
  }
}

function apply(call, context, original, thisArg, args) {
  const rule = match(call, context);
  if (!rule) return original.apply(thisArg, args);
  if (rule.action === "error") {
    const error = new Error(`fault-fs: injected ${call} failure on ${context.path}`);
    error.code = rule.code ?? "EIO";
    error.errno = -5;
    throw error;
  }
  if (rule.action === "half-then-kill") {
    const half = Math.max(1, Math.floor((context.length ?? 2) / 2));
    try {
      original.call(thisArg, context.fd, context.data, context.offset ?? 0, half);
    } catch {
      // Dying either way.
    }
    die();
  }
  if (rule.action === "kill-after") {
    const result = original.apply(thisArg, args);
    die();
    return result;
  }
  die();
  return undefined;
}

function match(call, context) {
  for (const rule of rules) {
    if (rule.call !== call) continue;
    if (rule.path && !String(context.path ?? "").includes(rule.path)) continue;
    if (rule.contains && !String(context.text ?? "").includes(rule.contains)) continue;
    rule.hits += 1;
    if (rule.hits !== (rule.nth ?? 1)) continue;
    return rule;
  }
  return null;
}

function die() {
  process.kill(process.pid, "SIGKILL");
}
