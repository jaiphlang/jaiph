import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { buildScripts } from "../transpiler";
import { parsejaiph } from "../parser";

function withTempDir(prefix: string, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("ACCEPTANCE: duplicate import alias fails with E_VALIDATE", () => {
  withTempDir("jaiph-acc-dup-import-", (root) => {
    writeFileSync(
      join(root, "a.jh"),
      [
        'script one_impl = `echo one`',
        "rule one() {",
        "  run one_impl()",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "b.jh"),
      [
        'script two_impl = `echo two`',
        "rule two() {",
        "  run two_impl()",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "a.jh" as mod',
        'import "b.jh" as mod',
        "",
        "workflow default() {",
        "  ensure mod.one()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE duplicate import alias "mod"/);
  });
});

test("ACCEPTANCE: unknown local rule reference fails deterministically", () => {
  withTempDir("jaiph-acc-unknown-local-rule-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default() {",
        "  ensure missing_rule()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE unknown local rule reference "missing_rule"/);
  });
});

test("ACCEPTANCE: unknown import alias in rule reference fails deterministically", () => {
  withTempDir("jaiph-acc-unknown-import-alias-rule-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default() {",
        "  ensure ghost.guard()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE unknown import alias "ghost" for rule reference "ghost\.guard"/);
  });
});

test("ACCEPTANCE: unknown local workflow reference in run fails deterministically", () => {
  withTempDir("jaiph-acc-unknown-local-workflow-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default() {",
        "  run missing_workflow()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE unknown local workflow or script reference "missing_workflow"/);
  });
});

test("ACCEPTANCE: invalid workflow reference shape fails at parse stage", () => {
  withTempDir("jaiph-acc-invalid-workflow-ref-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default() {",
        "  run bad.ref.shape()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_PARSE calls require parentheses/);
  });
});

test("ACCEPTANCE: imported workflow missing fails with E_VALIDATE", () => {
  withTempDir("jaiph-acc-imported-workflow-missing-", (root) => {
    writeFileSync(
      join(root, "lib.jh"),
      [
        'script existing_impl = `echo ok`',
        "workflow existing() {",
        "  run existing_impl()",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "lib.jh" as lib',
        "",
        "workflow default() {",
        "  run lib.missing()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE imported workflow or script "lib\.missing" does not exist/);
  });
});

test("ACCEPTANCE: unterminated rule block reports parse location and code", () => {
  assert.throws(
    () => parsejaiph("rule bad() {\n  echo x\n", "/fake/main.jh"),
    /\/fake\/main\.jh:1:1 E_PARSE unterminated rule block: bad/,
  );
});

test("ACCEPTANCE: unterminated prompt string fails with E_PARSE", () => {
  withTempDir("jaiph-acc-unterminated-prompt-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default() {",
        '  prompt "this never closes',
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_PARSE multiline prompt strings are no longer supported/);
  });
});

test("ACCEPTANCE: brace if block must close before workflow ends", () => {
  withTempDir("jaiph-acc-if-brace-close-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule gate() {",
        "  run gate_impl()",
        "}",
        'script gate_impl = `false`',
        "",
        "workflow default() {",
        "  if not ensure gate() {",
        "    echo fallback",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_PARSE unterminated block, expected "}"/);
  });
});

test("ACCEPTANCE: if not ensure then-branch allows mixed prompt and run", () => {
  withTempDir("jaiph-acc-if-ensure-mixed-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule gate() {",
        "  run gate_impl()",
        "}",
        'script gate_impl = `false`',
        "",
        "workflow fix_build() {",
        '  prompt "fix build"',
        "}",
        "",
        "workflow default() {",
        "  if not ensure gate() {",
        '    prompt "recover"',
        "    run fix_build()",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(join(root, "main.jh"), join(root, "out"));
  });
});

test("ACCEPTANCE: malformed import syntax fails with E_PARSE", () => {
  assert.throws(
    () => parsejaiph('import "lib.jh"\nworkflow default() {\n  echo ok\n}\n', "/fake/main.jh"),
    /\/fake\/main\.jh:1:1 E_PARSE import must match: import "<path>" as <alias>/,
  );
});

test("ACCEPTANCE: unsupported top-level statement fails with E_PARSE", () => {
  assert.throws(
    () => parsejaiph('echo "not allowed at top level"\nworkflow default() {\n  echo ok\n}\n', "/fake/main.jh"),
    /\/fake\/main\.jh:1:1 E_PARSE unsupported top-level statement/,
  );
});

