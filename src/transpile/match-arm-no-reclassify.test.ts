import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// Match-arm bodies are classified exactly once, by the parser (src/parse/), into
// the typed `MatchArmBody` sum. Every downstream consumer must switch on
// `body.kind` rather than re-deriving the kind from a string with a regex or
// `startsWith`. This test fails if any production source *outside* src/parse/
// reintroduces that classification.

// Tests run from dist/src/transpile/, so repo root is three levels up.
const repoRoot = resolve(__dirname, "../../..");
const srcRoot = join(repoRoot, "src");

/** Every non-test `.ts` under `dir`, recursively, as repo-relative paths. */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSources(abs, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Classification signatures that only ever meant "decide the arm-body kind from
 * its text". Each is the exact shape a consumer used before the typed body
 * existed; none has any legitimate use once the kind is carried on the AST.
 */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /startsWith\(["']fail /, why: 'startsWith("fail ") on an arm body' },
  { pattern: /\/\^fail\\?b?\s?\//, why: "/^fail/ regex on an arm body" },
  { pattern: /\(\[A-Za-z_\]\[A-Za-z0-9_\.\]\*\)\\\(/, why: "callee-from-body regex /([A-Za-z_][A-Za-z0-9_.]*)\\(/" },
  { pattern: /arm\.body\.(startsWith|match|trim|slice|includes|endsWith)\(/, why: "string operation on a typed arm.body" },
];

test("match-arm bodies are not re-classified outside src/parse/", () => {
  const sources = collectSources(srcRoot).filter((abs) => !abs.includes(`${join("src", "parse")}`));
  for (const abs of sources) {
    const rel = abs.slice(repoRoot.length + 1);
    const content = readFileSync(abs, "utf8");
    for (const { pattern, why } of FORBIDDEN) {
      assert.equal(
        pattern.test(content),
        false,
        `${rel} re-classifies a match arm body (${why}); switch on body.kind instead`,
      );
    }
  }
});
