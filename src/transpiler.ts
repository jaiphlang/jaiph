import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import { jaiphError } from "./errors";
import { parsejaiph } from "./parser";
import { CompileResult, jaiphModule, RuleRefDef, WorkflowRefDef } from "./types";

const JAIPH_STDLIB_SH = `#!/usr/bin/env bash
# Standard helpers shared by transpiled Jaiph modules.

jaiph__version() {
  echo "jaiph 0.0.1"
}

jaiph__die() {
  local message="$1"
  echo "jai: $message" >&2
  return 1
}

jaiph__prompt() {
  cursor-agent "$@"
}

jaiph__new_run_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr "[:upper:]" "[:lower:]"
    return 0
  fi
  printf "%s-%s-%s" "$$" "$RANDOM" "$(date +%s)"
}

jaiph__sanitize_name() {
  local raw="$1"
  raw="\${raw//[^[:alnum:]_.-]/_}"
  printf "%s" "$raw"
}

jaiph__init_run_tracking() {
  if [[ -n "\${JAIPH_RUN_DIR:-}" ]]; then
    return 0
  fi
  local started_at run_id
  started_at="$(date -u +"%Y%m%dT%H%M%SZ")"
  run_id="$(jaiph__new_run_id)"
  JAIPH_RUN_DIR="$PWD/\${started_at}-\${run_id}"
  JAIPH_PRECEDING_FILES=""
  mkdir -p "$JAIPH_RUN_DIR"
  export JAIPH_RUN_DIR JAIPH_PRECEDING_FILES
}

jaiph__track_output_files() {
  local out_file="$1"
  local err_file="$2"
  if [[ -z "$JAIPH_PRECEDING_FILES" ]]; then
    JAIPH_PRECEDING_FILES="\${out_file},\${err_file}"
  else
    JAIPH_PRECEDING_FILES="\${JAIPH_PRECEDING_FILES},\${out_file},\${err_file}"
  fi
  export JAIPH_PRECEDING_FILES
}

jaiph__run_step() {
  local func_name="$1"
  shift || true
  if [[ -z "$func_name" ]]; then
    jaiph__die "jaiph__run_step requires a function name"
    return 1
  fi
  if [[ "$#" -eq 0 ]]; then
    jaiph__die "jaiph__run_step requires a command to execute"
    return 1
  fi
  jaiph__init_run_tracking || return 1
  local step_started_at safe_name out_file err_file status
  step_started_at="$(date -u +"%Y%m%dT%H%M%SZ")"
  safe_name="$(jaiph__sanitize_name "$func_name")"
  out_file="$JAIPH_RUN_DIR/\${step_started_at}-\${safe_name}.out"
  err_file="$JAIPH_RUN_DIR/\${step_started_at}-\${safe_name}.err"
  "$@" >"$out_file" 2>"$err_file"
  status=$?
  jaiph__track_output_files "$out_file" "$err_file"
  if [[ -s "$out_file" ]]; then
    cat "$out_file"
  fi
  if [[ -s "$err_file" ]]; then
    cat "$err_file" >&2
  fi
  return "$status"
}

# Wrapper to execute functions in a read-only filesystem sandbox.
jaiph__execute_readonly() {
  local func_name="$1"
  shift || true
  if [[ -z "$func_name" ]]; then
    jaiph__die "jaiph__execute_readonly requires a function name"
    return 1
  fi
  if ! declare -f "$func_name" >/dev/null 2>&1; then
    jaiph__die "unknown function: $func_name"
    return 1
  fi
  if ! command -v unshare >/dev/null 2>&1 || ! command -v sudo >/dev/null 2>&1; then
    # Best-effort fallback for environments without Linux mount namespace tooling (e.g. macOS).
    "$func_name" "$@"
    return $?
  fi

  export -f "$func_name"
  export -f jaiph__die
  export -f jaiph__prompt
  sudo env JAIPH_PRECEDING_FILES="$JAIPH_PRECEDING_FILES" unshare -m bash -c '
    mount --make-rprivate /
    mount -o remount,ro /
    func_name="$1"
    shift || true
    "$func_name" "$@"
  ' _ "$func_name" "$@"
}
`;

