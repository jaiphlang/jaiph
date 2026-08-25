import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournalFollower, listArtifacts, resolveArtifactPath, streamRunEventsSse, type StreamTarget } from "./runfiles";

/** A run dir with an `artifacts/` subdir and a couple of raw capture files at the root. */
function makeRunDir(): string {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-runfiles-"));
  const artifacts = join(runDir, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  // Raw step capture files live in the run-dir ROOT, never under artifacts/.
  writeFileSync(join(runDir, "000001-build__step.out"), "SECRET stdout capture\n");
  writeFileSync(join(runDir, "000001-build__step.err"), "stderr capture\n");
  writeFileSync(join(runDir, "run_summary.jsonl"), "");
  return runDir;
}

// === listArtifacts ===

test("listArtifacts returns [] when there is no artifacts dir", () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-noart-"));
  try {
    assert.deepEqual(listArtifacts(runDir), []);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("listArtifacts lists regular files recursively and never the .out/.err captures", () => {
  const runDir = makeRunDir();
  try {
    writeFileSync(join(runDir, "artifacts", "report.txt"), "hello");
    mkdirSync(join(runDir, "artifacts", "nested"), { recursive: true });
    writeFileSync(join(runDir, "artifacts", "nested", "deep.bin"), Buffer.from([1, 2, 3]));
    const entries = listArtifacts(runDir);
    assert.deepEqual(
      entries.map((e) => e.path),
      ["nested/deep.bin", "report.txt"],
      "recursive, sorted, POSIX-relative; no capture files",
    );
    const report = entries.find((e) => e.path === "report.txt")!;
    assert.equal(report.size, 5);
    assert.equal(typeof report.mtime, "string");
    // The capture files exist in the run dir but must never surface as artifacts.
    assert.ok(!entries.some((e) => e.path.endsWith(".out") || e.path.endsWith(".err")));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// === resolveArtifactPath: traversal battery ===

test("resolveArtifactPath serves a contained regular file (and a nested one)", () => {
  const runDir = makeRunDir();
  try {
    writeFileSync(join(runDir, "artifacts", "ok.txt"), "data");
    mkdirSync(join(runDir, "artifacts", "sub"), { recursive: true });
    writeFileSync(join(runDir, "artifacts", "sub", "inner.txt"), "data2");
    assert.equal(resolveArtifactPath(runDir, "ok.txt"), realpathSync(join(runDir, "artifacts", "ok.txt")));
    assert.equal(resolveArtifactPath(runDir, "sub/inner.txt"), realpathSync(join(runDir, "artifacts", "sub", "inner.txt")));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("resolveArtifactPath rejects a ../-containing path escaping artifacts/", () => {
  const runDir = makeRunDir();
  try {
    // Points at a real capture file in the run-dir root — must still be null.
    assert.equal(resolveArtifactPath(runDir, "../000001-build__step.out"), null);
    assert.equal(resolveArtifactPath(runDir, "../../etc/hosts"), null);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("resolveArtifactPath rejects an absolute path", () => {
  const runDir = makeRunDir();
  try {
    assert.equal(resolveArtifactPath(runDir, "/etc/passwd"), null);
    assert.equal(resolveArtifactPath(runDir, join(runDir, "run_summary.jsonl")), null);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("resolveArtifactPath rejects an empty or NUL-bearing request and a directory", () => {
  const runDir = makeRunDir();
  try {
    mkdirSync(join(runDir, "artifacts", "adir"), { recursive: true });
    assert.equal(resolveArtifactPath(runDir, ""), null);
    assert.equal(resolveArtifactPath(runDir, "a\0b"), null);
    assert.equal(resolveArtifactPath(runDir, "adir"), null, "a directory is not a downloadable artifact");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("resolveArtifactPath rejects a symlink escaping artifacts/ without reading the target", () => {
  const runDir = makeRunDir();
  try {
    // A symlink INSIDE artifacts pointing OUTSIDE (at a run-dir capture file).
    symlinkSync(join(runDir, "000001-build__step.out"), join(runDir, "artifacts", "escape.txt"));
    assert.equal(resolveArtifactPath(runDir, "escape.txt"), null);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("resolveArtifactPath serves a symlink whose target is inside artifacts/", () => {
  const runDir = makeRunDir();
  try {
    writeFileSync(join(runDir, "artifacts", "real.txt"), "payload");
    symlinkSync(join(runDir, "artifacts", "real.txt"), join(runDir, "artifacts", "link.txt"));
    const resolved = resolveArtifactPath(runDir, "link.txt");
    assert.equal(resolved, realpathSync(join(runDir, "artifacts", "real.txt")), "resolves to the contained real target");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("no capture file is reachable: an artifacts/ symlink to a .out is rejected", () => {
  const runDir = makeRunDir();
  try {
    symlinkSync(join(runDir, "000001-build__step.out"), join(runDir, "artifacts", "leak.out"));
    assert.equal(resolveArtifactPath(runDir, "leak.out"), null, "cannot download a capture file via a symlink");
    // And a direct traversal to either capture extension is rejected too.
    assert.equal(resolveArtifactPath(runDir, "../000001-build__step.out"), null);
    assert.equal(resolveArtifactPath(runDir, "../000001-build__step.err"), null);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// === SSE framing ===

/** Collect every write; report `aborted` and run abort callbacks on demand. */
function fakeTarget(): StreamTarget & { chunks: string[]; abort: () => void } {
  let aborted = false;
  const cbs: Array<() => void> = [];
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: string): void {
      chunks.push(chunk);
    },
    get aborted(): boolean {
      return aborted;
    },
    onAbort(cb: () => void): void {
      cbs.push(cb);
    },
    abort(): void {
      aborted = true;
      for (const cb of cbs) cb();
    },
  };
}

test("streamRunEventsSse replays a terminal run's journal as data: frames then event: end", async () => {
  const runDir = makeRunDir();
  try {
    const lines = [
      '{"type":"RUN_START","run_id":"r1"}',
      '{"type":"STEP_END","status":0}',
      '{"type":"RUN_END","run_id":"r1"}',
    ];
    writeFileSync(join(runDir, "run_summary.jsonl"), lines.map((l) => `${l}\n`).join(""));
    const target = fakeTarget();
    await streamRunEventsSse(target, {
      resolveRunDir: () => runDir,
      isTerminal: () => true,
      pollMs: 5,
      keepAliveMs: 15000,
    });
    // Every journal line arrives as its own `data:` frame, in order (the end
    // frame is a distinct `event: end` chunk, not a `data: ` one).
    const dataPayloads = target.chunks
      .filter((c) => c.startsWith("data: "))
      .map((c) => c.slice("data: ".length).replace(/\n\n$/, ""));
    assert.deepEqual(dataPayloads, lines, "concatenated data: payloads equal the journal line set");
    assert.ok(target.chunks.some((c) => c === "event: end\ndata: {}\n\n"), "closes with event: end");
    assert.equal(target.chunks[target.chunks.length - 1], "event: end\ndata: {}\n\n", "end frame is last");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// === journal follower: fd + offset, no rereads ===

test("createJournalFollower emits only complete lines and finishes a split line without rereading", () => {
  const runDir = mkdtempSync(join(tmpdir(), "jaiph-follow-"));
  const file = join(runDir, "run_summary.jsonl");
  const follower = createJournalFollower();
  try {
    assert.deepEqual(follower.readNewLines(file), [], "missing file is not an error");
    writeFileSync(file, '{"a":1}\n{"b":');
    assert.deepEqual(follower.readNewLines(file), ['{"a":1}'], "the partial trailing line is withheld");
    appendFileSync(file, '2}\n');
    assert.deepEqual(follower.readNewLines(file), ['{"b":2}'], "the completed line is emitted from the buffered tail");
    assert.deepEqual(follower.readNewLines(file), [], "no appended bytes, no lines");
  } finally {
    follower.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});

/** Poll until `target` holds at least `n` SSE `data:` frames. */
async function waitForFrames(target: { chunks: string[] }, n: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (target.chunks.filter((c) => c.startsWith("data: ")).length < n) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} SSE data frames`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("SSE follow reads each appended journal byte exactly once, never before the current offset", async () => {
  const runDir = makeRunDir();
  const journal = join(runDir, "run_summary.jsonl");
  const lines = ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}'];
  writeFileSync(journal, `${lines[0]}\n${lines[1]}\n`);
  // Instrument fs: record every positional read, and catch any whole-file load
  // of the journal (the pre-follower implementation reread it on every poll).
  // Patch the live CJS module object (what the compiled code reads at call
  // time) — the tsc `import *` namespace copy is getter-only.
  const fsAny = createRequire(__filename)("node:fs") as Record<string, unknown>;
  const origReadSync = readSync;
  const origReadFileSync = readFileSync;
  const reads: Array<{ fd: number; position: number; bytes: number }> = [];
  let wholeJournalReads = 0;
  const target = fakeTarget();
  let terminal = false;
  try {
    fsAny.readSync = (fd: number, buffer: Buffer, off: number, len: number, pos: number): number => {
      const n = (origReadSync as (...a: unknown[]) => number)(fd, buffer, off, len, pos);
      reads.push({ fd, position: pos, bytes: n });
      return n;
    };
    fsAny.readFileSync = (...args: unknown[]): unknown => {
      if (args[0] === journal) wholeJournalReads += 1;
      return (origReadFileSync as (...a: unknown[]) => unknown)(...args);
    };
    const done = streamRunEventsSse(target, {
      resolveRunDir: () => runDir,
      isTerminal: () => terminal,
      pollMs: 5,
      keepAliveMs: 15000,
    });
    await waitForFrames(target, 2);
    appendFileSync(journal, `${lines[2]}\n`);
    await waitForFrames(target, 3);
    appendFileSync(journal, `${lines[3]}\n`);
    await waitForFrames(target, 4);
    terminal = true;
    await done;
  } finally {
    fsAny.readSync = origReadSync;
    fsAny.readFileSync = origReadFileSync;
    rmSync(runDir, { recursive: true, force: true });
  }
  const payloads = target.chunks.filter((c) => c.startsWith("data: ")).map((c) => c.slice(6).replace(/\n\n$/, ""));
  assert.deepEqual(payloads, lines, "every line arrived once, in order");
  assert.equal(wholeJournalReads, 0, "the journal is never loaded whole on a poll");
  // The follower's fd is the one whose positional reads total the journal size.
  const totalBytes = Buffer.byteLength(lines.map((l) => `${l}\n`).join(""));
  const byFd = new Map<number, Array<{ position: number; bytes: number }>>();
  for (const r of reads) {
    const list = byFd.get(r.fd) ?? [];
    list.push({ position: r.position, bytes: r.bytes });
    byFd.set(r.fd, list);
  }
  const followerReads = [...byFd.values()].find((rs) => rs.reduce((s, r) => s + r.bytes, 0) === totalBytes);
  assert.ok(followerReads, "exactly the journal's byte count was read — each byte once");
  let offset = 0;
  for (const r of followerReads!) {
    assert.equal(r.position, offset, "every read starts at the high-water mark — no byte before the offset is reread");
    offset += r.bytes;
  }
  assert.equal(offset, totalBytes);
});

test("streamRunEventsSse stops promptly when the client disconnects mid-run", async () => {
  const runDir = makeRunDir();
  try {
    writeFileSync(join(runDir, "run_summary.jsonl"), '{"type":"RUN_START","run_id":"r1"}\n');
    const target = fakeTarget();
    // Never terminal: the loop would poll forever, but an abort ends it.
    const done = streamRunEventsSse(target, {
      resolveRunDir: () => runDir,
      isTerminal: () => false,
      pollMs: 10,
      keepAliveMs: 15000,
    });
    target.abort();
    await done;
    // The initial replay happened; no end frame (client left before terminal).
    assert.ok(target.chunks.some((c) => c.startsWith("data: ")));
    assert.ok(!target.chunks.some((c) => c.startsWith("event: end")));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
