import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp-client.js";
import { readTextHead, readTextLines } from "../src/bounded-utf8.js";
import { openWorkerFile } from "../src/worker-files.js";

// W8: fs/read_text_file and fs/write_text_file used to check a path and then
// open it by name again. Each race below is the swap a Worker that can rename
// or symlink inside its roots would make in that window, staged through the
// seams that run right before and right after the open.

const capabilityAgent = fileURLToPath(new URL("./mock-capability-agent.js", import.meta.url));
const TOKEN = "TOKEN-THAT-MUST-NOT-LEAK";
// Refused by the open itself (macOS refuses a link anywhere in the path, every
// platform one as the last component) or by the check of the descriptor.
const RACE_REFUSED = /symbolic link the Gateway does not follow|changed while the Gateway was opening it/;
// A platform with no OS-level descriptor check, so only the portable re-check runs.
const PORTABLE = "sunos";

async function withLayout(run) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "acp-worker-files-")));
  try {
    const root = join(directory, "root");
    const guarded = join(directory, "home", ".acp-gateway");
    await mkdir(join(root, "d"), { recursive: true });
    await mkdir(guarded, { recursive: true });
    await writeFile(join(root, "a.txt"), "inside\nsecond line");
    await writeFile(join(root, "d", "install.json"), "decoy");
    await writeFile(join(guarded, "install.json"), TOKEN);
    return await run({
      directory,
      root,
      guarded,
      secret: join(guarded, "install.json"),
      options: { roots: [root], protectedPaths: [guarded] }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// The swap: the directory steps aside and a symlink to the target takes its name.
async function swapForLink(path, target) {
  await rename(path, `${path}.real`);
  await symlink(target, path);
}

async function swapBack(path) {
  await unlink(path);
  await rename(`${path}.real`, path);
}

async function readAll(handle) {
  return (await readTextHead(handle, 1_000_000)).text;
}

test("a Worker file is read and written through the descriptor the check approved", async () => {
  await withLayout(async ({ root, guarded, options }) => {
    const read = await openWorkerFile(join(root, "a.txt"), options);
    try {
      assert.equal(await readAll(read), "inside\nsecond line");
      // The readers take the handle and name every position, so a second pass
      // over the same descriptor starts from the top again.
      assert.equal((await readTextLines(read, { line: 2, limit: 1 })).text, "second line");
    } finally {
      await read.close();
    }

    // A write opens without truncating: emptying the file is the caller's step,
    // after the check.
    const existing = await openWorkerFile(join(root, "a.txt"), { ...options, write: true });
    try {
      assert.equal(await readFile(join(root, "a.txt"), "utf8"), "inside\nsecond line");
      await existing.truncate(0);
      await existing.writeFile("replaced", "utf8");
    } finally {
      await existing.close();
    }
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "replaced");

    const umask = process.umask(0o022);
    try {
      const created = await openWorkerFile(join(root, "d", "new.txt"), { ...options, write: true });
      await created.writeFile("new", "utf8");
      await created.close();
    } finally {
      process.umask(umask);
    }
    assert.equal(await readFile(join(root, "d", "new.txt"), "utf8"), "new");
    assert.equal((await stat(join(root, "d", "new.txt"))).mode & 0o777, 0o644, "0o666 before the umask, as writeFile created it");

    await assert.rejects(openWorkerFile(join(guarded, "install.json"), options), /outside ACP session roots/);
    await assert.rejects(
      openWorkerFile(join(root, "a.txt"), { ...options, protectedPaths: [root] }),
      /protected by the Gateway/
    );
  });
});

test("a symlink swapped in as the last component after the check is never followed", async () => {
  await withLayout(async ({ root, secret, options }) => {
    const target = join(root, "a.txt");
    const beforeOpen = async (path) => {
      await rm(path, { force: true });
      await symlink(secret, path);
    };
    await assert.rejects(openWorkerFile(target, { ...options, beforeOpen }), /symbolic link the Gateway does not follow/);
    await rm(target, { force: true });
    await writeFile(target, "inside");
    await assert.rejects(
      openWorkerFile(target, { ...options, write: true, beforeOpen }),
      /symbolic link the Gateway does not follow/
    );
    assert.equal(await readFile(secret, "utf8"), TOKEN, "the protected file is neither truncated nor written");
  });
});

test("a directory swapped for a symlink after the check is refused, for reads and writes", async () => {
  await withLayout(async ({ root, guarded, secret, options }) => {
    const directory = join(root, "d");
    const requested = join(directory, "install.json");
    const beforeOpen = () => swapForLink(directory, guarded);
    await assert.rejects(openWorkerFile(requested, { ...options, beforeOpen }), RACE_REFUSED);
    await swapBack(directory);
    await assert.rejects(openWorkerFile(requested, { ...options, write: true, beforeOpen }), RACE_REFUSED);
    await swapBack(directory);
    assert.equal(await readFile(secret, "utf8"), TOKEN);
    // And the decoy the check approved is untouched as well: nothing was written anywhere.
    assert.equal(await readFile(requested, "utf8"), "decoy");
  });
});

test("without an OS-level check, a swap undone before the re-check is caught by the inode comparison", async () => {
  await withLayout(async ({ root, guarded, secret, options }) => {
    const directory = join(root, "d");
    const requested = join(directory, "install.json");
    // The open goes through the link to the protected file; the swap is undone
    // at once, so the path resolves exactly as checked again. Only the inode
    // the descriptor holds tells the two files apart.
    const race = { platform: PORTABLE, beforeOpen: () => swapForLink(directory, guarded), afterOpen: () => swapBack(directory) };
    await assert.rejects(openWorkerFile(requested, { ...options, ...race }), /changed while the Gateway was opening it/);
    await assert.rejects(openWorkerFile(requested, { ...options, ...race, write: true }), /changed while the Gateway was opening it/);
    assert.equal(await readFile(secret, "utf8"), TOKEN, "opened for writing, but never truncated or written");

    // A swap left in place: the path now resolves outside the roots.
    await assert.rejects(
      openWorkerFile(requested, { ...options, platform: PORTABLE, beforeOpen: () => swapForLink(directory, guarded) }),
      /changed while the Gateway was opening it/
    );
    await swapBack(directory);
    assert.equal(await readFile(requested, "utf8"), "decoy");
  });
});

test("on macOS and Linux the OS-level check alone refuses the swap, even where the inode matches", {
  skip: !["darwin", "linux"].includes(process.platform)
}, async () => {
  await withLayout(async ({ root, guarded, secret, options }) => {
    const directory = join(root, "d");
    const requested = join(directory, "install.json");
    // The decoy is a hard link to the protected file, so whichever way the path
    // resolves, stat finds the descriptor's inode and the portable re-check
    // passes: it narrows the window, it cannot close it. What refuses here is
    // the open on macOS (no link anywhere in the path) and, on Linux, the
    // descriptor's own path in /proc.
    await rm(requested);
    await link(secret, requested);
    await assert.rejects(
      openWorkerFile(requested, { ...options, beforeOpen: () => swapForLink(directory, guarded), afterOpen: () => swapBack(directory) }),
      process.platform === "darwin" ? /symbolic link the Gateway does not follow/ : /changed while the Gateway was opening it/
    );
    // On macOS the open failed, so the swap was never undone.
    if ((await lstat(directory)).isSymbolicLink()) await swapBack(directory);
    assert.equal(await readFile(secret, "utf8"), TOKEN);
  });
});

// F4 (1.8.0 review): link(2) needs no read permission on its target, so a Worker
// can give a protected file a second name inside its roots (ln the token to
// ./notes). The path check passes — the name is in-root and under no protected
// path — and /proc and the realpath both show that in-root name, so only the
// descriptor's inode tells the two names apart. Read and write refuse it by
// (dev, ino), before a byte is read or the file is truncated.
test("a hard link to a protected file is refused for reads and writes, and an ordinary one still works", async () => {
  await withLayout(async ({ root, secret, options }) => {
    const toSecret = join(root, "notes");
    await link(secret, toSecret);
    await assert.rejects(openWorkerFile(toSecret, options), /hard link to a Gateway-protected file/);
    await assert.rejects(openWorkerFile(toSecret, { ...options, write: true }), /hard link to a Gateway-protected file/);
    assert.equal(await readFile(secret, "utf8"), TOKEN, "neither read out nor truncated through the link");

    // A hard link to an ordinary in-root file is no protected inode: it still works.
    const toPlain = join(root, "b.txt");
    await link(join(root, "a.txt"), toPlain);
    const handle = await openWorkerFile(toPlain, options);
    try {
      assert.equal(await readAll(handle), "inside\nsecond line");
    } finally {
      await handle.close();
    }
  });
});

// Review: the inode scan swallowed every stat/readdir error, so a protected file
// it could not see was treated as absent and the open was allowed — a hard link
// to the token became readable while its directory was briefly unlistable.
test("the inode check fails closed when a protected path faults, and skips one that is absent", async () => {
  await withLayout(async ({ root, secret, options }) => {
    // A protected path the Gateway cannot stat (here it runs through a file, so
    // ENOTDIR, standing in for EACCES or EIO) could be hiding the token: the open
    // is refused rather than waved through on a swallowed error.
    const faulting = join(secret, "within");
    for (const write of [false, true]) {
      await assert.rejects(
        openWorkerFile(join(root, "a.txt"), { ...options, write, protectedPaths: [faulting] }),
        /Cannot verify a path is not Gateway-protected/
      );
    }
    // A protected path that is simply absent (ENOENT) protects nothing: the same
    // open is allowed, so a missing settings or state directory does not refuse reads.
    const handle = await openWorkerFile(join(root, "a.txt"), { ...options, protectedPaths: [join(root, "gone")] });
    try {
      assert.equal(await readAll(handle), "inside\nsecond line");
    } finally {
      await handle.close();
    }
    assert.equal(await readFile(secret, "utf8"), TOKEN);
  });
});

test("the inode check fails closed when a protected directory cannot be listed", {
  skip: typeof process.getuid === "function" && process.getuid() === 0
}, async () => {
  await withLayout(async ({ root, guarded, secret, options }) => {
    // Mode 000: the directory cannot be listed, so the token it holds cannot be
    // ruled out and even an ordinary in-root open is refused.
    await chmod(guarded, 0o000);
    try {
      await assert.rejects(openWorkerFile(join(root, "a.txt"), options), /Cannot list a Gateway-protected directory/);
      await assert.rejects(openWorkerFile(join(root, "a.txt"), { ...options, write: true }), /Cannot list a Gateway-protected directory/);
    } finally {
      await chmod(guarded, 0o700);
    }
    // Listable again: ordinary in-root files read, and the token is untouched.
    const handle = await openWorkerFile(join(root, "a.txt"), options);
    try {
      assert.equal(await readAll(handle), "inside\nsecond line");
    } finally {
      await handle.close();
    }
    assert.equal(await readFile(secret, "utf8"), TOKEN);
  });
});

test("a dangling symlink as the last component cannot make a write create its target", async () => {
  await withLayout(async ({ directory, root, options }) => {
    // realpath fails on a dangling link, so the check resolves its parent and
    // approves root/new.txt; following the link would create the target, here
    // outside the roots (a LaunchAgent or ~/.ssh file elsewhere).
    const target = join(directory, "created-by-worker.txt");
    await symlink(target, join(root, "new.txt"));
    await assert.rejects(
      openWorkerFile(join(root, "new.txt"), { ...options, write: true }),
      /symbolic link the Gateway does not follow/
    );
    assert.equal(existsSync(target), false);
  });
});

test("a FIFO or a directory is refused at once, without waiting for a writer", { skip: process.platform === "win32" }, async () => {
  await withLayout(async ({ root, options }) => {
    const fifo = join(root, "pipe");
    execFileSync("mkfifo", [fifo]);
    // Without O_NONBLOCK this open would wait for a writer forever.
    await assert.rejects(openWorkerFile(fifo, options), /not a regular file/);
    await assert.rejects(openWorkerFile(fifo, { ...options, write: true }));
    await assert.rejects(openWorkerFile(join(root, "d"), options), /not a regular file/);
  });
});

async function withCapabilityClient(cwd, run) {
  const client = new AcpClient({ provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "auto_approve" });
  try {
    await client.start();
    const session = await client.sessionNew({ cwd, permissionPolicy: "auto_approve" });
    return await run((prompt) => client.sessionPrompt({ sessionId: session.sessionId, prompt }));
  } finally {
    await client.stop();
  }
}

test("fs/write_text_file refuses a dangling symlink instead of creating its target outside the root", async () => {
  await withLayout(async ({ directory, root }) => {
    const target = join(directory, "created-by-worker.txt");
    await symlink(target, join(root, "written.txt"));
    await withCapabilityClient(root, async (prompt) => {
      assert.equal((await prompt("write")).stopReason, "rejected");
    });
    assert.equal(existsSync(target), false, "before 1.8.0 the write created it, with the Worker's content");
  });
});

test("fs/read_text_file refuses a FIFO at once and keeps serving reads", { skip: process.platform === "win32" }, async () => {
  await withLayout(async ({ root }) => {
    execFileSync("mkfifo", [join(root, "pipe")]);
    await withCapabilityClient(root, async (prompt) => {
      const refused = JSON.parse((await prompt("read-file:pipe")).stopReason);
      assert.match(refused.error, /not a regular file/);
      const served = JSON.parse((await prompt("read-file:a.txt:2:1")).stopReason);
      assert.equal(served.error, null);
      assert.equal(served.head, "second line");
    });
  });
});
