import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parsejaiph } from "./parser";
import { buildScripts as buildScriptsImpl, walkTestFiles } from "./transpile/build";
import { buildScriptFiles, type ScriptArtifact } from "./transpile/emit-script";
import { resolveImportPath, workflowSymbolForFile } from "./transpile/resolve";
import { validateReferences } from "./transpile/validate";

export { resolveImportPath, workflowSymbolForFile } from "./transpile/resolve";
export type { ScriptArtifact } from "./transpile/emit-script";

/**
 * Parse, validate, and extract per-`script` bash files for one module (no workflow bash emission).
 */
export function emitScriptsForModule(inputFile: string, rootDir: string, workspaceRoot?: string): ScriptArtifact[] {
  const ast = parsejaiph(readFileSync(inputFile, "utf8"), inputFile);
  validateReferences(ast, {
    resolveImportPath,
    existsSync,
    readFile: (path: string) => readFileSync(path, "utf8"),
    parse: parsejaiph,
    workspaceRoot,
  });
  const workflowSymbol = workflowSymbolForFile(inputFile, rootDir);
  const importedWorkflowSymbols = new Map<string, string>();
  for (const imp of ast.imports) {
    const importedFile = resolveImportPath(ast.filePath, imp.path, workspaceRoot);
    importedWorkflowSymbols.set(imp.alias, workflowSymbolForFile(importedFile, rootDir));
  }
  return buildScriptFiles(ast, importedWorkflowSymbols, workflowSymbol);
}

export { walkTestFiles };

export function buildScripts(inputPath: string, targetDir?: string, workspaceRoot?: string): { scriptsDir: string } {
  const emitFn = (file: string, root: string) => emitScriptsForModule(file, root, workspaceRoot);
  return buildScriptsImpl(inputPath, targetDir, emitFn, workspaceRoot);
}
