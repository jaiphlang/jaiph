import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import { jaiphError } from "./errors";
import { parsejaiph } from "./parser";
import { CompileResult, jaiphModule, RuleRefDef, WorkflowRefDef } from "./types";

function toWorkflowSymbol(inputFile: string, rootDir: string): string {
  const rel = relative(rootDir, inputFile);
  const parsed = parse(rel);
  const dirParts = parsed.dir ? parsed.dir.split(sep).filter(Boolean) : [];
  return [...dirParts, parsed.name].join("__");
}

export function workflowSymbolForFile(inputFile: string, rootDir: string): string {
  return toWorkflowSymbol(resolve(inputFile), resolve(rootDir));
}

function toImportSource(importPath: string, inputFile: string, rootDir: string): string {
  const importedFile = resolveImportPath(inputFile, importPath);
  const importedRel = relative(rootDir, importedFile).replace(/\.jph$/, ".sh");
  const currentRel = relative(rootDir, inputFile).replace(/\.jph$/, ".sh");
  const currentDir = dirname(currentRel);
  return relative(currentDir, importedRel).split(sep).join("/");
}

function transpileRuleRef(
  ref: RuleRefDef,
  workflowSymbol: string,
  importedWorkflowSymbols: Map<string, string>,
): string {
  const parts = ref.value.split(".");
  if (parts.length === 1) {
    return `${workflowSymbol}__rule_${parts[0]}`;
  }
  if (parts.length === 2) {
    const importedSymbol = importedWorkflowSymbols.get(parts[0]) ?? parts[0];
    return `${importedSymbol}__rule_${parts[1]}`;
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
    return `${workflowSymbol}__workflow_${parts[0]}`;
  }
  if (parts.length === 2) {
    const importedSymbol = importedWorkflowSymbols.get(parts[0]) ?? parts[0];
    return `${importedSymbol}__workflow_${parts[1]}`;
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

export function transpileFile(inputFile: string, rootDir: string): string {
  const ast = parsejaiph(readFileSync(inputFile, "utf8"), inputFile);
  validateReferences(ast);
  const workflowSymbol = toWorkflowSymbol(inputFile, rootDir);
  const importedWorkflowSymbols = new Map<string, string>();
  for (const imp of ast.imports) {
    const importedFile = resolveImportPath(ast.filePath, imp.path);
    importedWorkflowSymbols.set(imp.alias, toWorkflowSymbol(importedFile, rootDir));
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
  for (const imp of ast.imports) {
    out.push(`source "$(dirname "\${BASH_SOURCE[0]}")/${toImportSource(imp.path, inputFile, rootDir)}"`);
  }
  out.push("");

  for (const rule of ast.rules) {
    const ruleSymbol = `${workflowSymbol}__rule_${rule.name}`;
    for (const comment of rule.comments) {
      out.push(comment);
    }
    out.push(`${ruleSymbol}__impl() {`);
    out.push("  set -eo pipefail");
    out.push("  set +u");
    if (rule.commands.length === 0) {
      out.push("  :");
    } else {
      for (const cmd of rule.commands) {
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
    out.push(`  jaiph__run_step ${ruleSymbol} jaiph__execute_readonly ${ruleSymbol}__impl "$@"`);
    out.push("}");
    out.push("");
  }

  for (const fn of ast.functions) {
    const functionSymbol = `${workflowSymbol}__function_${fn.name}`;
    for (const comment of fn.comments) {
      out.push(comment);
    }
    out.push(`${functionSymbol}__impl() {`);
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
    out.push(`  jaiph__run_step_passthrough ${functionSymbol} ${functionSymbol}__impl "$@"`);
    out.push("}");
    out.push("");
    // Keep author-friendly call sites working while still namespacing internals.
    out.push(`${fn.name}() {`);
    out.push(`  ${functionSymbol} "$@"`);
    out.push("}");
    out.push("");
  }

  for (const workflow of ast.workflows) {
    for (const comment of workflow.comments) {
      out.push(comment);
    }
    out.push(`${workflowSymbol}__workflow_${workflow.name}__impl() {`);
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
          out.push(`  jaiph__prompt "$@" <<${delimiter}`);
          for (const line of promptText.split("\n")) {
            out.push(line);
          }
          out.push(delimiter);
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
    out.push("}");
    out.push("");
    out.push(`${workflowSymbol}__workflow_${workflow.name}() {`);
    out.push(
      `  jaiph__run_step ${workflowSymbol}__workflow_${workflow.name} ${workflowSymbol}__workflow_${workflow.name}__impl "$@"`,
    );
    out.push("}");
    out.push("");
    }
  }

  return out.join("\n").trimEnd();
}

function resolveImportPath(fromFile: string, importPath: string): string {
  const normalized = importPath.endsWith(".jph") ? importPath : `${importPath}.jph`;
  return resolve(dirname(fromFile), normalized);
}

function validateReferences(ast: jaiphModule): void {
  const localRules = new Set(ast.rules.map((r) => r.name));
  const localWorkflows = new Set(ast.workflows.map((w) => w.name));
  const importsByAlias = new Map<string, string>();
  const importedAstCache = new Map<string, jaiphModule>();

  for (const imp of ast.imports) {
    if (importsByAlias.has(imp.alias)) {
      throw jaiphError(
        ast.filePath,
        imp.loc.line,
        imp.loc.col,
        "E_VALIDATE",
        `duplicate import alias "${imp.alias}"`,
      );
    }
    const resolved = resolveImportPath(ast.filePath, imp.path);
    importsByAlias.set(imp.alias, resolved);
    if (!existsSync(resolved)) {
      throw jaiphError(
        ast.filePath,
        imp.loc.line,
        imp.loc.col,
        "E_IMPORT_NOT_FOUND",
        `import "${imp.alias}" resolves to missing file "${resolved}"`,
      );
    }
    importedAstCache.set(resolved, parsejaiph(readFileSync(resolved, "utf8"), resolved));
  }

  const validateRuleRef = (ref: RuleRefDef): void => {
    const parts = ref.value.split(".");
    if (parts.length === 1) {
      if (!localRules.has(parts[0])) {
        throw jaiphError(
          ast.filePath,
          ref.loc.line,
          ref.loc.col,
          "E_VALIDATE",
          `unknown local rule reference "${ref.value}"`,
        );
      }
      return;
    }

    if (parts.length !== 2) {
      throw jaiphError(
        ast.filePath,
        ref.loc.line,
        ref.loc.col,
        "E_VALIDATE",
        `invalid rule reference "${ref.value}"`,
      );
    }

    const [alias, importedRule] = parts;
    const importedFile = importsByAlias.get(alias);
    if (!importedFile) {
      throw jaiphError(
        ast.filePath,
        ref.loc.line,
        ref.loc.col,
        "E_VALIDATE",
        `unknown import alias "${alias}" for rule reference "${ref.value}"`,
      );
    }
    const importedAst = importedAstCache.get(importedFile)!;
    const importedRules = new Set(importedAst.rules.map((r) => r.name));
    if (!importedRules.has(importedRule)) {
      throw jaiphError(
        ast.filePath,
        ref.loc.line,
        ref.loc.col,
        "E_VALIDATE",
        `imported rule "${ref.value}" does not exist`,
      );
    }
  };

  const validateWorkflowRef = (ref: WorkflowRefDef): void => {
    const parts = ref.value.split(".");
    if (parts.length === 1) {
      if (!localWorkflows.has(parts[0])) {
        throw jaiphError(
          ast.filePath,
          ref.loc.line,
          ref.loc.col,
          "E_VALIDATE",
          `unknown local workflow reference "${ref.value}"`,
        );
      }
      return;
    }

    if (parts.length !== 2) {
      throw jaiphError(
        ast.filePath,
        ref.loc.line,
        ref.loc.col,
        "E_VALIDATE",
        `invalid workflow reference "${ref.value}"`,
      );
    }

    const [alias, importedWorkflow] = parts;
    const importedFile = importsByAlias.get(alias);
    if (!importedFile) {
      throw jaiphError(
        ast.filePath,
        ref.loc.line,
        ref.loc.col,
        "E_VALIDATE",
        `unknown import alias "${alias}" for workflow reference "${ref.value}"`,
      );
    }
    const importedAst = importedAstCache.get(importedFile)!;
    const importedWorkflows = new Set(importedAst.workflows.map((w) => w.name));
    if (!importedWorkflows.has(importedWorkflow)) {
      throw jaiphError(
        ast.filePath,
        ref.loc.line,
        ref.loc.col,
        "E_VALIDATE",
        `imported workflow "${ref.value}" does not exist`,
      );
    }
  };

  for (const workflow of ast.workflows) {
    for (const step of workflow.steps) {
      if (step.type === "ensure") {
        validateRuleRef(step.ref);
      } else if (step.type === "run") {
        validateWorkflowRef(step.workflow);
      } else if (step.type === "if_not_ensure_then_run") {
        validateRuleRef(step.ensureRef);
        validateWorkflowRef(step.runWorkflow);
      } else if (step.type === "if_not_ensure_then_shell") {
        validateRuleRef(step.ensureRef);
      }
    }
  }
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function walkjhFiles(inputPath: string): string[] {
  const s = statSync(inputPath);
  if (s.isFile()) {
    return extname(inputPath) === ".jph" ? [inputPath] : [];
  }

  const files: string[] = [];
  const stack = [inputPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && extname(entry.name) === ".jph") {
        files.push(full);
      }
    }
  }
  files.sort();
  return files;
}

export function build(inputPath: string, targetDir?: string): CompileResult[] {
  const absInput = resolve(inputPath);
  const inputStat = statSync(absInput);
  const rootDir = inputStat.isDirectory() ? absInput : dirname(absInput);
  const outRoot = resolve(targetDir ?? rootDir);
  ensureDir(outRoot);

  const files = walkjhFiles(rootDir);
  const entrypointFile = inputStat.isFile() ? absInput : null;
  const results: CompileResult[] = [];
  for (const file of files) {
    const bash = transpileFile(file, rootDir);
    const rel = relative(rootDir, file).replace(/\.jph$/, ".sh");
    const outPath = join(outRoot, rel);
    ensureDir(dirname(outPath));
    writeFileSync(outPath, bash, "utf8");
    if (entrypointFile === null || file === entrypointFile) {
      results.push({ outputPath: outPath, bash });
    }
  }

  return results;
}
