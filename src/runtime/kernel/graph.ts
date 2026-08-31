import { resolve } from "node:path";
import { loadModuleGraph, type ModuleGraph, type ModuleNode } from "../../transpiler";
import type { ScriptDef, Def, DefRef, PromptDef, jaiphModule } from "../../types";

export type RuntimeModuleNode = ModuleNode;
export type RuntimeGraph = ModuleGraph;

export interface ResolvedDef {
  filePath: string;
  def: Def;
}

export interface ResolvedScript {
  filePath: string;
  script: ScriptDef;
}

export interface ResolvedPrompt {
  filePath: string;
  prompt: PromptDef;
}

/** Inject `ScriptDef` stubs for `import script` declarations so `resolveScriptRef` finds them. Idempotent. */
function attachScriptImportStubs(ast: jaiphModule): void {
  if (!ast.scriptImports) return;
  for (const si of ast.scriptImports) {
    if (ast.scripts.some((s) => s.name === si.alias)) continue;
    ast.scripts.push({
      name: si.alias,
      comments: [],
      body: "",
      // Carry the `use` clause so the stub's script spawns get the same
      // sterile-env + `--env`-grant contract as a named script.
      ...(si.use ? { use: si.use } : {}),
      loc: si.loc,
    });
  }
}

/**
 * Adapt a {@link ModuleGraph} for runtime dispatch by injecting `ScriptDef`
 * stubs for `import script` declarations so `resolveScriptRef` lookups
 * succeed for cross-module script imports. The injection mutates the AST
 * in-place; the helper is idempotent so repeated calls are safe.
 */
export function buildRuntimeGraph(
  source: string | ModuleGraph,
  workspaceRoot?: string,
): RuntimeGraph {
  const graph = typeof source === "string"
    ? loadModuleGraph(source, workspaceRoot)
    : source;
  for (const node of graph.modules.values()) {
    attachScriptImportStubs(node.ast);
  }
  return graph;
}

export function lookupDef(graph: RuntimeGraph, fromFile: string, ref: DefRef): Def | null {
  return resolveDefRef(graph, fromFile, ref)?.def ?? null;
}

export function resolveDefRef(graph: RuntimeGraph, fromFile: string, ref: DefRef): ResolvedDef | null {
  const node = graph.modules.get(resolve(fromFile));
  if (!node) return null;
  const parts = ref.value.split(".");
  if (parts.length === 1) {
    const def = node.ast.defs.find((w) => w.name === parts[0]) ?? null;
    return def ? { filePath: node.filePath, def } : null;
  }
  const [alias, name] = parts;
  if (!alias || !name) return null;
  const importedFile = node.imports.get(alias);
  if (!importedFile) return null;
  const importedNode = graph.modules.get(importedFile);
  if (!importedNode) return null;
  const def = importedNode.ast.defs.find((w) => w.name === name) ?? null;
  return def ? { filePath: importedNode.filePath, def } : null;
}

export function resolvePromptRef(graph: RuntimeGraph, fromFile: string, ref: string): ResolvedPrompt | null {
  const node = graph.modules.get(resolve(fromFile));
  if (!node) return null;
  const parts = ref.split(".");
  if (parts.length === 1) {
    const prompt = node.ast.prompts?.find((p) => p.name === parts[0]) ?? null;
    return prompt ? { filePath: node.filePath, prompt } : null;
  }
  const [alias, name] = parts;
  if (!alias || !name) return null;
  const importedFile = node.imports.get(alias);
  if (!importedFile) return null;
  const importedNode = graph.modules.get(importedFile);
  if (!importedNode) return null;
  const prompt = importedNode.ast.prompts?.find((p) => p.name === name) ?? null;
  return prompt ? { filePath: importedNode.filePath, prompt } : null;
}

export function lookupScript(graph: RuntimeGraph, fromFile: string, ref: string): ScriptDef | null {
  return resolveScriptRef(graph, fromFile, ref)?.script ?? null;
}

export function resolveScriptRef(graph: RuntimeGraph, fromFile: string, ref: string): ResolvedScript | null {
  const node = graph.modules.get(resolve(fromFile));
  if (!node) return null;
  const parts = ref.split(".");
  if (parts.length === 1) {
    const script = node.ast.scripts.find((s) => s.name === parts[0]) ?? null;
    return script ? { filePath: node.filePath, script } : null;
  }
  const [alias, name] = parts;
  if (!alias || !name) return null;
  const importedFile = node.imports.get(alias);
  if (!importedFile) return null;
  const importedNode = graph.modules.get(importedFile);
  if (!importedNode) return null;
  const script = importedNode.ast.scripts.find((s) => s.name === name) ?? null;
  return script ? { filePath: importedNode.filePath, script } : null;
}
