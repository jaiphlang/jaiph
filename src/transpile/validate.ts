import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Diagnostics } from "../diagnostics";
import type { jaiphModule } from "../types";
import type { ModuleGraph } from "./module-graph";
import {
  resolveRouteTargetParams,
  ROUTE_REF_EXPECT,
  resolvePromptDef,
  validateRef,
} from "./validate-step";
import { validateDef, type DefScopeModuleCtx } from "./validate-def-scope";
import { validateConfigInto } from "./validate-config";
import { validateTestBlocks } from "./validate-tests";
import { validatePromptDefs } from "./validate-prompt-def";

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
  const localPrompts = new Set((ast.prompts ?? []).map((p) => p.name));
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
    localPrompts,
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
  };

  const resolvePromptReturns = (ref: string): string | undefined =>
    resolvePromptDef(ref, ast, refCtx)?.returns;

  validatePromptDefs(diag, ast);

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

  const modCtx: DefScopeModuleCtx = {
    baseCtx,
    moduleScripts: localScripts,
    resolvePromptReturns,
  };

  for (const workflow of ast.defs) {
    validateDef(workflow, modCtx, new Set(), new Map());
  }

  if (ast.tests && ast.tests.length > 0) {
    validateTestBlocks(diag, ast, ast.tests);
  }
}
