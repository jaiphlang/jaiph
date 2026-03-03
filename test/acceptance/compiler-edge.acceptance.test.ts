import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    assert.throws(() => build(root), /E_VALIDATE unknown local workflow reference "missing_workflow"/);
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

    assert.throws(() => build(root), /E_PARSE run must target a workflow reference/);
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

    assert.throws(() => build(root), /E_VALIDATE imported workflow "lib\.missing" does not exist/);
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

test("ACCEPTANCE: if ! ensure block must terminate with fi", () => {
  withTempDir("jaiph-acc-if-fi-", (root) => {
    writeFileSync(
      join(root, "main.jh"),
      [
        "rule gate {",
        "  false",
        "}",
        "",
        "workflow default {",
        "  if ! ensure gate; then",
        "    echo fallback",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_PARSE unterminated if-block, expected "fi"/);
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
