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
        "def one() {",
        "  run one_impl()",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "b.jh"),
      [
        'script two_impl = `echo two`',
        "def two() {",
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
        "export def main() {",
        "  run mod.one()",
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
        "export def main() {",
        "  run missing_rule()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE unknown local def or script reference "missing_rule"/);
  });
});

test("ACCEPTANCE: unknown import alias in rule reference fails deterministically", () => {
  withTempDir("jaiph-acc-unknown-import-alias-rule-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "export def main() {",
        "  run ghost.guard()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE unknown import alias "ghost" for run target "ghost\.guard"/);
  });
});

test("ACCEPTANCE: unknown local workflow reference in run fails deterministically", () => {
  withTempDir("jaiph-acc-unknown-local-workflow-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "export def main() {",
        "  run missing_workflow()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE unknown local def or script reference "missing_workflow"/);
  });
});

test("ACCEPTANCE: invalid workflow reference shape fails at parse stage", () => {
  withTempDir("jaiph-acc-invalid-workflow-ref-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "export def main() {",
        "  run bad.ref.shape()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_PARSE.*run must target a valid reference/);
  });
});

test("ACCEPTANCE: imported workflow missing fails with E_VALIDATE", () => {
  withTempDir("jaiph-acc-imported-workflow-missing-", (root) => {
    writeFileSync(
      join(root, "lib.jh"),
      [
        'script existing_impl = `echo ok`',
        "def existing() {",
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
        "export def main() {",
        "  run lib.missing()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE imported def or script "lib\.missing" does not exist/);
  });
});

test("ACCEPTANCE: unterminated rule block reports parse location and code", () => {
  assert.throws(
    () => parsejaiph("def bad() {\n  echo x\n", "/fake/main.jh"),
    /\/fake\/main\.jh:1:1 E_PARSE unterminated block/,
  );
});

test("ACCEPTANCE: unterminated prompt string fails with E_PARSE", () => {
  withTempDir("jaiph-acc-unterminated-prompt-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "export def main() {",
        '  prompt "this never closes',
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_PARSE multiline prompt strings are no longer supported/);
  });
});

test("ACCEPTANCE: if keyword with old syntax produces E_PARSE error", () => {
  withTempDir("jaiph-acc-if-old-syntax-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "def gate() {",
        "  run gate_impl()",
        "}",
        'script gate_impl = `false`',
        "",
        "export def main() {",
        "  if not run gate() {",
        '    log "fallback"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_PARSE.*invalid if syntax/);
  });
});

test("ACCEPTANCE: run catch then-branch allows mixed prompt and run", () => {
  withTempDir("jaiph-acc-catch-ensure-mixed-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "def gate() {",
        "  run gate_impl()",
        "}",
        'script gate_impl = `false`',
        "",
        "def fix_build() {",
        '  const _ = prompt "fix build"',
        "}",
        "",
        "export def main() {",
        "  run gate() catch (err) {",
        '    const _ = prompt "recover"',
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
    () => parsejaiph('import "lib.jh"\nexport def main() {\n  echo ok\n}\n', "/fake/main.jh"),
    /\/fake\/main\.jh:1:1 E_PARSE import must match: import "<path>" as <alias>/,
  );
});

test("ACCEPTANCE: unsupported top-level statement fails with E_PARSE", () => {
  assert.throws(
    () => parsejaiph('echo "not allowed at top level"\nexport def main() {\n  echo ok\n}\n', "/fake/main.jh"),
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

test("ACCEPTANCE: def with inline brace group cmd || { ... } compiles", () => {
  withTempDir("jaiph-acc-rule-or-brace-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "def example() {",
        '  check_something || { echo "failed"; exit 1; }',
        "}",
        "",
        "export def main() {",
        "  run example()",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "main.jh"), join(root, "out"));
  });
});

test("ACCEPTANCE: def with single-line || { ... } compiles", () => {
  withTempDir("jaiph-acc-def-or-brace-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "def example() {",
        '  check_something || { echo "failed"; exit 1; }',
        "}",
        "",
        "export def main() {",
        "  run example()",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "main.jh"), join(root, "out"));
  });
});

test("ACCEPTANCE: workflow shell step with || { ... } is allowed and compiles", () => {
  withTempDir("jaiph-acc-workflow-or-brace-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "export def main() {",
        '  cmd || { echo "failed"; exit 1; }',
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "main.jh"), join(root, "out"));
  });
});

