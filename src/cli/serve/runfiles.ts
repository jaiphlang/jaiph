import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join, resolve, sep } from "node:path";

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

/** The response-body sink an SSE stream writes to; decoupled from `node:http`. */
export interface StreamTarget {
  write(chunk: string): void;
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

/** Read complete (newline-terminated) lines from `file` starting at byte `offset`. */
function readNewLines(file: string, offset: number): { lines: string[]; nextOffset: number } {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return { lines: [], nextOffset: offset };
  }
  if (buf.length <= offset) return { lines: [], nextOffset: offset };
  const chunk = buf.toString("utf8", offset);
  const lastNl = chunk.lastIndexOf("\n");
  if (lastNl === -1) return { lines: [], nextOffset: offset };
  const complete = chunk.slice(0, lastNl);
  const lines = complete.length > 0 ? complete.split("\n") : [];
  const nextOffset = offset + Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8");
  return { lines, nextOffset };
}

/**
 * SSE follower for a run's durable journal. Replays every existing line as
 * `data: <raw json line>`, follows the file as it appends (polling every
 * `pollMs`), keeps proxies from idling the connection out with a `:ka` comment
 * every `keepAliveMs`, and closes with `event: end` once the run is terminal —
 * so it works identically for a still-running run and an already-terminal one
 * (full replay + immediate end).
 *
 * The journal is streamed verbatim: the credential redaction already applied by
 * `RuntimeEventEmitter` is the redaction guarantee, and the raw `%06d-*.out`/
 * `.err` capture files are never opened here.
 */
export async function streamRunEventsSse(target: StreamTarget, opts: SseEventsOptions): Promise<void> {
  let offset = 0;
  let lastKeepAlive = Date.now();
  const flush = (): void => {
    const dir = opts.resolveRunDir();
    if (!dir) return;
    const { lines, nextOffset } = readNewLines(join(dir, RUN_SUMMARY), offset);
    offset = nextOffset;
    for (const line of lines) target.write(`data: ${line}\n\n`);
  };
  for (;;) {
    if (target.aborted) return;
    flush();
    if (opts.isTerminal()) {
      // A final line (e.g. WORKFLOW_END) may have landed between the read above
      // and the registry marking the run terminal; flush once more so the
      // stream is complete before closing.
      flush();
      target.write("event: end\ndata: {}\n\n");
      return;
    }
    if (Date.now() - lastKeepAlive >= opts.keepAliveMs) {
      target.write(":ka\n\n");
      lastKeepAlive = Date.now();
    }
    await sleep(opts.pollMs, target);
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
