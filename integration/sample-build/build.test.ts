import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScripts } from "../../src/transpiler";

import "./helpers";

test("buildScripts extracts scripts for fixture corpus", () => {
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-build-"));
  try {
    buildScripts(join(process.cwd(), "test-fixtures/sample-build/fixtures"), outDir);
    const scriptsDir = join(outDir, "scripts");
    assert.ok(existsSync(scriptsDir));
    assert.ok(readdirSync(scriptsDir).length > 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build validates imported rule references with deterministic errors", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-invalid-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "./mod.jh" as mod',
        "",
        "script local_impl = `echo ok`",
        "def local() {",
        "  run local_impl()",
        "}",
        "",
        "export def main() {",
        "  run mod.missing()",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "mod.jh"),
      [
        "script existing_impl = `echo hi`",
        "def existing() {",
        "  run existing_impl()",
        "}",
        "",
        "def mod() {",
        "  run existing()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_VALIDATE imported def or script "mod\.missing" does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build fails on missing import file", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-import-missing-"));
  try {
    mkdirSync(join(root, "sub"));
    writeFileSync(
      join(root, "sub/entry.jh"),
      [
        'import "../missing/mod.jh" as mod',
        "",
        "def local() {",
        "  echo ok",
        "}",
        "",
        "def entry() {",
        "  run local()",
        "  run mod.anything()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => buildScripts(root, join(root, "out")), /E_IMPORT_NOT_FOUND import "mod" resolves to missing file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build rejects command substitution in prompt text", () => {
  const rootSubshell = mkdtempSync(join(tmpdir(), "jaiph-build-prompt-subshell-"));
  try {
    writeFileSync(
      join(rootSubshell, "main.jh"),
      [
        "export def main() {",
        '  prompt "literal command substitution: $(echo SHOULD_NOT_RUN)"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(rootSubshell, join(rootSubshell, "out")),
      /E_PARSE prompt cannot contain command substitution/,
    );
  } finally {
    rmSync(rootSubshell, { recursive: true, force: true });
  }
});

test("buildScripts accepts files with no workflows", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-no-workflows-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-no-workflows-out-"));
  try {
    const filePath = join(root, "rules-only.jh");
    writeFileSync(
      filePath,
      [
        "script only_rule_impl = `echo ok`",
        "def only_rule() {",
        "  run only_rule_impl()",
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(filePath, outDir);
    assert.ok(existsSync(join(outDir, "scripts", "only_rule_impl")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("buildScripts extracts scripts for ensure-with-args workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-args-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-args-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "script check_branch_impl = \`\`\`",
        "test \"$1\" = \"main\"",
        "\`\`\`",
        "def check_branch(branch) {",
        "  run check_branch_impl(branch)",
        "}",
        "",
        "export def main(name) {",
        "  run check_branch(name)",
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(filePath, outDir);
    assert.ok(readFileSync(join(outDir, "scripts", "check_branch_impl"), "utf8").includes("test "));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("buildScripts writes multiple script stubs", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-functions-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-functions-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "script changed_files = `printf '%s' 'from-function'`",
        "script print_value = \`\`\`",
        "printf '%s\\n' \"$1\"",
        "\`\`\`",
        "",
        "export def main() {",
        "  const VALUE = run changed_files()",
        '  run print_value(VALUE)',
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(filePath, outDir);
    const names = readdirSync(join(outDir, "scripts")).sort();
    assert.deepEqual(names, ["changed_files", "print_value"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build fails when run in rule references unknown symbol", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-in-rule-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-run-in-rule-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "def bad() {",
        "  run some_workflow()",
        "}",
        "",
        "export def main() {",
        "  run bad()",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(
      () => buildScripts(filePath, outDir),
      /unknown local def or script reference "some_workflow"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build allows run of another def", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-wf-in-rule-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-run-wf-in-rule-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "def helper() {",
        '  log "hi"',
        "}",
        "",
        "def bad() {",
        "  run helper()",
        "}",
        "",
        "export def main() {",
        "  run bad()",
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(filePath, outDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("buildScripts accepts run inside a rule block", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-in-rule-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-in-rule-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "script dep_impl = `echo dep`",
        "def dep() {",
        "  run dep_impl()",
        "}",
        "",
        "export def main() {",
        "  run dep()",
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(filePath, outDir);
    assert.ok(existsSync(join(outDir, "scripts", "dep_impl")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("buildScripts extracts scripts for run ... catch workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-catch-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-catch-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "script dep_impl = `test -f ready.txt`",
        "def dep() {",
        "  run dep_impl()",
        "}",
        "",
        "script install_deps_impl = `touch ready.txt`",
        "",
        "def install_deps() {",
        "  run install_deps_impl()",
        "}",
        "",
        "export def main() {",
        "  run dep() catch (failure) run install_deps()",
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(filePath, outDir);
    assert.ok(readdirSync(join(outDir, "scripts")).includes("install_deps_impl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build accepts run catch body with raw shell lines", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-catch-block-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-catch-block-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "script ready_impl = `test -f ready.txt`",
        "def ready() {",
        "  run ready_impl()",
        "}",
        "",
        "export def main() {",
        "  run ready() catch (failure) { echo fixing; touch ready.txt; }",
        "}",
        "",
      ].join("\n"),
    );

    buildScripts(filePath, outDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("buildScripts accepts multiline raw shell in workflow (assignment-style lines)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-assign-fail-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-assign-fail-out-"));
  try {
    const filePath = join(root, "entry.jh");
    writeFileSync(
      filePath,
      [
        "export def main() {",
        "  out = false",
        "  echo done",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(filePath, outDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
