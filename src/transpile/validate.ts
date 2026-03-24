import { jaiphError } from "../errors";
import type { jaiphModule, RuleRefDef, WorkflowRefDef, WorkflowStepDef } from "../types";
import type { SubstitutionValidateEnv } from "./validate-substitution";
import {
  validateManagedShellFragment,
  validateNoJaiphCommandSubstitution,
} from "./validate-substitution";

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
  const localChannels = new Set(ast.channels.map((c) => c.name));
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

  const validateRunTargetRef = (ref: WorkflowRefDef): void => {
    const parts = ref.value.split(".");
    if (parts.length === 1) {
      const name = parts[0];
      if (localWorkflows.has(name) || localFunctions.has(name)) {
        return;
      }
      if (localRules.has(name)) {
        throw jaiphError(
          ast.filePath,
          ref.loc.line,
          ref.loc.col,
          "E_VALIDATE",
          `rule "${name}" must be called with ensure, not run`,
        );
      }
      throw jaiphError(
        ast.filePath,
        ref.loc.line,
        ref.loc.col,
        "E_VALIDATE",
        `unknown local workflow or function reference "${ref.value}"`,
      );
    }

    if (parts.length !== 2) {
      throw jaiphError(
        ast.filePath,
        ref.loc.line,
        ref.loc.col,
        "E_VALIDATE",
        `invalid run target reference "${ref.value}"`,
      );
    }

    const [alias, importedName] = parts;
    const importedFile = importsByAlias.get(alias);
    if (!importedFile) {
      throw jaiphError(
        ast.filePath,
        ref.loc.line,
        ref.loc.col,
        "E_VALIDATE",
        `unknown import alias "${alias}" for run target "${ref.value}"`,
      );
    }
    const importedAst = importedAstCache.get(importedFile)!;
    const importedWorkflows = new Set(importedAst.workflows.map((w) => w.name));
    const importedFunctions = new Set(importedAst.functions.map((f) => f.name));
    if (importedWorkflows.has(importedName) || importedFunctions.has(importedName)) {
      return;
    }
    const kind = lookupKind(importedAst, importedName);
    if (kind === "rule") {
      throw jaiphError(
        ast.filePath,
        ref.loc.line,
        ref.loc.col,
        "E_VALIDATE",
        `rule "${ref.value}" must be called with ensure, not run`,
      );
    }
    throw jaiphError(
      ast.filePath,
      ref.loc.line,
      ref.loc.col,
      "E_VALIDATE",
      `imported workflow or function "${ref.value}" does not exist`,
    );
  };

  const lookupImportedKind = (alias: string, name: string): "rule" | "workflow" | "function" | undefined => {
    const importedFile = importsByAlias.get(alias);
    if (!importedFile) return undefined;
    const importedAst = importedAstCache.get(importedFile)!;
    return lookupKind(importedAst, name);
  };

  const makeSubEnv = (loc: { line: number; col: number }): SubstitutionValidateEnv => ({
    filePath: ast.filePath,
    loc,
    localRules,
    localWorkflows,
    localFunctions,
    importsByAlias,
    lookupImported: lookupImportedKind,
  });

  for (const fn of ast.functions) {
    const env = makeSubEnv(fn.loc);
    for (const cmd of fn.commands) {
      const t = cmd.trim();
      if (!t || t.startsWith("#")) continue;
      if (/^(run|ensure)\s/.test(t)) {
        throw jaiphError(
          ast.filePath,
          fn.loc.line,
          fn.loc.col,
          "E_VALIDATE",
          "function body cannot use run or ensure (move orchestration to a workflow)",
        );
      }
      if (/^\s*config\s*\{/.test(t)) {
        throw jaiphError(
          ast.filePath,
          fn.loc.line,
          fn.loc.col,
          "E_VALIDATE",
          "function body cannot contain config blocks",
        );
      }
      if (/^\s*(export\s+)?workflow\s/.test(t)) {
        throw jaiphError(
          ast.filePath,
          fn.loc.line,
          fn.loc.col,
          "E_VALIDATE",
          "function body cannot declare workflows",
        );
      }
      if (/^\s*(export\s+)?rule\s/.test(t)) {
        throw jaiphError(
          ast.filePath,
          fn.loc.line,
          fn.loc.col,
          "E_VALIDATE",
          "function body cannot declare rules",
        );
      }
      if (/^\s*function\s/.test(t)) {
        throw jaiphError(
          ast.filePath,
          fn.loc.line,
          fn.loc.col,
          "E_VALIDATE",
          "function body cannot declare nested functions",
        );
      }
      if (/^[A-Za-z_][A-Za-z0-9_.]*\s+->\s+/.test(t)) {
        throw jaiphError(
          ast.filePath,
          fn.loc.line,
          fn.loc.col,
          "E_VALIDATE",
          "function body cannot declare channel routes (->)",
        );
      }
      validateNoJaiphCommandSubstitution(cmd, env);
    }
  }

  for (const rule of ast.rules) {
    const env = makeSubEnv(rule.loc);
    for (const cmd of rule.commands) {
      const t = cmd.trim();
      if (!t || t.startsWith("#")) continue;
      validateNoJaiphCommandSubstitution(cmd, env);
    }
  }

  const validateChannelRef = (
    channel: string,
    loc: { line: number; col: number },
  ): void => {
    const parts = channel.split(".");
    if (parts.length === 1) {
      if (!localChannels.has(channel)) {
        throw jaiphError(
          ast.filePath,
          loc.line,
          loc.col,
          "E_VALIDATE",
          `Channel "${channel}" is not defined`,
        );
      }
      return;
    }
    if (parts.length !== 2) {
      throw jaiphError(
        ast.filePath,
        loc.line,
        loc.col,
        "E_VALIDATE",
        `Channel "${channel}" is not defined`,
      );
    }
    const [alias, importedChannel] = parts;
    const importedFile = importsByAlias.get(alias);
    if (!importedFile) {
      throw jaiphError(
        ast.filePath,
        loc.line,
        loc.col,
        "E_VALIDATE",
        `Channel "${channel}" is not defined`,
      );
    }
    const importedAst = importedAstCache.get(importedFile)!;
    const importedChannels = new Set(importedAst.channels.map((c) => c.name));
    if (!importedChannels.has(importedChannel)) {
      throw jaiphError(
        ast.filePath,
        loc.line,
        loc.col,
        "E_VALIDATE",
        `Channel "${channel}" is not defined`,
      );
    }
  };

  for (const workflow of ast.workflows) {
    const validateStep = (s: WorkflowStepDef): void => {
      if (s.type === "shell") {
        const env = makeSubEnv(s.loc);
        validateNoJaiphCommandSubstitution(s.command, env);
        for (const rawLine of s.command.split("\n")) {
          const line = rawLine.trim();
          if (!line || line.startsWith("#")) continue;
          validateManagedShellFragment(line, env);
        }
        return;
      }
      if (s.type === "send") {
        validateChannelRef(s.channel, s.loc);
        if (s.command !== "") {
          const env = makeSubEnv(s.loc);
          validateNoJaiphCommandSubstitution(s.command, env);
          validateManagedShellFragment(s.command.trim(), env);
        }
        return;
      }
      if (s.type === "ensure") {
        validateRuleRef(s.ref);
        if (s.recover) {
          const steps = "single" in s.recover ? [s.recover.single] : s.recover.block;
          for (const r of steps) validateStep(r);
        }
        return;
      }
      if (s.type === "run") {
        validateRunTargetRef(s.workflow);
        return;
      }
      if (s.type === "if") {
        if (s.condition.kind === "ensure") {
          validateRuleRef(s.condition.ref);
        } else if (s.condition.kind === "run") {
          validateRunTargetRef(s.condition.ref);
        } else {
          const env = makeSubEnv(workflow.loc);
          validateNoJaiphCommandSubstitution(s.condition.command, env);
          validateManagedShellFragment(s.condition.command.trim(), env);
        }
        for (const ts of s.thenSteps) validateStep(ts);
        if (s.elseSteps) {
          for (const es of s.elseSteps) validateStep(es);
        }
        return;
      }
      if (s.type === "prompt" || s.type === "log" || s.type === "logerr" || s.type === "return") {
        return;
      }
      const _never: never = s;
      return _never;
    };

    // Validate route declarations.
    if (workflow.routes) {
      for (const route of workflow.routes) {
        validateChannelRef(route.channel, route.loc);
        for (const wfRef of route.workflows) {
          validateWorkflowRef(wfRef);
        }
      }
    }

    for (const step of workflow.steps) {
      validateStep(step);
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
