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
