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

    // Expected must match emit-workflow.ts output exactly (no config, no imports).
    // To refresh after emitter changes: npm run build && node scripts/dump-golden-output.js
    const lines = [
      "#!/usr/bin/env bash",
      "",
      "set -euo pipefail",
      'jaiph_stdlib_path="${JAIPH_STDLIB:-$HOME/.local/bin/jaiph_stdlib.sh}"',
      'if [[ ! -f "$jaiph_stdlib_path" ]]; then',
      '  echo "jai: stdlib not found at $jaiph_stdlib_path (set JAIPH_STDLIB or reinstall jaiph)" >&2',
      "  exit 1",
      "fi",
      'source "$jaiph_stdlib_path"',
      'if [[ "$(jaiph__runtime_api)" != "1" ]]; then',
      '  echo "jai: incompatible jaiph stdlib runtime (required api=1)" >&2',
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
    ];
    const expected = normalize(lines.join("\n"));
    const actual = normalize(transpileFile(input, root));
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
      new RegExp(`${input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:2:\\d+ E_PARSE prompt cannot contain command substitution`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Skip: triggers heap exhaustion (build of fixtures + e2e). TODO: fix memory usage and re-enable.
test.skip("compiler corpus: fixtures and e2e workflows compile", () => {
  const outA = mkdtempSync(join(tmpdir(), "jaiph-corpus-a-"));
  const outB = mkdtempSync(join(tmpdir(), "jaiph-corpus-b-"));
  try {
    assert.equal(build(join(process.cwd(), "test/fixtures"), outA).length > 0, true);
    assert.equal(build(join(process.cwd(), "e2e"), outB).length > 0, true);
  } finally {
    rmSync(outA, { recursive: true, force: true });
    rmSync(outB, { recursive: true, force: true });
  }
});

test("parser: assignment capture parses for ensure, run, and shell steps", () => {
  const source = [
    "rule tests_pass {",
    "  echo ok",
    "}",
    "workflow default {",
    "  response = ensure tests_pass",
    "  out = echo hello",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows.length, 1);
  const steps = mod.workflows[0].steps;
  assert.equal(steps.length, 2);
  assert.equal(steps[0].type, "ensure");
  assert.equal((steps[0] as { type: "ensure"; captureName?: string }).captureName, "response");
  assert.equal(steps[1].type, "shell");
  assert.equal((steps[1] as { type: "shell"; captureName?: string }).captureName, "out");
  assert.equal((steps[1] as { type: "shell"; command: string }).command, "echo hello");
});

test("parser: config block parses and populates mod.metadata", () => {
  const source = [
    "config {",
    '  agent.default_model = "gpt-4"',
    '  run.logs_dir = ".jaiph/runs"',
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.metadata);
  assert.equal(mod.metadata!.agent?.defaultModel, "gpt-4");
  assert.equal(mod.metadata!.run?.logsDir, ".jaiph/runs");
});

test("parser: config agent.backend parses cursor and claude", () => {
  const sourceCursor = [
    "config {",
    '  agent.backend = "cursor"',
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  const modCursor = parsejaiph(sourceCursor, "/fake/entry.jh");
  assert.equal(modCursor.metadata?.agent?.backend, "cursor");

  const sourceClaude = [
    "config {",
    '  agent.backend = "claude"',
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  const modClaude = parsejaiph(sourceClaude, "/fake/entry.jh");
  assert.equal(modClaude.metadata?.agent?.backend, "claude");
});

test("parser: config agent.trusted_workspace parses string", () => {
  const source = [
    "config {",
    '  agent.trusted_workspace = ".jaiph/.."',
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.metadata?.agent?.trustedWorkspace, ".jaiph/..");
});

test("parser: config backend flag strings parse", () => {
  const source = [
    "config {",
    '  agent.cursor_flags = "--force --sandbox enabled"',
    '  agent.claude_flags = "--model sonnet-4"',
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.metadata?.agent?.cursorFlags, "--force --sandbox enabled");
  assert.equal(mod.metadata?.agent?.claudeFlags, "--model sonnet-4");
});

test("parser: invalid agent.backend value throws E_PARSE", () => {
  const source = [
    "config {",
    '  agent.backend = "foo"',
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /agent\.backend must be "cursor" or "claude"/,
  );
});

test("parser: unknown config key throws E_PARSE with file location", () => {
  const source = [
    "config {",
    '  unknown.key = "x"',
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /\/fake\/entry\.jh:2:.* E_PARSE unknown config key/,
  );
});

test("parser: invalid config value throws E_PARSE", () => {
  const source = [
    "config {",
    "  run.debug = yes",
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /\/fake\/entry\.jh:2:.* E_PARSE.*config value must be a quoted string or true\/false/,
  );
});

test("parser: duplicate config block throws E_PARSE", () => {
  const source = [
    "config {",
    '  run.logs_dir = "x"',
    "}",
    "config {",
    '  run.logs_dir = "y"',
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /\/fake\/entry\.jh:4:1 E_PARSE duplicate config block/,
  );
});

test("parser: positive if ensure parses into if_ensure_then step", () => {
  const source = [
    "rule ready {",
    "  true",
    "}",
    "workflow default {",
    '  if ensure ready; then',
    "    echo success",
    "  fi",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const steps = mod.workflows[0].steps;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, "if_ensure_then");
  const step = steps[0] as { type: "if_ensure_then"; ensureRef: { value: string }; thenSteps: unknown[] };
  assert.equal(step.ensureRef.value, "ready");
  assert.equal(step.thenSteps.length, 1);
});

test("parser: positive if ensure with args parses correctly", () => {
  const source = [
    "rule check {",
    "  true",
    "}",
    "workflow default {",
    '  if ensure check foo=bar baz; then',
    "    echo ok",
    "  fi",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as {
    type: "if_ensure_then";
    ensureRef: { value: string };
    args?: string;
  };
  assert.equal(step.type, "if_ensure_then");
  assert.equal(step.ensureRef.value, "check");
  assert.equal(step.args, "foo=bar baz");
});

test("parser: negated if ensure with args parses correctly", () => {
  const source = [
    "rule check {",
    "  true",
    "}",
    "workflow fix {",
    "  echo fix",
    "}",
    "workflow default {",
    '  if ! ensure check foo=bar; then',
    "    run fix",
    "  fi",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[1].steps[0] as {
    type: "if_not_ensure_then_run";
    ensureRef: { value: string };
    args?: string;
  };
  assert.equal(step.type, "if_not_ensure_then_run");
  assert.equal(step.args, "foo=bar");
});

test("parser: if ensure with else branch parses correctly", () => {
  const source = [
    "rule ready {",
    "  true",
    "}",
    "workflow default {",
    '  if ensure ready; then',
    "    echo yes",
    "  else",
    "    echo no",
    "  fi",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as {
    type: "if_ensure_then";
    thenSteps: unknown[];
    elseSteps?: unknown[];
  };
  assert.equal(step.type, "if_ensure_then");
  assert.equal(step.thenSteps.length, 1);
  assert.ok(step.elseSteps);
  assert.equal(step.elseSteps!.length, 1);
});

test("parser: negated if ensure with else branch parses correctly", () => {
  const source = [
    "rule ready {",
    "  true",
    "}",
    "workflow default {",
    '  if ! ensure ready; then',
    "    echo fail",
    "  else",
    "    echo pass",
    "  fi",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as {
    type: "if_not_ensure_then";
    thenSteps: unknown[];
    elseSteps?: unknown[];
  };
  assert.equal(step.type, "if_not_ensure_then");
  assert.equal(step.thenSteps.length, 1);
  assert.ok(step.elseSteps);
  assert.equal(step.elseSteps!.length, 1);
});

test("parser: malformed if ensure emits E_PARSE", () => {
  const source = [
    "workflow default {",
    "  if ensure; then",
    "    echo x",
    "  fi",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /E_PARSE malformed if-ensure statement/,
  );
});

test("compiler golden: positive if ensure with args transpiles correctly", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-ensure-pos-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "rule ready {",
        "  true",
        "}",
        "workflow default {",
        '  if ensure ready foo=bar; then',
        "    echo success",
        "  fi",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /if entry::rule::ready foo=bar; then/);
    assert.match(actual, /echo success/);
    assert.match(actual, /fi/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: positive if ensure with else transpiles correctly", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-ensure-else-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "rule ready {",
        "  true",
        "}",
        "workflow fallback {",
        "  echo fallback",
        "}",
        "workflow default {",
        '  if ensure ready; then',
        "    echo yes",
        "  else",
        "    run fallback",
        "  fi",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /if entry::rule::ready; then/);
    assert.match(actual, /echo yes/);
    assert.match(actual, /else/);
    assert.match(actual, /entry::workflow::fallback/);
    assert.match(actual, /fi/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: negated if ensure with args transpiles correctly", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-not-ensure-args-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "rule check {",
        "  true",
        "}",
        "workflow default {",
        '  if ! ensure check myarg; then',
        "    echo fallback",
        "  fi",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /if ! entry::rule::check myarg; then/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: workflow with config emits JAIPH export defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-metadata-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "config {",
        '  agent.default_model = "gpt-4"',
        '  agent.backend = "claude"',
        '  agent.trusted_workspace = ".jaiph/.."',
        '  agent.cursor_flags = "--force"',
        '  agent.claude_flags = "--model sonnet-4"',
        '  run.logs_dir = ".jaiph/runs"',
        "}",
        "rule ok {",
        "  echo ok",
        "}",
        "workflow default {",
        "  ensure ok",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root));
    assert.ok(actual.includes('export JAIPH_AGENT_MODEL="${JAIPH_AGENT_MODEL:-gpt-4}"'));
    assert.ok(actual.includes('export JAIPH_AGENT_BACKEND="${JAIPH_AGENT_BACKEND:-claude}"'));
    assert.ok(actual.includes('export JAIPH_AGENT_TRUSTED_WORKSPACE="${JAIPH_AGENT_TRUSTED_WORKSPACE:-.jaiph/..}"'));
    assert.ok(actual.includes('export JAIPH_AGENT_CURSOR_FLAGS="${JAIPH_AGENT_CURSOR_FLAGS:---force}"'));
    assert.ok(actual.includes('export JAIPH_AGENT_CLAUDE_FLAGS="${JAIPH_AGENT_CLAUDE_FLAGS:---model sonnet-4}"'));
    assert.ok(actual.includes('export JAIPH_RUNS_DIR="${JAIPH_RUNS_DIR:-.jaiph/runs}"'));
    assert.ok(actual.includes("entry::rule::ok"));
    assert.ok(actual.includes("entry::workflow::default"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
