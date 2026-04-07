import { jaiphError } from "../errors";
import type { jaiphModule, MatchExprDef, WorkflowStepDef } from "../types";
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
  validateSimpleInterpolationIdentifiers,
  extractInlineCaptures,
  extractDotFieldRefs,
} from "./validate-string";
import { validatePromptReturnsSchema, validatePromptStepReturns } from "./validate-prompt-schema";

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

function validateMatchExpr(filePath: string, expr: MatchExprDef): void {
  if (expr.arms.length === 0) {
    throw jaiphError(filePath, expr.loc.line, expr.loc.col, "E_VALIDATE", "match must have at least one arm");
  }
  let wildcardCount = 0;
  for (const arm of expr.arms) {
    if (arm.pattern.kind === "wildcard") {
      wildcardCount += 1;
    }
    if (arm.pattern.kind === "regex") {
      try {
        new RegExp(arm.pattern.source);
      } catch {
        throw jaiphError(
          filePath,
          expr.loc.line,
          expr.loc.col,
          "E_VALIDATE",
          `invalid regex in match pattern: /${arm.pattern.source}/`,
        );
      }
    }
  }
  if (wildcardCount === 0) {
    throw jaiphError(filePath, expr.loc.line, expr.loc.col, "E_VALIDATE", "match must have exactly one wildcard (_) arm");
  }
  if (wildcardCount > 1) {
    throw jaiphError(filePath, expr.loc.line, expr.loc.col, "E_VALIDATE", "match must have exactly one wildcard (_) arm, found multiple");
  }
}

/** Collect all variable names defined in a step list (consts, captures, params). Flat walk — includes nested if/else blocks. */
function collectKnownVars(steps: WorkflowStepDef[], envDecls?: { name: string }[], params?: string[]): Set<string> {
  const vars = new Set<string>();
  if (envDecls) {
    for (const d of envDecls) vars.add(d.name);
  }
  for (const p of params ?? []) {
    vars.add(p);
  }
  const walk = (ss: WorkflowStepDef[]): void => {
    for (const s of ss) {
      if (s.type === "const") {
        vars.add(s.name);
      }
      if ((s.type === "ensure" || s.type === "run" || s.type === "prompt" || s.type === "run_inline_script") && s.captureName) {
        vars.add(s.captureName);
      }
      if (s.type === "if") {
        walk(s.thenSteps);
        if (s.elseIfBranches) for (const br of s.elseIfBranches) walk(br.thenSteps);
        if (s.elseSteps) walk(s.elseSteps);
      }
      if (s.type === "ensure" && s.recover) {
        const recoverSteps = "single" in s.recover ? [s.recover.single] : s.recover.block;
        walk(recoverSteps);
      }
    }
  };
  walk(steps);
  return vars;
}

/** Count the number of call arguments from a space-separated args string (respects quotes). */
function countCallArgs(argsStr: string | undefined): number {
  if (!argsStr || !argsStr.trim()) return 0;
  let count = 0;
  let inQuote: string | null = null;
  let hasContent = false;
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inQuote) {
      hasContent = true;
      if (ch === inQuote && argsStr[i - 1] !== "\\") inQuote = null;
    } else if (ch === '"' || ch === "'") {
      hasContent = true;
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (hasContent) { count++; hasContent = false; }
    } else {
      hasContent = true;
    }
  }
  if (hasContent) count++;
  return count;
}

/** Look up declared params for a workflow or rule target. Returns undefined if target has no declared params. */
function lookupCalleeParams(
  ref: string,
  targetKind: "workflow" | "rule",
  ast: jaiphModule,
  refCtx: RefResolutionContext,
): string[] | undefined {
  const parts = ref.split(".");
  if (parts.length === 1) {
    const name = parts[0];
    if (targetKind === "workflow") {
      const wf = ast.workflows.find((w) => w.name === name);
      return wf?.params;
    }
    const rl = ast.rules.find((r) => r.name === name);
    return rl?.params;
  }
  if (parts.length === 2) {
    const [alias, name] = parts;
    const importedFile = refCtx.importsByAlias.get(alias);
    if (!importedFile) return undefined;
    const importedAst = refCtx.importedAstCache.get(importedFile);
    if (!importedAst) return undefined;
    if (targetKind === "workflow") {
      const wf = importedAst.workflows.find((w) => w.name === name);
      return wf?.params;
    }
    const rl = importedAst.rules.find((r) => r.name === name);
    return rl?.params;
  }
  return undefined;
}

