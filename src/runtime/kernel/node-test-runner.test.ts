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

test("test runner binds implicit `response` after `run` so expect_equal works without explicit capture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-implicit-response-"));
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });

  try {
    const testFile = join(dir, "implicit.test.jh");
    writeFileSync(
      testFile,
      `workflow greet(name) {
  return "hello \${name}"
}

test "implicit response" {
  run greet("world")
  expect_equal response "hello world"
}
`,
    );

    const exitCode = await runTestFile(testFile, dir, scriptsDir, [
      {
        description: "implicit response", loc,
        steps: [
          { type: "test_run_workflow" as const, workflowRef: "greet", args: ["world"], loc },
          { type: "test_expect_equal" as const, variable: "response", expected: "hello world", loc },
        ],
      },
    ]);

    assert.equal(exitCode, 0, "test should pass via implicit `response` binding");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
