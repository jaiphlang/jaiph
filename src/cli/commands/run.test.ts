import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "./run";

const MIN_WORKFLOW = `workflow default() {\n  log "hi"\n}\n`;

function captureStreams(): { restore: () => void; stderr: () => string; stdout: () => string } {
  let err = "";
  let out = "";
  const origErr = process.stderr.write;
  const origOut = process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    },
    stderr: () => err,
    stdout: () => out,
  };
}

test("runWorkflow: --workspace without a value errors and returns 1", async () => {
  const cap = captureStreams();
  let code: number;
  try {
    code = await runWorkflow(["--workspace"]);
  } finally {
    cap.restore();
  }
  assert.equal(code, 1);
  assert.match(cap.stderr(), /--workspace requires a directory path/);
});

test("runWorkflow: --workspace pointing to a non-existent dir errors and returns 1", async () => {
  const ws = mkdtempSync(join(tmpdir(), "jaiph-run-ws-"));
  writeFileSync(join(ws, "flow.jh"), MIN_WORKFLOW);
  const missing = join(ws, "does-not-exist");
  const cap = captureStreams();
  let code: number;
  try {
    code = await runWorkflow(["--workspace", missing, join(ws, "flow.jh")]);
  } finally {
    cap.restore();
    rmSync(ws, { recursive: true, force: true });
  }
  assert.equal(code, 1);
  assert.match(cap.stderr(), /--workspace path does not exist/);
});

test("runWorkflow: --workspace pointing to a file (not a dir) errors and returns 1", async () => {
  const ws = mkdtempSync(join(tmpdir(), "jaiph-run-ws-file-"));
  const notDir = join(ws, "not-a-dir");
  writeFileSync(notDir, "x");
  writeFileSync(join(ws, "flow.jh"), MIN_WORKFLOW);
  const cap = captureStreams();
  let code: number;
  try {
    code = await runWorkflow(["--workspace", notDir, join(ws, "flow.jh")]);
  } finally {
    cap.restore();
    rmSync(ws, { recursive: true, force: true });
  }
  assert.equal(code, 1);
  assert.match(cap.stderr(), /--workspace path is not a directory/);
});

test("runWorkflow: --workspace bypasses detectWorkspaceRoot — explicit-missing wins over auto-detectable", async () => {
  const autoDetected = mkdtempSync(join(tmpdir(), "jaiph-run-ws-auto-"));
  mkdirSync(join(autoDetected, ".git"), { recursive: true });
  const flowPath = join(autoDetected, "flow.jh");
  writeFileSync(flowPath, MIN_WORKFLOW);
  const explicitMissing = join(autoDetected, "no-such-explicit-workspace");
  const cap = captureStreams();
  let code: number;
  try {
    code = await runWorkflow(["--workspace", explicitMissing, flowPath]);
  } finally {
    cap.restore();
    rmSync(autoDetected, { recursive: true, force: true });
  }
  assert.equal(code, 1);
  assert.match(cap.stderr(), /--workspace path does not exist/);
  assert.ok(
    cap.stderr().includes(explicitMissing),
    `error must name the explicit --workspace path; got: ${cap.stderr()}`,
  );
});
