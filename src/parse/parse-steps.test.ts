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
    assert.equal(step.recover, undefined);
  }
  assert.equal(nextIdx, 0);
});

test("parseEnsureStep: parses ensure with args", () => {
  const lines = ['  ensure my_rule("arg1")'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule("arg1")');
  if (step.type === "ensure") {
    assert.equal(step.ref.value, "my_rule");
    assert.equal(step.args, '"arg1"');
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
    assert.ok(step.recover);
    assert.equal(step.recover.bindings.failure, "failure");
    if ("single" in step.recover) {
      assert.equal(step.recover.single.type, "log");
    }
  }
});

test("parseEnsureStep: parses ensure with catch run statement", () => {
  const lines = ["  ensure my_rule() catch (err) run fallback()"];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() catch (err) run fallback()");
  if (step.type === "ensure") {
    assert.ok(step.recover);
    assert.equal(step.recover.bindings.failure, "err");
    if ("single" in step.recover) {
      assert.equal(step.recover.single.type, "run");
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
    assert.ok(step.recover);
    if ("single" in step.recover) {
      assert.equal(step.recover.single.type, "fail");
    }
  }
});

// === parseEnsureStep: catch with inline block ===

test("parseEnsureStep: parses ensure with inline catch block", () => {
  const lines = ['  ensure my_rule() catch (failure) { log "a"; log "b" }'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() catch (failure) { log "a"; log "b" }');
  if (step.type === "ensure") {
    assert.ok(step.recover);
    if ("block" in step.recover) {
      assert.equal(step.recover.block.length, 2);
      assert.equal(step.recover.block[0].type, "log");
      assert.equal(step.recover.block[1].type, "log");
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
    assert.ok(step.recover);
    if ("block" in step.recover) {
      assert.equal(step.recover.block.length, 2);
      assert.equal(step.recover.block[0].type, "log");
      assert.equal(step.recover.block[1].type, "run");
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
  if (step.type === "ensure" && step.recover && "block" in step.recover) {
    assert.equal(step.recover.block.length, 3);
    assert.equal(step.recover.block[0].type, "run");
    const p = step.recover.block[1];
    assert.equal(p.type, "prompt");
    if (p.type === "prompt") {
      assert.equal(p.bodyKind, "triple_quoted");
      assert.ok(p.raw.includes("fix CI"));
    }
    assert.equal(step.recover.block[2].type, "run");
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
  if (step.type === "ensure" && step.recover && "block" in step.recover) {
    assert.equal(step.recover.block.length, 2);
    assert.equal(step.recover.block[0].type, "comment");
    assert.equal(step.recover.block[1].type, "run");
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
    assert.ok(step.recover);
    if ("single" in step.recover) {
      assert.equal(step.recover.single.type, "shell");
    }
  }
});

test("parseEnsureStep: catch with logerr statement", () => {
  const lines = ['  ensure my_rule() catch (failure) logerr "error msg"'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() catch (failure) logerr "error msg"');
  if (step.type === "ensure") {
    assert.ok(step.recover);
    if ("single" in step.recover) {
      assert.equal(step.recover.single.type, "logerr");
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
  if (ensureStep.type === "ensure" && ensureStep.recover && "block" in ensureStep.recover) {
    assert.equal(ensureStep.recover.block.length, 1);
    const p = ensureStep.recover.block[0];
    assert.equal(p.type, "prompt");
    if (p.type === "prompt") {
      assert.equal(p.bodyKind, "triple_quoted");
      assert.ok(p.raw.includes("hello"));
    }
  }
});

// === parseRunRecoverStep: recover with inline block ===

test("parseRunRecoverStep: parses run with inline recover block", () => {
  const lines = ['  run my_wf() recover(err) { log "retrying" }'];
  const result = parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], 'my_wf() recover(err) { log "retrying" }');
  assert.ok(result);
  assert.equal(result!.step.type, "run");
  if (result!.step.type === "run") {
    assert.ok(result!.step.recoverLoop);
    assert.equal(result!.step.recoverLoop!.bindings.failure, "err");
    if ("block" in result!.step.recoverLoop!) {
      assert.equal(result!.step.recoverLoop!.block.length, 1);
      assert.equal(result!.step.recoverLoop!.block[0].type, "log");
    }
  }
});

test("parseRunRecoverStep: parses run with multiline recover block", () => {
  const lines = [
    "  run my_wf() recover(err) {",
    '    log "repair"',
    "    run fix()",
    "  }",
  ];
  const result = parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], "my_wf() recover(err) {");
  assert.ok(result);
  if (result!.step.type === "run" && result!.step.recoverLoop && "block" in result!.step.recoverLoop) {
    assert.equal(result!.step.recoverLoop.block.length, 2);
    assert.equal(result!.step.recoverLoop.block[0].type, "log");
    assert.equal(result!.step.recoverLoop.block[1].type, "run");
  }
  assert.equal(result!.nextIdx, 3);
});

test("parseRunRecoverStep: parses single-statement recover", () => {
  const lines = ['  run my_wf() recover(err) log "retry"'];
  const result = parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], 'my_wf() recover(err) log "retry"');
  assert.ok(result);
  if (result!.step.type === "run" && result!.step.recoverLoop && "single" in result!.step.recoverLoop) {
    assert.equal(result!.step.recoverLoop.single.type, "log");
  }
});

test("parseRunRecoverStep: returns null when no recover keyword", () => {
  const lines = ["  run my_wf()"];
  const result = parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], "my_wf()");
  assert.equal(result, null);
});

test("parseRunRecoverStep: recover at EOL throws", () => {
  const lines = ["  run my_wf() recover"];
  assert.throws(
    () => parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], "my_wf() recover"),
    /recover requires explicit bindings/,
  );
});

test("parseRunRecoverStep: recover with two bindings throws", () => {
  const lines = ['  run my_wf() recover(err, attempt) { log "retry" }'];
  assert.throws(
    () => parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], 'my_wf() recover(err, attempt) { log "retry" }'),
    /recover accepts exactly one binding/,
  );
});

test("parseRunRecoverStep: empty recover block throws", () => {
  const lines = ["  run my_wf() recover(err) { }"];
  assert.throws(
    () => parseRunRecoverStep("test.jh", lines, 0, 1, lines[0], "my_wf() recover(err) { }"),
    /recover block must contain at least one statement/,
  );
});

// === parsejaiph: recover is distinct from catch ===

test("parsejaiph: workflow with recover creates recoverLoop not recover", () => {
  const src = [
    "workflow w() {",
    "  run my_wf() recover(err) {",
    '    log "retrying"',
    "  }",
    "}",
    "workflow my_wf() {",
    '  log "hello"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(src, "recover.jh");
  const w = mod.workflows.find((x) => x.name === "w");
  assert.ok(w);
  const runStep = w!.steps[0];
  assert.equal(runStep.type, "run");
  if (runStep.type === "run") {
    assert.equal(runStep.recover, undefined);
    assert.ok(runStep.recoverLoop);
    assert.equal(runStep.recoverLoop!.bindings.failure, "err");
  }
});

// === formatter: recover round-trip ===

test("parsejaiph: recover round-trips through formatter", () => {
  const { emitModule } = require("../format/emit");
  const src = [
    "workflow w() {",
    "  run my_wf() recover(err) {",
    '    log "retrying"',
    "  }",
    "}",
    "workflow my_wf() {",
    '  log "hello"',
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(src, "recover_fmt.jh");
  const emitted = emitModule(mod);
  assert.ok(emitted.includes("recover(err)"));
  assert.ok(!emitted.includes("catch"));
});
