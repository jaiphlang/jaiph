import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";

/** A run's durable journal file name, under its run directory. */
export const RUN_SUMMARY = "run_summary.jsonl";

/**
 * A published artifact: a regular file under a run's `artifacts/` directory,
 * described by its path relative to that directory (POSIX-style `/` separators),
 * byte size, and last-modified time.
 */
export interface ArtifactEntry {
  path: string;
  size: number;
  mtime: string;
}

/**
 * List every regular file under `<runDir>/artifacts/` (recursively), newest
 * paths sorted lexicographically, `[]` when the directory is absent or empty.
 *
 * Symlinks are skipped: `withFileTypes` reports the entry's own type (an
 * `lstat`, never following the link), so a symlink is neither listed as a file
 * nor descended into as a directory. Only the durable `artifacts/` tree is
 * walked — the raw `%06d-*.out`/`.err` capture files live in the run-dir root
 * and are never reached by this function.
 */
export function listArtifacts(runDir: string): ArtifactEntry[] {
  const root = join(runDir, "artifacts");
  const out: ArtifactEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        try {
          const st = statSync(abs);
          out.push({ path: rel, size: st.size, mtime: st.mtime.toISOString() });
        } catch {
          // File vanished between readdir and stat; skip it.
        }
      }
      // Symlinks and other node types are intentionally ignored.
    }
  };
  walk(root, "");
  return out;
}

/**
 * Resolve a requested artifact sub-path against `<runDir>/artifacts/`,
 * traversal-proof, returning the absolute real path of a contained regular file
 * or `null` if the request escapes the artifacts directory in any way.
 *
 * Three independent guards, checked before the file is ever read:
 * 1. Empty / NUL-bearing requests are rejected outright.
 * 2. Lexical containment: `resolve()` collapses `..` and absolute paths, then
 *    the result must sit strictly under the artifacts dir.
 * 3. Symlink containment: `realpathSync` resolves every symlink on the way, and
 *    the real target must still sit under the real artifacts dir — a symlink
 *    inside `artifacts/` pointing outside is rejected without reading its target.
 */
export function resolveArtifactPath(runDir: string, requested: string): string | null {
  if (requested.length === 0 || requested.includes("\0")) return null;
  const artifactsDir = join(runDir, "artifacts");
  const candidate = resolve(artifactsDir, requested);
  if (candidate !== artifactsDir && !candidate.startsWith(artifactsDir + sep)) return null;
  if (!existsSync(candidate)) return null;
  let realArtifacts: string;
  let realCandidate: string;
  try {
    realArtifacts = realpathSync(artifactsDir);
    realCandidate = realpathSync(candidate);
  } catch {
    return null;
  }
  if (realCandidate !== realArtifacts && !realCandidate.startsWith(realArtifacts + sep)) return null;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(realCandidate);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return realCandidate;
}

/** An opened artifact: a read descriptor plus the size + display name `fstat` reported for it. */
export interface OpenArtifact {
  /** Read-only descriptor; the caller owns it and must close it (the download stream does on end). */
  fd: number;
  /** Byte size from `fstat` on the descriptor — never a second path-based `stat`. */
  size: number;
  /** Basename of the resolved file, for the download's `Content-Disposition`. */
  name: string;
}

/**
 * Resolve and open a requested artifact in one step, closing the check→open
 * TOCTOU window. After {@link resolveArtifactPath}'s traversal + symlink
 * containment checks pass, the file is opened once with `O_NOFOLLOW` (where the
 * platform defines it), so the final path component cannot be swapped for a
 * symlink after the check; size and regular-file type are then read from the
 * descriptor with `fstat`, never from a second path `stat` that could resolve to
 * a different inode. Returns `null` (leaking no descriptor) when the request
 * escapes the artifacts dir, the final component became a symlink (`ELOOP`), the
 * file vanished, or the target is not a regular file.
 *
 * `beforeOpen` is a test-only seam fired between resolve and open to exercise the
 * swap race; production callers omit it.
 */
export function openArtifact(
  runDir: string,
  requested: string,
  beforeOpen?: (resolved: string) => void,
): OpenArtifact | null {
  const abs = resolveArtifactPath(runDir, requested);
  if (abs === null) return null;
  beforeOpen?.(abs);
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null; // Vanished, or the final component is now a symlink (ELOOP).
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      closeSync(fd);
      return null;
    }
    return { fd, size: st.size, name: basename(abs) };
  } catch {
    closeSync(fd);
    return null;
  }
}

/** The response-body sink an SSE stream writes to; decoupled from `node:http`. */
export interface StreamTarget {
  /**
   * Queue a chunk. Returns `false` when the socket's write buffer is full (a
   * slow or non-reading client) — the follower stops reading more of the journal
   * and awaits {@link drain} before continuing, so an unread stream can never make
   * the server buffer the whole file. `true` means keep going.
   */
  write(chunk: string): boolean;
  /** Resolves once the socket is ready for more writes after a `false` from {@link write}. */
  drain(): Promise<void>;
  readonly aborted: boolean;
  onAbort(cb: () => void): void;
}

/** Inputs to the SSE follower — injectable so it is unit-testable without a socket. */
export interface SseEventsOptions {
  /** Re-resolves the run dir each poll (it may appear after the run starts). */
  resolveRunDir: () => string | null;
  /** True once the server's registry has marked the run terminal. */
  isTerminal: () => boolean;
  /** File-follow poll interval (ms). */
  pollMs: number;
  /** Keep-alive comment cadence (ms). */
  keepAliveMs: number;
}

