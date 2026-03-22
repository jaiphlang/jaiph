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
    out.push(`${indent}${step.captureName}=$(${scopePrefix}${wfRef}::impl${args})`);
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
  // In recover blocks, ensure skips paramKeys emission (matches existing behavior).
  if (!ctx.inRecoverBlock) {
    const paramKeys = step.args ? parseParamKeysFromArgs(step.args) : null;
    if (paramKeys != null && paramKeys.length > 0) {
      out.push(`${indent}export JAIPH_STEP_PARAM_KEYS='${paramKeys.join(",")}'`);
    }
  }
  if (step.recover) {
    const recoverSteps = "single" in step.recover ? [step.recover.single] : step.recover.block;
    emitEnsureRecoverLoop(out, indent, transpiledRef, args, recoverSteps, ctx);
  } else if (step.captureName) {
    out.push(`${indent}${step.captureName}=$(${transpiledRef}::impl${args})`);
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
): void {
  const retriesDefault = String(DEFAULT_ENSURE_MAX_RETRIES);
  out.push(`${indent}local _jaiph_ensure_output`);
  out.push(`${indent}local _jaiph_ensure_prev_files`);
  out.push(`${indent}local _jaiph_ensure_new_files`);
  out.push(`${indent}local _jaiph_ensure_file`);
  out.push(`${indent}local _jaiph_ensure_chunk`);
  out.push(`${indent}local _jaiph_ensure_prev_args=()`);
  out.push(`${indent}local _jaiph_ensure_files_arr=()`);
  out.push(`${indent}local _jaiph_ensure_passed=0`);
  out.push(`${indent}for _jaiph_retry in $(seq 1 "\${JAIPH_ENSURE_MAX_RETRIES:-${retriesDefault}}"); do`);
  out.push(`${indent}  _jaiph_ensure_prev_files="\${JAIPH_PRECEDING_FILES:-}"`);
  out.push(`${indent}  if ${transpiledRef}${args}; then`);
  out.push(`${indent}    _jaiph_ensure_passed=1`);
  out.push(`${indent}    break`);
  out.push(`${indent}  fi`);
  out.push(`${indent}  _jaiph_ensure_output=""`);
  out.push(`${indent}  _jaiph_ensure_new_files="\${JAIPH_PRECEDING_FILES:-}"`);
  out.push(`${indent}  if [[ "$_jaiph_ensure_new_files" == "$_jaiph_ensure_prev_files" ]]; then`);
  out.push(`${indent}    _jaiph_ensure_new_files=""`);
  out.push(`${indent}  elif [[ -n "$_jaiph_ensure_prev_files" ]]; then`);
  out.push(`${indent}    _jaiph_ensure_new_files="\${_jaiph_ensure_new_files#\${_jaiph_ensure_prev_files},}"`);
  out.push(`${indent}  fi`);
  out.push(`${indent}  if [[ -n "$_jaiph_ensure_new_files" ]]; then`);
  out.push(`${indent}    IFS=',' read -r -a _jaiph_ensure_files_arr <<<"$_jaiph_ensure_new_files"`);
  out.push(`${indent}    for _jaiph_ensure_file in "\${_jaiph_ensure_files_arr[@]}"; do`);
  out.push(`${indent}      if [[ -f "$_jaiph_ensure_file" ]]; then`);
  out.push(`${indent}        _jaiph_ensure_chunk="$(<"$_jaiph_ensure_file")"`);
  out.push(`${indent}        if [[ -n "$_jaiph_ensure_output" ]]; then`);
  out.push(`${indent}          _jaiph_ensure_output="\${_jaiph_ensure_output}"$'\\n'"$_jaiph_ensure_chunk"`);
  out.push(`${indent}        else`);
  out.push(`${indent}          _jaiph_ensure_output="$_jaiph_ensure_chunk"`);
  out.push(`${indent}        fi`);
  out.push(`${indent}      fi`);
  out.push(`${indent}    done`);
  out.push(`${indent}  fi`);
  out.push(`${indent}  _jaiph_ensure_prev_args=("$@")`);
  out.push(`${indent}  set -- "$_jaiph_ensure_output"`);
  const recoverCtx: StepEmitCtx = { ...ctx, inRecoverBlock: true };
  for (const r of recoverSteps) {
    emitStep(out, indent + "  ", r, recoverCtx);
  }
  out.push(`${indent}  set -- "\${_jaiph_ensure_prev_args[@]}"`);
  out.push(`${indent}done`);
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
  if (step.type === "log") { out.push(`${indent}jaiph::log ${step.message}`); return; }
  if (step.type === "logerr") { out.push(`${indent}jaiph::logerr ${step.message}`); return; }
  if (step.type === "send") { emitSendStep(out, indent, step, ctx); return; }
  if (step.type === "if") { emitIfStep(out, indent, step, ctx); return; }
}
