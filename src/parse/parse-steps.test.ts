import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import { parseEnsureStep, parseRunRecoverStep } from "./steps";

/**
 * Helpers to keep individual asserts terse — `parseEnsureStep` /
 * `parseRunCatchStep` / `parseRunRecoverStep` all return an `exec` step whose
 * body is an `Expr.call` (run) or `Expr.ensure_call` (ensure).
 */
function asEnsureExec(step: import("../types").WorkflowStepDef) {
  if (step.type !== "exec" || step.body.kind !== "ensure_call") {
    throw new Error(`expected exec/ensure_call step, got ${step.type}`);
  }
  return step;
}
function asRunExec(step: import("../types").WorkflowStepDef) {
  if (step.type !== "exec" || step.body.kind !== "call") {
    throw new Error(`expected exec/call step, got ${step.type}`);
  }
  return step;
}

// === parseEnsureStep: basic ensure without catch ===

test("parseEnsureStep: parses basic ensure call", () => {
  const lines = ["  ensure my_rule()"];
  const { step, nextIdx } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule()");
  const e = asEnsureExec(step);
  assert.equal(e.body.kind, "ensure_call");
  if (e.body.kind === "ensure_call") {
    assert.equal(e.body.callee.value, "my_rule");
  }
  assert.equal(e.catch, undefined);
  assert.equal(nextIdx, 0);
});

test("parseEnsureStep: parses ensure with args", () => {
  const lines = ['  ensure my_rule("arg1")'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule("arg1")');
  const e = asEnsureExec(step);
  if (e.body.kind === "ensure_call") {
    assert.equal(e.body.callee.value, "my_rule");
    assert.deepEqual(e.body.args, [{ kind: "literal", raw: '"arg1"' }]);
  }
});

test("parseEnsureStep: parses ensure with dotted ref", () => {
  const lines = ["  ensure lib.check()"];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "lib.check()");
  const e = asEnsureExec(step);
  if (e.body.kind === "ensure_call") {
    assert.equal(e.body.callee.value, "lib.check");
  }
});

test("parseEnsureStep: parses ensure with captureName", () => {
  const lines = ["  result = ensure my_rule()"];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule()", "result");
  const e = asEnsureExec(step);
  assert.equal(e.captureName, "result");
});

test("parseEnsureStep: ensure without parens throws", () => {
  const lines = ["  ensure my_rule"];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule"),
    /parentheses are required/,
  );
});

// === parseEnsureStep: catch with single statement ===

test("parseEnsureStep: parses ensure with single catch statement", () => {
  const lines = ['  ensure my_rule() catch (failure) log "failed"'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() catch (failure) log "failed"');
  const e = asEnsureExec(step);
  assert.ok(e.catch);
  assert.equal(e.catch!.bindings.failure, "failure");
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "say");
  }
});

test("parseEnsureStep: parses ensure with catch run statement", () => {
  const lines = ["  ensure my_rule() catch (err) run fallback()"];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() catch (err) run fallback()");
  const e = asEnsureExec(step);
  assert.ok(e.catch);
  assert.equal(e.catch!.bindings.failure, "err");
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "exec");
  }
});

test("parseEnsureStep: parses ensure with catch wait statement", () => {
  const lines = ["  ensure my_rule() catch (failure) wait"];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() catch (failure) wait"),
    /"wait" has been removed from the language/,
  );
});

test("parseEnsureStep: parses ensure with catch fail statement", () => {
  const lines = ['  ensure my_rule() catch (failure) fail "reason"'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() catch (failure) fail "reason"');
  const e = asEnsureExec(step);
  assert.ok(e.catch);
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "say");
    if (e.catch.single.type === "say") {
      assert.equal(e.catch.single.level, "fail");
    }
  }
});

// === parseEnsureStep: catch with inline block ===

