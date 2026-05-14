import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsejaiph } from "../parser";
import { resolveImportPath } from "./resolve";
import type { jaiphModule } from "../types";

/**
 * One-shot parse of a `.jh` entry plus its transitive import closure. Reused by
 * `buildScripts` (validation + script emit) and `buildRuntimeGraph` (runtime
 * dispatch) so each reachable module is parsed exactly once per `jaiph run`,
 * even across the parent-CLI → child-runner process boundary.
 */
export interface CompilePrep {
  entryFile: string;
  workspaceRoot?: string;
  /** AST for every reachable module, keyed by absolute path. */
  astByFile: Map<string, jaiphModule>;
}

export function prepareCompile(entryFile: string, workspaceRoot?: string): CompilePrep {
  const entry = resolve(entryFile);
  const astByFile = new Map<string, jaiphModule>();
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (astByFile.has(current)) continue;
    const ast = parsejaiph(readFileSync(current, "utf8"), current);
    astByFile.set(current, ast);
    for (const imp of ast.imports) {
      const importedFile = resolveImportPath(current, imp.path, workspaceRoot);
      if (!astByFile.has(importedFile)) queue.push(importedFile);
    }
  }
  return { entryFile: entry, workspaceRoot, astByFile };
}

/** Stable JSON encoding for cross-process transfer. */
export function serializeCompilePrep(prep: CompilePrep): string {
  const entries = [...prep.astByFile.entries()];
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    entryFile: prep.entryFile,
    workspaceRoot: prep.workspaceRoot ?? null,
    modules: entries.map(([file, ast]) => ({ file, ast })),
  });
}

export function deserializeCompilePrep(content: string): CompilePrep {
  const obj = JSON.parse(content) as {
    entryFile: string;
    workspaceRoot: string | null;
    modules: Array<{ file: string; ast: jaiphModule }>;
  };
  const astByFile = new Map<string, jaiphModule>();
  for (const m of obj.modules) astByFile.set(m.file, m.ast);
  return {
    entryFile: obj.entryFile,
    workspaceRoot: obj.workspaceRoot ?? undefined,
    astByFile,
  };
}

export function writeCompilePrep(filePath: string, prep: CompilePrep): void {
  writeFileSync(filePath, serializeCompilePrep(prep), "utf8");
}

export function readCompilePrep(filePath: string): CompilePrep {
  return deserializeCompilePrep(readFileSync(filePath, "utf8"));
}
