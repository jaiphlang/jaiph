import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { jaiphError } from "../errors";
import { parsejaiph } from "../parser";
import { resolveImportPath } from "./resolve";
import type { jaiphModule } from "../types";

/**
 * `ModuleGraph` is the single representation of "all `.jh` modules reachable
 * from an entry point, parsed once." `loadModuleGraph` is the only routine
 * that reads and parses `.jh` sources; `validateReferences` and the script
 * emitter both consume the graph without touching the filesystem for source
 * or AST reads.
 */

export interface ModuleNode {
  filePath: string;
  ast: jaiphModule;
  /** alias → resolved absolute path of imported `.jh` module */
  imports: Map<string, string>;
}

export interface ModuleGraph {
  entryFile: string;
  workspaceRoot?: string;
  modules: Map<string, ModuleNode>;
}

function buildNode(filePath: string, ast: jaiphModule, workspaceRoot?: string): ModuleNode {
  const imports = new Map<string, string>();
  for (const imp of ast.imports) {
    imports.set(imp.alias, resolveImportPath(filePath, imp.path, workspaceRoot));
  }
  return { filePath, ast, imports };
}

/**
 * Walks the entry plus its transitive `.jh` import closure. Each reachable
 * file is read from disk and parsed exactly once. Import paths are resolved
 * via {@link resolveImportPath} so library fallbacks behave as elsewhere in
 * the toolchain. Missing imports are not surfaced here; the validator
 * reports `E_IMPORT_NOT_FOUND` once it inspects the graph.
 */
export function loadModuleGraph(entryFile: string, workspaceRoot?: string): ModuleGraph {
  const entry = resolve(entryFile);
  const modules = new Map<string, ModuleNode>();
  type QueueEntry = { file: string; importer?: { file: string; alias: string; loc: { line: number; col: number } } };
  const queue: QueueEntry[] = [{ file: entry }];
  while (queue.length > 0) {
    const { file: current, importer } = queue.shift()!;
    if (modules.has(current)) continue;
    if (!existsSync(current)) {
      if (importer) {
        throw jaiphError(
          importer.file,
          importer.loc.line,
          importer.loc.col,
          "E_IMPORT_NOT_FOUND",
          `import "${importer.alias}" resolves to missing file "${current}"`,
        );
      }
      throw jaiphError(current, 1, 1, "E_IMPORT_NOT_FOUND", `entry file not found: "${current}"`);
    }
    const ast = parsejaiph(readFileSync(current, "utf8"), current);
    const node = buildNode(current, ast, workspaceRoot);
    modules.set(current, node);
    for (const imp of ast.imports) {
      const resolved = node.imports.get(imp.alias)!;
      if (!modules.has(resolved)) {
        queue.push({ file: resolved, importer: { file: current, alias: imp.alias, loc: imp.loc } });
      }
    }
  }
  return { entryFile: entry, workspaceRoot, modules };
}

/** Build a graph from an already-parsed AST plus its workspace-resolved imports. Used by the cross-process deserializer. */
export function moduleGraphFromAsts(
  entryFile: string,
  astByFile: Map<string, jaiphModule>,
  workspaceRoot?: string,
): ModuleGraph {
  const modules = new Map<string, ModuleNode>();
  for (const [filePath, ast] of astByFile) {
    modules.set(filePath, buildNode(filePath, ast, workspaceRoot));
  }
  return { entryFile: resolve(entryFile), workspaceRoot, modules };
}

/** Stable JSON encoding for cross-process transfer (entries sorted by absolute path). */
export function serializeModuleGraph(graph: ModuleGraph): string {
  const entries = [...graph.modules.entries()];
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    entryFile: graph.entryFile,
    workspaceRoot: graph.workspaceRoot ?? null,
    modules: entries.map(([file, node]) => ({ file, ast: node.ast })),
  });
}

export function deserializeModuleGraph(content: string): ModuleGraph {
  const obj = JSON.parse(content) as {
    entryFile: string;
    workspaceRoot: string | null;
    modules: Array<{ file: string; ast: jaiphModule }>;
  };
  const astByFile = new Map<string, jaiphModule>();
  for (const m of obj.modules) astByFile.set(m.file, m.ast);
  return moduleGraphFromAsts(obj.entryFile, astByFile, obj.workspaceRoot ?? undefined);
}

export function writeModuleGraph(filePath: string, graph: ModuleGraph): void {
  writeFileSync(filePath, serializeModuleGraph(graph), "utf8");
}

export function readModuleGraph(filePath: string): ModuleGraph {
  return deserializeModuleGraph(readFileSync(filePath, "utf8"));
}
