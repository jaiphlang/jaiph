import { matchSendOperator } from "../parser";
import type { Expr } from "../types";
import {
  BARE_SEND_REF_MSG,
  RUN_TARGET_REF_EXPECT,
  validateRef,
} from "./validate-ref-resolution";
import { validatePromptReturnsSchema } from "./validate-prompt-schema";
import { validateManagedWorkflowShell } from "./validate-substitution";
import {
  stripDoubleQuotes,
  validateJaiphStringContent,
  validatePromptString,
  validateReturnString,
  validateSimpleInterpolationIdentifiers,
} from "./validate-string";
import { validateMatchExpr } from "./validate-match";
import {
  extractConstScriptName,
  hasUnquotedSendArrow,
  makeImportedKindLookup,
  makeSubEnv,
  promptBareIdentifier,
  validateArgVarRefs,
  validateArity,
  validateDotFieldRefs,
  validateDotSubject,
  validateInlineStringCaptures,
  validateNestedManagedCallArgs,
  validateNoShellRedirection,
} from "./validate-step-helpers";
import type { ExprLabel, ValidatorCtx } from "./validate-step-ctx";

// Expression-level validators: the `validateExpr` dispatcher and its per-kind
// bodies (literal, prompt, callable/`run`, and workflow-only inline
// shell). Split out of `validate-step.ts` so the step dispatcher stays small.

export function validateExpr(
  expr: Expr,
  stepLoc: { line: number; col: number },
  label: ExprLabel,
  ctx: ValidatorCtx,
): void {
  if (expr.kind === "literal") {
    validateLiteralExpr(expr, stepLoc, label, ctx);
    return;
  }
  if (expr.kind === "call") {
    validateCallable(expr, ctx);
    return;
  }
  if (expr.kind === "inline_script") {
    return;
  }
  if (expr.kind === "match") {
    validateMatchExpr(ctx.diag, ctx.ast.filePath, expr.match, ctx.knownVars);
    validateDotSubject(expr.match.subject, expr.match.loc, ctx);
    return;
  }
  if (expr.kind === "prompt") {
    validatePromptExpr(expr, stepLoc, label, ctx);
    return;
  }
  if (expr.kind === "bare_ref") {
    if (label !== "send") {
      ctx.diag.error(
        ctx.ast.filePath,
        expr.ref.loc.line,
        expr.ref.loc.col,
        "E_VALIDATE",
        "bare reference is only valid as a send payload",
      );
    }
    validateRef(expr.ref, ctx.ast, ctx.refCtx, {
      mode: "bare_send_rhs",
      bareSend: BARE_SEND_REF_MSG,
      lookupImportedKind: makeImportedKindLookup(ctx),
    });
    return;
  }
  if (expr.kind === "shell") {
    if (label !== "send") {
      ctx.diag.error(
        ctx.ast.filePath,
        expr.loc.line,
        expr.loc.col,
        "E_VALIDATE",
        "raw shell fragment is only valid as a send payload",
      );
    }
    validateManagedWorkflowShell(expr.command, makeSubEnv(ctx, expr.loc));
    return;
  }
}

function validateLiteralExpr(
  expr: Extract<Expr, { kind: "literal" }>,
  stepLoc: { line: number; col: number },
  label: ExprLabel,
  ctx: ValidatorCtx,
): void {
  if (label === "send") {
    const inner = expr.raw.startsWith('"') && expr.raw.endsWith('"') ? expr.raw.slice(1, -1) : expr.raw;
    validateJaiphStringContent(inner, ctx.ast.filePath, stepLoc.line, stepLoc.col, "send");
    validateInlineStringCaptures(inner, stepLoc, ctx);
    validateDotFieldRefs(inner, stepLoc, ctx);
    validateSimpleInterpolationIdentifiers(
      inner,
      ctx.ast.filePath,
      stepLoc.line,
      stepLoc.col,
      "send",
      ctx.knownVars,
      ctx.scope.kind,
      ctx.promptSchemas,
      ctx.recoverBindings,
      ctx.localScripts,
    );
    return;
  }
  if (label === "return") {
    validateReturnString(expr.raw, ctx.ast.filePath, stepLoc.line, stepLoc.col);
    if (expr.raw.startsWith('"')) {
      const retInner = stripDoubleQuotes(expr.raw);
      validateInlineStringCaptures(retInner, stepLoc, ctx);
      if (ctx.scope.withPromptSchemas) {
        validateDotFieldRefs(retInner, stepLoc, ctx);
      }
      validateSimpleInterpolationIdentifiers(
        retInner,
        ctx.ast.filePath,
        stepLoc.line,
        stepLoc.col,
        "return",
        ctx.knownVars,
        ctx.scope.kind,
        ctx.scope.withPromptSchemas ? ctx.promptSchemas : undefined,
        ctx.recoverBindings,
        ctx.localScripts,
      );
    }
    return;
  }
  // const / exec — same string-content handling
  const scriptName = extractConstScriptName(expr.raw);
  if (scriptName && ctx.localScripts.has(scriptName)) {
    ctx.diag.error(
      ctx.ast.filePath,
      stepLoc.line,
      stepLoc.col,
      "E_VALIDATE",
      `scripts are not values; "${scriptName}" is a script definition`,
    );
  }
  const inner = stripDoubleQuotes(expr.raw);
  validateInlineStringCaptures(inner, stepLoc, ctx);
  if (ctx.scope.withPromptSchemas) {
    validateDotFieldRefs(inner, stepLoc, ctx);
  }
  validateSimpleInterpolationIdentifiers(
    inner,
    ctx.ast.filePath,
    stepLoc.line,
    stepLoc.col,
    "const",
    ctx.knownVars,
    ctx.scope.kind,
    ctx.scope.withPromptSchemas ? ctx.promptSchemas : undefined,
    ctx.recoverBindings,
    ctx.localScripts,
  );
}

