#!/usr/bin/env node
// Run from project root after: npm run build
// Usage: node scripts/run-golden-check.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const { transpileFile } = require("../dist/src/transpiler.js");

function normalize(text) {
  return text.replace(/\r\n/g, "\n").trimEnd();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jaiph-golden-check-"));
try {
  const input = path.join(root, "entry.jh");
  fs.writeFileSync(
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
    ].join("\n"),
  );
  const actual = normalize(transpileFile(input, root).module);
  const expected = normalize(
    [
      "#!/usr/bin/env bash",
      "",
      "set -euo pipefail",
      'jaiph_stdlib_path="${JAIPH_STDLIB:-$HOME/.local/bin/jaiph_stdlib.sh}"',
      'if [[ ! -f "$jaiph_stdlib_path" ]]; then',
      '  echo "jaiph: stdlib not found at $jaiph_stdlib_path (set JAIPH_STDLIB or reinstall jaiph)" >&2',
      "  exit 1",
      "fi",
      'source "$jaiph_stdlib_path"',
      'if [[ "$(jaiph__runtime_api)" != "1" ]]; then',
      '  echo "jaiph: incompatible jaiph stdlib runtime (required api=1)" >&2',
      "  exit 1",
      "fi",
      "",
      "entry::rule::ok::impl() {",
      "  set -eo pipefail",
      "  set +u",
      "  echo ok",
      "}",
      "",
      "entry::rule::ok() {",
      '  jaiph::run_step entry::rule::ok jaiph::execute_readonly entry::rule::ok::impl "$@"',
      "}",
      "",
      "entry::workflow::default::impl() {",
      "  set -eo pipefail",
      "  set +u",
      "  entry::rule::ok",
      "  echo done",
      "}",
      "",
      "entry::workflow::default() {",
      '  jaiph::run_step entry::workflow::default entry::workflow::default::impl "$@"',
      "}",
    ].join("\n"),
  );
  if (actual === expected) {
    console.log("OK: Golden output matches expected.");
    process.exit(0);
  }
  console.log("MISMATCH:");
  console.log("--- ACTUAL ---");
  console.log(actual);
  console.log("--- EXPECTED ---");
  console.log(expected);
  process.exit(1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
