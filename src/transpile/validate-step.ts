/**
 * Visitor table for the validator: one row per step type, one expression
 * dispatcher, and the small per-call-shape helper that holds the five
 * standard checks. `validateStep` is the only entry point — it consults
 * `Scope.allowSteps` once and dispatches into `VALIDATORS`; everything below
 * is scope-aware via the `ValidatorCtx`.
 */
import { Diagnostics } from "../diagnostics";
import { matchSendOperator, isJaiphInterpolationRef } from "../parse/core";
import type { Arg, Expr, jaiphModule, MatchExprDef, WorkflowStepDef } from "../types";
import { canonicalizeTripleQuotedString } from "../parse/triple-quote";
import {
  BARE_SEND_REF_MSG,
  lookupKind,
  RULE_REF_EXPECT,
  RUN_IN_RULE_REF_EXPECT,
  RUN_TARGET_REF_EXPECT,
  validateRef,
  WORKFLOW_REF_EXPECT,
  type RefExpectMessages,
  type RefResolutionContext,
  type RefTargetKind,
} from "./validate-ref-resolution";
import { validatePromptReturnsSchema, validatePromptStepReturns } from "./validate-prompt-schema";
import {
  validateManagedWorkflowShell,
  type SubstitutionValidateEnv,
} from "./validate-substitution";
import {
  extractDotFieldRefs,
  extractInlineCaptures,
  validateFailString,
  validateJaiphStringContent,
  validateLogString,
  validatePromptString,
  validateReturnString,
  validateSimpleInterpolationIdentifiers,
} from "./validate-string";

export interface Scope {
  kind: "workflow" | "rule";
  /** Step types allowed in this scope — single set-lookup gate at the visitor entry. */
  allowSteps: Set<WorkflowStepDef["type"]>;
  /** Per-step-type message used when a step is rejected by `allowSteps`. */
  disallowStepMessages: Partial<Record<WorkflowStepDef["type"], string>>;
  /** Ref expectation for `run ref(...)` callees (workflow vs rule semantics differ). */
  runRefExpect: RefExpectMessages;
  /** True for workflows — rules skip prompt schema collection and reject prompts. */
  withPromptSchemas: boolean;
}

export const WORKFLOW_SCOPE: Scope = {
  kind: "workflow",
  allowSteps: new Set([
    "trivia",
    "send",
    "say",
    "return",
    "const",
    "exec",
    "if",
    "for_lines",
  ]),
  disallowStepMessages: {},
  runRefExpect: RUN_TARGET_REF_EXPECT,
  withPromptSchemas: true,
};

export const RULE_SCOPE: Scope = {
  kind: "rule",
  allowSteps: new Set(["trivia", "say", "return", "const", "exec", "if", "for_lines"]),
  disallowStepMessages: {
    send: "send is not allowed in rules",
  },
  runRefExpect: RUN_IN_RULE_REF_EXPECT,
  withPromptSchemas: false,
};

export interface ValidatorCtx {
  diag: Diagnostics;
  ast: jaiphModule;
  refCtx: RefResolutionContext;
  scope: Scope;
  knownVars: Set<string>;
  promptSchemas: Map<string, string[]>;
  recoverBindings: Set<string> | undefined;
  localChannels: Set<string>;
  localScripts: Set<string>;
  localWorkflows: Set<string>;
  importsByAlias: Map<string, string>;
  importedAstCache: Map<string, jaiphModule>;
}

type StepValidator = (s: WorkflowStepDef, ctx: ValidatorCtx) => void;

const VALIDATORS: Record<WorkflowStepDef["type"], StepValidator> = {
  trivia: () => {},
  const: validateConstStep,
  return: validateReturnStep,
  send: validateSendStep,
  say: validateSayStep,
  exec: validateExecStep,
  if: validateIfStep,
  for_lines: validateForLinesStep,
};

