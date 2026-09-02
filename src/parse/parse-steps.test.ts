import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import type { StepDef } from "../types";

/**
 * After Refactor 2 the per-host catch/recover parsers (`parseEnsureStep`,
 * `parseRunCatchStep`, `parseRunRecoverStep`) and their mini body parser
 * (`parseCatchStatement`) are gone. The contract is now exercised end-to-end
 * through `parsejaiph` — `parseAttachedBlock` (in `src/parse/workflow-brace.ts`)
 * delegates body parsing to the same `parseBlockStatement` used at the top
 * level.
 */

function asRunExec(step: StepDef) {
  if (step.type !== "exec" || step.body.kind !== "call") {
    throw new Error(`expected exec/call step, got ${step.type}`);
  }
  return step;
}

function parseOneWorkflowStep(bodyLines: string[]): StepDef {
  const src = ["def w() {", ...bodyLines.map((l) => `  ${l}`), "}", ""].join("\n");
  const mod = parsejaiph(src, "fixture.jh");
  const w = mod.defs.find((x) => x.name === "w");
  if (!w) throw new Error("def not found");
  const steps = w.steps.filter((s) => s.type !== "trivia");
  if (steps.length !== 1) throw new Error(`expected one step, got ${steps.length}`);
  return steps[0];
}

// === run: basic ===

test("run: parses basic run call", () => {
  const e = asRunExec(parseOneWorkflowStep(["run my_rule()"]));
  assert.equal(e.body.kind, "call");
  if (e.body.kind === "call") {
    assert.equal(e.body.callee.value, "my_rule");
  }
  assert.equal(e.catch, undefined);
});

test("run: parses run with args", () => {
  const e = asRunExec(parseOneWorkflowStep(['run my_rule("arg1")']));
  if (e.body.kind === "call") {
    assert.equal(e.body.callee.value, "my_rule");
    assert.deepEqual(e.body.args, [{ kind: "literal", raw: '"arg1"' }]);
  }
});

test("run: parses run with dotted ref", () => {
  const e = asRunExec(parseOneWorkflowStep(["run lib.check()"]));
  if (e.body.kind === "call") {
    assert.equal(e.body.callee.value, "lib.check");
  }
});

test("run: run without parens throws", () => {
  assert.throws(
    () => parseOneWorkflowStep(["run my_rule"]),
    /parentheses are required/,
  );
});

// === run catch: single statement forms ===

test("run catch: parses single catch log statement", () => {
  const e = asRunExec(parseOneWorkflowStep(['run my_rule() catch (failure) log "failed"']));
  assert.ok(e.catch);
  assert.equal(e.catch!.bindings.failure, "failure");
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "say");
  }
});

test("run catch: parses single catch run statement", () => {
  const e = asRunExec(parseOneWorkflowStep(["run my_rule() catch (err) run fallback()"]));
  assert.ok(e.catch);
  assert.equal(e.catch!.bindings.failure, "err");
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "exec");
  }
});

test("run catch: wait statement is rejected", () => {
  assert.throws(
    () => parseOneWorkflowStep(["run my_rule() catch (failure) wait"]),
    /"wait" has been removed from the language/,
  );
});

test("run catch: parses single catch fail statement", () => {
  const e = asRunExec(parseOneWorkflowStep(['run my_rule() catch (failure) fail "reason"']));
  assert.ok(e.catch);
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "say");
    if (e.catch.single.type === "say") {
      assert.equal(e.catch.single.level, "fail");
    }
  }
});

// === run catch: inline block ===

test("run catch: parses inline catch block", () => {
  const e = asRunExec(parseOneWorkflowStep(['run my_rule() catch (failure) { log "a"; log "b" }']));
  if (e.catch && "block" in e.catch) {
    assert.equal(e.catch.block.length, 2);
    assert.equal(e.catch.block[0].type, "say");
    assert.equal(e.catch.block[1].type, "say");
  }
});

// === run catch: multiline block ===

