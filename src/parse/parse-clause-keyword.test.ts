import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import type { CatchBody, StepDef } from "../types";

// The catch/recover clause keyword is the first such identifier token at the top
// level of the statement (after the call's `)`, outside strings, `"""` blocks,
// inline scripts, and nested parentheses). A `recover` or `catch` word written
// inside a quoted argument or inside the clause body must not select or block a
// clause. See `findClause` in stmt-call.ts.

function firstStep(body: string): StepDef {
  const src = ["export def main() {", `  ${body}`, "}"].join("\n");
  return parsejaiph(src, "test.jh").defs[0].steps[0];
}

function blockBinding(b: CatchBody | undefined): string | undefined {
  return b && "block" in b ? b.bindings.failure : undefined;
}

function blockSteps(b: CatchBody | undefined): StepDef[] | undefined {
  return b && "block" in b ? b.block : undefined;
}

type Case = { name: string; src: string; kind: "catch" | "recover"; binding: string };

const CASES: Case[] = [
  { name: 'catch body contains the word "recover"', src: 'f() catch (e) { log "do not recover now" }', kind: "catch", binding: "e" },
  { name: 'argument contains " catch "', src: 'f("a catch b") catch (e) { log "x" }', kind: "catch", binding: "e" },
  { name: 'argument contains "recover("', src: 'f("a recover(b)") recover (e) { log "y" }', kind: "recover", binding: "e" },
  { name: 'recover body contains the word "catch"', src: 'f() recover (e) { log "catch me" }', kind: "recover", binding: "e" },
];

for (const c of CASES) {
  test(`clause keyword: ${c.name}`, () => {
    const step = firstStep(c.src);
    assert.equal(step.type, "exec");
    if (step.type !== "exec") return;
    assert.equal(step.body.kind, "call");
    const clause = c.kind === "catch" ? step.catch : step.recover;
    const other = c.kind === "catch" ? step.recover : step.catch;
    assert.equal(other, undefined, `expected only a ${c.kind} clause`);
    assert.equal(blockBinding(clause), c.binding);
    const steps = blockSteps(clause);
    assert.ok(steps && steps.length === 1, "expected one statement in the clause body");
    assert.equal(steps![0].type, "say");
  });
}

// A genuinely malformed clause keeps today's message and column: a bare `catch`
// with no binding or body fails at the keyword column.
test("bare `catch` with no binding fails with today's message and column", () => {
  let actual = "<no error thrown>";
  try {
    parsejaiph("def w() {\n  f() catch\n}\n", "fixture.jh");
  } catch (e) {
    actual = (e as Error).message;
  }
  assert.equal(
    actual,
    "fixture.jh:2:7 E_PARSE catch requires explicit bindings and a body: catch (<name>) { ... }",
  );
});
