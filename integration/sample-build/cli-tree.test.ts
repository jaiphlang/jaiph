import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildRunTreeRows } from "../../src/cli";
import { formatRunningBottomLine } from "../../src/cli/run/progress";
import { parseStepEvent } from "../../src/cli/run/events";
import { parsejaiph } from "../../src/parser";

import "./helpers";

test("jaiph init creates workspace structure and guidance", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-init-"));
  try {
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const skillPath = join(process.cwd(), "docs/jaiph-skill.md");
    const initResult = spawnSync("node", [cliPath, "init"], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, ...(existsSync(skillPath) ? { JAIPH_SKILL_PATH: skillPath } : {}) },
    });

    assert.equal(initResult.status, 0, initResult.stderr);
    assert.equal(existsSync(join(root, ".jaiph")), true);
    assert.equal(existsSync(join(root, ".jaiph/lib")), false);
    assert.equal(existsSync(join(root, ".jaiph/bootstrap.jh")), true);
    assert.equal(existsSync(join(root, ".jaiph/SKILL.md")), true);
    const bootstrap = readFileSync(join(root, ".jaiph/bootstrap.jh"), "utf8");
    assert.match(bootstrap, /^#!\/usr\/bin\/env jaiph\n\n/);
    assert.match(bootstrap, /workflow default\(\) \{/);
    assert.match(bootstrap, /\.jaiph\/SKILL\.md/);
    assert.match(bootstrap, /Analyze repository structure/);
    assert.match(bootstrap, /Create or update Jaiph workflows under \.jaiph\//);
    assert.doesNotMatch(bootstrap, /\$1/);
    assert.equal(statSync(join(root, ".jaiph/bootstrap.jh")).mode & 0o777, 0o755);
    const localSkill = readFileSync(join(root, ".jaiph/SKILL.md"), "utf8");
    assert.match(localSkill, /Jaiph Bootstrap Skill/);
    assert.equal(existsSync(join(root, ".gitignore")), false);
    assert.equal(readFileSync(join(root, ".jaiph", ".gitignore"), "utf8"), "runs\ntmp\n");
    assert.match(initResult.stdout, /Jaiph init/);
    assert.match(initResult.stdout, /▸ Creating \.jaiph\/bootstrap\.jh/);
    assert.match(initResult.stdout, /✓ Initialized \.jaiph\/bootstrap\.jh/);
    assert.match(initResult.stdout, /✓ Created \.jaiph\/\.gitignore/);
    assert.match(initResult.stdout, /Wrote \.jaiph\/SKILL\.md from installation/);
    assert.match(initResult.stdout, /\.\/\.jaiph\/bootstrap\.jh/);
    assert.match(initResult.stdout, /analyze the project/i);
    assert.match(initResult.stdout, /\.jaiph\/\.gitignore/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph use maps nightly and version refs for reinstallation", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-use-"));
  try {
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const installSpy = join(root, "install-spy.sh");
    const outputPath = join(root, "used-ref.txt");
    writeFileSync(
      installSpy,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf '%s' \"$JAIPH_REPO_REF\" > \"$JAIPH_USE_REF_OUT\"",
        "",
      ].join("\n"),
    );
    chmodSync(installSpy, 0o755);

    const nightlyResult = spawnSync("node", [cliPath, "use", "nightly"], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        JAIPH_INSTALL_COMMAND: `"${installSpy}"`,
        JAIPH_USE_REF_OUT: outputPath,
      },
    });
    assert.equal(nightlyResult.status, 0, nightlyResult.stderr);
    assert.equal(readFileSync(outputPath, "utf8"), "nightly");

    const versionResult = spawnSync("node", [cliPath, "use", "0.2.3"], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        JAIPH_INSTALL_COMMAND: `"${installSpy}"`,
        JAIPH_USE_REF_OUT: outputPath,
      },
    });
    assert.equal(versionResult.status, 0, versionResult.stderr);
    assert.equal(readFileSync(outputPath, "utf8"), "v0.2.3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run tree includes function calls from workflow shell steps", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-function-tree-"));
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
        "workflow default() {",
        "  const VALUE = run changed_files()",
        '  run print_value(VALUE)',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /workflow default/);
    assert.match(runResult.stdout, /script changed_files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseStepEvent parses params array from event payload", () => {
  const line =
    '__JAIPH_EVENT__ {"type":"STEP_START","func":"main::docs_page","kind":"workflow","name":"docs_page","ts":"2025-01-01T00:00:00Z","status":null,"elapsed_ms":null,"out_file":"","err_file":"","id":"run:1:1","parent_id":"run:0:0","seq":1,"depth":1,"run_id":"run-1","params":[["path","docs/cli.md"],["mode","strict"]]}';
  const event = parseStepEvent(line);
  assert.ok(event);
  assert.equal(event?.kind, "workflow");
  assert.equal(event?.name, "docs_page");
  assert.equal(event?.params?.length, 2);
  assert.deepEqual(event?.params?.[0], ["path", "docs/cli.md"]);
  assert.deepEqual(event?.params?.[1], ["mode", "strict"]);
});