function validatePromptExpr(
  expr: Extract<Expr, { kind: "prompt" }>,
  stepLoc: { line: number; col: number },
  label: ExprLabel,
  ctx: ValidatorCtx,
): void {
  if (label !== "const" && label !== "exec") {
    ctx.diag.error(
      ctx.ast.filePath,
      stepLoc.line,
      stepLoc.col,
      "E_VALIDATE",
      `prompt is not a valid ${label} value`,
    );
  }
  const promptIdent = promptBareIdentifier(expr.raw);
  if (promptIdent && ctx.localScripts.has(promptIdent)) {
    ctx.diag.error(
      ctx.ast.filePath,
      stepLoc.line,
      stepLoc.col,
      "E_VALIDATE",
      `scripts are not promptable; "${promptIdent}" is a script — use a string const instead`,
    );
  }
  validatePromptString(expr.raw, ctx.ast.filePath, stepLoc.line, stepLoc.col);
  if (expr.returns !== undefined) {
    validatePromptReturnsSchema(expr.returns, ctx.ast.filePath, stepLoc.line, stepLoc.col);
  }
  const pcInner = stripDoubleQuotes(expr.raw);
  validateInlineStringCaptures(pcInner, stepLoc, ctx);
  validateDotFieldRefs(pcInner, stepLoc, ctx);
  validateSimpleInterpolationIdentifiers(
    pcInner,
    ctx.ast.filePath,
    stepLoc.line,
    stepLoc.col,
    "prompt",
    ctx.knownVars,
    ctx.scope.kind,
    ctx.promptSchemas,
    ctx.recoverBindings,
    ctx.localScripts,
  );
}

/**
 * The five checks every call site repeats: shell-redirection, nested-unmanaged
 * call inside literals, ref resolution, arity, and var-arg resolution.
 */
function validateCallable(expr: Expr, ctx: ValidatorCtx): void {
  if (expr.kind === "call") {
    const loc = expr.callee.loc;
    validateNoShellRedirection(ctx.diag, ctx.ast.filePath, loc, "run", expr.args);
    validateNestedManagedCallArgs(ctx.diag, ctx.ast.filePath, loc, expr.args);
    if (
      !expr.callee.value.includes(".") &&
      ctx.knownVars.has(expr.callee.value) &&
      !ctx.localScripts.has(expr.callee.value) &&
      !ctx.localDefs.has(expr.callee.value)
    ) {
      ctx.diag.error(
        ctx.ast.filePath,
        loc.line,
        loc.col,
        "E_VALIDATE",
        `strings are not executable; "${expr.callee.value}" is a string — use a script instead`,
      );
    }
    validateRef(expr.callee, ctx.ast, ctx.refCtx, {
      mode: "expect",
      expect: ctx.scope.runRefExpect,
    });
    validateArity(ctx.diag, ctx.ast.filePath, loc, expr.callee.value, expr.args, ctx.ast, ctx.refCtx);
    validateArgVarRefs(ctx.diag, ctx.ast.filePath, loc, expr.args, ctx.knownVars, ctx.recoverBindings, ctx);
  }
}

/** Emits W_PROMPT_IN_SHELL when a prompt capture is spliced directly into a shell line. */
function warnPromptInShellLine(
  body: Extract<Expr, { kind: "shell" }>,
  ctx: ValidatorCtx,
): void {
  if (ctx.promptCaptures.size === 0) return;
  const RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)?\}/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(body.command)) !== null) {
    const varName = m[1]!;
    if (ctx.promptCaptures.has(varName)) {
      ctx.diag.error(
        ctx.ast.filePath,
        body.loc.line,
        body.loc.col,
        "W_PROMPT_IN_SHELL",
        `prompt capture "${varName}" is interpolated into a shell line without quoting or validation; ` +
          `prefer passing it as a script argument: run my_script(${varName}) — ` +
          `scripts receive arguments as $1 $2 … (argv), which bypasses shell word-splitting. ` +
          `See: language.md`,
      );
      return; // one diagnostic per shell step is enough
    }
  }
}

export function validateWorkflowShellExec(
  body: Extract<Expr, { kind: "shell" }>,
  ctx: ValidatorCtx,
): void {
  warnPromptInShellLine(body, ctx);
  if (hasUnquotedSendArrow(body.command) && matchSendOperator(body.command) === null) {
    ctx.diag.error(
      ctx.ast.filePath,
      body.loc.line,
      body.loc.col,
      "E_VALIDATE",
      "invalid send: channel must be a single name or `alias.name` (at most one dot in the channel part)",
    );
  }
  const t = body.command.trim();
  if (/^(?:[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(t)) {
    if (!t.includes(".")) {
      if (ctx.localScripts.has(t) || ctx.localDefs.has(t)) {
        ctx.diag.error(
          ctx.ast.filePath,
          body.loc.line,
          body.loc.col,
          "E_VALIDATE",
          `use run ${t}() — a bare name that refers to a script or workflow must use a managed run step`,
        );
      }
    } else {
      validateRef({ value: t, loc: body.loc }, ctx.ast, ctx.refCtx, {
        mode: "expect",
        expect: RUN_TARGET_REF_EXPECT,
      });
      ctx.diag.error(
        ctx.ast.filePath,
        body.loc.line,
        body.loc.col,
        "E_VALIDATE",
        `use run ${t}() — "${t}" is a valid script or workflow reference; use a managed run step`,
      );
    }
  }
}
