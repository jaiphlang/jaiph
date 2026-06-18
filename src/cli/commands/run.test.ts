import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "./run";
import { _dockerExec, _dockerSpawn } from "../../runtime/docker";

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

function fenceDockerCalls(): { restore: () => void; calls: () => string[] } {
  const origExec = _dockerExec.run;
  const origSpawn = _dockerSpawn.run;
  const calls: string[] = [];
  _dockerExec.run = (_args: string[], _opts: object) => {
    calls.push("exec");
    throw new Error("docker exec should not be invoked in this test");
  };
  _dockerSpawn.run = (_args: string[], _opts: object) => {
    calls.push("spawn");
    throw new Error("docker spawn should not be invoked in this test");
  };
  return {
    restore: () => { _dockerExec.run = origExec; _dockerSpawn.run = origSpawn; },
    calls: () => calls,
  };
}

// ---------------------------------------------------------------------------
// E_FLAG_CONFLICT: --inplace + --unsafe must abort before any container launch
// ---------------------------------------------------------------------------

test("runWorkflow: --inplace + --unsafe fails with E_FLAG_CONFLICT, no docker exec or spawn invoked", async () => {
  const ws = mkdtempSync(join(tmpdir(), "jaiph-run-conflict-ws-"));
  writeFileSync(join(ws, "flow.jh"), MIN_WORKFLOW);
  const fence = fenceDockerCalls();
  const cap = captureStreams();
  let code: number;
  try {
    code = await runWorkflow(["--inplace", "--unsafe", join(ws, "flow.jh")]);
  } finally {
    cap.restore();
    fence.restore();
    rmSync(ws, { recursive: true, force: true });
  }
  assert.equal(code, 1, "must return 1 on flag conflict");
  assert.match(cap.stderr(), /E_FLAG_CONFLICT/);
  assert.deepEqual(fence.calls(), [], "no docker exec/spawn must be invoked");
});

test("runWorkflow: --inplace + env JAIPH_UNSAFE=true also fails with E_FLAG_CONFLICT", async () => {
  const ws = mkdtempSync(join(tmpdir(), "jaiph-run-conflict-ws-"));
  writeFileSync(join(ws, "flow.jh"), MIN_WORKFLOW);
  const fence = fenceDockerCalls();
  const cap = captureStreams();
  const savedUnsafe = process.env.JAIPH_UNSAFE;
  process.env.JAIPH_UNSAFE = "true";
  let code: number;
  try {
    code = await runWorkflow(["--inplace", join(ws, "flow.jh")]);
  } finally {
    if (savedUnsafe === undefined) delete process.env.JAIPH_UNSAFE;
    else process.env.JAIPH_UNSAFE = savedUnsafe;
    cap.restore();
    fence.restore();
    rmSync(ws, { recursive: true, force: true });
  }
  assert.equal(code, 1);
  assert.match(cap.stderr(), /E_FLAG_CONFLICT/);
  assert.deepEqual(fence.calls(), []);
});

// ---------------------------------------------------------------------------
// --workspace validation: missing value, non-existent dir, file (not dir)
// ---------------------------------------------------------------------------

test("runWorkflow: --workspace without a value errors and returns 1", async () => {
  const fence = fenceDockerCalls();
  const cap = captureStreams();
  let code: number;
  try {
    code = await runWorkflow(["--workspace"]);
  } finally {
    cap.restore();
    fence.restore();
  }
  assert.equal(code, 1);
  assert.match(cap.stderr(), /--workspace requires a directory path/);
  assert.deepEqual(fence.calls(), []);
});

