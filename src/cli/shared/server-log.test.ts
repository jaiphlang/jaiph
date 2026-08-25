import test from "node:test";
import assert from "node:assert/strict";
import {
  createServerLog,
  createOperatorLog,
  resolveServerLogEnv,
  formatCallStartLine,
  formatCallEndLine,
} from "./server-log";

const BLUE = "\u001b[34m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => void lines.push(line) };
}

test("createServerLog prefixes the label and colors only warn/error when colorEnabled", () => {
  const cap = capture();
  const log = createServerLog({ label: "jaiph mcp", write: cap.write, colorEnabled: true });
  log.info("hello");
  log.warn("careful");
  log.error("boom");
  assert.equal(cap.lines[0], "jaiph mcp: hello", "info is plain, label-prefixed");
  assert.ok(cap.lines[1].startsWith(`${YELLOW}jaiph mcp: careful`), "warn is yellow");
  assert.ok(cap.lines[2].startsWith(`${RED}jaiph mcp: boom`), "error is red");
});

test("createServerLog emits no ANSI when colorEnabled is false (CI / piped stderr)", () => {
  const cap = capture();
  const log = createServerLog({ label: "jaiph serve", write: cap.write, colorEnabled: false });
  log.warn("careful");
  log.error("boom");
  assert.equal(cap.lines[0], "jaiph serve: careful");
  assert.equal(cap.lines[1], "jaiph serve: boom");
  assert.ok(!cap.lines.join("").includes("\u001b["), "no escape sequences in non-TTY mode");
});

test("debug lines are gated behind debugEnabled (JAIPH_SERVER_LOG=debug)", () => {
  const off = capture();
  createServerLog({ label: "jaiph mcp", write: off.write, colorEnabled: false }).debug("verbose");
  assert.equal(off.lines.length, 0, "debug is silent by default");

  const on = capture();
  createServerLog({ label: "jaiph mcp", write: on.write, colorEnabled: false, debugEnabled: true }).debug("verbose");
  assert.deepEqual(on.lines, ["jaiph mcp: verbose"], "debug prints when enabled");
});

test("resolveServerLogEnv reads the two documented knobs", () => {
  assert.deepEqual(resolveServerLogEnv({}), { debugEnabled: false, mirrorWorkflowLog: false });
  assert.deepEqual(resolveServerLogEnv({ JAIPH_SERVER_LOG: "debug" }).debugEnabled, true);
  assert.deepEqual(resolveServerLogEnv({ JAIPH_SERVER_LOG: "DEBUG" }).debugEnabled, true);
  assert.deepEqual(resolveServerLogEnv({ JAIPH_SERVER_LOG: "info" }).debugEnabled, false);
  assert.equal(resolveServerLogEnv({ JAIPH_SERVER_LOG_WORKFLOW: "1" }).mirrorWorkflowLog, true);
  assert.equal(resolveServerLogEnv({ JAIPH_SERVER_LOG_WORKFLOW: "true" }).mirrorWorkflowLog, true);
  assert.equal(resolveServerLogEnv({ JAIPH_SERVER_LOG_WORKFLOW: "0" }).mirrorWorkflowLog, false);
});

test("mirrorWorkflowLog flag reflects the option; mirror() is silent otherwise via the caller gate", () => {
  const off = createServerLog({ label: "jaiph mcp", write: () => {}, colorEnabled: false });
  assert.equal(off.mirrorWorkflowLog, false);
  const on = createServerLog({ label: "jaiph mcp", write: () => {}, colorEnabled: false, mirrorWorkflowLog: true });
  assert.equal(on.mirrorWorkflowLog, true);
});

test("mirror() colorizes by level and tags run_id; async_indices add a subscript indent", () => {
  const cap = capture();
  const log = createServerLog({ label: "jaiph mcp", write: cap.write, colorEnabled: true, mirrorWorkflowLog: true });
  log.mirror("LOG", "info line", { runId: "r1", depth: 0, asyncIndices: [] });
  log.mirror("LOGWARN", "warn line", { runId: "r1", depth: 0, asyncIndices: [] });
  log.mirror("LOGERR", "err line", { runId: "r1", depth: 1, asyncIndices: [2] });

  assert.ok(cap.lines[0].includes(BLUE) && cap.lines[0].endsWith("run_id=r1"), "LOG mirrors blue with run_id tail");
  assert.ok(cap.lines[1].includes(YELLOW), "LOGWARN mirrors yellow");
  assert.ok(cap.lines[2].includes(RED), "LOGERR mirrors red");
  // The async-branch subscript (₂) appears in the indent for a non-empty async_indices chain.
  assert.ok(cap.lines[2].includes("₂"), "async_indices render as a subscript indent");
});

test("mirror() carries the async subscript indent even when colors are off", () => {
  const cap = capture();
  const log = createServerLog({ label: "jaiph serve", write: cap.write, colorEnabled: false, mirrorWorkflowLog: true });
  log.mirror("LOG", "line", { runId: "r9", depth: 2, asyncIndices: [1, 3] });
  assert.ok(!cap.lines[0].includes("\u001b["), "no ANSI when colors are off");
  assert.ok(cap.lines[0].includes("₁") && cap.lines[0].includes("₃"), "both subscripts present");
  assert.ok(cap.lines[0].endsWith("run_id=r9"));
});

// === per-call banner formatters ===

test("formatCallStartLine matches Running…run_id= shape", () => {
  const line = formatCallStartLine({ def: "engineer", runId: "abc123" });
  assert.equal(line, "Running engineer run_id=abc123");
});

test("formatCallStartLine appends rundir / principal / correlation only when present", () => {
  const bare = formatCallStartLine({ def: "w", runId: "r" });
  assert.equal(bare, "Running w run_id=r", "no optional tails when unset");
  const full = formatCallStartLine({
    def: "w",
    runId: "r",
    rundir: "/runs/x",
    principal: "alice",
    correlationId: "cid-1",
  });
  assert.equal(full, "Running w run_id=r rundir=/runs/x principal=alice correlation=cid-1");
});

test("formatCallEndLine carries status, exit, elapsed_ms, and rundir when known", () => {
  const line = formatCallEndLine({ def: "w", status: "ok", exit: 0, elapsedMs: 1234, rundir: "/runs/x" });
  assert.equal(line, "Finished w status=ok exit=0 elapsed_ms=1234 rundir=/runs/x");
  const failed = formatCallEndLine({ def: "w", status: "failed", exit: 1, elapsedMs: 7 });
  assert.equal(failed, "Finished w status=failed exit=1 elapsed_ms=7", "rundir omitted when unknown");
});

test("createOperatorLog writes only to the injected sink", () => {
  const cap = capture();
  const op = createOperatorLog({
    label: "jaiph serve",
    write: cap.write,
  });
  op.log.info("x");
  assert.equal(cap.lines[0], "jaiph serve: x", "the operator log writes only to the injected sink");
});