/** Sole entry for per-step validation. Scope gate first, table dispatch second. */
export function validateStep(s: WorkflowStepDef, ctx: ValidatorCtx): void {
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

function validateConstStep(s: WorkflowStepDef, ctx: ValidatorCtx): void {
  if (s.type !== "const") return;
  validateExpr(s.value, s.loc, "const", ctx);
}

function validateReturnStep(s: WorkflowStepDef, ctx: ValidatorCtx): void {
  if (s.type !== "return") return;
  validateExpr(s.value, s.loc, "return", ctx);
}

function validateSendStep(s: WorkflowStepDef, ctx: ValidatorCtx): void {
  if (s.type !== "send") return;
  validateChannelRef(s.channel, s.loc, ctx);
  validateExpr(s.value, s.loc, "send", ctx);
}

function validateSayStep(s: WorkflowStepDef, ctx: ValidatorCtx): void {
  if (s.type !== "say") return;
  if (s.level === "log" || s.level === "logerr") {
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
  const failInner = semanticQuotedOrchestrationInner(s.message.raw);
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

function validateExecStep(s: WorkflowStepDef, ctx: ValidatorCtx): void {
  if (s.type !== "exec") return;
  const body = s.body;
  if (body.kind === "prompt") {
    if (ctx.scope.kind === "rule") {
      ctx.diag.error(
        ctx.ast.filePath,
        body.loc.line,
        body.loc.col,
        "E_VALIDATE",
        "prompt is not allowed in rules",
      );
    }
    validateExpr(body, s.loc, "const", ctx);
    validatePromptStepReturns(body, s.captureName, ctx.ast.filePath);
    return;
  }
  if (body.kind === "shell") {
    if (ctx.scope.kind === "rule") {
      ctx.diag.error(
        ctx.ast.filePath,
        body.loc.line,
        body.loc.col,
        "E_VALIDATE",
        "inline shell steps are forbidden in rules; use explicit script blocks",
      );
    }
    validateWorkflowShellExec(body, ctx);
    return;
  }
  if (body.kind === "call" && body.async && ctx.scope.kind === "rule") {
    ctx.diag.error(
      ctx.ast.filePath,
      body.callee.loc.line,
      body.callee.loc.col,
      "E_VALIDATE",
      "run async is not allowed in rules; use it in workflows only",
    );
  }
  validateExpr(body, s.loc, "exec", ctx);
}

function validateIfStep(s: WorkflowStepDef, ctx: ValidatorCtx): void {
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
}

function validateForLinesStep(s: WorkflowStepDef, ctx: ValidatorCtx): void {
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

// -- Expr dispatcher --------------------------------------------------------

type ExprLabel = "const" | "return" | "send" | "exec";

function validateExpr(
  expr: Expr,
  stepLoc: { line: number; col: number },
  label: ExprLabel,
  ctx: ValidatorCtx,
): void {
  if (expr.kind === "literal") {
    validateLiteralExpr(expr, stepLoc, label, ctx);
    return;
  }
  if (expr.kind === "call" || expr.kind === "ensure_call") {
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
      const retInner = stripDQ(expr.raw);
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
  const inner = stripDQ(expr.raw);
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
  if (ctx.scope.kind === "rule") {
    ctx.diag.error(
      ctx.ast.filePath,
      stepLoc.line,
      stepLoc.col,
      "E_VALIDATE",
      "const ... = prompt is not allowed in rules",
    );
  }
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
  const pcInner = stripDQ(expr.raw);
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

// -- Managed call shape (the "5-check sequence") ----------------------------

/**
 * The five checks every call site repeats: shell-redirection, nested-unmanaged
 * call inside literals, ref resolution, arity, and var-arg resolution. The
 * scope picks the ref expectation for `run` (workflow vs rule semantics).
 */
function validateCallable(expr: Expr, ctx: ValidatorCtx): void {
  if (expr.kind === "call") {
    const loc = expr.callee.loc;
    validateNoShellRedirection(ctx.diag, ctx.ast.filePath, loc, "run", expr.args);
    validateNestedManagedCallArgs(ctx.diag, ctx.ast.filePath, loc, expr.args);
    const isRuleScope = ctx.scope.kind === "rule";
    if (
      !expr.callee.value.includes(".") &&
      ctx.knownVars.has(expr.callee.value) &&
      !ctx.localScripts.has(expr.callee.value) &&
      !(!isRuleScope && ctx.localWorkflows.has(expr.callee.value))
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
    validateArity(ctx.diag, ctx.ast.filePath, loc, expr.callee.value, expr.args, "workflow", ctx.ast, ctx.refCtx);
    validateArgVarRefs(ctx.diag, ctx.ast.filePath, loc, expr.args, ctx.knownVars, ctx.recoverBindings, ctx);
    return;
  }
  if (expr.kind === "ensure_call") {
    const loc = expr.callee.loc;
    validateNoShellRedirection(ctx.diag, ctx.ast.filePath, loc, "ensure", expr.args);
    validateNestedManagedCallArgs(ctx.diag, ctx.ast.filePath, loc, expr.args);
    validateRef(expr.callee, ctx.ast, ctx.refCtx, { mode: "expect", expect: RULE_REF_EXPECT });
    validateArity(ctx.diag, ctx.ast.filePath, loc, expr.callee.value, expr.args, "rule", ctx.ast, ctx.refCtx);
    validateArgVarRefs(ctx.diag, ctx.ast.filePath, loc, expr.args, ctx.knownVars, ctx.recoverBindings, ctx);
  }
}

// -- Match expression -------------------------------------------------------

export function validateMatchExpr(
  diag: Diagnostics,
  filePath: string,
  expr: MatchExprDef,
  knownVars: Set<string>,
): void {
  if (expr.arms.length === 0) {
    diag.error(filePath, expr.loc.line, expr.loc.col, "E_VALIDATE", "match must have at least one arm");
  }
  let wildcardCount = 0;
  for (const arm of expr.arms) {
    if (arm.pattern.kind === "wildcard") wildcardCount += 1;
    if (arm.pattern.kind === "regex") {
      try {
        new RegExp(arm.pattern.source);
      } catch {
        diag.error(
          filePath,
          expr.loc.line,
          expr.loc.col,
          "E_VALIDATE",
          `invalid regex in match pattern: /${arm.pattern.source}/`,
        );
      }
    }
    const bodyTrimmed = (arm.tripleQuotedBody ? canonicalizeTripleQuotedString(arm.body) : arm.body).trimStart();
    if (/^return(\s|$)/.test(bodyTrimmed)) {
      diag.error(
        filePath,
        expr.loc.line,
        expr.loc.col,
        "E_VALIDATE",
        `match arm body must not start with "return"; the match expression itself produces the value — use the expression directly after =>`,
      );
    }
    if (/`[^`]*`\s*\(/.test(bodyTrimmed) || bodyTrimmed.startsWith("```")) {
      diag.error(
        filePath,
        expr.loc.line,
        expr.loc.col,
        "E_VALIDATE",
        `inline scripts are not allowed in match arm bodies; use a named script with "run script_name(…)" instead`,
      );
    }
    if (!arm.tripleQuotedBody) {
      const idMatch = bodyTrimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (idMatch) {
        const ident = idMatch[1]!;
        const after = bodyTrimmed.slice(ident.length);
        const startsCall = after.startsWith("(");
        const startsArgs = /^\s+\S/.test(after);
        if ((startsCall || startsArgs) && ident !== "fail" && ident !== "run" && ident !== "ensure") {
          const hint = ident === "error" ? ` did you mean "fail"?` : "";
          diag.error(
            filePath,
            expr.loc.line,
            expr.loc.col,
            "E_VALIDATE",
            `unknown match arm verb "${ident}"; allowed: fail "...", run ref(...), ensure ref(...).${hint}`,
          );
        }
        if (!startsCall && !startsArgs && after.trim() === "" && !knownVars.has(ident)) {
          diag.error(
            filePath,
            expr.loc.line,
            expr.loc.col,
            "E_VALIDATE",
            `unknown identifier "${ident}" in match arm body; declare it with "const", use a capture, or add a parameter`,
          );
        }
      }
    }
  }
  if (wildcardCount === 0) {
    diag.error(filePath, expr.loc.line, expr.loc.col, "E_VALIDATE", "match must have exactly one wildcard (_) arm");
  }
  if (wildcardCount > 1) {
    diag.error(
      filePath,
      expr.loc.line,
      expr.loc.col,
      "E_VALIDATE",
      "match must have exactly one wildcard (_) arm, found multiple",
    );
  }
}

// -- Workflow shell exec (workflow-only body kind) --------------------------

function validateWorkflowShellExec(
  body: Extract<Expr, { kind: "shell" }>,
  ctx: ValidatorCtx,
): void {
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
      if (ctx.localScripts.has(t) || ctx.localWorkflows.has(t)) {
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

// -- Channel/route helpers --------------------------------------------------

function validateChannelRef(channel: string, loc: { line: number; col: number }, ctx: ValidatorCtx): void {
  const parts = channel.split(".");
  if (parts.length === 1) {
    if (!ctx.localChannels.has(channel)) {
      ctx.diag.error(ctx.ast.filePath, loc.line, loc.col, "E_VALIDATE", `Channel "${channel}" is not defined`);
    }
    return;
  }
  if (parts.length !== 2) {
    ctx.diag.error(ctx.ast.filePath, loc.line, loc.col, "E_VALIDATE", `Channel "${channel}" is not defined`);
  }
  const [alias, importedChannel] = parts;
  const importedFile = ctx.importsByAlias.get(alias);
  if (!importedFile) {
    ctx.diag.error(ctx.ast.filePath, loc.line, loc.col, "E_VALIDATE", `Channel "${channel}" is not defined`);
  }
  const importedAst = ctx.importedAstCache.get(importedFile)!;
  const importedChannels = new Set(importedAst.channels.map((c) => c.name));
  if (!importedChannels.has(importedChannel)) {
    ctx.diag.error(ctx.ast.filePath, loc.line, loc.col, "E_VALIDATE", `Channel "${channel}" is not defined`);
  }
}

export const ROUTE_REF_EXPECT: RefExpectMessages = WORKFLOW_REF_EXPECT;

export function resolveRouteTargetParams(
  ref: string,
  ast: jaiphModule,
  refCtx: RefResolutionContext,
): number | undefined {
  const dotIdx = ref.indexOf(".");
  if (dotIdx >= 0) {
    const alias = ref.slice(0, dotIdx);
    const name = ref.slice(dotIdx + 1);
    const importPath = refCtx.importsByAlias.get(alias);
    if (!importPath) return undefined;
    const importedAst = refCtx.importedAstCache.get(importPath);
    if (!importedAst) return undefined;
    const wf = importedAst.workflows.find((w) => w.name === name);
    return wf?.params.length;
  }
  const wf = ast.workflows.find((w) => w.name === ref);
  return wf?.params.length;
}

// -- Inline string captures / dot-field refs --------------------------------

function validateInlineStringCaptures(
  content: string,
  loc: { line: number; col: number },
  ctx: ValidatorCtx,
): void {
  for (const cap of extractInlineCaptures(content)) {
    if (cap.kind === "run") {
      validateNoShellRedirection(ctx.diag, ctx.ast.filePath, loc, "run", cap.args);
      validateRef({ value: cap.ref, loc }, ctx.ast, ctx.refCtx, {
        mode: "expect",
        expect: ctx.scope.runRefExpect,
      });
    } else {
      validateNoShellRedirection(ctx.diag, ctx.ast.filePath, loc, "ensure", cap.args);
      validateRef({ value: cap.ref, loc }, ctx.ast, ctx.refCtx, {
        mode: "expect",
        expect: RULE_REF_EXPECT,
      });
    }
  }
}

function validateDotFieldRefs(
  content: string,
  loc: { line: number; col: number },
  ctx: ValidatorCtx,
): void {
  for (const ref of extractDotFieldRefs(content)) {
    validateDotFieldRef(ref.varName, ref.fieldName, loc, ctx);
  }
}

/**
 * Validate a dot-notation `if` / `match` subject like `r.verdict`. Emits the
 * same `E_VALIDATE` diagnostics as `${var.field}` interpolation when the base
 * is not a typed prompt capture or the field is not in its `returns` schema.
 * Non-dot subjects (single identifier) are accepted without further checks
 * to preserve prior behavior.
 */
function validateDotSubject(
  subject: string,
  loc: { line: number; col: number },
  ctx: ValidatorCtx,
): void {
  const dotIdx = subject.indexOf(".");
  if (dotIdx === -1) return;
  const varName = subject.slice(0, dotIdx);
  const fieldName = subject.slice(dotIdx + 1);
  validateDotFieldRef(varName, fieldName, loc, ctx);
}

function validateDotFieldRef(
  varName: string,
  fieldName: string,
  loc: { line: number; col: number },
  ctx: ValidatorCtx,
): void {
  const fields = ctx.promptSchemas.get(varName);
  if (!fields) {
    ctx.diag.error(
      ctx.ast.filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `\${${varName}.${fieldName}}: "${varName}" is not a typed prompt capture; dot notation requires a prompt with "returns" schema`,
    );
    return;
  }
  if (!fields.includes(fieldName)) {
    ctx.diag.error(
      ctx.ast.filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `\${${varName}.${fieldName}}: field "${fieldName}" is not defined in the returns schema for "${varName}"; available fields: ${fields.join(", ")}`,
    );
  }
}

// -- Shared call-shape helpers ----------------------------------------------

function hasShellRedirection(args: Arg[] | undefined): boolean {
  if (!args) return false;
  for (const a of args) {
    if (a.kind !== "literal") continue;
    let inQuote = false;
    const raw = a.raw;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"' && (i === 0 || raw[i - 1] !== "\\")) {
        inQuote = !inQuote;
        continue;
      }
      if (!inQuote && (ch === ">" || ch === "|" || ch === "&")) {
        return true;
      }
    }
  }
  return false;
}

export function validateNoShellRedirection(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  keyword: string,
  args: Arg[] | undefined,
): void {
  if (!hasShellRedirection(args)) return;
  diag.error(
    filePath,
    loc.line,
    loc.col,
    "E_VALIDATE",
    `shell redirection (>, >>, |, &) is not supported with ${keyword}; use a script block for shell operations`,
  );
}

function validateNestedManagedCallArgs(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  args: Arg[] | undefined,
): void {
  if (!args) return;
  for (const a of args) {
    if (a.kind !== "literal") continue;
    checkNestedManagedInLiteral(diag, filePath, loc, a.raw);
  }
}

function checkNestedManagedInLiteral(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  raw: string,
): void {
  const stripped = stripQuotedSegmentContent(raw);
  const re = /\b([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const before = stripped.slice(0, match.index).trimEnd();
    const lastToken = before.length === 0 ? "" : before.slice(before.lastIndexOf(" ") + 1);
    if (lastToken === "run" || lastToken === "ensure") continue;
    diag.error(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `nested managed calls in argument position must be explicit; use "run ${match[1]}(...)" or "ensure ${match[1]}(...)" inside the argument list`,
    );
  }
  const btRe = /`[^`]*`\s*\(/g;
  let btMatch: RegExpExecArray | null;
  while ((btMatch = btRe.exec(stripped)) !== null) {
    const before = stripped.slice(0, btMatch.index).trimEnd();
    const lastToken = before.length === 0 ? "" : before.slice(before.lastIndexOf(" ") + 1);
    if (lastToken === "run" || lastToken === "ensure") continue;
    diag.error(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `nested inline script calls in argument position must be explicit; use "run \`...\`(...)" inside the argument list`,
    );
  }
}

function stripQuotedSegmentContent(segment: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote && segment[i - 1] !== "\\") {
        quote = null;
      }
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

function validateArgVarRefs(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  args: Arg[] | undefined,
  knownVars: Set<string>,
  recoverBindings: Set<string> | undefined,
  ctx: ValidatorCtx,
): void {
  if (!args) return;
  for (const a of args) {
    if (a.kind === "literal") {
      // Unquoted `${…}` is only valid inside strings. Call args must use bare
      // identifiers / bare IDENT.IDENT (or a quoted string that embeds ${…}).
      if (isJaiphInterpolationRef(a.raw)) {
        const bare = a.raw.slice(2, -1); // strip ${ }
        diag.error(
          filePath,
          loc.line,
          loc.col,
          "E_VALIDATE",
          `call arguments cannot use unquoted interpolation ${a.raw}; use bare ${bare.includes(".") ? "field access" : "identifier"}: ...(${bare})`,
        );
        continue;
      }
      // Quoted strings may embed `${var.field}` — validate those fields.
      validateDotFieldRefs(a.raw, loc, ctx);
      continue;
    }
    const dotIdx = a.name.indexOf(".");
    if (dotIdx >= 0) {
      // Bare IDENT.IDENT — typed-prompt field access; runtime expands via ${base.field}.
      validateDotFieldRef(a.name.slice(0, dotIdx), a.name.slice(dotIdx + 1), loc, ctx);
      continue;
    }
    if (recoverBindings?.has(a.name)) continue;
    if (knownVars.has(a.name)) continue;
    diag.error(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `unknown identifier "${a.name}" used as bare argument; declare it with "const", use a capture, or add a workflow/rule parameter`,
    );
  }
}

function validateArity(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  ref: string,
  args: Arg[] | undefined,
  targetKind: "workflow" | "rule",
  ast: jaiphModule,
  refCtx: RefResolutionContext,
): void {
  const params = lookupCalleeParams(ref, targetKind, ast, refCtx);
  if (params === undefined) return;
  const argCount = args?.length ?? 0;
  if (argCount !== params.length) {
    diag.error(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `${targetKind} "${ref}" expects ${params.length} argument(s) (${params.join(", ") || "none"}), but got ${argCount}`,
    );
  }
}

function lookupCalleeParams(
  ref: string,
  targetKind: "workflow" | "rule",
  ast: jaiphModule,
  refCtx: RefResolutionContext,
): string[] | undefined {
  const parts = ref.split(".");
  if (parts.length === 1) {
    const name = parts[0];
    if (targetKind === "workflow") {
      const wf = ast.workflows.find((w) => w.name === name);
      return wf?.params;
    }
    const rl = ast.rules.find((r) => r.name === name);
    return rl?.params;
  }
  if (parts.length === 2) {
    const [alias, name] = parts;
    const importedFile = refCtx.importsByAlias.get(alias);
    if (!importedFile) return undefined;
    const importedAst = refCtx.importedAstCache.get(importedFile);
    if (!importedAst) return undefined;
    if (targetKind === "workflow") {
      const wf = importedAst.workflows.find((w) => w.name === name);
      return wf?.params;
    }
    const rl = importedAst.rules.find((r) => r.name === name);
    return rl?.params;
  }
  return undefined;
}

// -- Misc small helpers -----------------------------------------------------

function hasUnquotedSendArrow(line: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && (inDoubleQuote || inSingleQuote)) {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && ch === "<" && line[i + 1] === "-") {
      return true;
    }
  }
  return false;
}

function stripDQ(s: string): string {
  return s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s;
}

function semanticQuotedOrchestrationInner(dqRaw: string): string {
  return stripDQ(dqRaw);
}

function extractConstScriptName(rhs: string): string | undefined {
  const trimmed = rhs.trim();
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) return trimmed;
  const inner = stripDQ(trimmed);
  const m = inner.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
  return m?.[1];
}

function promptBareIdentifier(raw: string): string | undefined {
  const m = raw.match(/^"\$\{([A-Za-z_][A-Za-z0-9_]*)\}"$/);
  return m?.[1];
}

export function parseSchemaFieldNames(rawSchema: string): string[] {
  const inner = rawSchema.trim().replace(/^\s*\{\s*/, "").replace(/\s*\}\s*$/, "").trim();
  if (!inner) return [];
  const names: string[] = [];
  for (const part of inner.split(",")) {
    const m = part.trim().match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\S+\s*$/);
    if (m) names.push(m[1]);
  }
  return names;
}

function makeImportedKindLookup(
  ctx: ValidatorCtx,
): (alias: string, name: string) => RefTargetKind | undefined {
  return (alias, name) => {
    const importedFile = ctx.importsByAlias.get(alias);
    if (!importedFile) return undefined;
    const importedAst = ctx.importedAstCache.get(importedFile)!;
    return lookupKind(importedAst, name);
  };
}

function makeSubEnv(
  ctx: ValidatorCtx,
  loc: { line: number; col: number },
): SubstitutionValidateEnv {
  return {
    filePath: ctx.ast.filePath,
    loc,
    localRules: new Set(ctx.ast.rules.map((r) => r.name)),
    localWorkflows: ctx.localWorkflows,
    localScripts: ctx.localScripts,
    importsByAlias: ctx.importsByAlias,
    lookupImported: makeImportedKindLookup(ctx),
  };
}
