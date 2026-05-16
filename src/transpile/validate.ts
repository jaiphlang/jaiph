import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Diagnostics } from "../diagnostics";
import type { Arg, Expr, jaiphModule, MatchExprDef, WorkflowStepDef } from "../types";
import type { ModuleGraph } from "./module-graph";
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
import { matchSendOperator } from "../parse/core";
import { tripleQuotedRawForRuntime } from "../runtime/orchestration-text";

/** True when `<-` appears outside quotes (same idea as `matchSendOperator`). */
function hasUnquotedSendArrow(line: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && (inDoubleQuote || inSingleQuote)) {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && ch === "<" && line[i + 1] === "-") {
      return true;
    }
  }
  return false;
}

/** Check if any literal arg contains unquoted shell redirection operators (>, >>, |, &). */
function hasShellRedirection(args: Arg[] | undefined): boolean {
  if (!args) return false;
  for (const a of args) {
    if (a.kind !== "literal") continue;
    let inQuote = false;
    const raw = a.raw;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"' && (i === 0 || raw[i - 1] !== "\\")) {
        inQuote = !inQuote;
        continue;
      }
      if (!inQuote && (ch === ">" || ch === "|" || ch === "&")) {
        return true;
      }
    }
  }
  return false;
}

function validateNoShellRedirection(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  keyword: string,
  args: Arg[] | undefined,
): void {
  if (!hasShellRedirection(args)) return;
  diag.error(
    filePath,
    loc.line,
    loc.col,
    "E_VALIDATE",
    `shell redirection (>, >>, |, &) is not supported with ${keyword}; use a script block for shell operations`,
  );
}

function validateMatchExpr(
  diag: Diagnostics,
  filePath: string,
  expr: MatchExprDef,
  knownVars: Set<string>,
): void {
  if (expr.arms.length === 0) {
    diag.error(filePath, expr.loc.line, expr.loc.col, "E_VALIDATE", "match must have at least one arm");
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
        diag.error(
          filePath,
          expr.loc.line,
          expr.loc.col,
          "E_VALIDATE",
          `invalid regex in match pattern: /${arm.pattern.source}/`,
        );
      }
    }
    const bodyTrimmed = (arm.tripleQuotedBody ? tripleQuotedRawForRuntime(arm.body) : arm.body).trimStart();
    if (/^return(\s|$)/.test(bodyTrimmed)) {
      diag.error(
        filePath,
        expr.loc.line,
        expr.loc.col,
        "E_VALIDATE",
        `match arm body must not start with "return"; the match expression itself produces the value — use the expression directly after =>`,
      );
    }
    if (/`[^`]*`\s*\(/.test(bodyTrimmed) || bodyTrimmed.startsWith("```")) {
      diag.error(
        filePath,
        expr.loc.line,
        expr.loc.col,
        "E_VALIDATE",
        `inline scripts are not allowed in match arm bodies; use a named script with "run script_name(…)" instead`,
      );
    }
    if (!arm.tripleQuotedBody) {
      const idMatch = bodyTrimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (idMatch) {
        const ident = idMatch[1]!;
        const after = bodyTrimmed.slice(ident.length);
        const startsCall = after.startsWith("(");
        const startsArgs = /^\s+\S/.test(after);
        if ((startsCall || startsArgs) && ident !== "fail" && ident !== "run" && ident !== "ensure") {
          const hint = ident === "error" ? ` did you mean "fail"?` : "";
          diag.error(
            filePath,
            expr.loc.line,
            expr.loc.col,
            "E_VALIDATE",
            `unknown match arm verb "${ident}"; allowed: fail "...", run ref(...), ensure ref(...).${hint}`,
          );
        }
        if (!startsCall && !startsArgs && after.trim() === "" && !knownVars.has(ident)) {
          diag.error(
            filePath,
            expr.loc.line,
            expr.loc.col,
            "E_VALIDATE",
            `unknown identifier "${ident}" in match arm body; declare it with "const", use a capture, or add a parameter`,
          );
        }
      }
    }
  }
  if (wildcardCount === 0) {
    diag.error(filePath, expr.loc.line, expr.loc.col, "E_VALIDATE", "match must have exactly one wildcard (_) arm");
  }
  if (wildcardCount > 1) {
    diag.error(filePath, expr.loc.line, expr.loc.col, "E_VALIDATE", "match must have exactly one wildcard (_) arm, found multiple");
  }
}

/**
 * One step entry in the flat list built by the single workflow walk.
 *
 * `recoverBindings` is the `Set` of failure-binding names contributed by an
 * enclosing `catch` / `recover`, threaded down so steps inside a recovery
 * body can resolve `<failure>` as an in-scope identifier.
 */
interface FlatStepEntry {
  step: WorkflowStepDef;
  recoverBindings: Set<string> | undefined;
}

