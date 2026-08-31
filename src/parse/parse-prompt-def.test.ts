import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph, parsejaiphWithTrivia } from "../parser";
import { emitModule } from "../format/index";

// Named prompt definitions: parse shape + bit-for-bit format round-trip.

function roundtrip(src: string): string {
  const { ast, trivia } = parsejaiphWithTrivia(src, "t.jh");
  return emitModule(ast, trivia);
}

test("parse: named prompt with params + use + single-line body", () => {
  const ast = parsejaiph(
    'prompt analyze_ci(log) use GITHUB_TOKEN = "Look at ${log}"\n',
    "t.jh",
  );
  assert.equal(ast.prompts?.length, 1);
  const p = ast.prompts![0];
  assert.equal(p.name, "analyze_ci");
  assert.deepEqual(p.params, ["log"]);
  assert.deepEqual(p.use, ["GITHUB_TOKEN"]);
  assert.equal(p.raw, '"Look at ${log}"');
});

test("parse: named prompt triple-quoted body with returns and zero params", () => {
  const ast = parsejaiph(
    [
      "prompt summarize() = \"\"\"",
      "  Summarize it.",
      "\"\"\"",
      'returns "{ summary: string }"',
      "",
    ].join("\n"),
    "t.jh",
  );
  const p = ast.prompts![0];
  assert.equal(p.name, "summarize");
  assert.deepEqual(p.params, []);
  assert.equal(p.returns, "{ summary: string }");
});

test("round-trip: single-line named prompt with use", () => {
  const src = 'prompt analyze_ci(log) use GITHUB_TOKEN = "Look at ${log}"\n';
  assert.equal(roundtrip(src), src);
});

test("round-trip: triple-quoted named prompt with returns", () => {
  const src = [
    "prompt summarize(a, b) = \"\"\"",
    "  Summarize ${a} and ${b}.",
    "\"\"\"",
    'returns "{ summary: string }"',
    "",
  ].join("\n");
  assert.equal(roundtrip(src), src);
});

test("round-trip: export prompt and a named invocation inside a def", () => {
  const src = [
    'export prompt greet(who) = "Hi ${who}"',
    "",
    "export def main() {",
    '  const out = prompt greet("world")',
    "  return out",
    "}",
    "",
  ].join("\n");
  assert.equal(roundtrip(src), src);
});

test("round-trip: parse → format → parse → format converges", () => {
  const src = [
    'prompt analyze_ci(log) use GITHUB_TOKEN NPM_TOKEN = "CI: ${log}"',
    "",
    "export def main() {",
    "  const log = \"x\"",
    "  prompt analyze_ci(log)",
    "}",
    "",
  ].join("\n");
  const once = roundtrip(src);
  assert.equal(roundtrip(once), once);
});

test("parse: E_PARSE on missing = after parameter list", () => {
  assert.throws(
    () => parsejaiph('prompt foo(a) "body"\n', "t.jh"),
    /require = after the parameter list/,
  );
});

test("parse: E_PARSE on non-string body (identifier is step-only sugar)", () => {
  assert.throws(
    () => parsejaiph("prompt foo(a) = bar\n", "t.jh"),
    /named prompt bodies must be a double-quoted string or triple-quoted block/,
  );
});
