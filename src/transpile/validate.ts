import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Diagnostics } from "../diagnostics";
import type { Expr, jaiphModule, StepDef } from "../types";
import type { ModuleGraph } from "./module-graph";
import { validateRef } from "./validate-ref-resolution";
import {
  parseSchemaFieldNames,
  resolveRouteTargetParams,
  ROUTE_REF_EXPECT,
  validateStep,
  DEF_SCOPE,
  type ValidatorCtx,
} from "./validate-step";
import { validateConfigInto } from "./validate-config";
import { validateTestBlocks } from "./validate-tests";

/**
 * One step entry in the flat list built by the single workflow walk.
 *
 * `recoverBindings` is the `Set` of failure-binding names contributed by an
 * enclosing `catch` / `recover`, threaded down so steps inside a recovery
 * body can resolve `<failure>` as an in-scope identifier.
 */
interface FlatStepEntry {
  step: StepDef;
  recoverBindings: Set<string> | undefined;
}

/**
 * Result of the single recursive descent over a workflow's / rule's step
 * tree: the global identifier set (envDecls + params + every nested const /
 * capture / for-iterator), the top-level prompt schemas, and a flat list of
 * every step in tree order. The flat list is what the main validator loop
 * iterates over — that loop is non-recursive, so the only recursive helper
 * walking `StepDef[]` in this file is `walkStepTree` itself.
 */
interface StepTreeWalk {
  knownVars: Set<string>;
  promptSchemas: Map<string, string[]>;
  /** All variables bound to a prompt result — typed and untyped, const or exec-capture. */
  promptCaptures: Set<string>;
  flat: FlatStepEntry[];
}

function walkStepTree(
  diag: Diagnostics,
  filePath: string,
  steps: StepDef[],
  envDecls: { name: string; loc: { line: number; col: number } }[] | undefined,
  params: string[],
  declLoc: { line: number; col: number },
  moduleScripts: Set<string>,
  options: { withPromptSchemas: boolean },
): StepTreeWalk {
  const knownVars = new Set<string>();
  const promptSchemas = new Map<string, string[]>();
  const promptCaptures = new Set<string>();
  const flat: FlatStepEntry[] = [];

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
        checkBinding(s.name, "const", s.loc, bindings);
        if (s.value.kind === "prompt") {
          promptCaptures.add(s.name);
          if (options.withPromptSchemas && topLevel && s.value.returns !== undefined) {
            promptSchemas.set(s.name, parseSchemaFieldNames(s.value.returns));
          }
        }
        continue;
      }

      if (s.type === "exec") {
        if (s.captureName) {
          knownVars.add(s.captureName);
          const captureLoc = execBodyLoc(s.body) ?? s.loc;
          checkBinding(s.captureName, "capture", captureLoc, bindings);
          if (s.body.kind === "prompt") {
            promptCaptures.add(s.captureName);
            if (options.withPromptSchemas && topLevel && s.body.returns !== undefined) {
              promptSchemas.set(s.captureName, parseSchemaFieldNames(s.body.returns));
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
  return { knownVars, promptSchemas, promptCaptures, flat };
}

/** Best-effort location for an exec body — used to attribute capture-binding errors. */
function execBodyLoc(body: Expr): { line: number; col: number } | undefined {
  if (body.kind === "call") return body.callee.loc;
  if (body.kind === "prompt" || body.kind === "shell") return body.loc;
  if (body.kind === "match") return body.match.loc;
  return undefined;
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

/** `main` is reserved as the run entry: if present, it must be `export def main`. */
function validateMainReservation(diag: Diagnostics, ast: jaiphModule): void {
  const scriptMain = ast.scripts.find((s) => s.name === "main");
  if (scriptMain) {
    diag.error(
      ast.filePath,
      scriptMain.loc.line,
      scriptMain.loc.col,
      "E_VALIDATE",
      '`main` is reserved as the run entry; use `export def main(...)`',
    );
  }
  const defMain = ast.defs.find((w) => w.name === "main");
  if (!defMain) return;
  if (!ast.exports.includes("main")) {
    diag.error(
      ast.filePath,
      defMain.loc.line,
      defMain.loc.col,
      "E_VALIDATE",
      '`main` must be exported: export def main(...)',
    );
  }
}

export function validateModuleInto(
  ast: jaiphModule,
  graph: ModuleGraph,
  diag: Diagnostics,
): void {
  const localChannels = new Set(ast.channels.map((c) => c.name));
  const localDefs = new Set(ast.defs.map((w) => w.name));
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

  const refCtx = {
    importsByAlias,
    importedAstCache,
    localDefs,
    localScripts,
  };

  const baseCtx = {
    diag,
    ast,
    refCtx,
    localChannels,
    localScripts,
    localDefs,
    importsByAlias,
    importedAstCache,
  } as const;

  validateConfigInto(ast, diag);

  diag.capture(() => {
    validateMainReservation(diag, ast);
  });

  for (const ch of ast.channels) {
    if (!ch.routes) continue;
    for (const wfRef of ch.routes) {
      diag.capture(() => {
        validateRef(wfRef, ast, refCtx, { mode: "expect", expect: ROUTE_REF_EXPECT });
        const targetParams = resolveRouteTargetParams(wfRef.value, ast, refCtx);
        if (targetParams !== undefined && (targetParams < 1 || targetParams > 3)) {
          diag.error(
            ast.filePath,
            wfRef.loc.line,
            wfRef.loc.col,
            "E_VALIDATE",
            `inbox route target "${wfRef.value}" must declare 1 to 3 parameters (message, channel, sender), but declares ${targetParams}`,
          );
        }
      });
    }
  }

  for (const workflow of ast.defs) {
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
        { withPromptSchemas: true },
      );
    });
    if (!wfWalk) continue;
    const ctx: ValidatorCtx = {
      ...baseCtx,
      scope: DEF_SCOPE,
      knownVars: wfWalk.knownVars,
      promptSchemas: wfWalk.promptSchemas,
      promptCaptures: wfWalk.promptCaptures,
      recoverBindings: undefined,
    };
    for (const entry of wfWalk.flat) {
      diag.capture(() => validateStep(entry.step, { ...ctx, recoverBindings: entry.recoverBindings }));
    }
  }

  if (ast.tests && ast.tests.length > 0) {
    validateTestBlocks(diag, ast, ast.tests);
  }
}
