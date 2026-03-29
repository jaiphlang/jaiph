import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, transpileFile } from "../transpiler";
import { parsejaiph } from "../parser";

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
        "script f_ok() {",
        "  echo ok",
        "}",
        "",
        "rule ok {",
        "  run f_ok",
        "}",
        "",
        "workflow default {",
        "  ensure ok",
        "  log \"done\"",
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
      'if [[ -z "${JAIPH_RUN_STEP_MODULE:-}" ]]; then',
      '  export JAIPH_RUN_STEP_MODULE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"',
      "fi",
      'export JAIPH_LIB="${JAIPH_LIB:-${JAIPH_WORKSPACE:-.}/.jaiph/lib}"',
      'export JAIPH_SCRIPTS="${JAIPH_SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/scripts" && pwd)}"',
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
      '  jaiph::run_step entry::f_ok script "$JAIPH_SCRIPTS/f_ok"',
      "}",
      "",
      "entry::ok() {",
      '  jaiph::run_step entry::ok rule jaiph::execute_readonly entry::ok::impl "$@"',
      "}",
      "",
      "entry::f_ok() {",
      '  jaiph::run_step entry::f_ok script "$JAIPH_SCRIPTS/f_ok" "$@"',
      "}",
      "",
      "f_ok() {",
      "  entry::f_ok \"$@\"",
      "}",
      "",
      "entry::default::impl() {",
      "  set -eo pipefail",
      "  set +u",
      "  jaiph::emit_workflow_summary_event WORKFLOW_START 'default'",
      "  entry::ok",
      "  jaiph::log \"done\"",
      "  jaiph::emit_workflow_summary_event WORKFLOW_END 'default'",
      "}",
      "",
      "entry::default() {",
      '  jaiph::run_step entry::default workflow entry::default::impl "$@"',
      "}",
      "",
      'if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then',
      "  __jaiph_status=0",
      "  __jaiph_write_meta() {",
      '    local status_value="$1"',
      '    if [[ -n "${JAIPH_META_FILE:-}" ]]; then',
      '      printf "status=%s\\n" "$status_value" > "$JAIPH_META_FILE"',
      '      printf "run_dir=%s\\n" "${JAIPH_RUN_DIR:-}" >> "$JAIPH_META_FILE"',
      '      printf "summary_file=%s\\n" "${JAIPH_RUN_SUMMARY_FILE:-}" >> "$JAIPH_META_FILE"',
      "    fi",
      "  }",
      '  trap \'__jaiph_status=$?; __jaiph_write_meta "$__jaiph_status"\' EXIT',
      '  if [[ "${JAIPH_DEBUG:-}" == "true" ]]; then',
      "    set -x",
      "  fi",
      '  __jaiph_mode="${1:-__jaiph_workflow}"',
      '  case "$__jaiph_mode" in',
      "    __jaiph_dispatch)",
      "      shift",
      '      __jaiph_target="${1:-}"',
      "      shift",
      '      if [[ -z "$__jaiph_target" ]]; then',
      '        echo "jaiph inbox: missing dispatch target" >&2',
      "        exit 1",
      "      fi",
      '      if ! declare -F "$__jaiph_target" >/dev/null; then',
      '        echo "jaiph inbox: unknown dispatch target: $__jaiph_target" >&2',
      "        exit 1",
      "      fi",
      '      "$__jaiph_target" "$@"',
      "      ;;",
      "    __jaiph_workflow)",
      "      shift",
      '      __jaiph_workflow_name="${1:-default}"',
      "      shift",
      '      __jaiph_entrypoint="entry::$__jaiph_workflow_name"',
      '      if ! declare -F "$__jaiph_entrypoint" >/dev/null; then',
      '        if [[ "$__jaiph_workflow_name" == "default" ]]; then',
      '          echo "jaiph run requires workflow \'default\' in the input file" >&2',
      "        else",
      '          echo "jaiph run requires workflow \'$__jaiph_workflow_name\' in the input file" >&2',
      "        fi",
      "        exit 1",
      "      fi",
      '      "$__jaiph_entrypoint" "$@"',
      "      ;;",
      "    *)",
      '      __jaiph_entrypoint="entry::default"',
      '      if ! declare -F "$__jaiph_entrypoint" >/dev/null; then',
      '        echo "jaiph run requires workflow \'default\' in the input file" >&2',
      "        exit 1",
      "      fi",
      '      "$__jaiph_entrypoint" "$@"',
      "      ;;",
      "  esac",
      "fi",
    ];
    const expected = normalize(lines.join("\n"));
    const emitted = transpileFile(input, root);
    const actual = normalize(emitted.module);
    assert.equal(actual, expected);
    const fOkScript = emitted.scripts.find((s) => s.name === "f_ok");
    assert.ok(fOkScript, "expected transpiled script file for f_ok");
    assert.match(fOkScript.content, /set -euo pipefail/);
    assert.doesNotMatch(fOkScript.content, /set \+u/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: parser error message is deterministic", () => {
  assert.throws(
    () => parsejaiph("script 123bad {\n  echo x\n}\n", "/fake/main.jh"),
    /\/fake\/main\.jh:1:1 E_PARSE invalid script declaration/,
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

test("compiler corpus: fixtures compile", () => {
  const outA = mkdtempSync(join(tmpdir(), "jaiph-corpus-a-"));
  try {
    assert.equal(build(join(process.cwd(), "test/fixtures"), outA).length > 0, true);
  } finally {
    rmSync(outA, { recursive: true, force: true });
  }
});

test("compiler corpus: representative e2e workflows compile", () => {
  const outB = mkdtempSync(join(tmpdir(), "jaiph-corpus-b-"));
  try {
    const e2eFiles = [
      join(process.cwd(), "e2e/say_hello.jh"),
      join(process.cwd(), "e2e/assign_capture.jh"),
      join(process.cwd(), "e2e/prompt_returns_run_capture.jh"),
    ];
    for (const file of e2eFiles) {
      assert.equal(build(file, outB).length, 1);
    }
  } finally {
    rmSync(outB, { recursive: true, force: true });
  }
});

test("parser: assignment capture parses for ensure, run, and const run capture", () => {
  const source = [
    "script say_hello() {",
    "  echo hello",
    "}",
    "",
    "rule tests_pass {",
    "  return \"ok\"",
    "}",
    "workflow default {",
    "  response = ensure tests_pass",
    "  const out = run say_hello",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows.length, 1);
  const steps = mod.workflows[0].steps;
  assert.equal(steps.length, 2);
  assert.equal(steps[0].type, "ensure");
  assert.equal((steps[0] as { type: "ensure"; captureName?: string }).captureName, "response");
  assert.equal(steps[1].type, "const");
  const c1 = steps[1] as { type: "const"; name: string; value: { kind: string } };
  assert.equal(c1.name, "out");
  assert.equal(c1.value.kind, "run_capture");
});

test("parser: config block parses and populates mod.metadata", () => {
  const source = [
    "config {",
    '  agent.default_model = "gpt-4"',
    '  run.logs_dir = ".jaiph/runs"',
    "}",
    "workflow default {",
    "  log \"ok\"",
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
    "  log \"ok\"",
    "}",
  ].join("\n");
  const modCursor = parsejaiph(sourceCursor, "/fake/entry.jh");
  assert.equal(modCursor.metadata?.agent?.backend, "cursor");

  const sourceClaude = [
    "config {",
    '  agent.backend = "claude"',
    "}",
    "workflow default {",
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  log \"ok\"",
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
    "  return \"ok\"",
    "}",
    "workflow default {",
    "  if ensure ready {",
    "    log \"success\"",
    "  }",
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
    "  return \"ok\"",
    "}",
    "workflow default {",
    "  if ensure check foo=bar baz {",
    "    log \"ok\"",
    "  }",
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
    "  return \"ok\"",
    "}",
    "workflow fix {",
    "  log \"fix\"",
    "}",
    "workflow default {",
    "  if not ensure check foo=bar {",
    "    run fix",
    "  }",
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
    "  return \"ok\"",
    "}",
    "workflow default {",
    "  if ensure ready {",
    "    log \"yes\"",
    "  } else {",
    "    log \"no\"",
    "  }",
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
    "  return \"ok\"",
    "}",
    "workflow default {",
    "  if not ensure ready {",
    "    log \"fail\"",
    "  } else {",
    "    log \"pass\"",
    "  }",
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
    "    log \"x\"",
    "  fi",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /then\/fi syntax is not supported/,
  );
});

test("parser: fail step parses quoted message", () => {
  const source = [
    "workflow default {",
    '  fail "expected reason"',
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as { type: string; message: string };
  assert.equal(step.type, "fail");
  assert.equal(step.message, '"expected reason"');
});

test("parser: const string expr and const run capture parse", () => {
  const source = [
    "script noop() {",
    "  :",
    "}",
    "workflow default {",
    '  const msg = "hi"',
    "  const out = run noop",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const steps = mod.workflows[0].steps;
  assert.equal(steps.length, 2);
  const c0 = steps[0] as { type: string; name: string; value: { kind: string; bashRhs?: string } };
  const c1 = steps[1] as { type: string; name: string; value: { kind: string } };
  assert.equal(c0.type, "const");
  assert.equal(c0.name, "msg");
  assert.equal(c0.value.kind, "expr");
  assert.equal(c0.value.bashRhs, '"hi"');
  assert.equal(c1.type, "const");
  assert.equal(c1.name, "out");
  assert.equal(c1.value.kind, "run_capture");
});

test("parser: const rejects bare call-like rhs without run", () => {
  const source = [
    "script some_script() {",
    "  echo \"$1\"",
    "}",
    "workflow default {",
    '  const x = some_script "$arg"',
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /Script calls in const assignments must use run/,
  );
});

test("parser: const allows run-wrapped script call with args", () => {
  const source = [
    "script some_script() {",
    "  echo \"$1\"",
    "}",
    "workflow default {",
    '  const x = run some_script "$arg"',
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as {
    type: string;
    name: string;
    value: { kind: string; ref?: { value: string }; args?: string };
  };
  assert.equal(step.type, "const");
  assert.equal(step.name, "x");
  assert.equal(step.value.kind, "run_capture");
  assert.equal(step.value.ref?.value, "some_script");
  assert.equal(step.value.args, '"$arg"');
});

test("parser: const prompt capture parses", () => {
  const source = [
    "workflow default {",
    '  const ans = prompt "type here"',
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as {
    type: string;
    name: string;
    value: { kind: string };
  };
  assert.equal(step.type, "const");
  assert.equal(step.name, "ans");
  assert.equal(step.value.kind, "prompt_capture");
});

test("parser: wait parses as workflow step (not shell)", () => {
  const source = [
    "workflow default {",
    "  wait",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows[0].steps[0].type, "wait");
});

test("parser: brace-style if parses not, else if, and else", () => {
  const source = [
    "rule ok {",
    "  return \"ok\"",
    "}",
    "rule bad {",
    "  fail \"no\"",
    "}",
    "script check() {",
    "  true",
    "}",
    "workflow default {",
    "  if not ensure bad {",
    "    log \"neg\"",
    "  }",
    "  else if run check {",
    "    log \"elif\"",
    "  }",
    "  else {",
    "    log \"final\"",
    "  }",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  const step = mod.workflows[0].steps[0] as {
    type: string;
    negated: boolean;
    elseIfBranches?: Array<{ negated: boolean; condition: { kind: string } }>;
    elseSteps?: unknown[];
  };
  assert.equal(step.type, "if");
  assert.equal(step.negated, true);
  assert.ok(step.elseIfBranches);
  assert.equal(step.elseIfBranches!.length, 1);
  assert.equal(step.elseIfBranches![0].negated, false);
  assert.equal(step.elseIfBranches![0].condition.kind, "run");
  assert.ok(step.elseSteps);
  assert.equal(step.elseSteps!.length, 1);
});

test("compiler golden: fail step transpiles to stderr echo and exit 1", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-fail-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "workflow default {",
        '  fail "stop here"',
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /echo "stop here" >&2/);
    assert.match(actual, /exit 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: const string transpiles to local assignment", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-const-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "workflow default {",
        '  const x = "abc"',
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /local x; x="abc"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: wait step emits bare wait", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-wait-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "workflow default {",
        "  wait",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /\n  wait\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: brace if transpiles to if elif else fi", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-brace-if-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "rule r1 {",
        "  return \"ok\"",
        "}",
        "rule r2 {",
        "  fail \"no\"",
        "}",
        "workflow default {",
        "  if ensure r1 {",
        '    log "then"',
        "  }",
        "  else if not ensure r2 {",
        '    log "mid"',
        "  }",
        "  else {",
        '    log "last"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /if entry::r1; then/);
    assert.match(actual, /elif ! entry::r2; then/);
    assert.match(actual, /\n  else\n/);
    assert.match(actual, /\nfi\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: positive if ensure with args transpiles correctly", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-ensure-pos-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "rule ready {",
        "  return \"ok\"",
        "}",
        "workflow default {",
        "  if ensure ready foo=bar {",
        "    log \"success\"",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /if entry::ready foo=bar; then/);
    assert.match(actual, /jaiph::log "success"/);
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
        "  return \"ok\"",
        "}",
        "workflow fallback {",
        "  log \"fallback\"",
        "}",
        "workflow default {",
        "  if ensure ready {",
        "    log \"yes\"",
        "  } else {",
        "    run fallback",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /if entry::ready; then/);
    assert.match(actual, /jaiph::log "yes"/);
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
        "  return \"ok\"",
        "}",
        "workflow default {",
        "  if not ensure check myarg {",
        "    log \"fallback\"",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
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
        "  log \"ok\"",
        "}",
        "workflow recovery {",
        "  log \"recovering\"",
        "}",
        "workflow default {",
        "  if not run check {",
        '    prompt "fix things"',
        "    run recovery",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
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
        "  log \"ok\"",
        "}",
        "workflow default {",
        "  if run check {",
        "    log \"passed\"",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /if entry::check; then/);
    assert.match(actual, /jaiph::log "passed"/);
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
        "  log \"ok\"",
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
        "  if not run lib.healthcheck {",
        "    log \"service down\"",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /if ! jaiph::run_step [a-z0-9_]+::healthcheck workflow [a-z0-9_]+::healthcheck::impl; then/);
    assert.match(actual, /jaiph::log "service down"/);
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
        "  log \"ok\"",
        "}",
        "workflow default {",
        "  if not run check foo=bar {",
        "    log \"fallback\"",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
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
        "  log \"ok\"",
        "}",
        "workflow default {",
        "  if run check {",
        "    log \"success\"",
        "  } else {",
        "    log \"failure\"",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /if entry::check; then/);
    assert.match(actual, /jaiph::log "success"/);
    assert.match(actual, /else/);
    assert.match(actual, /jaiph::log "failure"/);
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
        "script f_ok() {",
        "  echo ok",
        "}",
        "",
        "rule ok {",
        "  run f_ok",
        "}",
        "workflow default {",
        "  ensure ok",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root).module);
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

test("parser: send operator parses channel <- \"literal\"", () => {
  const source = [
    "workflow default {",
    `  findings <- "hello"`,
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows[0].steps.length, 1);
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "send");
  if (step.type !== "send") throw new Error("expected send");
  assert.equal(step.rhs.kind, "literal");
  assert.equal(step.rhs.token, `"hello"`);
  assert.equal(step.channel, "findings");
});

test("parser: top-level channel declarations parse and are stored", () => {
  const source = [
    "channel findings",
    "channel report",
    "workflow analyst {",
    "  log \"ok\"",
    "}",
    "workflow default {",
    `  findings <- "hi"`,
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
    `  findings <- "hi"`,
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
        "  log \"ok\"",
        "}",
        "workflow default {",
        `  typo <- "x"`,
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
        "  log \"ok\"",
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
        `  shared.typo <- "x"`,
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
  assert.equal(step.type === "send" && step.rhs.kind, "forward");
  assert.equal((step as { type: "send"; channel: string }).channel, "findings");
});

test("parser: <- inside quotes is not a send", () => {
  const source = [
    "workflow default {",
    '  log "a <- b"',
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.equal(mod.workflows[0].steps.length, 1);
  assert.equal(mod.workflows[0].steps[0].type, "log");
});

test("parser: route declaration parses into routes", () => {
  const source = [
    "workflow analyst {",
    "  log \"ok\"",
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
    "  log \"ok\"",
    "}",
    "workflow b {",
    "  log \"ok\"",
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
    `  name = channel <- "hello"`,
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
        `  channel <- "foo"`,
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /jaiph::send 'channel' "foo"/);
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
    const actual = normalize(transpileFile(input, root).module);
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
        "  log \"ok\"",
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
        `  shared.findings <- "foo"`,
        "  shared.findings -> shared.analyst",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /jaiph::send 'shared\.findings' "foo"/);
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
        "  log \"ok\"",
        "}",
        "workflow default {",
        "  findings -> analyst",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
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
        "  log \"ok\"",
        "}",
        "workflow b {",
        "  log \"ok\"",
        "}",
        "workflow default {",
        "  findings -> a, b",
        "}",
        "",
      ].join("\n"),
    );
    const actual = normalize(transpileFile(input, root).module);
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
        "script emit_findings() {",
        "  echo '## findings'",
        "}",
        "",
        "script write_findings_file() {",
        '  printf "%s\\n" "$1" > findings_file.md',
        "}",
        "",
        "script emit_reviewed() {",
        '  printf "[reviewed] %s\\n" "$1"',
        "}",
        "",
        "workflow researcher {",
        "  findings <- run emit_findings",
        "}",
        "",
        "workflow analyst {",
        "  run write_findings_file \"$1\"",
        '  const summary = "Summary of findings"',
        "  summary <- $summary",
        "}",
        "",
        "workflow reviewer {",
        "  final_summary <- run emit_reviewed \"$1\"",
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
    const actual = normalize(transpileFile(input, root).module);
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

// === Top-level const (env declaration) tests ===

test("parser: top-level const declaration parses single-line string", () => {
  const source = [
    'const greeting = "hello world"',
    "workflow default {",
    "  log \"$greeting\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.envDecls);
  assert.equal(mod.envDecls!.length, 1);
  assert.equal(mod.envDecls![0].name, "greeting");
  assert.equal(mod.envDecls![0].value, "hello world");
});

test("parser: top-level const declaration parses multi-line string", () => {
  const source = [
    'const role = "You are an expert.',
    "    1. You write clearly",
    '    2. You are concise"',
    "workflow default {",
    "  log \"$role\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.envDecls);
  assert.equal(mod.envDecls!.length, 1);
  assert.equal(mod.envDecls![0].name, "role");
  assert.ok(mod.envDecls![0].value.includes("You are an expert."));
  assert.ok(mod.envDecls![0].value.includes("You are concise"));
});

test("parser: top-level const declaration parses bare value", () => {
  const source = [
    "const count = 42",
    "workflow default {",
    "  log \"$count\"",
    "}",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/entry.jh");
  assert.ok(mod.envDecls);
  assert.equal(mod.envDecls![0].name, "count");
  assert.equal(mod.envDecls![0].value, "42");
});

test("parser: top-level local keyword is rejected", () => {
  const source = [
    'local greeting = "hello world"',
    "workflow default {",
    "  log \"$greeting\"",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /unknown top-level keyword "local" — use const NAME = VALUE/,
  );
});

test("parser: top-level const name collision with rule is E_PARSE", () => {
  const source = [
    'const foo = "bar"',
    "rule foo {",
    "  return \"ok\"",
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

test("parser: top-level const name collision with workflow is E_PARSE", () => {
  const source = [
    'const default = "val"',
    "workflow default {",
    "  log \"ok\"",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /duplicate name "default".*variable name collides with workflow/,
  );
});

test("parser: top-level const name collision with script is E_PARSE", () => {
  const source = [
    'const helper = "val"',
    "script helper() {",
    "  echo ok",
    "}",
    "workflow default {",
    "  run helper",
    "}",
  ].join("\n");
  assert.throws(
    () => parsejaiph(source, "/fake/entry.jh"),
    /duplicate name "helper".*variable name collides with script/,
  );
});

test("compiler golden: top-level const emits prefixed variable and shims", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-env-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'const greeting = "hello world"',
        "",
        "rule check {",
        "  log \"$greeting\"",
        "}",
        "",
        "script helper() {",
        "  echo $greeting",
        "}",
        "",
        "workflow default {",
        "  ensure check",
        "  run helper",
        "  log \"$greeting\"",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root).module);
    // Exported prefixed variable at top (export needed for child-shell rule sandbox)
    assert.match(actual, /export entry__greeting="hello world"/);
    // Local shims in rule impl
    assert.match(actual, /entry::check::impl\(\) \{[\s\S]*?local greeting="\$entry__greeting"/);
    // Script wrapper runs via run_step + JAIPH_SCRIPTS (body is external file)
    assert.match(
      actual,
      /entry::helper\(\) \{[\s\S]*?jaiph::run_step entry::helper script "\$JAIPH_SCRIPTS\/helper" "\$@"/,
    );
    // Local shims in workflow impl
    assert.match(actual, /entry::default::impl\(\) \{[\s\S]*?local greeting="\$entry__greeting"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: top-level const $sibling is expanded in export (set -u safe)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-env-cross-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'const shared = "MIDDLE"',
        'const combined = "before $shared after"',
        "",
        "workflow default {",
        "  log \"$combined\"",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /export entry__shared="MIDDLE"/);
    assert.match(actual, /export entry__combined="before MIDDLE after"/);
    assert.ok(!/export entry__combined="[^"]*\$shared/.test(actual));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// === script isolation golden tests ===

test("compiler golden: standalone script file has no env shims (isolation)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-script-iso-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        'const greeting = "hello world"',
        "",
        "script helper() {",
        "  echo $greeting",
        "}",
        "",
        "workflow default {",
        "  run helper",
        "}",
        "",
      ].join("\n"),
    );

    const result = transpileFile(input, root);
    assert.equal(result.scripts.length, 1);
    const scriptContent = result.scripts[0].content;
    // Script file must NOT contain env shim lines
    assert.ok(!/local greeting="\$entry__greeting"/.test(scriptContent), "script file should not contain env shim for greeting");
    assert.ok(!/entry__/.test(scriptContent), "script file should not reference prefixed module variables");
    // Script file should still contain the body
    assert.ok(scriptContent.includes("echo $greeting"), "script body preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: cross-script call is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-cross-script-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "script helper() {",
        "  echo ok",
        "}",
        "",
        "script caller() {",
        "  helper",
        "}",
        "",
        "workflow default {",
        "  run caller",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => transpileFile(input, root),
      /scripts cannot call other Jaiph scripts/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: script calling itself is allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-script-self-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "script recurse() {",
        "  recurse",
        "}",
        "",
        "workflow default {",
        "  run recurse",
        "}",
        "",
      ].join("\n"),
    );
    // Self-reference should not throw (a script calling itself is recursion, not cross-script)
    const result = transpileFile(input, root);
    assert.equal(result.scripts.length, 1);
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
        "script has_results_txt() {",
        "  test -f results.txt",
        "}",
        "",
        "rule tests_pass {",
        "  run has_results_txt",
        "}",
        "",
        "workflow fix_tests {",
        "  log \"fixing\"",
        "}",
        "",
        "workflow default {",
        "  ensure tests_pass recover run fix_tests",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root).module);
    // Retry loop structure
    assert.match(actual, /local _jaiph_ensure_passed=0/);
    assert.match(actual, /for _jaiph_retry in \$\(seq 1/);
    assert.match(actual, /JAIPH_RETURN_VALUE_FILE="\$_jaiph_ensure_rv_file" JAIPH_ENSURE_OUTPUT_FILE="\$_jaiph_ensure_output_file" entry::tests_pass; then/);
    assert.match(actual, /_jaiph_ensure_passed=1/);
    assert.match(actual, /break/);
    // Recover payload read from ensure output file (merged stdout+stderr)
    assert.match(actual, /\$_jaiph_ensure_output_file/);
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
        "script has_ci_ok() {",
        "  test -f ci_ok.txt",
        "}",
        "",
        "rule ci_pass {",
        "  run has_ci_ok",
        "}",
        "",
        "workflow fix_ci {",
        "  log \"fixing ci\"",
        "}",
        "",
        "workflow default {",
        "  ensure ci_pass recover {",
        "    run fix_ci",
        "    log \"retrying\"",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root).module);
    // Retry loop
    assert.match(actual, /for _jaiph_retry in \$\(seq 1/);
    assert.match(actual, /JAIPH_RETURN_VALUE_FILE="\$_jaiph_ensure_rv_file" JAIPH_ENSURE_OUTPUT_FILE="\$_jaiph_ensure_output_file" entry::ci_pass; then/);
    // Both recover steps present
    assert.match(actual, /entry::fix_ci/);
    assert.match(actual, /jaiph::log "retrying"/);
    // Loop end + failure guard
    assert.match(actual, /done/);
    assert.match(actual, /if \[{2} "\$_jaiph_ensure_passed" -ne 1 \]{2}; then/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// === brace if + function replaces legacy shell-condition if ===

test("compiler golden: if not run <fn> emits bash conditional on workflow call", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-not-run-fn-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "script config_yml_exists() {",
        "  test -f config.yml",
        "}",
        "",
        "workflow setup {",
        "  log \"setting up\"",
        "}",
        "",
        "workflow default {",
        "  if not run config_yml_exists {",
        "    log \"creating config\"",
        "    run setup",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root).module);
    assert.match(
      actual,
      /if ! jaiph::run_step entry::config_yml_exists script "\$JAIPH_SCRIPTS\/config_yml_exists"; then/,
    );
    assert.match(actual, /jaiph::log "creating config"/);
    assert.match(actual, /entry::setup/);
    assert.match(actual, /fi/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler golden: if not ensure with run steps in branch emits expected bash", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-golden-if-not-ensure-run-"));
  try {
    const input = join(root, "entry.jh");
    writeFileSync(
      input,
      [
        "script has_config_yml() {",
        "  test -f config.yml",
        "}",
        "",
        "script touch_config_yml() {",
        "  touch config.yml",
        "}",
        "",
        "rule config_exists {",
        "  run has_config_yml",
        "}",
        "",
        "workflow default {",
        "  if not ensure config_exists {",
        "    log \"creating default config\"",
        "    run touch_config_yml",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root).module);
    assert.match(actual, /if ! entry::config_exists; then/);
    assert.match(actual, /jaiph::log "creating default config"/);
    assert.match(
      actual,
      /jaiph::run_step entry::touch_config_yml script "\$JAIPH_SCRIPTS\/touch_config_yml"/,
    );
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
        "  log \"done\"",
        "}",
        "",
      ].join("\n"),
    );

    const actual = normalize(transpileFile(input, root).module);
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
        "  return \"ok\"",
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
    const bash = normalize(transpileFile(input, root).module);
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
        '  log "hello"',
        "}",
        "",
      ].join("\n"),
    );
    const bash = normalize(transpileFile(input, root).module);
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
