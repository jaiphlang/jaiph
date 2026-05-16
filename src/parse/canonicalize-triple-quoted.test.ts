import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { parsejaiph } from "../parser";
import {
  canonicalizeTripleQuotedString,
  tripleQuoteBodyToRaw,
} from "./triple-quote";
import { dedentCommonLeadingWhitespace } from "./dedent";
import type { Expr, WorkflowStepDef } from "../types";

// Tests run from dist/src/parse/, so repo root is three levels up.
const repoRoot = resolve(__dirname, "../../..");

/**
 * Verbatim copy of the pre-move `tripleQuotedRawForRuntime` (the helper that
 * lived in `src/runtime/orchestration-text.ts`). Used as the parity baseline:
 * the new parser-side `canonicalizeTripleQuotedString` must produce bit-for-bit
 * identical output for every triple-quoted match-arm body in the corpus.
 */
function legacyTripleQuotedRawForRuntime(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return tripleQuoteBodyToRaw(dedentCommonLeadingWhitespace(inner));
}

function listJhFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...listJhFiles(abs));
      continue;
    }
    if (entry.endsWith(".jh") || entry.endsWith(".test.jh")) out.push(abs);
  }
  return out;
}

function collectTripleQuotedArmBodies(expr: Expr, bodies: string[]): void {
  if (expr.kind === "match") {
    for (const arm of expr.match.arms) {
      if (arm.tripleQuotedBody) bodies.push(arm.body);
    }
  }
}

function walkSteps(steps: WorkflowStepDef[], bodies: string[]): void {
  for (const s of steps) {
    if (s.type === "const" || s.type === "return") {
      collectTripleQuotedArmBodies(s.value, bodies);
    } else if (s.type === "send") {
      collectTripleQuotedArmBodies(s.value, bodies);
    } else if (s.type === "exec") {
      collectTripleQuotedArmBodies(s.body, bodies);
      if (s.catch) walkSteps("single" in s.catch ? [s.catch.single] : s.catch.block, bodies);
      if (s.recover) walkSteps("single" in s.recover ? [s.recover.single] : s.recover.block, bodies);
    } else if (s.type === "if") {
      walkSteps(s.body, bodies);
    } else if (s.type === "for_lines") {
      walkSteps(s.body, bodies);
    }
  }
}

test("AC2: canonicalizeTripleQuotedString matches pre-move tripleQuotedRawForRuntime bit-for-bit on every fixture", () => {
  const roots = [join(repoRoot, "test-fixtures"), join(repoRoot, "examples")];
  const files: string[] = [];
  for (const r of roots) {
    try {
      files.push(...listJhFiles(r));
    } catch {
      // root missing in this checkout — skip.
    }
  }
  assert.ok(files.length > 0, "expected to discover .jh fixtures under test-fixtures/ and examples/");

  let armCount = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    let ast;
    try {
      ast = parsejaiph(source, file);
    } catch {
      // Fixtures that intentionally fail to parse (e.g. parse-error corpus) are out of scope.
      continue;
    }
    const bodies: string[] = [];
    for (const w of ast.workflows) walkSteps(w.steps, bodies);
    for (const r of ast.rules) walkSteps(r.steps, bodies);
    for (const body of bodies) {
      armCount += 1;
      assert.equal(
        canonicalizeTripleQuotedString(body),
        legacyTripleQuotedRawForRuntime(body),
        `${file}: canonical form drifted from pre-move tripleQuotedRawForRuntime`,
      );
    }
  }
  assert.ok(
    armCount > 0,
    "expected at least one triple-quoted match-arm body across the fixture corpus",
  );
});
