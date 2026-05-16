import test from "node:test";
import assert from "node:assert/strict";
import type { ConstRhs, SendRhsDef, WorkflowStepDef } from "../types";

/**
 * AC1: `bareIdentifierArgs` must not appear on any call-bearing AST node.
 *
 * Each helper below probes a specific variant where the field used to live; if
 * it is re-added, `HasField` widens to `true`, the type-level assertion fails,
 * and TypeScript breaks compilation.
 */
type HasField<T, K extends string> = T extends Record<K, unknown> ? true : false;

type EnsureStep = Extract<WorkflowStepDef, { type: "ensure" }>;
type RunStep = Extract<WorkflowStepDef, { type: "run" }>;
type RunInlineScriptStep = Extract<WorkflowStepDef, { type: "run_inline_script" }>;
type LogStep = Extract<WorkflowStepDef, { type: "log" }>;
type LogerrStep = Extract<WorkflowStepDef, { type: "logerr" }>;
type ReturnStep = Extract<WorkflowStepDef, { type: "return" }>;
type LogManaged = NonNullable<LogStep["managed"]>;
type LogerrManaged = NonNullable<LogerrStep["managed"]>;
type ReturnManaged = NonNullable<ReturnStep["managed"]>;
type ReturnManagedRun = Extract<ReturnManaged, { kind: "run" }>;
type ReturnManagedEnsure = Extract<ReturnManaged, { kind: "ensure" }>;
type ReturnManagedInline = Extract<ReturnManaged, { kind: "run_inline_script" }>;
type RunCapture = Extract<ConstRhs, { kind: "run_capture" }>;
type EnsureCapture = Extract<ConstRhs, { kind: "ensure_capture" }>;
type InlineScriptCapture = Extract<ConstRhs, { kind: "run_inline_script_capture" }>;
type SendRun = Extract<SendRhsDef, { kind: "run" }>;

const _ensureNoBare: HasField<EnsureStep, "bareIdentifierArgs"> = false;
const _runNoBare: HasField<RunStep, "bareIdentifierArgs"> = false;
const _inlineNoBare: HasField<RunInlineScriptStep, "bareIdentifierArgs"> = false;
const _logManagedNoBare: HasField<LogManaged, "bareIdentifierArgs"> = false;
const _logerrManagedNoBare: HasField<LogerrManaged, "bareIdentifierArgs"> = false;
const _returnManagedRunNoBare: HasField<ReturnManagedRun, "bareIdentifierArgs"> = false;
const _returnManagedEnsureNoBare: HasField<ReturnManagedEnsure, "bareIdentifierArgs"> = false;
const _returnManagedInlineNoBare: HasField<ReturnManagedInline, "bareIdentifierArgs"> = false;
const _runCaptureNoBare: HasField<RunCapture, "bareIdentifierArgs"> = false;
const _ensureCaptureNoBare: HasField<EnsureCapture, "bareIdentifierArgs"> = false;
const _inlineCaptureNoBare: HasField<InlineScriptCapture, "bareIdentifierArgs"> = false;
const _sendRunNoBare: HasField<SendRun, "bareIdentifierArgs"> = false;

test("AC1: bareIdentifierArgs does not appear on any call-bearing AST type", () => {
  assert.equal(_ensureNoBare, false);
  assert.equal(_runNoBare, false);
  assert.equal(_inlineNoBare, false);
  assert.equal(_logManagedNoBare, false);
  assert.equal(_logerrManagedNoBare, false);
  assert.equal(_returnManagedRunNoBare, false);
  assert.equal(_returnManagedEnsureNoBare, false);
  assert.equal(_returnManagedInlineNoBare, false);
  assert.equal(_runCaptureNoBare, false);
  assert.equal(_ensureCaptureNoBare, false);
  assert.equal(_inlineCaptureNoBare, false);
  assert.equal(_sendRunNoBare, false);
});
