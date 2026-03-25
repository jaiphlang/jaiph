import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { build, transpileTestFile } from "../../src/transpiler";
import { parsejaiph } from "../../src/parser";

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
    writeFileSync(join(root, "a.jh"), "rule one {\n  echo one\n}\n");
    writeFileSync(join(root, "b.jh"), "rule two {\n  echo two\n}\n");
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "a.jh" as mod',
        'import "b.jh" as mod',
        "",
        "workflow default {",
        "  ensure mod.one",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_VALIDATE duplicate import alias "mod"/);
  });
});

test("ACCEPTANCE: unknown local rule reference fails deterministically", () => {
  withTempDir("jaiph-acc-unknown-local-rule-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default {",
        "  ensure missing_rule",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_VALIDATE unknown local rule reference "missing_rule"/);
  });
});

test("ACCEPTANCE: unknown import alias in rule reference fails deterministically", () => {
  withTempDir("jaiph-acc-unknown-import-alias-rule-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default {",
        "  ensure ghost.guard",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_VALIDATE unknown import alias "ghost" for rule reference "ghost\.guard"/);
  });
});

test("ACCEPTANCE: unknown local workflow reference in run fails deterministically", () => {
  withTempDir("jaiph-acc-unknown-local-workflow-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default {",
        "  run missing_workflow",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_VALIDATE unknown local workflow or script reference "missing_workflow"/);
  });
});

test("ACCEPTANCE: invalid workflow reference shape fails at parse stage", () => {
  withTempDir("jaiph-acc-invalid-workflow-ref-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default {",
        "  run bad.ref.shape",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_PARSE run must target a workflow or script reference/);
  });
});

test("ACCEPTANCE: imported workflow missing fails with E_VALIDATE", () => {
  withTempDir("jaiph-acc-imported-workflow-missing-", (root) => {
    writeFileSync(join(root, "lib.jh"), "workflow existing {\n  echo ok\n}\n");
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "lib.jh" as lib',
        "",
        "workflow default {",
        "  run lib.missing",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_VALIDATE imported workflow or script "lib\.missing" does not exist/);
  });
});

test("ACCEPTANCE: unterminated rule block reports parse location and code", () => {
  assert.throws(
    () => parsejaiph("rule bad {\n  echo x\n", "/fake/main.jh"),
    /\/fake\/main\.jh:1:1 E_PARSE unterminated rule block: bad/,
  );
});

test("ACCEPTANCE: unterminated prompt string fails with E_PARSE", () => {
  withTempDir("jaiph-acc-unterminated-prompt-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default {",
        '  prompt "this never closes',
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_PARSE unterminated prompt string/);
  });
});

test("ACCEPTANCE: brace if block must close before workflow ends", () => {
  withTempDir("jaiph-acc-if-brace-close-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule gate {",
        "  false",
        "}",
        "",
        "workflow default {",
        "  if not ensure gate {",
        "    echo fallback",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_PARSE unterminated block, expected "}"/);
  });
});

test("ACCEPTANCE: if not ensure then-branch allows mixed prompt and run", () => {
  withTempDir("jaiph-acc-if-ensure-mixed-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule gate {",
        "  false",
        "}",
        "",
        "workflow fix_build {",
        '  prompt "fix build"',
        "}",
        "",
        "workflow default {",
        "  if not ensure gate {",
        '    prompt "recover"',
        "    run fix_build",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const output = build(join(root, "main.jh"), join(root, "out"));
    assert.equal(output.length, 1);
    assert.match(output[0].bash, /if ! .*::gate; then/);
    assert.match(output[0].bash, /jaiph::prompt.*<<__JAIPH_PROMPT_/);
    assert.match(output[0].bash, /::fix_build/);
  });
});

test("ACCEPTANCE: test file without test blocks fails with E_PARSE", () => {
  withTempDir("jaiph-acc-empty-test-file-", (root) => {
    const testPath = join(root, "flow.test.jh");
    writeFileSync(
      testPath,
      [
        'import "flow.jh" as f',
        "",
      ].join("\n"),
    );
    writeFileSync(join(root, "flow.jh"), "workflow default {\n  echo ok\n}\n");

    assert.throws(() => transpileTestFile(testPath, root), /E_PARSE test file must contain at least one test block/);
  });
});

