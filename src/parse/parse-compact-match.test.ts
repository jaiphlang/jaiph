import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";

function mainSteps(src: string) {
  return parsejaiph(src, "test.jh").defs.find((d) => d.name === "main")!.steps;
}

test("compact return match is a match expr, not shell", () => {
  const steps = mainSteps(`export def main() {\n  const s = "ok"\n  return match s { "ok" => "pass", _ => "fail" }\n}`);
  const ret = steps[1];
  assert.equal(ret.type, "return");
  if (ret.type !== "return") return;
  assert.equal(ret.value.kind, "match");
  if (ret.value.kind !== "match") return;
  assert.equal(ret.value.match.subject, "s");
  assert.equal(ret.value.match.arms.length, 2);
});

test("compact return match with one arm parses", () => {
  const steps = mainSteps(`export def main() {\n  const later = "ok"\n  return match later { _ => "x" }\n}`);
  const ret = steps[1];
  assert.equal(ret.type, "return");
  if (ret.type !== "return") return;
  assert.equal(ret.value.kind, "match");
});

test("compact const match is a match expr", () => {
  const steps = mainSteps(`export def main() {\n  const s = "ok"\n  const x = match s { "ok" => "yes", _ => "no" }\n  return x\n}`);
  const c = steps[1];
  assert.equal(c.type, "const");
  if (c.type !== "const") return;
  assert.equal(c.value.kind, "match");
  if (c.value.kind !== "match") return;
  assert.equal(c.value.match.arms.length, 2);
});

test("compact standalone match is a match exec, not shell", () => {
  const steps = mainSteps(`export def main() {\n  const s = "ok"\n  match s { "ok" => "yes", _ => "no" }\n}`);
  const step = steps[1];
  assert.equal(step.type, "exec");
  if (step.type !== "exec") return;
  assert.equal(step.body.kind, "match");
});

test("return prompt is a prompt expr, not shell", () => {
  const steps = mainSteps(`export def main() {\n  return prompt "hello"\n}`);
  const ret = steps[0];
  assert.equal(ret.type, "return");
  if (ret.type !== "return") return;
  assert.equal(ret.value.kind, "prompt");
  if (ret.value.kind !== "prompt") return;
  assert.equal(ret.value.raw, '"hello"');
});

test("return echo hi is E_PARSE, not a shell step", () => {
  assert.throws(
    () => parsejaiph(`export def main() {\n  return echo hi\n}`, "test.jh"),
    /return value must be a string/,
  );
});

/** The match expr value of the single `return` step in `main`, with `loc` stripped. */
function returnMatch(src: string): unknown {
  const ret = mainSteps(src).find((s) => s.type === "return")!;
  assert.equal(ret.type, "return");
  if (ret.type !== "return") throw new Error("not a return");
  assert.equal(ret.value.kind, "match");
  const json = JSON.stringify(ret.value, (k, v) => (k === "loc" ? undefined : v));
  return JSON.parse(json);
}

const CALLEES = `export def f(a, b) {\n  return a\n}\nexport def g(a, b) {\n  return a\n}\n`;

test("compact call arm with a comma is one arm, same AST as multiline", () => {
  const compact = returnMatch(
    `${CALLEES}export def main() {\n  const x = "a"\n  return match x { "a" => f(x, x), _ => "n" }\n}`,
  );
  const multiline = returnMatch(
    `${CALLEES}export def main() {\n  const x = "a"\n  return match x {\n    "a" => f(x, x)\n    _ => "n"\n  }\n}`,
  );
  assert.deepEqual(compact, multiline);
});

test("compact nested call arm keeps inner commas in one arm", () => {
  const steps = mainSteps(`${CALLEES}export def main() {\n  const x = "a"\n  return match x { "a" => f(g(x, x), x), _ => "n" }\n}`);
  const ret = steps.find((s) => s.type === "return")!;
  if (ret.type !== "return" || ret.value.kind !== "match") throw new Error("not a match return");
  assert.equal(ret.value.match.arms.length, 2);
  assert.equal(ret.value.match.arms[0]!.body, "f(g(x, x), x)");
});

test("compact inline-script arm with two args is one arm, rejected like multiline", () => {
  const compact = `export def main() {\n  const x = "a"\n  return match x { "a" => 'echo $1 $2'(x, x), _ => "n" }\n}`;
  const multiline = `export def main() {\n  const x = "a"\n  return match x {\n    "a" => 'echo $1 $2'(x, x)\n    _ => "n"\n  }\n}`;
  const msg = /inline scripts are not allowed in match arm bodies/;
  // The inner comma must not split the arm; both forms reach the same arm-body rule.
  assert.throws(() => parsejaiph(compact, "test.jh"), msg);
  assert.throws(() => parsejaiph(multiline, "test.jh"), msg);
});

test("compact arm with an unbalanced ( is E_PARSE at the arm body column", () => {
  const line = `  return match x { "a" => f(x, _ => "n" }`;
  const src = `${CALLEES}export def main() {\n  const x = "a"\n${line}\n}`;
  const bodyCol = line.indexOf("f(") + 1;
  assert.throws(
    () => parsejaiph(src, "test.jh"),
    (e: Error) => {
      assert.match(e.message, new RegExp(`test\\.jh:\\d+:${bodyCol} E_PARSE`));
      return true;
    },
  );
});

test("multiline return match still parses", () => {
  const steps = mainSteps(
    [
      "export def main() {",
      '  const s = "ok"',
      "  return match s {",
      '    "ok" => "pass"',
      '    _ => "fail"',
      "  }",
      "}",
    ].join("\n"),
  );
  const ret = steps[1];
  assert.equal(ret.type, "return");
  if (ret.type !== "return") return;
  assert.equal(ret.value.kind, "match");
  if (ret.value.kind !== "match") return;
  assert.equal(ret.value.match.arms.length, 2);
});