test("run catch: parses multiline catch block", () => {
  const e = asRunExec(parseOneWorkflowStep([
    "run my_rule() catch (failure) {",
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

test("run catch: multiline block with triple-quoted prompt", () => {
  const e = asRunExec(parseOneWorkflowStep([
    "run gate() catch (err) {",
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

test("run catch: comment lines become trivia", () => {
  const e = asRunExec(parseOneWorkflowStep([
    "run gate() catch (err) {",
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

// === run catch: bindings ===

test("run catch: rejects two bindings", () => {
  assert.throws(
    () => parseOneWorkflowStep(['run my_rule() catch (failure, attempt) { log "retry" }']),
    /catch accepts exactly one binding.*attempt.*has been removed/,
  );
});

// === run catch: error messages ===

test("run catch: catch at EOL without block throws", () => {
  assert.throws(
    () => parseOneWorkflowStep(["run my_rule() catch"]),
    /catch requires explicit bindings/,
  );
});

test("run catch: catch without bindings throws", () => {
  assert.throws(
    () => parseOneWorkflowStep(["run my_rule() catch {"]),
    /catch requires explicit bindings/,
  );
});

test("run catch: unterminated multiline catch block throws", () => {
  assert.throws(
    () => parsejaiph(
      [
        "def w() {",
        "  run my_rule() catch (failure) {",
        '    log "recovering"',
        "",
      ].join("\n"),
      "fixture.jh",
    ),
    /unterminated catch block/,
  );
});

test("run catch: empty catch block throws", () => {
  assert.throws(
    () => parseOneWorkflowStep([
      "run my_rule() catch (failure) {",
      "  }",
    ]),
    /catch block must contain at least one statement/,
  );
});

test("run catch: empty inline catch block throws", () => {
  assert.throws(
    () => parseOneWorkflowStep(["run my_rule() catch (failure) { }"]),
    /catch block must contain at least one statement/,
  );
});

// === run catch: statement varieties ===

test("run catch: single shell command", () => {
  const e = asRunExec(parseOneWorkflowStep(["run my_rule() catch (failure) echo fallback"]));
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "exec");
    if (e.catch.single.type === "exec") {
      assert.equal(e.catch.single.body.kind, "shell");
    }
  }
});

test("run catch: single logerr statement", () => {
  const e = asRunExec(parseOneWorkflowStep(['run my_rule() catch (failure) logerr "error msg"']));
  if (e.catch && "single" in e.catch) {
    assert.equal(e.catch.single.type, "say");
    if (e.catch.single.type === "say") {
      assert.equal(e.catch.single.level, "logerr");
    }
  }
});

test("parsejaiph: def with run catch and multiline triple-quoted prompt", () => {
  const src = [
    "def gate() {",
    "  run noop()",
    "}",
    "script noop = `true`",
    "def w() {",
    "  run gate() catch (err) {",
    '    prompt """',
    "      hello",
    '    """',
    "  }",
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(src, "catch_prompt.jh");
  const w = mod.defs.find((x) => x.name === "w");
  assert.ok(w);
  const e = asRunExec(w!.steps[0]);
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

test("parsejaiph: def with run recover block", () => {
  const src = [
    "def deploy() {",
    '  run setup() recover(err) {',
    '    log "fixing"',
    '    run fix()',
    '  }',
    "}",
    "def setup() {",
    '  log "setup"',
    "}",
    "def fix() {",
    '  log "fix"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(src, "recover_test.jh");
  const w = mod.defs.find((x) => x.name === "deploy");
  assert.ok(w);
  const step = asRunExec(w!.steps[0]);
  assert.ok(step.recover);
  assert.equal(step.catch, undefined);
});

// === else if chaining (desugars to nested if/else) ===

/** Strip `loc` recursively so structural comparisons ignore source positions. */
function stripLoc(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLoc);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "loc") continue;
      out[k] = stripLoc(v);
    }
    return out;
  }
  return value;
}

test("else if: chain desugars to the manually nested if/else equivalent", () => {
  const sugar = [
    "def w() {",
    '  if a == "x" {',
    '    log "x"',
    '  } else if a == "y" {',
    '    log "y"',
    "  } else {",
    '    log "other"',
    "  }",
    "}",
    "",
  ].join("\n");
  const nested = [
    "def w() {",
    '  if a == "x" {',
    '    log "x"',
    "  } else {",
    '    if a == "y" {',
    '      log "y"',
    "    } else {",
    '      log "other"',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
  const sugarSteps = parsejaiph(sugar, "fixture.jh").defs[0].steps;
  const nestedSteps = parsejaiph(nested, "fixture.jh").defs[0].steps;
  assert.deepEqual(stripLoc(sugarSteps), stripLoc(nestedSteps));
});

test("else if: arbitrary depth chains nest right", () => {
  const step = parseOneWorkflowStep([
    'if a == "x" {',
    '  log "x"',
    '} else if a == "y" {',
    '  log "y"',
    '} else if a == "z" {',
    '  log "z"',
    "} else {",
    '  log "w"',
    "}",
  ]);
  assert.equal(step.type, "if");
  if (step.type !== "if") return;
  // elseBody of each arm is a single nested `if` until the terminal `else`.
  const arm2 = step.elseBody!;
  assert.equal(arm2.length, 1);
  assert.equal(arm2[0].type, "if");
  const arm3 = (arm2[0] as Extract<StepDef, { type: "if" }>).elseBody!;
  assert.equal(arm3.length, 1);
  assert.equal(arm3[0].type, "if");
  const terminal = (arm3[0] as Extract<StepDef, { type: "if" }>).elseBody!;
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, "say");
});

test("else if: empty else-if body is E_PARSE", () => {
  assert.throws(
    () =>
      parseOneWorkflowStep([
        'if a == "x" {',
        '  log "x"',
        '} else if a == "y" {',
        "} else {",
        '  log "z"',
        "}",
      ]),
    /E_PARSE "else if" body cannot be empty/,
  );
});

test("else if: malformed else if without a condition is E_PARSE", () => {
  assert.throws(
    () =>
      parseOneWorkflowStep([
        'if a == "x" {',
        '  log "x"',
        "} else if {",
        '  log "y"',
        "}",
      ]),
    /E_PARSE invalid if syntax/,
  );
});

test("else if: else if on its own line (not attached to closing brace) is E_PARSE", () => {
  assert.throws(
    () =>
      parseOneWorkflowStep([
        'if a == "x" {',
        '  log "x"',
        "}",
        'else if a == "y" {',
        '  log "y"',
        "}",
      ]),
    /E_PARSE "else if" must appear on the same line as the closing/,
  );
});
