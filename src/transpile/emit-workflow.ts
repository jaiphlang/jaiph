import { jaiphError } from "../errors";
import type { jaiphModule, RuleRefDef, WorkflowStepDef, WorkflowRefDef } from "../types";

/** Prefix to wrap an imported workflow call so it runs with that module's config (e.g. "child::with_metadata_scope "). */
function prefixForImportedWorkflowCall(
  workflowRef: WorkflowRefDef,
  importedModuleHasMetadata: Map<string, boolean>,
): string {
  const parts = workflowRef.value.split(".");
  if (parts.length !== 2 || !importedModuleHasMetadata.get(parts[0])) return "";
  return `${parts[0]}::with_metadata_scope `;
}

/** If args look like key=value key=value..., return ordered param keys for tree display; else null. */
function parseParamKeysFromArgs(args: string): string[] | null {
  const trimmed = args.trim();
  if (trimmed.length === 0) return null;
  const keyRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)=/g;
  const matches = [...trimmed.matchAll(keyRegex)];
  if (matches.length === 0) return null;
  return matches.map((m) => m[1]);
}

function transpileRuleRef(
  ref: RuleRefDef,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
): string {
  const parts = ref.value.split(".");
  if (parts.length === 1) {
    return `${workflowSymbol}::rule::${parts[0]}`;
  }
  if (parts.length === 2) {
    const importedSymbol = importedWorkflowSymbols.get(parts[0]) ?? parts[0];
    return `${importedSymbol}::rule::${parts[1]}`;
  }
  throw new Error(`ValidationError: invalid rule reference "${ref.value}"`);
}

function transpileWorkflowRef(
  ref: WorkflowRefDef,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
): string {
  const parts = ref.value.split(".");
  if (parts.length === 1) {
    return `${workflowSymbol}::workflow::${parts[0]}`;
  }
  if (parts.length === 2) {
    const importedSymbol = importedWorkflowSymbols.get(parts[0]) ?? parts[0];
    return `${importedSymbol}::workflow::${parts[1]}`;
  }
  throw new Error(`ValidationError: invalid workflow reference "${ref.value}"`);
}

function parsePromptText(raw: string): string {
  if (!raw.startsWith(`"`)) {
    throw new Error("invalid prompt literal");
  }
  let closingQuote = -1;
  for (let i = 1; i < raw.length; i += 1) {
    if (raw[i] !== `"`) {
      continue;
    }
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && raw[j] === `\\`; j -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 1) {
      continue;
    }
    closingQuote = i;
    break;
  }
  if (closingQuote === -1) {
    throw new Error("unterminated prompt string");
  }
  if (raw.slice(closingQuote + 1).trim().length > 0) {
    throw new Error("prompt allows only whitespace after closing quote");
  }
  const quoted = raw.slice(1, closingQuote);
  let out = "";
  for (let i = 0; i < quoted.length; i += 1) {
    const ch = quoted[i];
    if (ch !== `\\`) {
      out += ch;
      continue;
    }
    const next = quoted[i + 1];
    if (next === undefined) {
      out += `\\`;
      continue;
    }
    if (next === "\n") {
      i += 1;
      continue;
    }
    if (next === "$" || next === "`" || next === `"` || next === `\\`) {
      out += next;
      i += 1;
      continue;
    }
    out += `\\`;
  }
  return out;
}

function validatePromptTextSafety(promptText: string): void {
  if (promptText.includes("`")) {
    throw new Error("prompt cannot contain backticks (`...`); use variable expansion only");
  }
  if (promptText.includes("$(")) {
    throw new Error("prompt cannot contain command substitution ($( ... )); use variable expansion only");
  }
}

export type PromptSchemaField = { name: string; type: "string" | "number" | "boolean" };

const SUPPORTED_SCHEMA_TYPES = new Set<string>(["string", "number", "boolean"]);

/**
 * Parse flat prompt returns schema string: { field: type, ... }.
 * V1: only string, number, boolean; no nested objects, arrays, or unions.
 */