test("runWorkflow: --workspace pointing to a non-existent dir errors and returns 1", async () => {
  const ws = mkdtempSync(join(tmpdir(), "jaiph-run-ws-"));
  writeFileSync(join(ws, "flow.jh"), MIN_WORKFLOW);
  const missing = join(ws, "does-not-exist");
  const fence = fenceDockerCalls();
  const cap = captureStreams();
  let code: number;
  try {
    code = await runWorkflow(["--workspace", missing, join(ws, "flow.jh")]);
  } finally {
    cap.restore();
    fence.restore();
    rmSync(ws, { recursive: true, force: true });
  }
  assert.equal(code, 1);
  assert.match(cap.stderr(), /--workspace path does not exist/);
  assert.deepEqual(fence.calls(), []);
});

test("runWorkflow: --workspace pointing to a file (not a directory) errors and returns 1", async () => {
  const ws = mkdtempSync(join(tmpdir(), "jaiph-run-ws-"));
  writeFileSync(join(ws, "flow.jh"), MIN_WORKFLOW);
  const notDir = join(ws, "notadir.txt");
  writeFileSync(notDir, "");
  const fence = fenceDockerCalls();
  const cap = captureStreams();
  let code: number;
  try {
    code = await runWorkflow(["--workspace", notDir, join(ws, "flow.jh")]);
  } finally {
    cap.restore();
    fence.restore();
    rmSync(ws, { recursive: true, force: true });
  }
  assert.equal(code, 1);
  assert.match(cap.stderr(), /--workspace path is not a directory/);
  assert.deepEqual(fence.calls(), []);
});

// ---------------------------------------------------------------------------
// --raw applies sandbox flags too: flag conflict aborts before runner spawn
// ---------------------------------------------------------------------------

test("runWorkflow --raw: --inplace + --unsafe fails with E_FLAG_CONFLICT", async () => {
  const ws = mkdtempSync(join(tmpdir(), "jaiph-run-raw-conflict-ws-"));
  writeFileSync(join(ws, "flow.jh"), MIN_WORKFLOW);
  const fence = fenceDockerCalls();
  const cap = captureStreams();
  let code: number;
  try {
    code = await runWorkflow(["--raw", "--inplace", "--unsafe", join(ws, "flow.jh")]);
  } finally {
    cap.restore();
    fence.restore();
    rmSync(ws, { recursive: true, force: true });
  }
  assert.equal(code, 1);
  assert.match(cap.stderr(), /E_FLAG_CONFLICT/);
  // --raw never goes through docker anyway, but assert fence still untouched.
  assert.deepEqual(fence.calls(), []);
});

// ---------------------------------------------------------------------------
// --workspace explicit path wins over auto-detect: even when the .jh file
// lives under a perfectly-good auto-detected workspace, the explicit path
// is consulted (and rejected as missing) before any fallback applies.
// ---------------------------------------------------------------------------

test("runWorkflow: --workspace bypasses detectWorkspaceRoot — explicit-missing wins over auto-detectable", async () => {
  // A workspace-shaped dir (has .git) that would be auto-detected.
  const autoDetected = mkdtempSync(join(tmpdir(), "jaiph-run-ws-auto-"));
  mkdirSync(join(autoDetected, ".git"), { recursive: true });
  const flowPath = join(autoDetected, "flow.jh");
  writeFileSync(flowPath, MIN_WORKFLOW);
  const explicitMissing = join(autoDetected, "no-such-explicit-workspace");
  const fence = fenceDockerCalls();
  const cap = captureStreams();
  let code: number;
  try {
    code = await runWorkflow(["--workspace", explicitMissing, flowPath]);
  } finally {
    cap.restore();
    fence.restore();
    rmSync(autoDetected, { recursive: true, force: true });
  }
  // If --workspace were ignored, detectWorkspaceRoot would happily find
  // `autoDetected` and the run would proceed past workspace validation.
  // The explicit-missing error proves the flag is consulted first.
  assert.equal(code, 1);
  assert.match(cap.stderr(), /--workspace path does not exist/);
  assert.ok(
    cap.stderr().includes(explicitMissing),
    `error must name the explicit --workspace path; got: ${cap.stderr()}`,
  );
  assert.deepEqual(fence.calls(), []);
});
