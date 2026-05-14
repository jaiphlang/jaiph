import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parsejaiph } from "./parser";
import { buildScripts as buildScriptsImpl, walkTestFiles } from "./transpile/build";
import type { CompilePrep } from "./transpile/compile-prep";
import { buildScriptFiles, type ScriptArtifact } from "./transpile/emit-script";
import { resolveImportPath, workflowSymbolForFile } from "./transpile/resolve";
import { resolveScriptImportPath, validateReferences } from "./transpile/validate";

export { resolveImportPath, workflowSymbolForFile } from "./transpile/resolve";
export type { ScriptArtifact } from "./transpile/emit-script";
export type { CompilePrep } from "./transpile/compile-prep";

/**
 * Parse, validate, and extract per-`script` bash files for one module (no workflow bash emission).
 * When `prep` is supplied, reuses already-parsed ASTs instead of re-reading from disk.
 */
export function emitScriptsForModule(
  inputFile: string,
  rootDir: string,
  workspaceRoot?: string,
  prep?: CompilePrep,
): ScriptArtifact[] {
  const cachedAst = prep?.astByFile.get(inputFile);
  const ast = cachedAst ?? parsejaiph(readFileSync(inputFile, "utf8"), inputFile);
  const readFile = prep
    ? (path: string): string => (prep.astByFile.has(path) ? "" : readFileSync(path, "utf8"))
    : (path: string): string => readFileSync(path, "utf8");
  const parse = prep
    ? (content: string, filePath: string) =>
        prep.astByFile.get(filePath) ?? parsejaiph(content, filePath)
    : parsejaiph;
  validateReferences(ast, {
    resolveImportPath,
    existsSync,
    readFile,
    parse,
    workspaceRoot,
  });
  const workflowSymbol = workflowSymbolForFile(inputFile, rootDir);
  const importedWorkflowSymbols = new Map<string, string>();
  for (const imp of ast.imports) {
    const importedFile = resolveImportPath(ast.filePath, imp.path, workspaceRoot);
    importedWorkflowSymbols.set(imp.alias, workflowSymbolForFile(importedFile, rootDir));
  }
  // Resolve script imports: read external script files so they are emitted as artifacts.
  let resolvedScriptImports: Map<string, string> | undefined;
  if (ast.scriptImports && ast.scriptImports.length > 0) {
    resolvedScriptImports = new Map();
    for (const si of ast.scriptImports) {
      const resolved = resolveScriptImportPath(ast.filePath, si.path);
      resolvedScriptImports.set(si.alias, readFileSync(resolved, "utf8"));
    }
  }
  return buildScriptFiles(ast, importedWorkflowSymbols, workflowSymbol, resolvedScriptImports);
}

export { walkTestFiles };

export function buildScripts(
  inputPath: string,
  targetDir?: string,
  workspaceRoot?: string,
  prep?: CompilePrep,
): { scriptsDir: string } {
  const emitFn = (file: string, root: string) => emitScriptsForModule(file, root, workspaceRoot, prep);
  return buildScriptsImpl(inputPath, targetDir, emitFn, workspaceRoot, prep);
}