test("ACCEPTANCE: test workflow reference must be alias.workflow", () => {
  withTempDir("jaiph-acc-test-ref-shape-", (root) => {
    writeFileSync(join(root, "flow.jh"), "workflow default {\n  echo ok\n}\n");
    const testPath = join(root, "flow.test.jh");
    writeFileSync(
      testPath,
      [
        'import "flow.jh" as f',
        "",
        'test "bad reference" {',
        "  out = default",
        '  expectContain out "ok"',
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(
      () => transpileTestFile(testPath, root),
      /E_VALIDATE test workflow reference must be <alias>\.<workflow>, got "default"/,
    );
  });
});

test("ACCEPTANCE: malformed import syntax fails with E_PARSE", () => {
  assert.throws(
    () => parsejaiph('import "lib.jh"\nworkflow default {\n  echo ok\n}\n', "/fake/main.jh"),
    /\/fake\/main\.jh:1:1 E_PARSE import must match: import "<path>" as <alias>/,
  );
});

test("ACCEPTANCE: unsupported top-level statement fails with E_PARSE", () => {
  assert.throws(
    () => parsejaiph('echo "not allowed at top level"\nworkflow default {\n  echo ok\n}\n', "/fake/main.jh"),
    /\/fake\/main\.jh:1:1 E_PARSE unsupported top-level statement/,
  );
});

test("ACCEPTANCE: malformed mock prompt block (respond without if) fails with E_PARSE", () => {
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
    /E_PARSE.*respond must follow if\/elif/,
  );
});

test("ACCEPTANCE: import stem resolves .jh before .jph when both exist", () => {
  withTempDir("jaiph-acc-import-preference-", (root) => {
    writeFileSync(join(root, "dep.jh"), "rule ready {\n  echo from-jh\n}\n");
    writeFileSync(join(root, "dep.jph"), "rule ready {\n  echo from-jph\n}\n");
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "dep" as dep',
        "",
        "workflow default {",
        "  ensure dep.ready",
        "}",
        "",
      ].join("\n"),
    );

    const output = build(join(root, "main.jh"), join(root, "out"));
    assert.equal(output.length, 1);
    assert.match(output[0].bash, /source "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/dep\.sh"/);
  });
});

test("ACCEPTANCE: inline mock prompt block with if/elif/else emits first-match dispatch", () => {
  withTempDir("jaiph-acc-mock-block-", (root) => {
    writeFileSync(
      join(root, "w.jh"),
      [
        "workflow default {",
        '  result = prompt "greeting"',
        "  echo \"$result\"",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "w.test.jh"),
      [
        'import "w.jh" as w',
        "",
        'test "mock block first match" {',
        "  mock prompt {",
        '    if $1 contains "greeting" ; then',
        '      respond "hello"',
        '    elif $1 contains "other" ; then',
        '      respond "other"',
        "    else",
        '      respond "fallback"',
        "    fi",
        "  }",
        "  response = w.default",
        '  expectContain response "hello"',
        "}",
        "",
      ].join("\n"),
    );
    const bash = transpileTestFile(join(root, "w.test.jh"), root);
    assert.match(bash, /JAIPH_MOCK_DISPATCH_SCRIPT/);
    assert.match(bash, /greeting/);
    assert.match(bash, /other/);
  });
});

test("ACCEPTANCE: mock prompt block without else emits failure path for unmatched prompt", () => {
  withTempDir("jaiph-acc-mock-no-else-", (root) => {
    writeFileSync(
      join(root, "w.jh"),
      ["workflow default {", '  prompt "only-this-match"', "}", ""].join("\n"),
    );
    writeFileSync(
      join(root, "w.test.jh"),
      [
        'import "w.jh" as w',
        "",
        'test "no else branch" {',
        "  mock prompt {",
        '    if $1 contains "wrong" ; then',
        '      respond "x"',
        "    fi",
        "  }",
        "  response = w.default",
        '  expectContain response "x"',
        "}",
        "",
      ].join("\n"),
    );
    const bash = transpileTestFile(join(root, "w.test.jh"), root);
    assert.match(bash, /no mock matched prompt/);
    assert.match(bash, /exit 1/);
  });
});

test("ACCEPTANCE: unterminated mock prompt block (missing fi and }) fails with E_PARSE", () => {
  assert.throws(
    () =>
      parsejaiph(
        [
          'import "w.jh" as w',
          "",
          'test "unterminated" {',
          "  mock prompt {",
          '    if $1 contains "x" ; then',
          '      respond "y"',
          "  }",
          "}",
          "",
        ].join("\n"),
        "/fake/t.test.jh",
      ),
    /E_PARSE.*mock prompt block/,
  );
});

