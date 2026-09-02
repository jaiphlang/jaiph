import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph, parsejaiphWithTrivia } from "../parser";
import { emitModule } from "../format/index";

// Nested (def-local) declarations: parse shape + bit-for-bit format round-trip,
// and the parse-time `export` rejection.

function roundtrip(src: string): string {
  const { ast, trivia } = parsejaiphWithTrivia(src, "t.jh");
  return emitModule(ast, trivia);
}

const NESTED_SRC = [
  "export def main() {",
  '  const greeting = "hi"',
  "  script shout = `echo \"SHOUT: $1\"`",
  "  def helper(name) {",
  '    log "helper sees ${greeting} and ${name}"',
  '    return "helped-${name}"',
  "  }",
  '  prompt describe(x) = "Tell me about ${x}"',
  '  const h = run helper("bob")',
  "  run shout(greeting)",
  "}",
  "",
].join("\n");

test("parse: a def holds nested const/script/def/prompt as local_decl steps", () => {
  const ast = parsejaiph(NESTED_SRC, "t.jh");
  const steps = ast.defs[0].steps.filter((s) => s.type === "local_decl");
  const kinds = steps.map((s) => (s.type === "local_decl" ? s.decl.kind : "?"));
  assert.deepEqual(kinds, ["script", "def", "prompt"]);
  // Nested decls are not hoisted to module scope.
  assert.equal(ast.scripts.length, 0);
  assert.equal(ast.prompts ?? undefined, undefined);
  assert.equal(ast.defs.length, 1);
});

const TEMPLATE_SRC = [
  "export def main(who) {",
  '  const greeting = "hello ${who}"',
  "  const note = \"\"\"",
  "    note for ${who}",
  "  \"\"\"",
  '  script shout = `echo "$1"`',
  "  def helper(name) {",
  '    const msg = "${greeting}-${name}"',
  "    return msg",
  "  }",
  '  prompt describe(x) = "Tell ${who} about ${x}"',
  "  prompt describe_block(x) = \"\"\"",
  "    Tell ${who} about ${x}",
  "  \"\"\"",
  '  const h = run helper("bob")',
  '  const d = prompt describe("today")',
  "  run shout(greeting)",
  '  return "${h} ${d}"',
  "}",
  "",
].join("\n");

test("parse: nested const and prompt bodies keep ${…} templates (including triple-quoted)", () => {
  const ast = parsejaiph(TEMPLATE_SRC, "t.jh");
  const main = ast.defs[0];
  const greeting = main.steps.find((s) => s.type === "const" && s.name === "greeting");
  assert.ok(greeting && greeting.type === "const" && greeting.value.kind === "literal");
  if (!(greeting && greeting.type === "const" && greeting.value.kind === "literal")) return;
  assert.equal(greeting.value.raw, '"hello ${who}"');

  const note = main.steps.find((s) => s.type === "const" && s.name === "note");
  assert.ok(note && note.type === "const" && note.value.kind === "literal");
  if (!(note && note.type === "const" && note.value.kind === "literal")) return;
  assert.match(note.value.raw, /\$\{who\}/);

  const helper = main.steps.find((s) => s.type === "local_decl" && s.decl.kind === "def");
  assert.ok(helper && helper.type === "local_decl" && helper.decl.kind === "def");
  if (!(helper && helper.type === "local_decl" && helper.decl.kind === "def")) return;
  const msg = helper.decl.def.steps.find((s) => s.type === "const" && s.name === "msg");
  assert.ok(msg && msg.type === "const" && msg.value.kind === "literal");
  if (!(msg && msg.type === "const" && msg.value.kind === "literal")) return;
  assert.equal(msg.value.raw, '"${greeting}-${name}"');

  const describe = main.steps.find(
    (s) => s.type === "local_decl" && s.decl.kind === "prompt" && s.decl.prompt.name === "describe",
  );
  assert.ok(describe && describe.type === "local_decl" && describe.decl.kind === "prompt");
  if (!(describe && describe.type === "local_decl" && describe.decl.kind === "prompt")) return;
  assert.equal(describe.decl.prompt.raw, '"Tell ${who} about ${x}"');

  const block = main.steps.find(
    (s) => s.type === "local_decl" && s.decl.kind === "prompt" && s.decl.prompt.name === "describe_block",
  );
  assert.ok(block && block.type === "local_decl" && block.decl.kind === "prompt");
  if (!(block && block.type === "local_decl" && block.decl.kind === "prompt")) return;
  assert.match(block.decl.prompt.raw, /\$\{who\}/);
  assert.match(block.decl.prompt.raw, /\$\{x\}/);
});

test("format: nested const/prompt templates (quoted and triple-quoted) round-trip", () => {
  const once = roundtrip(TEMPLATE_SRC);
  const twice = roundtrip(once);
  assert.equal(once, twice, "format is idempotent");
  assert.equal(once, TEMPLATE_SRC, "canonical form is preserved");
});

