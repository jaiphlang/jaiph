import { jaiphError } from "../errors";
import type { jaiphModule, WorkflowStepDef } from "../types";
import type { SubstitutionValidateEnv } from "./validate-substitution";
import {
  validateManagedWorkflowShell,
  validateNoJaiphCommandSubstitution,
} from "./validate-substitution";
import { classifyJaiphShellRefToken } from "./shell-jaiph-guard";
import type { RefResolutionContext, RefTargetKind } from "./validate-ref-resolution";
import {
  BARE_SEND_REF_MSG,
  lookupKind,
  RULE_REF_EXPECT,
  RUN_IN_RULE_REF_EXPECT,
  RUN_TARGET_REF_EXPECT,
  validateRef,
  WORKFLOW_REF_EXPECT,
} from "./validate-ref-resolution";

export interface ValidateContext {
  resolveImportPath: (fromFile: string, importPath: string) => string;
  existsSync: (path: string) => boolean;
  readFile: (path: string) => string;
  parse: (content: string, filePath: string) => jaiphModule;
}

export function validateReferences(ast: jaiphModule, ctx: ValidateContext): void {
  const localChannels = new Set(ast.channels.map((c) => c.name));
  const localRules = new Set(ast.rules.map((r) => r.name));
  const localWorkflows = new Set(ast.workflows.map((w) => w.name));
  const localScripts = new Set(ast.scripts.map((s) => s.name));
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

  const refCtx: RefResolutionContext = {
    importsByAlias,
    importedAstCache,
    localRules,
    localWorkflows,
    localScripts,
  };

  const expectRuleRef = { mode: "expect" as const, expect: RULE_REF_EXPECT };
  const expectWorkflowRef = { mode: "expect" as const, expect: WORKFLOW_REF_EXPECT };
  const expectRunInRuleRef = { mode: "expect" as const, expect: RUN_IN_RULE_REF_EXPECT };
  const expectRunTargetRef = { mode: "expect" as const, expect: RUN_TARGET_REF_EXPECT };

  const lookupImportedKind = (alias: string, name: string): RefTargetKind | undefined => {
    const importedFile = importsByAlias.get(alias);
    if (!importedFile) return undefined;
    const importedAst = importedAstCache.get(importedFile)!;
    return lookupKind(importedAst, name);
  };

  const bareSendRefSpec = {
    mode: "bare_send_rhs" as const,
    bareSend: BARE_SEND_REF_MSG,
    lookupImportedKind,
  };

  const makeSubEnv = (loc: { line: number; col: number }): SubstitutionValidateEnv => ({
    filePath: ast.filePath,
    loc,
    localRules,
    localWorkflows,
    localScripts,
    importsByAlias,
    lookupImported: lookupImportedKind,
  });

  for (const sc of ast.scripts) {
    const env = makeSubEnv(sc.loc);
    for (const cmd of sc.commands) {
      const t = cmd.trim();
      if (!t || t.startsWith("#")) continue;
      if (/^(run|ensure)\s/.test(t)) {
        throw jaiphError(
          ast.filePath,
          sc.loc.line,
          sc.loc.col,
          "E_VALIDATE",
          "script body cannot use run or ensure (move orchestration to a workflow)",
        );
      }
      if (/^\s*config\s*\{/.test(t)) {
        throw jaiphError(
          ast.filePath,
          sc.loc.line,
          sc.loc.col,
          "E_VALIDATE",
          "script body cannot contain config blocks",
        );
      }
      if (/^\s*(export\s+)?workflow\s/.test(t)) {
        throw jaiphError(
          ast.filePath,
          sc.loc.line,
          sc.loc.col,
          "E_VALIDATE",
          "script body cannot declare workflows",
        );
      }
      if (/^\s*(export\s+)?rule\s/.test(t)) {
        throw jaiphError(
          ast.filePath,
          sc.loc.line,
          sc.loc.col,
          "E_VALIDATE",
          "script body cannot declare rules",
        );
      }
      if (/^\s*script\s/.test(t)) {
        throw jaiphError(
          ast.filePath,
          sc.loc.line,
          sc.loc.col,
          "E_VALIDATE",
          "script body cannot declare nested scripts",
        );
      }
      if (/^[A-Za-z_][A-Za-z0-9_.]*\s+->\s+/.test(t)) {
        throw jaiphError(
          ast.filePath,
          sc.loc.line,
          sc.loc.col,
          "E_VALIDATE",
          "script body cannot declare channel routes (->)",
        );
      }
      validateNoJaiphCommandSubstitution(cmd, env);
      // Detect cross-script calls: a script body must not invoke another Jaiph script.
      const leadWord = t.match(/^([A-Za-z_][A-Za-z0-9_.]*)/)?.[1];
      if (leadWord && classifyJaiphShellRefToken(leadWord, env) === "script" && leadWord !== sc.name) {
        throw jaiphError(
          ast.filePath,
          sc.loc.line,
          sc.loc.col,
          "E_VALIDATE",
          `scripts cannot call other Jaiph scripts; use a shared library or compose in a workflow`,
        );
      }
    }
  }

  for (const rule of ast.rules) {
    const validateRuleStep = (s: WorkflowStepDef): void => {
      if (s.type === "prompt" || s.type === "send" || s.type === "wait") {
        throw jaiphError(
          ast.filePath,
          s.loc.line,
          s.loc.col,
          "E_VALIDATE",
          `${s.type} is not allowed in rules`,
        );
      }
      if (s.type === "comment") {
        return;
      }
      if (s.type === "ensure") {
        validateRef(s.ref, ast, refCtx, expectRuleRef);
        if (s.recover) {
          throw jaiphError(
            ast.filePath,
            s.ref.loc.line,
            s.ref.loc.col,
            "E_VALIDATE",
            "ensure ... recover is not allowed in rules",
          );
        }
        return;
      }
      if (s.type === "run") {
        validateRef(s.workflow, ast, refCtx, expectRunInRuleRef);
        return;
      }
      if (s.type === "if") {
        if (s.condition.kind === "ensure") {
          validateRef(s.condition.ref, ast, refCtx, expectRuleRef);
        } else {
          validateRef(s.condition.ref, ast, refCtx, expectRunInRuleRef);
        }
        for (const ts of s.thenSteps) validateRuleStep(ts);
        if (s.elseIfBranches) {
          for (const br of s.elseIfBranches) {
            if (br.condition.kind === "ensure") {
              validateRef(br.condition.ref, ast, refCtx, expectRuleRef);
            } else {
              validateRef(br.condition.ref, ast, refCtx, expectRunInRuleRef);
            }
            for (const ts of br.thenSteps) validateRuleStep(ts);
          }
        }
        if (s.elseSteps) {
          for (const es of s.elseSteps) validateRuleStep(es);
        }
        return;
      }
      if (s.type === "fail" || s.type === "log" || s.type === "logerr" || s.type === "return") {
        return;
      }
      if (s.type === "const") {
        const v = s.value;
        if (v.kind === "run_capture") {
          validateRef(v.ref, ast, refCtx, expectRunInRuleRef);
        } else if (v.kind === "ensure_capture") {
          validateRef(v.ref, ast, refCtx, expectRuleRef);
        } else if (v.kind === "prompt_capture") {
          throw jaiphError(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", "const ... = prompt is not allowed in rules");
        }
        return;
      }
      if (s.type === "shell") {
        validateManagedWorkflowShell(s.command, makeSubEnv(s.loc));
        return;
      }
      const _never: never = s;
      return _never;
    };
    for (const st of rule.steps) {
      validateRuleStep(st);
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
      if (s.type === "comment") {
        return;
      }
      if (s.type === "send") {
        validateChannelRef(s.channel, s.loc);
        if (s.rhs.kind === "run") {
          validateRef(s.rhs.ref, ast, refCtx, expectRunTargetRef);
        } else if (s.rhs.kind === "bare_ref") {
          validateRef(s.rhs.ref, ast, refCtx, bareSendRefSpec);
        } else if (s.rhs.kind === "shell") {
          validateManagedWorkflowShell(
            s.rhs.command,
            makeSubEnv({ line: s.rhs.loc.line, col: s.rhs.loc.col }),
          );
        }
        return;
      }
      if (s.type === "ensure") {
        validateRef(s.ref, ast, refCtx, expectRuleRef);
        if (s.recover) {
          const steps = "single" in s.recover ? [s.recover.single] : s.recover.block;
          for (const r of steps) validateStep(r);
        }
        return;
      }
      if (s.type === "run") {
        validateRef(s.workflow, ast, refCtx, expectRunTargetRef);
        return;
      }
      if (s.type === "if") {
        if (s.condition.kind === "ensure") {
          validateRef(s.condition.ref, ast, refCtx, expectRuleRef);
        } else {
          validateRef(s.condition.ref, ast, refCtx, expectRunTargetRef);
        }
        for (const ts of s.thenSteps) validateStep(ts);
        if (s.elseIfBranches) {
          for (const br of s.elseIfBranches) {
            if (br.condition.kind === "ensure") {
              validateRef(br.condition.ref, ast, refCtx, expectRuleRef);
            } else {
              validateRef(br.condition.ref, ast, refCtx, expectRunTargetRef);
            }
            for (const ts of br.thenSteps) validateStep(ts);
          }
        }
        if (s.elseSteps) {
          for (const es of s.elseSteps) validateStep(es);
        }
        return;
      }
      if (s.type === "prompt" || s.type === "log" || s.type === "logerr" || s.type === "return") {
        return;
      }
      if (s.type === "fail" || s.type === "wait") {
        return;
      }
      if (s.type === "const") {
        const v = s.value;
        if (v.kind === "run_capture") {
          validateRef(v.ref, ast, refCtx, expectRunTargetRef);
        } else if (v.kind === "ensure_capture") {
          validateRef(v.ref, ast, refCtx, expectRuleRef);
        }
        return;
      }
      if (s.type === "shell") {
        validateManagedWorkflowShell(s.command, makeSubEnv(s.loc));
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
          validateRef(wfRef, ast, refCtx, expectWorkflowRef);
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
