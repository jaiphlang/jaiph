import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import "./helpers";

test("jaiph test runs workflow with mocked prompts", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-mock-"));
  try {
    writeFileSync(
      join(root, "hello.jh"),
      [
        "workflow default() {",
        '  prompt "Please greet the user"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "hello.test.jh"),
      [
        'import "hello.jh" as h',
        "",
        'test "workflow default" {',
        '  mock prompt "Mocked greeting output"',
        "  const response = run h.default()",
        '  expect_contain response "Mocked greeting output"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "hello.test.jh"], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });

    assert.equal(testResult.status, 0, testResult.stderr);
    assert.match(testResult.stdout, /test\(s\) passed|PASS/);
    assert.match(testResult.stdout, /test happy path|workflow default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test fails when no mock matches prompt", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-no-mock-"));
  try {
    writeFileSync(
      join(root, "hello.jh"),
      [
        "workflow default() {",
        '  prompt "Please greet the user"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "hello.test.jh"),
      [
        'import "hello.jh" as h',
        "",
        'test "no mock for prompt" {',
        "  const response = run h.default()",
        '  expect_contain response "no mock"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "hello.test.jh"], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:/bin:/usr/bin`,
      },
    });

    assert.equal(testResult.status, 1, "expected test run to fail when prompt has no mock");
    assert.match(testResult.stderr + testResult.stdout, /expect_contain failed|FAIL|no mock|not found|command not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test fails when non-test file is passed", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-missing-mock-"));
  try {
    writeFileSync(
      join(root, "hello.jh"),
      [
        "workflow default() {",
        '  prompt "hello"',
        "}",
        "",
      ].join("\n"),
    );
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "hello.jh"], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });
    assert.equal(testResult.status, 1);
    assert.match(testResult.stderr, /\.test\.jh|inline mock/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test captures mock response into variable and variable is available in subsequent step", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-prompt-capture-"));
  try {
    writeFileSync(
      join(root, "capture.jh"),
      [
        "workflow default() {",
        '  const result = prompt "Please greet the user"',
        '  return "${result}"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "capture.test.jh"),
      [
        'import "capture.jh" as c',
        "",
        'test "capture mock" {',
        '  mock prompt "CAPTURED_MOCK_OUTPUT"',
        "  const response = run c.default()",
        '  expect_contain response "CAPTURED_MOCK_OUTPUT"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "capture.test.jh"], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });

    assert.equal(testResult.status, 0, testResult.stderr);
    assert.match(testResult.stdout, /test\(s\) passed|PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test inline mock prompt block with if/elif/else and first-match", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-mock-block-"));
  try {
    writeFileSync(
      join(root, "multi_prompt.jh"),
      [
        "workflow default() {",
        '  const a = prompt "greet"',
        '  const b = prompt "bye"',
        '  return "${a} ${b}"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "multi_prompt.test.jh"),
      [
        'import "multi_prompt.jh" as m',
        "",
        'test "mock block first-match" {',
        "  mock prompt {",
        '    /greet/ => "hello"',
        '    /bye/ => "goodbye"',
        '    _ => "default"',
        "  }",
        "  const out = run m.default()",
        '  expect_contain out "hello"',
        '  expect_contain out "goodbye"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "multi_prompt.test.jh"], {
      encoding: "utf8",
      cwd: root,
      env: process.env,
    });

    assert.equal(testResult.status, 0, testResult.stderr + testResult.stdout);
    assert.match(testResult.stdout, /test\(s\) passed|PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jaiph test fails when no mock branch matches and no wildcard", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-test-mock-no-else-"));
  try {
    writeFileSync(
      join(root, "single.jh"),
      [
        "workflow default() {",
        '  const result = prompt "unmatched prompt text"',
        '  return "${result}"',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "single.test.jh"),
      [
        'import "single.jh" as s',
        "",
        'test "no wildcard arm" {',
        "  mock prompt {",
        '    /other/ => "never"',
        "  }",
        "  const out = run s.default()",
        '  expect_contain out "x"',
        "}",
        "",
      ].join("\n"),
    );

    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const testResult = spawnSync("node", [cliPath, "test", "single.test.jh"], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:/bin:/usr/bin`,
      },
    });

    assert.equal(testResult.status, 1, "expected test to fail when no branch matches, no wildcard, and no backend in PATH");
    assert.match(
      testResult.stderr + testResult.stdout,
      /workflow exited with status|no mock matched|no branch matched|expect_contain failed|FAIL|not found|command not found/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
