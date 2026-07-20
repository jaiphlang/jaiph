/**
 * Acceptance tests for Refactor 4 (visitor-table validator).
 *
 * AC1 — `src/transpile/validate.ts` is at most 700 lines.
 * AC3 — Diagnostic snapshot over every txtar `validate-*` error fixture pins
 *       `{ code, line, col, message }` bit-for-bit.
 * AC4 — Adding a new step type requires exactly one row in `VALIDATORS`: a
 *       synthetic step type injected via type cast is rejected with the
 *       documented "internal: no validator" message and produces exactly
 *       one diagnostic.
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
import { Diagnostics } from "../diagnostics";
import { loadModuleGraph } from "./module-graph";
import { collectDiagnostics } from "./validate";
import {
  RULE_SCOPE,
  WORKFLOW_SCOPE,
  validateStep,
  type ValidatorCtx,
} from "./validate-step";
import type { jaiphModule, WorkflowStepDef } from "../types";

const repoRoot = resolve(__dirname, "../../..");
const validatePath = resolve(repoRoot, "src/transpile/validate.ts");

// --- AC1: file size bound -------------------------------------------------

test("AC1: validate.ts is at most 700 lines", () => {
  const text = readFileSync(validatePath, "utf8");
  const lineCount = text.split("\n").length;
  assert.ok(
    lineCount <= 700,
    `validate.ts is ${lineCount} lines (limit 700). The visitor-table refactor (Refactor 4) bounds this file; new validators belong in validate-step.ts.`,
  );
});

// --- AC3: diagnostic snapshot --------------------------------------------

interface TxtarTestCase {
  name: string;
  files: Map<string, string>;
}

function parseTxtar(content: string): TxtarTestCase[] {
  const cases: TxtarTestCase[] = [];
  const blocks = content.split(/^=== /m);
  for (const block of blocks) {
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

interface SnapshotEntry {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}
type Snapshot = Record<string, SnapshotEntry[]>;

function captureSnapshot(): Snapshot {
  const fixturesDir = resolve(repoRoot, "test-fixtures/compiler-txtar");
  const out: Snapshot = {};
  const files = ["validate-errors.txt", "validate-errors-multi-module.txt"];
  for (const fileName of files) {
    const content = readFileSync(join(fixturesDir, fileName), "utf8");
    for (const tc of parseTxtar(content)) {
      const key = `${fileName} > ${tc.name}`;
      const tmpDir = mkdtempSync(join(tmpdir(), "jaiph-snap-"));
      try {
        for (const [name, body] of tc.files) {
          writeFileSync(join(tmpDir, name), body, "utf8");
        }
        const entry = join(tmpDir, entryFile(tc.files));
        let diagnostics: SnapshotEntry[] = [];
        try {
          const graph = loadModuleGraph(entry);
          const diag = collectDiagnostics(graph);
          diagnostics = diag.sorted().map((d) => ({
            file: relativizeTmp(d.file, tmpDir),
            line: d.line,
            col: d.col,
            code: d.code,
            message: scrubTmp(d.message, tmpDir),
          }));
        } catch (e) {
          // Fatal parser/loader error — capture as a synthetic diagnostic row
          // so the snapshot still pins the failure mode.
          const msg = (e as Error).message ?? String(e);
          const m = msg.match(/^(.+):(\d+):(\d+) (\S+) ([\s\S]+)$/);
          diagnostics = [
            m
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
                },
          ];
        }
        out[key] = diagnostics;
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }
  return out;
}

function relativizeTmp(p: string, tmpDir: string): string {
  if (p.startsWith(tmpDir)) {
    const rel = p.slice(tmpDir.length);
    return rel.replace(/^[\/]+/, "");
  }
  return p;
}

/** Replace `<tmpDir>/...` substrings in error messages with `<TMP>/...` so the snapshot is stable across runs. */
function scrubTmp(msg: string, tmpDir: string): string {
  const escaped = tmpDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return msg.replace(new RegExp(escaped, "g"), "<TMP>");
}

test("AC3: validate-* fixtures diagnostic snapshot pins {code, line, col, message}", () => {
  const snapshotPath = resolve(
    repoRoot,
    "test-fixtures/compiler-txtar/validate-diagnostics-snapshot.json",
  );
  const current = captureSnapshot();

  if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(snapshotPath)) {
    writeFileSync(snapshotPath, JSON.stringify(current, null, 2) + "\n", "utf8");
    return;
  }
  const stored = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
  assert.deepEqual(
    current,
    stored,
    "diagnostic output drifted from snapshot. Re-run with UPDATE_SNAPSHOTS=1 only after confirming the change is intentional.",
  );
});

// --- AC4: unknown step type rejection -------------------------------------

test("AC4: unknown step type is rejected with the documented 'no validator' diagnostic (one error)", () => {
  const ast: jaiphModule = {
    filePath: "/synthetic.jh",
    imports: [],
    channels: [],
    exports: [],
    rules: [],
    scripts: [],
    workflows: [],
  };
  const diag = new Diagnostics();
  const ctx: ValidatorCtx = {
    diag,
    ast,
    refCtx: {
      importsByAlias: new Map(),
      importedAstCache: new Map(),
      localRules: new Set(),
      localWorkflows: new Set(),
      localScripts: new Set(),
    },
    scope: WORKFLOW_SCOPE,
    knownVars: new Set(),
    promptSchemas: new Map(),
    promptCaptures: new Set(),
    recoverBindings: undefined,
    localChannels: new Set(),
    localScripts: new Set(),
    localWorkflows: new Set(),
    importsByAlias: new Map(),
    importedAstCache: new Map(),
  };

  const syntheticStep = {
    type: "ZZZ_synthetic_step_type",
    loc: { line: 42, col: 7 },
  } as unknown as WorkflowStepDef;

  diag.capture(() => validateStep(syntheticStep, ctx));
  const errs = diag.sorted();
  assert.equal(errs.length, 1, `expected exactly one diagnostic, got ${JSON.stringify(errs)}`);
  assert.equal(errs[0].code, "E_VALIDATE");
  assert.equal(errs[0].line, 42);
  assert.equal(errs[0].col, 7);
  assert.match(errs[0].message, /^internal: no validator for step type "ZZZ_synthetic_step_type"$/);
});

test("AC4: same synthetic step type is rejected in RULE_SCOPE too (scope-independent fallback)", () => {
  const ast: jaiphModule = {
    filePath: "/synthetic.jh",
    imports: [],
    channels: [],
    exports: [],
    rules: [],
    scripts: [],
    workflows: [],
  };
  const diag = new Diagnostics();
  const ctx: ValidatorCtx = {
    diag,
    ast,
    refCtx: {
      importsByAlias: new Map(),
      importedAstCache: new Map(),
      localRules: new Set(),
      localWorkflows: new Set(),
      localScripts: new Set(),
    },
    scope: RULE_SCOPE,
    knownVars: new Set(),
    promptSchemas: new Map(),
    promptCaptures: new Set(),
    recoverBindings: undefined,
    localChannels: new Set(),
    localScripts: new Set(),
    localWorkflows: new Set(),
    importsByAlias: new Map(),
    importedAstCache: new Map(),
  };
  const syntheticStep = {
    type: "ZZZ_synthetic_step_type",
    loc: { line: 3, col: 1 },
  } as unknown as WorkflowStepDef;

  diag.capture(() => validateStep(syntheticStep, ctx));
  const errs = diag.sorted();
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /^internal: no validator for step type "ZZZ_synthetic_step_type"$/);
});