test("ACCEPTANCE: inline shell short-circuit in workflow compiles", () => {
  withTempDir("jaiph-acc-or-brace-workflow-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        'script gate_impl = `true`',
        "",
        "export def main() {",
        '  other || { echo "err"; exit 1; }',
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "main.jh"), join(root, "out"));
  });
});

test("ACCEPTANCE: prompt with returns schema (single-line) parses and emits typed capture", () => {
  const mod = parsejaiph(
    [
      "export def main() {",
      '  const result = prompt "Analyse the diff" returns "{ type: string, risk: string }"',
      "}",
      "",
    ].join("\n"),
    "/fake/main.jh",
  );
  assert.equal(mod.defs.length, 1);
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "const");
  assert.ok(step.type === "const" && step.name === "result");
  assert.ok(step.type === "const" && step.value.kind === "prompt");
  if (step.type === "const" && step.value.kind === "prompt") {
    assert.ok(step.value.returns !== undefined);
    assert.match(step.value.returns!, /type:\s*string/);
  }

  withTempDir("jaiph-acc-prompt-returns-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "export def main() {",
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
    "export def main() {",
    '  const result = prompt "Analyse" \\',
    '    returns "{ type: string, risk: string }"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(src, "/fake/main.jh");
  assert.equal(mod.defs.length, 1);
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "const");
  assert.ok(step.type === "const" && step.value.kind === "prompt");
  if (step.type === "const" && step.value.kind === "prompt") {
    assert.ok(step.value.returns !== undefined);
    assert.match(step.value.returns!, /type:\s*string/);
    assert.match(step.value.returns!, /risk:\s*string/);
  }
});

test("ACCEPTANCE: unsupported type in returns schema fails with E_SCHEMA", () => {
  withTempDir("jaiph-acc-prompt-returns-bad-type-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "export def main() {",
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
        "export def main() {",
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
        "export def main() {",
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
        "  const out = run w.main()",
        '  expect_contain out "raw={\\"type\\":\\"fix\\",\\"risk\\":\\"low\\"}"',
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
        "export def main() {",
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
        "  const out = run w.main()",
        '  expect_contain out "done"',
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
        "export def main() {",
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
        "  const out = run w.main()",
        '  expect_contain out "done"',
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
        "export def main() {",
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
        "  const out = run w.main()",
        '  expect_contain out "done"',
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
    assert.match(err, /def exited with status|expected string|got number|type.*mismatch|FAIL/i);
  });
});

// === Inbox / send operator / route acceptance tests ===

test("ACCEPTANCE: route with unknown def fails E_VALIDATE", () => {
  withTempDir("jaiph-acc-route-unknown-wf-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "channel findings -> missing_wf",
        "export def main() {",
        "  log \"ok\"",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE unknown local def reference "missing_wf"/);
  });
});

test("ACCEPTANCE: route with rule ref fails E_VALIDATE", () => {
  withTempDir("jaiph-acc-route-rule-ref-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "channel findings -> check",
        "def check() {",
        "  run check_impl()",
        "}",
        'script check_impl = `true`',
        "export def main() {",
        "  log \"ok\"",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => buildScripts(root, join(root, "out")), /inbox route target "check" must declare 1 to 3 parameters/);
  });
});

test("ACCEPTANCE: route inside workflow body is E_PARSE", () => {
  withTempDir("jaiph-acc-route-in-body-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "channel findings",
        "export def main() {",
        "  findings -> analyst",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => buildScripts(root, join(root, "out")), /route declarations belong at the top level/);
  });
});

test("ACCEPTANCE: capture + send is parse error", () => {
  withTempDir("jaiph-acc-capture-send-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "export def main() {",
        "  findings <- \"hello\"",
        "}",
        "",
      ].join("\n"),
    );
    // `channel <- payload` is removed; use `send <payload> -> <channel>`.
    assert.throws(() => buildScripts(root, join(root, "out")), /use 'send <payload> -> <channel>'/);
  });
});

