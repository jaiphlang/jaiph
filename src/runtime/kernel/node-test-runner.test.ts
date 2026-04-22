import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTestFile } from "./node-test-runner";
import type { SourceLoc } from "../../types";

const loc: SourceLoc = { line: 1, col: 1 };

test("multiple test blocks with test_run_workflow share a single graph build", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-cache-test-"));
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });

  try {
    const testFile = join(dir, "multi.test.jh");
    writeFileSync(
      testFile,
      `workflow greet() {
  log "hello"
}

test "block A" {
  run greet()
}

test "block B" {
  run greet()
}
`,
    );

    // Run two blocks that each invoke test_run_workflow.
    // Before this change, buildRuntimeGraph would be called once per
    // test_run_workflow step (2 calls). After caching, it is called once.
    // We verify behavioral correctness: both blocks pass with the shared graph.
    const exitCode = await runTestFile(testFile, dir, scriptsDir, [
      {
        description: "block A", loc,
        steps: [{ type: "test_run_workflow" as const, workflowRef: "greet", args: [], loc }],
      },
      {
        description: "block B", loc,
        steps: [{ type: "test_run_workflow" as const, workflowRef: "greet", args: [], loc }],
      },
    ]);

    assert.equal(exitCode, 0, "both blocks should pass with shared graph");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test runner resolves `const` bindings inside `mock prompt <ident>` and `expect_equal var <ident>`", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-const-binding-"));
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });

  try {
    const testFile = join(dir, "consts.test.jh");
    writeFileSync(
      testFile,
      `workflow ask() {
  const r = prompt "say hi"
  return r
}

test "const drives mock and expect" {
  const expected = "Hello Alice!"
  mock prompt expected
  const response = run ask()
  expect_equal response expected
}
`,
    );

    const exitCode = await runTestFile(testFile, dir, scriptsDir, [
      {
        description: "const drives mock and expect", loc,
        steps: [
          { type: "test_const" as const, name: "expected", value: "Hello Alice!", loc },
          { type: "test_mock_prompt" as const, response: "", responseVar: "expected", loc },
          { type: "test_run_workflow" as const, captureName: "response", workflowRef: "ask", args: [], loc },
          {
            type: "test_expect_equal" as const,
            variable: "response",
            expected: "",
            expectedVar: "expected",
            loc,
          },
        ],
      },
    ]);

    assert.equal(exitCode, 0, "test should pass when const value flows into mock and expect_equal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test runner reports a clear error when an expect_* step references an undefined const", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-undefined-const-"));
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });

  try {
    const testFile = join(dir, "missing.test.jh");
    writeFileSync(
      testFile,
      `workflow noop() {
  return "v"
}

test "undefined const ref" {
  const response = run noop()
  expect_equal response missing
}
`,
    );

    const exitCode = await runTestFile(testFile, dir, scriptsDir, [
      {
        description: "undefined const ref", loc,
        steps: [
          { type: "test_run_workflow" as const, captureName: "response", workflowRef: "noop", args: [], loc },
          {
            type: "test_expect_equal" as const,
            variable: "response",
            expected: "",
            expectedVar: "missing",
            loc,
          },
        ],
      },
    ]);

    assert.notEqual(exitCode, 0, "test should fail when referencing an undefined const");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test runner rejects bare `response` reference when `run` was not captured (no implicit binding)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-no-implicit-response-"));
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });

  try {
    const testFile = join(dir, "no_implicit.test.jh");
    writeFileSync(
      testFile,
      `workflow greet(name) {
  return "hello \${name}"
}

test "no implicit response" {
  run greet("world")
  expect_equal response "hello world"
}
`,
    );

    const exitCode = await runTestFile(testFile, dir, scriptsDir, [
      {
        description: "no implicit response", loc,
        steps: [
          { type: "test_run_workflow" as const, workflowRef: "greet", args: ["world"], loc },
          { type: "test_expect_equal" as const, variable: "response", expected: "hello world", loc },
        ],
      },
    ]);

    assert.notEqual(
      exitCode,
      0,
      "test should fail because `response` was never captured — there is no implicit alias",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
