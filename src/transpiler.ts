import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { jaiphError } from "./errors";
import { parsejaiph } from "./parser";
import type { CompileResult } from "./types";
import { build as buildImpl, buildScripts as buildScriptsImpl, walkTestFiles } from "./transpile/build";
import { emitWorkflow, type EmittedModule, type JaiphSourceLineMapEntry } from "./transpile/emit-workflow";
import {
  JAIPH_EXT_REGEX,
  resolveImportPath,
  toImportSource,
  workflowSymbolForFile,
} from "./transpile/resolve";
import { validateReferences } from "./transpile/validate";

export { resolveImportPath, workflowSymbolForFile } from "./transpile/resolve";
export type { EmittedModule, JaiphSourceLineMapEntry };

function computeJaiphScriptsRelFromModuleDir(inputFile: string, rootDir: string): string {
  const relFile = relative(rootDir, inputFile);
  const moduleOutPath = join(rootDir, relFile.replace(JAIPH_EXT_REGEX, ".sh"));
  const moduleDir = dirname(moduleOutPath);
  const scriptsDir = join(rootDir, "scripts");
  let rel = relative(moduleDir, scriptsDir);
  if (!rel) rel = ".";
  return rel.split(sep).join("/");
}

export function transpileFile(inputFile: string, rootDir: string): EmittedModule {
  const ast = parsejaiph(readFileSync(inputFile, "utf8"), inputFile);
  validateReferences(ast, {
    resolveImportPath,
    existsSync,
    readFile: (path: string) => readFileSync(path, "utf8"),
    parse: parsejaiph,
  });
  const workflowSymbol = workflowSymbolForFile(inputFile, rootDir);
  const importedWorkflowSymbols = new Map<string, string>();
  const importSourcePaths: string[] = [];
  const importedModuleHasMetadata = new Map<string, boolean>();
  const importedScriptNames = new Map<string, Set<string>>();
  for (const imp of ast.imports) {
    const importedFile = resolveImportPath(ast.filePath, imp.path);
    importedWorkflowSymbols.set(imp.alias, workflowSymbolForFile(importedFile, rootDir));
    importSourcePaths.push(toImportSource(imp.path, inputFile, rootDir));
    const importedAst = parsejaiph(readFileSync(importedFile, "utf8"), importedFile);
    importedModuleHasMetadata.set(imp.alias, importedAst.metadata !== undefined);
    importedScriptNames.set(imp.alias, new Set(importedAst.scripts.map((s) => s.name)));
  }
  const jaiphScriptsRel = computeJaiphScriptsRelFromModuleDir(inputFile, rootDir);
  return emitWorkflow(
    ast,
    workflowSymbol,
    importedWorkflowSymbols,
    importSourcePaths,
    importedModuleHasMetadata,
    importedScriptNames,
    jaiphScriptsRel,
  );
}

export { walkTestFiles };

export function build(inputPath: string, targetDir?: string): CompileResult[] {
  return buildImpl(inputPath, targetDir, transpileFile);
}

export function buildScripts(inputPath: string, targetDir?: string): { scriptsDir: string } {
  return buildScriptsImpl(inputPath, targetDir, transpileFile);
}
