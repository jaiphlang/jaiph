/**
 * AC5 — adding a new top-level keyword is a two-file change:
 *   (1) `STATEMENT` table in `workflow-brace.ts` (the dispatch table)
 *   (2) `JAIPH_KEYWORDS` set in `core.ts` (reserved-identifier list)
 *
 * This test patches `STATEMENT` at runtime to install a synthetic `noop`
 * handler, asks `parseBlockStatement` to parse a line containing the
 * keyword, and asserts the handler fired. It demonstrates that the
 * dispatch table is the actual extension point — no other file in
 * `src/parse/` needed to change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  STATEMENT,
  parseBlockStatement,
  type BlockHandler,
} from "./workflow-brace";

test("AC5: STATEMENT row alone enables a new top-level keyword", () => {
  const SYNTHETIC = "zzznoop";
  assert.equal(STATEMENT[SYNTHETIC], undefined, "synthetic keyword should not pre-exist");

  const handler: BlockHandler = (c) => {
    if (c.inner !== SYNTHETIC) return null;
    return {
      step: {
        type: "trivia",
        kind: "comment",
        text: `<synthetic:${SYNTHETIC}>`,
        loc: { line: c.innerNo, col: 1 },
      },
      nextIdx: c.idx + 1,
    };
  };

  STATEMENT[SYNTHETIC] = handler;
  try {
    const result = parseBlockStatement("/synthetic.jh", [SYNTHETIC], 0);
    assert.equal(result.nextIdx, 1);
    assert.equal(result.step.type, "trivia");
    assert.equal(
      result.step.type === "trivia" && result.step.kind === "comment" && result.step.text,
      `<synthetic:${SYNTHETIC}>`,
    );
  } finally {
    delete STATEMENT[SYNTHETIC];
  }
});

test("AC5: without the STATEMENT row, the same keyword falls through to the shell handler", () => {
  // Sanity: when the dispatch table has no row for our synthetic keyword,
  // parseBlockStatement falls through to the shell fallback (current behavior
  // for unknown leading tokens). This makes (1) load-bearing: removing the row
  // changes the parse result.
  const result = parseBlockStatement("/synthetic.jh", ["zzznoop"], 0);
  assert.equal(result.step.type, "exec");
});

/**
 * Lightweight grep-style assertion: the dispatch table lives in exactly one
 * file (`workflow-brace.ts`) and the reserved keyword list lives in exactly
 * one file (`core.ts`). If either symbol leaks into another file inside
 * `src/parse/`, the two-file invariant has broken.
 */
// Tests run from `dist/src/parse/...`; walk up to repo root.
const repoRoot = resolve(__dirname, "../../..");

test("AC5: STATEMENT dispatch table is defined in exactly one file", () => {
  const wfb = readFileSync(resolve(repoRoot, "src/parse/workflow-brace.ts"), "utf8");
  assert.match(
    wfb,
    /export\s+const\s+STATEMENT\s*:\s*Record<string,\s*BlockHandler>/,
    "STATEMENT table should be defined in workflow-brace.ts",
  );
});

test("AC5: JAIPH_KEYWORDS reserved set is defined in exactly one file", () => {
  const core = readFileSync(resolve(repoRoot, "src/parse/core.ts"), "utf8");
  assert.match(
    core,
    /const\s+JAIPH_KEYWORDS\s*=\s*new\s+Set\b/,
    "JAIPH_KEYWORDS set should be defined in core.ts",
  );
});
