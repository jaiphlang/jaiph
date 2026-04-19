import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import { parseRunRecoverStep } from "./steps";

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
