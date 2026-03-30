import { jaiphError } from "../errors";
import type { jaiphModule, WorkflowStepDef } from "../types";
import type { SubstitutionValidateEnv } from "./validate-substitution";
import { validateManagedWorkflowShell } from "./validate-substitution";
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
import {
  validatePromptString,
  validateLogString,
  validateFailString,
  validateReturnString,
  validateJaiphStringContent,
  extractInlineCaptures,
} from "./validate-string";
import { validatePromptStepReturns } from "./validate-prompt-schema";

export interface ValidateContext {
  resolveImportPath: (fromFile: string, importPath: string) => string;
  existsSync: (path: string) => boolean;
  readFile: (path: string) => string;
  parse: (content: string, filePath: string) => jaiphModule;
}

/** Check if args contain unquoted shell redirection operators (>, >>, |, &). */
function hasShellRedirection(args: string): boolean {
  let inQuote = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '"' && (i === 0 || args[i - 1] !== "\\")) {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && (ch === ">" || ch === "|" || ch === "&")) {
      return true;
    }
  }
  return false;
}

function validateNoShellRedirection(
  filePath: string,
  loc: { line: number; col: number },
  keyword: string,
  args: string | undefined,
): void {
  if (!args || !hasShellRedirection(args)) return;
  throw jaiphError(
    filePath,
    loc.line,
    loc.col,
    "E_VALIDATE",
    `shell redirection (>, >>, |, &) is not supported with ${keyword}; use a script block for shell operations`,
  );
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

  const stripDQ = (s: string): string =>
    s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s;

  const validateWorkflowStringCaptures = (content: string, loc: { line: number; col: number }): void => {
    for (const cap of extractInlineCaptures(content)) {
      if (cap.kind === "run") {
        validateNoShellRedirection(ast.filePath, loc, "run", cap.args);
        validateRef({ value: cap.ref, loc }, ast, refCtx, expectRunTargetRef);
      } else {
        validateNoShellRedirection(ast.filePath, loc, "ensure", cap.args);
        validateRef({ value: cap.ref, loc }, ast, refCtx, expectRuleRef);
      }
    }
  };

  const validateRuleStringCaptures = (content: string, loc: { line: number; col: number }): void => {
    for (const cap of extractInlineCaptures(content)) {
      if (cap.kind === "run") {
        validateNoShellRedirection(ast.filePath, loc, "run", cap.args);
        validateRef({ value: cap.ref, loc }, ast, refCtx, expectRunInRuleRef);
      } else {
        validateNoShellRedirection(ast.filePath, loc, "ensure", cap.args);
        validateRef({ value: cap.ref, loc }, ast, refCtx, expectRuleRef);
      }
    }
  };

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
        validateNoShellRedirection(ast.filePath, s.ref.loc, "ensure", s.args);
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
        validateNoShellRedirection(ast.filePath, s.workflow.loc, "run", s.args);
        if (s.async) {
          throw jaiphError(
            ast.filePath,
            s.workflow.loc.line,
            s.workflow.loc.col,
            "E_VALIDATE",
            "run async is not allowed in rules; use it in workflows only",
          );
        }
        validateRef(s.workflow, ast, refCtx, expectRunInRuleRef);
        return;
      }
      if (s.type === "if") {
        validateNoShellRedirection(ast.filePath, s.condition.ref.loc, s.condition.kind, s.condition.args);
        if (s.condition.kind === "ensure") {
          validateRef(s.condition.ref, ast, refCtx, expectRuleRef);
        } else {
          validateRef(s.condition.ref, ast, refCtx, expectRunInRuleRef);
        }
        for (const ts of s.thenSteps) validateRuleStep(ts);
        if (s.elseIfBranches) {
          for (const br of s.elseIfBranches) {
            validateNoShellRedirection(ast.filePath, br.condition.ref.loc, br.condition.kind, br.condition.args);
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
      if (s.type === "fail") {
        validateFailString(s.message, ast.filePath, s.loc.line, s.loc.col);
        validateRuleStringCaptures(stripDQ(s.message), s.loc);
        return;
      }
      if (s.type === "log") {
        validateLogString(s.message, ast.filePath, s.loc.line, s.loc.col, "log");
        validateRuleStringCaptures(s.message, s.loc);
        return;
      }
      if (s.type === "logerr") {
        validateLogString(s.message, ast.filePath, s.loc.line, s.loc.col, "logerr");
        validateRuleStringCaptures(s.message, s.loc);
        return;
      }
      if (s.type === "return") {
        validateReturnString(s.value, ast.filePath, s.loc.line, s.loc.col);
        if (s.value.startsWith('"')) validateRuleStringCaptures(stripDQ(s.value), s.loc);
        return;
      }
      if (s.type === "const") {
        const v = s.value;
        if (v.kind === "run_capture") {
          validateNoShellRedirection(ast.filePath, v.ref.loc, "run", v.args);
          validateRef(v.ref, ast, refCtx, expectRunInRuleRef);
        } else if (v.kind === "ensure_capture") {
          validateNoShellRedirection(ast.filePath, v.ref.loc, "ensure", v.args);
          validateRef(v.ref, ast, refCtx, expectRuleRef);
        } else if (v.kind === "prompt_capture") {
          throw jaiphError(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", "const ... = prompt is not allowed in rules");
        } else if (v.kind === "expr") {
          validateRuleStringCaptures(stripDQ(v.bashRhs), s.loc);
        }
        return;
      }
      if (s.type === "shell") {
        throw jaiphError(
          ast.filePath,
          s.loc.line,
          s.loc.col,
          "E_VALIDATE",
          "inline shell steps are forbidden in rules; use explicit script blocks",
        );
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
          validateNoShellRedirection(ast.filePath, s.rhs.ref.loc, "run", s.rhs.args);
          validateRef(s.rhs.ref, ast, refCtx, expectRunTargetRef);
        } else if (s.rhs.kind === "literal") {
          const inner = s.rhs.token.startsWith('"') && s.rhs.token.endsWith('"')
            ? s.rhs.token.slice(1, -1) : s.rhs.token;
          validateJaiphStringContent(inner, ast.filePath, s.loc.line, s.loc.col, "send");
          validateWorkflowStringCaptures(inner, s.loc);
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
        validateNoShellRedirection(ast.filePath, s.ref.loc, "ensure", s.args);
        validateRef(s.ref, ast, refCtx, expectRuleRef);
        if (s.recover) {
          const steps = "single" in s.recover ? [s.recover.single] : s.recover.block;
          for (const r of steps) validateStep(r);
        }
        return;
      }
      if (s.type === "run") {
        validateNoShellRedirection(ast.filePath, s.workflow.loc, "run", s.args);
        validateRef(s.workflow, ast, refCtx, expectRunTargetRef);
        return;
      }
      if (s.type === "if") {
        validateNoShellRedirection(ast.filePath, s.condition.ref.loc, s.condition.kind, s.condition.args);
        if (s.condition.kind === "ensure") {
          validateRef(s.condition.ref, ast, refCtx, expectRuleRef);
        } else {
          validateRef(s.condition.ref, ast, refCtx, expectRunTargetRef);
        }
        for (const ts of s.thenSteps) validateStep(ts);
        if (s.elseIfBranches) {
          for (const br of s.elseIfBranches) {
            validateNoShellRedirection(ast.filePath, br.condition.ref.loc, br.condition.kind, br.condition.args);
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
      if (s.type === "prompt") {
        validatePromptString(s.raw, ast.filePath, s.loc.line, s.loc.col);
        validatePromptStepReturns(s, ast.filePath);
        validateWorkflowStringCaptures(stripDQ(s.raw), s.loc);
        return;
      }
      if (s.type === "log") {
        validateLogString(s.message, ast.filePath, s.loc.line, s.loc.col, "log");
        validateWorkflowStringCaptures(s.message, s.loc);
        return;
      }
      if (s.type === "logerr") {
        validateLogString(s.message, ast.filePath, s.loc.line, s.loc.col, "logerr");
        validateWorkflowStringCaptures(s.message, s.loc);
        return;
      }
      if (s.type === "return") {
        validateReturnString(s.value, ast.filePath, s.loc.line, s.loc.col);
        if (s.value.startsWith('"')) validateWorkflowStringCaptures(stripDQ(s.value), s.loc);
        return;
      }
      if (s.type === "fail") {
        validateFailString(s.message, ast.filePath, s.loc.line, s.loc.col);
        validateWorkflowStringCaptures(stripDQ(s.message), s.loc);
        return;
      }
      if (s.type === "wait") {
        return;
      }
      if (s.type === "const") {
        const v = s.value;
        if (v.kind === "run_capture") {
          validateNoShellRedirection(ast.filePath, v.ref.loc, "run", v.args);
          validateRef(v.ref, ast, refCtx, expectRunTargetRef);
        } else if (v.kind === "ensure_capture") {
          validateNoShellRedirection(ast.filePath, v.ref.loc, "ensure", v.args);
          validateRef(v.ref, ast, refCtx, expectRuleRef);
        } else if (v.kind === "expr") {
          validateWorkflowStringCaptures(stripDQ(v.bashRhs), s.loc);
        }
        return;
      }
      if (s.type === "shell") {
        throw jaiphError(
          ast.filePath,
          s.loc.line,
          s.loc.col,
          "E_VALIDATE",
          "inline shell steps are forbidden in workflows; use explicit script blocks",
        );
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

