import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, transpileFile } from "../src/transpiler";
import { parsejaiph } from "../src/parser";

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trimEnd();
}

test("compiler golden: transpileFile emits stable workflow shell", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-transpile-"));
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
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root));
    const expected = normalize(`#!/usr/bin/env bash

set -euo pipefail
jaiph_stdlib_path="\${JAIPH_STDLIB:-$HOME/.local/bin/jaiph_stdlib.sh}"
if [[ ! -f "$jaiph_stdlib_path" ]]; then
  echo "jai: stdlib not found at $jaiph_stdlib_path (set JAIPH_STDLIB or reinstall jaiph)" >&2
  exit 1
fi
source "$jaiph_stdlib_path"
if [[ "$(jaiph__runtime_api)" != "1" ]]; then
  echo "jai: incompatible jaiph stdlib runtime (required api=1)" >&2
  exit 1
fi

entry::rule::ok::impl() {
  set -eo pipefail
  set +u
  echo ok
}

entry::rule::ok() {
  jaiph__run_step entry::rule::ok jaiph__execute_readonly entry::rule::ok::impl "$@"
}

entry::workflow::default::impl() {
  set -eo pipefail
  set +u
  entry::rule::ok
  echo done
}

entry::workflow::default() {
  jaiph__run_step entry::workflow::default entry::workflow::default::impl "$@"
}`);
    assert.equal(actual, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: parser error message is deterministic", () => {
  assert.throws(
    () => parsejaiph("function 123bad {\n  echo x\n}\n", "/fake/main.jh"),
    /\/fake\/main\.jh:1:1 E_PARSE invalid function declaration/,
  );
});

test("compiler golden: prompt substitution guard reports E_PARSE", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-parse-guard-"));
  try {
    const input = join(root, "bad_prompt.jh");
    writeFileSync(
      input,
      [
        "workflow default {",
        '  prompt "Show host $(uname)"',
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(
      () => build(input, join(root, "out")),
      new RegExp(`${input}:2:3 E_PARSE prompt cannot contain command substitution`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler corpus: fixtures and e2e workflows compile", () => {
  const outA = mkdtempSync(join(tmpdir(), "jaiph-corpus-a-"));
  const outB = mkdtempSync(join(tmpdir(), "jaiph-corpus-b-"));
  try {
    const fixtureResults = build(join(process.cwd(), "test/fixtures"), outA);
    const e2eResults = build(join(process.cwd(), "e2e"), outB);
    assert.equal(fixtureResults.length > 0, true);
    assert.equal(e2eResults.length > 0, true);
  } finally {
    rmSync(outA, { recursive: true, force: true });
    rmSync(outB, { recursive: true, force: true });
  }
});
