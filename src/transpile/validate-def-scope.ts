import type { Def, Expr } from "../types";
import { validatePromptDefBody } from "./validate-prompt-def";
import {
  DEF_SCOPE,
  localDeclName,
  localSymFromDecl,
  parseSchemaFieldNames,
  refCtxWithLocals,
  validateStep,
  type LocalSym,
  type ValidatorCtx,
} from "./validate-step";

// The single recursive, block-scoped descent that validates one def's step
// tree. Split out of `validate.ts` so that file stays a thin orchestrator (and
// under the agent-analyzability line cap); this is the only recursive helper
// walking `StepDef[]` in the validator. Each `if` / `else` / `for` / `catch` /
// `recover` body is its own lexical scope: a nested `script` / `def` / `prompt`
// / `const` / capture / iterator is visible only inside the body that declares
// it and only after its declaration, and may shadow an enclosing binding for
// the rest of that body. This replaces the old flat-list walk, which hoisted
// every in-branch declaration to the whole def and so accepted a `run` /
// `${…}` after a branch that would be undefined when the branch was not taken.

/**
 * Per-module immutable context handed to {@link validateDef}. `baseCtx` is a
 * {@link ValidatorCtx} minus the fields that vary per step / per lexical scope.
 * `moduleScripts` is the module-level script set — a nested decl may shadow one,
 * a `const` / capture may not. `resolvePromptReturns` resolves a module-level
 * named prompt's `returns` schema (nested prompts resolve from the scope first).
 */
export type BaseDefCtx = Omit<
  ValidatorCtx,
  "scope" | "knownVars" | "promptSchemas" | "promptCaptures" | "forwardConsts" | "recoverBindings"
>;

export interface DefScopeModuleCtx {
  baseCtx: BaseDefCtx;
  moduleScripts: Set<string>;
  resolvePromptReturns: (ref: string) => string | undefined;
}

/**
 * One lexical block scope. A def body is the root scope; each `if` / `else` /
 * `for` / `catch` / `recover` body is a child. Every field holds only what THIS
 * scope introduced so far (sequential); the "visible at a step" set is the union
 * up the parent chain, with an inner scope shadowing an ancestor.
 */
interface LexScope {
  parent?: LexScope;
  /** Identifiers declared so far in this scope: `const`s, captures, iterators, seeded params/env. */
  vars: Set<string>;
  /** Nested `script` / `def` / `prompt` decls declared so far in this scope. */
  locals: Map<string, LocalSym>;
  /** Typed prompt captures (name → returns fields) declared so far in this scope. */
  promptSchemas: Map<string, string[]>;
  /** Prompt-result captures (typed or untyped) declared so far in this scope. */
  promptCaptures: Set<string>;
  /** Rebind-conflict bindings introduced in this scope (params, consts, captures, decls, iterators). */
  bindings: Map<string, { kind: string; line: number }>;
  /** `const`s declared later in this scope, not yet reached (forward-reference set). */
  pending: Set<string>;
}

function childScope(parent: LexScope): LexScope {
  return {
    parent,
    vars: new Set(),
    locals: new Map(),
    promptSchemas: new Map(),
    promptCaptures: new Set(),
    bindings: new Map(),
    pending: new Set(),
  };
}

/** Union of a set-valued field up the scope chain. */
function flatVars(scope: LexScope): Set<string> {
  const out = new Set<string>();
  for (let c: LexScope | undefined = scope; c; c = c.parent) {
    for (const v of c.vars) out.add(v);
  }
  return out;
}

function flatPromptCaptures(scope: LexScope): Set<string> {
  const out = new Set<string>();
  for (let c: LexScope | undefined = scope; c; c = c.parent) {
    for (const v of c.promptCaptures) out.add(v);
  }
  return out;
}

function flatPending(scope: LexScope): Set<string> {
  const out = new Set<string>();
  for (let c: LexScope | undefined = scope; c; c = c.parent) {
    for (const v of c.pending) out.add(v);
  }
  return out;
}

