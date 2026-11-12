import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Tests run from dist/src/parse/, so repo root is three levels up.
const repoRoot = resolve(__dirname, "../../..");
const parseDir = join(repoRoot, "src/parse");

const parseSources = readdirSync(parseDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
  .map((name) => ({ name, content: readFileSync(join(parseDir, name), "utf8") }));

/**
 * The parser is driven by a `BodyCursor` over the whole source: positions are
 * source offsets and statements are read from tokens (`lex` / `tokenize` in
 * lexer.ts). No parser module splits the source into a line array, passes one
 * around, or indexes into one.
 */
test("parser modules do not split the source into lines", () => {
  const forbidden: Array<[RegExp, string]> = [
    [/\bsource\s*\.\s*split\s*\(/, "source.split("],
    [/\.split\s*\(\s*\/\\r\?\\n\//, "split(/\\r?\\n/)"],
    [/\blines\s*\??\s*:\s*string\s*\[\s*\]/, "a `lines: string[]` parameter or field"],
    [/\bBodyCursor\.endLineIdx\b|\bnextLineIdx\b|\bclosingLineIdx\b/, "a line-index result"],
  ];
  for (const { name, content } of parseSources) {
    if (name === "lexer.ts") continue;
    for (const [re, what] of forbidden) {
      assert.equal(re.test(content), false, `src/parse/${name} uses ${what}`);
    }
  }
});

/**
 * Splitting on newlines is token processing only: a `"""` / `'''` block
 * token's text into its body lines, and a block body for dedenting. Any other
 * file that splits on "\n" is reading the source line by line.
 */
test('parser modules split on "\\n" only to process a block token\'s text', () => {
  const allowed = new Set(["lexer.ts", "triple-quote.ts", "dedent.ts"]);
  const newlineSplit = /\.split\s*\(\s*(?:"\\n"|'\\n'|\/\\n\/)/;
  for (const { name, content } of parseSources) {
    if (allowed.has(name)) continue;
    assert.equal(newlineSplit.test(content), false, `src/parse/${name} splits text on newlines`);
  }
});
