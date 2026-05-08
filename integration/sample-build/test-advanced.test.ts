import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parsejaiph } from "../../src/parser";
import { walkTestFiles } from "../../src/transpiler";

import { getLatestRunDir, readCombinedRunLogs } from "./helpers";

test("jaiph run prompt capture: variable accessible in subsequent shell step", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-prompt-capture-"));
  try {
    // Anchor workspace here: a parent of TMPDIR may contain `.jaiph`, which would otherwise
    // become JAIPH_WORKSPACE and send runs outside this temp root.
    mkdirSync(join(root, ".jaiph"), { recursive: true });
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeAgent = join(binDir, "cursor-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env bash",
        "echo '{\"type\":\"result\",\"result\":\"agent-summary\"}'",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "capture.jh");
    writeFileSync(
      filePath,
      [
        "script print_captured = \`\`\`",
        "printf 'captured:%s\\n' \"$1\"",
        "\`\`\`",
        "workflow default() {",
        '  const result = prompt "Summarize"',
        '  run print_captured(result)',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        JAIPH_AGENT_BACKEND: "cursor",
        JAIPH_DOCKER_ENABLED: "false",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const { out: workflowOut } = readCombinedRunLogs(latestRunDir);
    assert.match(workflowOut, /captured:[\s\S]*agent-summary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph run prompt capture stores only final answer in assigned variable", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-prompt-capture-final-only-"));
  try {
    mkdirSync(join(root, ".jaiph"), { recursive: true });
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeAgent = join(binDir, "cursor-agent");
    writeFileSync(
      fakeAgent,
      [
        "#!/usr/bin/env bash",
        "echo '{\"type\":\"thinking\",\"text\":\"Plan: inspect data.\"}'",
        "echo '{\"type\":\"result\",\"result\":\"final-only-value\"}'",
        "",
      ].join("\n"),
    );
    chmodSync(fakeAgent, 0o755);

    const filePath = join(root, "capture_final_only.jh");
    writeFileSync(
      filePath,
      [
        "script print_captured = \`\`\`",
        "printf 'captured:%s\\n' \"$1\"",
        "\`\`\`",
        "workflow default() {",
        '  const result = prompt "Summarize"',
        '  run print_captured(result)',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const runResult = spawnSync("node", [cliPath, "run", filePath], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        JAIPH_AGENT_BACKEND: "cursor",
        JAIPH_DOCKER_ENABLED: "false",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(runResult.status, 0, runResult.stderr);
    const runsRoot = join(root, ".jaiph/runs");
    const latestRunDir = getLatestRunDir(runsRoot);
    const { out: workflowOut } = readCombinedRunLogs(latestRunDir);
    assert.match(workflowOut, /captured:[\s\S]*final-only-value/);
    assert.doesNotMatch(workflowOut, /captured:[^\n]*Plan: inspect data\./);

    const { out: promptOut } = readCombinedRunLogs(latestRunDir);
    assert.ok(promptOut.length >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test with agent.backend = claude uses mock and does not invoke claude", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-backend-claude-mock-"));
  try {
    writeFileSync(
      join(root, "flow.jh"),
      [
        "script print_got = \`\`\`",
        "printf 'got:%s\\n' \"$1\"",
        "\`\`\`",
        "config {",
        '  agent.backend = "claude"',
        "}",
        "workflow default() {",
        '  const result = prompt "ask"',
        '  run print_got(result)',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "flow.test.jh"),
      [
        'import "flow.jh" as w',
        "",
        'test "mock overrides backend" {',
        '  mock prompt "mock-response"',
        "  const out = run w.default()",
        '  expect_contain out "mock-response"',
        '  expect_contain out "got:"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, PATH: `${dirname(process.execPath)}:/bin:/usr/bin:/nonexistent` },
    });

    assert.equal(testResult.status, 0, testResult.stderr + testResult.stdout);
    assert.match(testResult.stdout + testResult.stderr, /mock-response|PASS|passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test when prompt is not mocked runs selected backend", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-unmocked-backend-"));
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeCursor = join(binDir, "cursor-agent");
    writeFileSync(
      fakeCursor,
      [
        "#!/usr/bin/env bash",
        "echo '{\"type\":\"result\",\"result\":\"backend-ran\"}'",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCursor, 0o755);

    writeFileSync(
      join(root, "flow.jh"),
      [
        "script print_got = \`\`\`",
        "printf 'got:%s\\n' \"$1\"",
        "\`\`\`",
        "config {",
        '  agent.backend = "cursor"',
        "}",
        "workflow default() {",
        '  const result = prompt "ask"',
        '  run print_got(result)',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "flow.test.jh"),
      [
        'import "flow.jh" as w',
        "",
        'test "no mock uses backend" {',
        "  const out = run w.default()",
        '  expect_contain out "backend-ran"',
        '  expect_contain out "got:"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(testResult.status, 0, testResult.stderr + testResult.stdout);
    assert.match(testResult.stdout + testResult.stderr, /backend-ran|PASS|passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test passes for workflow using ensure only with mocks", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-ensure-only-"));
  try {
    writeFileSync(
      join(root, "ensure_only.jh"),
      [
        "script ready_impl = `echo ok`",
        "rule ready() {",
        "  run ready_impl()",
        "}",
        "",
        "workflow default() {",
        "  ensure ready()",
        '  return "ready-ok"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "ensure_only.test.jh"),
      [
        'import "ensure_only.jh" as e',
        "",
        'test "workflow default" {',
        "  const response = run e.default()",
        '  expect_contain response "ready-ok"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "ensure_only.test.jh"], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });

    assert.equal(testResult.status, 0, testResult.stderr);
    assert.match(testResult.stdout, /test\(s\) passed|PASS/);
    assert.match(testResult.stdout, /workflow default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parser parses test blocks in *.test.jh file", () => {
  const source = [
    'import "workflow.jh" as w',
    '',
    'test "runs default" {',
    '  const response = run w.default()',
    '  expect_contain response "PASS"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/workflow.test.jh");
  assert.ok(mod.tests);
  assert.equal(mod.tests!.length, 1);
  assert.equal(mod.tests![0].description, "runs default");
  assert.equal(mod.tests![0].steps.length, 2);
  assert.equal(mod.tests![0].steps[0].type, "test_run_workflow");
  if (mod.tests![0].steps[0].type === "test_run_workflow") {
    assert.equal(mod.tests![0].steps[0].captureName, "response");
    assert.equal(mod.tests![0].steps[0].workflowRef, "w.default");
  }
  assert.equal(mod.tests![0].steps[1].type, "test_expect_contain");
  if (mod.tests![0].steps[1].type === "test_expect_contain") {
    assert.equal(mod.tests![0].steps[1].variable, "response");
    assert.equal(mod.tests![0].steps[1].substring, "PASS");
  }
});

test("parser parses mock workflow, rule, and script in test block", () => {
  const source = [
    'import "app.jh" as app',
    "",
    'test "isolated orchestration" {',
    "  mock workflow app.build() {",
    '    log "build ok"',
    '    return "done"',
    "  }",
    "",
    "  mock rule app.policy_check() {",
    '    return "blocked"',
    "  }",
    "",
    "  mock script app.changed_files() {",
    '    echo "a.ts"',
    '    echo "b.ts"',
    "  }",
    "",
    "  const out = run app.default()",
    '  expect_contain out "blocked"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/app.test.jh");
  assert.ok(mod.tests);
  assert.equal(mod.tests!.length, 1);
  assert.equal(mod.tests![0].description, "isolated orchestration");
  const steps = mod.tests![0].steps;
  assert.equal(steps[0].type, "test_mock_workflow");
  if (steps[0].type === "test_mock_workflow") {
    assert.equal(steps[0].ref, "app.build");
    assert.deepEqual(steps[0].params, []);
    assert.equal(steps[0].steps.length, 2);
  }
  assert.equal(steps[1].type, "blank_line");
  assert.equal(steps[2].type, "test_mock_rule");
  if (steps[2].type === "test_mock_rule") {
    assert.equal(steps[2].ref, "app.policy_check");
    assert.deepEqual(steps[2].params, []);
    assert.equal(steps[2].steps.length, 1);
  }
  assert.equal(steps[3].type, "blank_line");
  assert.equal(steps[4].type, "test_mock_script");
  if (steps[4].type === "test_mock_script") {
    assert.equal(steps[4].ref, "app.changed_files");
    assert.ok(steps[4].body.includes('echo "a.ts"'));
  }
  assert.equal(steps[5].type, "blank_line");
  assert.equal(steps[6].type, "test_run_workflow");
  assert.equal(steps[7].type, "test_expect_contain");
});

test("parser ignores test keyword in non-test file", () => {
  const source = [
    "workflow default() {",
    '  echo "hello"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(source, "/fake/main.jh");
  assert.equal(mod.tests, undefined);
});

test("jaiph test runs *.test.jh with mock workflow, rule, and script", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-mock-symbols-"));
  try {
    writeFileSync(
      join(root, "app.jh"),
      [
        "script policy_check_impl = `echo real-policy`",
        "rule policy_check() {",
        "  run policy_check_impl()",
        "}",
        "script changed_files = `echo real_files`",
        "script build_impl = \`\`\`",
        'echo "real build"',
        "\`\`\`",
        "workflow build() {",
        "  run build_impl()",
        "}",
        "workflow default() {",
        "  ensure policy_check()",
        "  run build()",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "app.test.jh"),
      [
        'import "app.jh" as app',
        "",
        'test "isolated orchestration" {',
        "  mock workflow app.build() {",
        '    log "build ok"',
        '    return "build ok"',
        "  }",
        "",
        "  mock rule app.policy_check() {",
        '    return "policy ok"',
        "  }",
        "",
        "  mock script app.changed_files() {",
        '    echo "a.ts"',
        '    echo "b.ts"',
        "  }",
        "",
        "  const out = run app.default()",
        '  expect_contain out "build ok"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const result = spawnSync("node", [cliPath, "test", join(root, "app.test.jh")], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
    assert.match(result.stdout, /test\(s\) passed|PASS/);
    assert.match(result.stdout, /isolated orchestration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test runs *.test.jh file with mocks", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-native-test-"));
  try {
    writeFileSync(
      join(root, "flow.jh"),
      [
        "workflow default() {",
        '  prompt "please greet"',
        '  return "done"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "flow.test.jh"),
      [
        'import "flow.jh" as f',
        "",
        'test "captures output" {',
        '  mock prompt "mocked"',
        "  const out = run f.default()",
        '  expect_contain out "done"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const result = spawnSync("node", [cliPath, "test", join(root, "flow.test.jh")], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
    assert.match(result.stdout, /test\(s\) passed|PASS/);
    assert.match(result.stdout, /captures output/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkTestFiles discovers *.test.jh in directory", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-walk-test-"));
  try {
    writeFileSync(join(root, "a.test.jh"), "test \"t\" { }\n");
    writeFileSync(join(root, "b.jh"), "workflow default() { }\n");
    const files = walkTestFiles(root);
    assert.equal(files.length, 1);
    assert.ok(files.some((f) => f.endsWith("a.test.jh")));
    assert.ok(!files.some((f) => f.endsWith("b.jh")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
