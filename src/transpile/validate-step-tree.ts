import type { Diagnostics } from "../diagnostics";
import type { Expr, StepDef } from "../types";
import { localDeclName } from "./validate-local-decl";
import { parseSchemaFieldNames } from "./validate-step-helpers";

// The single recursive descent over a def's step tree. Produces the flat step
// list the (non-recursive) validation loop iterates, plus the def-wide binding
// sets it consults. Split out of `validate.ts` so that file stays under the
// agent-analyzability line cap; `walkStepTree` is the only recursive helper
// walking `StepDef[]`.

/**
 * One step entry in the flat list built by the single workflow walk.
 *
 * `recoverBindings` is the `Set` of failure-binding names contributed by an
 * enclosing `catch` / `recover`, threaded down so steps inside a recovery
 * body can resolve `<failure>` as an in-scope identifier.
 */
export interface FlatStepEntry {
  step: StepDef;
  recoverBindings: Set<string> | undefined;
}

/**
 * Result of the single recursive descent over a workflow's / rule's step
 * tree: the global identifier set (envDecls + params + every nested const /
 * capture / for-iterator), the top-level prompt schemas, and a flat list of
 * every step in tree order. The flat list is what the main validator loop
 * iterates over — that loop is non-recursive, so the only recursive helper
 * walking `StepDef[]` is `walkStepTree` itself.
 */
export interface StepTreeWalk {
  knownVars: Set<string>;
  promptSchemas: Map<string, string[]>;
  /** All variables bound to a prompt result — typed and untyped, const or exec-capture. */
  promptCaptures: Set<string>;
  /**
   * Every `const` name bound anywhere in this def's step tree. Used by the
   * validation loop to enforce sequential visibility: a `const` is in
   * `knownVars` for lookups only once its declaration has been reached, so a
   * `${name}` / bare-arg / `if`-`match` subject naming a not-yet-declared
   * `const` is rejected as an unknown identifier (same as `run`/`prompt`
   * targets via `localsSoFar`).
   */
  constNames: Set<string>;
  flat: FlatStepEntry[];
}

export function walkStepTree(
  diag: Diagnostics,
  filePath: string,
  steps: StepDef[],
  envDecls: { name: string; loc: { line: number; col: number } }[] | undefined,
  params: string[],
  declLoc: { line: number; col: number },
  moduleScripts: Set<string>,
  options: {
    withPromptSchemas: boolean;
    /** Resolve a named-prompt call's returns schema (its schema lives on the def). */
    resolvePromptReturns?: (ref: string) => string | undefined;
    /** Names visible from an enclosing def (closure): its params + `const`s. */
    inheritedKnownVars?: Set<string>;
  },
): StepTreeWalk {
  const knownVars = new Set<string>();
  const promptSchemas = new Map<string, string[]>();
  const promptCaptures = new Set<string>();
  const constNames = new Set<string>();
  const flat: FlatStepEntry[] = [];

  if (options.inheritedKnownVars) {
    for (const v of options.inheritedKnownVars) knownVars.add(v);
  }
  if (envDecls) {
    for (const d of envDecls) knownVars.add(d.name);
  }
  for (const p of params) knownVars.add(p);

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
    ss: StepDef[],
    bindings: Map<string, { kind: string; line: number }>,
    recoverBindings: Set<string> | undefined,
    topLevel: boolean,
  ): void => {
    for (const s of ss) {
      flat.push({ step: s, recoverBindings });

      if (s.type === "const") {
        knownVars.add(s.name);
        constNames.add(s.name);
        checkBinding(s.name, "const", s.loc, bindings);
        if (s.value.kind === "prompt") {
          promptCaptures.add(s.name);
          const ret = promptExprReturns(s.value, options.resolvePromptReturns);
          if (options.withPromptSchemas && topLevel && ret !== undefined) {
            promptSchemas.set(s.name, parseSchemaFieldNames(ret));
          }
        }
        continue;
      }

      if (s.type === "local_decl") {
        const name = localDeclName(s.decl);
        const prev = bindings.get(name);
        if (prev) {
          diag.error(
            filePath,
            s.loc.line,
            s.loc.col,
            "E_VALIDATE",
            `cannot rebind immutable name "${name}"; already bound as ${prev.kind} at ${filePath}:${prev.line}`,
          );
        }
        // A nested declaration MAY shadow a module-level script/def/prompt, so
        // unlike `checkBinding` the module-script collision check is skipped.
        bindings.set(name, { kind: s.decl.kind, line: s.loc.line });
        // Do not descend into a nested def body — it is validated as its own
        // scope by `validateDefTree`.
        continue;
      }

      if (s.type === "exec") {
        if (s.captureName) {
          knownVars.add(s.captureName);
          const captureLoc = execBodyLoc(s.body) ?? s.loc;
          checkBinding(s.captureName, "capture", captureLoc, bindings);
          if (s.body.kind === "prompt") {
            promptCaptures.add(s.captureName);
            const ret = promptExprReturns(s.body, options.resolvePromptReturns);
            if (options.withPromptSchemas && topLevel && ret !== undefined) {
              promptSchemas.set(s.captureName, parseSchemaFieldNames(ret));
            }
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
        if (s.elseBody) {
          descend(s.elseBody, bindings, recoverBindings, false);
        }
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
  return { knownVars, promptSchemas, promptCaptures, constNames, flat };
}

/** The effective returns schema of a prompt expr: on the def for a named call, inline otherwise. */
function promptExprReturns(
  expr: Extract<Expr, { kind: "prompt" }>,
  resolvePromptReturns?: (ref: string) => string | undefined,
): string | undefined {
  if (expr.name !== undefined) return resolvePromptReturns?.(expr.name);
  return expr.returns;
}

/** Best-effort location for an exec body — used to attribute capture-binding errors. */
function execBodyLoc(body: Expr): { line: number; col: number } | undefined {
  if (body.kind === "call") return body.callee.loc;
  if (body.kind === "prompt" || body.kind === "shell") return body.loc;
  if (body.kind === "match") return body.match.loc;
  return undefined;
}