/** Merge a map-valued field up the chain, inner scope (leaf) winning on a name clash. */
function flatLocals(scope: LexScope): Map<string, LocalSym> {
  const out = new Map<string, LocalSym>();
  for (let c: LexScope | undefined = scope; c; c = c.parent) {
    for (const [k, v] of c.locals) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

function flatPromptSchemas(scope: LexScope): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let c: LexScope | undefined = scope; c; c = c.parent) {
    for (const [k, v] of c.promptSchemas) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

function bindingInChain(scope: LexScope, name: string): boolean {
  for (let c: LexScope | undefined = scope; c; c = c.parent) {
    if (c.bindings.has(name)) return true;
  }
  return false;
}

/**
 * Validate one def (top-level or nested) as its own lexical root scope. Nested
 * defs recurse with the enclosing visible identifiers (closure over params /
 * `const`s declared before the nested `def`) and the visible nested decls.
 */
export function validateDef(
  def: Def,
  mod: DefScopeModuleCtx,
  inheritedKnownVars: Set<string>,
  inheritedLocals: Map<string, LocalSym>,
): void {
  const { baseCtx, moduleScripts, resolvePromptReturns } = mod;
  const diag = baseCtx.diag;
  const filePath = baseCtx.ast.filePath;

  // Non-throwing rebind report: record the diagnostic but keep validating, so a
  // rebind never suppresses the rest of the def and the collector sees the full
  // set. `allowModuleShadow` skips the module-script collision (a nested decl
  // may shadow one; a `const` / capture may not).
  const checkBinding = (
    scope: LexScope,
    name: string,
    kind: string,
    loc: { line: number; col: number },
    allowModuleShadow: boolean,
  ): void => {
    const prev = scope.bindings.get(name);
    if (prev) {
      diag.add({
        file: filePath,
        line: loc.line,
        col: loc.col,
        code: "E_VALIDATE",
        message: `cannot rebind immutable name "${name}"; already bound as ${prev.kind} at ${filePath}:${prev.line}`,
        fatal: false,
      });
    } else if (!allowModuleShadow && moduleScripts.has(name)) {
      diag.add({
        file: filePath,
        line: loc.line,
        col: loc.col,
        code: "E_VALIDATE",
        message: `cannot rebind immutable name "${name}"; already bound as script in this module`,
        fatal: false,
      });
    }
    scope.bindings.set(name, { kind, line: loc.line });
  };

  const stepCtx = (scope: LexScope, recoverBindings: Set<string> | undefined): ValidatorCtx => {
    const refCtx = refCtxWithLocals(baseCtx.refCtx, flatLocals(scope));
    return {
      ...baseCtx,
      scope: DEF_SCOPE,
      knownVars: flatVars(scope),
      promptSchemas: flatPromptSchemas(scope),
      promptCaptures: flatPromptCaptures(scope),
      forwardConsts: flatPending(scope),
      refCtx,
      localScripts: refCtx.localScripts,
      localDefs: refCtx.localDefs,
      recoverBindings,
    };
  };

  // The effective `returns` schema of a prompt expr: a nested named prompt
  // resolves from the visible scope first (so a `returns` prompt declared inside
  // a branch is typed only there), then the module-level resolver; an inline
  // prompt carries its own `returns`.
  const promptReturns = (
    expr: Extract<Expr, { kind: "prompt" }>,
    scope: LexScope,
  ): string | undefined => {
    if (expr.name !== undefined) {
      const local = flatLocals(scope).get(expr.name);
      if (local?.kind === "prompt") return local.prompt.returns;
      return resolvePromptReturns(expr.name);
    }
    return expr.returns;
  };

  const descend = (
    steps: Def["steps"],
    scope: LexScope,
    recoverBindings: Set<string> | undefined,
  ): void => {
    // Forward-reference set for this body: a `const` naming rule / TDZ message
    // needs the not-yet-declared `const`s of the current scope.
    for (const s of steps) if (s.type === "const") scope.pending.add(s.name);

    for (const s of steps) {
      if (s.type === "trivia") continue;

      if (s.type === "const") {
        checkBinding(scope, s.name, "const", s.loc, false);
        // A `const` is visible in its own RHS (self-reference behavior unchanged).
        scope.vars.add(s.name);
        scope.pending.delete(s.name);
        if (s.value.kind === "prompt") {
          scope.promptCaptures.add(s.name);
          const ret = promptReturns(s.value, scope);
          if (ret !== undefined) scope.promptSchemas.set(s.name, parseSchemaFieldNames(ret));
        }
        diag.capture(() => validateStep(s, stepCtx(scope, recoverBindings)));
        continue;
      }

      if (s.type === "local_decl") {
        const name = localDeclName(s.decl);
        // A nested decl MAY shadow a module-level script/def/prompt, so the
        // module-script collision check is skipped (unlike a `const`).
        checkBinding(scope, name, s.decl.kind, s.loc, true);
        // A nested def / prompt body closes over the enclosing names visible at
        // this declaration point — snapshot them before registering the decl.
        const inheritedKnownVars = flatVars(scope);
        if (s.decl.kind === "def") {
          validateDef(s.decl.def, mod, inheritedKnownVars, flatLocals(scope));
        } else if (s.decl.kind === "prompt") {
          validatePromptDefBody(diag, filePath, s.decl.prompt, inheritedKnownVars);
        }
        // Nested scripts need no body validation (module scripts don't either).
        scope.locals.set(name, localSymFromDecl(s.decl));
        continue;
      }

      if (s.type === "exec") {
        if (s.captureName) {
          const captureLoc = execBodyLoc(s.body) ?? s.loc;
          checkBinding(scope, s.captureName, "capture", captureLoc, false);
          scope.vars.add(s.captureName);
          if (s.body.kind === "prompt") {
            scope.promptCaptures.add(s.captureName);
            const ret = promptReturns(s.body, scope);
            if (ret !== undefined) scope.promptSchemas.set(s.captureName, parseSchemaFieldNames(ret));
          }
        }
        diag.capture(() => validateStep(s, stepCtx(scope, recoverBindings)));
        if (s.catch) {
          const catchSteps = "single" in s.catch ? [s.catch.single] : s.catch.block;
          descend(catchSteps, childScope(scope), new Set([s.catch.bindings.failure]));
        }
        if (s.recover) {
          const recoverSteps = "single" in s.recover ? [s.recover.single] : s.recover.block;
          descend(recoverSteps, childScope(scope), new Set([s.recover.bindings.failure]));
        }
        continue;
      }

      if (s.type === "if") {
        // Subject / operand are evaluated in the enclosing scope, before the body.
        diag.capture(() => validateStep(s, stepCtx(scope, recoverBindings)));
        descend(s.body, childScope(scope), recoverBindings);
        if (s.elseBody) descend(s.elseBody, childScope(scope), recoverBindings);
        continue;
      }

      if (s.type === "for_lines") {
        // Source var resolves in the enclosing scope; the iterator lives only in
        // the loop body.
        diag.capture(() => validateStep(s, stepCtx(scope, recoverBindings)));
        if (bindingInChain(scope, s.iterVar)) {
          diag.add({
            file: filePath,
            line: s.loc.line,
            col: s.loc.col,
            code: "E_VALIDATE",
            message: `for loop iterator "${s.iterVar}" conflicts with an existing binding`,
            fatal: false,
          });
        }
        const body = childScope(scope);
        body.vars.add(s.iterVar);
        body.bindings.set(s.iterVar, { kind: "loop_iterator", line: s.loc.line });
        descend(s.body, body, recoverBindings);
        continue;
      }

      // return / send / say
      diag.capture(() => validateStep(s, stepCtx(scope, recoverBindings)));
    }
  };

  const envNames = (baseCtx.ast.envDecls ?? []).map((e) => e.name);
  const root: LexScope = {
    vars: new Set<string>([...inheritedKnownVars, ...envNames, ...def.params]),
    locals: new Map(inheritedLocals),
    promptSchemas: new Map(),
    promptCaptures: new Set(),
    bindings: new Map(def.params.map((p) => [p, { kind: "parameter", line: def.loc.line }])),
    pending: new Set(),
  };
  descend(def.steps, root, undefined);
}

/** Best-effort location for an exec body — used to attribute capture-binding errors. */
function execBodyLoc(body: Expr): { line: number; col: number } | undefined {
  if (body.kind === "call") return body.callee.loc;
  if (body.kind === "prompt" || body.kind === "shell") return body.loc;
  if (body.kind === "match") return body.match.loc;
  return undefined;
}
