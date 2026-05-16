import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import { parseEnsureStep, parseRunRecoverStep } from "./steps";

// === parseEnsureStep: basic ensure without catch ===

test("parseEnsureStep: parses basic ensure call", () => {
  const lines = ["  ensure my_rule()"];
  const { step, nextIdx } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule()");
  assert.equal(step.type, "ensure");
  if (step.type === "ensure") {
    assert.equal(step.ref.value, "my_rule");
    assert.equal(step.catch, undefined);
  }
  assert.equal(nextIdx, 0);
});

test("parseEnsureStep: parses ensure with args", () => {
  const lines = ['  ensure my_rule("arg1")'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule("arg1")');
  if (step.type === "ensure") {
    assert.equal(step.ref.value, "my_rule");
    assert.deepEqual(step.args, [{ kind: "literal", raw: '"arg1"' }]);
  }
});

test("parseEnsureStep: parses ensure with dotted ref", () => {
  const lines = ["  ensure lib.check()"];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "lib.check()");
  if (step.type === "ensure") {
    assert.equal(step.ref.value, "lib.check");
  }
});

test("parseEnsureStep: parses ensure with captureName", () => {
  const lines = ["  result = ensure my_rule()"];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule()", "result");
  if (step.type === "ensure") {
    assert.equal(step.captureName, "result");
  }
});

test("parseEnsureStep: ensure without parens parses as zero-arg call", () => {
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
  if (step.type === "ensure") {
    assert.ok(step.catch);
    assert.equal(step.catch.bindings.failure, "failure");
    if ("single" in step.catch) {
      assert.equal(step.catch.single.type, "log");
    }
  }
});

test("parseEnsureStep: parses ensure with catch run statement", () => {
  const lines = ["  ensure my_rule() catch (err) run fallback()"];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() catch (err) run fallback()");
  if (step.type === "ensure") {
    assert.ok(step.catch);
    assert.equal(step.catch.bindings.failure, "err");
    if ("single" in step.catch) {
      assert.equal(step.catch.single.type, "run");
    }
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
  if (step.type === "ensure") {
    assert.ok(step.catch);
    if ("single" in step.catch) {
      assert.equal(step.catch.single.type, "fail");
    }
  }
});

// === parseEnsureStep: catch with inline block ===

test("parseEnsureStep: parses ensure with inline catch block", () => {
  const lines = ['  ensure my_rule() catch (failure) { log "a"; log "b" }'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() catch (failure) { log "a"; log "b" }');
  if (step.type === "ensure") {
    assert.ok(step.catch);
    if ("block" in step.catch) {
      assert.equal(step.catch.block.length, 2);
      assert.equal(step.catch.block[0].type, "log");
      assert.equal(step.catch.block[1].type, "log");
    }
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
  if (step.type === "ensure") {
    assert.ok(step.catch);
    if ("block" in step.catch) {
      assert.equal(step.catch.block.length, 2);
      assert.equal(step.catch.block[0].type, "log");
      assert.equal(step.catch.block[1].type, "run");
    }
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
  assert.equal(step.type, "ensure");
  if (step.type === "ensure" && step.catch && "block" in step.catch) {
    assert.equal(step.catch.block.length, 3);
    assert.equal(step.catch.block[0].type, "run");
    const p = step.catch.block[1];
    assert.equal(p.type, "prompt");
    if (p.type === "prompt") {
      assert.ok(p.raw.includes("fix CI"));
    }
    assert.equal(step.catch.block[2].type, "run");
  }
  assert.equal(nextIdx, 6);
});

test("parseEnsureStep: catch block lines starting with # are comments not shell", () => {
  const lines = [
    "  ensure gate() catch (err) {",
    "    # note",
    "    run retry()",
    "  }",
  ];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "gate() catch (err) {");
  assert.equal(step.type, "ensure");
  if (step.type === "ensure" && step.catch && "block" in step.catch) {
    assert.equal(step.catch.block.length, 2);
    assert.equal(step.catch.block[0].type, "comment");
    assert.equal(step.catch.block[1].type, "run");
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
  if (step.type === "ensure") {
    assert.ok(step.catch);
    if ("single" in step.catch) {
      assert.equal(step.catch.single.type, "shell");
    }
  }
});

test("parseEnsureStep: catch with logerr statement", () => {
  const lines = ['  ensure my_rule() catch (failure) logerr "error msg"'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() catch (failure) logerr "error msg"');
  if (step.type === "ensure") {
    assert.ok(step.catch);
    if ("single" in step.catch) {
      assert.equal(step.catch.single.type, "logerr");
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
  assert.equal(ensureStep.type, "ensure");
  if (ensureStep.type === "ensure" && ensureStep.catch && "block" in ensureStep.catch) {
    assert.equal(ensureStep.catch.block.length, 1);
    const p = ensureStep.catch.block[0];
    assert.equal(p.type, "prompt");
    if (p.type === "prompt") {
      assert.ok(p.raw.includes("hello"));
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
  const step = result!.step;
  assert.equal(step.type, "run");
  if (step.type === "run") {
    assert.equal(step.workflow.value, "my_workflow");
    assert.ok(step.recover);
    assert.equal(step.recover!.bindings.failure, "err");
    if ("single" in step.recover!) {
      assert.equal(step.recover!.single.type, "log");
    }
  }
});

test("parseRunRecoverStep: parses run with inline recover block", () => {
  const lines = ['  run fix() recover(e) { log "a"; run patch() }'];
  const result = parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], 'fix() recover(e) { log "a"; run patch() }');
  assert.ok(result);
  const step = result!.step;
  if (step.type === "run" && step.recover && "block" in step.recover) {
    assert.equal(step.recover.block.length, 2);
    assert.equal(step.recover.block[0].type, "log");
    assert.equal(step.recover.block[1].type, "run");
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
  const step = result!.step;
  if (step.type === "run" && step.recover && "block" in step.recover) {
    assert.equal(step.recover.block.length, 2);
    assert.equal(step.recover.block[0].type, "log");
    assert.equal(step.recover.block[1].type, "run");
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

// === parsejaiph: full workflow with recover ===

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
  const runStep = w!.steps[0];
  assert.equal(runStep.type, "run");
  if (runStep.type === "run") {
    assert.ok(runStep.recover);
    assert.equal(runStep.catch, undefined);
  }
});
