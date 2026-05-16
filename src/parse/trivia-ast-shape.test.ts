import test from "node:test";
import assert from "node:assert/strict";
import type {
  ChannelDef,
  ConstRhs,
  ImportDef,
  ScriptDef,
  ScriptImportDef,
  SendRhsDef,
  TestBlockDef,
  WorkflowMetadata,
  WorkflowStepDef,
  jaiphModule,
} from "../types";

/**
 * AC1: trivia / source-fidelity fields must not live on semantic AST types.
 *
 * Each helper below assigns an object literal with the field that *used* to
 * exist; if anyone re-adds the field to the public type, the literal type
 * widens, the type assertion below fails, and TypeScript breaks compilation —
 * which is what the criterion asks for.
 */

type HasField<T, K extends string> = T extends Record<K, unknown> ? true : false;

// jaiphModule must not carry: configLeadingComments, trailingTopLevelComments, topLevelOrder.
const _moduleNoConfigLeading: HasField<jaiphModule, "configLeadingComments"> = false;
const _moduleNoTrailing: HasField<jaiphModule, "trailingTopLevelComments"> = false;
const _moduleNoTopLevelOrder: HasField<jaiphModule, "topLevelOrder"> = false;

// ImportDef / ScriptImportDef / ChannelDef / TestBlockDef must not carry leadingComments.
const _importNoLeading: HasField<ImportDef, "leadingComments"> = false;
const _scriptImportNoLeading: HasField<ScriptImportDef, "leadingComments"> = false;
const _channelNoLeading: HasField<ChannelDef, "leadingComments"> = false;
const _testBlockNoLeading: HasField<TestBlockDef, "leadingComments"> = false;

// WorkflowMetadata must not carry configBodySequence.
const _metaNoConfigSeq: HasField<WorkflowMetadata, "configBodySequence"> = false;

// ScriptDef must not carry bodyKind.
const _scriptNoBodyKind: HasField<ScriptDef, "bodyKind"> = false;

// Pick concrete variants out of WorkflowStepDef and assert no trivia fields.
type LogStep = Extract<WorkflowStepDef, { type: "log" }>;
type LogerrStep = Extract<WorkflowStepDef, { type: "logerr" }>;
type FailStep = Extract<WorkflowStepDef, { type: "fail" }>;
type ReturnStep = Extract<WorkflowStepDef, { type: "return" }>;
type PromptStep = Extract<WorkflowStepDef, { type: "prompt" }>;

const _logNoTripleQuoted: HasField<LogStep, "tripleQuoted"> = false;
const _logerrNoTripleQuoted: HasField<LogerrStep, "tripleQuoted"> = false;
const _failNoTripleQuoted: HasField<FailStep, "tripleQuoted"> = false;
const _returnNoTripleQuoted: HasField<ReturnStep, "tripleQuoted"> = false;
const _returnNoBareSource: HasField<ReturnStep, "bareSource"> = false;
const _promptNoBodyKind: HasField<PromptStep, "bodyKind"> = false;
const _promptNoBodyIdentifier: HasField<PromptStep, "bodyIdentifier"> = false;

// ConstRhs.expr must not carry tripleQuoted.
type ConstExpr = Extract<ConstRhs, { kind: "expr" }>;
type ConstPromptCapture = Extract<ConstRhs, { kind: "prompt_capture" }>;
const _constExprNoTripleQuoted: HasField<ConstExpr, "tripleQuoted"> = false;
const _constPromptNoBodyKind: HasField<ConstPromptCapture, "bodyKind"> = false;
const _constPromptNoBodyIdentifier: HasField<ConstPromptCapture, "bodyIdentifier"> = false;

// SendRhsDef literal must not carry tripleQuoted.
type SendLiteral = Extract<SendRhsDef, { kind: "literal" }>;
const _sendLiteralNoTripleQuoted: HasField<SendLiteral, "tripleQuoted"> = false;

// Reference the symbols so they are not tree-shaken or marked unused.
test("AC1: no trivia fields on semantic AST types", () => {
  assert.equal(_moduleNoConfigLeading, false);
  assert.equal(_moduleNoTrailing, false);
  assert.equal(_moduleNoTopLevelOrder, false);
  assert.equal(_importNoLeading, false);
  assert.equal(_scriptImportNoLeading, false);
  assert.equal(_channelNoLeading, false);
  assert.equal(_testBlockNoLeading, false);
  assert.equal(_metaNoConfigSeq, false);
  assert.equal(_scriptNoBodyKind, false);
  assert.equal(_logNoTripleQuoted, false);
  assert.equal(_logerrNoTripleQuoted, false);
  assert.equal(_failNoTripleQuoted, false);
  assert.equal(_returnNoTripleQuoted, false);
  assert.equal(_returnNoBareSource, false);
  assert.equal(_promptNoBodyKind, false);
  assert.equal(_promptNoBodyIdentifier, false);
  assert.equal(_constExprNoTripleQuoted, false);
  assert.equal(_constPromptNoBodyKind, false);
  assert.equal(_constPromptNoBodyIdentifier, false);
  assert.equal(_sendLiteralNoTripleQuoted, false);
});
