import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

function firstStep(body: string) {
  const src = ["export def main() {", `  ${body}`, "}"].join("\n");
  return parsejaiph(src, "test.jh").defs[0].steps[0];
}

// === bare call is the invoke form ===

test("bare call parses as an exec call step", () => {
  const step = firstStep('save("p")');
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.callee.value, "save");
    assert.deepEqual(step.body.args, [{ kind: "literal", raw: '"p"' }]);
    assert.equal(step.body.async, undefined);
  } else {
    assert.fail("expected an exec call step");
  }
});

test("bare call with several args", () => {
  const step = firstStep('deploy("prod", "v1")');
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.callee.value, "deploy");
    assert.deepEqual(step.body.args, [
      { kind: "literal", raw: '"prod"' },
      { kind: "literal", raw: '"v1"' },
    ]);
  }
});

test("nested call in argument position: foo(bar())", () => {
  const step = firstStep("foo(bar())");
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.callee.value, "foo");
    assert.deepEqual(step.body.args, [{ kind: "literal", raw: "bar()" }]);
  }
});

test("async bare call", () => {
  const step = firstStep("async bg_task()");
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.callee.value, "bg_task");
    assert.equal(step.body.async, true);
  }
});

test("inline script bare call", () => {
  const step = firstStep("'echo hello'()");
  assert.equal(step.type, "exec");
  assert.equal(step.type === "exec" && step.body.kind, "inline_script");
});

// === `run` is no longer a keyword ===

test("run save(p) is E_PARSE and does not mention a script block", () => {
  assert.throws(
    () => parsejaiph('export def main() {\n  run save("p")\n}', "test.jh"),
    (err: Error) => {
      assert.match(err.message, /E_PARSE/);
      assert.match(err.message, /'run' is not a keyword/);
      assert.doesNotMatch(err.message, /script block/);
      return true;
    },
  );
});

test("run async save(p) is E_PARSE", () => {
  assert.throws(
    () => parsejaiph('export def main() {\n  run async save("p")\n}', "test.jh"),
    /'run' is not a keyword/,
  );
});

test("a symbol may be named run: run() is a bare call", () => {
  const step = firstStep("run()");
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.equal(step.body.callee.value, "run");
  }
});

test("return run helper() is E_PARSE", () => {
  assert.throws(
    () => parsejaiph('export def main() {\n  return run helper()\n}', "test.jh"),
    /'run' is not a keyword/,
  );
});

test("const x = run helper() is E_PARSE", () => {
  assert.throws(
    () => parsejaiph('export def main() {\n  const x = run helper()\n}', "test.jh"),
    /'run' is not a keyword/,
  );
});

// === const / return bare captures ===

test("const x = save(p) captures a call value", () => {
  const step = firstStep('const x = save("p")');
  assert.equal(step.type, "const");
  if (step.type === "const") {
    assert.equal(step.value.kind, "call");
  }
});

test("const h = async save(p) captures an async handle", () => {
  const step = firstStep('const h = async save("p")');
  assert.equal(step.type, "const");
  if (step.type === "const" && step.value.kind === "call") {
    assert.equal(step.value.async, true);
  }
});

test("return save(p) returns a call value", () => {
  const step = firstStep('return save("p")');
  assert.equal(step.type, "return");
  if (step.type === "return") {
    assert.equal(step.value.kind, "call");
  }
});

// === assignment without const still rejected ===

test("x = helper() without const is rejected", () => {
  assert.throws(
    () => parsejaiph('export def main() {\n  x = helper()\n}', "test.jh"),
    /assignment without "const" is no longer supported/,
  );
});

// === send payload call ===

test("send save(p) -> channel carries a call payload", () => {
  const mod = parsejaiph(
    ["channel out", "export def main() {", '  send save("p") -> out', "}"].join("\n"),
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "send");
  if (step.type === "send") {
    assert.equal(step.channel, "out");
    assert.equal(step.value.kind, "call");
  }
});

// === interpolation capture ${greet()} ===

test("interpolation capture ${greet()} parses inside a string", () => {
  const step = firstStep('log "got: ${greet()}"');
  assert.equal(step.type, "say");
});
