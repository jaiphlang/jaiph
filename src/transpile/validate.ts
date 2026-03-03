import { jaiphError } from "../errors";
import type { jaiphModule, RuleRefDef, WorkflowRefDef } from "../types";

export interface ValidateContext {
  resolveImportPath: (fromFile: string, importPath: string) => string;
  existsSync: (path: string) => boolean;
  readFile: (path: string) => string;
  parse: (content: string, filePath: string) => jaiphModule;
}

export function validateReferences(ast: jaiphModule, ctx: ValidateContext): void {
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
    const resolved = ctx.resolveImportPath(ast.filePath, imp.path);
    importsByAlias.set(imp.alias, resolved);
    if (!ctx.existsSync(resolved)) {
      throw jaiphError(
        ast.filePath,
        imp.loc.line,
        imp.loc.col,
        "E_IMPORT_NOT_FOUND",
        `import "${imp.alias}" resolves to missing file "${resolved}"`,
      );
    }
    importedAstCache.set(resolved, ctx.parse(ctx.readFile(resolved), resolved));
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

export function validateTestReferences(ast: jaiphModule, ctx: ValidateContext): void {
  if (!ast.tests || ast.tests.length === 0) return;
  const importsByAlias = new Map<string, string>();
  const importedAstCache = new Map<string, jaiphModule>();
  for (const imp of ast.imports) {
    const resolved = ctx.resolveImportPath(ast.filePath, imp.path);
    if (!ctx.existsSync(resolved)) {
      throw jaiphError(
        ast.filePath,
        imp.loc.line,
        imp.loc.col,
        "E_IMPORT_NOT_FOUND",
        `import "${imp.alias}" resolves to missing file "${resolved}"`,
      );
    }
    importsByAlias.set(imp.alias, resolved);
    importedAstCache.set(resolved, ctx.parse(ctx.readFile(resolved), resolved));
  }
  for (const block of ast.tests) {
    for (const step of block.steps) {
      if (step.type !== "test_run_workflow") continue;
      const ref = step.workflowRef;
      const parts = ref.split(".");
      if (parts.length !== 2) {
        throw jaiphError(
          ast.filePath,
          step.loc.line,
          step.loc.col,
          "E_VALIDATE",
          `test workflow reference must be <alias>.<workflow>, got "${ref}"`,
        );
      }
      const [alias, wfName] = parts;
      const resolved = importsByAlias.get(alias);
      if (!resolved) {
        throw jaiphError(
          ast.filePath,
          step.loc.line,
          step.loc.col,
          "E_VALIDATE",
          `unknown import alias "${alias}" in test`,
        );
      }
      const importedAst = importedAstCache.get(resolved)!;
      const hasWorkflow = importedAst.workflows.some((w) => w.name === wfName);
      if (!hasWorkflow) {
        throw jaiphError(
          ast.filePath,
          step.loc.line,
          step.loc.col,
          "E_VALIDATE",
          `imported module "${alias}" has no workflow "${wfName}"`,
        );
      }
    }
  }
}
