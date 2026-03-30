import test from "node:test";
import assert from "node:assert/strict";
import { parseEnsureStep } from "./steps";

// === parseEnsureStep: basic ensure without recover ===

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

test("parseEnsureStep: ensure without parens throws", () => {
  const lines = ["  ensure my_rule"];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule"),
    /calls require parentheses/,
  );
});

// === parseEnsureStep: recover with single statement ===

test("parseEnsureStep: parses ensure with single recover statement", () => {
  const lines = ['  ensure my_rule() recover log "failed"'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() recover log "failed"');
  if (step.type === "ensure") {
    assert.ok(step.recover);
    if ("single" in step.recover) {
      assert.equal(step.recover.single.type, "log");
    }
  }
});

test("parseEnsureStep: parses ensure with recover run statement", () => {
  const lines = ["  ensure my_rule() recover run fallback()"];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() recover run fallback()");
  if (step.type === "ensure") {
    assert.ok(step.recover);
    if ("single" in step.recover) {
      assert.equal(step.recover.single.type, "run");
    }
  }
});

test("parseEnsureStep: parses ensure with recover wait statement", () => {
  const lines = ["  ensure my_rule() recover wait"];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() recover wait");
  if (step.type === "ensure") {
    assert.ok(step.recover);
    if ("single" in step.recover) {
      assert.equal(step.recover.single.type, "wait");
    }
  }
});

test("parseEnsureStep: parses ensure with recover fail statement", () => {
  const lines = ['  ensure my_rule() recover fail "reason"'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() recover fail "reason"');
  if (step.type === "ensure") {
    assert.ok(step.recover);
    if ("single" in step.recover) {
      assert.equal(step.recover.single.type, "fail");
    }
  }
});

// === parseEnsureStep: recover with inline block ===

test("parseEnsureStep: parses ensure with inline recover block", () => {
  const lines = ['  ensure my_rule() recover { log "a"; log "b" }'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() recover { log "a"; log "b" }');
  if (step.type === "ensure") {
    assert.ok(step.recover);
    if ("block" in step.recover) {
      assert.equal(step.recover.block.length, 2);
      assert.equal(step.recover.block[0].type, "log");
      assert.equal(step.recover.block[1].type, "log");
    }
  }
});

// === parseEnsureStep: recover with multiline block ===

test("parseEnsureStep: parses ensure with multiline recover block", () => {
  const lines = [
    "  ensure my_rule() recover {",
    '    log "recovering"',
    "    run fallback()",
    "  }",
  ];
  const { step, nextIdx } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() recover {");
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

// === parseEnsureStep: recover errors ===

test("parseEnsureStep: recover at EOL without block throws", () => {
  const lines = ["  ensure my_rule() recover"];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() recover"),
    /recover requires a \{ \.\.\. \} block/,
  );
});

test("parseEnsureStep: unterminated multiline recover block throws", () => {
  const lines = [
    "  ensure my_rule() recover {",
    '    log "recovering"',
  ];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() recover {"),
    /unterminated recover block/,
  );
});

test("parseEnsureStep: empty recover block throws", () => {
  const lines = [
    "  ensure my_rule() recover {",
    "  }",
  ];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() recover {"),
    /recover block must contain at least one statement/,
  );
});

test("parseEnsureStep: empty inline recover block throws", () => {
  const lines = ["  ensure my_rule() recover { }"];
  assert.throws(
    () => parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() recover { }"),
    /recover block must contain at least one statement/,
  );
});

// === parseEnsureStep: recover statement types ===

test("parseEnsureStep: recover with shell command", () => {
  const lines = ["  ensure my_rule() recover echo fallback"];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], "my_rule() recover echo fallback");
  if (step.type === "ensure") {
    assert.ok(step.recover);
    if ("single" in step.recover) {
      assert.equal(step.recover.single.type, "shell");
    }
  }
});

test("parseEnsureStep: recover with logerr statement", () => {
  const lines = ['  ensure my_rule() recover logerr "error msg"'];
  const { step } = parseEnsureStep("test.jh", lines, 0, 1, lines[0], 'my_rule() recover logerr "error msg"');
  if (step.type === "ensure") {
    assert.ok(step.recover);
    if ("single" in step.recover) {
      assert.equal(step.recover.single.type, "logerr");
    }
  }
});
