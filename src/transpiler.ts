import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { jaiphError } from "./errors";
import { parsejaiph } from "./parser";
import type { CompileResult } from "./types";
import { build as buildImpl, walkTestFiles } from "./transpile/build";
import { emitTest } from "./transpile/emit-test";
import { emitWorkflow, type EmittedModule } from "./transpile/emit-workflow";
import {
  JAIPH_EXT_REGEX,
  resolveImportPath,
  toImportSource,
  workflowSymbolForFile,
} from "./transpile/resolve";
import { validateReferences, validateTestReferences } from "./transpile/validate";

export { resolveImportPath, workflowSymbolForFile } from "./transpile/resolve";
export type { EmittedModule };

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

/**
 * Transpiles a *.test.jh file to a bash script that runs each test block and reports PASS/FAIL.
 * Imported modules must already be built to .sh in the same output directory.
 */
export function transpileTestFile(inputFile: string, rootDir: string): string {
  const ast = parsejaiph(readFileSync(inputFile, "utf8"), inputFile);
  if (!ast.tests || ast.tests.length === 0) {
    throw jaiphError(ast.filePath, 1, 1, "E_PARSE", "test file must contain at least one test block");
  }
  validateTestReferences(ast, {
    resolveImportPath,
    existsSync,
    readFile: (path: string) => readFileSync(path, "utf8"),
    parse: parsejaiph,
  });
  const importedWorkflowSymbols = new Map<string, string>();
  const importSourcePaths: string[] = [];
  for (const imp of ast.imports) {
    const importedFile = resolveImportPath(ast.filePath, imp.path);
    importedWorkflowSymbols.set(imp.alias, workflowSymbolForFile(importedFile, rootDir));
    importSourcePaths.push(toImportSource(imp.path, inputFile, rootDir));
  }
  return emitTest(ast, importedWorkflowSymbols, importSourcePaths);
}

export { walkTestFiles };

export function build(inputPath: string, targetDir?: string): CompileResult[] {
  return buildImpl(inputPath, targetDir, transpileFile);
}