function toWorkflowSymbol(inputFile: string, rootDir: string): string {
  const rel = relative(rootDir, inputFile);
  const parsed = parse(rel);
  const dirParts = parsed.dir ? parsed.dir.split(sep).filter(Boolean) : [];
  return [...dirParts, parsed.name].join("__");
}

export function workflowSymbolForFile(inputFile: string, rootDir: string): string {
  return toWorkflowSymbol(resolve(inputFile), resolve(rootDir));
}

function toStdlibSourcePath(inputFile: string, rootDir: string): string {
  const relInput = relative(rootDir, inputFile);
  const dir = dirname(relInput);
  if (dir === ".") {
    return "jaiph_stdlib.sh";
  }
  const segments = dir.split(sep).filter(Boolean).length;
  const up = new Array(segments).fill("..").join("/");
  return `${up}/jaiph_stdlib.sh`;
}

function toImportSource(importPath: string, inputFile: string, rootDir: string): string {
  const importedFile = resolveImportPath(inputFile, importPath);
  const importedRel = relative(rootDir, importedFile).replace(/\.(jph|jh|jrh)$/, ".sh");
  const currentRel = relative(rootDir, inputFile).replace(/\.(jph|jh|jrh)$/, ".sh");
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
  out.push("set -euo pipefail");
  out.push(`source "$(dirname "\${BASH_SOURCE[0]}")/${toStdlibSourcePath(inputFile, rootDir)}"`);
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
    if (rule.commands.length === 0) {
      out.push("  :");
    } else {
      for (const cmd of rule.commands) {
        out.push(`  ${cmd}`);
      }
    }
    out.push("}");
    out.push("");
    out.push(`${ruleSymbol}() {`);
    out.push(`  jaiph__run_step ${ruleSymbol} jaiph__execute_readonly ${ruleSymbol}__impl "$@"`);
    out.push("}");
    out.push("");
  }

  for (const workflow of ast.workflows) {
    for (const comment of workflow.comments) {
      out.push(comment);
    }
    out.push(`${workflowSymbol}__workflow_${workflow.name}__impl() {`);
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
          const promptLines = step.raw.split("\n");
          out.push(`  jaiph__prompt ${promptLines[0]}`);
          for (let lineNo = 1; lineNo < promptLines.length; lineNo += 1) {
            out.push(promptLines[lineNo]);
          }
          continue;
        }
        if (step.type === "shell") {
          out.push(`  ${step.command}`);
          continue;
        }
        out.push(
          `  if ! ${transpileRuleRef(step.ensureRef, workflowSymbol, importedWorkflowSymbols)}; then`,
        );
        out.push(`    ${transpileWorkflowRef(step.runWorkflow, workflowSymbol, importedWorkflowSymbols)}`);
        out.push("  fi");
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

  return out.join("\n").trimEnd();
}

function resolveImportPath(fromFile: string, importPath: string): string {
  const normalized =
    importPath.endsWith(".jph") || importPath.endsWith(".jh") || importPath.endsWith(".jrh")
      ? importPath
      : `${importPath}.jph`;
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
    return [".jph", ".jh", ".jrh"].includes(extname(inputPath)) ? [inputPath] : [];
  }

  const files: string[] = [];
  const stack = [inputPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && [".jph", ".jh", ".jrh"].includes(extname(entry.name))) {
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

  const files = walkjhFiles(absInput);
  if (files.length > 0) {
    writeFileSync(join(outRoot, "jaiph_stdlib.sh"), JAIPH_STDLIB_SH, "utf8");
  }
  const results: CompileResult[] = [];
  for (const file of files) {
    const bash = transpileFile(file, rootDir);
    const rel = relative(rootDir, file).replace(/\.(jph|jh|jrh)$/, ".sh");
    const outPath = join(outRoot, rel);
    ensureDir(dirname(outPath));
    writeFileSync(outPath, bash, "utf8");
    results.push({ outputPath: outPath, bash });
  }

  return results;
}