/** Validate arity: if the callee declares named params, the call must supply exactly that many args. */
function validateArity(
  filePath: string,
  loc: { line: number; col: number },
  ref: string,
  args: string | undefined,
  targetKind: "workflow" | "rule",
  ast: jaiphModule,
  refCtx: RefResolutionContext,
): void {
  const params = lookupCalleeParams(ref, targetKind, ast, refCtx);
  if (params === undefined) return; // callee not a workflow/rule in scope — skip
  const argCount = countCallArgs(args);
  if (argCount !== params.length) {
    throw jaiphError(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `${targetKind} "${ref}" expects ${params.length} argument(s) (${params.join(", ") || "none"}), but got ${argCount}`,
    );
  }
}

/**
 * Reject any call argument that is exactly `"${identifier}"` — the caller should use a bare identifier instead
 * (e.g. `run foo(name)` not `run foo("${name}")`). Bare identifiers in the spaced args string appear as
 * unquoted `${name}`; only the quoted form `"${name}"` is rejected here.
 */
function validateNoQuotedSingleInterpolation(
  filePath: string,
  loc: { line: number; col: number },
  args: string | undefined,
): void {
  if (!args) return;
  // Walk space-separated tokens respecting quotes; reject any that match exactly "${identifier}"
  let i = 0;
  while (i < args.length) {
    while (i < args.length && (args[i] === " " || args[i] === "\t")) i++;
    if (i >= args.length) break;
    if (args[i] === '"') {
      let j = i + 1;
      while (j < args.length && !(args[j] === '"' && args[j - 1] !== "\\")) j++;
      const token = args.slice(i, j + 1);
      i = j + 1;
      const m = token.match(/^"\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}"$/);
      if (m) {
        const name = m[1]!;
        throw jaiphError(
          filePath,
          loc.line,
          loc.col,
          "E_VALIDATE",
          `do not use "\${${name}}" in call arguments; use a bare identifier: ...(${name})`,
        );
      }
    } else {
      while (i < args.length && args[i] !== " " && args[i] !== "\t") i++;
    }
  }
}

/** Validate bare identifier args against known variables. */
function validateBareIdentifierArgs(
  filePath: string,
  loc: { line: number; col: number },
  bareIdentifierArgs: string[] | undefined,
  knownVars: Set<string>,
  /** `ensure … recover { }` bodies receive merged failure output as `arg1` regardless of workflow params. */
  recoverPayloadArg1?: boolean,
): void {
  if (!bareIdentifierArgs) return;
  for (const name of bareIdentifierArgs) {
    if (recoverPayloadArg1 && name === "arg1") {
      continue;
    }
    if (!knownVars.has(name)) {
      throw jaiphError(
        filePath,
        loc.line,
        loc.col,
        "E_VALIDATE",
        `unknown identifier "${name}" used as bare argument; declare it with "const", use a capture, or add a workflow/rule parameter`,
      );
    }
  }
}

