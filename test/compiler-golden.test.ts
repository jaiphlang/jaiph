import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, transpileFile, transpileTestFile } from "../src/transpiler";
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
      '  echo "jaiph: stdlib not found at $jaiph_stdlib_path (set JAIPH_STDLIB or reinstall jaiph)" >&2',
      "  exit 1",
      "fi",
      'source "$jaiph_stdlib_path"',
      'if [[ "$(jaiph__runtime_api)" != "1" ]]; then',
      '  echo "jaiph: incompatible jaiph stdlib runtime (required api=1)" >&2',
      "  exit 1",
      "fi",
      "exec 7>&1",
      "export JAIPH_STDOUT_SAVED=1",
      "",
      "entry::ok::impl() {",
      "  set -eo pipefail",
      "  set +u",
      "  echo ok",
      "}",
      "",
      "entry::ok() {",
      '  jaiph::run_step entry::ok rule jaiph::execute_readonly entry::ok::impl "$@"',
      "}",
      "",
      "entry::default::impl() {",
      "  set -eo pipefail",
      "  set +u",
      "  jaiph::emit_workflow_summary_event WORKFLOW_START 'default'",
      "  entry::ok",
      "  echo done",
      "  jaiph::emit_workflow_summary_event WORKFLOW_END 'default'",
      "}",
      "",
      "entry::default() {",
      '  jaiph::run_step entry::default workflow entry::default::impl "$@"',
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

test("parser: config integer value parses as number", () => {
  const source = [
    "config {",
    "  runtime.docker_timeout = 300",
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.metadata);
  assert.strictEqual(mod.metadata!.runtime?.dockerTimeout, 300);
  assert.strictEqual(typeof mod.metadata!.runtime?.dockerTimeout, "number");
});

test("parser: config integer key rejects string value with E_PARSE", () => {
  const source = [
    "config {",
    '  runtime.docker_timeout = "fast"',
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /runtime\.docker_timeout must be an integer/,
  );
});

test("parser: config array value parses multi-line array", () => {
  const source = [
    "config {",
    "  runtime.workspace = [",
    '    ".:/jaiph/workspace:rw",',
    '    "config:config:ro"',
    "  ]",
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.metadata);
  assert.deepStrictEqual(mod.metadata!.runtime?.workspace, [
    ".:/jaiph/workspace:rw",
    "config:config:ro",
  ]);
});

test("parser: config empty array parses as empty string[]", () => {
  const source = [
    "config {",
    "  runtime.workspace = []",
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.metadata);
  assert.deepStrictEqual(mod.metadata!.runtime?.workspace, []);
});

