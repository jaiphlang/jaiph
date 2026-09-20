import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

test("named script: backtick one-liner is E_PARSE", () => {
  assert.throws(
    () => parsejaiph("script foo = `echo hi`\n", "test.jh"),
    /script one-liners use single quotes/,
  );
});

test("inline script: backtick one-liner is E_PARSE", () => {
  assert.throws(
    () => parsejaiph("export def main() {\n  `echo hi`()\n}\n", "test.jh"),
    /script one-liners use single quotes/,
  );
});

test("named script: one-line single quotes parse", () => {
  const mod = parsejaiph("script foo = 'echo hi'\n", "test.jh");
  assert.equal(mod.scripts[0]?.body, "echo hi");
});

test("inline script: one-line single quotes parse", () => {
  const ast = parsejaiph("export def main() {\n  'echo hi'()\n}\n", "test.jh");
  const step = ast.defs[0].steps[0];
  assert.equal(step.type, "exec");
  if (step.type === "exec" && step.body.kind === "inline_script") {
    assert.equal(step.body.body, "echo hi");
  }
});

test("one-liner: a quote in the body closes early (no escapes)", () => {
  assert.throws(
    () => parsejaiph("export def main() {\n  'echo 'hi''()\n}\n", "test.jh"),
    /argument list after closing quote/,
  );
});

test("one-liner: Jaiph interpolation is E_PARSE", () => {
  assert.throws(
    () => parsejaiph("script foo = 'echo ${bar}'\n", "test.jh"),
    /cannot contain Jaiph interpolation/,
  );
});
