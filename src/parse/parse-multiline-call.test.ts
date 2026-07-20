import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

// ─── positive: single-line triple-quoted arg (multiline content) ─────────────

test("triple-quoted call arg stored as Arg literal, not shell", () => {
  const src = [
    "workflow helper(prompt_text) {",
    '  return "${prompt_text}"',
    "}",
    "workflow default() {",
    '  return run helper(',
    '    "x",',
    '    """',
    "    line1",
    "    line2",
    '    """,',
    "    x",
    "  )",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const wf = mod.workflows.find((w) => w.name === "default")!;
  const step = wf.steps[0];
  assert.equal(step.type, "return");
  if (step.type !== "return") return;
  assert.equal(step.value.kind, "call");
  if (step.value.kind !== "call") return;
  const args = step.value.args!;
  assert.equal(args.length, 3);
  assert.deepEqual(args[0], { kind: "literal", raw: '"x"' });
  // triple-quoted arg is stored as a literal (not shell)
  assert.equal(args[1].kind, "literal", "triple-quoted arg must be stored as Arg literal, not shell");
  // raw must be a double-quoted string containing the dedented body
  assert.ok((args[1] as { kind: "literal"; raw: string }).raw.startsWith('"'), "raw must be double-quoted");
  assert.ok((args[1] as { kind: "literal"; raw: string }).raw.includes("line1"), "raw must include body content");
  assert.deepEqual(args[2], { kind: "var", name: "x" });
});

// ─── positive: multiline form with return run ────────────────────────────────

test("return run multiline call parses — three args including triple-quoted", () => {
  const src = [
    "workflow helper(a, b, c) {",
    '  return "${a}"',
    "}",
    "workflow default() {",
    "  return run helper(",
    '    "codebase",',
    '    """',
    "    Review the ENTIRE repository",
    '    """,',
    "    helper",
    "  )",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const wf = mod.workflows.find((w) => w.name === "default")!;
  const step = wf.steps[0];
  assert.equal(step.type, "return");
  if (step.type !== "return") return;
  assert.equal(step.value.kind, "call");
  if (step.value.kind !== "call") return;
  assert.equal(step.value.callee.value, "helper");
  const args = step.value.args!;
  assert.equal(args.length, 3);
  assert.equal(args[0].kind, "literal");
  assert.equal(args[1].kind, "literal"); // triple-quoted, not shell
  assert.equal(args[2].kind, "var");
  assert.equal((args[2] as { kind: "var"; name: string }).name, "helper");
});

// ─── positive: multiline run statement ───────────────────────────────────────

test("standalone run multiline call parses", () => {
  const src = [
    "workflow helper(a, b) {",
    '  return "${a}"',
    "}",
    "workflow default() {",
    "  run helper(",
    '    "first",',
    '    """',
    "    second",
    '    """',
    "  )",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const wf = mod.workflows.find((w) => w.name === "default")!;
  const step = wf.steps[0];
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.equal(step.body.kind, "call");
  if (step.body.kind !== "call") return;
  assert.equal(step.body.callee.value, "helper");
  const args = step.body.args!;
  assert.equal(args.length, 2);
  assert.equal(args[0].kind, "literal");
  assert.equal(args[1].kind, "literal");
});

// ─── positive: multiline ensure statement ────────────────────────────────────

test("standalone ensure multiline call parses", () => {
  const src = [
    "rule checker(a) {",
    '  return "${a}"',
    "}",
    "workflow default() {",
    "  ensure checker(",
    '    "arg"',
    "  )",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const wf = mod.workflows.find((w) => w.name === "default")!;
  const step = wf.steps[0];
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.equal(step.body.kind, "ensure_call");
});

// ─── positive: return ensure multiline ───────────────────────────────────────

test("return ensure multiline call parses", () => {
  const src = [
    "rule checker(a) {",
    '  return "${a}"',
    "}",
    "workflow default() {",
    "  return ensure checker(",
    '    "arg"',
    "  )",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const wf = mod.workflows.find((w) => w.name === "default")!;
  const step = wf.steps[0];
  assert.equal(step.type, "return");
  if (step.type !== "return") return;
  assert.equal(step.value.kind, "ensure_call");
});

// ─── positive: const = run multiline ─────────────────────────────────────────

test("const = run multiline call parses", () => {
  const src = [
    "workflow helper(a, b) {",
    '  return "${a}"',
    "}",
    "workflow default() {",
    "  const result = run helper(",
    '    "x",',
    '    """',
    "    body",
    '    """',
    "  )",
    '  return "${result}"',
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const wf = mod.workflows.find((w) => w.name === "default")!;
  const constStep = wf.steps[0];
  assert.equal(constStep.type, "const");
  if (constStep.type !== "const") return;
  assert.equal(constStep.name, "result");
  assert.equal(constStep.value.kind, "call");
  if (constStep.value.kind !== "call") return;
  const args = constStep.value.args!;
  assert.equal(args.length, 2);
  assert.equal(args[0].kind, "literal");
  assert.equal(args[1].kind, "literal"); // triple-quoted
});

// ─── negative: incomplete managed call → E_PARSE, not shell ─────────────────

test("return run with unclosed paren is E_PARSE, not shell", () => {
  assert.throws(
    () =>
      parsejaiph(
        [
          "workflow default() {",
          "  return run missing_close(",
          "}",
        ].join("\n"),
        "test.jh",
      ),
    (err: unknown) => {
      const msg = (err as Error).message ?? "";
      // Must be E_PARSE; must not silently compile to a shell step
      assert.ok(msg.includes("E_PARSE"), `expected E_PARSE, got: ${msg}`);
      return true;
    },
  );
});

test("return ensure with unclosed paren is E_PARSE, not shell", () => {
  assert.throws(
    () =>
      parsejaiph(
        [
          "workflow default() {",
          "  return ensure missing_close(",
          "}",
        ].join("\n"),
        "test.jh",
      ),
    (err: unknown) => {
      const msg = (err as Error).message ?? "";
      assert.ok(msg.includes("E_PARSE"), `expected E_PARSE, got: ${msg}`);
      return true;
    },
  );
});

test("standalone run with unclosed paren is E_PARSE, not shell", () => {
  assert.throws(
    () =>
      parsejaiph(
        [
          "workflow helper() {",
          '  return "ok"',
          "}",
          "workflow default() {",
          "  run helper(",
          "}",
        ].join("\n"),
        "test.jh",
      ),
    (err: unknown) => {
      const msg = (err as Error).message ?? "";
      assert.ok(msg.includes("E_PARSE"), `expected E_PARSE, got: ${msg}`);
      return true;
    },
  );
});

// ─── regression: bare-identifier return run still falls through to shell ─────

test("return run bare identifier (no parens) still falls through to shell", () => {
  const mod = parsejaiph(
    `workflow default() {\n  return run helper\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec") {
    assert.equal(step.body.kind, "shell");
  }
});

test("return ensure bare identifier (no parens) still falls through to shell", () => {
  const mod = parsejaiph(
    `rule check() {\n  return "ok"\n}\nworkflow default() {\n  return ensure check\n}`,
    "test.jh",
  );
  const step = mod.workflows[0].steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec") {
    assert.equal(step.body.kind, "shell");
  }
});

// ─── existing single-line calls still work unchanged ─────────────────────────

test("single-line run with double-quoted args still works", () => {
  const mod = parsejaiph(
    'workflow deploy(env, ver) {\n  return "${env}"\n}\nworkflow default() {\n  run deploy("prod", "v1")\n}',
    "test.jh",
  );
  const step = mod.workflows.find((w) => w.name === "default")!.steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.deepEqual(step.body.args, [
      { kind: "literal", raw: '"prod"' },
      { kind: "literal", raw: '"v1"' },
    ]);
  }
});
