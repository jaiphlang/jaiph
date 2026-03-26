import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Stats } from "node:fs";

export type FileCursor = {
  offset: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

export type TailAccumulator = {
  cursor?: FileCursor;
  /** Bytes not yet forming a full line (no trailing newline). */
  partial: string;
};

function fileIdentityChanged(prev: FileCursor | undefined, st: Stats): boolean {
  if (!prev) {
    return true;
  }
  if (prev.dev !== st.dev || prev.ino !== st.ino) {
    return true;
  }
  if (st.size < prev.offset) {
    return true;
  }
  return false;
}

/**
 * Read newly appended bytes from absPath. If the file was replaced or truncated,
 * returns needsReset=true so the caller can clear parser state and re-read from offset 0.
 */
export function readAppendWindow(absPath: string, acc: TailAccumulator): { chunk: string; needsReset: boolean } {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absPath);
  } catch {
    return { chunk: "", needsReset: false };
  }
  if (!st.isFile()) {
    return { chunk: "", needsReset: false };
  }

  if (fileIdentityChanged(acc.cursor, st)) {
    acc.cursor = undefined;
    acc.partial = "";
    return { chunk: "", needsReset: true };
  }

  const start = acc.cursor?.offset ?? 0;
  if (st.size <= start) {
    acc.cursor = {
      offset: st.size,
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
    return { chunk: "", needsReset: false };
  }

  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(absPath, "r");
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }

  acc.cursor = {
    offset: st.size,
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
  return { chunk: buf.toString("utf8"), needsReset: false };
}

export function readFullFile(absPath: string): string {
  const st = statSync(absPath);
  const fd = openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