/**
 * Result of the single recursive descent over a workflow's / rule's step
 * tree: the global identifier set (envDecls + params + every nested const /
 * capture / for-iterator), the top-level prompt schemas, and a flat list of
 * every step in tree order. The flat list is what the main validator loop
 * iterates over — that loop is non-recursive, so the only recursive helper
 * walking `WorkflowStepDef[]` in this file is `walkStepTree` itself.
 *
 * Replaces three prior pre-passes that each walked the same step tree with
 * subtly different recursion rules. Immutable-binding rules are enforced
 * inline during the descent so the failure order matches the prior
 * "binding errors first, then per-step errors" behavior.
 */
interface StepTreeWalk {
  knownVars: Set<string>;
  promptSchemas: Map<string, string[]>;
  flat: FlatStepEntry[];
}

function walkStepTree(
  diag: Diagnostics,
  filePath: string,
  steps: WorkflowStepDef[],
  envDecls: { name: string; loc: { line: number; col: number } }[] | undefined,
  params: string[],
  declLoc: { line: number; col: number },
  moduleScripts: Set<string>,
  parseSchemaFieldNames: (rawSchema: string) => string[],
  options: { withPromptSchemas: boolean },
): StepTreeWalk {
  const knownVars = new Set<string>();
  const promptSchemas = new Map<string, string[]>();
  const flat: FlatStepEntry[] = [];

  if (envDecls) {
    for (const d of envDecls) knownVars.add(d.name);
  }
  for (const p of params) {
    knownVars.add(p);
  }

  const seedBindings = new Map<string, { kind: string; line: number }>();
  for (const p of params) {
    seedBindings.set(p, { kind: "parameter", line: declLoc.line });
  }

  const checkBinding = (
    name: string,
    kind: string,
    loc: { line: number; col: number },
    b: Map<string, { kind: string; line: number }>,
  ): void => {
    const prev = b.get(name);
    if (prev) {
      diag.error(
        filePath,
        loc.line,
        loc.col,
        "E_VALIDATE",
        `cannot rebind immutable name "${name}"; already bound as ${prev.kind} at ${filePath}:${prev.line}`,
      );
    }
    if (moduleScripts.has(name)) {
      diag.error(
        filePath,
        loc.line,
        loc.col,
        "E_VALIDATE",
        `cannot rebind immutable name "${name}"; already bound as script in this module`,
      );
    }
    b.set(name, { kind, line: loc.line });
  };

  const descend = (
    ss: WorkflowStepDef[],
    bindings: Map<string, { kind: string; line: number }>,
    recoverBindings: Set<string> | undefined,
    topLevel: boolean,
  ): void => {
    for (const s of ss) {
      flat.push({ step: s, recoverBindings });

      if (s.type === "const") {
        knownVars.add(s.name);
        checkBinding(s.name, "const", s.loc, bindings);
        if (options.withPromptSchemas && topLevel && s.value.kind === "prompt" && s.value.returns !== undefined) {
          promptSchemas.set(s.name, parseSchemaFieldNames(s.value.returns));
        }
        continue;
      }

      if (s.type === "exec") {
        if (s.captureName) {
          knownVars.add(s.captureName);
          const captureLoc = execBodyLoc(s.body) ?? s.loc;
          checkBinding(s.captureName, "capture", captureLoc, bindings);
          if (options.withPromptSchemas && topLevel && s.body.kind === "prompt" && s.body.returns !== undefined) {
            promptSchemas.set(s.captureName, parseSchemaFieldNames(s.body.returns));
          }
        }
        if (s.catch) {
          const catchSteps = "single" in s.catch ? [s.catch.single] : s.catch.block;
          descend(catchSteps, bindings, new Set([s.catch.bindings.failure]), false);
        }
        if (s.recover) {
          const recoverSteps = "single" in s.recover ? [s.recover.single] : s.recover.block;
          descend(recoverSteps, bindings, new Set([s.recover.bindings.failure]), false);
        }
        continue;
      }

      if (s.type === "if") {
        descend(s.body, bindings, recoverBindings, false);
        continue;
      }

      if (s.type === "for_lines") {
        knownVars.add(s.iterVar);
        if (bindings.has(s.iterVar)) {
          diag.error(
            filePath,
            s.loc.line,
            s.loc.col,
            "E_VALIDATE",
            `for loop iterator "${s.iterVar}" conflicts with an existing binding`,
          );
        }
        const inner = new Map(bindings);
        inner.set(s.iterVar, { kind: "loop_iterator", line: s.loc.line });
        descend(s.body, inner, recoverBindings, false);
        continue;
      }
    }
  };

  descend(steps, seedBindings, undefined, true);
  return { knownVars, promptSchemas, flat };
}

/** Best-effort location for an exec body — used to attribute capture-binding errors. */
function execBodyLoc(body: Expr): { line: number; col: number } | undefined {
  if (body.kind === "call" || body.kind === "ensure_call") return body.callee.loc;
  if (body.kind === "prompt" || body.kind === "shell") return body.loc;
  if (body.kind === "match") return body.match.loc;
  return undefined;
}

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

