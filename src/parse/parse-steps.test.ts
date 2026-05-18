import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import type { WorkflowStepDef } from "../types";

/**
 * After Refactor 2 the per-host catch/recover parsers (`parseEnsureStep`,
 * `parseRunCatchStep`, `parseRunRecoverStep`) and their mini body parser
 * (`parseCatchStatement`) are gone. The contract is now exercised end-to-end
 * through `parsejaiph` — `parseAttachedBlock` (in `src/parse/steps.ts`)
 * delegates body parsing to the same `parseBlockStatement` used at the top
 * level.
 */

function asEnsureExec(step: WorkflowStepDef) {
  if (step.type !== "exec" || step.body.kind !== "ensure_call") {
    throw new Error(`expected exec/ensure_call step, got ${step.type}`);
  }
  return step;
}
function asRunExec(step: WorkflowStepDef) {
  if (step.type !== "exec" || step.body.kind !== "call") {
    throw new Error(`expected exec/call step, got ${step.type}`);
  }
  return step;
}

function parseOneWorkflowStep(bodyLines: string[]): WorkflowStepDef {
  const src = ["workflow w() {", ...bodyLines.map((l) => `  ${l}`), "}", ""].join("\n");
  const mod = parsejaiph(src, "fixture.jh");
  const w = mod.workflows.find((x) => x.name === "w");
  if (!w) throw new Error("workflow not found");
  const steps = w.steps.filter((s) => s.type !== "trivia");
  if (steps.length !== 1) throw new Error(`expected one step, got ${steps.length}`);
  return steps[0];
}

// === ensure: basic ===

test("ensure: parses basic ensure call", () => {
  const e = asEnsureExec(parseOneWorkflowStep(["ensure my_rule()"]));
  assert.equal(e.body.kind, "ensure_call");
  if (e.body.kind === "ensure_call") {
    assert.equal(e.body.callee.value, "my_rule");
  }
  assert.equal(e.catch, undefined);
});

test("ensure: parses ensure with args", () => {
  const e = asEnsureExec(parseOneWorkflowStep(['ensure my_rule("arg1")']));
  if (e.body.kind === "ensure_call") {
    assert.equal(e.body.callee.value, "my_rule");
    assert.deepEqual(e.body.args, [{ kind: "literal", raw: '"arg1"' }]);
  }
});

test("ensure: parses ensure with dotted ref", () => {
  const e = asEnsureExec(parseOneWorkflowStep(["ensure lib.check()"]));
  if (e.body.kind === "ensure_call") {
    assert.equal(e.body.callee.value, "lib.check");
  }
});

test("ensure: ensure without parens throws", () => {
  assert.throws(
    () => parseOneWorkflowStep(["ensure my_rule"]),
    /parentheses are required/,
  );
});

// === ensure catch: single statement forms ===

test("ensure catch: parses single catch log statement", () => {
  const e = asEnsureExec(parseOneWorkflowStep(['ensure my_rule() catch (failure) log "failed"']));
  assert.ok(e.catch);
  assert.equal(e.catch!.bindings.failure, "failure");
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "say");
  }
});

test("ensure catch: parses single catch run statement", () => {
  const e = asEnsureExec(parseOneWorkflowStep(["ensure my_rule() catch (err) run fallback()"]));
  assert.ok(e.catch);
  assert.equal(e.catch!.bindings.failure, "err");
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "exec");
  }
});

test("ensure catch: wait statement is rejected", () => {
  assert.throws(
    () => parseOneWorkflowStep(["ensure my_rule() catch (failure) wait"]),
    /"wait" has been removed from the language/,
  );
});

test("ensure catch: parses single catch fail statement", () => {
  const e = asEnsureExec(parseOneWorkflowStep(['ensure my_rule() catch (failure) fail "reason"']));
  assert.ok(e.catch);
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "say");
    if (e.catch.single.type === "say") {
      assert.equal(e.catch.single.level, "fail");
    }
  }
});

// === ensure catch: inline block ===

test("ensure catch: parses inline catch block", () => {
  const e = asEnsureExec(parseOneWorkflowStep(['ensure my_rule() catch (failure) { log "a"; log "b" }']));
  if (e.catch && "block" in e.catch) {
    assert.equal(e.catch.block.length, 2);
    assert.equal(e.catch.block[0].type, "say");
    assert.equal(e.catch.block[1].type, "say");
  }
});

// === ensure catch: multiline block ===

test("ensure catch: parses multiline catch block", () => {
  const e = asEnsureExec(parseOneWorkflowStep([
    "ensure my_rule() catch (failure) {",
    '    log "recovering"',
    "    run fallback()",
    "  }",
  ]));
  if (e.catch && "block" in e.catch) {
    assert.equal(e.catch.block.length, 2);
    assert.equal(e.catch.block[0].type, "say");
    assert.equal(e.catch.block[1].type, "exec");
  }
});

test("ensure catch: multiline block with triple-quoted prompt", () => {
  const e = asEnsureExec(parseOneWorkflowStep([
    "ensure gate() catch (err) {",
    "    run save()",
    '    prompt """',
    "      fix CI",
    '    """',
    "    run retry()",
    "  }",
  ]));
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
});

