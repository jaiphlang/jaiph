import { jaiphError } from "../errors";
import type { jaiphModule, RuleRefDef, WorkflowRefDef, WorkflowStepDef } from "../types";

export interface ValidateContext {
  resolveImportPath: (fromFile: string, importPath: string) => string;
  existsSync: (path: string) => boolean;
  readFile: (path: string) => string;
  parse: (content: string, filePath: string) => jaiphModule;
}

/** Look up which kind a name belongs to in a module: "rule", "workflow", "function", or undefined. */
function lookupKind(mod: jaiphModule, name: string): "rule" | "workflow" | "function" | undefined {
  if (mod.rules.some((r) => r.name === name)) return "rule";
  if (mod.workflows.some((w) => w.name === name)) return "workflow";
  if (mod.functions.some((f) => f.name === name)) return "function";
  return undefined;
}

export function validateReferences(ast: jaiphModule, ctx: ValidateContext): void {
  const localRules = new Set(ast.rules.map((r) => r.name));
  const localWorkflows = new Set(ast.workflows.map((w) => w.name));
  const localFunctions = new Set(ast.functions.map((f) => f.name));
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
      const name = parts[0];
      if (!localRules.has(name)) {
        if (localWorkflows.has(name)) {
          throw jaiphError(
            ast.filePath,
            ref.loc.line,
            ref.loc.col,
            "E_VALIDATE",
            `workflow "${name}" must be called with run`,
          );
        }
        if (localFunctions.has(name)) {
          throw jaiphError(
            ast.filePath,
            ref.loc.line,
            ref.loc.col,
            "E_VALIDATE",
            `function "${name}" cannot be called with ensure`,
          );
        }
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
      const kind = lookupKind(importedAst, importedRule);
      if (kind === "workflow") {
        throw jaiphError(
          ast.filePath,
          ref.loc.line,
          ref.loc.col,
          "E_VALIDATE",
          `workflow "${ref.value}" must be called with run`,
        );
      }
      if (kind === "function") {
        throw jaiphError(
          ast.filePath,
          ref.loc.line,
          ref.loc.col,
          "E_VALIDATE",
          `function "${ref.value}" cannot be called with ensure`,
        );
      }
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
      const name = parts[0];
      if (!localWorkflows.has(name)) {
        if (localRules.has(name)) {
          throw jaiphError(
            ast.filePath,
            ref.loc.line,
            ref.loc.col,
            "E_VALIDATE",
            `rule "${name}" must be called with ensure`,
          );
        }
        if (localFunctions.has(name)) {
          throw jaiphError(
            ast.filePath,
            ref.loc.line,
            ref.loc.col,
            "E_VALIDATE",
            `function "${name}" cannot be called with run`,
          );
        }
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
      const kind = lookupKind(importedAst, importedWorkflow);
      if (kind === "rule") {
        throw jaiphError(
          ast.filePath,
          ref.loc.line,
          ref.loc.col,
          "E_VALIDATE",
          `rule "${ref.value}" must be called with ensure`,
        );
      }
      if (kind === "function") {
        throw jaiphError(
          ast.filePath,
          ref.loc.line,
          ref.loc.col,
          "E_VALIDATE",
          `function "${ref.value}" cannot be called with run`,
        );
      }
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
    const validateStep = (s: WorkflowStepDef): void => {
      if (s.type === "ensure") {
        validateRuleRef(s.ref);
        if (s.recover) {
          const steps = "single" in s.recover ? [s.recover.single] : s.recover.block;
          for (const r of steps) validateStep(r);
        }
      } else if (s.type === "run") {
        validateWorkflowRef(s.workflow);
      } else if (s.type === "if") {
        if (s.condition.kind === "ensure") {
          validateRuleRef(s.condition.ref);
        }
        for (const ts of s.thenSteps) validateStep(ts);
        if (s.elseSteps) {
          for (const es of s.elseSteps) validateStep(es);
        }
      }
      // send steps have no refs to validate (channel is a string identifier)
    };

    // Validate route declarations.
    if (workflow.routes) {
      for (const route of workflow.routes) {
        for (const wfRef of route.workflows) {
          validateWorkflowRef(wfRef);
        }
      }
    }

    for (const step of workflow.steps) {
      if (step.type === "ensure") {
        validateRuleRef(step.ref);
        if (step.recover) {
          const steps = "single" in step.recover ? [step.recover.single] : step.recover.block;
          for (const r of steps) validateStep(r);
        }
      } else if (step.type === "run") {
        validateWorkflowRef(step.workflow);
      } else if (step.type === "if") {
        if (step.condition.kind === "ensure") {
          validateRuleRef(step.condition.ref);
        }
        for (const ts of step.thenSteps) validateStep(ts);
        if (step.elseSteps) {
          for (const es of step.elseSteps) validateStep(es);
        }
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
