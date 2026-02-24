import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "../src/transpiler";

test("build transpiles .jh into strict bash with retry flow", () => {
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-build-"));
  try {
    const results = build(join(process.cwd(), "test/fixtures"), outDir);
    assert.equal(results.length, 3);

    const stdlib = readFileSync(join(outDir, "jaiph_stdlib.sh"), "utf8");
    assert.match(stdlib, /jaiph__version\(\)/);
    assert.match(stdlib, /jaiph__prompt\(\)/);
    assert.match(stdlib, /jaiph__execute_readonly\(\)/);
    assert.match(stdlib, /jaiph__run_step\(\)/);
    assert.match(stdlib, /sudo env JAIPH_PRECEDING_FILES="\$JAIPH_PRECEDING_FILES" unshare -m bash -c/);

    const generatedPath = join(outDir, "main.sh");
    const generated = readFileSync(generatedPath, "utf8");

    assert.match(generated, /set -euo pipefail/);
    assert.ok(generated.includes('source "$(dirname "${BASH_SOURCE[0]}")/jaiph_stdlib.sh"'));
    assert.match(generated, /# Validates local build prerequisites\./);
    assert.match(generated, /# Orchestrates checks, prompt execution, and docs refresh\./);
    assert.match(generated, /main__rule_project_ready\(\) \{/);
    assert.match(generated, /main__rule_project_ready__impl\(\) \{/);
    assert.match(generated, /jaiph__run_step main__rule_project_ready jaiph__execute_readonly main__rule_project_ready__impl/);
    assert.match(generated, /if ! main__rule_project_ready; then/);
    assert.match(generated, /bootstrap_project__workflow_nodejs/);
    assert.match(generated, /jaiph__prompt "/);
    assert.match(generated, /main__rule_build_passes\(\)/);
    assert.match(generated, /tools__security__rule_scan_passes/);
    assert.match(generated, /main__workflow_update_docs/);
    assert.match(generated, /main__workflow_default__impl\(\) \{/);
    assert.match(generated, /jaiph__run_step main__workflow_default main__workflow_default__impl "\$@"/);

    const securityGenerated = readFileSync(join(outDir, "tools/security.sh"), "utf8");
    assert.match(securityGenerated, /tools__security__rule_scan_passes\(\) \{/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build validates imported rule references with deterministic errors", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-invalid-"));
  try {
    writeFileSync(
      join(root, "main.jrh"),
      [
        'import "./mod.jph" as mod',
        "",
        "rule local {",
        "  echo ok",
        "}",
        "",
        "workflow main {",
        "  ensure mod.missing",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "mod.jph"),
      [
        "rule existing {",
        "  echo hi",
        "}",
        "",
        "workflow mod {",
        "  ensure existing",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_VALIDATE imported rule "mod\.missing" does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build fails on missing import file", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-import-missing-"));
  try {
    mkdirSync(join(root, "sub"));
    writeFileSync(
      join(root, "sub/entry.jrh"),
      [
        'import "../missing/mod.jph" as mod',
        "",
        "rule local {",
        "  echo ok",
        "}",
        "",
        "workflow entry {",
        "  ensure local",
        "  ensure mod.anything",
        "}",
        "",
      ].join("\n"),
    );

    assert.throws(() => build(root), /E_IMPORT_NOT_FOUND import "mod" resolves to missing file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run compiles and executes workflow with args", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-"));
  try {
    const filePath = join(root, "echo.jrh");
    writeFileSync(
      filePath,
      [
        "workflow default {",
        "  printf '%s\\n' \"$1\"",
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath, "hello-run"], {
      encoding: "utf8",
      cwd: root,
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /workflow default/);
    assert.match(runResult.stdout, /✓ PASS workflow default \(\d+ms\)/);
    assert.match(runResult.stdout, /hello-run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run fails when workflow default is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-missing-default-"));
  try {
    const filePath = join(root, "pr.jph");
    writeFileSync(
      filePath,
      [
        "workflow main {",
        "  printf 'fallback:%s\\n' \"$1\"",
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath, "hello-main"], {
      encoding: "utf8",
      cwd: root,
    });

    assert.equal(runResult.status, 1);
    assert.match(runResult.stderr, /requires workflow 'default'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run prints rule tree and fail summary", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-tree-fail-"));
  try {
    const filePath = join(root, "fail.jph");
    writeFileSync(
      filePath,
      [
        "rule current_branch {",
        "  echo \"Current branch is not 'main'.\" >&2",
        "  exit 1",
        "}",
        "",
        "workflow default {",
        "  ensure current_branch",
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
    });

    assert.equal(runResult.status, 1);
    assert.match(runResult.stdout, /workflow default/);
    assert.match(runResult.stdout, /└── rule current_branch/);
    assert.match(runResult.stderr, /✗ FAIL workflow default \(\d+ms\)/);
    assert.match(runResult.stderr, /Current branch is not 'main'\./);
    assert.match(runResult.stderr, /Logs: /);
    assert.match(runResult.stderr, /out: /);
    assert.match(runResult.stderr, /err: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("build accepts files with no workflows", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-no-workflows-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-no-workflows-out-"));
  try {
    const filePath = join(root, "rules-only.jph");
    writeFileSync(
      filePath,
      [
        "rule only_rule {",
        "  echo ok",
        "}",
        "",
      ].join("\n"),
    );

    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    assert.match(results[0].bash, /rule_only_rule/);
    assert.doesNotMatch(results[0].bash, /__workflow_/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("build transpiles ensure statements with arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-ensure-args-"));
  const outDir = mkdtempSync(join(tmpdir(), "jaiph-ensure-args-out-"));
  try {
    const filePath = join(root, "entry.jph");
    writeFileSync(
      filePath,
      [
        "rule check_branch {",
        "  test \"$1\" = \"main\"",
        "}",
        "",
        "workflow default {",
        "  ensure check_branch \"$1\"",
        "}",
        "",
      ].join("\n"),
    );

    const results = build(filePath, outDir);
    assert.equal(results.length, 1);
    assert.match(
      results[0].bash,
      /jaiph__run_step entry__rule_check_branch jaiph__execute_readonly entry__rule_check_branch__impl "\$@"/,
    );
    assert.match(results[0].bash, /entry__rule_check_branch "\$1"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
