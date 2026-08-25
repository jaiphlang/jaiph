import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

// ─── positive: single-line triple-quoted arg (multiline content) ─────────────

test("triple-quoted call arg stored as Arg literal, not shell", () => {
  const src = [
    "def helper(prompt_text) {",
    '  return "${prompt_text}"',
    "}",
    "export def main() {",
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
  const wf = mod.defs.find((w) => w.name === "main")!;
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
    "def helper(a, b, c) {",
    '  return "${a}"',
    "}",
    "export def main() {",
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
  const wf = mod.defs.find((w) => w.name === "main")!;
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
    "def helper(a, b) {",
    '  return "${a}"',
    "}",
    "export def main() {",
    "  run helper(",
    '    "first",',
    '    """',
    "    second",
    '    """',
    "  )",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const wf = mod.defs.find((w) => w.name === "main")!;
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

// ─── positive: multiline run statement ────────────────────────────────────

test("standalone run multiline call parses", () => {
  const src = [
    "def checker(a) {",
    '  return "${a}"',
    "}",
    "export def main() {",
    "  run checker(",
    '    "arg"',
    "  )",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const wf = mod.defs.find((w) => w.name === "main")!;
  const step = wf.steps[0];
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.equal(step.body.kind, "call");
});

// ─── positive: return run multiline ───────────────────────────────────────

test("return run multiline call parses", () => {
  const src = [
    "def checker(a) {",
    '  return "${a}"',
    "}",
    "export def main() {",
    "  return run checker(",
    '    "arg"',
    "  )",
    "}",
  ].join("\n");
  const mod = parsejaiph(src, "test.jh");
  const wf = mod.defs.find((w) => w.name === "main")!;
  const step = wf.steps[0];
  assert.equal(step.type, "return");
  if (step.type !== "return") return;
  assert.equal(step.value.kind, "call");
});

// ─── positive: const = run multiline ─────────────────────────────────────────

test("const = run multiline call parses", () => {
  const src = [
    "def helper(a, b) {",
    '  return "${a}"',
    "}",
    "export def main() {",
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
  const wf = mod.defs.find((w) => w.name === "main")!;
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
          "export def main() {",
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

test("return run with unclosed paren is E_PARSE, not shell", () => {
  assert.throws(
    () =>
      parsejaiph(
        [
          "export def main() {",
          "  return run missing_close(",
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
          "def helper() {",
          '  return "ok"',
          "}",
          "export def main() {",
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
    `export def main() {\n  return run helper\n}`,
    "test.jh",
  );
  const step = mod.defs[0].steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec") {
    assert.equal(step.body.kind, "shell");
  }
});

test("return run bare identifier (no parens) still falls through to shell", () => {
  const mod = parsejaiph(
    `def check() {\n  return "ok"\n}\nexport def main() {\n  return run check\n}`,
    "test.jh",
  );
  const main = mod.defs.find((w) => w.name === "main")!;
  const step = main.steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec") {
    assert.equal(step.body.kind, "shell");
  }
});

// ─── existing single-line calls still work unchanged ─────────────────────────

test("single-line run with double-quoted args still works", () => {
  const mod = parsejaiph(
    'def deploy(env, ver) {\n  return "${env}"\n}\nexport def main() {\n  run deploy("prod", "v1")\n}',
    "test.jh",
  );
  const step = mod.defs.find((w) => w.name === "main")!.steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "call") {
    assert.deepEqual(step.body.args, [
      { kind: "literal", raw: '"prod"' },
      { kind: "literal", raw: '"v1"' },
    ]);
  }
});
