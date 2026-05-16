import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsejaiph } from "../parser";
import type { WorkflowStepDef } from "../types";

const stepsTsPath = join(process.cwd(), "src/parse/steps.ts");
const stepsTsSource = readFileSync(stepsTsPath, "utf8");

// === AC1: src/parse/steps.ts size + grep budget ===

test("AC1: src/parse/steps.ts is at most 200 lines", () => {
  const lineCount = stepsTsSource.split("\n").length;
  assert.ok(
    lineCount <= 200,
    `expected src/parse/steps.ts to be <=200 lines (was 757 before Refactor 2); got ${lineCount}`,
  );
});

test("AC1: src/parse/steps.ts has no parse(Run)?(Catch|Recover|EnsureStep) function", () => {
  const re = /\bfunction\s+(parse(?:Run)?(?:Catch|Recover|EnsureStep))\b/;
  const m = stepsTsSource.match(re);
  assert.equal(
    m,
    null,
    `legacy catch/recover host-parser function reappeared in src/parse/steps.ts: ${m && m[1]}`,
  );
});

// === AC2: parseBlockStatement is THE entry point for any catch/recover body ===
//
// Before Refactor 2, `parseCatchStatement` was a stripped-down copy of
// `parseBlockStatement` that recognised only a fixed subset of statement
// forms. A `for … in …` head, for example, was treated as a shell command.
// After Refactor 2 the same `parseBlockStatement` parses bodies everywhere,
// so introducing a new statement form (here: using `for` as the probe — it
// has always been a parseBlockStatement-only form historically) is accepted
// identically at top level, inside `catch (e) { … }`, and inside
// `recover(e) { … }` without any change to the catch/recover code path.

function pickFor(steps: WorkflowStepDef[]): WorkflowStepDef | undefined {
  return steps.find((s) => s.type === "for_lines");
}

const FOR_BODY = [
  '    for line in items {',
  '      log "$line"',
  '    }',
];

test("AC2: top-level for-loop is parsed as `for_lines`", () => {
  const src = [
    "workflow w(items) {",
    ...FOR_BODY,
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(src, "ac2-top.jh");
  const w = mod.workflows.find((x) => x.name === "w")!;
  const forStep = pickFor(w.steps);
  assert.ok(forStep, "expected for_lines step at top level");
});

test("AC2: same for-loop inside catch body parses identically", () => {
  const src = [
    "rule check() {",
    '  return "ok"',
    "}",
    "workflow w(items) {",
    "  ensure check() catch (e) {",
    ...FOR_BODY,
    "  }",
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(src, "ac2-catch.jh");
  const w = mod.workflows.find((x) => x.name === "w")!;
  const ensureStep = w.steps[0];
  assert.equal(ensureStep.type, "exec");
  if (ensureStep.type !== "exec") return;
  assert.ok(ensureStep.catch && "block" in ensureStep.catch);
  if (!(ensureStep.catch && "block" in ensureStep.catch)) return;
  const forStep = pickFor(ensureStep.catch.block);
  assert.ok(forStep, "expected for_lines step inside catch body");
});

test("AC2: same for-loop inside recover body parses identically", () => {
  const src = [
    "workflow target() {",
    '  log "target"',
    "}",
    "workflow w(items) {",
    "  run target() recover(e) {",
    ...FOR_BODY,
    "  }",
    "}",
    "",
  ].join("\n");
  const mod = parsejaiph(src, "ac2-recover.jh");
  const w = mod.workflows.find((x) => x.name === "w")!;
  const runStep = w.steps[0];
  assert.equal(runStep.type, "exec");
  if (runStep.type !== "exec") return;
  assert.ok(runStep.recover && "block" in runStep.recover);
  if (!(runStep.recover && "block" in runStep.recover)) return;
  const forStep = pickFor(runStep.recover.block);
  assert.ok(forStep, "expected for_lines step inside recover body");
});

// === AC3: parse error messages and locations preserved bit-for-bit ===
//
// These cover every error message and location the legacy three-function
// catch/recover path produced. They are exhaustively asserted as snapshots.

type ErrSnap = { name: string; src: string; expected: string };

const ERR_SNAPSHOTS: ErrSnap[] = [
  // Bindings paren missing
  {
    name: "ensure catch: missing bindings paren (EOL)",
    src: "workflow w() {\n  ensure r() catch\n}\n",
    expected: 'fixture.jh:2:14 E_PARSE catch requires explicit bindings and a body: catch (<name>) { ... }',
  },
  {
    name: "ensure catch: bindings open after `{`",
    src: "workflow w() {\n  ensure r() catch {\n}\n",
    expected: 'fixture.jh:2:14 E_PARSE catch requires explicit bindings: catch (<name>) { ... }',
  },
  {
    name: "run catch: missing bindings paren (EOL)",
    src: "workflow w() {\n  run r() catch\n}\n",
    expected: 'fixture.jh:2:11 E_PARSE catch requires explicit bindings and a body: catch (<name>) { ... }',
  },
  {
    name: "run recover: missing bindings paren (EOL)",
    src: "workflow w() {\n  run r() recover\n}\n",
    expected: 'fixture.jh:2:11 E_PARSE recover requires explicit bindings and a body: recover(<name>) { ... }',
  },
  {
    name: "run recover: bindings open after `{`",
    src: "workflow w() {\n  run r() recover {\n}\n",
    expected: 'fixture.jh:2:11 E_PARSE recover requires explicit bindings: recover(<name>) { ... }',
  },

  // Too many bindings
  {
    name: "ensure catch: two bindings rejected",
    src: 'workflow w() {\n  ensure r() catch (a, b) { log "x" }\n}\n',
    expected: 'fixture.jh:2:14 E_PARSE catch accepts exactly one binding: catch (<name>) — the second binding (attempt) has been removed',
  },
  {
    name: "run recover: two bindings rejected",
    src: 'workflow w() {\n  run r() recover(a, b) { log "x" }\n}\n',
    expected: 'fixture.jh:2:11 E_PARSE recover accepts exactly one binding: recover(<name>)',
  },

  // Empty body
  {
    name: "ensure catch: empty inline block rejected",
    src: "workflow w() {\n  ensure r() catch (e) { }\n}\n",
    expected: 'fixture.jh:2:14 E_PARSE catch block must contain at least one statement',
  },
  {
    name: "ensure catch: empty multiline block rejected",
    src: "workflow w() {\n  ensure r() catch (e) {\n  }\n}\n",
    expected: 'fixture.jh:2:14 E_PARSE catch block must contain at least one statement',
  },
  {
    name: "run recover: empty inline block rejected",
    src: "workflow w() {\n  run r() recover(e) { }\n}\n",
    expected: 'fixture.jh:2:11 E_PARSE recover block must contain at least one statement',
  },

  // Unterminated multiline block
  {
    name: "ensure catch: unterminated multiline block",
    src: 'workflow w() {\n  ensure r() catch (e) {\n    log "x"\n',
    expected: 'fixture.jh:2:14 E_PARSE unterminated catch block, expected "}"',
  },
];

for (const s of ERR_SNAPSHOTS) {
  test(`AC3 snapshot: ${s.name}`, () => {
    let actual = "<no error thrown>";
    try {
      parsejaiph(s.src, "fixture.jh");
    } catch (e) {
      actual = (e as Error).message;
    }
    assert.equal(actual, s.expected);
  });
}
