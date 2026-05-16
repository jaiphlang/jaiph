import { resolve } from "node:path";
import { loadModuleGraph, type ModuleGraph, type ModuleNode } from "../../transpile/module-graph";
import type { RuleDef, ScriptDef, WorkflowDef, WorkflowRefDef, RuleRefDef, jaiphModule } from "../../types";

export type RuntimeModuleNode = ModuleNode;
export type RuntimeGraph = ModuleGraph;

export interface ResolvedWorkflow {
  filePath: string;
  workflow: WorkflowDef;
}

export interface ResolvedRule {
  filePath: string;
  rule: RuleDef;
}

export interface ResolvedScript {
  filePath: string;
  script: ScriptDef;
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

export function lookupWorkflow(graph: RuntimeGraph, fromFile: string, ref: WorkflowRefDef): WorkflowDef | null {
  return resolveWorkflowRef(graph, fromFile, ref)?.workflow ?? null;
}

export function resolveWorkflowRef(graph: RuntimeGraph, fromFile: string, ref: WorkflowRefDef): ResolvedWorkflow | null {
  const node = graph.modules.get(resolve(fromFile));
  if (!node) return null;
  const parts = ref.value.split(".");
  if (parts.length === 1) {
    const workflow = node.ast.workflows.find((w) => w.name === parts[0]) ?? null;
    return workflow ? { filePath: node.filePath, workflow } : null;
  }
  const [alias, name] = parts;
  if (!alias || !name) return null;
  const importedFile = node.imports.get(alias);
  if (!importedFile) return null;
  const importedNode = graph.modules.get(importedFile);
  if (!importedNode) return null;
  const workflow = importedNode.ast.workflows.find((w) => w.name === name) ?? null;
  return workflow ? { filePath: importedNode.filePath, workflow } : null;
}

export function lookupRule(graph: RuntimeGraph, fromFile: string, ref: RuleRefDef): RuleDef | null {
  return resolveRuleRef(graph, fromFile, ref)?.rule ?? null;
}

export function resolveRuleRef(graph: RuntimeGraph, fromFile: string, ref: RuleRefDef): ResolvedRule | null {
  const node = graph.modules.get(resolve(fromFile));
  if (!node) return null;
  const parts = ref.value.split(".");
  if (parts.length === 1) {
    const rule = node.ast.rules.find((r) => r.name === parts[0]) ?? null;
    return rule ? { filePath: node.filePath, rule } : null;
  }
  const [alias, name] = parts;
  if (!alias || !name) return null;
  const importedFile = node.imports.get(alias);
  if (!importedFile) return null;
  const importedNode = graph.modules.get(importedFile);
  if (!importedNode) return null;
  const rule = importedNode.ast.rules.find((r) => r.name === name) ?? null;
  return rule ? { filePath: importedNode.filePath, rule } : null;
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
