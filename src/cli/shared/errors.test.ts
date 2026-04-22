import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  summarizeError,
  resolveFailureDetails,
  hasFatalRuntimeStderr,
  extractRunMeta,
  latestRunFiles,
  readFailedStepOutput,
  failedStepArtifactPaths,
  discoverDockerRunDir,
} from "./errors";

// === summarizeError ===

test("summarizeError: returns last non-empty line of stderr", () => {
  assert.equal(summarizeError("line one\nline two\nlast line"), "last line");
});

test("summarizeError: trims whitespace from lines", () => {
  assert.equal(summarizeError("  \n  error here  \n  "), "error here");
});

test("summarizeError: returns fallback when stderr is empty", () => {
  assert.equal(summarizeError(""), "Workflow execution failed.");
});

test("summarizeError: returns custom fallback when stderr is empty", () => {
  assert.equal(summarizeError("", "custom fallback"), "custom fallback");
});

test("summarizeError: returns fallback when stderr is only whitespace", () => {
  assert.equal(summarizeError("   \n  \n  "), "Workflow execution failed.");
});

test("summarizeError: handles \\r\\n line endings", () => {
  assert.equal(summarizeError("first\r\nsecond\r\nthird"), "third");
});

// === hasFatalRuntimeStderr ===

test("hasFatalRuntimeStderr: returns false when debug is enabled", () => {
  assert.equal(hasFatalRuntimeStderr("some error", true), false);
});

test("hasFatalRuntimeStderr: returns false for empty stderr", () => {
  assert.equal(hasFatalRuntimeStderr("", false), false);
});

test("hasFatalRuntimeStderr: returns false for whitespace-only stderr", () => {
  assert.equal(hasFatalRuntimeStderr("   \n  ", false), false);
});

test("hasFatalRuntimeStderr: returns true for non-empty stderr when debug is off", () => {
  assert.equal(hasFatalRuntimeStderr("error occurred", false), true);
});

// === extractRunMeta ===

test("extractRunMeta: extracts status from meta line", () => {
  const output = "visible line\n__JAIPH_META_STATUS__:42\nmore output";
  const result = extractRunMeta(output);
  assert.equal(result.status, 42);
  assert.equal(result.output, "visible line\nmore output");
});

test("extractRunMeta: extracts run dir from meta line", () => {
  const output = "__JAIPH_META_RUN_DIR__:/tmp/runs/2024\nvisible";
  const result = extractRunMeta(output);
  assert.equal(result.runDir, "/tmp/runs/2024");
  assert.equal(result.output, "visible");
});

test("extractRunMeta: returns undefined status and runDir when no meta lines", () => {
  const output = "just regular output\nnothing special";
  const result = extractRunMeta(output);
  assert.equal(result.status, undefined);
  assert.equal(result.runDir, undefined);
  assert.equal(result.output, "just regular output\nnothing special");
});

test("extractRunMeta: ignores invalid status (NaN)", () => {
  const output = "__JAIPH_META_STATUS__:notanumber";
  const result = extractRunMeta(output);
  assert.equal(result.status, undefined);
});

test("extractRunMeta: ignores empty run dir value", () => {
  const output = "__JAIPH_META_RUN_DIR__:";
  const result = extractRunMeta(output);
  assert.equal(result.runDir, undefined);
});

test("extractRunMeta: trims trailing whitespace from visible output", () => {
  const output = "line1\nline2\n\n";
  const result = extractRunMeta(output);
  assert.equal(result.output, "line1\nline2");
});

// === latestRunFiles ===

