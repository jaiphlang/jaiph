import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src/parse");

/**
 * Files that accept string RHS values with bare-identifier sugar must also
 * accept bare ${name} interpolation refs via isJaiphInterpolationRef.
 * This test fails if a parser adds bare-id handling without the shared helper,
 * preventing drift as new string-RHS sites are added.
 */
const STRING_RHS_FILES = [
  "core.ts",           // parseLogMessageRhs
  "metadata.ts",       // parseMetadataValue
  "prompt.ts",         // parsePromptStep
  "workflow-brace.ts", // tryParseFail
];

test("string-rhs parity: all string-RHS parsers use isJaiphInterpolationRef", () => {
  for (const file of STRING_RHS_FILES) {
    const src = readFileSync(join(SRC, file), "utf8");
    assert.ok(
      src.includes("isJaiphInterpolationRef"),
      `${file} must use isJaiphInterpolationRef for bare \${name} acceptance — add the check or the file no longer handles string RHS`,
    );
  }
});
