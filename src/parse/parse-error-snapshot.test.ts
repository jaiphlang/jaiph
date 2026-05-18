/**
 * Snapshot test for parser errors. Walks every `=== name` block in
 * `test-fixtures/compiler-txtar/parse-errors.txt`, parses the virtual files,
 * and re-emits the captured error as `{ file, line, col, code, message }`.
 *
 * The snapshot is stored at
 * `test-fixtures/compiler-txtar/parse-errors-snapshot.json`. Re-run with
 * `UPDATE_SNAPSHOTS=1` only after confirming a diff is intentional — this
 * test exists so any drift in parser error code/line/col/message surfaces
 * immediately.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadModuleGraph } from "../transpile/module-graph";

// Tests run from `dist/src/parse/...`; walk up to repo root.
const repoRoot = resolve(__dirname, "../../..");
const fixturesDir = resolve(repoRoot, "test-fixtures/compiler-txtar");
const fixtureFile = join(fixturesDir, "parse-errors.txt");
const snapshotPath = join(fixturesDir, "parse-errors-snapshot.json");

interface TxtarCase {
  name: string;
  files: Map<string, string>;
}

interface SnapshotEntry {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

type Snapshot = Record<string, SnapshotEntry>;

function parseTxtar(content: string): TxtarCase[] {
  const cases: TxtarCase[] = [];
  for (const block of content.split(/^=== /m)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split("\n");
    const name = lines[0].trim();
    let fileStartIdx = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].startsWith("--- ")) {
        fileStartIdx = i;
        break;
      }
    }
    if (fileStartIdx < 0) continue;
    cases.push({ name, files: parseVirtualFiles(lines.slice(fileStartIdx)) });
  }
  return cases;
}

function parseVirtualFiles(lines: string[]): Map<string, string> {
  const files = new Map<string, string>();
  let cur: string | undefined;
  let buf: string[] = [];
  for (const line of lines) {
    if (line.startsWith("--- ")) {
      if (cur !== undefined) files.set(cur, buf.join("\n") + "\n");
      cur = line.slice(4).trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (cur !== undefined) files.set(cur, buf.join("\n") + "\n");
  return files;
}

function entryFile(files: Map<string, string>): string {
  if (files.has("main.jh")) return "main.jh";
  if (files.has("input.jh")) return "input.jh";
  if (files.has("input.test.jh")) return "input.test.jh";
  const first = files.keys().next().value;
  if (!first) throw new Error("no virtual files");
  return first;
}

function relativizeTmp(p: string, tmpDir: string): string {
  return p.startsWith(tmpDir) ? p.slice(tmpDir.length).replace(/^[\/]+/, "") : p;
}

function scrubTmp(msg: string, tmpDir: string): string {
  const escaped = tmpDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return msg.replace(new RegExp(escaped, "g"), "<TMP>");
}

function captureSnapshot(): Snapshot {
  const content = readFileSync(fixtureFile, "utf8");
  const out: Snapshot = {};
  for (const tc of parseTxtar(content)) {
    const tmpDir = mkdtempSync(join(tmpdir(), "jaiph-parse-snap-"));
    try {
      for (const [name, body] of tc.files) {
        writeFileSync(join(tmpDir, name), body, "utf8");
      }
      const entry = join(tmpDir, entryFile(tc.files));
      try {
        loadModuleGraph(entry);
        out[tc.name] = {
          file: "<no-error>",
          line: 0,
          col: 0,
          code: "OK",
          message: "compilation succeeded but fixture expected a parse error",
        };
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        const m = msg.match(/^(.+):(\d+):(\d+) (\S+) ([\s\S]+)$/);
        out[tc.name] = m
          ? {
              file: relativizeTmp(m[1], tmpDir),
              line: Number(m[2]),
              col: Number(m[3]),
              code: m[4],
              message: scrubTmp(m[5], tmpDir),
            }
          : {
              file: "<unknown>",
              line: 0,
              col: 0,
              code: "E_FATAL",
              message: scrubTmp(msg, tmpDir),
            };
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  return out;
}

test("parse-errors.txt snapshot pins {file, line, col, code, message}", () => {
  const current = captureSnapshot();
  if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(snapshotPath)) {
    writeFileSync(snapshotPath, JSON.stringify(current, null, 2) + "\n", "utf8");
    return;
  }
  const stored = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
  assert.deepEqual(
    current,
    stored,
    "parser error output drifted from snapshot. Re-run with UPDATE_SNAPSHOTS=1 only after confirming the change is intentional.",
  );
});