function parsePromptSchema(
  rawSchema: string,
  filePath: string,
  line: number,
  col: number,
): PromptSchemaField[] {
  const trimmed = rawSchema.trim();
  if (trimmed.length === 0) {
    throw jaiphError(filePath, line, col, "E_SCHEMA", "returns schema cannot be empty");
  }
  if (/[[\]|]/.test(trimmed)) {
    throw jaiphError(
      filePath,
      line,
      col,
      "E_SCHEMA",
      "returns schema must be flat (no arrays or union types); only string, number, boolean allowed",
    );
  }
  const inner = trimmed.replace(/^\s*\{\s*/, "").replace(/\s*\}\s*$/, "").trim();
  if (inner.length === 0) {
    return [];
  }
  const fields: PromptSchemaField[] = [];
  const parts = inner.split(",");
  for (const part of parts) {
    const m = part.trim().match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\S+)\s*$/);
    if (!m) {
      throw jaiphError(
        filePath,
        line,
        col,
        "E_SCHEMA",
        `invalid returns schema entry: expected "fieldName: type" (got ${part.trim().slice(0, 40)}...)`,
      );
    }
    const [, name, typeStr] = m;
    const typeLower = typeStr.trim().toLowerCase();
    if (!SUPPORTED_SCHEMA_TYPES.has(typeLower)) {
      throw jaiphError(
        filePath,
        line,
        col,
        "E_SCHEMA",
        `unsupported type in returns schema: "${typeStr}" (only string, number, boolean allowed)`,
      );
    }
    fields.push({ name, type: typeLower as "string" | "number" | "boolean" });
  }
  return fields;
}