test("ACCEPTANCE: malformed mock prompt block (invalid pattern) fails with E_PARSE", () => {
  assert.throws(
    () =>
      parsejaiph(
        [
          'import "w.jh" as w',
          "",
          'test "bad mock" {',
          "  mock prompt {",
          '    respond "x"',
          "  }",
          "}",
          "",
        ].join("\n"),
        "/fake/t.test.jh",
      ),
    /E_PARSE.*match pattern must be/,
  );
});

test("ACCEPTANCE: unterminated mock prompt block fails with E_PARSE", () => {
  assert.throws(
    () =>
      parsejaiph(
        [
          'import "w.jh" as w',
          "",
          'test "unterminated" {',
          "  mock prompt {",
          '    "x" => "y"',
          "",
        ].join("\n"),
        "/fake/t.test.jh",
      ),
    /E_PARSE.*unterminated match block/,
  );
});

test("ACCEPTANCE: rule with inline brace group cmd || { ... } fails under strict shell-step ban", () => {
  withTempDir("jaiph-acc-rule-or-brace-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule example() {",
        '  check_something || { echo "failed"; exit 1; }',
        "}",
        "",
        "workflow default() {",
        "  ensure example()",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "main.jh"), join(root, "out")),
      /E_VALIDATE inline shell steps are forbidden in rules; use explicit script blocks/,
    );
  });
});

test("ACCEPTANCE: rule with multi-line || { ... } fails under strict shell-step ban", () => {
  withTempDir("jaiph-acc-rule-or-brace-multiline-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule example() {",
        "  check_something || {",
        '    echo "failed"',
        "    exit 1",
        "  }",
        "}",
        "",
        "workflow default() {",
        "  ensure example()",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "main.jh"), join(root, "out")),
      /E_VALIDATE inline shell steps are forbidden in rules; use explicit script blocks/,
    );
  });
});

test("ACCEPTANCE: workflow shell step with || { ... } fails under strict shell-step ban", () => {
  withTempDir("jaiph-acc-workflow-or-brace-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default() {",
        '  cmd || { echo "failed"; exit 1; }',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "main.jh"), join(root, "out")),
      /E_VALIDATE inline shell steps are forbidden in workflows; use explicit script blocks/,
    );
  });
});

test("ACCEPTANCE: if not ensure { } + inline shell short-circuit fails under strict shell-step ban", () => {
  withTempDir("jaiph-acc-if-and-or-brace-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule gate() {",
        "  run gate_impl()",
        "}",
        'script gate_impl = `true`',
        "",
        "workflow default() {",
        "  if not ensure gate() {",
        "    echo fallback",
        "  }",
        '  other || { echo "err"; exit 1; }',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "main.jh"), join(root, "out")),
      /E_VALIDATE inline shell steps are forbidden in workflows; use explicit script blocks/,
    );
  });
});

test("ACCEPTANCE: prompt with returns schema (single-line) parses and emits typed capture", () => {
  const mod = parsejaiph(
    [
      "workflow default() {",
      '  const result = prompt "Analyse the diff" returns "{ type: string, risk: string }"',
      "}",
      "",
    ].join("\n"),
    "/fake/main.jh",
  );
  assert.equal(mod.workflows.length, 1);
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "const");
  assert.ok(step.type === "const" && step.name === "result");
  assert.ok(step.type === "const" && step.value.kind === "prompt_capture");
  assert.ok(step.type === "const" && step.value.returns !== undefined);
  assert.match(step.value.returns!, /type:\s*string/);

  withTempDir("jaiph-acc-prompt-returns-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default() {",
        '  const result = prompt "Analyse" returns "{ type: string, risk: string }"',
        '  return "${result}"',
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "main.jh"), join(root, "out"));
  });
});

// Multiline returns: continuation with \ then returns "{ ... }" on next line.
test("ACCEPTANCE: prompt with returns schema (multiline continuation) parses", () => {
  const src = [
    "workflow default() {",
    '  const result = prompt "Analyse" \\',
    '    returns "{ type: string, risk: string }"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(src, "/fake/main.jh");
  assert.equal(mod.workflows.length, 1);
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "const");
  assert.ok(step.type === "const" && step.value.kind === "prompt_capture");
  assert.ok(step.type === "const" && step.value.returns !== undefined);
  assert.match(step.value.returns!, /type:\s*string/);
  assert.match(step.value.returns!, /risk:\s*string/);
});

