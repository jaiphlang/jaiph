import { join, sep } from "node:path";
import type { ModuleGraph, ModuleNode } from "../transpiler";
import type { Def, Expr, LocalDecl, StepDef } from "../types";
import type { CollapsedCounts, GraphOptions } from "./model";

/**
 * Callee resolution and the expansion plan for the graph builder.
 *
 * A def is drawn as a subgraph ("expanded") when all of these hold:
 *   - its shortest call distance from the entry def is at most `depth`
 *     (route targets of the entry's channels count as distance 1, since the
 *     entry frame calls them when it drains its inbox);
 *   - it lives in a library module (under `<workspace>/.jaiph/libs/`) only
 *     when `libs` is set; library defs ignore `importDepth`;
 *   - otherwise its module is at most `importDepth` import hops from the entry.
 * Any other reachable def is drawn as a collapsed call node and counted.
 */

/** A def reachable from the entry, with the scope its body resolves names in. */
export interface DefTarget {
  modNode: ModuleNode;
  def: Def;
  /** `alias.` for a def in an imported module, "" in the entry module. */
  prefix: string;
  key: string;
  locals: Map<string, LocalDecl>;
}

export type Callee = { kind: "def"; target: DefTarget } | { kind: "leaf" };

export interface Scope {
  graph: ModuleGraph;
  modNode: ModuleNode;
  prefix: string;
  key: string;
  locals: Map<string, LocalDecl>;
}

export interface Plan {
  expanded: Set<string>;
  collapsed: CollapsedCounts;
}

/** Collect nested `script` / `def` / `prompt` declarations by name (recursively). */
function collectLocalDecls(steps: StepDef[], into: Map<string, LocalDecl>): void {
  for (const step of steps) {
    if (step.type === "local_decl") {
      const d = step.decl;
      const name =
        d.kind === "script" ? d.script.name : d.kind === "def" ? d.def.name : d.prompt.name;
      into.set(name, d);
    } else if (step.type === "if") {
      collectLocalDecls(step.body, into);
      if (step.elseBody) collectLocalDecls(step.elseBody, into);
    } else if (step.type === "for_lines") {
      collectLocalDecls(step.body, into);
    }
  }
}

export function defTarget(
  modNode: ModuleNode,
  def: Def,
  prefix: string,
  key: string,
  outer?: Map<string, LocalDecl>,
): DefTarget {
  const locals = new Map(outer ?? []);
  collectLocalDecls(def.steps, locals);
  return { modNode, def, prefix, key, locals };
}

export function scopeOf(graph: ModuleGraph, t: DefTarget): Scope {
  return { graph, modNode: t.modNode, prefix: t.prefix, key: t.key, locals: t.locals };
}

export function resolveCallee(scope: Scope, value: string): Callee {
  const dot = value.indexOf(".");
  if (dot < 0) {
    const local = scope.locals.get(value);
    if (local?.kind === "def") {
      const key = `${scope.key}/${value}`;
      return { kind: "def", target: defTarget(scope.modNode, local.def, scope.prefix, key, scope.locals) };
    }
    if (local) return { kind: "leaf" };
    const def = scope.modNode.ast.defs.find((d) => d.name === value);
    if (!def) return { kind: "leaf" };
    const key = `${scope.modNode.filePath}::${value}`;
    return { kind: "def", target: defTarget(scope.modNode, def, scope.prefix, key) };
  }
  const alias = value.slice(0, dot);
  const name = value.slice(dot + 1);
  const file = scope.modNode.imports.get(alias);
  const mod = file ? scope.graph.modules.get(file) : undefined;
  const def = mod?.ast.defs.find((d) => d.name === name);
  if (!mod || !def) return { kind: "leaf" };
  return { kind: "def", target: defTarget(mod, def, `${alias}.`, `${mod.filePath}::${name}`) };
}

