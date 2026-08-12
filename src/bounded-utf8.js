import { closeSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

// Truncates text to at most maxBytes of UTF-8 without splitting a multi-byte
// character. Length checks on JavaScript strings count code units, not bytes,
// so byte caps must go through here.
export function utf8ByteHead(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

// Removes an incomplete UTF-8 sequence from the end of a buffer. A read that
// stops at an arbitrary byte offset would otherwise decode to U+FFFD, which is
// corruption a caller cannot detect.
export function trimIncompleteUtf8(buffer) {
  let index = buffer.length - 1;
  let continuations = 0;
  while (index >= 0 && (buffer[index] & 0xc0) === 0x80) {
    continuations += 1;
    index -= 1;
  }
  if (index < 0) return buffer.subarray(0, 0);
  const lead = buffer[index];
  const needed = lead < 0x80 ? 0 : lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
  // Only an actually incomplete sequence is cut. Malformed input (more
  // continuations than the lead byte announces) is left exactly as it was read.
  return needed > continuations ? buffer.subarray(0, index) : buffer;
}

// Reads the first maxBytes of a text file without splitting a character; returns
// null when the file cannot be read. Moved here from the session store so the
// async sibling below can share its contract.
export function readHeadBytes(path, maxBytes) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    // Over-read a few bytes to tell "file fits entirely" apart from "cut
    // mid-character at exactly maxBytes".
    const buffer = Buffer.alloc(maxBytes + 3);
    const read = readSync(fd, buffer, 0, maxBytes + 3, 0);
    if (read <= maxBytes) return buffer.subarray(0, read).toString("utf8");
    let end = maxBytes;
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
    return buffer.subarray(0, end).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

// The async sibling, for a request path that must not block the event loop and
// must report why a read failed rather than swallow it. Allocates maxBytes, never
// the file size: a 2GB file costs the cap.
export async function readTextHead(path, maxBytes) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 3);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 3, 0);
    if (bytesRead <= maxBytes) {
      return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytes: bytesRead, truncated: false };
    }
    const head = trimIncompleteUtf8(buffer.subarray(0, maxBytes));
    return { text: head.toString("utf8"), bytes: head.length, truncated: true };
  } finally {
    await handle.close();
  }
}

// Reads a line window in one forward pass with a fixed buffer: time is O(bytes
// scanned), memory is the buffer plus what is actually returned. Nothing
// proportional to the skipped prefix is ever allocated.
export async function readTextLines(path, {
  line = 1,
  limit = Infinity,
  maxBytes = Infinity,
  chunkBytes = 64 * 1024
} = {}) {
  const handle = await open(path, "r");
  const buffer = Buffer.allocUnsafe(chunkBytes);
  const skip = Math.max(0, Math.floor(line) - 1);
  const chunks = [];
  let skipped = 0;
  let completed = 0;
  let bytes = 0;
  let truncated = false;
  let position = 0;
  let done = !(limit > 0);
  try {
    while (!done) {
      const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let index = 0;
      // Skip to the first byte of the requested line, keeping none of it.
      while (skipped < skip && index < bytesRead) {
        if (buffer[index] === 0x0a) skipped += 1;
        index += 1;
      }
      if (skipped < skip) continue;
      const from = index;
      while (index < bytesRead) {
        if (buffer[index] !== 0x0a) {
          index += 1;
          continue;
        }
        completed += 1;
        // The newline that ends the last requested line is a terminator, not
        // content: joining the window never produced a trailing separator either.
        if (completed >= limit) {
          done = true;
          break;
        }
        index += 1;
      }
      const room = maxBytes - bytes;
      const slice = buffer.subarray(from, index);
      // Strictly greater: a window that ends exactly at the cap is complete, and
      // must not report itself truncated.
      if (slice.length > room) {
        chunks.push(Buffer.from(slice.subarray(0, room)));
        bytes += room;
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(slice));
      bytes += slice.length;
    }
  } finally {
    await handle.close();
  }
  const window = truncated
    ? trimIncompleteUtf8(Buffer.concat(chunks, bytes))
    : Buffer.concat(chunks, bytes);
  return { text: window.toString("utf8"), bytes: window.length, truncated };
}

// Bounded tail accumulator for UTF-8 text: append cost is proportional to the
// new/evicted chunks, not the full accumulated size. A string is materialized
// only when read.
export class BoundedUtf8Text {
  constructor(maxBytes, { onTrim = null } = {}) {
    this.maxBytes = maxBytes;
    this.onTrim = onTrim;
    this.chunks = [];
    this.head = 0;
    this.totalBytes = 0;
    this.trimmedBytes = 0;
    this.pendingHighSurrogate = "";
    this.pendingBytes = 0;
  }

  append(text) {
    if (text == null || text === "") return;
    let value = this.pendingHighSurrogate + String(text);
    this.pendingHighSurrogate = "";
    this.pendingBytes = 0;
    const lastCodeUnit = value.charCodeAt(value.length - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      this.pendingHighSurrogate = value.at(-1);
      this.pendingBytes = Buffer.byteLength(this.pendingHighSurrogate, "utf8");
      value = value.slice(0, -1);
    }
    const chunk = Buffer.from(value, "utf8");
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.totalBytes += chunk.length;
    }
    this.#trim();
  }

  reset(text = "") {
    this.chunks = [];
    this.head = 0;
    this.totalBytes = 0;
    this.trimmedBytes = 0;
    this.pendingHighSurrogate = "";
    this.pendingBytes = 0;
    this.append(text);
  }

  toString() {
    const liveChunks = this.chunks.length - this.head;
    if (liveChunks === 0) return "";
    if (liveChunks > 1) this.chunks = [Buffer.concat(this.chunks.slice(this.head), this.totalBytes)];
    else if (this.head > 0) this.chunks = [this.chunks[this.head]];
    this.head = 0;
    return this.chunks[0].toString("utf8");
  }

  #trim() {
    while (this.totalBytes + this.pendingBytes > this.maxBytes && this.head < this.chunks.length) {
      const front = this.chunks[this.head];
      const excess = this.totalBytes + this.pendingBytes - this.maxBytes;
      if (front.length <= excess) {
        this.onTrim?.(front);
        this.totalBytes -= front.length;
        this.trimmedBytes += front.length;
        this.head += 1;
        continue;
      }
      let start = excess;
      while (start < front.length && (front[start] & 0xc0) === 0x80) start += 1;
      this.onTrim?.(front.subarray(0, start));
      this.totalBytes -= start;
      this.trimmedBytes += start;
      this.chunks[this.head] = front.subarray(start);
    }
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    if (this.totalBytes + this.pendingBytes > this.maxBytes) {
      if (this.pendingHighSurrogate) this.onTrim?.(Buffer.from(this.pendingHighSurrogate, "utf8"));
      this.trimmedBytes += this.pendingBytes;
      this.pendingHighSurrogate = "";
      this.pendingBytes = 0;
    }
  }
}