function validateArity(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  ref: string,
  args: Arg[] | undefined,
  targetKind: "workflow" | "rule",
  ast: jaiphModule,
  refCtx: RefResolutionContext,
): void {
  const params = lookupCalleeParams(ref, targetKind, ast, refCtx);
  if (params === undefined) return;
  const argCount = args?.length ?? 0;
  if (argCount !== params.length) {
    diag.error(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `${targetKind} "${ref}" expects ${params.length} argument(s) (${params.join(", ") || "none"}), but got ${argCount}`,
    );
  }
}

function validateArgVarRefs(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  args: Arg[] | undefined,
  knownVars: Set<string>,
  recoverBindings?: Set<string>,
): void {
  if (!args) return;
  for (const a of args) {
    if (a.kind !== "var") continue;
    if (recoverBindings?.has(a.name)) continue;
    if (knownVars.has(a.name)) continue;
    diag.error(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `unknown identifier "${a.name}" used as bare argument; declare it with "const", use a capture, or add a workflow/rule parameter`,
    );
  }
}

function validateNestedManagedCallArgs(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  args: Arg[] | undefined,
): void {
  if (!args) return;
  for (const a of args) {
    if (a.kind !== "literal") continue;
    checkNestedManagedInLiteral(diag, filePath, loc, a.raw);
  }
}