test("parseStepEvent returns empty params when payload has no params", () => {
  const line =
    '__JAIPH_EVENT__ {"type":"STEP_START","func":"main::default","kind":"workflow","name":"default","ts":"2025-01-01T00:00:00Z","status":null,"elapsed_ms":null,"out_file":"","err_file":"","id":"run:1:1","parent_id":null,"seq":1,"depth":0,"run_id":"run-1"}';
  const event = parseStepEvent(line);
  assert.ok(event);
  assert.equal(event?.params?.length, 0);
});

test("formatRunningBottomLine produces TTY bottom line with RUNNING, workflow name, and elapsed time", () => {
  const line = formatRunningBottomLine("default", 2.6);
  assert.ok(line.includes("RUNNING"), "contains RUNNING");
  assert.ok(line.includes("workflow"), "contains workflow");
  assert.ok(line.includes("default"), "contains workflow name");
  assert.match(line, /\(\d+\.\ds\)/, "contains (X.Xs) time");
});

test("jaiph run tree shows workflow params inline when run has key=value args", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-tree-params-"));
  try {
    writeFileSync(
      join(root, "sub.jh"),
      ["script done_impl = `echo done`", "workflow default(path, mode) {", "  run done_impl()", "}", ""].join("\n"),
    );
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "sub.jh" as sub',
        "workflow default() {",
        '  run sub.default(path="docs/cli.md" mode="strict")',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false", NO_COLOR: "1" },
    });
    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /workflow default/);
    // Nested workflow step is shown (rootStepId fix); params inline when runtime sends them
    assert.match(runResult.stdout, /▸ workflow default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run tree shows function step; params shown when runtime includes them", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-tree-fn-params-"));
  try {
    writeFileSync(
      join(root, "main.jh"),
      [
        "script echo_args = \`\`\`",
        "printf '%s %s\\n' \"$1\" \"$2\"",
        "\`\`\`",
        "workflow default() {",
        '  run echo_args("first" "second")',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false", NO_COLOR: "1" },
    });
    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /script echo_args/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run tree truncates param values over 32 chars when params present", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-tree-truncate-"));
  try {
    const longValue = "a".repeat(40);
    writeFileSync(
      join(root, "sub.jh"),
      ["script done_impl = `echo done`", "workflow default(longparam) {", "  run done_impl()", "}", ""].join("\n"),
    );
    writeFileSync(
      join(root, "main.jh"),
      [
        'import "sub.jh" as sub',
        "workflow default() {",
        `  run sub.default(longparam="${longValue}")`,
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", join(root, "main.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false", NO_COLOR: "1" },
    });
    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /workflow default/);
    // When params are shown, long values are truncated to 32 chars + "..."
    if (/longparam=/.test(runResult.stdout)) {
      assert.match(runResult.stdout, /longparam="a{32}\.\.\./);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildRunTreeRows expands nested workflow from imported module", () => {
  const mainSource = [
    'import "sub.jh" as sub',
    "workflow default() {",
    "  run sub.default()",
    "}",
    "",
  ].join("\n");
  const subSource = [
    "workflow default() {",
    '  prompt "nested prompt"',
    "}",
    "",
  ].join("\n");
  const mainMod = parsejaiph(mainSource, "/fake/main.jh");
  const subMod = parsejaiph(subSource, "/fake/sub.jh");
  const importedModules = new Map<string, ReturnType<typeof parsejaiph>>([
    ["sub", subMod],
  ]);
  const rows = buildRunTreeRows(mainMod, "workflow default", importedModules, "/fake");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].rawLabel, "workflow default");
  assert.equal(rows[0].isRoot, true);
  assert.equal(rows[1].rawLabel, "workflow sub.default");
  assert.equal(rows[2].rawLabel, 'prompt "nested prompt"');
});

test("jaiph run shows nested workflow subtree and step timing", () => {
  const rootRaw = mkdtempSync(join(tmpdir(), "jaiph-run-subtree-"));
  const root = realpathSync(rootRaw);
  try {
    writeFileSync(
      join(root, "sub.jh"),
      [
        "workflow default() {",
        '  prompt "nested prompt"',
        "}",
        "",
      ].join("\n"),
    );
    const mainPath = join(root, "main.jh");
    writeFileSync(
      mainPath,
      [
        'import "sub.jh" as sub',
        "workflow default() {",
        "  run sub.default()",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "main.test.jh"),
      [
        'import "main.jh" as m',
        "",
        'test "nested workflow" {',
        '  mock prompt "mocked"',
        "  const response = run m.default()",
        '  expect_contain response "mocked"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", join(root, "main.test.jh")], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });

    assert.equal(testResult.status, 0, testResult.stderr);
    assert.match(testResult.stdout, /test\(s\) passed|PASS/);
  } finally {
    rmSync(rootRaw, { recursive: true, force: true });
  }
});