function promptDelimiter(content: string, seed: number): string {
  const lines = new Set(content.split("\n"));
  let index = seed;
  while (true) {
    const candidate = `__JAIPH_PROMPT_${index}__`;
    if (!lines.has(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

/** Escape for use inside a Bash single-quoted string; used for JAIPH_PROMPT_PREVIEW. */
function bashSingleQuotedEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

const PROMPT_PREVIEW_MAX_LEN = 24;

/** Emit a prompt step (untyped or typed with returns). When returns is set, captureName is required. */
function emitPromptStep(
  out: string[],
  indent: string,
  step: { type: "prompt"; raw: string; loc: { line: number; col: number }; captureName?: string; returns?: string },
  filePath: string,
): void {
  let promptText: string;
  try {
    promptText = parsePromptText(step.raw);
    validatePromptTextSafety(promptText);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid prompt literal";
    throw jaiphError(filePath, step.loc.line, step.loc.col, "E_PARSE", message);
  }
    if (step.returns !== undefined) {
    if (!step.captureName) {
      throw jaiphError(
        filePath,
        step.loc.line,
        step.loc.col,
        "E_PARSE",
        'prompt with "returns" schema must capture to a variable (e.g. result = prompt "..." returns \'{ ... }\')',
      );
    }
    const schemaFields = parsePromptSchema(step.returns, filePath, step.loc.line, step.loc.col);
    const schemaPayload = JSON.stringify({ fields: schemaFields });
    const schemaSuffix =
      "\n\nRespond with exactly one line of valid JSON (no markdown, no explanation) matching this schema: " +
      JSON.stringify(
        Object.fromEntries(schemaFields.map((f) => [f.name, f.type])),
      );
    const fullPromptText = promptText + schemaSuffix;
    const delimiter = promptDelimiter(fullPromptText, step.loc.line);
    const schemaEscaped = schemaPayload.replace(/'/g, "'\\''");
    out.push(`${indent}export JAIPH_PROMPT_PREVIEW='${bashSingleQuotedEscape(fullPromptText.slice(0, PROMPT_PREVIEW_MAX_LEN))}'`);
    out.push(`${indent}export JAIPH_PROMPT_SCHEMA='${schemaEscaped}'`);
    out.push(`${indent}export JAIPH_PROMPT_CAPTURE_NAME='${step.captureName}'`);
    out.push(`${indent}jaiph::prompt_capture_with_schema "$JAIPH_PROMPT_PREVIEW" "$@" <<${delimiter}`);
    for (const line of fullPromptText.split("\n")) {
      out.push(line);
    }
    out.push(delimiter);
    return;
  }
  const delimiter = promptDelimiter(promptText, step.loc.line);
  out.push(`${indent}export JAIPH_PROMPT_PREVIEW='${bashSingleQuotedEscape(promptText.slice(0, PROMPT_PREVIEW_MAX_LEN))}'`);
  if (step.captureName) {
    out.push(`${indent}${step.captureName}=$(jaiph::prompt_capture "$JAIPH_PROMPT_PREVIEW" "$@" <<${delimiter}`);
  } else {
    out.push(`${indent}jaiph::prompt "$JAIPH_PROMPT_PREVIEW" "$@" <<${delimiter}`);
  }
  for (const line of promptText.split("\n")) {
    out.push(line);
  }
  out.push(delimiter);
  if (step.captureName) {
    out.push(")");
  }
}

export function emitWorkflow(
  ast: jaiphModule,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
  importSourcePaths: string[],
  importedModuleHasMetadata: Map<string, boolean>,
): string {
  const scopedMetadataAssignments: Array<{ name: string; value: string }> = [];
  if (ast.metadata?.agent?.defaultModel !== undefined) {
    const v = ast.metadata.agent.defaultModel.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    scopedMetadataAssignments.push({ name: "JAIPH_AGENT_MODEL", value: v });
  }
  if (ast.metadata?.agent?.command !== undefined) {
    const v = ast.metadata.agent.command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    scopedMetadataAssignments.push({ name: "JAIPH_AGENT_COMMAND", value: v });
  }
  if (ast.metadata?.agent?.backend !== undefined) {
    const v = ast.metadata.agent.backend.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    scopedMetadataAssignments.push({ name: "JAIPH_AGENT_BACKEND", value: v });
  }
  if (ast.metadata?.agent?.trustedWorkspace !== undefined) {
    const v = ast.metadata.agent.trustedWorkspace.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    scopedMetadataAssignments.push({ name: "JAIPH_AGENT_TRUSTED_WORKSPACE", value: v });
  }
  if (ast.metadata?.agent?.cursorFlags !== undefined) {
    const v = ast.metadata.agent.cursorFlags.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    scopedMetadataAssignments.push({ name: "JAIPH_AGENT_CURSOR_FLAGS", value: v });
  }
  if (ast.metadata?.agent?.claudeFlags !== undefined) {
    const v = ast.metadata.agent.claudeFlags.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    scopedMetadataAssignments.push({ name: "JAIPH_AGENT_CLAUDE_FLAGS", value: v });
  }
  if (ast.metadata?.run?.logsDir !== undefined) {
    const v = ast.metadata.run.logsDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    scopedMetadataAssignments.push({ name: "JAIPH_RUNS_DIR", value: v });
  }
  if (ast.metadata?.run?.debug !== undefined) {
    scopedMetadataAssignments.push({ name: "JAIPH_DEBUG", value: ast.metadata.run.debug ? "true" : "false" });
  }
  const out: string[] = [];
  out.push("#!/usr/bin/env bash");
  out.push("");
  out.push("set -euo pipefail");
  out.push('jaiph_stdlib_path="${JAIPH_STDLIB:-$HOME/.local/bin/jaiph_stdlib.sh}"');
  out.push('if [[ ! -f "$jaiph_stdlib_path" ]]; then');
  out.push('  echo "jai: stdlib not found at $jaiph_stdlib_path (set JAIPH_STDLIB or reinstall jaiph)" >&2');
  out.push("  exit 1");
  out.push("fi");
  out.push('source "$jaiph_stdlib_path"');
  out.push('if [[ "$(jaiph__runtime_api)" != "1" ]]; then');
  out.push('  echo "jai: incompatible jaiph stdlib runtime (required api=1)" >&2');
  out.push("  exit 1");
  out.push("fi");
  if (ast.metadata) {
    if (ast.metadata.agent?.defaultModel !== undefined) {
      const v = ast.metadata.agent.defaultModel.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_AGENT_MODEL="\${JAIPH_AGENT_MODEL:-${v}}"`);
    }
    if (ast.metadata.agent?.command !== undefined) {
      const v = ast.metadata.agent.command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_AGENT_COMMAND="\${JAIPH_AGENT_COMMAND:-${v}}"`);
    }
    if (ast.metadata.agent?.backend !== undefined) {
      const v = ast.metadata.agent.backend.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_AGENT_BACKEND="\${JAIPH_AGENT_BACKEND:-${v}}"`);
    }
    if (ast.metadata.agent?.trustedWorkspace !== undefined) {
      const v = ast.metadata.agent.trustedWorkspace.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_AGENT_TRUSTED_WORKSPACE="\${JAIPH_AGENT_TRUSTED_WORKSPACE:-${v}}"`);
    }
    if (ast.metadata.agent?.cursorFlags !== undefined) {
      const v = ast.metadata.agent.cursorFlags.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_AGENT_CURSOR_FLAGS="\${JAIPH_AGENT_CURSOR_FLAGS:-${v}}"`);
    }
    if (ast.metadata.agent?.claudeFlags !== undefined) {
      const v = ast.metadata.agent.claudeFlags.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_AGENT_CLAUDE_FLAGS="\${JAIPH_AGENT_CLAUDE_FLAGS:-${v}}"`);
    }
    if (ast.metadata.run?.logsDir !== undefined) {
      const v = ast.metadata.run.logsDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out.push(`export JAIPH_RUNS_DIR="\${JAIPH_RUNS_DIR:-${v}}"`);
    }
    if (ast.metadata.run?.debug === true) {
      out.push('export JAIPH_DEBUG="${JAIPH_DEBUG:-true}"');
    }
    if (ast.metadata.agent || ast.metadata.run) {
      out.push("");
    }
  }
  for (const rel of importSourcePaths) {
    out.push(`source "$(dirname "\${BASH_SOURCE[0]}")/${rel}"`);
  }
  out.push("");
  if (scopedMetadataAssignments.length > 0) {
    const scopedVars = [
      "JAIPH_AGENT_MODEL",
      "JAIPH_AGENT_COMMAND",
      "JAIPH_AGENT_BACKEND",
      "JAIPH_AGENT_TRUSTED_WORKSPACE",
      "JAIPH_AGENT_CURSOR_FLAGS",
      "JAIPH_AGENT_CLAUDE_FLAGS",
      "JAIPH_RUNS_DIR",
      "JAIPH_DEBUG",
    ];
    out.push(`${workflowSymbol}::with_metadata_scope() {`);
    for (const name of scopedVars) {
      out.push(`  local __had_${name}=0`);
      out.push(`  local __old_${name}=""`);
      out.push(`  if [[ -n "\${${name}+x}" ]]; then`);
      out.push(`    __had_${name}=1`);
      out.push(`    __old_${name}="\${${name}}"`);
      out.push("  fi");
    }
    for (const assignment of scopedMetadataAssignments) {
      out.push(`  if [[ "\${${assignment.name}_LOCKED:-}" != "1" ]]; then`);
      out.push(`    export ${assignment.name}="${assignment.value}"`);
      out.push("  fi");
    }
    out.push("  set +e");
    out.push('  "$@"');
    out.push("  local __jaiph_scoped_status=$?");
    out.push("  set -e");
    for (const name of scopedVars) {
      out.push(`  if [[ "$__had_${name}" == "1" ]]; then`);
      out.push(`    export ${name}="$__old_${name}"`);
      out.push("  else");
      out.push(`    unset ${name}`);
      out.push("  fi");
    }
    out.push("  return $__jaiph_scoped_status");
    out.push("}");
    out.push("");
  }

  for (const rule of ast.rules) {
    const ruleSymbol = `${workflowSymbol}::rule::${rule.name}`;
    for (const comment of rule.comments) {
      out.push(comment);
    }
    out.push(`${ruleSymbol}::impl() {`);
    out.push("  set -eo pipefail");
    out.push("  set +u");
    if (rule.commands.length === 0) {
      out.push("  :");
    } else {
      for (const cmd of rule.commands) {
        if (cmd.startsWith("run ")) {
          throw jaiphError(
            ast.filePath,
            rule.loc.line,
            rule.loc.col,
            "E_PARSE",
            "`run` is not allowed inside a `rule` block.\nUse `ensure` to call another rule, or move this call to a `workflow`.",
          );
        }
        const ensureMatch = cmd.match(
          /^ensure\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.+))?$/,
        );
        if (ensureMatch) {
          const ref: RuleRefDef = { value: ensureMatch[1], loc: { line: 0, col: 0 } };
          const args = ensureMatch[2]?.trim();
          out.push(
            `  ${transpileRuleRef(ref, workflowSymbol, importedWorkflowSymbols)}${args ? ` ${args}` : ""}`,
          );
        } else {
          out.push(`  ${cmd}`);
        }
      }
    }
    out.push("}");
    out.push("");
    out.push(`${ruleSymbol}() {`);
    if (scopedMetadataAssignments.length > 0) {
      out.push(
        `  ${workflowSymbol}::with_metadata_scope jaiph::run_step ${ruleSymbol} jaiph::execute_readonly ${ruleSymbol}::impl "$@"`,
      );
    } else {
      out.push(`  jaiph::run_step ${ruleSymbol} jaiph::execute_readonly ${ruleSymbol}::impl "$@"`);
    }
    out.push("}");
    out.push("");
  }

  for (const fn of ast.functions) {
    const functionSymbol = `${workflowSymbol}::function::${fn.name}`;
    for (const comment of fn.comments) {
      out.push(comment);
    }
    out.push(`${functionSymbol}::impl() {`);
    out.push("  set -eo pipefail");
    out.push("  set +u");
    if (fn.commands.length === 0) {
      out.push("  :");
    } else {
      for (const cmd of fn.commands) {
        out.push(`  ${cmd}`);
      }
    }
    out.push("}");
    out.push("");
    out.push(`${functionSymbol}() {`);
    if (scopedMetadataAssignments.length > 0) {
      out.push(
        `  ${workflowSymbol}::with_metadata_scope jaiph::run_step_passthrough ${functionSymbol} ${functionSymbol}::impl "$@"`,
      );
    } else {
      out.push(`  jaiph::run_step_passthrough ${functionSymbol} ${functionSymbol}::impl "$@"`);
    }
    out.push("}");
    out.push("");
    out.push(`${fn.name}() {`);
    out.push(`  ${functionSymbol} "$@"`);
    out.push("}");
    out.push("");
  }

/** Max retries for ensure ... recover before failing. Overridable via JAIPH_ENSURE_MAX_RETRIES. */
const DEFAULT_ENSURE_MAX_RETRIES = 10;

function emitEnsureRecoverLoop(
  out: string[],
  indent: string,
  transpiledRef: string,
  args: string,
  recoverSteps: WorkflowStepDef[],
  emitRecoverStep: (s: WorkflowStepDef, indent: string) => void,
): void {
  const retriesDefault = String(DEFAULT_ENSURE_MAX_RETRIES);
  out.push(`${indent}for _jaiph_retry in $(seq 1 "\${JAIPH_ENSURE_MAX_RETRIES:-${retriesDefault}}"); do`);
  out.push(`${indent}  if ${transpiledRef}${args}; then`);
  out.push(`${indent}    break`);
  out.push(`${indent}  fi`);
  for (const r of recoverSteps) {
    emitRecoverStep(r, indent + "  ");
  }
  out.push(`${indent}done`);
  out.push(`${indent}if ! ${transpiledRef}${args}; then`);
  out.push(`${indent}  echo "jaiph: ensure condition did not pass after \${JAIPH_ENSURE_MAX_RETRIES:-${retriesDefault}} retries" >&2`);
  out.push(`${indent}  exit 1`);
  out.push(`${indent}fi`);
}

  for (const workflow of ast.workflows) {
    const emitRecoverStep = (recoverStep: WorkflowStepDef, indent: string): void => {
      if (recoverStep.type === "run") {
        const args = recoverStep.args ? ` ${recoverStep.args}` : "";
        const paramKeys = recoverStep.args ? parseParamKeysFromArgs(recoverStep.args) : null;
        if (paramKeys != null && paramKeys.length > 0) {
          out.push(`${indent}export JAIPH_STEP_PARAM_KEYS='${paramKeys.join(",")}'`);
        }
        const wfRef = transpileWorkflowRef(recoverStep.workflow, workflowSymbol, importedWorkflowSymbols);
        const scopePrefix = prefixForImportedWorkflowCall(recoverStep.workflow, importedModuleHasMetadata);
        if (recoverStep.captureName) {
          out.push(`${indent}${recoverStep.captureName}=$(${scopePrefix}${wfRef}::impl${args})`);
        } else {
          out.push(`${indent}${scopePrefix}${wfRef}${args}`);
        }
        return;
      }
      if (recoverStep.type === "ensure") {
        const tr = transpileRuleRef(recoverStep.ref, workflowSymbol, importedWorkflowSymbols);
        const a = recoverStep.args ? ` ${recoverStep.args}` : "";
        if (recoverStep.recover) {
          const steps =
            "single" in recoverStep.recover ? [recoverStep.recover.single] : recoverStep.recover.block;
          emitEnsureRecoverLoop(out, indent, tr, a, steps, emitRecoverStep);
        } else if (recoverStep.captureName) {
          out.push(`${indent}${recoverStep.captureName}=$(${tr}::impl${a})`);
        } else {
          out.push(`${indent}${tr}${a}`);
        }
        return;
      }
      if (recoverStep.type === "prompt") {
        emitPromptStep(out, indent, recoverStep, ast.filePath);
        return;
      }
      if (recoverStep.type === "shell") {
        if (recoverStep.captureName) {
          out.push(`${indent}${recoverStep.captureName}=$(${recoverStep.command})`);
        } else {
          out.push(`${indent}${recoverStep.command}`);
        }
      }
    };

    for (const comment of workflow.comments) {
      out.push(comment);
    }
    out.push(`${workflowSymbol}::workflow::${workflow.name}::impl() {`);
    out.push("  set -eo pipefail");
    out.push("  set +u");
    if (workflow.steps.length === 0) {
      out.push("  :");
    } else {
      for (const step of workflow.steps) {
        if (step.type === "ensure") {
          const transpiledRef = transpileRuleRef(step.ref, workflowSymbol, importedWorkflowSymbols);
          const args = step.args ? ` ${step.args}` : "";
          const paramKeys = step.args ? parseParamKeysFromArgs(step.args) : null;
          if (paramKeys != null && paramKeys.length > 0) {
            out.push(`  export JAIPH_STEP_PARAM_KEYS='${paramKeys.join(",")}'`);
          }
          if (step.recover) {
            const recoverSteps =
              "single" in step.recover ? [step.recover.single] : step.recover.block;
            emitEnsureRecoverLoop(out, "  ", transpiledRef, args, recoverSteps, emitRecoverStep);
          } else if (step.captureName) {
            out.push(`  ${step.captureName}=$(${transpiledRef}::impl${args})`);
          } else {
            out.push(`  ${transpiledRef}${args}`);
          }
          continue;
        }
        if (step.type === "run") {
          const args = step.args ? ` ${step.args}` : "";
          const paramKeys = step.args ? parseParamKeysFromArgs(step.args) : null;
          if (paramKeys != null && paramKeys.length > 0) {
            out.push(`  export JAIPH_STEP_PARAM_KEYS='${paramKeys.join(",")}'`);
          }
          const wfRef = transpileWorkflowRef(step.workflow, workflowSymbol, importedWorkflowSymbols);
          const scopePrefix = prefixForImportedWorkflowCall(step.workflow, importedModuleHasMetadata);
          if (step.captureName) {
            out.push(`  ${step.captureName}=$(${scopePrefix}${wfRef}::impl${args})`);
          } else {
            out.push(`  ${scopePrefix}${wfRef}${args}`);
          }
          continue;
        }
        if (step.type === "prompt") {
          emitPromptStep(out, "  ", step, ast.filePath);
          continue;
        }
        if (step.type === "shell") {
          if (step.captureName) {
            out.push(`  ${step.captureName}=$(${step.command})`);
          } else {
            out.push(`  ${step.command}`);
          }
          continue;
        }
        if (step.type === "if_not_ensure_then_run") {
          out.push(
            `  if ! ${transpileRuleRef(step.ensureRef, workflowSymbol, importedWorkflowSymbols)}; then`,
          );
          for (const wf of step.runWorkflows) {
            const args = wf.args ? ` ${wf.args}` : "";
            const paramKeys = wf.args ? parseParamKeysFromArgs(wf.args) : null;
            if (paramKeys != null && paramKeys.length > 0) {
              out.push(`    export JAIPH_STEP_PARAM_KEYS='${paramKeys.join(",")}'`);
            }
            const wfRef = transpileWorkflowRef(wf.workflow, workflowSymbol, importedWorkflowSymbols);
            const scopePrefix = prefixForImportedWorkflowCall(wf.workflow, importedModuleHasMetadata);
            out.push(`    ${scopePrefix}${wfRef}${args}`);
          }
          out.push("  fi");
          continue;
        }
        if (step.type === "if_not_ensure_then") {
          out.push(
            `  if ! ${transpileRuleRef(step.ensureRef, workflowSymbol, importedWorkflowSymbols)}; then`,
          );
          for (const thenStep of step.thenSteps) {
            if (thenStep.type === "run") {
              const args = thenStep.args ? ` ${thenStep.args}` : "";
              const paramKeys = thenStep.args ? parseParamKeysFromArgs(thenStep.args) : null;
              if (paramKeys != null && paramKeys.length > 0) {
                out.push(`    export JAIPH_STEP_PARAM_KEYS='${paramKeys.join(",")}'`);
              }
              const wfRef = transpileWorkflowRef(thenStep.workflow, workflowSymbol, importedWorkflowSymbols);
              const scopePrefix = prefixForImportedWorkflowCall(thenStep.workflow, importedModuleHasMetadata);
              if (thenStep.captureName) {
                out.push(`    ${thenStep.captureName}=$(${scopePrefix}${wfRef}::impl${args})`);
              } else {
                out.push(`    ${scopePrefix}${wfRef}${args}`);
              }
              continue;
            }
            if (thenStep.type === "prompt") {
              emitPromptStep(out, "    ", thenStep, ast.filePath);
              continue;
            }
            if (thenStep.type === "shell") {
              if (thenStep.captureName) {
                out.push(`    ${thenStep.captureName}=$(${thenStep.command})`);
              } else {
                out.push(`    ${thenStep.command}`);
              }
              continue;
            }
          }
          out.push("  fi");
          continue;
        }
        if (step.type === "if_not_shell_then") {
          out.push(`  if ! ${step.condition}; then`);
          for (const thenStep of step.thenSteps) {
            if (thenStep.type === "shell") {
              out.push(`    ${thenStep.command}`);
            } else {
              const args = thenStep.args ? ` ${thenStep.args}` : "";
              const paramKeys = thenStep.args ? parseParamKeysFromArgs(thenStep.args) : null;
              if (paramKeys != null && paramKeys.length > 0) {
                out.push(`    export JAIPH_STEP_PARAM_KEYS='${paramKeys.join(",")}'`);
              }
              const wfRef = transpileWorkflowRef(thenStep.workflow, workflowSymbol, importedWorkflowSymbols);
              const scopePrefix = prefixForImportedWorkflowCall(thenStep.workflow, importedModuleHasMetadata);
              out.push(`    ${scopePrefix}${wfRef}${args}`);
            }
          }
          out.push("  fi");
          continue;
        }
        if (step.type === "if_not_ensure_then_shell") {
          out.push(
            `  if ! ${transpileRuleRef(step.ensureRef, workflowSymbol, importedWorkflowSymbols)}; then`,
          );
          for (const { command } of step.commands) {
            out.push(`    ${command}`);
          }
          out.push("  fi");
          continue;
        }
      }
    }
    out.push("}");
    out.push("");
    out.push(`${workflowSymbol}::workflow::${workflow.name}() {`);
    if (scopedMetadataAssignments.length > 0) {
      out.push(
        `  ${workflowSymbol}::with_metadata_scope jaiph::run_step ${workflowSymbol}::workflow::${workflow.name} ${workflowSymbol}::workflow::${workflow.name}::impl "$@"`,
      );
    } else {
      out.push(
        `  jaiph::run_step ${workflowSymbol}::workflow::${workflow.name} ${workflowSymbol}::workflow::${workflow.name}::impl "$@"`,
      );
    }
    out.push("}");
    out.push("");
  }

  return out.join("\n").trimEnd();
}