function checkNestedManagedInLiteral(
  diag: Diagnostics,
  filePath: string,
  loc: { line: number; col: number },
  raw: string,
): void {
  const stripped = stripQuotedSegmentContent(raw);
  const re = /\b([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const before = stripped.slice(0, match.index).trimEnd();
    const lastToken = before.length === 0 ? "" : before.slice(before.lastIndexOf(" ") + 1);
    if (lastToken === "run" || lastToken === "ensure") continue;
    diag.error(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `nested managed calls in argument position must be explicit; use "run ${match[1]}(...)" or "ensure ${match[1]}(...)" inside the argument list`,
    );
  }
  const btRe = /`[^`]*`\s*\(/g;
  let btMatch: RegExpExecArray | null;
  while ((btMatch = btRe.exec(stripped)) !== null) {
    const before = stripped.slice(0, btMatch.index).trimEnd();
    const lastToken = before.length === 0 ? "" : before.slice(before.lastIndexOf(" ") + 1);
    if (lastToken === "run" || lastToken === "ensure") continue;
    diag.error(
      filePath,
      loc.line,
      loc.col,
      "E_VALIDATE",
      `nested inline script calls in argument position must be explicit; use "run \`...\`(...)" inside the argument list`,
    );
  }
}

function stripQuotedSegmentContent(segment: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote && segment[i - 1] !== "\\") {
        quote = null;
      }
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

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

export function resolveScriptImportPath(fromFile: string, importPath: string): string {
  return resolve(dirname(fromFile), importPath);
}

/**
 * Legacy throwing entry. Builds a `Diagnostics` collector internally and
 * throws the first sorted diagnostic via `jaiphError` so existing callers
 * (and per-error tests) continue to see one error per failed compile.
 *
 * Use {@link collectDiagnostics} when you want the full set.
 */
export function validateReferences(graph: ModuleGraph): void {
  const diag = collectDiagnostics(graph);
  diag.throwFirstIfAny();
}

/**
 * New entry: walk the graph and append every validation error into a fresh
 * `Diagnostics`. Never throws on user-level validation errors — non-validator
 * problems (internal bugs) still bubble up.
 */
export function collectDiagnostics(graph: ModuleGraph): Diagnostics {
  const diag = new Diagnostics();
  for (const node of graph.modules.values()) {
    validateModuleInto(node.ast, graph, diag);
  }
  return diag;
}

/** Legacy throwing per-module wrapper (kept for `emitScriptsForModuleFromGraph`). */
export function validateModule(ast: jaiphModule, graph: ModuleGraph): void {
  const diag = new Diagnostics();
  validateModuleInto(ast, graph, diag);
  diag.throwFirstIfAny();
}

export function validateModuleInto(
  ast: jaiphModule,
  graph: ModuleGraph,
  diag: Diagnostics,
): void {
  const localChannels = new Set(ast.channels.map((c) => c.name));
  const localRules = new Set(ast.rules.map((r) => r.name));
  const localWorkflows = new Set(ast.workflows.map((w) => w.name));
  const localScripts = new Set(ast.scripts.map((s) => s.name));
  const importsByAlias = new Map<string, string>();
  const importedAstCache = new Map<string, jaiphModule>();

  if (ast.scriptImports) {
    for (const si of ast.scriptImports) {
      diag.capture(() => {
        const resolved = resolveScriptImportPath(ast.filePath, si.path);
        if (!existsSync(resolved)) {
          diag.error(
            ast.filePath,
            si.loc.line,
            si.loc.col,
            "E_IMPORT_NOT_FOUND",
            `import script "${si.alias}" resolves to missing file "${resolved}"`,
          );
        }
        localScripts.add(si.alias);
      });
    }
  }

  const node = graph.modules.get(ast.filePath);
  for (const imp of ast.imports) {
    diag.capture(() => {
      if (importsByAlias.has(imp.alias)) {
        diag.error(
          ast.filePath,
          imp.loc.line,
          imp.loc.col,
          "E_VALIDATE",
          `duplicate import alias "${imp.alias}"`,
        );
      }
      const resolved = node?.imports.get(imp.alias);
      if (!resolved) {
        diag.error(
          ast.filePath,
          imp.loc.line,
          imp.loc.col,
          "E_IMPORT_NOT_FOUND",
          `import "${imp.alias}" could not be resolved`,
        );
      }
      importsByAlias.set(imp.alias, resolved);
      const importedAst = graph.modules.get(resolved)?.ast;
      if (!importedAst) {
        diag.error(
          ast.filePath,
          imp.loc.line,
          imp.loc.col,
          "E_IMPORT_NOT_FOUND",
          `import "${imp.alias}" resolves to missing file "${resolved}"`,
        );
      }
      importedAstCache.set(resolved, importedAst);
    });
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

  const extractConstScriptName = (rhs: string): string | undefined => {
    const trimmed = rhs.trim();
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) return trimmed;
    const inner = stripDQ(trimmed);
    const m = inner.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
    return m?.[1];
  };

  const semanticQuotedOrchestrationInner = (dqRaw: string): string => stripDQ(dqRaw);

  const promptBareIdentifier = (raw: string): string | undefined => {
    const m = raw.match(/^"\$\{([A-Za-z_][A-Za-z0-9_]*)\}"$/);
    return m?.[1];
  };

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

  const validateDotFieldRefs = (
    content: string,
    loc: { line: number; col: number },
    promptSchemas: Map<string, string[]>,
  ): void => {
    for (const ref of extractDotFieldRefs(content)) {
      const fields = promptSchemas.get(ref.varName);
      if (!fields) {
        diag.error(
          ast.filePath,
          loc.line,
          loc.col,
          "E_VALIDATE",
          `\${${ref.varName}.${ref.fieldName}}: "${ref.varName}" is not a typed prompt capture; dot notation requires a prompt with "returns" schema`,
        );
      }
      if (!fields.includes(ref.fieldName)) {
        diag.error(
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
        validateNoShellRedirection(diag, ast.filePath, loc, "run", cap.args);
        validateRef({ value: cap.ref, loc }, ast, refCtx, expectRunTargetRef);
      } else {
        validateNoShellRedirection(diag, ast.filePath, loc, "ensure", cap.args);
        validateRef({ value: cap.ref, loc }, ast, refCtx, expectRuleRef);
      }
    }
  };

  const validateRuleStringCaptures = (content: string, loc: { line: number; col: number }): void => {
    for (const cap of extractInlineCaptures(content)) {
      if (cap.kind === "run") {
        validateNoShellRedirection(diag, ast.filePath, loc, "run", cap.args);
        validateRef({ value: cap.ref, loc }, ast, refCtx, expectRunInRuleRef);
      } else {
        validateNoShellRedirection(diag, ast.filePath, loc, "ensure", cap.args);
        validateRef({ value: cap.ref, loc }, ast, refCtx, expectRuleRef);
      }
    }
  };

  /** Run the 5 standard checks (redirection, nested-managed, ref, arity, var-ref) on a callable Expr. */
  const validateCallable = (
    body: Expr,
    knownVars: Set<string>,
    scope: "workflow" | "rule",
    recoverBindings?: Set<string>,
  ): void => {
    if (body.kind === "call") {
      const loc = body.callee.loc;
      validateNoShellRedirection(diag, ast.filePath, loc, "run", body.args);
      validateNestedManagedCallArgs(diag, ast.filePath, loc, body.args);
      const isRuleScope = scope === "rule";
      if (!body.callee.value.includes(".") && knownVars.has(body.callee.value) && !localScripts.has(body.callee.value) && !(scope === "workflow" && localWorkflows.has(body.callee.value))) {
        diag.error(ast.filePath, loc.line, loc.col, "E_VALIDATE", `strings are not executable; "${body.callee.value}" is a string — use a script instead`);
      }
      validateRef(body.callee, ast, refCtx, isRuleScope ? expectRunInRuleRef : expectRunTargetRef);
      validateArity(diag, ast.filePath, loc, body.callee.value, body.args, "workflow", ast, refCtx);
      validateArgVarRefs(diag, ast.filePath, loc, body.args, knownVars, recoverBindings);
      return;
    }
    if (body.kind === "ensure_call") {
      const loc = body.callee.loc;
      validateNoShellRedirection(diag, ast.filePath, loc, "ensure", body.args);
      validateNestedManagedCallArgs(diag, ast.filePath, loc, body.args);
      validateRef(body.callee, ast, refCtx, expectRuleRef);
      validateArity(diag, ast.filePath, loc, body.callee.value, body.args, "rule", ast, refCtx);
      validateArgVarRefs(diag, ast.filePath, loc, body.args, knownVars, recoverBindings);
      return;
    }
    if (body.kind === "inline_script") {
      return; // no ref to validate
    }
    if (body.kind === "match") {
      validateMatchExpr(diag, ast.filePath, body.match, knownVars);
      return;
    }
  };

  /** Validate the value Expr stored under a `const` / `return` / `send` step in a workflow context. */
  const validateWorkflowValueExpr = (
    expr: Expr,
    stepLoc: { line: number; col: number },
    knownVars: Set<string>,
    promptSchemas: Map<string, string[]>,
    recoverBindings: Set<string> | undefined,
    label: "const" | "return" | "send",
    constName?: string,
  ): void => {
    if (expr.kind === "literal") {
      if (label === "send") {
        const inner = expr.raw.startsWith('"') && expr.raw.endsWith('"') ? expr.raw.slice(1, -1) : expr.raw;
        validateJaiphStringContent(inner, ast.filePath, stepLoc.line, stepLoc.col, "send");
        validateWorkflowStringCaptures(inner, stepLoc);
        validateDotFieldRefs(inner, stepLoc, promptSchemas);
        validateSimpleInterpolationIdentifiers(
          inner, ast.filePath, stepLoc.line, stepLoc.col,
          "send", knownVars, "workflow", promptSchemas, recoverBindings, localScripts,
        );
        return;
      }
      if (label === "return") {
        validateReturnString(expr.raw, ast.filePath, stepLoc.line, stepLoc.col);
        if (expr.raw.startsWith('"')) {
          const retInner = semanticQuotedOrchestrationInner(expr.raw);
          validateWorkflowStringCaptures(retInner, stepLoc);
          validateDotFieldRefs(retInner, stepLoc, promptSchemas);
          validateSimpleInterpolationIdentifiers(
            retInner, ast.filePath, stepLoc.line, stepLoc.col,
            "return", knownVars, "workflow", promptSchemas, recoverBindings, localScripts,
          );
        }
        return;
      }
      // const
      const scriptName = extractConstScriptName(expr.raw);
      if (scriptName && localScripts.has(scriptName)) {
        diag.error(ast.filePath, stepLoc.line, stepLoc.col, "E_VALIDATE", `scripts are not values; "${scriptName}" is a script definition`);
      }
      const inner = semanticQuotedOrchestrationInner(expr.raw);
      validateWorkflowStringCaptures(inner, stepLoc);
      validateDotFieldRefs(inner, stepLoc, promptSchemas);
      validateSimpleInterpolationIdentifiers(
        inner, ast.filePath, stepLoc.line, stepLoc.col,
        "const", knownVars, "workflow", promptSchemas, recoverBindings, localScripts,
      );
      return;
    }
    if (expr.kind === "call") {
      validateCallable(expr, knownVars, "workflow", recoverBindings);
      return;
    }
    if (expr.kind === "ensure_call") {
      validateCallable(expr, knownVars, "workflow", recoverBindings);
      return;
    }
    if (expr.kind === "inline_script") {
      return;
    }
    if (expr.kind === "match") {
      validateMatchExpr(diag, ast.filePath, expr.match, knownVars);
      return;
    }
    if (expr.kind === "prompt") {
      if (label !== "const") {
        diag.error(ast.filePath, stepLoc.line, stepLoc.col, "E_VALIDATE", `prompt is not a valid ${label} value`);
      }
      const promptIdent = promptBareIdentifier(expr.raw);
      if (promptIdent && localScripts.has(promptIdent)) {
        diag.error(ast.filePath, stepLoc.line, stepLoc.col, "E_VALIDATE", `scripts are not promptable; "${promptIdent}" is a script — use a string const instead`);
      }
      validatePromptString(expr.raw, ast.filePath, stepLoc.line, stepLoc.col);
      if (expr.returns !== undefined) {
        validatePromptReturnsSchema(expr.returns, ast.filePath, stepLoc.line, stepLoc.col);
      }
      const pcInner = semanticQuotedOrchestrationInner(expr.raw);
      validateWorkflowStringCaptures(pcInner, stepLoc);
      validateDotFieldRefs(pcInner, stepLoc, promptSchemas);
      validateSimpleInterpolationIdentifiers(
        pcInner, ast.filePath, stepLoc.line, stepLoc.col,
        "prompt", knownVars, "workflow", promptSchemas, recoverBindings, localScripts,
      );
      return;
    }
    if (expr.kind === "bare_ref") {
      if (label !== "send") {
        diag.error(ast.filePath, expr.ref.loc.line, expr.ref.loc.col, "E_VALIDATE", `bare reference is only valid as a send payload`);
      }
      validateRef(expr.ref, ast, refCtx, bareSendRefSpec);
      return;
    }
    if (expr.kind === "shell") {
      if (label !== "send") {
        diag.error(ast.filePath, expr.loc.line, expr.loc.col, "E_VALIDATE", `raw shell fragment is only valid as a send payload`);
      }
      validateManagedWorkflowShell(expr.command, makeSubEnv({ line: expr.loc.line, col: expr.loc.col }));
      return;
    }
    void constName;
  };

  /** Same as `validateWorkflowValueExpr` but with rule-scope rules (no prompt, restricted run targets). */
  const validateRuleValueExpr = (
    expr: Expr,
    stepLoc: { line: number; col: number },
    knownVars: Set<string>,
    label: "const" | "return",
  ): void => {
    if (expr.kind === "literal") {
      if (label === "return") {
        validateReturnString(expr.raw, ast.filePath, stepLoc.line, stepLoc.col);
        if (expr.raw.startsWith('"')) {
          const retRuleInner = semanticQuotedOrchestrationInner(expr.raw);
          validateRuleStringCaptures(retRuleInner, stepLoc);
          validateSimpleInterpolationIdentifiers(
            retRuleInner, ast.filePath, stepLoc.line, stepLoc.col,
            "return", knownVars, "rule", undefined, undefined, localScripts,
          );
        }
        return;
      }
      const scriptName = extractConstScriptName(expr.raw);
      if (scriptName && localScripts.has(scriptName)) {
        diag.error(ast.filePath, stepLoc.line, stepLoc.col, "E_VALIDATE", `scripts are not values; "${scriptName}" is a script definition`);
      }
      validateRuleStringCaptures(stripDQ(expr.raw), stepLoc);
      validateSimpleInterpolationIdentifiers(
        stripDQ(expr.raw), ast.filePath, stepLoc.line, stepLoc.col,
        "const", knownVars, "rule", undefined, undefined, localScripts,
      );
      return;
    }
    if (expr.kind === "call") {
      validateCallable(expr, knownVars, "rule");
      return;
    }
    if (expr.kind === "ensure_call") {
      validateCallable(expr, knownVars, "rule");
      return;
    }
    if (expr.kind === "inline_script") {
      return;
    }
    if (expr.kind === "match") {
      validateMatchExpr(diag, ast.filePath, expr.match, knownVars);
      return;
    }
    if (expr.kind === "prompt") {
      diag.error(ast.filePath, stepLoc.line, stepLoc.col, "E_VALIDATE", "const ... = prompt is not allowed in rules");
    }
    if (expr.kind === "bare_ref" || expr.kind === "shell") {
      diag.error(ast.filePath, stepLoc.line, stepLoc.col, "E_VALIDATE", `${expr.kind} expression is not allowed in rules`);
    }
  };

  for (const rule of ast.rules) {
    let ruleWalk: StepTreeWalk | undefined;
    diag.capture(() => {
      ruleWalk = walkStepTree(
        diag,
        ast.filePath,
        rule.steps,
        ast.envDecls,
        rule.params,
        rule.loc,
        localScripts,
        parseSchemaFieldNames,
        { withPromptSchemas: false },
      );
    });
    if (!ruleWalk) continue;
    const ruleKnownVars = ruleWalk.knownVars;
    const validateRuleStep = (s: WorkflowStepDef): void => {
      if (s.type === "trivia") return;
      if (s.type === "say") {
        if (s.level === "log" || s.level === "logerr") {
          if (s.message.kind === "inline_script") return;
          if (s.message.kind === "literal") {
            validateLogString(s.message.raw, ast.filePath, s.loc.line, s.loc.col, s.level);
            const inner = s.message.raw;
            validateRuleStringCaptures(inner, s.loc);
            validateSimpleInterpolationIdentifiers(
              inner, ast.filePath, s.loc.line, s.loc.col,
              s.level, ruleKnownVars, "rule", undefined, undefined, localScripts,
            );
            return;
          }
          diag.error(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", `unsupported ${s.level} message form`);
        }
        // fail
        if (s.message.kind !== "literal") {
          diag.error(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", "fail message must be a literal string");
        }
        validateFailString(s.message.raw, ast.filePath, s.loc.line, s.loc.col);
        const failInner = semanticQuotedOrchestrationInner(s.message.raw);
        validateRuleStringCaptures(failInner, s.loc);
        validateSimpleInterpolationIdentifiers(
          failInner, ast.filePath, s.loc.line, s.loc.col,
          "fail", ruleKnownVars, "rule", undefined, undefined, localScripts,
        );
        return;
      }
      if (s.type === "send") {
        diag.error(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", "send is not allowed in rules");
      }
      if (s.type === "return") {
        validateRuleValueExpr(s.value, s.loc, ruleKnownVars, "return");
        return;
      }
      if (s.type === "const") {
        validateRuleValueExpr(s.value, s.loc, ruleKnownVars, "const");
        return;
      }
      if (s.type === "exec") {
        const body = s.body;
        if (body.kind === "prompt") {
          diag.error(ast.filePath, body.loc.line, body.loc.col, "E_VALIDATE", "prompt is not allowed in rules");
        }
        if (body.kind === "shell") {
          diag.error(ast.filePath, body.loc.line, body.loc.col, "E_VALIDATE", "inline shell steps are forbidden in rules; use explicit script blocks");
        }
        if (body.kind === "call" && (s as Extract<WorkflowStepDef, { type: "exec" }>).body.kind === "call") {
          const callBody = body;
          if (callBody.async) {
            diag.error(ast.filePath, callBody.callee.loc.line, callBody.callee.loc.col, "E_VALIDATE", "run async is not allowed in rules; use it in workflows only");
          }
        }
        validateCallable(body, ruleKnownVars, "rule");
        return;
      }
      if (s.type === "if") {
        if (s.operand.kind === "regex") {
          try { new RegExp(s.operand.source); } catch {
            diag.error(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", `invalid regex in if condition: /${s.operand.source}/`);
          }
        }
        return;
      }
      if (s.type === "for_lines") {
        if (!ruleKnownVars.has(s.sourceVar)) {
          diag.error(
            ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE",
            `for ... in <name>: "${s.sourceVar}" is not a known variable in this scope`,
          );
        }
        return;
      }
      const _never: never = s;
      return _never;
    };
    for (const entry of ruleWalk.flat) {
      diag.capture(() => validateRuleStep(entry.step));
    }
  }

  const validateChannelRef = (channel: string, loc: { line: number; col: number }): void => {
    const parts = channel.split(".");
    if (parts.length === 1) {
      if (!localChannels.has(channel)) {
        diag.error(ast.filePath, loc.line, loc.col, "E_VALIDATE", `Channel "${channel}" is not defined`);
      }
      return;
    }
    if (parts.length !== 2) {
      diag.error(ast.filePath, loc.line, loc.col, "E_VALIDATE", `Channel "${channel}" is not defined`);
    }
    const [alias, importedChannel] = parts;
    const importedFile = importsByAlias.get(alias);
    if (!importedFile) {
      diag.error(ast.filePath, loc.line, loc.col, "E_VALIDATE", `Channel "${channel}" is not defined`);
    }
    const importedAst = importedAstCache.get(importedFile)!;
    const importedChannels = new Set(importedAst.channels.map((c) => c.name));
    if (!importedChannels.has(importedChannel)) {
      diag.error(ast.filePath, loc.line, loc.col, "E_VALIDATE", `Channel "${channel}" is not defined`);
    }
  };

  for (const ch of ast.channels) {
    if (ch.routes) {
      for (const wfRef of ch.routes) {
        diag.capture(() => {
          validateRef(wfRef, ast, refCtx, expectWorkflowRef);
          const targetParams = resolveRouteTargetParams(wfRef.value, ast, refCtx);
          if (targetParams !== undefined && targetParams !== 3) {
            diag.error(
              ast.filePath, wfRef.loc.line, wfRef.loc.col, "E_VALIDATE",
              `inbox route target "${wfRef.value}" must declare exactly 3 parameters (message, channel, sender), but declares ${targetParams}`,
            );
          }
        });
      }
    }
  }

  for (const workflow of ast.workflows) {
    let wfWalk: StepTreeWalk | undefined;
    diag.capture(() => {
      wfWalk = walkStepTree(
        diag,
        ast.filePath,
        workflow.steps,
        ast.envDecls,
        workflow.params,
        workflow.loc,
        localScripts,
        parseSchemaFieldNames,
        { withPromptSchemas: true },
      );
    });
    if (!wfWalk) continue;
    const wfKnownVars = wfWalk.knownVars;
    const promptSchemas = wfWalk.promptSchemas;

    const validateStep = (s: WorkflowStepDef, recoverBindings?: Set<string>): void => {
      if (s.type === "trivia") return;
      if (s.type === "send") {
        validateChannelRef(s.channel, s.loc);
        validateWorkflowValueExpr(s.value, s.loc, wfKnownVars, promptSchemas, recoverBindings, "send");
        return;
      }
      if (s.type === "say") {
        if (s.level === "log" || s.level === "logerr") {
          if (s.message.kind === "inline_script") return;
          if (s.message.kind === "literal") {
            validateLogString(s.message.raw, ast.filePath, s.loc.line, s.loc.col, s.level);
            const inner = s.message.raw;
            validateWorkflowStringCaptures(inner, s.loc);
            validateDotFieldRefs(inner, s.loc, promptSchemas);
            validateSimpleInterpolationIdentifiers(
              inner, ast.filePath, s.loc.line, s.loc.col,
              s.level, wfKnownVars, "workflow", promptSchemas, recoverBindings, localScripts,
            );
            return;
          }
          diag.error(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", `unsupported ${s.level} message form`);
        }
        // fail
        if (s.message.kind !== "literal") {
          diag.error(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", "fail message must be a literal string");
        }
        validateFailString(s.message.raw, ast.filePath, s.loc.line, s.loc.col);
        const failInner = semanticQuotedOrchestrationInner(s.message.raw);
        validateWorkflowStringCaptures(failInner, s.loc);
        validateDotFieldRefs(failInner, s.loc, promptSchemas);
        validateSimpleInterpolationIdentifiers(
          failInner, ast.filePath, s.loc.line, s.loc.col,
          "fail", wfKnownVars, "workflow", promptSchemas, recoverBindings, localScripts,
        );
        return;
      }
      if (s.type === "return") {
        validateWorkflowValueExpr(s.value, s.loc, wfKnownVars, promptSchemas, recoverBindings, "return");
        return;
      }
      if (s.type === "const") {
        validateWorkflowValueExpr(s.value, s.loc, wfKnownVars, promptSchemas, recoverBindings, "const", s.name);
        return;
      }
      if (s.type === "exec") {
        const body = s.body;
        if (body.kind === "prompt") {
          validateWorkflowValueExpr(body, s.loc, wfKnownVars, promptSchemas, recoverBindings, "const");
          validatePromptStepReturns(body, s.captureName, ast.filePath);
          return;
        }
        if (body.kind === "shell") {
          if (hasUnquotedSendArrow(body.command) && matchSendOperator(body.command) === null) {
            diag.error(
              ast.filePath, body.loc.line, body.loc.col, "E_VALIDATE",
              "invalid send: channel must be a single name or `alias.name` (at most one dot in the channel part)",
            );
          }
          const t = body.command.trim();
          if (/^(?:[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(t)) {
            if (!t.includes(".")) {
              if (localScripts.has(t) || localWorkflows.has(t)) {
                diag.error(
                  ast.filePath, body.loc.line, body.loc.col, "E_VALIDATE",
                  `use run ${t}() — a bare name that refers to a script or workflow must use a managed run step`,
                );
              }
            } else {
              validateRef({ value: t, loc: body.loc }, ast, refCtx, expectRunTargetRef);
              diag.error(
                ast.filePath, body.loc.line, body.loc.col, "E_VALIDATE",
                `use run ${t}() — "${t}" is a valid script or workflow reference; use a managed run step`,
              );
            }
          }
          return;
        }
        validateCallable(body, wfKnownVars, "workflow", recoverBindings);
        return;
      }
      if (s.type === "if") {
        if (s.operand.kind === "regex") {
          try { new RegExp(s.operand.source); } catch {
            diag.error(ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE", `invalid regex in if condition: /${s.operand.source}/`);
          }
        }
        return;
      }
      if (s.type === "for_lines") {
        if (!wfKnownVars.has(s.sourceVar)) {
          diag.error(
            ast.filePath, s.loc.line, s.loc.col, "E_VALIDATE",
            `for ... in <name>: "${s.sourceVar}" is not a known variable in this scope`,
          );
        }
        return;
      }
      const _never: never = s;
      return _never;
    };

    for (const entry of wfWalk.flat) {
      diag.capture(() => validateStep(entry.step, entry.recoverBindings));
    }
  }

  if (ast.tests && ast.tests.length > 0) {
    validateTestBlocks(diag, ast, ast.tests);
  }
}

function validateTestBlocks(
  diag: Diagnostics,
  ast: jaiphModule,
  tests: import("../types").TestBlockDef[],
): void {
  for (const tb of tests) {
    const inScope = new Set<string>();
    for (const step of tb.steps) {
      diag.capture(() => {
        if (step.type === "test_const") {
          inScope.add(step.name);
          return;
        }
        if (step.type === "test_run_workflow") {
          if (step.captureName) inScope.add(step.captureName);
          return;
        }
        if (step.type === "test_mock_prompt" && step.responseVar) {
          if (!inScope.has(step.responseVar)) {
            diag.error(
              ast.filePath,
              step.loc.line,
              step.loc.col,
              "E_VALIDATE",
              `mock prompt: undefined name "${step.responseVar}" (declare it earlier with: const ${step.responseVar} = "…")`,
            );
          }
          return;
        }
        if (
          step.type === "test_expect_contain" ||
          step.type === "test_expect_not_contain" ||
          step.type === "test_expect_equal"
        ) {
          if (!inScope.has(step.variable)) {
            diag.error(
              ast.filePath,
              step.loc.line,
              step.loc.col,
              "E_VALIDATE",
              `${step.type.replace("test_", "")}: undefined name "${step.variable}" (capture it first with: const ${step.variable} = run …)`,
            );
          }
          const refName =
            step.type === "test_expect_equal"
              ? step.expectedVar
              : step.substringVar;
          if (refName !== undefined && !inScope.has(refName)) {
            diag.error(
              ast.filePath,
              step.loc.line,
              step.loc.col,
              "E_VALIDATE",
              `${step.type.replace("test_", "")}: undefined name "${refName}" (declare it earlier with: const ${refName} = "…")`,
            );
          }
        }
      });
    }
  }
}