/** Resolve a route target workflow ref to its declared parameter count. Returns undefined if unresolvable. */
function resolveRouteTargetParams(
  ref: string,
  ast: jaiphModule,
  refCtx: RefResolutionContext,
): number | undefined {
  const dotIdx = ref.indexOf(".");
  if (dotIdx >= 0) {
    const alias = ref.slice(0, dotIdx);
    const name = ref.slice(dotIdx + 1);
    const importPath = refCtx.importsByAlias.get(alias);
    if (!importPath) return undefined;
    const importedAst = refCtx.importedAstCache.get(importPath);
    if (!importedAst) return undefined;
    const wf = importedAst.workflows.find((w) => w.name === name);
    return wf?.params.length;
  }
  const wf = ast.workflows.find((w) => w.name === ref);
  return wf?.params.length;
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

  /** Parse field names from a returns schema string like '{ name: string, age: number }'. */
  const parseSchemaFieldNames = (rawSchema: string): string[] => {
    const inner = rawSchema.trim().replace(/^\s*\{\s*/, "").replace(/\s*\}\s*$/, "").trim();
    if (!inner) return [];
    const names: string[] = [];
    for (const part of inner.split(",")) {
      const m = part.trim().match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\S+\s*$/);
      if (m) names.push(m[1]);
    }
    return names;
  };

  /** Collect prompt capture schemas from all steps in a workflow (pre-pass). */
  const collectPromptSchemas = (steps: WorkflowStepDef[]): Map<string, string[]> => {
    const schemas = new Map<string, string[]>();
    for (const s of steps) {
      if (s.type === "prompt" && s.captureName && s.returns !== undefined) {
        schemas.set(s.captureName, parseSchemaFieldNames(s.returns));
      }
      if (s.type === "const" && s.value.kind === "prompt_capture" && s.value.returns !== undefined) {
        schemas.set(s.name, parseSchemaFieldNames(s.value.returns));
      }
      if (s.type === "if") {
        for (const [k, v] of collectPromptSchemas(s.thenSteps)) schemas.set(k, v);
        if (s.elseIfBranches) {
          for (const br of s.elseIfBranches) {
            for (const [k, v] of collectPromptSchemas(br.thenSteps)) schemas.set(k, v);
          }
        }
        if (s.elseSteps) {
          for (const [k, v] of collectPromptSchemas(s.elseSteps)) schemas.set(k, v);
        }
      }
    }
    return schemas;
  };

  /** Validate ${var.field} references against known prompt schemas. */
  const validateDotFieldRefs = (
    content: string,
    loc: { line: number; col: number },
    promptSchemas: Map<string, string[]>,
  ): void => {
    for (const ref of extractDotFieldRefs(content)) {
      const fields = promptSchemas.get(ref.varName);
      if (!fields) {
        throw jaiphError(
          ast.filePath,
          loc.line,
          loc.col,
          "E_VALIDATE",
          `\${${ref.varName}.${ref.fieldName}}: "${ref.varName}" is not a typed prompt capture; dot notation requires a prompt with "returns" schema`,
        );
      }
      if (!fields.includes(ref.fieldName)) {
        throw jaiphError(
          ast.filePath,
          loc.line,
          loc.col,
          "E_VALIDATE",
          `\${${ref.varName}.${ref.fieldName}}: field "${ref.fieldName}" is not defined in the returns schema for "${ref.varName}"; available fields: ${fields.join(", ")}`,
        );
      }
    }
  };

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
    const ruleKnownVars = collectKnownVars(rule.steps, ast.envDecls, rule.params);
    // Named params are validated via knownVars; positional argN access was removed.
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
      if (s.type === "comment" || s.type === "blank_line") {
        return;
      }
      if (s.type === "ensure") {
        validateNoShellRedirection(ast.filePath, s.ref.loc, "ensure", s.args);
        validateRef(s.ref, ast, refCtx, expectRuleRef);
        validateArity(ast.filePath, s.ref.loc, s.ref.value, s.args, "rule", ast, refCtx);
        validateNoQuotedSingleInterpolation(ast.filePath, s.ref.loc, s.args);
        validateBareIdentifierArgs(ast.filePath, s.ref.loc, s.bareIdentifierArgs, ruleKnownVars);
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
        if (!s.workflow.value.includes(".") && ruleKnownVars.has(s.workflow.value) && !localScripts.has(s.workflow.value)) {
          throw jaiphError(ast.filePath, s.workflow.loc.line, s.workflow.loc.col, "E_VALIDATE", `strings are not executable; "${s.workflow.value}" is a string — use a script instead`);
        }
        validateRef(s.workflow, ast, refCtx, expectRunInRuleRef);
        validateArity(ast.filePath, s.workflow.loc, s.workflow.value, s.args, "workflow", ast, refCtx);
        validateNoQuotedSingleInterpolation(ast.filePath, s.workflow.loc, s.args);
        validateBareIdentifierArgs(ast.filePath, s.workflow.loc, s.bareIdentifierArgs, ruleKnownVars);
        return;
      }
      if (s.type === "if") {
        validateNoShellRedirection(ast.filePath, s.condition.ref.loc, s.condition.kind, s.condition.args);
        validateBareIdentifierArgs(ast.filePath, s.condition.ref.loc, s.condition.bareIdentifierArgs, ruleKnownVars);
        if (s.condition.kind === "ensure") {
          validateRef(s.condition.ref, ast, refCtx, expectRuleRef);
          validateArity(ast.filePath, s.condition.ref.loc, s.condition.ref.value, s.condition.args, "rule", ast, refCtx);
          validateNoQuotedSingleInterpolation(ast.filePath, s.condition.ref.loc, s.condition.args);
        } else {
          validateRef(s.condition.ref, ast, refCtx, expectRunInRuleRef);
          validateArity(ast.filePath, s.condition.ref.loc, s.condition.ref.value, s.condition.args, "workflow", ast, refCtx);
          validateNoQuotedSingleInterpolation(ast.filePath, s.condition.ref.loc, s.condition.args);
        }
        for (const ts of s.thenSteps) validateRuleStep(ts);
        if (s.elseIfBranches) {
          for (const br of s.elseIfBranches) {
            validateNoShellRedirection(ast.filePath, br.condition.ref.loc, br.condition.kind, br.condition.args);
            validateBareIdentifierArgs(ast.filePath, br.condition.ref.loc, br.condition.bareIdentifierArgs, ruleKnownVars);
            if (br.condition.kind === "ensure") {
              validateRef(br.condition.ref, ast, refCtx, expectRuleRef);
              validateArity(ast.filePath, br.condition.ref.loc, br.condition.ref.value, br.condition.args, "rule", ast, refCtx);
              validateNoQuotedSingleInterpolation(ast.filePath, br.condition.ref.loc, br.condition.args);
            } else {
              validateRef(br.condition.ref, ast, refCtx, expectRunInRuleRef);
              validateArity(ast.filePath, br.condition.ref.loc, br.condition.ref.value, br.condition.args, "workflow", ast, refCtx);
              validateNoQuotedSingleInterpolation(ast.filePath, br.condition.ref.loc, br.condition.args);
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
        validateSimpleInterpolationIdentifiers(
          stripDQ(s.message),
          ast.filePath,
          s.loc.line,
          s.loc.col,
          "fail",
          ruleKnownVars,
          "rule",
          undefined,
          undefined,
          localScripts,
        );
        return;
      }
      if (s.type === "log") {
        validateLogString(s.message, ast.filePath, s.loc.line, s.loc.col, "log");
        validateRuleStringCaptures(s.message, s.loc);
        validateSimpleInterpolationIdentifiers(
          s.message,
          ast.filePath,
          s.loc.line,
          s.loc.col,
          "log",
          ruleKnownVars,
          "rule",
          undefined,
          undefined,
          localScripts,
        );
        return;
      }
      if (s.type === "logerr") {
        validateLogString(s.message, ast.filePath, s.loc.line, s.loc.col, "logerr");
        validateRuleStringCaptures(s.message, s.loc);
        validateSimpleInterpolationIdentifiers(
          s.message,
          ast.filePath,
          s.loc.line,
          s.loc.col,
          "logerr",
          ruleKnownVars,
          "rule",
          undefined,
          undefined,
          localScripts,
        );
        return;
      }
      if (s.type === "return") {
        if (s.managed) {
          if (s.managed.kind === "run") {
            validateNoShellRedirection(ast.filePath, s.managed.ref.loc, "run", s.managed.args);
            validateRef(s.managed.ref, ast, refCtx, expectRunInRuleRef);
            validateArity(ast.filePath, s.managed.ref.loc, s.managed.ref.value, s.managed.args, "workflow", ast, refCtx);
            validateNoQuotedSingleInterpolation(ast.filePath, s.managed.ref.loc, s.managed.args);
            validateBareIdentifierArgs(ast.filePath, s.managed.ref.loc, s.managed.bareIdentifierArgs, ruleKnownVars);
          } else if (s.managed.kind === "ensure") {
            validateNoShellRedirection(ast.filePath, s.managed.ref.loc, "ensure", s.managed.args);
            validateRef(s.managed.ref, ast, refCtx, expectRuleRef);
            validateArity(ast.filePath, s.managed.ref.loc, s.managed.ref.value, s.managed.args, "rule", ast, refCtx);
            validateNoQuotedSingleInterpolation(ast.filePath, s.managed.ref.loc, s.managed.args);
            validateBareIdentifierArgs(ast.filePath, s.managed.ref.loc, s.managed.bareIdentifierArgs, ruleKnownVars);
          } else if (s.managed.kind === "match") {
            validateMatchExpr(ast.filePath, s.managed.match);
          }
        } else {
          validateReturnString(s.value, ast.filePath, s.loc.line, s.loc.col);
          if (s.value.startsWith('"')) {
            validateRuleStringCaptures(stripDQ(s.value), s.loc);
            validateSimpleInterpolationIdentifiers(
              stripDQ(s.value),
              ast.filePath,
              s.loc.line,
              s.loc.col,
              "return",
              ruleKnownVars,
              "rule",
              undefined,
              undefined,
              localScripts,
            );
          }
        }
        return;
      }
      if (s.type === "const") {
        const v = s.value;
        if (v.kind === "run_capture") {
          validateNoShellRedirection(ast.filePath, v.ref.loc, "run", v.args);
          if (!v.ref.value.includes(".") && ruleKnownVars.has(v.ref.value) && !localScripts.has(v.ref.value)) {
            throw jaiphError(ast.filePath, v.ref.loc.line, v.ref.loc.col, "E_VALIDATE", `strings are not executable; "${v.ref.value}" is a string — use a script instead`);
          }
          validateRef(v.ref, ast, refCtx, expectRunInRuleRef);
          validateArity(ast.filePath, v.ref.loc, v.ref.value, v.args, "workflow", ast, refCtx);
          validateNoQuotedSingleInterpolation(ast.filePath, v.ref.loc, v.args);
          validateBareIdentifierArgs(ast.filePath, v.ref.loc, v.bareIdentifierArgs, ruleKnownVars);
        } else if (v.kind === "ensure_capture") {
          validateNoShellRedirection(ast.filePath, v.ref.loc, "ensure", v.args);
          validateRef(v.ref, ast, refCtx, expectRuleRef);
          validateArity(ast.filePath, v.ref.loc, v.ref.value, v.args, "rule", ast, refCtx);
          validateNoQuotedSingleInterpolation(ast.filePath, v.ref.loc, v.args);
          validateBareIdentifierArgs(ast.filePath, v.ref.loc, v.bareIdentifierArgs, ruleKnownVars);
        } else if (v.kind === "prompt_capture") {
          throw jaiphError(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", "const ... = prompt is not allowed in rules");
        } else if (v.kind === "run_inline_script_capture") {
          // inline script capture — no ref to validate
        } else if (v.kind === "match_expr") {
          validateMatchExpr(ast.filePath, v.match);
        } else if (v.kind === "expr") {
          const bareRhs = v.bashRhs.trim();
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(bareRhs) && localScripts.has(bareRhs)) {
            throw jaiphError(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", `scripts are not values; "${bareRhs}" is a script definition`);
          }
          validateRuleStringCaptures(stripDQ(v.bashRhs), s.loc);
          validateSimpleInterpolationIdentifiers(
            stripDQ(v.bashRhs),
            ast.filePath,
            s.loc.line,
            s.loc.col,
            "const",
            ruleKnownVars,
            "rule",
            undefined,
            undefined,
            localScripts,
          );
        }
        return;
      }
      if (s.type === "match") {
        validateMatchExpr(ast.filePath, s.expr);
        return;
      }
      if (s.type === "run_inline_script") {
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

  // Validate channel-level route declarations.
  for (const ch of ast.channels) {
    if (ch.routes) {
      for (const wfRef of ch.routes) {
        validateRef(wfRef, ast, refCtx, expectWorkflowRef);
        const targetParams = resolveRouteTargetParams(wfRef.value, ast, refCtx);
        if (targetParams !== undefined && targetParams !== 3) {
          throw jaiphError(
            ast.filePath,
            wfRef.loc.line,
            wfRef.loc.col,
            "E_VALIDATE",
            `inbox route target "${wfRef.value}" must declare exactly 3 parameters (message, channel, sender), but declares ${targetParams}`,
          );
        }
      }
    }
  }

  for (const workflow of ast.workflows) {
    const promptSchemas = collectPromptSchemas(workflow.steps);
    const wfKnownVars = collectKnownVars(workflow.steps, ast.envDecls, workflow.params);
    // Named params are validated via knownVars; positional argN access was removed.

    const validateStep = (s: WorkflowStepDef, recoverPayloadArg1?: boolean): void => {
      if (s.type === "comment" || s.type === "blank_line") {
        return;
      }
      if (s.type === "send") {
        validateChannelRef(s.channel, s.loc);
        if (s.rhs.kind === "run") {
          validateNoShellRedirection(ast.filePath, s.rhs.ref.loc, "run", s.rhs.args);
          validateRef(s.rhs.ref, ast, refCtx, expectRunTargetRef);
          validateArity(ast.filePath, s.rhs.ref.loc, s.rhs.ref.value, s.rhs.args, "workflow", ast, refCtx);
          validateNoQuotedSingleInterpolation(ast.filePath, s.rhs.ref.loc, s.rhs.args);
          validateBareIdentifierArgs(ast.filePath, s.rhs.ref.loc, s.rhs.bareIdentifierArgs, wfKnownVars, recoverPayloadArg1);
        } else if (s.rhs.kind === "literal") {
          const inner = s.rhs.token.startsWith('"') && s.rhs.token.endsWith('"')
            ? s.rhs.token.slice(1, -1) : s.rhs.token;
          validateJaiphStringContent(inner, ast.filePath, s.loc.line, s.loc.col, "send");
          validateWorkflowStringCaptures(inner, s.loc);
          validateDotFieldRefs(inner, s.loc, promptSchemas);
          validateSimpleInterpolationIdentifiers(
            inner,
            ast.filePath,
            s.loc.line,
            s.loc.col,
            "send",
            wfKnownVars,
            "workflow",
            promptSchemas,
            recoverPayloadArg1,
            localScripts,
          );
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
        validateArity(ast.filePath, s.ref.loc, s.ref.value, s.args, "rule", ast, refCtx);
        validateNoQuotedSingleInterpolation(ast.filePath, s.ref.loc, s.args);
        validateBareIdentifierArgs(ast.filePath, s.ref.loc, s.bareIdentifierArgs, wfKnownVars, recoverPayloadArg1);
        if (s.recover) {
          const steps = "single" in s.recover ? [s.recover.single] : s.recover.block;
          for (const r of steps) validateStep(r, true);
        }
        return;
      }
      if (s.type === "run") {
        validateNoShellRedirection(ast.filePath, s.workflow.loc, "run", s.args);
        if (!s.workflow.value.includes(".") && wfKnownVars.has(s.workflow.value) && !localScripts.has(s.workflow.value) && !localWorkflows.has(s.workflow.value)) {
          throw jaiphError(ast.filePath, s.workflow.loc.line, s.workflow.loc.col, "E_VALIDATE", `strings are not executable; "${s.workflow.value}" is a string — use a script instead`);
        }
        validateRef(s.workflow, ast, refCtx, expectRunTargetRef);
        validateArity(ast.filePath, s.workflow.loc, s.workflow.value, s.args, "workflow", ast, refCtx);
        validateNoQuotedSingleInterpolation(ast.filePath, s.workflow.loc, s.args);
        validateBareIdentifierArgs(ast.filePath, s.workflow.loc, s.bareIdentifierArgs, wfKnownVars, recoverPayloadArg1);
        return;
      }
      if (s.type === "if") {
        validateNoShellRedirection(ast.filePath, s.condition.ref.loc, s.condition.kind, s.condition.args);
        validateBareIdentifierArgs(ast.filePath, s.condition.ref.loc, s.condition.bareIdentifierArgs, wfKnownVars, recoverPayloadArg1);
        if (s.condition.kind === "ensure") {
          validateRef(s.condition.ref, ast, refCtx, expectRuleRef);
          validateArity(ast.filePath, s.condition.ref.loc, s.condition.ref.value, s.condition.args, "rule", ast, refCtx);
          validateNoQuotedSingleInterpolation(ast.filePath, s.condition.ref.loc, s.condition.args);
        } else {
          validateRef(s.condition.ref, ast, refCtx, expectRunTargetRef);
          validateArity(ast.filePath, s.condition.ref.loc, s.condition.ref.value, s.condition.args, "workflow", ast, refCtx);
          validateNoQuotedSingleInterpolation(ast.filePath, s.condition.ref.loc, s.condition.args);
        }
        for (const ts of s.thenSteps) validateStep(ts, recoverPayloadArg1);
        if (s.elseIfBranches) {
          for (const br of s.elseIfBranches) {
            validateNoShellRedirection(ast.filePath, br.condition.ref.loc, br.condition.kind, br.condition.args);
            validateBareIdentifierArgs(ast.filePath, br.condition.ref.loc, br.condition.bareIdentifierArgs, wfKnownVars, recoverPayloadArg1);
            if (br.condition.kind === "ensure") {
              validateRef(br.condition.ref, ast, refCtx, expectRuleRef);
              validateArity(ast.filePath, br.condition.ref.loc, br.condition.ref.value, br.condition.args, "rule", ast, refCtx);
              validateNoQuotedSingleInterpolation(ast.filePath, br.condition.ref.loc, br.condition.args);
            } else {
              validateRef(br.condition.ref, ast, refCtx, expectRunTargetRef);
              validateArity(ast.filePath, br.condition.ref.loc, br.condition.ref.value, br.condition.args, "workflow", ast, refCtx);
              validateNoQuotedSingleInterpolation(ast.filePath, br.condition.ref.loc, br.condition.args);
            }
            for (const ts of br.thenSteps) validateStep(ts, recoverPayloadArg1);
          }
        }
        if (s.elseSteps) {
          for (const es of s.elseSteps) validateStep(es, recoverPayloadArg1);
        }
        return;
      }
      if (s.type === "prompt") {
        if (s.bodyKind === "identifier" && s.bodyIdentifier && localScripts.has(s.bodyIdentifier)) {
          throw jaiphError(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", `scripts are not promptable; "${s.bodyIdentifier}" is a script — use a string const instead`);
        }
        validatePromptString(s.raw, ast.filePath, s.loc.line, s.loc.col);
        validatePromptStepReturns(s, ast.filePath);
        validateWorkflowStringCaptures(stripDQ(s.raw), s.loc);
        validateDotFieldRefs(stripDQ(s.raw), s.loc, promptSchemas);
        validateSimpleInterpolationIdentifiers(
          stripDQ(s.raw),
          ast.filePath,
          s.loc.line,
          s.loc.col,
          "prompt",
          wfKnownVars,
          "workflow",
          promptSchemas,
          recoverPayloadArg1,
          localScripts,
        );
        return;
      }
      if (s.type === "log") {
        validateLogString(s.message, ast.filePath, s.loc.line, s.loc.col, "log");
        validateWorkflowStringCaptures(s.message, s.loc);
        validateDotFieldRefs(s.message, s.loc, promptSchemas);
        validateSimpleInterpolationIdentifiers(
          s.message,
          ast.filePath,
          s.loc.line,
          s.loc.col,
          "log",
          wfKnownVars,
          "workflow",
          promptSchemas,
          recoverPayloadArg1,
          localScripts,
        );
        return;
      }
      if (s.type === "logerr") {
        validateLogString(s.message, ast.filePath, s.loc.line, s.loc.col, "logerr");
        validateWorkflowStringCaptures(s.message, s.loc);
        validateDotFieldRefs(s.message, s.loc, promptSchemas);
        validateSimpleInterpolationIdentifiers(
          s.message,
          ast.filePath,
          s.loc.line,
          s.loc.col,
          "logerr",
          wfKnownVars,
          "workflow",
          promptSchemas,
          recoverPayloadArg1,
          localScripts,
        );
        return;
      }
      if (s.type === "return") {
        if (s.managed) {
          if (s.managed.kind === "run") {
            validateNoShellRedirection(ast.filePath, s.managed.ref.loc, "run", s.managed.args);
            validateRef(s.managed.ref, ast, refCtx, expectRunTargetRef);
            validateArity(ast.filePath, s.managed.ref.loc, s.managed.ref.value, s.managed.args, "workflow", ast, refCtx);
            validateNoQuotedSingleInterpolation(ast.filePath, s.managed.ref.loc, s.managed.args);
            validateBareIdentifierArgs(ast.filePath, s.managed.ref.loc, s.managed.bareIdentifierArgs, wfKnownVars, recoverPayloadArg1);
          } else if (s.managed.kind === "ensure") {
            validateNoShellRedirection(ast.filePath, s.managed.ref.loc, "ensure", s.managed.args);
            validateRef(s.managed.ref, ast, refCtx, expectRuleRef);
            validateArity(ast.filePath, s.managed.ref.loc, s.managed.ref.value, s.managed.args, "rule", ast, refCtx);
            validateNoQuotedSingleInterpolation(ast.filePath, s.managed.ref.loc, s.managed.args);
            validateBareIdentifierArgs(ast.filePath, s.managed.ref.loc, s.managed.bareIdentifierArgs, wfKnownVars, recoverPayloadArg1);
          } else if (s.managed.kind === "match") {
            validateMatchExpr(ast.filePath, s.managed.match);
          }
          return;
        }
        validateReturnString(s.value, ast.filePath, s.loc.line, s.loc.col);
        if (s.value.startsWith('"')) {
          validateWorkflowStringCaptures(stripDQ(s.value), s.loc);
          validateDotFieldRefs(stripDQ(s.value), s.loc, promptSchemas);
          validateSimpleInterpolationIdentifiers(
            stripDQ(s.value),
            ast.filePath,
            s.loc.line,
            s.loc.col,
            "return",
            wfKnownVars,
            "workflow",
            promptSchemas,
            recoverPayloadArg1,
            localScripts,
          );
        }
        return;
      }
      if (s.type === "fail") {
        validateFailString(s.message, ast.filePath, s.loc.line, s.loc.col);
        validateWorkflowStringCaptures(stripDQ(s.message), s.loc);
        validateDotFieldRefs(stripDQ(s.message), s.loc, promptSchemas);
        validateSimpleInterpolationIdentifiers(
          stripDQ(s.message),
          ast.filePath,
          s.loc.line,
          s.loc.col,
          "fail",
          wfKnownVars,
          "workflow",
          promptSchemas,
          recoverPayloadArg1,
          localScripts,
        );
        return;
      }
      if (s.type === "wait") {
        return;
      }
      if (s.type === "const") {
        const v = s.value;
        if (v.kind === "run_capture") {
          validateNoShellRedirection(ast.filePath, v.ref.loc, "run", v.args);
          if (!v.ref.value.includes(".") && wfKnownVars.has(v.ref.value) && !localScripts.has(v.ref.value) && !localWorkflows.has(v.ref.value)) {
            throw jaiphError(ast.filePath, v.ref.loc.line, v.ref.loc.col, "E_VALIDATE", `strings are not executable; "${v.ref.value}" is a string — use a script instead`);
          }
          validateRef(v.ref, ast, refCtx, expectRunTargetRef);
          validateArity(ast.filePath, v.ref.loc, v.ref.value, v.args, "workflow", ast, refCtx);
          validateNoQuotedSingleInterpolation(ast.filePath, v.ref.loc, v.args);
          validateBareIdentifierArgs(ast.filePath, v.ref.loc, v.bareIdentifierArgs, wfKnownVars, recoverPayloadArg1);
        } else if (v.kind === "ensure_capture") {
          validateNoShellRedirection(ast.filePath, v.ref.loc, "ensure", v.args);
          validateRef(v.ref, ast, refCtx, expectRuleRef);
          validateArity(ast.filePath, v.ref.loc, v.ref.value, v.args, "rule", ast, refCtx);
          validateNoQuotedSingleInterpolation(ast.filePath, v.ref.loc, v.args);
          validateBareIdentifierArgs(ast.filePath, v.ref.loc, v.bareIdentifierArgs, wfKnownVars, recoverPayloadArg1);
        } else if (v.kind === "prompt_capture") {
          if (v.bodyKind === "identifier" && v.bodyIdentifier && localScripts.has(v.bodyIdentifier)) {
            throw jaiphError(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", `scripts are not promptable; "${v.bodyIdentifier}" is a script — use a string const instead`);
          }
          validatePromptString(v.raw, ast.filePath, s.loc.line, s.loc.col);
          if (v.returns !== undefined) {
            validatePromptReturnsSchema(v.returns, ast.filePath, s.loc.line, s.loc.col);
          }
          validateWorkflowStringCaptures(stripDQ(v.raw), s.loc);
          validateDotFieldRefs(stripDQ(v.raw), s.loc, promptSchemas);
          validateSimpleInterpolationIdentifiers(
            stripDQ(v.raw),
            ast.filePath,
            s.loc.line,
            s.loc.col,
            "prompt",
            wfKnownVars,
            "workflow",
            promptSchemas,
            recoverPayloadArg1,
            localScripts,
          );
        } else if (v.kind === "run_inline_script_capture") {
          // inline script capture — no ref to validate
        } else if (v.kind === "match_expr") {
          validateMatchExpr(ast.filePath, v.match);
        } else if (v.kind === "expr") {
          const bareRhs = v.bashRhs.trim();
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(bareRhs) && localScripts.has(bareRhs)) {
            throw jaiphError(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", `scripts are not values; "${bareRhs}" is a script definition`);
          }
          validateWorkflowStringCaptures(stripDQ(v.bashRhs), s.loc);
          validateDotFieldRefs(stripDQ(v.bashRhs), s.loc, promptSchemas);
          validateSimpleInterpolationIdentifiers(
            stripDQ(v.bashRhs),
            ast.filePath,
            s.loc.line,
            s.loc.col,
            "const",
            wfKnownVars,
            "workflow",
            promptSchemas,
            recoverPayloadArg1,
            localScripts,
          );
        }
        return;
      }
      if (s.type === "match") {
        validateMatchExpr(ast.filePath, s.expr);
        return;
      }
      if (s.type === "run_inline_script") {
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


    for (const step of workflow.steps) {
      validateStep(step);
    }
  }
}

