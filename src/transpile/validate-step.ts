/**
 * Visitor table for the validator: one row per step type. `validateStep` is the
 * only entry point — it consults `Scope.allowSteps` once and dispatches into
 * `VALIDATORS`; everything below is scope-aware via the `ValidatorCtx`. The
 * expression validators live in `validate-expr.ts`, the shared call-shape /
 * string / channel helpers in `validate-step-helpers.ts`, the match validator
 * in `validate-match.ts`, and the scope/context shapes in `validate-step-ctx.ts`;
 * this file re-exports the surface `validate.ts` (and the visitor tests) consume.
 */
import type { StepDef } from "../types";
import { validateExpr, validateNamedPromptReturnsCapture, validateWorkflowShellExec } from "./validate-expr";
import {
  validateChannelRef,
  validateDotFieldRefs,
  validateDotSubject,
  validateInlineStringCaptures,
  validateSubjectForwardConst,
} from "./validate-step-helpers";
import { validatePromptStepReturns } from "./validate-prompt-schema";
import {
  stripDoubleQuotes,
  validateFailString,
  validateLogString,
  validateSimpleInterpolationIdentifiers,
} from "./validate-string";
import type { ValidatorCtx } from "./validate-step-ctx";

export type { Scope, ValidatorCtx } from "./validate-step-ctx";
export { DEF_SCOPE } from "./validate-step-ctx";
export {
  localDeclName,
  localSymFromDecl,
  refCtxWithLocals,
  type LocalSym,
} from "./validate-local-decl";
export { validateMatchExpr } from "./validate-match";
export {
  ROUTE_REF_EXPECT,
  parseSchemaFieldNames,
  resolveRouteTargetParams,
  resolvePromptDef,
  validateNoShellRedirection,
} from "./validate-step-helpers";
export { validateRef } from "./validate-ref-resolution";

type StepValidator = (s: StepDef, ctx: ValidatorCtx) => void;

const VALIDATORS: Record<StepDef["type"], StepValidator> = {
  trivia: () => {},
  // Nested declarations are validated by `validateDefTree` (their own scope /
  // sequential local visibility), never through this per-step dispatcher.
  local_decl: () => {},
  const: validateConstStep,
  return: validateReturnStep,
  send: validateSendStep,
  say: validateSayStep,
  exec: validateExecStep,
  if: validateIfStep,
  for_lines: validateForLinesStep,
};

/** Sole entry for per-step validation. Scope gate first, table dispatch second. */
export function validateStep(s: StepDef, ctx: ValidatorCtx): void {
  const v = (VALIDATORS as Record<string, StepValidator | undefined>)[s.type];
  if (!v) {
    const loc = (s as { loc?: { line: number; col: number } }).loc ?? { line: 0, col: 0 };
    ctx.diag.error(
      ctx.ast.filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `internal: no validator for step type "${(s as { type: string }).type}"`,
    );
  }
  if (!ctx.scope.allowSteps.has(s.type)) {
    const msg = ctx.scope.disallowStepMessages[s.type];
    if (msg !== undefined) {
      const loc = (s as { loc: { line: number; col: number } }).loc;
      ctx.diag.error(ctx.ast.filePath, loc.line, loc.col, "E_VALIDATE", msg);
    }
    return;
  }
  v(s, ctx);
}

// -- Per-step validators ----------------------------------------------------

function validateConstStep(s: StepDef, ctx: ValidatorCtx): void {
  if (s.type !== "const") return;
  validateExpr(s.value, s.loc, "const", ctx);
}

function validateReturnStep(s: StepDef, ctx: ValidatorCtx): void {
  if (s.type !== "return") return;
  validateExpr(s.value, s.loc, "return", ctx);
}

function validateSendStep(s: StepDef, ctx: ValidatorCtx): void {
  if (s.type !== "send") return;
  validateChannelRef(s.channel, s.loc, ctx);
  validateExpr(s.value, s.loc, "send", ctx);
}

function validateSayStep(s: StepDef, ctx: ValidatorCtx): void {
  if (s.type !== "say") return;
  if (s.level === "log" || s.level === "logerr" || s.level === "logwarn") {
    if (s.message.kind === "inline_script") return;
    if (s.message.kind === "literal") {
      validateLogString(s.message.raw, ctx.ast.filePath, s.loc.line, s.loc.col, s.level);
      const inner = s.message.raw;
      validateInlineStringCaptures(inner, s.loc, ctx);
      if (ctx.scope.withPromptSchemas) {
        validateDotFieldRefs(inner, s.loc, ctx);
      }
      validateSimpleInterpolationIdentifiers(
        inner,
        ctx.ast.filePath,
        s.loc.line,
        s.loc.col,
        s.level,
        ctx.knownVars,
        ctx.scope.kind,
        ctx.scope.withPromptSchemas ? ctx.promptSchemas : undefined,
        ctx.recoverBindings,
        ctx.localScripts,
      );
      return;
    }
    ctx.diag.error(
      ctx.ast.filePath,
      s.loc.line,
      s.loc.col,
      "E_VALIDATE",
      `unsupported ${s.level} message form`,
    );
  }
  if (s.message.kind !== "literal") {
    ctx.diag.error(
      ctx.ast.filePath,
      s.loc.line,
      s.loc.col,
      "E_VALIDATE",
      "fail message must be a literal string",
    );
  }
  validateFailString(s.message.raw, ctx.ast.filePath, s.loc.line, s.loc.col);
  const failInner = stripDoubleQuotes(s.message.raw);
  validateInlineStringCaptures(failInner, s.loc, ctx);
  if (ctx.scope.withPromptSchemas) {
    validateDotFieldRefs(failInner, s.loc, ctx);
  }
  validateSimpleInterpolationIdentifiers(
    failInner,
    ctx.ast.filePath,
    s.loc.line,
    s.loc.col,
    "fail",
    ctx.knownVars,
    ctx.scope.kind,
    ctx.scope.withPromptSchemas ? ctx.promptSchemas : undefined,
    ctx.recoverBindings,
    ctx.localScripts,
  );
}

function validateExecStep(s: StepDef, ctx: ValidatorCtx): void {
  if (s.type !== "exec") return;
  const body = s.body;
  if (body.kind === "prompt") {
    validateExpr(body, s.loc, "const", ctx);
    validatePromptStepReturns(body, s.captureName, ctx.ast.filePath);
    validateNamedPromptReturnsCapture(body, s.captureName, ctx);
    return;
  }
  if (body.kind === "shell") {
    validateWorkflowShellExec(body, ctx);
    return;
  }
  validateExpr(body, s.loc, "exec", ctx);
}

function validateIfStep(s: StepDef, ctx: ValidatorCtx): void {
  if (s.type !== "if") return;
  if (s.operand.kind === "regex") {
    try {
      new RegExp(s.operand.source);
    } catch {
      ctx.diag.error(
        ctx.ast.filePath,
        s.loc.line,
        s.loc.col,
        "E_VALIDATE",
        `invalid regex in if condition: /${s.operand.source}/`,
      );
    }
  }
  validateDotSubject(s.subject, s.loc, ctx);
  validateSubjectForwardConst(s.subject, s.loc, ctx);
}

function validateForLinesStep(s: StepDef, ctx: ValidatorCtx): void {
  if (s.type !== "for_lines") return;
  if (!ctx.knownVars.has(s.sourceVar)) {
    ctx.diag.error(
      ctx.ast.filePath,
      s.loc.line,
      s.loc.col,
      "E_VALIDATE",
      `for ... in <name>: "${s.sourceVar}" is not a known variable in this scope`,
    );
  }
}
