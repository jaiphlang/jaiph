import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// Tests run from dist/src/parse/, so repo root is three levels up.
const repoRoot = resolve(__dirname, "../../..");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
        out.push(abs);
      }
    }
  };
  walk(dir);
  return out;
}

const parseSources = listTsFiles(join(repoRoot, "src/parse"));
const transpileSources = listTsFiles(join(repoRoot, "src/transpile"));

/**
 * AC2: no production code under src/parse/ or src/transpile/ may re-parse a
 * call's `args` payload into bare-identifier components. The tokenizer / parser
 * builds `Arg[]` once via `commaArgsToArgList` in `src/parse/core.ts`;
 * downstream consumers walk that typed list directly — no `args.split(",")`,
 * no `bareIdentifierArgs` shadow field, no ad-hoc rescans.
 */
test("AC2: no args re-parse into bare-identifier components outside the tokenizer", () => {
  const forbidden: RegExp[] = [
    /\bargs\.split\s*\(\s*[`'"],/,
    /\bbareIdentifierArgs\b/,
  ];
  for (const file of [...parseSources, ...transpileSources]) {
    const content = readFileSync(file, "utf8");
    for (const re of forbidden) {
      assert.equal(
        re.test(content),
        false,
        `${file} matches forbidden args re-parse pattern ${re}`,
      );
    }
  }
});

/**
 * AC3: `validateBareIdentifierArgs` is deleted. The bare-arg check folds into
 * the per-step validator that already walks the call: each `Arg` of kind
 * `"var"` is resolved against in-scope bindings inline.
 */
test("AC3: validateBareIdentifierArgs does not reappear in src/transpile/", () => {
  for (const file of transpileSources) {
    const content = readFileSync(file, "utf8");
    assert.equal(
      /\bvalidateBareIdentifierArgs\b/.test(content),
      false,
      `${file} references validateBareIdentifierArgs — it must stay deleted`,
    );
  }
});