test("parseEnsureStep: parses ensure with inline catch block", () => {
  const lines = ['  ensure my_rule() catch (failure) { log "a"; log "b" }'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() catch (failure) { log "a"; log "b" }');
  const e = asEnsureExec(step);
  if (e.catch && "block" in e.catch) {
    assert.equal(e.catch.block.length, 2);
    assert.equal(e.catch.block[0].type, "say");
    assert.equal(e.catch.block[1].type, "say");
  }
});

// === parseEnsureStep: catch with multiline block ===

test("parseEnsureStep: parses ensure with multiline catch block", () => {
  const lines = [
    "  ensure my_rule() catch (failure) {",
    '    log "recovering"',
    "    run fallback()",
    "  }",
  ];
  const { step, nextIdx } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() catch (failure) {");
  const e = asEnsureExec(step);
  if (e.catch && "block" in e.catch) {
    assert.equal(e.catch.block.length, 2);
    assert.equal(e.catch.block[0].type, "say");
    assert.equal(e.catch.block[1].type, "exec");
  }
  assert.equal(nextIdx, 3);
});

test("parseEnsureStep: multiline catch block with triple-quoted prompt", () => {
  const lines = [
    "  ensure gate() catch (err) {",
    "    run save()",
    '    prompt """',
    "      fix CI",
    '    """',
    "    run retry()",
    "  }",
  ];
  const { step, nextIdx } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "gate() catch (err) {");
  const e = asEnsureExec(step);
  if (e.catch && "block" in e.catch) {
    assert.equal(e.catch.block.length, 3);
    assert.equal(e.catch.block[0].type, "exec");
    const p = e.catch.block[1];
    assert.equal(p.type, "exec");
    if (p.type === "exec" && p.body.kind === "prompt") {
      assert.ok(p.body.raw.includes("fix CI"));
    }
    assert.equal(e.catch.block[2].type, "exec");
  }
  assert.equal(nextIdx, 6);
});

test("parseEnsureStep: catch block lines starting with # are trivia comments", () => {
  const lines = [
    "  ensure gate() catch (err) {",
    "    # note",
    "    run retry()",
    "  }",
  ];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "gate() catch (err) {");
  const e = asEnsureExec(step);
  if (e.catch && "block" in e.catch) {
    assert.equal(e.catch.block.length, 2);
    assert.equal(e.catch.block[0].type, "trivia");
    assert.equal(e.catch.block[1].type, "exec");
  }
});

// === parseEnsureStep: catch bindings ===

test("parseEnsureStep: rejects catch with two bindings", () => {
  const lines = ['  ensure my_rule() catch (failure, attempt) { log "retry" }'];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() catch (failure, attempt) { log "retry" }'),
    /catch accepts exactly one binding.*attempt.*has been removed/,
  );
});

// === parseEnsureStep: catch errors ===

test("parseEnsureStep: catch at EOL without block throws", () => {
  const lines = ["  ensure my_rule() catch"];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() catch"),
    /catch requires explicit bindings/,
  );
});

test("parseEnsureStep: catch without bindings throws", () => {
  const lines = ["  ensure my_rule() catch {"];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() catch {"),
    /catch requires explicit bindings/,
  );
});

test("parseEnsureStep: unterminated multiline catch block throws", () => {
  const lines = [
    "  ensure my_rule() catch (failure) {",
    '    log "recovering"',
  ];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() catch (failure) {"),
    /unterminated catch block/,
  );
});

test("parseEnsureStep: empty catch block throws", () => {
  const lines = [
    "  ensure my_rule() catch (failure) {",
    "  }",
  ];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() catch (failure) {"),
    /catch block must contain at least one statement/,
  );
});

test("parseEnsureStep: empty inline catch block throws", () => {
  const lines = ["  ensure my_rule() catch (failure) { }"];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() catch (failure) { }"),
    /catch block must contain at least one statement/,
  );
});

// === parseEnsureStep: catch statement types ===

test("parseEnsureStep: catch with shell command", () => {
  const lines = ["  ensure my_rule() catch (failure) echo fallback"];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() catch (failure) echo fallback");
  const e = asEnsureExec(step);
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "exec");
    if (e.catch.single.type === "exec") {
      assert.equal(e.catch.single.body.kind, "shell");
    }
  }
});

test("parseEnsureStep: catch with logerr statement", () => {
  const lines = ['  ensure my_rule() catch (failure) logerr "error msg"'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() catch (failure) logerr "error msg"');
  const e = asEnsureExec(step);
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "say");
    if (e.catch.single.type === "say") {
      assert.equal(e.catch.single.level, "logerr");
    }
  }
});

