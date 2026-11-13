/**
 * A def-body (or top-level) line that starts with an `Object.prototype` method
 * name (`toString`, `constructor`, `hasOwnProperty`, …) must not reach the
 * inherited function through the dispatch table. Each such name has to behave
 * exactly like an ordinary unknown name (`fooBar`): a bare call to it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

const PROTO_NAMES = ["toString", "constructor", "hasOwnProperty", "valueOf", "isPrototypeOf"];

function parseStep(src: string): { ok: true; step: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, step: parsejaiph(src, "test.jh").defs[0]!.steps[0] };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

function defBody(name: string): string {
  return `export def main() {\n  ${name}()\n}`;
}

test("def body: an Object.prototype name parses as the same bare call as fooBar()", () => {
  const baseline = parseStep(defBody("fooBar"));
  assert.ok(baseline.ok, "fooBar() should parse as a bare call");
  assert.deepEqual((baseline.step as { body?: { callee?: { value?: string } } }).body?.callee?.value, "fooBar");

  for (const name of PROTO_NAMES) {
    const got = parseStep(defBody(name));
    assert.ok(got.ok, `${name}() should parse, not error with: ${got.ok ? "" : got.message}`);
    assert.deepEqual(
      (got.step as { body?: { callee?: { value?: string } } }).body?.callee?.value,
      name,
      `${name}() should be a bare call to "${name}"`,
    );
  }
});

test("top-level: an Object.prototype name is the same unsupported statement as fooBar", () => {
  const baseline = parseStep(`${"fooBar"}()`);
  assert.ok(!baseline.ok, "a bare top-level call should be an unsupported top-level statement");

  for (const name of PROTO_NAMES) {
    const got = parseStep(`${name}()`);
    assert.ok(!got.ok, `${name}() at top level should error like fooBar()`);
    assert.equal(
      got.message.replace(name, "NAME"),
      baseline.message.replace("fooBar", "NAME"),
      `${name}() should fail with the same message as fooBar()`,
    );
  }
});