test("ACCEPTANCE: unsupported type in returns schema fails with E_SCHEMA", () => {
  withTempDir("jaiph-acc-prompt-returns-bad-type-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default() {",
        '  const result = prompt "x" returns "{ foo: array }"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => buildScripts(join(root, "main.jh"), join(root, "out")), /E_SCHEMA.*unsupported type/);
  });
});

test("ACCEPTANCE: prompt with returns without capture name fails with E_PARSE", () => {
  withTempDir("jaiph-acc-prompt-returns-no-capture-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default() {",
        '  prompt "x" returns "{ a: string }"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "main.jh"), join(root, "out")),
      /prompt with "returns" schema must capture to a variable/,
    );
  });
});

// Requires node in PATH when the test script runs; in some environments the child bash gets 127.
test("ACCEPTANCE: jaiph test typed prompt — valid JSON passes and raw result is available", () => {
  withTempDir("jaiph-acc-typed-prompt-valid-", (root) => {
    writeFileSync(
      join(root, "flow.jh"),
      [
        "workflow default() {",
        '  const result = prompt "classify" returns "{ type: string, risk: string }"',
        '  return "raw=${result}"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "flow.test.jh"),
      [
        'import "flow.jh" as w',
        "",
        'test "typed prompt accepts valid JSON" {',
        '  mock prompt "{\\"type\\":\\"fix\\",\\"risk\\":\\"low\\"}"',
        "  out = w.default",
        '  expectContain out "raw={\\"type\\":\\"fix\\",\\"risk\\":\\"low\\"}"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const nodeDir = dirname(process.execPath);
    const r = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${nodeDir}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(r.status, 0, `jaiph test should pass; stderr: ${r.stderr ?? ""}; stdout: ${r.stdout ?? ""}`);
    assert.ok((r.stdout ?? "").includes("passed") || (r.stdout ?? "").includes("PASS"));
  });
});

test("ACCEPTANCE: jaiph test typed prompt — invalid JSON fails with parse error", () => {
  withTempDir("jaiph-acc-typed-prompt-parse-err-", (root) => {
    writeFileSync(
      join(root, "flow.jh"),
      [
        "workflow default() {",
        '  const result = prompt "classify" returns "{ type: string }"',
        '  log "done"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "flow.test.jh"),
      [
        'import "flow.jh" as w',
        "",
        'test "invalid JSON fails" {',
        '  mock prompt "not valid json"',
        "  out = w.default",
        '  expectContain out "done"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const nodeDir = dirname(process.execPath);
    const r = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${nodeDir}:${process.env.PATH ?? ""}`,
      },
    });
    assert.notEqual(r.status, 0, `expected non-zero exit; stdout:\n${r.stdout ?? ""}\nstderr:\n${r.stderr ?? ""}`);
    const err = (r.stderr ?? "") + (r.stdout ?? "");
    assert.match(err, /invalid JSON|parse error/i, "stderr should mention JSON parse error");
  });
});

test("ACCEPTANCE: jaiph test typed prompt — missing field fails with schema error", () => {
  withTempDir("jaiph-acc-typed-prompt-missing-field-", (root) => {
    writeFileSync(
      join(root, "flow.jh"),
      [
        "workflow default() {",
        '  const result = prompt "classify" returns "{ type: string, risk: string }"',
        '  log "done"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "flow.test.jh"),
      [
        'import "flow.jh" as w',
        "",
        'test "missing field fails" {',
        '  mock prompt "{\\"type\\":\\"fix\\"}"',
        "  out = w.default",
        '  expectContain out "done"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const nodeDir = dirname(process.execPath);
    const r = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${nodeDir}:${process.env.PATH ?? ""}`,
      },
    });
    assert.notEqual(r.status, 0, `expected non-zero exit; stdout:\n${r.stdout ?? ""}\nstderr:\n${r.stderr ?? ""}`);
    const err = (r.stderr ?? "") + (r.stdout ?? "");
    assert.match(err, /missing required field|missing.*field/i);
  });
});

// Requires node in PATH when the test script runs; in some environments the child bash gets 127 before type validation.
test("ACCEPTANCE: jaiph test typed prompt — wrong type fails", () => {
  withTempDir("jaiph-acc-typed-prompt-type-err-", (root) => {
    writeFileSync(
      join(root, "flow.jh"),
      [
        "workflow default() {",
        '  const result = prompt "classify" returns "{ type: string, risk: string }"',
        '  log "done"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "flow.test.jh"),
      [
        'import "flow.jh" as w',
        "",
        'test "type error fails" {',
        '  mock prompt "{\\"type\\":123,\\"risk\\":\\"low\\"}"',
        "  out = w.default",
        '  expectContain out "done"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const nodeDir = dirname(process.execPath);
    const r = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${nodeDir}:${process.env.PATH ?? ""}`,
      },
    });
    assert.notEqual(r.status, 0);
    const err = (r.stderr ?? "") + (r.stdout ?? "");
    assert.match(err, /workflow exited with status|expected string|got number|type.*mismatch|FAIL/i);
  });
});

// === Inbox / send operator / route acceptance tests ===

test("ACCEPTANCE: route with unknown workflow fails E_VALIDATE", () => {
  withTempDir("jaiph-acc-route-unknown-wf-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "channel findings",
        "workflow default() {",
        "  findings -> missing_wf",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE unknown local workflow reference "missing_wf"/);
  });
});

test("ACCEPTANCE: route with rule ref fails E_VALIDATE", () => {
  withTempDir("jaiph-acc-route-rule-ref-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "channel findings",
        "rule check() {",
        "  run check_impl()",
        "}",
        'script check_impl = `true`',
        "workflow default() {",
        "  findings -> check",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE rule "check" must be called with ensure/);
  });
});

test("ACCEPTANCE: capture + send is parse error", () => {
  withTempDir("jaiph-acc-capture-send-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default() {",
        "  name = channel <- echo hello",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => buildScripts(root, join(root, "out")), /capture and send cannot be combined/);
  });
});

test("ACCEPTANCE: inbox.jh fixture builds successfully", () => {
  withTempDir("jaiph-acc-inbox-fixture-", (root) => {
    writeFileSync(
      join(root, "inbox.jh"),
      [
        "channel findings",
        "channel summary",
        "channel final_summary",
        "",
        "script emit_findings = `echo '## findings'`",
        "",
        'script summarize_findings = `echo "Summary of findings"`',
        "",
        'script review_summary = `echo "[reviewed] $1"`',
        "",
        "workflow researcher() {",
        "  findings <- run emit_findings()",
        "}",
        "",
        'script write_findings_file = `echo "$1" > findings_file.md`',
        "",
        "workflow analyst(name) {",
        '  run write_findings_file(arg1)',
        '  summary = run summarize_findings()',
        '  summary <- "${summary}"',
        "}",
        "",
        "workflow reviewer(name) {",
        '  final_summary <- run review_summary(arg1)',
        "}",
        "",
        "workflow default() {",
        "  run researcher()",
        "  findings -> analyst",
        "  summary -> reviewer",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "inbox.jh"), join(root, "out"));
  });
});

// === ensure ... recover validation ===

test("ACCEPTANCE: ensure recover with args after recover fails with E_PARSE", () => {
  withTempDir("jaiph-acc-recover-args-after-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule ci_passes() {",
        "  run ci_passes_impl()",
        "}",
        'script ci_passes_impl = `true`',
        "",
        "workflow default() {",
        '  ensure ci_passes() recover "$repo_dir" {',
        '    prompt "Apply the smallest safe fix."',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(root, join(root, "out")),
      /E_PARSE.*rule arguments must appear before 'recover'/,
    );
  });
});

test("ACCEPTANCE: ensure recover with multiple args after recover fails with E_PARSE", () => {
  withTempDir("jaiph-acc-recover-multi-args-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule some_rule() {",
        "  true",
        "}",
        "",
        "workflow default() {",
        '  ensure some_rule("a") recover "b" {',
        '    log "should not parse"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(root, join(root, "out")),
      /E_PARSE.*rule arguments must appear before 'recover'/,
    );
  });
});

test("ACCEPTANCE: ensure recover without block fails with E_PARSE", () => {
  assert.throws(
    () =>
      parsejaiph(
        [
          "rule ci_passes() {",
          "  true",
          "}",
          "",
          "workflow default() {",
          '  ensure ci_passes("$repo_dir") recover',
          "}",
          "",
        ].join("\n"),
        "/fake/main.jh",
      ),
    /E_PARSE.*recover requires a \{ \.\.\. \} block/,
  );
});

test("ACCEPTANCE: valid ensure recover block still works", () => {
  withTempDir("jaiph-acc-recover-valid-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule ci_passes(repo_dir) {",
        "  run ci_passes_impl()",
        "}",
        'script ci_passes_impl = `true`',
        "",
        "workflow fix_it() {",
        '  prompt "fix"',
        "}",
        "",
        "workflow default() {",
        '  ensure ci_passes("$repo_dir") recover {',
        "    run fix_it()",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "main.jh"), join(root, "out"));
  });
});
