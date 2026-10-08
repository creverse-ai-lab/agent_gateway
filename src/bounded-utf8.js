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

// Fills a buffer from the start of a file, one read at a time. One read is not
// one file: a short read is ordinary on a network or FUSE filesystem, and taking
// it for EOF reports a cut-short head as the complete file — a truncation the
// caller has no way to detect. Only bytesRead === 0 means there is nothing more.
// Exported as the seam for that case: no local filesystem will produce a partial
// read on request, so the test supplies the handle.
export async function readInto(handle, buffer) {
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (chunk.bytesRead === 0) break;
    bytesRead += chunk.bytesRead;
  }
  return bytesRead;
}

// The async sibling of readHeadBytes, for a request path that must not block the
// event loop and must report why a read failed rather than swallow it. Allocates
// maxBytes, never the file size: a 2GB file costs the cap.
export async function readTextHead(path, maxBytes) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 3);
    const bytesRead = await readInto(handle, buffer);
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
  // Validated before anything is opened, and matching what 1.3.2 did with the
  // same input: a non-numeric line or limit made Array#slice compute NaN bounds,
  // which returned an empty window rather than the whole file. Without the check
  // Math.floor(NaN) - 1 leaves skip = NaN, every comparison against it is false,
  // and the read silently starts at line 1 — the caller asked for line "abc" and
  // got the top of the file.
  const requestedLine = Number(line);
  const requestedLimit = Number(limit);
  if (!Number.isFinite(requestedLine) || Number.isNaN(requestedLimit) || !(requestedLimit > 0)) {
    return { text: "", bytes: 0, truncated: false };
  }
  const handle = await open(path, "r");
  const skip = Math.max(0, Math.floor(requestedLine) - 1);
  const chunks = [];
  let skipped = 0;
  let completed = 0;
  let bytes = 0;
  let truncated = false;
  let position = 0;
  let done = false;
  try {
    // Inside the try: an allocation between open() and it leaks the handle when
    // it throws, and a caller-supplied chunk size can throw.
    const buffer = Buffer.allocUnsafe(chunkBytes);
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
        if (completed >= requestedLimit) {
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

// A fragment below this many bytes is copied into the open tail block instead of
// becoming a Buffer of its own. A worker streams its answer a token at a time,
// and one Buffer object per token costs far more memory than the token.
const SMALL_APPEND_BYTES = 4096;
// Tail blocks start small and double up to the cap, so a two-word answer does not
// pay for 16KiB and a long transcript is not cut into thousands of blocks.
const MIN_BLOCK_BYTES = 256;
const MAX_BLOCK_BYTES = 16 * 1024;
// How many released slots the chunk list may carry before it is compacted.
const COMPACT_AFTER_SLOTS = 32;

// Bounded tail accumulator for UTF-8 text: append cost is proportional to the
// new/evicted bytes, not the full accumulated size. A string is materialized
// only when read.
//
// What it keeps alive is bounded too, not just what it returns. Small appends
// share tail blocks, so the chunk count follows the byte bound rather than the
// number of appends; an evicted chunk is released at once; and a large backing
// store whose live part has shrunk to a small tail is copied out instead of
// staying pinned by a view of it.
export class BoundedUtf8Text {
  constructor(maxBytes, { onTrim = null } = {}) {
    this.maxBytes = maxBytes;
    this.onTrim = onTrim;
    // Sealed chunks, oldest first; slots before head are released (undefined).
    this.chunks = [];
    this.head = 0;
    // The open tail block small appends are copied into. Its bytes from
    // blockStart to blockEnd are live and come after every sealed chunk.
    this.block = null;
    this.blockStart = 0;
    this.blockEnd = 0;
    this.nextBlockBytes = MIN_BLOCK_BYTES;
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
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes >= SMALL_APPEND_BYTES) {
      this.#seal();
      // Exactly sized and never pooled: a pooled Buffer is a view of a shared
      // slab that this chunk would keep alive for as long as it is retained.
      const chunk = Buffer.allocUnsafeSlow(bytes);
      chunk.write(value, 0, bytes, "utf8");
      this.chunks.push(chunk);
      this.totalBytes += bytes;
    } else if (bytes > 0) {
      this.#makeRoom(bytes);
      this.block.write(value, this.blockEnd, bytes, "utf8");
      this.blockEnd += bytes;
      this.totalBytes += bytes;
    }
    this.#trim();
  }

  reset(text = "") {
    this.chunks = [];
    this.head = 0;
    this.block = null;
    this.blockStart = 0;
    this.blockEnd = 0;
    this.nextBlockBytes = MIN_BLOCK_BYTES;
    this.totalBytes = 0;
    this.trimmedBytes = 0;
    this.pendingHighSurrogate = "";
    this.pendingBytes = 0;
    this.append(text);
  }

  toString() {
    const sealed = this.chunks.length - this.head;
    const open = this.blockEnd - this.blockStart;
    if (sealed === 0) return open > 0 ? this.block.toString("utf8", this.blockStart, this.blockEnd) : "";
    if (sealed === 1 && open === 0) return this.chunks[this.head].toString("utf8");
    // Collapsed into one chunk, so the next read is a single decode. The open
    // block keeps only its free room: the bytes it held are in the copy now.
    const merged = Buffer.allocUnsafeSlow(this.totalBytes);
    let offset = 0;
    for (let index = this.head; index < this.chunks.length; index += 1) {
      offset += this.chunks[index].copy(merged, offset);
    }
    if (open > 0) this.block.copy(merged, offset, this.blockStart, this.blockEnd);
    this.chunks = [merged];
    this.head = 0;
    this.blockStart = this.blockEnd;
    this.#dropSpentBlock();
    return merged.toString("utf8");
  }

  // What this accumulator keeps allocated: the Buffers it references and the
  // backing stores behind them, each store counted once. For tests and
  // diagnostics; nothing on the append path reads it.
  memoryStats() {
    const stores = new Set();
    let chunks = 0;
    for (const chunk of this.chunks) {
      if (!chunk) continue;
      chunks += 1;
      stores.add(chunk.buffer);
    }
    if (this.block) {
      chunks += 1;
      stores.add(this.block.buffer);
    }
    let retainedBytes = 0;
    for (const store of stores) retainedBytes += store.byteLength;
    return { chunks, retainedBytes };
  }

  // Ends the open region: its bytes become a sealed chunk (a view of the block)
  // so that whatever is appended next comes after them. The block keeps its
  // free room for the next small append.
  #seal() {
    if (this.blockEnd > this.blockStart) {
      this.chunks.push(this.block.subarray(this.blockStart, this.blockEnd));
    }
    this.blockStart = this.blockEnd;
  }

  #makeRoom(bytes) {
    if (this.block && this.block.length - this.blockEnd >= bytes) return;
    this.#seal();
    const cap = Math.min(MAX_BLOCK_BYTES, Math.max(MIN_BLOCK_BYTES, this.maxBytes));
    // Buffer.alloc never draws from the shared pool, and zero-filled bytes past
    // blockEnd can never be read as stale memory.
    this.block = Buffer.alloc(Math.max(bytes, Math.min(cap, this.nextBlockBytes)));
    this.blockStart = 0;
    this.blockEnd = 0;
    this.nextBlockBytes = Math.min(cap, this.nextBlockBytes * 2);
  }

  // A full block with nothing live left in it is only memory.
  #dropSpentBlock() {
    if (!this.block || this.blockEnd !== this.blockStart || this.blockEnd !== this.block.length) return;
    this.block = null;
    this.blockStart = 0;
    this.blockEnd = 0;
  }

  #evicted(bytes) {
    this.totalBytes -= bytes;
    this.trimmedBytes += bytes;
  }

  #trim() {
    while (this.totalBytes + this.pendingBytes > this.maxBytes) {
      const excess = this.totalBytes + this.pendingBytes - this.maxBytes;
      if (this.head < this.chunks.length) {
        const front = this.chunks[this.head];
        const start = front.length <= excess ? front.length : utf8Boundary(front, excess);
        this.onTrim?.(start === front.length ? front : front.subarray(0, start));
        this.#evicted(start);
        if (start < front.length) {
          this.chunks[this.head] = released(front.subarray(start));
        } else {
          // Released now, not at the next compaction.
          this.chunks[this.head] = undefined;
          this.head += 1;
        }
        continue;
      }
      if (this.blockEnd > this.blockStart) {
        const live = this.block.subarray(this.blockStart, this.blockEnd);
        const start = live.length <= excess ? live.length : utf8Boundary(live, excess);
        this.onTrim?.(live.subarray(0, start));
        this.#evicted(start);
        this.blockStart += start;
        continue;
      }
      break;
    }
    if (this.head === this.chunks.length) {
      if (this.head > 0) this.chunks = [];
      this.head = 0;
    } else if (this.head >= COMPACT_AFTER_SLOTS && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    this.#dropSpentBlock();
    if (this.totalBytes + this.pendingBytes > this.maxBytes) {
      if (this.pendingHighSurrogate) this.onTrim?.(Buffer.from(this.pendingHighSurrogate, "utf8"));
      this.trimmedBytes += this.pendingBytes;
      this.pendingHighSurrogate = "";
      this.pendingBytes = 0;
    }
  }
}

// The first character boundary at or after offset: evicting up to it never
// leaves a partial character at the front.
function utf8Boundary(buffer, offset) {
  let start = offset;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return start;
}

// A view keeps its whole backing store alive. Once most of a store larger than a
// tail block is evicted text, the live rest is worth a copy of its own: a 5MB
// append trimmed to a 1MB bound must not keep holding 5MB.
function released(view) {
  const store = view.buffer.byteLength;
  if (store <= MAX_BLOCK_BYTES || view.length * 2 >= store) return view;
  const copy = Buffer.allocUnsafeSlow(view.length);
  view.copy(copy);
  return copy;
}
