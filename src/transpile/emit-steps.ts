import type { RuleRefDef, WorkflowStepDef, WorkflowRefDef } from "../types";
import { emitPromptStepToOut } from "./emit-prompt";

// ---------------------------------------------------------------------------
// Shared context for step emitters
// ---------------------------------------------------------------------------

export type StepEmitCtx = {
  workflowSymbol: string;
  importedWorkflowSymbols: Map<string, string>;
  importedModuleHasMetadata: Map<string, boolean>;
  filePath: string;
  workflowName: string;
  /** In recover blocks, run/ensure default to ' "$@"' args and ensure skips paramKeys. */
  inRecoverBlock: boolean;
};

// ---------------------------------------------------------------------------
// Helpers (exported where needed by emit-workflow.ts)
// ---------------------------------------------------------------------------

/** Prefix to wrap an imported workflow call so it runs with that module's config. */
function prefixForImportedWorkflowCall(
  workflowRef: WorkflowRefDef,
  importedModuleHasMetadata: Map<string, boolean>,
  importedWorkflowSymbols: Map<string, string>,
): string {
  const parts = workflowRef.value.split(".");
  if (parts.length !== 2 || !importedModuleHasMetadata.get(parts[0])) return "";
  const symbol = importedWorkflowSymbols.get(parts[0]) ?? parts[0];
  return `${symbol}::with_metadata_scope `;
}

/** If args look like key=value key=value..., return ordered param keys for tree display; else null. */
export function parseParamKeysFromArgs(args: string): string[] | null {
  const trimmed = args.trim();
  if (trimmed.length === 0) return null;
  const keyRegex = /\b([a-zA-Z_][A-Za-z0-9_]*)=/g;
  const matches = [...trimmed.matchAll(keyRegex)];
  if (matches.length === 0) return null;
  return matches.map((m) => m[1]);
}

function transpileRef(
  refValue: string,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
): string {
  const parts = refValue.split(".");
  if (parts.length === 1) {
    return `${workflowSymbol}::${parts[0]}`;
  }
  if (parts.length === 2) {
    const importedSymbol = importedWorkflowSymbols.get(parts[0]) ?? parts[0];
    return `${importedSymbol}::${parts[1]}`;
  }
  throw new Error(`ValidationError: invalid reference "${refValue}"`);
}

export function transpileRuleRef(
  ref: RuleRefDef,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
): string {
  return transpileRef(ref.value, workflowSymbol, importedWorkflowSymbols);
}

export function transpileWorkflowRef(
  ref: WorkflowRefDef,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
): string {
  return transpileRef(ref.value, workflowSymbol, importedWorkflowSymbols);
}

/**
 * Replace `alias.name` patterns in shell commands with
 * the fully-qualified bash symbol (`symbol::name`).
 */