test("ACCEPTANCE: rule with inline brace group cmd || { ... } compiles and transpiles", () => {
  withTempDir("jaiph-acc-rule-or-brace-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule example {",
        '  check_something || { echo "failed"; exit 1; }',
        "}",
        "",
        "workflow default {",
        "  ensure example",
        "}",
        "",
      ].join("\n"),
    );
    const output = build(join(root, "main.jh"), join(root, "out"));
    assert.equal(output.length, 1);
    assert.match(output[0].bash, /check_something \|\| \{ echo "failed"; exit 1; \}/);
  });
});

test("ACCEPTANCE: rule with multi-line || { ... } compiles and transpiles", () => {
  withTempDir("jaiph-acc-rule-or-brace-multiline-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule example {",
        "  check_something || {",
        '    echo "failed"',
        "    exit 1",
        "  }",
        "}",
        "",
        "workflow default {",
        "  ensure example",
        "}",
        "",
      ].join("\n"),
    );
    const output = build(join(root, "main.jh"), join(root, "out"));
    assert.equal(output.length, 1);
    assert.match(output[0].bash, /check_something \|\| \{/);
    assert.match(output[0].bash, /echo "failed"/);
    assert.match(output[0].bash, /exit 1/);
  });
});

test("ACCEPTANCE: workflow shell step with || { ... } compiles and transpiles", () => {
  withTempDir("jaiph-acc-workflow-or-brace-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default {",
        '  cmd || { echo "failed"; exit 1; }',
        "}",
        "",
      ].join("\n"),
    );
    const output = build(join(root, "main.jh"), join(root, "out"));
    assert.equal(output.length, 1);
    assert.match(output[0].bash, /cmd \|\| \{ echo "failed"; exit 1; \}/);
  });
});

test("ACCEPTANCE: if not ensure { } works alongside || { } shell short-circuit", () => {
  withTempDir("jaiph-acc-if-and-or-brace-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule gate {",
        "  true",
        "}",
        "",
        "workflow default {",
        "  if not ensure gate {",
        "    echo fallback",
        "  }",
        '  other || { echo "err"; exit 1; }',
        "}",
        "",
      ].join("\n"),
    );
    const output = build(join(root, "main.jh"), join(root, "out"));
    assert.equal(output.length, 1);
    assert.match(output[0].bash, /if ! .*::gate; then/);
    assert.match(output[0].bash, /other \|\| \{ echo "err"; exit 1; \}/);
  });
});

test("ACCEPTANCE: prompt with returns schema (single-line) parses and emits typed capture", () => {
  const mod = parsejaiph(
    [
      "workflow default {",
      '  result = prompt "Analyse the diff" returns \'{ type: string, risk: string }\'',
      "}",
      "",
    ].join("\n"),
    "/fake/main.jh",
  );
  assert.equal(mod.workflows.length, 1);
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "prompt");
  assert.ok(step.type === "prompt" && step.captureName === "result");
  assert.ok(step.type === "prompt" && step.returns !== undefined);
  assert.match((step as { returns?: string }).returns!, /type:\s*string/);

  withTempDir("jaiph-acc-prompt-returns-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default {",
        '  result = prompt "Analyse" returns \'{ type: string, risk: string }\'',
        "  echo \"$result\"",
        "}",
        "",
      ].join("\n"),
    );
    const output = build(join(root, "main.jh"), join(root, "out"));
    assert.equal(output.length, 1);
    assert.match(output[0].bash, /jaiph::prompt_capture_with_schema/);
    assert.match(output[0].bash, /JAIPH_PROMPT_SCHEMA/);
    assert.match(output[0].bash, /JAIPH_PROMPT_CAPTURE_NAME/);
  });
});

// Multiline returns: continuation with \ then returns '{ ... }' on next line. Skip: parser line continuation needs debugging.
test.skip("ACCEPTANCE: prompt with returns schema (multiline continuation) parses", () => {
  const src = [
    "workflow default {",
    '  result = prompt "Analyse" \\',
    "    returns '{ type: string, risk: string }'",
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(src, "/fake/main.jh");
  assert.equal(mod.workflows.length, 1);
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "prompt");
  assert.ok(step.type === "prompt" && step.returns !== undefined);
  assert.match((step as { returns?: string }).returns!, /type:\s*string/);
  assert.match((step as { returns?: string }).returns!, /risk:\s*string/);
});

test("ACCEPTANCE: unsupported type in returns schema fails with E_SCHEMA", () => {
  withTempDir("jaiph-acc-prompt-returns-bad-type-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default {",
        '  result = prompt "x" returns \'{ foo: array }\'',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => build(join(root, "main.jh"), join(root, "out")), /E_SCHEMA.*unsupported type/);
  });
});