test("format: nested declarations round-trip bit-for-bit", () => {
  const once = roundtrip(NESTED_SRC);
  const twice = roundtrip(once);
  assert.equal(once, twice, "format is idempotent");
  assert.equal(once, NESTED_SRC, "canonical form is preserved");
});

test("E_PARSE: export on a nested script is rejected", () => {
  assert.throws(
    () => parsejaiph("export def main() {\n  export script foo = `echo hi`\n  run foo()\n}\n", "t.jh"),
    /E_PARSE.*nested script declarations cannot be exported/,
  );
});

test("E_PARSE: export on a nested def is rejected", () => {
  assert.throws(
    () => parsejaiph("export def main() {\n  export def foo() {\n    return \"x\"\n  }\n}\n", "t.jh"),
    /E_PARSE.*nested def declarations cannot be exported/,
  );
});

test("E_PARSE: export on a nested prompt is rejected", () => {
  assert.throws(
    () => parsejaiph('export def main() {\n  export prompt foo(x) = "hi ${x}"\n}\n', "t.jh"),
    /E_PARSE.*nested prompt declarations cannot be exported/,
  );
});

test("a bash `export FOO=bar` shell line inside a def still parses (not a declaration)", () => {
  const ast = parsejaiph("export def main() {\n  export FOO=bar\n}\n", "t.jh");
  const step = ast.defs[0].steps.find((s) => s.type === "exec");
  assert.ok(step, "export FOO=bar is a shell exec step, not a declaration");
});

test("E_PARSE: import inside a nested def is rejected (would run as shell)", () => {
  const src = 'def outer() {\n  def inner() {\n    import "x.jh" as y\n  }\n}\n';
  assert.throws(
    () => parsejaiph(src, "t.jh"),
    /E_PARSE.*import declarations are not allowed inside a nested def/,
  );
});

test("E_PARSE: import script inside a nested def is rejected", () => {
  const src = 'def outer() {\n  def inner() {\n    import script "./x.sh" as y\n  }\n}\n';
  assert.throws(
    () => parsejaiph(src, "t.jh"),
    /E_PARSE.*import declarations are not allowed inside a nested def/,
  );
});

test("E_PARSE: config block inside a nested def is rejected", () => {
  const src = 'def outer() {\n  def inner() {\n    config {\n      agent.backend = "claude"\n    }\n  }\n}\n';
  assert.throws(
    () => parsejaiph(src, "t.jh"),
    /E_PARSE.*config blocks are not allowed inside a nested def/,
  );
});

test("E_PARSE: import inside an if body of a nested def is rejected too", () => {
  const src = [
    "def outer() {",
    "  def inner(flag) {",
    '    if flag == "y" {',
    '      import "x.jh" as y',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "t.jh"),
    /E_PARSE.*import declarations are not allowed inside a nested def/,
  );
});

test("E_PARSE: import inside a catch body of a nested def is rejected", () => {
  const src = [
    "def outer() {",
    "  def inner() {",
    "    run s() catch (e) {",
    '      import "x.jh" as y',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "t.jh"),
    /E_PARSE.*import declarations are not allowed inside a nested def/,
  );
});

test("E_PARSE: import inside a recover body of a nested def is rejected", () => {
  const src = [
    "def outer() {",
    "  def inner() {",
    "    run s() recover(e) {",
    '      import "x.jh" as y',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "t.jh"),
    /E_PARSE.*import declarations are not allowed inside a nested def/,
  );
});

