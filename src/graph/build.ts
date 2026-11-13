import type { ModuleGraph, ModuleNode } from "../transpiler";
import type { CatchBody, Def, Expr, LocalDecl, StepDef } from "../types";
import {
  isPlainValue,
  isShort,
  renderCall,
  renderCondition,
  renderInline,
  renderPattern,
  renderPlainValue,
  renderPrompt,
  unquote,
  withCapture,
  type GraphModel,
  type GraphSubgraph,
  type NodeShape,
} from "./model";

/**
 * Builds a {@link GraphModel} from a module graph and an entry def name.
 * Traversal is depth-first in source order, so node ids (`n1`, `n2`, …) are
 * deterministic; the same input yields a byte-identical model (and thus
 * byte-identical Mermaid). Each reachable def is drawn once as a subgraph;
 * recursion and repeated calls reuse the same subgraph.
 */

interface Builder {
  graph: ModuleGraph;
  nodes: GraphModel["nodes"];
  edges: GraphModel["edges"];
  subgraphs: GraphSubgraph[];
  builtDefs: Map<string, { startId: string; endId: string }>;
  nextNode: number;
  nextSub: number;
}

interface Ctx {
  b: Builder;
  modNode: ModuleNode;
  sub: GraphSubgraph;
  localDecls: Map<string, LocalDecl>;
  defEndId: string;
}

/** An edge source: a node id plus the label/dash the next edge should carry. */
interface Incoming {
  id: string;
  label?: string;
  dashed?: boolean;
}

type Resolved =
  | { kind: "def"; modNode: ModuleNode; def: Def; title: string; defKey: string }
  | { kind: "leaf" };

interface ValueResult {
  tails: Incoming[];
  node: string;
}

function newNode(b: Builder, sub: GraphSubgraph, shape: NodeShape, label: string): string {
  const id = `n${b.nextNode}`;
  b.nextNode += 1;
  b.nodes.push({ id, shape, label });
  sub.nodeIds.push(id);
  return id;
}

