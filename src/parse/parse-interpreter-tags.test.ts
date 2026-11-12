import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph, parsejaiphWithTrivia } from "../parser";

// === Accepted: fenced block with interpreter tag before the quotes ===

test("fenced block with python3 tag parses correctly", () => {
  const { ast: mod, trivia } = parsejaiphWithTrivia("script transform = python3'''\nprint(\"hi\")\n'''", "test.jh");
  assert.equal(mod.scripts.length, 1);
  assert.equal(mod.scripts[0].name, "transform");
  assert.equal(mod.scripts[0].lang, "python3");
  assert.equal(mod.scripts[0].body, 'print("hi")');
  assert.equal(trivia.getNode(mod.scripts[0])?.scriptBodyKind, "fenced");
});

test("fenced block with node tag parses correctly", () => {
  const { ast: mod, trivia } = parsejaiphWithTrivia("script transform = node'''\nconsole.log('hi');\n'''", "test.jh");
  assert.equal(mod.scripts.length, 1);
  assert.equal(mod.scripts[0].name, "transform");
  assert.equal(mod.scripts[0].lang, "node");
  assert.equal(mod.scripts[0].body, "console.log('hi');");
  assert.equal(trivia.getNode(mod.scripts[0])?.scriptBodyKind, "fenced");
});

test("any arbitrary tag is valid (no allowlist)", () => {
  const { ast: mod, trivia } = parsejaiphWithTrivia("script run_deno = deno'''\nconsole.log('hi');\n'''", "test.jh");
  assert.equal(mod.scripts.length, 1);
  assert.equal(mod.scripts[0].lang, "deno");
  assert.equal(trivia.getNode(mod.scripts[0])?.scriptBodyKind, "fenced");
});

test("tag may contain dots and dashes (python3.12, pwsh-preview)", () => {
  const mod = parsejaiph("script a = python3.12'print(1)'\nscript b = pwsh-preview'Write-Output 1'", "test.jh");
  assert.equal(mod.scripts[0].lang, "python3.12");
  assert.equal(mod.scripts[1].lang, "pwsh-preview");
});

// === Accepted: one-liner with interpreter tag ===

test("one-line named script with tag", () => {
  const { ast: mod, trivia } = parsejaiphWithTrivia("script hi = python3'print(1)'", "test.jh");
  assert.equal(mod.scripts[0].lang, "python3");
  assert.equal(mod.scripts[0].body, "print(1)");
  assert.equal(trivia.getNode(mod.scripts[0])?.scriptBodyKind, "oneline");
});

test("one-line inline script with tag in statement and const position", () => {
  const mod = parsejaiph(
    'def main() {\n  node\'console.log(1)\'()\n  const x = python3\'print(2)\'("a")\n}',
    "test.jh",
  );
  const steps = mod.defs[0].steps;
  assert.equal(steps[0].type, "exec");
  const first = steps[0].type === "exec" ? steps[0].body : undefined;
  assert.equal(first?.kind, "inline_script");
  assert.equal(first?.kind === "inline_script" ? first.lang : undefined, "node");
  const second = steps[1].type === "const" ? steps[1].value : undefined;
  assert.equal(second?.kind, "inline_script");
  assert.equal(second?.kind === "inline_script" ? second.lang : undefined, "python3");
});

test("fenced inline script with tag", () => {
  const mod = parsejaiph("def main() {\n  python3'''\n    print(1)\n  '''()\n}", "test.jh");
  const step = mod.defs[0].steps[0];
  const body = step.type === "exec" ? step.body : undefined;
  assert.equal(body?.kind === "inline_script" ? body.lang : undefined, "python3");
  assert.equal(body?.kind === "inline_script" ? body.body : undefined, "print(1)");
});

// === Accepted: plain script without tag ===

test("plain script without tag has no lang", () => {
  const { ast: mod, trivia } = parsejaiphWithTrivia("script setup = 'echo hello'", "test.jh");
  assert.equal(mod.scripts[0].lang, undefined);
  assert.equal(mod.scripts[0].body, "echo hello");
  assert.equal(trivia.getNode(mod.scripts[0])?.scriptBodyKind, "oneline");
});

// === Accepted: manual shebang in fenced body (no tag) ===

test("manual shebang in fenced body without tag works", () => {
  const { ast: mod, trivia } = parsejaiphWithTrivia("script analyze = '''\n#!/usr/bin/env ruby\nputs \"hi\"\n'''", "test.jh");
  assert.equal(mod.scripts[0].lang, undefined);
  assert.equal(mod.scripts[0].body, '#!/usr/bin/env ruby\nputs "hi"');
  assert.equal(trivia.getNode(mod.scripts[0])?.scriptBodyKind, "fenced");
});

// === Rejected: old tag-after-fence form ===

test("tag after the opening fence is E_PARSE with a fix-it (named script)", () => {
  assert.throws(
    () => parsejaiph("script transform = '''python3\nprint(1)\n'''", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("interpreter tags go before the opening quotes: python3'''...'''"),
  );
});

test("tag after the opening fence is E_PARSE with a fix-it (inline script)", () => {
  assert.throws(
    () => parsejaiph("def main() {\n  '''node\n  console.log(1)\n  '''()\n}", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("interpreter tags go before the opening quotes: node'''...'''"),
  );
});

// === Rejected: tag + manual shebang, tag with whitespace, tag without quote ===

test("tag with manual shebang is rejected", () => {
  assert.throws(
    () => parsejaiph("script transform = node'''\n#!/usr/bin/env node\nconsole.log('hi');\n'''", "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("already sets the shebang"),
  );
});

test("whitespace between tag and quote is rejected", () => {
  assert.throws(
    () => parsejaiph("script transform = python3 'print(1)'", "test.jh"),
    (err: any) => err.message.includes("E_PARSE"),
  );
});

// === Rejected: script with parentheses ===

test("script with parentheses is rejected", () => {
  assert.throws(
    () => parsejaiph('script transform() = "body"', "test.jh"),
    (err: any) =>
      err.message.includes("E_PARSE") &&
      err.message.includes("definitions must not use parentheses"),
  );
});