/** Route targets of `channel` (alias stripped) declared in the entry module. */
export function routesOf(graph: ModuleGraph, channel: string): string[] {
  const bare = channel.slice(channel.lastIndexOf(".") + 1);
  const entry = graph.modules.get(graph.entryFile);
  const ch = entry?.ast.channels.find((c) => c.name === bare);
  return (ch?.routes ?? []).map((r) => r.value);
}

/** Import hops from the entry module to every module in the graph. */
function importHops(graph: ModuleGraph): Map<string, number> {
  const hops = new Map<string, number>([[graph.entryFile, 0]]);
  const queue = [graph.entryFile];
  for (let i = 0; i < queue.length; i += 1) {
    const mod = graph.modules.get(queue[i]);
    for (const file of mod?.imports.values() ?? []) {
      if (hops.has(file)) continue;
      hops.set(file, hops.get(queue[i])! + 1);
      queue.push(file);
    }
  }
  return hops;
}

function isLibrary(graph: ModuleGraph, filePath: string): boolean {
  if (!graph.workspaceRoot) return false;
  return filePath.startsWith(join(graph.workspaceRoot, ".jaiph", "libs") + sep);
}

/** Callees a def body names, in source order; a `send` is recorded with `route: true` (its channel name). */
function callsIn(steps: StepDef[], out: Array<{ value: string; route: boolean }>): void {
  const expr = (e: Expr | undefined): void => {
    if (e?.kind === "call") out.push({ value: e.callee.value, route: false });
  };
  for (const step of steps) {
    if (step.type === "exec") {
      expr(step.stdin);
      for (const s of step.stages ?? []) expr(s);
      expr(step.body);
      for (const body of [step.catch, step.recover]) {
        if (body) callsIn("single" in body ? [body.single] : body.block, out);
      }
    } else if (step.type === "const" || step.type === "return") {
      expr(step.value);
    } else if (step.type === "send") {
      out.push({ value: step.channel, route: true });
    } else if (step.type === "if") {
      callsIn(step.body, out);
      if (step.elseBody) callsIn(step.elseBody, out);
    } else if (step.type === "for_lines") {
      callsIn(step.body, out);
    }
  }
}

/** Decide which defs reachable from `entry` are expanded, and count the rest. */
export function planExpansion(graph: ModuleGraph, entry: DefTarget, opts: GraphOptions): Plan {
  const hops = importHops(graph);
  const entryScope = scopeOf(graph, entry);
  const dist = new Map<string, number>();
  const reason = new Map<string, keyof CollapsedCounts>();
  const queue: Array<{ t: DefTarget; d: number }> = [];

  const reach = (t: DefTarget, d: number): void => {
    const lib = isLibrary(graph, t.modNode.filePath);
    if (lib && !opts.libs) reason.set(t.key, "libs");
    else if (!lib && (hops.get(t.modNode.filePath) ?? Infinity) > opts.importDepth) reason.set(t.key, "imports");
    else if (d > opts.depth) {
      if (!reason.has(t.key)) reason.set(t.key, "depth");
    } else if (!dist.has(t.key) || d < dist.get(t.key)!) {
      dist.set(t.key, d);
      queue.push({ t, d });
    }
  };

  dist.set(entry.key, 0);
  queue.push({ t: entry, d: 0 });
  for (let i = 0; i < queue.length; i += 1) {
    const { t, d } = queue[i];
    if (dist.get(t.key) !== d) continue; // superseded by a shorter path
    const scope = scopeOf(graph, t);
    const calls: Array<{ value: string; route: boolean }> = [];
    callsIn(t.def.steps, calls);
    for (const c of calls) {
      if (c.route) {
        for (const r of routesOf(graph, c.value)) {
          const callee = resolveCallee(entryScope, r);
          if (callee.kind === "def") reach(callee.target, 1);
        }
        continue;
      }
      const callee = resolveCallee(scope, c.value);
      if (callee.kind === "def") reach(callee.target, d + 1);
    }
  }

  const collapsed: CollapsedCounts = { depth: 0, imports: 0, libs: 0 };
  for (const [key, why] of reason) if (!dist.has(key)) collapsed[why] += 1;
  return { expanded: new Set(dist.keys()), collapsed };
}