test("E_PARSE: config inside a catch body of a nested def is rejected", () => {
  const src = [
    "def outer() {",
    "  def inner() {",
    "    run s() catch (e) {",
    "      config {",
    '        agent.backend = "claude"',
    "      }",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
  assert.throws(
    () => parsejaiph(src, "t.jh"),
    /E_PARSE.*config blocks are not allowed inside a nested def/,
  );
});

test("E_PARSE: inline catch `{ import … }` in a nested def is rejected", () => {
  const src = 'def outer() {\n  def inner() {\n    run s() catch (e) { import "x.jh" as y }\n  }\n}\n';
  assert.throws(
    () => parsejaiph(src, "t.jh"),
    /E_PARSE.*import declarations are not allowed inside a nested def/,
  );
});

test("E_PARSE: single-statement catch import in a nested def is rejected", () => {
  const src = 'def outer() {\n  def inner() {\n    run s() catch (e) import "x.jh" as y\n  }\n}\n';
  assert.throws(
    () => parsejaiph(src, "t.jh"),
    /E_PARSE.*import declarations are not allowed inside a nested def/,
  );
});

test("top-level def catch body: `import` still falls through to shell (unchanged)", () => {
  const ast = parsejaiph(
    'export def main() {\n  run s() catch (e) {\n    import photo.png\n  }\n}\n',
    "t.jh",
  );
  const step = ast.defs[0].steps.find((s) => s.type === "exec");
  assert.ok(step && step.type === "exec" && step.catch && "block" in step.catch);
  if (!(step && step.type === "exec" && step.catch && "block" in step.catch)) return;
  const shell = step.catch.block.find((s) => s.type === "exec");
  assert.ok(
    shell && shell.type === "exec" && shell.body.kind === "shell",
    "a top-level def catch body keeps the shell fallthrough for import",
  );
});

test("a nested def with only run / const / nested script still compiles", () => {
  const src = [
    "export def main() {",
    "  def inner() {",
    '    const x = "1"',
    "    script s = `echo hi`",
    "    run s()",
    "  }",
    "  run inner()",
    "}",
    "",
  ].join("\n");
  const ast = parsejaiph(src, "t.jh");
  const inner = ast.defs[0].steps.find((s) => s.type === "local_decl");
  assert.ok(inner && inner.type === "local_decl" && inner.decl.kind === "def", "inner def parses");
});

test("top-level def body: `import` still falls through to shell (unchanged)", () => {
  const ast = parsejaiph("export def main() {\n  import photo.png\n}\n", "t.jh");
  const step = ast.defs[0].steps.find((s) => s.type === "exec");
  assert.ok(
    step && step.type === "exec" && step.body.kind === "shell",
    "a top-level def body keeps the shell fallthrough for import",
  );
});

// Nested declarations inside control-flow bodies (`if` / `else` / `else if` /
// `for` / `catch` / `recover`) parse as `local_decl` / `const` in that body's
// step list — the AST prerequisite for block-scoped validation. If the parser
// dropped an in-branch decl these assertions would fail.

const IN_BRANCH_SRC = [
  "export def main(flag, src) {",
  '  if flag == "y" {',
  "    script s = `echo YES`",
  "  } else if flag == \"m\" {",
  "    def d() {",
  '      return "x"',
  "    }",
  "  } else {",
  '    prompt p(x) = "hi ${x}"',
  "  }",
  "  for line in src {",
  '    const c = "1"',
  "  }",
  "  run s() catch (e) {",
  "    script cs = `echo recovered`",
  "  }",
  "  run s() recover (e) {",
  "    def rf() {",
  '      return "ok"',
  "    }",
  "  }",
  "}",
  "",
].join("\n");

function declKind(s: { type: string; decl?: { kind: string } }): string {
  if (s.type === "local_decl" && s.decl) return `local_decl:${s.decl.kind}`;
  return s.type;
}

test("parse: nested decls inside if / else if / else bodies parse as local_decl", () => {
  const ast = parsejaiph(IN_BRANCH_SRC, "t.jh");
  const main = ast.defs[0];
  const ifStep = main.steps.find((s) => s.type === "if");
  assert.ok(ifStep && ifStep.type === "if");
  if (!(ifStep && ifStep.type === "if")) return;
  assert.deepEqual(ifStep.body.map(declKind), ["local_decl:script"]);
  const elseIf = ifStep.elseBody?.find((s) => s.type === "if");
  assert.ok(elseIf && elseIf.type === "if", "else if is a nested if in elseBody");
  if (!(elseIf && elseIf.type === "if")) return;
  assert.deepEqual(elseIf.body.map(declKind), ["local_decl:def"]);
  assert.deepEqual(elseIf.elseBody?.map(declKind), ["local_decl:prompt"]);
});

test("parse: a nested const inside a for body stays a const step in that body", () => {
  const ast = parsejaiph(IN_BRANCH_SRC, "t.jh");
  const forStep = ast.defs[0].steps.find((s) => s.type === "for_lines");
  assert.ok(forStep && forStep.type === "for_lines");
  if (!(forStep && forStep.type === "for_lines")) return;
  assert.deepEqual(forStep.body.map(declKind), ["const"]);
});

test("parse: nested decls inside catch / recover bodies parse as local_decl", () => {
  const ast = parsejaiph(IN_BRANCH_SRC, "t.jh");
  const execs = ast.defs[0].steps.filter((s) => s.type === "exec");
  const withCatch = execs.find((s) => s.type === "exec" && s.catch);
  assert.ok(withCatch && withCatch.type === "exec" && withCatch.catch && "block" in withCatch.catch);
  if (!(withCatch && withCatch.type === "exec" && withCatch.catch && "block" in withCatch.catch)) return;
  assert.deepEqual(withCatch.catch.block.map(declKind), ["local_decl:script"]);

  const withRecover = execs.find((s) => s.type === "exec" && s.recover);
  assert.ok(withRecover && withRecover.type === "exec" && withRecover.recover && "block" in withRecover.recover);
  if (!(withRecover && withRecover.type === "exec" && withRecover.recover && "block" in withRecover.recover)) return;
  assert.deepEqual(withRecover.recover.block.map(declKind), ["local_decl:def"]);
});
