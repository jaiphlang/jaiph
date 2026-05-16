import { readFileSync } from "node:fs";
import type { ModuleGraph } from "./module-graph";
import { buildScriptFiles, type ScriptArtifact } from "./emit-script";
import { workflowSymbolForFile } from "./resolve";
import { resolveScriptImportPath, validateModule } from "./validate";

/**
 * Parse, validate, and extract per-`script` bash files for one module in the
 * graph. Operates entirely on in-memory ASTs from `graph`; `.jh` files are
 * never re-read. External `import script` bodies still come from disk (they
 * are not `.jh`).
 */
export function emitScriptsForModuleFromGraph(
  graph: ModuleGraph,
  inputFile: string,
  rootDir: string,
): ScriptArtifact[] {
  const node = graph.modules.get(inputFile);
  if (!node) {
    throw new Error(`emitScriptsForModule: ${inputFile} is not in the graph`);
  }
  const ast = node.ast;
  validateModule(ast, graph);
  const workflowSymbol = workflowSymbolForFile(inputFile, rootDir);
  const importedWorkflowSymbols = new Map<string, string>();
  for (const [alias, importedFile] of node.imports) {
    importedWorkflowSymbols.set(alias, workflowSymbolForFile(importedFile, rootDir));
  }
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
