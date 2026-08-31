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