test("parsejaiph: workflow with ensure catch and multiline triple-quoted prompt", () => {
  const src = [
    "rule gate() {",
    "  run noop()",
    "}",
    "script noop = `true`",
    "workflow w() {",
    "  ensure gate() catch (err) {",
    '    prompt """',
    "      hello",
    '    """',
    "  }",
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(src, "catch_prompt.jh");
  const w = mod.workflows.find((x) => x.name === "w");
  assert.ok(w);
  const ensureStep = w!.steps[0];
  const e = asEnsureExec(ensureStep);
  if (e.catch && "block" in e.catch) {
    assert.equal(e.catch.block.length, 1);
    const p = e.catch.block[0];
    assert.equal(p.type, "exec");
    if (p.type === "exec" && p.body.kind === "prompt") {
      assert.ok(p.body.raw.includes("hello"));
    }
  }
});

// === parseRunRecoverStep: basic recover ===

test("parseRunRecoverStep: returns null when no recover keyword", () => {
  const lines = ["  run my_workflow()"];
  const result = parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], "my_workflow()");
  assert.equal(result, null);
});

test("parseRunRecoverStep: parses run with single recover statement", () => {
  const lines = ['  run my_workflow() recover(err) log "repairing"'];
  const result = parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], 'my_workflow() recover(err) log "repairing"');
  assert.ok(result);
  const step = asRunExec(result!.step);
  assert.equal(step.body.kind, "call");
  if (step.body.kind === "call") {
    assert.equal(step.body.callee.value, "my_workflow");
  }
  assert.ok(step.recover);
  assert.equal(step.recover!.bindings.failure, "err");
  if (step.recover && "single" in step.recover) {
    assert.equal(step.recover.single.type, "say");
  }
});

test("parseRunRecoverStep: parses run with inline recover block", () => {
  const lines = ['  run fix() recover(e) { log "a"; run patch() }'];
  const result = parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], 'fix() recover(e) { log "a"; run patch() }');
  assert.ok(result);
  const step = asRunExec(result!.step);
  if (step.recover && "block" in step.recover) {
    assert.equal(step.recover.block.length, 2);
    assert.equal(step.recover.block[0].type, "say");
    assert.equal(step.recover.block[1].type, "exec");
  }
});

test("parseRunRecoverStep: parses run with multiline recover block", () => {
  const lines = [
    "  run deploy() recover(err) {",
    '    log "retrying"',
    "    run cleanup()",
    "  }",
  ];
  const result = parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], "deploy() recover(err) {");
  assert.ok(result);
  const step = asRunExec(result!.step);
  if (step.recover && "block" in step.recover) {
    assert.equal(step.recover.block.length, 2);
    assert.equal(step.recover.block[0].type, "say");
    assert.equal(step.recover.block[1].type, "exec");
  }
  assert.equal(result!.nextIdx, 3);
});

test("parseRunRecoverStep: rejects recover at EOL without body", () => {
  const lines = ["  run my_workflow() recover"];
  assert.throws(
    () => parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], "my_workflow() recover"),
    /recover requires explicit bindings/,
  );
});

test("parseRunRecoverStep: rejects recover without bindings", () => {
  const lines = ["  run my_workflow() recover {"];
  assert.throws(
    () => parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], "my_workflow() recover {"),
    /recover requires explicit bindings/,
  );
});

test("parseRunRecoverStep: rejects recover with two bindings", () => {
  const lines = ['  run my_workflow() recover(a, b) { log "x" }'];
  assert.throws(
    () => parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], 'my_workflow() recover(a, b) { log "x" }'),
    /recover accepts exactly one binding/,
  );
});

test("parseRunRecoverStep: empty recover block throws", () => {
  const lines = ["  run my_workflow() recover(err) { }"];
  assert.throws(
    () => parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], "my_workflow() recover(err) { }"),
    /recover block must contain at least one statement/,
  );
});

test("parsejaiph: workflow with run recover block", () => {
  const src = [
    "workflow deploy() {",
    '  run setup() recover(err) {',
    '    log "fixing"',
    '    run fix()',
    '  }',
    "}",
    "workflow setup() {",
    '  log "setup"',
    "}",
    "workflow fix() {",
    '  log "fix"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(src, "recover_test.jh");
  const w = mod.workflows.find((x) => x.name === "deploy");
  assert.ok(w);
  const runStep = asRunExec(w!.steps[0]);
  assert.ok(runStep.recover);
  assert.equal(runStep.catch, undefined);
});