test("ACCEPTANCE: inbox.jh fixture builds successfully", () => {
  withTempDir("jaiph-acc-inbox-fixture-", (root) => {
    writeFileSync(
      join(root, "inbox.jh"),
      [
        "channel findings -> analyst",
        "channel summary -> reviewer",
        "channel final_summary",
        "",
        "script emit_findings = `echo '## findings'`",
        "",
        'script summarize_findings = `echo "Summary of findings"`',
        "",
        'script review_summary = `echo "[reviewed] $1"`',
        "",
        "def researcher() {",
        "  send run emit_findings() -> findings",
        "}",
        "",
        'script write_findings_file = `echo "$1" > findings_file.md`',
        "",
        "def analyst(message, chan, sender) {",
        '  run write_findings_file(message)',
        '  const summary = run summarize_findings()',
        '  send "${summary}" -> summary',
        "}",
        "",
        "def reviewer(message, chan, sender) {",
        '  send run review_summary(message) -> final_summary',
        "}",
        "",
        "export def main() {",
        "  run researcher()",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "inbox.jh"), join(root, "out"));
  });
});

// === run ... catch validation ===

test("ACCEPTANCE: run catch with args after catch fails with E_PARSE", () => {
  withTempDir("jaiph-acc-catch-args-after-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "def ci_passes() {",
        "  run ci_passes_impl()",
        "}",
        'script ci_passes_impl = `true`',
        "",
        "export def main() {",
        '  run ci_passes() catch "$repo_dir" {',
        '    prompt "Apply the smallest safe fix."',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(root, join(root, "out")),
      /E_PARSE.*catch requires explicit bindings/,
    );
  });
});

test("ACCEPTANCE: run catch with multiple args after catch fails with E_PARSE", () => {
  withTempDir("jaiph-acc-catch-multi-args-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "def some_rule() {",
        "  true",
        "}",
        "",
        "export def main() {",
        '  run some_rule("a") catch "b" {',
        '    log "should not parse"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(root, join(root, "out")),
      /E_PARSE.*catch requires explicit bindings/,
    );
  });
});

test("ACCEPTANCE: run catch without block fails with E_PARSE", () => {
  assert.throws(
    () =>
      parsejaiph(
        [
          "def ci_passes() {",
          "  true",
          "}",
          "",
          "export def main() {",
          '  run ci_passes("$repo_dir") catch',
          "}",
          "",
        ].join("\n"),
        "/fake/main.jh",
      ),
    /E_PARSE.*catch requires explicit bindings/,
  );
});

test("ACCEPTANCE: unexported def main is E_VALIDATE", () => {
  withTempDir("jaiph-acc-unexported-main-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      ["def main() {", '  log "hi"', "}", ""].join("\n"),
    );
    assert.throws(
      () => buildScripts(root, join(root, "out")),
      /main.*must be exported/,
    );
  });
});

test("ACCEPTANCE: script named main is E_VALIDATE", () => {
  withTempDir("jaiph-acc-script-main-", (root) => {
    writeFileSync(
      join(root, "lib.jh"),
      ["script main = `echo hi`", ""].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "lib.jh"), join(root, "out")),
      /reserved as the run entry/,
    );
  });
});

test("ACCEPTANCE: a library with no main compiles", () => {
  withTempDir("jaiph-acc-lib-no-main-", (root) => {
    writeFileSync(
      join(root, "lib.jh"),
      ["export def greet(name) {", '  return "hi ${name}"', "}", ""].join("\n"),
    );
    buildScripts(join(root, "lib.jh"), join(root, "out"));
  });
});

test("ACCEPTANCE: valid run catch block still works", () => {
  withTempDir("jaiph-acc-catch-valid-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "def ci_passes(repo_dir) {",
        "  run ci_passes_impl()",
        "}",
        'script ci_passes_impl = `true`',
        "",
        "def fix_it() {",
        '  prompt "fix"',
        "}",
        "",
        "export def main() {",
        '  run ci_passes("$repo_dir") catch (failure) {',
        "    run fix_it()",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "main.jh"), join(root, "out"));
  });
});