test("latestRunFiles: finds latest .out and .err files", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-latest-run-"));
  try {
    writeFileSync(join(dir, "001_step.out"), "out1");
    writeFileSync(join(dir, "002_step.out"), "out2");
    writeFileSync(join(dir, "001_step.err"), "err1");
    const result = latestRunFiles(dir);
    assert.ok(result.out);
    assert.match(result.out!, /002_step\.out$/);
    assert.ok(result.err);
    assert.match(result.err!, /001_step\.err$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latestRunFiles: returns empty when directory does not exist", () => {
  const result = latestRunFiles("/nonexistent/path/abc123");
  assert.equal(result.out, undefined);
  assert.equal(result.err, undefined);
});

test("latestRunFiles: returns empty when directory has no .out/.err files", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-latest-run-empty-"));
  try {
    writeFileSync(join(dir, "readme.txt"), "hello");
    const result = latestRunFiles(dir);
    assert.equal(result.out, undefined);
    assert.equal(result.err, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// === readFailedStepOutput ===

test("readFailedStepOutput: returns null for nonexistent file", () => {
  assert.equal(readFailedStepOutput("/nonexistent/summary.jsonl"), null);
});

test("readFailedStepOutput: returns null when no STEP_END with non-zero status", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-read-failed-"));
  try {
    const summaryPath = join(dir, "summary.jsonl");
    writeFileSync(
      summaryPath,
      JSON.stringify({ type: "STEP_END", status: 0, out_content: "ok" }) + "\n",
    );
    assert.equal(readFailedStepOutput(summaryPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFailedStepOutput: returns embedded out_content for failed step", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-read-failed-content-"));
  try {
    const summaryPath = join(dir, "summary.jsonl");
    writeFileSync(
      summaryPath,
      JSON.stringify({ type: "STEP_END", status: 1, out_content: "test failed output" }) + "\n",
    );
    const result = readFailedStepOutput(summaryPath);
    assert.equal(result, "test failed output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFailedStepOutput: combines out_content and err_content", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-read-failed-combined-"));
  try {
    const summaryPath = join(dir, "summary.jsonl");
    writeFileSync(
      summaryPath,
      JSON.stringify({
        type: "STEP_END",
        status: 1,
        out_content: "stdout output",
        err_content: "stderr output",
      }) + "\n",
    );
    const result = readFailedStepOutput(summaryPath);
    assert.equal(result, "stdout output\nstderr output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFailedStepOutput: returns null when both contents are empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-read-failed-empty-"));
  try {
    const summaryPath = join(dir, "summary.jsonl");
    writeFileSync(
      summaryPath,
      JSON.stringify({ type: "STEP_END", status: 1, out_content: "", err_content: "" }) + "\n",
    );
    assert.equal(readFailedStepOutput(summaryPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFailedStepOutput: falls back to reading file when out_content not embedded", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-read-failed-file-"));
  try {
    const outFile = join(dir, "step.out");
    writeFileSync(outFile, "file-based output");
    const summaryPath = join(dir, "summary.jsonl");
    writeFileSync(
      summaryPath,
      JSON.stringify({ type: "STEP_END", status: 1, out_file: outFile }) + "\n",
    );
    const result = readFailedStepOutput(summaryPath);
    assert.equal(result, "file-based output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// === failedStepArtifactPaths ===

test("failedStepArtifactPaths: empty when summary missing failed STEP_END", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-failed-paths-none-"));
  try {
    const summaryPath = join(dir, "summary.jsonl");
    writeFileSync(
      summaryPath,
      JSON.stringify({ type: "STEP_END", status: 0, out_file: "/x.out", err_file: "/y.err" }) + "\n",
    );
    assert.deepEqual(failedStepArtifactPaths(summaryPath), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failedStepArtifactPaths: maps to failed step out file, not lexicographically latest in run dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-failed-paths-latest-"));
  try {
    const staleOut = join(dir, "099_late_unrelated.out");
    const trueFailOut = join(dir, "020_true_fail.out");
    const staleErr = join(dir, "098_stale.err");
    writeFileSync(staleOut, "noise out");
    writeFileSync(staleErr, "noise err");
    writeFileSync(trueFailOut, "TRUE_FAIL_BODY");
    const summaryPath = join(dir, "summary.jsonl");
    writeFileSync(
      summaryPath,
      [
        JSON.stringify({
          type: "STEP_END",
          status: 0,
          out_file: staleOut,
          err_file: staleErr,
        }),
        JSON.stringify({
          type: "STEP_END",
          status: 1,
          out_file: trueFailOut,
          err_file: "",
          out_content: "TRUE_FAIL_BODY",
        }),
      ].join("\n") + "\n",
    );
    assert.deepEqual(failedStepArtifactPaths(summaryPath), { out: trueFailOut });
    const latest = latestRunFiles(dir);
    assert.equal(latest.out, staleOut);
    assert.equal(latest.err, staleErr);
    assert.equal(readFailedStepOutput(summaryPath), "TRUE_FAIL_BODY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// === resolveFailureDetails ===

test("resolveFailureDetails: returns summary and no failedStepOutput without summaryPath", () => {
  const result = resolveFailureDetails("line1\nerror msg");
  assert.equal(result.summary, "error msg");
  assert.equal(result.failedStepOutput, null);
  assert.equal(result.shouldPrintSummaryLine, true);
});

test("resolveFailureDetails: sets shouldPrintSummaryLine false when failedStepOutput exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-resolve-failure-"));
  try {
    const summaryPath = join(dir, "summary.jsonl");
    writeFileSync(
      summaryPath,
      JSON.stringify({ type: "STEP_END", status: 1, out_content: "detailed error" }) + "\n",
    );
    const result = resolveFailureDetails("error line", summaryPath);
    assert.equal(result.failedStepOutput, "detailed error");
    assert.equal(result.shouldPrintSummaryLine, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// === discoverDockerRunDir ===

test("discoverDockerRunDir: returns matching dir by run_id even when a newer dir exists", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-discover-"));
  try {
    const runIdA = "aaaa-1111";
    const runIdB = "bbbb-2222";
    // older run dir for run A
    const dirA = join(root, "2026-04-22", "10-00-00-wf");
    mkdirSync(dirA, { recursive: true });
    writeFileSync(
      join(dirA, "run_summary.jsonl"),
      JSON.stringify({ type: "WORKFLOW_START", run_id: runIdA }) + "\n",
    );
    // newer run dir for run B
    const dirB = join(root, "2026-04-22", "10-05-00-wf");
    mkdirSync(dirB, { recursive: true });
    writeFileSync(
      join(dirB, "run_summary.jsonl"),
      JSON.stringify({ type: "WORKFLOW_START", run_id: runIdB }) + "\n",
    );
    // Asking for run A should return dirA, not the newer dirB
    const resultA = discoverDockerRunDir(root, runIdA);
    assert.equal(resultA.runDir, dirA);
    assert.equal(resultA.summaryFile, join(dirA, "run_summary.jsonl"));
    // Asking for run B should return dirB
    const resultB = discoverDockerRunDir(root, runIdB);
    assert.equal(resultB.runDir, dirB);
    assert.equal(resultB.summaryFile, join(dirB, "run_summary.jsonl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverDockerRunDir: returns empty when no dir matches the expected run_id", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-discover-none-"));
  try {
    const dir = join(root, "2026-04-22", "10-00-00-wf");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "run_summary.jsonl"),
      JSON.stringify({ type: "WORKFLOW_START", run_id: "other-id" }) + "\n",
    );
    const result = discoverDockerRunDir(root, "nonexistent-id");
    assert.equal(result.runDir, undefined);
    assert.equal(result.summaryFile, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
