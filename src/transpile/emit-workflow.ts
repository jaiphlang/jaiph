import { jaiphError } from "../errors";
import type { jaiphModule, RuleRefDef, WorkflowRefDef } from "../types";

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

export function emitWorkflow(
  ast: jaiphModule,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
  importSourcePaths: string[],
): string {
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
  for (const rel of importSourcePaths) {
    out.push(`source "$(dirname "\${BASH_SOURCE[0]}")/${rel}"`);
  }
  out.push("");

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
    out.push(`  jaiph::run_step ${ruleSymbol} jaiph::execute_readonly ${ruleSymbol}::impl "$@"`);
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
    out.push(`  jaiph::run_step_passthrough ${functionSymbol} ${functionSymbol}::impl "$@"`);
    out.push("}");
    out.push("");
    out.push(`${fn.name}() {`);
    out.push(`  ${functionSymbol} "$@"`);
    out.push("}");
    out.push("");
  }

  for (const workflow of ast.workflows) {
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
          out.push(`  ${transpiledRef}${args}`);
          continue;
        }
        if (step.type === "run") {
          out.push(`  ${transpileWorkflowRef(step.workflow, workflowSymbol, importedWorkflowSymbols)}`);
          continue;
        }
        if (step.type === "prompt") {
          let promptText: string;
          try {
            promptText = parsePromptText(step.raw);
            validatePromptTextSafety(promptText);
          } catch (error) {
            const message = error instanceof Error ? error.message : "invalid prompt literal";
            throw jaiphError(ast.filePath, step.loc.line, step.loc.col, "E_PARSE", message);
          }
          const delimiter = promptDelimiter(promptText, step.loc.line);
          if (step.captureName) {
            out.push(`  ${step.captureName}=$(jaiph::prompt "$@" <<${delimiter}`);
            for (const line of promptText.split("\n")) {
              out.push(line);
            }
            out.push(delimiter);
            out.push(")");
          } else {
            out.push(`  jaiph::prompt "$@" <<${delimiter}`);
            for (const line of promptText.split("\n")) {
              out.push(line);
            }
            out.push(delimiter);
          }
          continue;
        }
        if (step.type === "shell") {
          out.push(`  ${step.command}`);
          continue;
        }
        if (step.type === "if_not_ensure_then_run") {
          out.push(
            `  if ! ${transpileRuleRef(step.ensureRef, workflowSymbol, importedWorkflowSymbols)}; then`,
          );
          out.push(`    ${transpileWorkflowRef(step.runWorkflow, workflowSymbol, importedWorkflowSymbols)}`);
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
    out.push(
      `  jaiph::run_step ${workflowSymbol}::workflow::${workflow.name} ${workflowSymbol}::workflow::${workflow.name}::impl "$@"`,
    );
    out.push("}");
    out.push("");
  }

  return out.join("\n").trimEnd();
}