test("ensure catch: comment lines become trivia", () => {
  const e = asEnsureExec(parseOneWorkflowStep([
    "ensure gate() catch (err) {",
    "    # note",
    "    run retry()",
    "  }",
  ]));
  if (e.catch && "block" in e.catch) {
    assert.equal(e.catch.block.length, 2);
    assert.equal(e.catch.block[0].type, "trivia");
    assert.equal(e.catch.block[1].type, "exec");
  }
});

// === ensure catch: bindings ===

test("ensure catch: rejects two bindings", () => {
  assert.throws(
    () => parseOneWorkflowStep(['ensure my_rule() catch (failure, attempt) { log "retry" }']),
    /catch accepts exactly one binding.*attempt.*has been removed/,
  );
});

// === ensure catch: error messages ===

test("ensure catch: catch at EOL without block throws", () => {
  assert.throws(
    () => parseOneWorkflowStep(["ensure my_rule() catch"]),
    /catch requires explicit bindings/,
  );
});

test("ensure catch: catch without bindings throws", () => {
  assert.throws(
    () => parseOneWorkflowStep(["ensure my_rule() catch {"]),
    /catch requires explicit bindings/,
  );
});

test("ensure catch: unterminated multiline catch block throws", () => {
  assert.throws(
    () => parsejaiph(
      [
        "workflow w() {",
        "  ensure my_rule() catch (failure) {",
        '    log "recovering"',
        "",
      ].join("\n"),
      "fixture.jh",
    ),
    /unterminated catch block/,
  );
});

test("ensure catch: empty catch block throws", () => {
  assert.throws(
    () => parseOneWorkflowStep([
      "ensure my_rule() catch (failure) {",
      "  }",
    ]),
    /catch block must contain at least one statement/,
  );
});

test("ensure catch: empty inline catch block throws", () => {
  assert.throws(
    () => parseOneWorkflowStep(["ensure my_rule() catch (failure) { }"]),
    /catch block must contain at least one statement/,
  );
});

// === ensure catch: statement varieties ===

test("ensure catch: single shell command", () => {
  const e = asEnsureExec(parseOneWorkflowStep(["ensure my_rule() catch (failure) echo fallback"]));
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "exec");
    if (e.catch.single.type === "exec") {
      assert.equal(e.catch.single.body.kind, "shell");
    }
  }
});

test("ensure catch: single logerr statement", () => {
  const e = asEnsureExec(parseOneWorkflowStep(['ensure my_rule() catch (failure) logerr "error msg"']));
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
  const e = asEnsureExec(w!.steps[0]);
  if (e.catch && "block" in e.catch) {
    assert.equal(e.catch.block.length, 1);
    const p = e.catch.block[0];
    assert.equal(p.type, "exec");
    if (p.type === "exec" && p.body.kind === "prompt") {
      assert.ok(p.body.raw.includes("hello"));
    }
  }
});

// === run recover ===

test("run recover: parses single recover statement", () => {
  const step = asRunExec(parseOneWorkflowStep(['run my_workflow() recover(err) log "repairing"']));
  if (step.body.kind === "call") {
    assert.equal(step.body.callee.value, "my_workflow");
  }
  assert.ok(step.recover);
  assert.equal(step.recover!.bindings.failure, "err");
  if (step.recover && "single" in step.recover) {
    assert.equal(step.recover.single.type, "say");
  }
});

test("run recover: parses inline recover block", () => {
  const step = asRunExec(parseOneWorkflowStep(['run fix() recover(e) { log "a"; run patch() }']));
  if (step.recover && "block" in step.recover) {
    assert.equal(step.recover.block.length, 2);
    assert.equal(step.recover.block[0].type, "say");
    assert.equal(step.recover.block[1].type, "exec");
  }
});

test("run recover: parses multiline recover block", () => {
  const step = asRunExec(parseOneWorkflowStep([
    "run deploy() recover(err) {",
    '    log "retrying"',
    "    run cleanup()",
    "  }",
  ]));
  if (step.recover && "block" in step.recover) {
    assert.equal(step.recover.block.length, 2);
    assert.equal(step.recover.block[0].type, "say");
    assert.equal(step.recover.block[1].type, "exec");
  }
});

test("run recover: rejects recover at EOL without body", () => {
  assert.throws(
    () => parseOneWorkflowStep(["run my_workflow() recover"]),
    /recover requires explicit bindings/,
  );
});

test("run recover: rejects recover without bindings", () => {
  assert.throws(
    () => parseOneWorkflowStep(["run my_workflow() recover {"]),
    /recover requires explicit bindings/,
  );
});

test("run recover: rejects recover with two bindings", () => {
  assert.throws(
    () => parseOneWorkflowStep(['run my_workflow() recover(a, b) { log "x" }']),
    /recover accepts exactly one binding/,
  );
});

test("run recover: empty recover block throws", () => {
  assert.throws(
    () => parseOneWorkflowStep(["run my_workflow() recover(err) { }"]),
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
  const step = asRunExec(w!.steps[0]);
  assert.ok(step.recover);
  assert.equal(step.catch, undefined);
});
