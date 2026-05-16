import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// Compiled test sits at dist/src/transpile/; the source file is three levels
// up under src/transpile/.
const validatePath = resolve(__dirname, "../../../src/transpile/validate.ts");

/**
 * AC1 — The three pre-pass helpers (`collectKnownVars`,
 * `collectPromptSchemas`, `validateImmutableBindings`) have been replaced by a
 * single workflow walk. None of those names should reappear in validate.ts —
 * if they do, this test fails immediately. The grep is anchored on word
 * boundaries so unrelated identifiers (e.g. a `validateImmutableBindingsFoo`
 * variant) would still be flagged.
 */
test("AC1: pre-pass helpers are deleted from validate.ts", () => {
  const text = readFileSync(validatePath, "utf8");
  const forbidden = [
    "collectKnownVars",
    "collectPromptSchemas",
    "validateImmutableBindings",
  ];
  const offenders: string[] = [];
  for (const name of forbidden) {
    if (new RegExp(`\\b${name}\\b`).test(text)) {
      offenders.push(name);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `forbidden helper names reappeared in validate.ts: ${offenders.join(", ")}`,
  );
});

/**
 * AC2 — Exactly one recursive helper in validate.ts walks
 * `WorkflowStepDef[]`. A "helper" is any top-level or nested
 * function/arrow declaration whose parameter list mentions
 * `WorkflowStepDef[]`; it is "recursive" if its body calls its own name.
 *
 * Before the refactor there were four such walkers (`collectKnownVars`'s
 * inner walk, `validateImmutableBindings`'s inner walk, the workflow's
 * `validateStep`, and the rule's `validateRuleStep`). After the refactor
 * only the single `descend` inside `walkStepTree` should remain.
 */
test("AC2: at most one recursive helper walks WorkflowStepDef[] in validate.ts", () => {
  const text = readFileSync(validatePath, "utf8");
  const helpers = findStepArrayHelpers(text);
  const recursive = helpers.filter((h) =>
    new RegExp(`\\b${h.name}\\(`).test(h.body),
  );
  assert.ok(
    recursive.length <= 1,
    `expected at most 1 recursive helper walking WorkflowStepDef[] in validate.ts, ` +
      `found ${recursive.length}: ${recursive.map((h) => h.name).join(", ")}`,
  );
});

interface Helper {
  name: string;
  body: string;
}

/**
 * Locate every `function NAME(...)` or `const NAME = (...) => ...` declaration
 * whose parameter list textually contains `WorkflowStepDef[]`, and return its
 * name + body (text between the body's matching braces). Nested arrows count
 * — that's how we catch a helper redeclared inside another function.
 */
function findStepArrayHelpers(text: string): Helper[] {
  const out: Helper[] = [];
  const declRe = /(?:^|\n)\s*(?:function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\()/g;
  let match: RegExpExecArray | null;
  while ((match = declRe.exec(text)) !== null) {
    const name = match[1] ?? match[2];
    if (!name) continue;
    const openParen = text.indexOf("(", match.index);
    if (openParen < 0) continue;
    const closeParen = findMatching(text, openParen, "(", ")");
    if (closeParen < 0) continue;
    const params = text.slice(openParen, closeParen + 1);
    if (!params.includes("WorkflowStepDef[]")) continue;
    const bodyOpen = text.indexOf("{", closeParen);
    if (bodyOpen < 0) continue;
    const bodyClose = findMatching(text, bodyOpen, "{", "}");
    if (bodyClose < 0) continue;
    out.push({ name, body: text.slice(bodyOpen + 1, bodyClose) });
  }
  return out;
}

function findMatching(text: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