function connect(
  b: Builder,
  incomings: Incoming[],
  toId: string,
  opts?: { label?: string; dashed?: boolean },
): void {
  for (const inc of incomings) {
    b.edges.push({
      from: inc.id,
      to: toId,
      label: opts?.label ?? inc.label,
      dashed: opts?.dashed ?? inc.dashed,
    });
  }
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

function resolveCall(ctx: Ctx, value: string): Resolved {
  const parts = value.split(".");
  if (parts.length === 1) {
    const name = parts[0];
    const local = ctx.localDecls.get(name);
    if (local?.kind === "def") {
      return {
        kind: "def",
        modNode: ctx.modNode,
        def: local.def,
        title: `def ${name}`,
        defKey: `${ctx.modNode.filePath}::local:${name}`,
      };
    }
    if (local) return { kind: "leaf" };
    const def = ctx.modNode.ast.defs.find((d) => d.name === name);
    if (def) {
      return {
        kind: "def",
        modNode: ctx.modNode,
        def,
        title: `def ${name}`,
        defKey: `${ctx.modNode.filePath}::${name}`,
      };
    }
    return { kind: "leaf" };
  }
  const [alias, importedName] = parts;
  const importedFile = ctx.modNode.imports.get(alias);
  const importedNode = importedFile ? ctx.b.graph.modules.get(importedFile) : undefined;
  const def = importedNode?.ast.defs.find((d) => d.name === importedName);
  if (importedNode && def) {
    return {
      kind: "def",
      modNode: importedNode,
      def,
      title: `${alias}.${importedName}`,
      defKey: `${importedNode.filePath}::${importedName}`,
    };
  }
  return { kind: "leaf" };
}

function emitCall(
  ctx: Ctx,
  expr: Extract<Expr, { kind: "call" }>,
  incoming: Incoming[],
  capture?: string,
): ValueResult {
  const label = withCapture(capture, renderCall(expr));
  const r = resolveCall(ctx, expr.callee.value);
  if (r.kind === "def") {
    const node = newNode(ctx.b, ctx.sub, "rect", label);
    connect(ctx.b, incoming, node);
    const sg = buildDef(ctx.b, r.modNode, r.def, r.title, r.defKey);
    if (expr.async) {
      ctx.b.edges.push({ from: node, to: sg.startId, dashed: true });
      return { tails: [{ id: node }], node };
    }
    ctx.b.edges.push({ from: node, to: sg.startId });
    return { tails: [{ id: sg.endId }], node };
  }
  const node = newNode(ctx.b, ctx.sub, "subroutine", label);
  connect(ctx.b, incoming, node);
  return { tails: [{ id: node }], node };
}

function emitMatch(
  ctx: Ctx,
  m: Extract<Expr, { kind: "match" }>["match"],
  incoming: Incoming[],
  capture?: string,
): ValueResult {
  const diamond = newNode(ctx.b, ctx.sub, "diamond", withCapture(capture, `match ${m.subject}`));
  connect(ctx.b, incoming, diamond);
  const tails: Incoming[] = [];
  for (const arm of m.arms) {
    const pat = renderPattern(arm.pattern);
    const body = arm.body.trim();
    if (/^fail\b/.test(body)) {
      const msg = unquote(body.replace(/^fail\s*/, ""));
      const fnode = newNode(ctx.b, ctx.sub, "failure", `fail ${msg}`);
      ctx.b.edges.push({ from: diamond, to: fnode, label: pat });
    } else {
      tails.push({ id: diamond, label: pat });
    }
  }
  return { tails, node: diamond };
}

function emitValue(ctx: Ctx, expr: Expr, incoming: Incoming[], capture?: string): ValueResult {
  if (expr.kind === "call") return emitCall(ctx, expr, incoming, capture);
  if (expr.kind === "match") return emitMatch(ctx, expr.match, incoming, capture);
  if (expr.kind === "inline_script") {
    const node = newNode(ctx.b, ctx.sub, "subroutine", withCapture(capture, renderInline(expr)));
    connect(ctx.b, incoming, node);
    return { tails: [{ id: node }], node };
  }
  if (expr.kind === "prompt") {
    const node = newNode(ctx.b, ctx.sub, "hexagon", withCapture(capture, renderPrompt(expr)));
    connect(ctx.b, incoming, node);
    return { tails: [{ id: node }], node };
  }
  const node = newNode(ctx.b, ctx.sub, "rect", withCapture(capture, renderPlainValue(expr)));
  connect(ctx.b, incoming, node);
  return { tails: [{ id: node }], node };
}

function walkCatchBody(body: CatchBody, ctx: Ctx, incoming: Incoming[]): Incoming[] {
  const steps = "single" in body ? [body.single] : body.block;
  return walk(steps, ctx, incoming);
}

function handleExec(step: Extract<StepDef, { type: "exec" }>, ctx: Ctx, cur: Incoming[]): Incoming[] {
  if (step.stdin) return handleStdin(step, ctx, cur);
  const vr = emitValue(ctx, step.body, cur, step.captureName);
  let tails = vr.tails;
  if (step.catch) {
    const catchTails = walkCatchBody(step.catch, ctx, [
      { id: vr.node, label: "on failure", dashed: true },
    ]);
    tails = [...tails, ...catchTails];
  }
  if (step.recover) {
    const recTails = walkCatchBody(step.recover, ctx, [
      { id: vr.node, label: "on failure", dashed: true },
    ]);
    connect(ctx.b, recTails, vr.node, { label: "retry" });
  }
  return tails;
}

function handleStdin(
  step: Extract<StepDef, { type: "exec" }>,
  ctx: Ctx,
  cur: Incoming[],
): Incoming[] {
  const stages: Expr[] = [];
  if (step.stdin && (step.stdin.kind === "call" || step.stdin.kind === "inline_script")) {
    stages.push(step.stdin);
  }
  for (const s of step.stages ?? []) stages.push(s);
  stages.push(step.body);
  let incoming = cur;
  for (let i = 0; i < stages.length; i += 1) {
    const cap = i === stages.length - 1 ? step.captureName : undefined;
    incoming = emitValue(ctx, stages[i], incoming, cap).tails;
  }
  return incoming;
}

function handleReturn(
  step: Extract<StepDef, { type: "return" }>,
  ctx: Ctx,
  cur: Incoming[],
): Incoming[] {
  if (isPlainValue(step.value)) {
    const text = renderPlainValue(step.value);
    connect(ctx.b, cur, ctx.defEndId, { label: isShort(text) ? text : undefined });
    return [];
  }
  const vr = emitValue(ctx, step.value, cur);
  connect(ctx.b, vr.tails, ctx.defEndId);
  return [];
}

function handleSend(
  step: Extract<StepDef, { type: "send" }>,
  ctx: Ctx,
  cur: Incoming[],
): Incoming[] {
  const node = newNode(
    ctx.b,
    ctx.sub,
    "rect",
    `send ${renderPlainValue(step.value)} -> ${step.channel}`,
  );
  connect(ctx.b, cur, node);
  const channel = ctx.modNode.ast.channels.find((c) => c.name === step.channel);
  for (const route of channel?.routes ?? []) {
    const r = resolveCall(ctx, route.value);
    if (r.kind === "def") {
      const sg = buildDef(ctx.b, r.modNode, r.def, r.title, r.defKey);
      ctx.b.edges.push({ from: node, to: sg.startId, dashed: true });
    }
  }
  return [{ id: node }];
}

function handleIf(step: Extract<StepDef, { type: "if" }>, ctx: Ctx, cur: Incoming[]): Incoming[] {
  const diamond = newNode(ctx.b, ctx.sub, "diamond", renderCondition(step));
  connect(ctx.b, cur, diamond);
  const yesTails = walk(step.body, ctx, [{ id: diamond, label: "yes" }]);
  const noTails = step.elseBody
    ? walk(step.elseBody, ctx, [{ id: diamond, label: "no" }])
    : [{ id: diamond, label: "no" }];
  return [...yesTails, ...noTails];
}

function handleFor(
  step: Extract<StepDef, { type: "for_lines" }>,
  ctx: Ctx,
  cur: Incoming[],
): Incoming[] {
  const loop = newNode(ctx.b, ctx.sub, "rect", `for ${step.iterVar} in ${step.sourceVar}`);
  connect(ctx.b, cur, loop);
  const bodyTails = walk(step.body, ctx, [{ id: loop }]);
  connect(ctx.b, bodyTails, loop, { label: "loop" });
  return [{ id: loop }];
}

function handleStep(step: StepDef, ctx: Ctx, cur: Incoming[]): Incoming[] {
  switch (step.type) {
    case "trivia":
    case "local_decl":
      return cur;
    case "say":
      if (step.level === "fail") {
        const node = newNode(
          ctx.b,
          ctx.sub,
          "failure",
          `fail ${unquote(renderPlainValue(step.message))}`,
        );
        connect(ctx.b, cur, node);
        return [];
      }
      return cur;
    case "const":
      if (isPlainValue(step.value)) return cur;
      return emitValue(ctx, step.value, cur, step.name).tails;
    case "return":
      return handleReturn(step, ctx, cur);
    case "exec":
      return handleExec(step, ctx, cur);
    case "send":
      return handleSend(step, ctx, cur);
    case "if":
      return handleIf(step, ctx, cur);
    case "for_lines":
      return handleFor(step, ctx, cur);
  }
}

function walk(steps: StepDef[], ctx: Ctx, incoming: Incoming[]): Incoming[] {
  let cur = incoming;
  for (const step of steps) cur = handleStep(step, ctx, cur);
  return cur;
}

function buildDef(
  b: Builder,
  modNode: ModuleNode,
  def: Def,
  title: string,
  defKey: string,
): { startId: string; endId: string } {
  const existing = b.builtDefs.get(defKey);
  if (existing) return existing;
  const sub: GraphSubgraph = {
    id: `sg${b.nextSub}`,
    title,
    nodeIds: [],
    startId: "",
    endId: "",
  };
  b.nextSub += 1;
  b.subgraphs.push(sub);
  sub.startId = newNode(b, sub, "stadium", "start");
  sub.endId = newNode(b, sub, "stadium", "end");
  const result = { startId: sub.startId, endId: sub.endId };
  // Reserve before walking so recursion / repeated calls reuse this subgraph.
  b.builtDefs.set(defKey, result);
  const localDecls = new Map<string, LocalDecl>();
  collectLocalDecls(def.steps, localDecls);
  const ctx: Ctx = { b, modNode, sub, localDecls, defEndId: sub.endId };
  const tails = walk(def.steps, ctx, [{ id: sub.startId }]);
  connect(b, tails, sub.endId);
  return result;
}

/** Names of the module-level defs in the entry module (for error messages). */
export function entryDefNames(graph: ModuleGraph): string[] {
  const entry = graph.modules.get(graph.entryFile);
  return entry ? entry.ast.defs.map((d) => d.name) : [];
}

/**
 * Build the execution-flow model for `defName` in the graph's entry module.
 * Caller must ensure the def exists (see {@link entryDefNames}); returns null
 * if it does not.
 */
export function buildGraph(graph: ModuleGraph, defName: string): GraphModel | null {
  const entry = graph.modules.get(graph.entryFile);
  const def = entry?.ast.defs.find((d) => d.name === defName);
  if (!entry || !def) return null;
  const b: Builder = {
    graph,
    nodes: [],
    edges: [],
    subgraphs: [],
    builtDefs: new Map(),
    nextNode: 1,
    nextSub: 1,
  };
  buildDef(b, entry, def, `def ${defName}`, `${entry.filePath}::${defName}`);
  return { nodes: b.nodes, edges: b.edges, subgraphs: b.subgraphs };
}