/** Upper bound on one follower read, so neither a single `readSync` nor the
 * in-memory copy of appended bytes ever exceeds this — a 50 MB journal is drained
 * in 64 KB chunks, not loaded whole. */
export const JOURNAL_CHUNK_BYTES = 64 * 1024;

/**
 * Incremental reader over an append-only journal: an open file descriptor plus
 * a byte offset, so each poll reads only the bytes appended since the previous
 * one — bytes before the current offset are never read again, and no call loads
 * the whole file. Each call reads at most {@link JOURNAL_CHUNK_BYTES}; a caller
 * that needs to catch up on a large backlog loops until the result is empty.
 * Bytes after the last newline (a partial line still being written) are buffered
 * in memory and completed on a later call, never re-read from disk.
 */
export interface JournalFollower {
  /**
   * Complete (newline-terminated) lines from the next bounded chunk of `file`.
   * An empty result means caught up (no appended bytes, or only a partial line
   * buffered); otherwise more chunks may remain, so loop until it returns empty.
   */
  readNewLines(file: string): string[];
  close(): void;
}

export function createJournalFollower(): JournalFollower {
  let fd: number | null = null;
  let offset = 0;
  let tail = Buffer.alloc(0);
  return {
    readNewLines(file: string): string[] {
      if (fd === null) {
        try {
          fd = openSync(file, "r");
        } catch {
          return []; // The journal may not exist yet; try again next poll.
        }
      }
      let size: number;
      try {
        size = fstatSync(fd).size;
      } catch {
        return [];
      }
      if (size <= offset) return [];
      // Read at most one bounded chunk per call — never `size - offset`, which on
      // the first poll of a large journal would allocate and read the whole file.
      const toRead = Math.min(size - offset, JOURNAL_CHUNK_BYTES);
      const appended = Buffer.alloc(toRead);
      let read = 0;
      try {
        while (read < appended.length) {
          const n = readSync(fd, appended, read, appended.length - read, offset + read);
          if (n === 0) break;
          read += n;
        }
      } catch {
        return [];
      }
      offset += read;
      const buf = tail.length > 0 ? Buffer.concat([tail, appended.subarray(0, read)]) : appended.subarray(0, read);
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl === -1) {
        tail = Buffer.from(buf);
        return [];
      }
      // Copy the partial tail out so the full appended buffer can be collected.
      tail = Buffer.from(buf.subarray(lastNl + 1));
      const complete = buf.toString("utf8", 0, lastNl);
      return complete.length > 0 ? complete.split("\n") : [];
    },
    close(): void {
      if (fd === null) return;
      try {
        closeSync(fd);
      } catch {
        // Already closed; nothing to release.
      }
      fd = null;
    },
  };
}

/**
 * SSE follower for a run's durable journal. Replays every existing line as
 * `data: <raw json line>`, follows the file as it appends (polling every
 * `pollMs` through a {@link JournalFollower}, so each poll reads only the new
 * bytes), keeps proxies from idling the connection out with a `:ka` comment
 * every `keepAliveMs`, and closes with `event: end` once the run is terminal —
 * so it works identically for a still-running run and an already-terminal one
 * (full replay + immediate end).
 *
 * The journal is streamed verbatim: the credential redaction already applied by
 * `RuntimeEventEmitter` is the redaction guarantee, and the raw `%06d-*.out`/
 * `.err` capture files are never opened here.
 */
export async function streamRunEventsSse(target: StreamTarget, opts: SseEventsOptions): Promise<void> {
  const follower = createJournalFollower();
  let lastKeepAlive = Date.now();
  // Drain the journal in bounded chunks, honoring backpressure: when `write`
  // reports a full socket buffer, stop reading more of the file until the client
  // has drained what is already queued — so a slow reader cannot force the whole
  // journal into memory.
  const flush = async (): Promise<void> => {
    const dir = opts.resolveRunDir();
    if (!dir) return;
    const file = join(dir, RUN_SUMMARY);
    for (;;) {
      if (target.aborted) return;
      const lines = follower.readNewLines(file);
      if (lines.length === 0) return; // Caught up (or only a partial line buffered).
      let ready = true;
      for (const line of lines) {
        ready = target.write(`data: ${line}\n\n`);
        if (target.aborted) return;
      }
      if (!ready) await target.drain();
    }
  };
  try {
    for (;;) {
      if (target.aborted) return;
      await flush();
      if (opts.isTerminal()) {
        // A final line (e.g. RUN_END) may have landed between the read above
        // and the registry marking the run terminal; flush once more so the
        // stream is complete before closing.
        await flush();
        target.write("event: end\ndata: {}\n\n");
        return;
      }
      if (Date.now() - lastKeepAlive >= opts.keepAliveMs) {
        target.write(":ka\n\n");
        lastKeepAlive = Date.now();
      }
      await sleep(opts.pollMs, target);
    }
  } finally {
    follower.close();
  }
}

/** Sleep `ms`, resolving early if the client disconnects. */
function sleep(ms: number, target: StreamTarget): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    target.onAbort(() => {
      clearTimeout(timer);
      resolveSleep();
    });
  });
}
