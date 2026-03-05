#!/usr/bin/env node
// Run from project root after build: npm run build && node scripts/dump-golden-output.js
// Use output to update test/compiler-golden.test.ts expected if golden test fails.
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { transpileFile } = require("../dist/src/transpiler.js");

function normalize(text) {
  return text.replace(/\r\n/g, "\n").trimEnd();
}

const root = mkdtempSync(join(tmpdir(), "jaiph-dump-"));
try {
  const input = join(root, "entry.jh");
  writeFileSync(
    input,
    [
      "rule ok {",
      "  echo ok",
      "}",
      "",
      "workflow default {",
      "  ensure ok",
      "  echo done",
      "}",
      "",
    ].join("\n")
  );
  const actual = normalize(transpileFile(input, root));
  process.stdout.write(actual);
  process.stdout.write("\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