export function resolveShellRefs(
  command: string,
  importedWorkflowSymbols: Map<string, string>,
): string {
  for (const [alias, symbol] of importedWorkflowSymbols) {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_])${alias}\\.([A-Za-z_][A-Za-z0-9_]*)`,
      "g",
    );
    command = command.replace(pattern, `${symbol}::$1`);
  }
  return command;
}

/** Bash requires no space around = in local/export/readonly. */
export function normalizeShellLocalExport(command: string): string {
  return command.replace(
    /\b(local|export|readonly)\s+([A-Za-z_][A-Za-z0-9_]*)\s+=\s+/g,
    "$1 $2=",
  );
}

// ---------------------------------------------------------------------------
// Per-step emitters
// ---------------------------------------------------------------------------

export function emitRunStep(
  out: string[],
  indent: string,
  step: Extract<WorkflowStepDef, { type: "run" }>,
  ctx: StepEmitCtx,
): void {
  const defaultArgs = ctx.inRecoverBlock ? ' "$@"' : "";
  const args = step.args ? ` ${step.args}` : defaultArgs;
  const paramKeys = step.args ? parseParamKeysFromArgs(step.args) : null;
  if (paramKeys != null && paramKeys.length > 0) {
    out.push(`${indent}export JAIPH_STEP_PARAM_KEYS='${paramKeys.join(",")}'`);
  }
  const wfRef = transpileWorkflowRef(step.workflow, ctx.workflowSymbol, ctx.importedWorkflowSymbols);
  const scopePrefix = prefixForImportedWorkflowCall(step.workflow, ctx.importedModuleHasMetadata, ctx.importedWorkflowSymbols);
  if (step.captureName) {
    emitReturnValueCapture(out, indent, step.captureName, `${scopePrefix}${wfRef}${args}`);
  } else {
    out.push(`${indent}${scopePrefix}${wfRef}${args}`);
  }
}

export function emitShellStep(
  out: string[],
  indent: string,
  step: Extract<WorkflowStepDef, { type: "shell" }>,
  ctx: StepEmitCtx,
): void {
  const resolved = normalizeShellLocalExport(
    resolveShellRefs(step.command, ctx.importedWorkflowSymbols),
  );
  if (step.captureName) {
    out.push(`${indent}${step.captureName}=$(${resolved})`);
  } else {
    out.push(`${indent}${resolved}`);
  }
}

export function emitSendStep(
  out: string[],
  indent: string,
  step: Extract<WorkflowStepDef, { type: "send" }>,
  ctx: StepEmitCtx,
): void {
  if (step.command === "") {
    out.push(`${indent}jaiph::send '${step.channel}' "$1" '${ctx.workflowName}'`);
  } else {
    const resolved = resolveShellRefs(step.command, ctx.importedWorkflowSymbols);
    out.push(`${indent}jaiph::send '${step.channel}' "$(${resolved})" '${ctx.workflowName}'`);
  }
}

export function emitEnsureStep(
  out: string[],
  indent: string,
  step: Extract<WorkflowStepDef, { type: "ensure" }>,
  ctx: StepEmitCtx,
): void {
  const transpiledRef = transpileRuleRef(step.ref, ctx.workflowSymbol, ctx.importedWorkflowSymbols);
  const defaultArgs = ctx.inRecoverBlock ? ' "$@"' : "";
  const args = step.args ? ` ${step.args}` : defaultArgs;
  if (!ctx.inRecoverBlock) {
    const paramKeys = step.args ? parseParamKeysFromArgs(step.args) : null;
    if (paramKeys != null && paramKeys.length > 0) {
      out.push(`${indent}export JAIPH_STEP_PARAM_KEYS='${paramKeys.join(",")}'`);
    }
  }
  if (step.recover) {
    const recoverSteps = "single" in step.recover ? [step.recover.single] : step.recover.block;
    emitEnsureRecoverLoop(out, indent, transpiledRef, args, recoverSteps, ctx, step.captureName);
  } else if (step.captureName) {
    emitReturnValueCapture(out, indent, step.captureName, `${transpiledRef}${args}`);
  } else {
    out.push(`${indent}${transpiledRef}${args}`);
  }
}

export function emitIfStep(
  out: string[],
  indent: string,
  step: Extract<WorkflowStepDef, { type: "if" }>,
  ctx: StepEmitCtx,
): void {
  const negPrefix = step.negated ? "! " : "";
  if (step.condition.kind === "ensure") {
    const ensureArgs = step.condition.args ? ` ${step.condition.args}` : "";
    out.push(
      `${indent}if ${negPrefix}${transpileRuleRef(step.condition.ref, ctx.workflowSymbol, ctx.importedWorkflowSymbols)}${ensureArgs}; then`,
    );
  } else if (step.condition.kind === "run") {
    const runArgs = step.condition.args ? ` ${step.condition.args}` : "";
    const wfRef = transpileWorkflowRef(step.condition.ref, ctx.workflowSymbol, ctx.importedWorkflowSymbols);
    const scopePrefix = prefixForImportedWorkflowCall(step.condition.ref, ctx.importedModuleHasMetadata, ctx.importedWorkflowSymbols);
    out.push(`${indent}if ${negPrefix}${scopePrefix}${wfRef}${runArgs}; then`);
  } else {
    const resolvedCondition = resolveShellRefs(step.condition.command, ctx.importedWorkflowSymbols);
    out.push(`${indent}if ${negPrefix}${resolvedCondition}; then`);
  }
  const branchCtx: StepEmitCtx = { ...ctx, inRecoverBlock: false };
  for (const branchStep of step.thenSteps) {
    emitStep(out, indent + "  ", branchStep, branchCtx);
  }
  if (step.elseSteps && step.elseSteps.length > 0) {
    out.push(`${indent}else`);
    for (const branchStep of step.elseSteps) {
      emitStep(out, indent + "  ", branchStep, branchCtx);
    }
  }
  out.push(`${indent}fi`);
}

// ---------------------------------------------------------------------------
// Return value capture helper
// ---------------------------------------------------------------------------

/**
 * Emit bash that captures the return value (via JAIPH_RETURN_VALUE_FILE)
 * from a rule/workflow/function call into a variable.
 * stdout goes to artifacts; only the explicit return value is captured.
 */
function emitReturnValueCapture(
  out: string[],
  indent: string,
  captureName: string,
  callExpr: string,
): void {
  const rv = `_jaiph_rv_${captureName}`;
  out.push(`${indent}local ${rv}; ${rv}=$(mktemp)`);
  out.push(`${indent}JAIPH_RETURN_VALUE_FILE="$${rv}" ${callExpr}`);
  out.push(`${indent}${captureName}=""; [[ -s "$${rv}" ]] && ${captureName}=$(<"$${rv}")`);
  out.push(`${indent}rm -f "$${rv}"`);
}

// ---------------------------------------------------------------------------
// Recover loop
// ---------------------------------------------------------------------------

/** Max retries for ensure ... recover before failing. */
const DEFAULT_ENSURE_MAX_RETRIES = 10;

export function emitEnsureRecoverLoop(
  out: string[],
  indent: string,
  transpiledRef: string,
  args: string,
  recoverSteps: WorkflowStepDef[],
  ctx: StepEmitCtx,
  captureName?: string,
): void {
  const retriesDefault = String(DEFAULT_ENSURE_MAX_RETRIES);
  out.push(`${indent}local _jaiph_ensure_rv_file; _jaiph_ensure_rv_file=$(mktemp)`);
  out.push(`${indent}local _jaiph_ensure_output`);
  out.push(`${indent}local _jaiph_ensure_prev_args=()`);
  out.push(`${indent}local _jaiph_ensure_passed=0`);
  out.push(`${indent}for _jaiph_retry in $(seq 1 "\${JAIPH_ENSURE_MAX_RETRIES:-${retriesDefault}}"); do`);
  out.push(`${indent}  : > "$_jaiph_ensure_rv_file"`);
  out.push(`${indent}  if JAIPH_RETURN_VALUE_FILE="$_jaiph_ensure_rv_file" ${transpiledRef}${args}; then`);
  out.push(`${indent}    _jaiph_ensure_passed=1`);
  out.push(`${indent}    break`);
  out.push(`${indent}  fi`);
  out.push(`${indent}  _jaiph_ensure_output=""`);
  out.push(`${indent}  [[ -s "$_jaiph_ensure_rv_file" ]] && _jaiph_ensure_output=$(<"$_jaiph_ensure_rv_file")`);
  out.push(`${indent}  _jaiph_ensure_prev_args=("$@")`);
  out.push(`${indent}  set -- "$_jaiph_ensure_output"`);
  const recoverCtx: StepEmitCtx = { ...ctx, inRecoverBlock: true };
  for (const r of recoverSteps) {
    emitStep(out, indent + "  ", r, recoverCtx);
  }
  out.push(`${indent}  set -- "\${_jaiph_ensure_prev_args[@]}"`);
  out.push(`${indent}done`);
  if (captureName) {
    out.push(`${indent}${captureName}=""; [[ -s "$_jaiph_ensure_rv_file" ]] && ${captureName}=$(<"$_jaiph_ensure_rv_file")`);
  }
  out.push(`${indent}rm -f "$_jaiph_ensure_rv_file"`);
  out.push(`${indent}if [[ "$_jaiph_ensure_passed" -ne 1 ]]; then`);
  out.push(`${indent}  echo "jaiph: ensure condition did not pass after \${JAIPH_ENSURE_MAX_RETRIES:-${retriesDefault}} retries" >&2`);
  out.push(`${indent}  exit 1`);
  out.push(`${indent}fi`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Emit a single workflow step to the output array. */
export function emitStep(
  out: string[],
  indent: string,
  step: WorkflowStepDef,
  ctx: StepEmitCtx,
): void {
  if (step.type === "ensure") { emitEnsureStep(out, indent, step, ctx); return; }
  if (step.type === "run") { emitRunStep(out, indent, step, ctx); return; }
  if (step.type === "prompt") { emitPromptStepToOut(out, indent, step, ctx); return; }
  if (step.type === "shell") { emitShellStep(out, indent, step, ctx); return; }
  if (step.type === "return") { out.push(`${indent}jaiph::set_return_value ${step.value}`); out.push(`${indent}return 0`); return; }
  if (step.type === "log") { out.push(`${indent}jaiph::log ${step.message}`); return; }
  if (step.type === "logerr") { out.push(`${indent}jaiph::logerr ${step.message}`); return; }
  if (step.type === "send") { emitSendStep(out, indent, step, ctx); return; }
  if (step.type === "if") { emitIfStep(out, indent, step, ctx); return; }
}
