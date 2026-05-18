import type { ModuleGraph } from "./transpile/module-graph";
import { loadModuleGraph } from "./transpile/module-graph";
import { buildScripts as buildScriptsImpl, buildScriptsFromGraph as buildScriptsFromGraphImpl, walkTestFiles } from "./transpile/build";
import { emitScriptsForModuleFromGraph } from "./transpile/emit-from-graph";
import type { ScriptArtifact } from "./transpile/emit-script";

export { resolveImportPath, workflowSymbolForFile } from "./transpile/resolve";
export type { ScriptArtifact } from "./transpile/emit-script";
export type { ModuleGraph, ModuleNode } from "./transpile/module-graph";
export { loadModuleGraph } from "./transpile/module-graph";
export { emitScriptsForModuleFromGraph } from "./transpile/emit-from-graph";

/**
 * Path-based wrapper for callers that don't already have a graph (tests and
 * legacy entry points). Loads a single-entry graph and emits scripts for the
 * entry module. Imported modules are validated transitively as part of the
 * shared graph but their script bodies are not emitted from this call.
 */
export function emitScriptsForModule(
  inputFile: string,
  rootDir: string,
  workspaceRoot?: string,
): ScriptArtifact[] {
  const graph = loadModuleGraph(inputFile, workspaceRoot);
  return emitScriptsForModuleFromGraph(graph, graph.entryFile, rootDir);
}

export { walkTestFiles };

/**
 * Path-based wrapper. Loads the module graph and emits per-script bash files
 * for every reachable module (file entry) or every non-test `.jh` under the
 * directory (directory entry). Kept for tests and the `jaiph test` path.
 */
export function buildScripts(
  inputPath: string,
  targetDir?: string,
  workspaceRoot?: string,
): { scriptsDir: string } {
  return buildScriptsImpl(inputPath, targetDir, workspaceRoot);
}

/**
 * Graph-based entry point. Used by `jaiph run` where the parent CLI already
 * built the graph and wants to skip a second discovery walk.
 */
export function buildScriptsFromGraph(
  graph: ModuleGraph,
  targetDir: string,
): { scriptsDir: string } {
  return buildScriptsFromGraphImpl(graph, targetDir);
}
