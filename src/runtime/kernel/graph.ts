import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsejaiph } from "../../parser";
import type { RuleDef, ScriptDef, WorkflowDef, WorkflowRefDef, RuleRefDef, jaiphModule } from "../../types";
import { resolveImportPath } from "../../transpile/resolve";

export interface RuntimeModuleNode {
  filePath: string;
  ast: jaiphModule;
  imports: Map<string, string>;
}

export interface RuntimeGraph {
  entryFile: string;
  modules: Map<string, RuntimeModuleNode>;
}

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

function buildNode(filePath: string, workspaceRoot?: string): RuntimeModuleNode {
  const ast = parsejaiph(readFileSync(filePath, "utf8"), filePath);
  const imports = new Map<string, string>();
  for (const imp of ast.imports) {
    imports.set(imp.alias, resolveImportPath(filePath, imp.path, workspaceRoot));
  }
  return { filePath, ast, imports };
}

export function buildRuntimeGraph(entryFile: string, workspaceRoot?: string): RuntimeGraph {
  const entry = resolve(entryFile);
  const modules = new Map<string, RuntimeModuleNode>();
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (modules.has(current)) continue;
    const node = buildNode(current, workspaceRoot);
    modules.set(current, node);
    for (const imported of node.imports.values()) {
      if (!modules.has(imported)) queue.push(imported);
    }
  }
  return { entryFile: entry, modules };
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
