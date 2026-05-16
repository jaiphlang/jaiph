import test from "node:test";
import assert from "node:assert/strict";
import type { Expr, WorkflowStepDef } from "../types";

/**
 * AC1 (Refactor 3): `bareIdentifierArgs` must not appear on any call-bearing
 * AST node, and the three "managed call that yields a value" encodings
 * — `managed:` sidecar / `run_capture` const RHS / placeholder strings
 * — have been replaced by a single `Expr` shape that carries `args: Arg[]`.
 *
 * Each helper below probes a specific Expr variant where the field used to
 * live; if it is re-added, `HasField` widens to `true`, the type-level
 * assertion fails, and TypeScript breaks compilation.
 */
type HasField<T, K extends string> = T extends Record<K, unknown> ? true : false;

type ExecStep = Extract<WorkflowStepDef, { type: "exec" }>;
type ReturnStep = Extract<WorkflowStepDef, { type: "return" }>;
type SayStep = Extract<WorkflowStepDef, { type: "say" }>;
type SendStep = Extract<WorkflowStepDef, { type: "send" }>;
type ConstStep = Extract<WorkflowStepDef, { type: "const" }>;

type CallExpr = Extract<Expr, { kind: "call" }>;
type EnsureCallExpr = Extract<Expr, { kind: "ensure_call" }>;
type InlineScriptExpr = Extract<Expr, { kind: "inline_script" }>;
type PromptExpr = Extract<Expr, { kind: "prompt" }>;
type SendRunExpr = SendStep["value"];
type ConstValueExpr = ConstStep["value"];

const _callNoBare: HasField<CallExpr, "bareIdentifierArgs"> = false;
const _ensureCallNoBare: HasField<EnsureCallExpr, "bareIdentifierArgs"> = false;
const _inlineNoBare: HasField<InlineScriptExpr, "bareIdentifierArgs"> = false;
const _promptNoBare: HasField<PromptExpr, "bareIdentifierArgs"> = false;
const _sendValueNoBare: HasField<SendRunExpr, "bareIdentifierArgs"> = false;
const _constValueNoBare: HasField<ConstValueExpr, "bareIdentifierArgs"> = false;

// Managed sidecar / placeholder strings on return/log/logerr/etc. are gone:
const _returnNoManaged: HasField<ReturnStep, "managed"> = false;
const _sayNoManaged: HasField<SayStep, "managed"> = false;
const _execNoManaged: HasField<ExecStep, "managed"> = false;

// return.value is now an Expr (not a placeholder string).
const _returnValueIsExpr: ReturnStep["value"] extends Expr ? true : false = true;
const _sayMessageIsExpr: SayStep["message"] extends Expr ? true : false = true;
const _sendValueIsExpr: SendStep["value"] extends Expr ? true : false = true;
const _constValueIsExpr: ConstStep["value"] extends Expr ? true : false = true;

test("AC1: managed-call encodings collapsed into Expr; no `bareIdentifierArgs` on Expr", () => {
  assert.equal(_callNoBare, false);
  assert.equal(_ensureCallNoBare, false);
  assert.equal(_inlineNoBare, false);
  assert.equal(_promptNoBare, false);
  assert.equal(_sendValueNoBare, false);
  assert.equal(_constValueNoBare, false);
  assert.equal(_returnNoManaged, false);
  assert.equal(_sayNoManaged, false);
  assert.equal(_execNoManaged, false);
  assert.equal(_returnValueIsExpr, true);
  assert.equal(_sayMessageIsExpr, true);
  assert.equal(_sendValueIsExpr, true);
  assert.equal(_constValueIsExpr, true);
});
