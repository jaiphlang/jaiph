import test from "node:test";
import assert from "node:assert/strict";
import type {
  ChannelDef,
  ImportDef,
  ScriptDef,
  ScriptImportDef,
  TestBlockDef,
  WorkflowMetadata,
  WorkflowStepDef,
  jaiphModule,
  Expr,
} from "../types";

/**
 * AC1 (Trivia/CST split): source-fidelity fields must not live on semantic
 * AST types. Each helper below assigns an object literal with the field that
 * *used* to exist; if anyone re-adds the field to the public type, the literal
 * widens, the type assertion below fails, and TypeScript breaks compilation.
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

// Step variants must not carry surface-form trivia.
type SayStep = Extract<WorkflowStepDef, { type: "say" }>;
type ReturnStep = Extract<WorkflowStepDef, { type: "return" }>;
type SendStep = Extract<WorkflowStepDef, { type: "send" }>;
type ExecStep = Extract<WorkflowStepDef, { type: "exec" }>;

const _sayNoTripleQuoted: HasField<SayStep, "tripleQuoted"> = false;
const _returnNoTripleQuoted: HasField<ReturnStep, "tripleQuoted"> = false;
const _returnNoBareSource: HasField<ReturnStep, "bareSource"> = false;
const _execNoBodyKind: HasField<ExecStep, "bodyKind"> = false;
const _execNoBodyIdentifier: HasField<ExecStep, "bodyIdentifier"> = false;

// Expr literal must not carry tripleQuoted — that lives in trivia instead.
type LiteralExpr = Extract<Expr, { kind: "literal" }>;
type PromptExpr = Extract<Expr, { kind: "prompt" }>;
const _literalNoTripleQuoted: HasField<LiteralExpr, "tripleQuoted"> = false;
const _promptNoBodyKind: HasField<PromptExpr, "bodyKind"> = false;
const _promptNoBodyIdentifier: HasField<PromptExpr, "bodyIdentifier"> = false;

// send.value carries an Expr; the old SendRhsDef.literal wrapper with
// `tripleQuoted` is gone.
const _sendValueIsExpr: SendStep["value"] extends Expr ? true : false = true;

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
  assert.equal(_sayNoTripleQuoted, false);
  assert.equal(_returnNoTripleQuoted, false);
  assert.equal(_returnNoBareSource, false);
  assert.equal(_execNoBodyKind, false);
  assert.equal(_execNoBodyIdentifier, false);
  assert.equal(_literalNoTripleQuoted, false);
  assert.equal(_promptNoBodyKind, false);
  assert.equal(_promptNoBodyIdentifier, false);
  assert.equal(_sendValueIsExpr, true);
});