test("parser: config array with trailing commas and comments", () => {
  const source = [
    "config {",
    "  runtime.workspace = [",
    '    ".:/jaiph/workspace:rw",  # main workspace',
    '    "config:config:ro",',
    "    # another comment",
    "  ]",
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.deepStrictEqual(mod.metadata!.runtime?.workspace, [
    ".:/jaiph/workspace:rw",
    "config:config:ro",
  ]);
});

test("parser: config array key rejects non-array value with E_PARSE", () => {
  const source = [
    "config {",
    '  runtime.workspace = "not-an-array"',
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /runtime\.workspace must be an array of strings/,
  );
});

test("parser: all runtime config keys are accepted", () => {
  const source = [
    "config {",
    "  runtime.docker_enabled = true",
    '  runtime.docker_image = "ubuntu:24.04"',
    '  runtime.docker_network = "host"',
    "  runtime.docker_timeout = 600",
    "  runtime.workspace = [",
    '    ".:/jaiph/workspace:rw"',
    "  ]",
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.metadata?.runtime);
  assert.strictEqual(mod.metadata!.runtime!.dockerEnabled, true);
  assert.strictEqual(mod.metadata!.runtime!.dockerImage, "ubuntu:24.04");
  assert.strictEqual(mod.metadata!.runtime!.dockerNetwork, "host");
  assert.strictEqual(mod.metadata!.runtime!.dockerTimeout, 600);
  assert.deepStrictEqual(mod.metadata!.runtime!.workspace, [".:/jaiph/workspace:rw"]);
});

test("parser: unknown runtime key throws E_PARSE", () => {
  const source = [
    "config {",
    '  runtime.unknown_key = "x"',
    "}",
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /unknown config key: runtime\.unknown_key/,
  );
});

test("parser: positive if ensure parses into if step", () => {
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
  assert.equal(steps[0].type, "if");
  const step = steps[0] as { type: "if"; negated: boolean; condition: { kind: "ensure"; ref: { value: string } }; thenSteps: unknown[] };
  assert.equal(step.negated, false);
  assert.equal(step.condition.kind, "ensure");
  assert.equal(step.condition.ref.value, "ready");
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
    type: "if";
    negated: boolean;
    condition: { kind: "ensure"; ref: { value: string }; args?: string };
  };
  assert.equal(step.type, "if");
  assert.equal(step.negated, false);
  assert.equal(step.condition.ref.value, "check");
  assert.equal(step.condition.args, "foo=bar baz");
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
    type: "if";
    negated: boolean;
    condition: { kind: "ensure"; ref: { value: string }; args?: string };
  };
  assert.equal(step.type, "if");
  assert.equal(step.negated, true);
  assert.equal(step.condition.args, "foo=bar");
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
    type: "if";
    negated: boolean;
    thenSteps: unknown[];
    elseSteps?: unknown[];
  };
  assert.equal(step.type, "if");
  assert.equal(step.negated, false);
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
    type: "if";
    negated: boolean;
    thenSteps: unknown[];
    elseSteps?: unknown[];
  };
  assert.equal(step.type, "if");
  assert.equal(step.negated, true);
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
    assert.match(actual, /if entry::ready foo=bar; then/);
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
    assert.match(actual, /if entry::ready; then/);
    assert.match(actual, /echo yes/);
    assert.match(actual, /else/);
    assert.match(actual, /entry::fallback/);
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
    assert.match(actual, /if ! entry::check myarg; then/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: negated if-run transpiles workflow ref, not raw DSL tokens", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-not-run-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "workflow check {",
        "  true",
        "}",
        "workflow recovery {",
        "  echo recovering",
        "}",
        "workflow default {",
        "  if ! run check; then",
        '    prompt "fix things"',
        "    run recovery",
        "  fi",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /if ! entry::check; then/);
    assert.match(actual, /entry::recovery/);
    assert.doesNotMatch(actual, /\brun check\b/);
    assert.doesNotMatch(actual, /\brun recovery\b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: positive if-run transpiles workflow ref", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-pos-run-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "workflow check {",
        "  true",
        "}",
        "workflow default {",
        "  if run check; then",
        "    echo passed",
        "  fi",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /if entry::check; then/);
    assert.match(actual, /echo passed/);
    assert.doesNotMatch(actual, /\brun check\b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: if-run with imported workflow ref", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-run-import-"));
  try {
    const libFile = join(root, "lib.jh");
    writeFileSync(
      libFile,
      [
        "workflow healthcheck {",
        "  true",
        "}",
        "",
      ].join("\n"),
    );
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'import "lib.jh" as lib',
        "workflow default {",
        "  if ! run lib.healthcheck; then",
        "    echo service down",
        "  fi",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /if ! [a-z0-9_]+::healthcheck; then/);
    assert.match(actual, /echo service down/);
    assert.doesNotMatch(actual, /\brun lib\.healthcheck\b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: if-run with args transpiles correctly", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-run-args-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "workflow check {",
        "  true",
        "}",
        "workflow default {",
        "  if ! run check foo=bar; then",
        "    echo fallback",
        "  fi",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /if ! entry::check foo=bar; then/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: if-run with else branch transpiles correctly", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-run-else-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "workflow check {",
        "  true",
        "}",
        "workflow default {",
        "  if run check; then",
        "    echo success",
        "  else",
        "    echo failure",
        "  fi",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /if entry::check; then/);
    assert.match(actual, /echo success/);
    assert.match(actual, /else/);
    assert.match(actual, /echo failure/);
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
    assert.ok(actual.includes("entry::ok"));
    assert.ok(actual.includes("entry::default"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// === Inbox / send operator / on route tests ===

test("parser: send operator parses channel <- echo", () => {
  const source = [
    "workflow default {",
    "  findings <- echo 'hello'",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows[0].steps.length, 1);
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "send");
  assert.equal((step as { type: "send"; command: string }).command, "echo 'hello'");
  assert.equal((step as { type: "send"; channel: string }).channel, "findings");
});

test("parser: top-level channel declarations parse and are stored", () => {
  const source = [
    "channel findings",
    "channel report",
    "workflow analyst {",
    "  echo ok",
    "}",
    "workflow default {",
    "  findings <- echo hi",
    "  report -> analyst",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.deepStrictEqual(mod.channels.map((c) => c.name), ["findings", "report"]);
  const defaultWf = mod.workflows.find((w) => w.name === "default")!;
  assert.equal(defaultWf.steps.length, 1);
  assert.equal(defaultWf.steps[0].type, "send");
  assert.ok(defaultWf.routes);
  assert.equal(defaultWf.routes![0].channel, "report");
});

test("parser: channel declaration must be single per line", () => {
  const source = [
    "channel findings, report",
    "workflow default {",
    "  findings <- echo hi",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /invalid channel declaration; expected exactly: channel <name>/,
  );
});

test("validator: unknown local channel fails with required message", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-validate-channel-local-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "workflow analyst {",
        "  echo ok",
        "}",
        "workflow default {",
        "  typo <- echo x",
        "  typo -> analyst",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => transpileFile(input, root),
      /E_VALIDATE Channel "typo" is not defined/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validator: missing channel import fails with required message", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-validate-channel-import-"));
  try {
    const shared = join(root, "shared.jh");
    writeFileSync(
      shared,
      [
        "channel findings",
        "workflow analyst {",
        "  echo ok",
        "}",
        "",
      ].join("\n"),
    );
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'import "shared.jh" as shared',
        "workflow default {",
        "  shared.typo <- echo x",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => transpileFile(input, root),
      /E_VALIDATE Channel "shared\.typo" is not defined/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parser: standalone channel <- forwards $1", () => {
  const source = [
    "workflow default {",
    "  findings <-",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows[0].steps.length, 1);
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "send");
  assert.equal((step as { type: "send"; command: string }).command, "");
  assert.equal((step as { type: "send"; channel: string }).channel, "findings");
});

test("parser: <- inside quotes is not a send", () => {
  const source = [
    "workflow default {",
    '  echo "a <- b"',
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows[0].steps.length, 1);
  assert.equal(mod.workflows[0].steps[0].type, "shell");
});

test("parser: route declaration parses into routes", () => {
  const source = [
    "workflow analyst {",
    "  echo ok",
    "}",
    "workflow default {",
    "  findings -> analyst",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const defaultWf = mod.workflows.find((w) => w.name === "default")!;
  assert.equal(defaultWf.steps.length, 0);
  assert.ok(defaultWf.routes);
  assert.equal(defaultWf.routes!.length, 1);
  assert.equal(defaultWf.routes![0].channel, "findings");
  assert.equal(defaultWf.routes![0].workflows.length, 1);
  assert.equal(defaultWf.routes![0].workflows[0].value, "analyst");
});

test("parser: route with multiple targets", () => {
  const source = [
    "workflow a {",
    "  echo ok",
    "}",
    "workflow b {",
    "  echo ok",
    "}",
    "workflow default {",
    "  findings -> a, b",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const defaultWf = mod.workflows.find((w) => w.name === "default")!;
  assert.ok(defaultWf.routes);
  assert.equal(defaultWf.routes![0].workflows.length, 2);
  assert.equal(defaultWf.routes![0].workflows[0].value, "a");
  assert.equal(defaultWf.routes![0].workflows[1].value, "b");
});

test("parser: capture + send is E_PARSE", () => {
  const source = [
    "workflow default {",
    "  name = channel <- echo hello",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /capture and send cannot be combined/,
  );
});

test("compiler golden: send operator transpiles to jaiph::send", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-send-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "channel channel",
        "workflow default {",
        "  channel <- echo 'foo'",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /jaiph::send 'channel' "\$\(echo 'foo'\)"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: standalone send transpiles to jaiph::send with $1", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-send-standalone-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "channel channel",
        "workflow default {",
        "  channel <-",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /jaiph::send 'channel' "\$1"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: imported channel ref transpiles as channel key", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-send-imported-channel-"));
  try {
    const shared = join(root, "shared.jh");
    writeFileSync(
      shared,
      [
        "channel findings",
        "workflow analyst {",
        "  echo ok",
        "}",
        "",
      ].join("\n"),
    );
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'import "shared.jh" as shared',
        "workflow default {",
        "  shared.findings <- echo 'foo'",
        "  shared.findings -> shared.analyst",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /jaiph::send 'shared\.findings' "\$\(echo 'foo'\)"/);
    assert.match(actual, /jaiph::register_route 'shared\.findings' 'shared::analyst'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: route emits register_route and drain_queue", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-route-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "channel findings",
        "workflow analyst {",
        "  echo ok",
        "}",
        "workflow default {",
        "  findings -> analyst",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /jaiph::inbox_init/);
    assert.match(actual, /jaiph::register_route 'findings' 'entry::analyst'/);
    assert.match(actual, /jaiph::drain_queue/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: multi-target route emits multiple funcs in register_route", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-route-multi-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "channel findings",
        "workflow a {",
        "  echo ok",
        "}",
        "workflow b {",
        "  echo ok",
        "}",
        "workflow default {",
        "  findings -> a, b",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /jaiph::register_route 'findings' 'entry::a' 'entry::b'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: inbox.jh fixture compiles successfully", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-inbox-fixture-"));
  try {
    const input = join(root, "inbox.jh");
    writeFileSync(
      input,
      [
        "channel findings",
        "channel summary",
        "channel final_summary",
        "",
        "workflow researcher {",
        "  findings <- echo '## findings'",
        "}",
        "",
        "workflow analyst {",
        '  echo "$1" > findings_file.md',
        '  summary = echo "Summary of findings"',
        '  summary <- echo "$summary"',
        "}",
        "",
        "workflow reviewer {",
        '  final_summary <- echo "[reviewed] $1"',
        "}",
        "",
        "workflow default {",
        "  run researcher",
        "  findings -> analyst",
        "  summary -> reviewer",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root));
    // researcher workflow sends to findings
    assert.match(actual, /jaiph::send 'findings'/);
    // analyst workflow sends to summary
    assert.match(actual, /jaiph::send 'summary'/);
    // reviewer workflow sends to final_summary
    assert.match(actual, /jaiph::send 'final_summary'/);
    // default workflow registers routes and drains
    assert.match(actual, /jaiph::inbox_init/);
    assert.match(actual, /jaiph::register_route 'findings' 'inbox::analyst'/);
    assert.match(actual, /jaiph::register_route 'summary' 'inbox::reviewer'/);
    assert.match(actual, /jaiph::drain_queue/);
    // default workflow runs researcher
    assert.match(actual, /inbox::researcher/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// === Top-level local (env declaration) tests ===

test("parser: top-level local declaration parses single-line string", () => {
  const source = [
    'local greeting = "hello world"',
    "workflow default {",
    "  echo $greeting",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.envDecls);
  assert.equal(mod.envDecls!.length, 1);
  assert.equal(mod.envDecls![0].name, "greeting");
  assert.equal(mod.envDecls![0].value, "hello world");
});

test("parser: top-level local declaration parses multi-line string", () => {
  const source = [
    'local role = "You are an expert.',
    "    1. You write clearly",
    '    2. You are concise"',
    "workflow default {",
    "  echo $role",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.envDecls);
  assert.equal(mod.envDecls!.length, 1);
  assert.equal(mod.envDecls![0].name, "role");
  assert.ok(mod.envDecls![0].value.includes("You are an expert."));
  assert.ok(mod.envDecls![0].value.includes("You are concise"));
});

test("parser: top-level local declaration parses bare value", () => {
  const source = [
    "local count = 42",
    "workflow default {",
    "  echo $count",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.envDecls);
  assert.equal(mod.envDecls![0].name, "count");
  assert.equal(mod.envDecls![0].value, "42");
});

test("parser: top-level local name collision with rule is E_PARSE", () => {
  const source = [
    'local foo = "bar"',
    "rule foo {",
    "  echo ok",
    "}",
    "workflow default {",
    "  ensure foo",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /duplicate name "foo".*variable name collides with rule/,
  );
});

test("parser: top-level local name collision with workflow is E_PARSE", () => {
  const source = [
    'local default = "val"',
    "workflow default {",
    "  echo ok",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /duplicate name "default".*variable name collides with workflow/,
  );
});

test("parser: top-level local name collision with function is E_PARSE", () => {
  const source = [
    'local helper = "val"',
    "function helper {",
    "  echo ok",
    "}",
    "workflow default {",
    "  helper",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /duplicate name "helper".*variable name collides with function/,
  );
});

test("compiler golden: top-level local emits prefixed variable and shims", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-env-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'local greeting = "hello world"',
        "",
        "rule check {",
        "  echo $greeting",
        "}",
        "",
        "function helper() {",
        "  echo $greeting",
        "}",
        "",
        "workflow default {",
        "  ensure check",
        "  run helper",
        "  echo $greeting",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root));
    // Exported prefixed variable at top (export needed for child-shell rule sandbox)
    assert.match(actual, /export entry__greeting="hello world"/);
    // Local shims in rule impl
    assert.match(actual, /entry::check::impl\(\) \{[\s\S]*?local greeting="\$entry__greeting"/);
    // Local shims in function impl
    assert.match(actual, /entry::helper::impl\(\) \{[\s\S]*?local greeting="\$entry__greeting"/);
    // Local shims in workflow impl
    assert.match(actual, /entry::default::impl\(\) \{[\s\S]*?local greeting="\$entry__greeting"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: top-level local $sibling is expanded in export (set -u safe)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-env-cross-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'local shared = "MIDDLE"',
        'local combined = "before $shared after"',
        "",
        "workflow default {",
        "  echo $combined",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /export entry__shared="MIDDLE"/);
    assert.match(actual, /export entry__combined="before MIDDLE after"/);
    assert.ok(!/export entry__combined="[^"]*\$shared/.test(actual));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// === ensure...recover golden tests ===

test("compiler golden: ensure...recover single statement emits retry loop", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-recover-single-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "rule tests_pass {",
        "  test -f results.txt",
        "}",
        "",
        "workflow fix_tests {",
        "  echo fixing",
        "}",
        "",
        "workflow default {",
        "  ensure tests_pass recover run fix_tests",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root));
    // Retry loop structure
    assert.match(actual, /local _jaiph_ensure_passed=0/);
    assert.match(actual, /for _jaiph_retry in \$\(seq 1/);
    assert.match(actual, /JAIPH_RETURN_VALUE_FILE="\$_jaiph_ensure_rv_file" entry::tests_pass; then/);
    assert.match(actual, /_jaiph_ensure_passed=1/);
    assert.match(actual, /break/);
    // Recover step calls the workflow
    assert.match(actual, /entry::fix_tests/);
    // Failure message after max retries
    assert.match(actual, /ensure condition did not pass after/);
    assert.match(actual, /exit 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: ensure...recover block emits retry loop with multiple steps", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-recover-block-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "rule ci_pass {",
        "  test -f ci_ok.txt",
        "}",
        "",
        "workflow fix_ci {",
        "  echo fixing ci",
        "}",
        "",
        "workflow default {",
        "  ensure ci_pass recover {",
        "    run fix_ci",
        "    echo retrying",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root));
    // Retry loop
    assert.match(actual, /for _jaiph_retry in \$\(seq 1/);
    assert.match(actual, /JAIPH_RETURN_VALUE_FILE="\$_jaiph_ensure_rv_file" entry::ci_pass; then/);
    // Both recover steps present
    assert.match(actual, /entry::fix_ci/);
    assert.match(actual, /echo retrying/);
    // Loop end + failure guard
    assert.match(actual, /done/);
    assert.match(actual, /if \[{2} "\$_jaiph_ensure_passed" -ne 1 \]{2}; then/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// === if_not_shell_then golden test ===

test("compiler golden: if ! <shell_cmd>; then emits correct bash conditional", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-not-shell-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "workflow setup {",
        "  echo setting up",
        "}",
        "",
        "workflow default {",
        '  if ! test -f config.yml; then',
        "    echo creating config",
        "    run setup",
        "  fi",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /if ! test -f config\.yml; then/);
    assert.match(actual, /echo creating config/);
    assert.match(actual, /entry::setup/);
    assert.match(actual, /fi/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// === if_not_ensure_then_shell golden test ===

test("compiler golden: if ! ensure with only shell commands emits if_not_ensure_then_shell", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-not-ensure-shell-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "rule config_exists {",
        "  test -f config.yml",
        "}",
        "",
        "workflow default {",
        "  if ! ensure config_exists; then",
        "    echo creating default config",
        "    touch config.yml",
        "  fi",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root));
    assert.match(actual, /if ! entry::config_exists; then/);
    assert.match(actual, /echo creating default config/);
    assert.match(actual, /touch config\.yml/);
    assert.match(actual, /fi/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// === prompt with returns golden test ===

test("compiler golden: prompt with returns schema emits prompt_capture_with_schema and schema env vars", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-prompt-returns-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "workflow default {",
        "  result = prompt \"Analyse the diff\" returns '{ category: string, risk: boolean }'",
        "  echo $result",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root));
    // Schema-specific capture function
    assert.match(actual, /jaiph::prompt_capture_with_schema/);
    // Schema exported as env var
    assert.match(actual, /JAIPH_PROMPT_SCHEMA/);
    // Capture name exported
    assert.match(actual, /JAIPH_PROMPT_CAPTURE_NAME='result'/);
    // Preview exported
    assert.match(actual, /JAIPH_PROMPT_PREVIEW/);
    // Heredoc delimiter
    assert.match(actual, /<<__JAIPH_PROMPT_/);
    // Schema suffix appended to prompt body
    assert.match(actual, /Respond with exactly one line of valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// === test_mock_prompt_block dispatch script golden test ===

test("compiler golden: mock prompt block emits if/elif/else dispatch script structure", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-mock-dispatch-"));
  try {
    writeFileSync(
      join(root, "w.jh"),
      [
        "workflow default {",
        '  result = prompt "question"',
        '  echo "$result"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "w.test.jh"),
      [
        'import "w.jh" as w',
        "",
        'test "dispatch test" {',
        "  mock prompt {",
        '    if $1 contains "greeting" ; then',
        '      respond "hello"',
        '    elif $1 contains "farewell" ; then',
        '      respond "goodbye"',
        "    else",
        '      respond "default"',
        "    fi",
        "  }",
        "  response = w.default",
        '  expectContain response "hello"',
        "}",
        "",
      ].join("\n"),
    );
    const bash = transpileTestFile(join(root, "w.test.jh"), root);
    const normalized = normalize(bash);
    // Dispatch script uses if/elif/else pattern matching
    assert.match(normalized, /if \[\[ "\$prompt" == \*'greeting'\* \]\]; then/);
    assert.match(normalized, /printf '%s' 'hello'/);
    assert.match(normalized, /elif \[\[ "\$prompt" == \*'farewell'\* \]\]; then/);
    assert.match(normalized, /printf '%s' 'goodbye'/);
    assert.match(normalized, /else/);
    assert.match(normalized, /printf '%s' 'default'/);
    assert.match(normalized, /fi/);
    // Dispatch script is set via env var
    assert.match(normalized, /JAIPH_MOCK_DISPATCH_SCRIPT/);
    // Mock responses file is unset when dispatch is used
    assert.match(normalized, /unset JAIPH_MOCK_RESPONSES_FILE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: mock prompt block without else emits error fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-mock-dispatch-noelse-"));
  try {
    writeFileSync(
      join(root, "w.jh"),
      [
        "workflow default {",
        '  prompt "something"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "w.test.jh"),
      [
        'import "w.jh" as w',
        "",
        'test "no else fallback" {',
        "  mock prompt {",
        '    if $1 contains "match" ; then',
        '      respond "found"',
        "    fi",
        "  }",
        "  w.default",
        "}",
        "",
      ].join("\n"),
    );
    const bash = transpileTestFile(join(root, "w.test.jh"), root);
    const normalized = normalize(bash);
    // When no else, should emit error fallback
    assert.match(normalized, /no mock matched prompt/);
    assert.match(normalized, /exit 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: workflow-level config emits per-workflow with_metadata_scope with _LOCKED", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-wfconfig-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "config {",
        '  agent.backend = "cursor"',
        "}",
        "",
        "rule check {",
        "  true",
        "}",
        "",
        "workflow fast {",
        "  config {",
        '    agent.backend = "claude"',
        '    agent.default_model = "gpt-4"',
        "  }",
        "  ensure check",
        "}",
        "",
        "workflow default {",
        "  ensure check",
        "}",
        "",
      ].join("\n"),
    );
    const bash = normalize(transpileFile(input, root));
    // Module-level scope function exists.
    assert.match(bash, /entry::with_metadata_scope\(\)/);
    // Workflow-level scope function for 'fast' exists.
    assert.match(bash, /entry::fast::with_metadata_scope\(\)/);
    // Workflow 'fast' wrapper uses its own scope, not the module one.
    assert.match(bash, /entry::fast::with_metadata_scope jaiph::run_step entry::fast workflow/);
    // Workflow 'default' wrapper uses the module scope (no workflow config).
    assert.match(bash, /entry::with_metadata_scope jaiph::run_step entry::default workflow/);
    // Workflow scope sets _LOCKED to prevent inner module scope from overriding.
    assert.match(bash, /export JAIPH_AGENT_BACKEND_LOCKED="1"/);
    assert.match(bash, /export JAIPH_AGENT_MODEL_LOCKED="1"/);
    // Workflow scope also restores _LOCKED state.
    assert.match(bash, /unset JAIPH_AGENT_BACKEND_LOCKED/);
    assert.match(bash, /unset JAIPH_AGENT_MODEL_LOCKED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: workflow-level config without module config uses workflow scope only", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-wfconfig2-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "workflow default {",
        "  config {",
        '    agent.backend = "claude"',
        "  }",
        '  echo "hello"',
        "}",
        "",
      ].join("\n"),
    );
    const bash = normalize(transpileFile(input, root));
    // No module-level scope function (no module config).
    assert.doesNotMatch(bash, /entry::with_metadata_scope\(\)/);
    // Workflow-level scope function exists.
    assert.match(bash, /entry::default::with_metadata_scope\(\)/);
    // Wrapper uses workflow scope.
    assert.match(bash, /entry::default::with_metadata_scope jaiph::run_step entry::default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
