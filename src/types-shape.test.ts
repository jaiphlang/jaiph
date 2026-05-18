import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Expr, WorkflowStepDef } from "./types";
import * as TypesModule from "./types";

// Tests run from dist/src/, so source files live two levels up under src/.
const repoRoot = resolve(__dirname, "../..");
const srcRoot = join(repoRoot, "src");

/**
 * AC1 — Placeholder strings deleted from the AST.
 *
 * After collapsing the three managed-call encodings into `Expr`, no source
 * file under `src/` should ever produce the legacy sentinel values that
 * existed only so the formatter could print something while the real
 * payload sat in a `managed:` sidecar.
 *
 * If anyone reintroduces one of these strings as a placeholder, this test
 * fails with the offending file:line.
 */
const PLACEHOLDER_STRINGS = ['"__match__"', '"run inline_script"', '"__JAIPH_MANAGED__"'];

function listSourceFiles(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip the test file itself so it's allowed to mention the strings.
      listSourceFiles(full, acc);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue; // tests may reference strings in assertions
    if (full.endsWith("types-shape.test.ts")) continue;
    acc.push(full);
  }
}

test("AC1: no AST placeholder strings linger in src/", () => {
  const files: string[] = [];
  listSourceFiles(srcRoot, files);
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const placeholder of PLACEHOLDER_STRINGS) {
      if (text.includes(placeholder)) {
        offenders.push(`${file} contains ${placeholder}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Placeholder strings reappeared in src/:\n${offenders.join("\n")}`);
});

/**
 * AC2 — `WorkflowStepDef` has at most 8 variants. The exhaustive switch
 * below fails to compile if a new variant is silently added (the `never`
 * fallback widens), and the runtime tuple lookup pins the count to 8.
 */
type StepType = WorkflowStepDef["type"];
type AllStepTypes = readonly ["exec", "const", "return", "send", "say", "if", "for_lines", "trivia"];
type _StepTypesCoverAllVariants = StepType extends AllStepTypes[number]
  ? AllStepTypes[number] extends StepType
    ? true
    : never
  : never;
const _stepTypesAtMost8: _StepTypesCoverAllVariants = true;

function _exhaustiveStepSwitch(s: WorkflowStepDef): void {
  switch (s.type) {
    case "exec":
    case "const":
    case "return":
    case "send":
    case "say":
    case "if":
    case "for_lines":
    case "trivia":
      return;
    default: {
      const _never: never = s;
      return _never;
    }
  }
}

test("AC2: WorkflowStepDef has exactly 8 variants", () => {
  const declaredTypes: AllStepTypes = ["exec", "const", "return", "send", "say", "if", "for_lines", "trivia"];
  assert.equal(declaredTypes.length, 8);
  assert.equal(_stepTypesAtMost8, true);
  // Reference the exhaustive switch so the unused-symbol check is happy and
  // the dead-code eliminator can't drop the type-level assertion.
  void _exhaustiveStepSwitch;
});

/**
 * AC2 (companion) — `Expr` is exhaustive too. The Refactor 3 design carries
 * 7 base kinds from the task spec; this implementation adds `shell` and
 * `bare_ref` for send-RHS shapes that the validator either rejects or
 * specializes. If a kind is added or removed without updating both the
 * declared list and the exhaustive switch, this fails to compile.
 */
type ExprKind = Expr["kind"];
type AllExprKinds = readonly ["literal", "call", "ensure_call", "inline_script", "prompt", "match", "shell", "bare_ref"];
type _ExprKindsExhaustive = ExprKind extends AllExprKinds[number]
  ? AllExprKinds[number] extends ExprKind
    ? true
    : never
  : never;
const _exprExhaustive: _ExprKindsExhaustive = true;

function _exhaustiveExprSwitch(e: Expr): void {
  switch (e.kind) {
    case "literal":
    case "call":
    case "ensure_call":
    case "inline_script":
    case "prompt":
    case "match":
    case "shell":
    case "bare_ref":
      return;
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

test("AC2: Expr has exactly 8 kinds (literal/call/ensure_call/inline_script/prompt/match/shell/bare_ref)", () => {
  const declaredKinds: AllExprKinds = ["literal", "call", "ensure_call", "inline_script", "prompt", "match", "shell", "bare_ref"];
  assert.equal(declaredKinds.length, 8);
  assert.equal(_exprExhaustive, true);
  void _exhaustiveExprSwitch;
});

/**
 * AC3 — `ConstRhs` and `SendRhsDef` are deleted as separate exported
 * symbols; their fields now live inside `Expr`.
 */
test("AC3: ConstRhs and SendRhsDef are not exported from src/types.ts", () => {
  const exported = Object.keys(TypesModule);
  // Both symbol names should be absent from the module's export surface.
  assert.ok(!exported.includes("ConstRhs"), `ConstRhs should not be exported`);
  assert.ok(!exported.includes("SendRhsDef"), `SendRhsDef should not be exported`);

  // Belt-and-suspenders: re-check the source file. (Pure types don't show up
  // in runtime exports, so the textual check is what catches them.)
  const typesPath = join(srcRoot, "types.ts");
  const typesText = readFileSync(typesPath, "utf8");
  assert.ok(
    !/export\s+type\s+ConstRhs\b/.test(typesText),
    "src/types.ts must not export ConstRhs",
  );
  assert.ok(
    !/export\s+type\s+SendRhsDef\b/.test(typesText),
    "src/types.ts must not export SendRhsDef",
  );
});