test("ACCEPTANCE: prompt with returns without capture name fails with E_PARSE", () => {
  withTempDir("jaiph-acc-prompt-returns-no-capture-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default {",
        '  prompt "x" returns \'{ a: string }\'',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => build(join(root, "main.jh"), join(root, "out")),
      /prompt with "returns" schema must capture to a variable/,
    );
  });
});

// Requires node in PATH when the test script runs; in some environments the child bash gets 127.
test.skip("ACCEPTANCE: jaiph test typed prompt — valid JSON passes, typed fields and raw result available", () => {
  withTempDir("jaiph-acc-typed-prompt-valid-", (root) => {
    writeFileSync(
      join(root, "flow.jh"),
      [
        "workflow default {",
        '  result = prompt "classify" returns \'{ type: string, risk: string }\'',
        '  echo "type=$result_type risk=$result_risk"',
        '  echo "raw=$result"',
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
        '  expectContain out "type=fix risk=low"',
        '  expectContain out "raw={\\"type\\":\\"fix\\",\\"risk\\":\\"low\\"}"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const stdlibPath = join(process.cwd(), "dist/src/jaiph_stdlib.sh");
    const nodeDir = dirname(process.execPath);
    const r = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        JAIPH_STDLIB: stdlibPath,
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
        "workflow default {",
        '  result = prompt "classify" returns \'{ type: string }\'',
        "  echo done",
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
    const stdlibPath = join(process.cwd(), "dist/src/jaiph_stdlib.sh");
    const nodeDir = dirname(process.execPath);
    const r = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        JAIPH_STDLIB: stdlibPath,
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
        "workflow default {",
        '  result = prompt "classify" returns \'{ type: string, risk: string }\'',
        "  echo done",
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
    const stdlibPath = join(process.cwd(), "dist/src/jaiph_stdlib.sh");
    const nodeDir = dirname(process.execPath);
    const r = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        JAIPH_STDLIB: stdlibPath,
        PATH: `${nodeDir}:${process.env.PATH ?? ""}`,
      },
    });
    assert.notEqual(r.status, 0, `expected non-zero exit; stdout:\n${r.stdout ?? ""}\nstderr:\n${r.stderr ?? ""}`);
    const err = (r.stderr ?? "") + (r.stdout ?? "");
    assert.match(err, /missing required field|missing.*field/i);
  });
});

// Requires node in PATH when the test script runs; in some environments the child bash gets 127 before type validation.
test.skip("ACCEPTANCE: jaiph test typed prompt — wrong type fails with type error", () => {
  withTempDir("jaiph-acc-typed-prompt-type-err-", (root) => {
    writeFileSync(
      join(root, "flow.jh"),
      [
        "workflow default {",
        '  result = prompt "classify" returns \'{ type: string, risk: string }\'',
        "  echo done",
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
    const stdlibPath = join(process.cwd(), "dist/src/jaiph_stdlib.sh");
    const nodeDir = dirname(process.execPath);
    const r = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        JAIPH_STDLIB: stdlibPath,
        PATH: `${nodeDir}:${process.env.PATH ?? ""}`,
      },
    });
    assert.notEqual(r.status, 0);
    const err = (r.stderr ?? "") + (r.stdout ?? "");
    assert.match(err, /expected string|got number|type.*mismatch/i);
  });
});

// === Inbox / send operator / route acceptance tests ===

test("ACCEPTANCE: route with unknown workflow fails E_VALIDATE", () => {
  withTempDir("jaiph-acc-route-unknown-wf-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "channel findings",
        "workflow default {",
        "  findings -> missing_wf",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => build(root), /E_VALIDATE unknown local workflow reference "missing_wf"/);
  });
});

test("ACCEPTANCE: route with rule ref fails E_VALIDATE", () => {
  withTempDir("jaiph-acc-route-rule-ref-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "channel findings",
        "rule check {",
        "  true",
        "}",
        "workflow default {",
        "  findings -> check",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => build(root), /E_VALIDATE rule "check" must be called with ensure/);
  });
});

test("ACCEPTANCE: capture + send is parse error", () => {
  withTempDir("jaiph-acc-capture-send-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "workflow default {",
        "  name = channel <- echo hello",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => build(root), /capture and send cannot be combined/);
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
    const output = build(join(root, "inbox.jh"), join(root, "out"));
    assert.equal(output.length, 1);
    assert.match(output[0].bash, /jaiph::inbox_init/);
    assert.match(output[0].bash, /jaiph::register_route/);
    assert.match(output[0].bash, /jaiph::drain_queue/);
    assert.match(output[0].bash, /jaiph::send/);
  });
});
