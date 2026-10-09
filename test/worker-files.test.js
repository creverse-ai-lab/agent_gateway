import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod, copyFile, link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { AcpClient } from "../src/acp-client.js";
import { ArtifactStore } from "../src/artifacts.js";
import { readTextHead, readTextLines } from "../src/bounded-utf8.js";
import { GatewayService } from "../src/gateway-service.js";
import { GatewayRpcClient } from "../src/socket-rpc.js";
import { openWorkerFile } from "../src/worker-files.js";
import { startDaemon, writeMockProviders } from "./helpers/daemon-harness.js";

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

async function withCapabilityClient(cwd, run, options = {}) {
  const client = new AcpClient({ provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "auto_approve" }, options);
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

// F11 (1.8.0 review): a write opens with O_CREAT, and Linux follows a link
// anywhere above the last component, so a parent swapped for a link made the
// open create an empty file wherever the link pointed before the descriptor
// check refused the write. Removing it afterwards is no fix: Node has no
// unlinkat, and an unlink by name follows the same swap, onto a file that
// already existed, install.json included. So nothing is ever unlinked, and the
// create itself stays in the checked directory instead: on Linux the file is
// opened through a verified descriptor of its parent, on macOS the open refuses
// a link anywhere in the path. These run on the real platform, not PORTABLE.
test("on Linux a write whose parent was swapped for a link creates nothing where the link points", {
  skip: process.platform !== "linux"
}, async () => {
  await withLayout(async ({ directory, root, options }) => {
    const elsewhere = join(directory, "elsewhere"); // writable, outside the roots
    await mkdir(elsewhere);
    const parent = join(root, "d");
    await assert.rejects(
      openWorkerFile(join(parent, "new.txt"), { ...options, write: true, beforeOpen: () => swapForLink(parent, elsewhere) }),
      /changed while the Gateway was opening it/
    );
    await swapBack(parent);
    assert.equal(existsSync(join(elsewhere, "new.txt")), false, "the held parent was not the checked one, so nothing was created");
    assert.equal(existsSync(join(parent, "new.txt")), false);
  });
});

test("on Linux a parent swapped once it is held and verified still gets the file, the link's target never", {
  skip: process.platform !== "linux"
}, async () => {
  await withLayout(async ({ directory, root, options }) => {
    const elsewhere = join(directory, "elsewhere");
    await mkdir(elsewhere);
    const parent = join(root, "d");
    // The swap lands between the check of the held directory and the create, so
    // the path now leads elsewhere, but the create goes through the descriptor.
    await assert.rejects(
      openWorkerFile(join(parent, "new.txt"), { ...options, write: true, beforeCreate: () => swapForLink(parent, elsewhere) }),
      /changed while the Gateway was opening it/
    );
    assert.equal(await readFile(join(`${parent}.real`, "new.txt"), "utf8"), "", "created, empty, in the held directory inside the roots");
    assert.equal(existsSync(join(elsewhere, "new.txt")), false, "and nothing where the link points");
    await swapBack(parent);
  });
});

// /proc names no path longer than PATH_MAX, so a Worker that swaps the parent
// for a link to a directory nested deeper than that makes the readlink fail
// even though /proc is there. Only ENOENT (no /proc at all) skips a /proc check;
// this failure refuses, or the Worker could switch the check off at will.

// A directory nested deeper than PATH_MAX inside directory, built through short
// links: deepest is a short link to it, and remove() takes it down level by
// level the same way, since rm cannot walk a path that long.
async function tooDeepForProc(directory) {
  const name = "x".repeat(200);
  const hops = [join(directory, "deep")];
  await mkdir(hops[0]);
  for (let length = hops[0].length; length <= 4096; length += name.length + 1) {
    await mkdir(join(hops.at(-1), name));
    hops.push(join(directory, `hop${hops.length}`));
    await symlink(join(hops.at(-2), name), hops.at(-1));
  }
  return {
    deepest: hops.at(-1),
    async remove() {
      for (let level = hops.length - 1; level > 0; level--) await rm(join(hops[level - 1], name), { recursive: true, force: true });
    }
  };
}

// A write must not fall back to the open by path, which would follow the link
// and create the file in that directory.
test("on Linux a write whose parent is too deep for /proc to name is refused, not opened by path", {
  skip: process.platform !== "linux"
}, async () => {
  await withLayout(async ({ directory, root, options }) => {
    const deep = await tooDeepForProc(directory);
    const parent = join(root, "d");
    try {
      await assert.rejects(
        openWorkerFile(join(parent, "new.txt"), { ...options, write: true, beforeOpen: () => swapForLink(parent, deep.deepest) }),
        /changed while the Gateway was opening it/
      );
      await swapBack(parent);
      assert.equal(existsSync(join(deep.deepest, "new.txt")), false, "nothing is created in the directory /proc cannot name");
    } finally {
      await deep.remove();
    }
  });
});

// A read opens by path, so the descriptor's check is what must not be skipped.
// Left in place, the swap would fail the realpath re-check anyway; undone after
// the open, with the deep file a second name for the decoy, the path resolves
// as checked and to the very inode the descriptor holds, so only /proc tells
// the two names apart, and it cannot name the descriptor.
test("on Linux a read through a parent too deep for /proc to name is refused, not checked less", {
  skip: process.platform !== "linux"
}, async () => {
  await withLayout(async ({ directory, root, options }) => {
    const deep = await tooDeepForProc(directory);
    const parent = join(root, "d");
    const requested = join(parent, "install.json"); // the decoy
    try {
      await link(requested, join(deep.deepest, "install.json"));
      await assert.rejects(
        openWorkerFile(requested, { ...options, beforeOpen: () => swapForLink(parent, deep.deepest), afterOpen: () => swapBack(parent) }),
        /changed while the Gateway was opening it/
      );
    } finally {
      await deep.remove();
    }
  });
});

// F11 held the parent open for reading, so a parent the daemon may write into
// and search but not list (mode -wx) refused every write with EACCES. The
// parent is now held with O_PATH, which needs no permission on the directory
// itself; the swap tests above still refuse. Root may list any directory, so
// only a run as another user shows the difference.
test("on Linux a write into a parent the daemon may write and search but not list creates the file", {
  skip: process.platform !== "linux" ? "Linux only" : process.getuid?.() === 0 && "root ignores directory permissions"
}, async () => {
  await withLayout(async ({ root, options }) => {
    const parent = join(root, "d");
    await chmod(parent, 0o300);
    try {
      const created = await openWorkerFile(join(parent, "new.txt"), { ...options, write: true });
      try {
        await created.writeFile("content", "utf8");
      } finally {
        await created.close();
      }
      // And a Worker's fs/write_text_file, its approval path and new-file check included.
      await withCapabilityClient(parent, async (prompt) => {
        assert.equal((await prompt("write")).stopReason, "end_turn");
      });
    } finally {
      await chmod(parent, 0o700);
    }
    assert.equal(await readFile(join(parent, "new.txt"), "utf8"), "content");
    assert.equal(await readFile(join(parent, "written.txt"), "utf8"), "written");
  });
});

test("on macOS a write whose parent was swapped for a link is refused by the open, before anything is created", {
  skip: process.platform !== "darwin"
}, async () => {
  await withLayout(async ({ directory, root, options }) => {
    const elsewhere = join(directory, "elsewhere");
    await mkdir(elsewhere);
    const parent = join(root, "d");
    await assert.rejects(
      openWorkerFile(join(parent, "new.txt"), { ...options, write: true, beforeOpen: () => swapForLink(parent, elsewhere) }),
      /symbolic link the Gateway does not follow/
    );
    await swapBack(parent);
    assert.equal(existsSync(join(elsewhere, "new.txt")), false);
    assert.equal(existsSync(join(parent, "new.txt")), false);
  });
});

// The review's case against unlinking: the name is absent in the root, so the
// write may create it, and the swap, left in place, leads the path to the
// protected file of that name. A cleanup that unlinked what a refused open had
// reached would delete install.json; nothing is unlinked, so it keeps the token.
test("a refused write never deletes or empties the protected file a swapped parent leads to", async () => {
  await withLayout(async ({ root, guarded, secret, options }) => {
    const parent = join(root, "d");
    const requested = join(parent, "install.json");
    await rm(requested); // absent in the root
    for (const platform of [PORTABLE, process.platform]) {
      await assert.rejects(
        openWorkerFile(requested, { ...options, write: true, platform, beforeOpen: () => swapForLink(parent, guarded) }),
        RACE_REFUSED
      );
      await swapBack(parent);
      assert.equal(await readFile(secret, "utf8"), TOKEN, `${platform}: the protected file is neither deleted nor emptied`);
      assert.equal(existsSync(requested), false, `${platform}: and nothing was created in the root`);
    }
  });
});

test("a refused write to a file that already existed never deletes it", async () => {
  await withLayout(async ({ root, guarded, secret, options }) => {
    const directory = join(root, "d");
    const requested = join(directory, "install.json"); // the decoy, already on disk
    await assert.rejects(
      openWorkerFile(requested, {
        ...options, write: true, platform: PORTABLE,
        beforeOpen: () => swapForLink(directory, guarded),
        afterOpen: () => swapBack(directory)
      }),
      /changed while the Gateway was opening it/
    );
    assert.equal(await readFile(requested, "utf8"), "decoy", "the pre-existing in-root file is left intact");
    assert.equal(await readFile(secret, "utf8"), TOKEN, "and the protected file it was pointed at is untouched");
  });
});

test("a legitimate new-file write creates the file and keeps it", async () => {
  await withLayout(async ({ root, options }) => {
    const created = await openWorkerFile(join(root, "d", "fresh.txt"), { ...options, write: true });
    try {
      await created.writeFile("content", "utf8");
    } finally {
      await created.close();
    }
    assert.equal(await readFile(join(root, "d", "fresh.txt"), "utf8"), "content", "a verified new file is created where it was asked for and kept");
  });
});

// N3 (release-gate review): the inode check knows the files a protected
// directory holds now. A hard link a Worker made to install.json keeps the old
// inode once install.json is replaced by rename, with the same token in it when
// the run did not rotate; the installer now empties that file (installer.test.js),
// but only as far as it can open it for writing, and a copy never had a protected
// inode at all. So a read is also judged by what it would return: text that
// carries the Control token the daemon accepts is refused, before anything is
// returned.

const CREDENTIAL = /^File holds a Gateway credential; the Gateway does not return its content$/;

function installState(token) {
  return `${JSON.stringify({ version: 1, identity: { token, rootId: "main-test" }, managedMcp: {} }, null, 2)}\n`;
}

// The answer to a read-file prompt (mock-capability-agent.js), which holds no
// part of the token whatever the outcome.
async function readThrough(prompt, request) {
  const { stopReason } = await prompt(`read-file:${request}`);
  assert.equal(stopReason.includes(TOKEN), false, `${request}: the answer holds no part of the token`);
  return JSON.parse(stopReason);
}

test("N3: a hard link that outlived an atomic rewrite of install.json is refused by what it holds", async () => {
  await withLayout(async ({ root, guarded, secret, options }) => {
    await writeFile(secret, installState(TOKEN));
    const notes = join(root, "notes.json");
    await link(secret, notes);
    // A replacement that left the old file whole: the same token, written beside
    // install.json and renamed over it.
    await writeFile(`${secret}.4242.tmp`, installState(TOKEN));
    await rename(`${secret}.4242.tmp`, secret);
    // The link keeps the old inode, which no protected file has any more, so
    // the name and inode checks let it through as they would any in-root file.
    const opened = await openWorkerFile(notes, options);
    await opened.close();
    await withCapabilityClient(root, async (prompt) => {
      const refused = await readThrough(prompt, "notes.json");
      assert.match(refused.error, CREDENTIAL);
      assert.equal(refused.bytes, null, "nothing of the file was returned");
      // Line 4 is the one that holds the token.
      assert.match((await readThrough(prompt, "notes.json:4:1")).error, CREDENTIAL);
    }, { protectedPaths: [guarded], protectedSecrets: [TOKEN] });
  });
});

test("N3: a copy of the token file is refused, a file without the token is served, and a window is judged by what it returns", async () => {
  await withLayout(async ({ root, guarded, secret }) => {
    await writeFile(secret, installState(TOKEN));
    await copyFile(secret, join(root, "copy.json"));
    await writeFile(join(root, "mixed.txt"), `plain line\n${TOKEN}\nafter\n`);
    await withCapabilityClient(root, async (prompt) => {
      assert.match((await readThrough(prompt, "copy.json")).error, CREDENTIAL);
      const served = await readThrough(prompt, "a.txt");
      assert.equal(served.error, null);
      assert.equal(served.bytes, Buffer.byteLength("inside\nsecond line"));
      assert.match((await readThrough(prompt, "mixed.txt")).error, CREDENTIAL);
      assert.match((await readThrough(prompt, "mixed.txt:2:1")).error, CREDENTIAL);
      const around = await readThrough(prompt, "mixed.txt:1:1");
      assert.equal(around.error, null, "a line without the token is served");
      assert.equal(around.head, "plain line");
    }, { protectedPaths: [guarded], protectedSecrets: [TOKEN] });
    // An empty secret refuses nothing: it would be in every text.
    await withCapabilityClient(root, async (prompt) => {
      assert.equal((await readThrough(prompt, "a.txt")).error, null);
    }, { protectedPaths: [guarded], protectedSecrets: [""] });
  });
});

test("N3: the service hands every client the token to refuse, and nothing it persists or shows holds it", async () => {
  await withLayout(async ({ directory, root, guarded, secret }) => {
    await writeFile(secret, installState(TOKEN));
    await copyFile(secret, join(root, "copy.json"));
    const stateDirectory = join(directory, "state");
    const handed = [];
    const service = new GatewayService({
      statePath: join(stateDirectory, "state.json"),
      protectedPaths: [guarded],
      protectedSecrets: [TOKEN],
      createClient: (_provider, clientOptions) => {
        handed.push(clientOptions.protectedSecrets);
        return new AcpClient(
          { provider: "mock", command: process.execPath, args: [capabilityAgent], permissionPolicy: "auto_approve" },
          clientOptions
        );
      }
    });
    const context = { rootId: "main-n3" };
    try {
      await service.init();
      const { sessionId } = await service.call("session_open", { provider: "claude", cwd: root, permissionPolicy: "auto_approve" }, context);
      assert.deepEqual(handed, [[TOKEN]], "an injected client factory receives it too");
      const ran = await service.call("run", { sessionId, prompt: "read-file:copy.json", waitMs: 10_000 }, context);
      assert.match(JSON.parse(ran.result.stopReason).error, CREDENTIAL, "the real client refuses it");
      const got = await service.call("session", { action: "get", sessionId, includeEvents: true, includeTranscript: true }, context);
      for (const shown of [ran, got, service.stateSnapshot()]) assert.equal(JSON.stringify(shown).includes(TOKEN), false);
      assert.equal(inspect(service, { depth: 4 }).includes(TOKEN), false, "nor the service, its clients or their options");
      assert.equal(inspect([...service.clients.values()], { depth: 4 }).includes(TOKEN), false);
    } finally {
      await service.shutdown();
    }
    // What a clean shutdown leaves in the state directory: snapshot, log, artifacts.
    const files = (await readdir(stateDirectory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    assert.ok(files.length > 0);
    for (const file of files) assert.equal((await readFile(file, "utf8")).includes(TOKEN), false, file);
  });
});

test("N3: the daemon refuses a Worker's read of a file that holds the Control token it accepts", async () => {
  await withLayout(async ({ directory, root }) => {
    const stateDirectory = join(directory, "state");
    const daemon = await startDaemon({
      directory,
      env: {
        ...await writeMockProviders(directory, { provider: "mockcap", agent: capabilityAgent, permissionPolicy: "auto_approve" }),
        // Its protected paths are this layout's, and none of them holds the root.
        HOME: join(directory, "home"),
        ACP_GATEWAY_STATE: join(stateDirectory, "state.json"),
        ACP_GATEWAY_INSTALL_STATE: join(stateDirectory, "install.json")
      }
    });
    const client = new GatewayRpcClient({
      socketPath: daemon.socketPath,
      token: daemon.token,
      rootId: daemon.rootId,
      statePath: join(stateDirectory, "state.json"),
      autoStart: false
    });
    try {
      await writeFile(join(root, "pasted.txt"), `ACP_GATEWAY_CONTROL_TOKEN=${daemon.token}\n`);
      const { sessionId } = await client.call("session_open", { provider: "mockcap", cwd: root, permissionPolicy: "auto_approve" });
      const read = async (name) => JSON.parse((await client.call("run", { sessionId, prompt: `read-file:${name}`, waitMs: 10_000 })).result.stopReason);
      assert.match((await read("pasted.txt")).error, CREDENTIAL);
      assert.equal((await read("a.txt")).error, null);
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

// An artifact sits a level below the protected directory, deeper than the inode
// check walks, and holds what sessions sent and got back: transcripts, tool
// payloads, terminal output, task results. A hard link a Worker made to one is
// refused by the store's registry of its artifacts' inodes, for reads and writes
// alike, before a byte is read or the file is emptied; and an artifact the store
// deletes while such a link holds it is emptied first, so the link keeps nothing.

const HELD = /Path is a hard link to a Gateway-protected file: /;

test("a hard link to an artifact is refused for reads and writes, and holds nothing once the store deletes it", async () => {
  await withLayout(async ({ root, guarded, options }) => {
    const artifacts = join(guarded, "artifacts");
    const store = new ArtifactStore({ root: artifacts });
    const spill = (text) => {
      const writer = store.create("another-session", "task-result", { durable: true });
      writer.append(text);
      writer.finalize(null, { sync: true });
      return writer.metadata().path;
    };
    const result = spill("RESULT-OF-ANOTHER-SESSION");
    await link(result, join(root, "notes.txt"));
    // The file the capability agent's write names.
    await link(result, join(root, "written.txt"));

    // The protected directory's own walk does not reach it.
    const unseen = await openWorkerFile(join(root, "notes.txt"), options);
    await unseen.close();
    const isProtectedFile = (info) => store.isArtifact(info);
    for (const write of [false, true]) {
      await assert.rejects(openWorkerFile(join(root, "notes.txt"), { ...options, isProtectedFile, write }), HELD);
    }
    await withCapabilityClient(root, async (prompt) => {
      const refused = await readThrough(prompt, "notes.txt");
      assert.match(refused.error, HELD);
      assert.equal(refused.bytes, null, "nothing of the file was returned");
      assert.equal((await prompt("write")).stopReason, "rejected");
    }, { protectedPaths: [guarded], artifactStore: store });
    assert.equal(await readFile(result, "utf8"), "RESULT-OF-ANOTHER-SESSION", "neither read out nor emptied through a link");

    // A store that starts over the directory knows the artifact as well.
    assert.equal(new ArtifactStore({ root: artifacts }).isArtifact(await stat(join(root, "notes.txt"), { bigint: true })), true);

    // Reclaimed (discard) or aged out (prune), an artifact a link holds is
    // emptied before it is unlinked: what is left under the links holds
    // nothing, and is an ordinary in-root file again.
    const used = store.usedBytes;
    assert.equal(store.discard(result), true);
    assert.equal(existsSync(result), false);
    assert.equal(store.usedBytes, used - Buffer.byteLength("RESULT-OF-ANOTHER-SESSION"));
    for (const name of ["notes.txt", "written.txt"]) assert.equal(await readFile(join(root, name), "utf8"), "", name);
    const freed = await openWorkerFile(join(root, "notes.txt"), { ...options, isProtectedFile });
    await freed.close();
    const aged = spill("AN-OLDER-RESULT");
    await link(aged, join(root, "aged.txt"));
    assert.equal(store.prune(0, Date.now() + 1_000), 1);
    assert.equal(existsSync(aged), false);
    assert.equal(await readFile(join(root, "aged.txt"), "utf8"), "");
    assert.equal(store.usedBytes, 0);

    // One no other name holds is only unlinked: a reader that has it open, a
    // Main following its pointer, still reads all of it.
    const alone = spill("READ-WHILE-DELETED");
    const reader = await open(alone, "r");
    try {
      assert.equal(store.discard(alone), true);
      assert.equal(await reader.readFile("utf8"), "READ-WHILE-DELETED");
    } finally {
      await reader.close();
    }
  });
});
