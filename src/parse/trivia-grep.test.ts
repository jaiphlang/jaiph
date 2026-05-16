import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

// Tests run from dist/src/parse/, so repo root is three levels up.
const repoRoot = resolve(__dirname, "../../..");

/** Validator and emitter source files that must not reference Trivia. */
const PROTECTED_FILES = [
  "src/transpile/validate.ts",
  "src/transpile/validate-string.ts",
  "src/transpile/validate-prompt-schema.ts",
  "src/transpile/validate-ref-resolution.ts",
  "src/transpile/validate-substitution.ts",
  "src/transpile/validate-match.test.ts",
  "src/transpile/emit-script.ts",
  "src/transpile/emit-from-graph.ts",
];

test("AC2: validator and emitter sources do not import Trivia", () => {
  for (const rel of PROTECTED_FILES) {
    const abs = join(repoRoot, rel);
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      // File doesn't exist in this checkout — skip rather than fail.
      continue;
    }
    // No imports from the trivia module.
    assert.equal(
      /from\s+["'][^"']*\/parse\/trivia["']/.test(content),
      false,
      `${rel} imports from parse/trivia — validator/emitter must not read Trivia`,
    );
    // No reference to the Trivia identifier or its node-trivia fields.
    const forbidden = ["Trivia", "createTrivia", "NodeTrivia", "ModuleTrivia"];
    for (const sym of forbidden) {
      // Word boundary on each side.
      const re = new RegExp(`\\b${sym}\\b`);
      assert.equal(
        re.test(content),
        false,
        `${rel} references ${sym} — validator/emitter must not see Trivia`,
      );
    }
  }
});
