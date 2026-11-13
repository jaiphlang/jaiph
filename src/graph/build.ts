import type { ModuleGraph } from "../transpiler";
import type { CatchBody, Expr, StepDef } from "../types";
import {
  conditionText,
  failText,
  inlineText,
  isPlainValue,
  patternText,
  plainText,
  promptText,
  returnLabel,
  argsText,
} from "./labels";
import {
  DEFAULT_GRAPH_OPTIONS,
  type EdgeKind,
  type GraphModel,
  type GraphOptions,
  type GraphSubgraph,
  type Label,
  type NodeKind,
} from "./model";
import {
  defTarget,
  planExpansion,
  resolveCallee,
  routesOf,
  scopeOf,
  type DefTarget,
  type Plan,
  type Scope,
} from "./scope";

/**
 * Builds a {@link GraphModel} from a module graph and an entry def name.
 * Traversal is depth-first in source order, so node ids (`n1`, `n2`, …) are
 * deterministic; the same input yields a byte-identical model (and thus
 * byte-identical Mermaid). Each expanded def is drawn once as a subgraph;
 * recursion and repeated calls link into the same subgraph.
 */

interface Builder {
  graph: ModuleGraph;
  plan: Plan;
  nodes: GraphModel["nodes"];
  edges: GraphModel["edges"];
  subgraphs: GraphSubgraph[];
  built: Map<string, { startId: string; endId: string }>;
  nextNode: number;
  /** Entry def subgraph and scope; it owns the inbox and drains it after its steps. */
  entrySub?: GraphSubgraph;
  entryScope?: Scope;
  inboxId?: string;
  /** Routed channels in the order first sent; each is delivered once. */
  channels: string[];
}

interface Ctx {
  b: Builder;
  scope: Scope;
  sub: GraphSubgraph;
  endId: string;
  forkIds: Set<string>;
  asyncTails: Incoming[];
}

/** An edge source: a node id plus the kind/label the next edge should carry. */
interface Incoming {
  id: string;
  label?: string;
  kind?: EdgeKind;
}

interface ValueResult {
  tails: Incoming[];
  node: string;
}

function newNode(b: Builder, sub: GraphSubgraph, kind: NodeKind, label: Label, collapsed?: boolean): string {
  const id = `n${b.nextNode}`;
  b.nextNode += 1;
  b.nodes.push(collapsed ? { id, kind, label, collapsed } : { id, kind, label });
  sub.nodeIds.push(id);
  return id;
}

/** Edge from every incoming to `to`. An incoming's own label wins over `opts.label`; `opts.kind` wins over its kind. */
function connect(b: Builder, incs: Incoming[], to: string, opts?: { label?: string; kind?: EdgeKind }): void {
  for (const inc of incs) {
    const label = inc.label ?? opts?.label;
    const edge = { from: inc.id, to, kind: opts?.kind ?? inc.kind ?? "flow" };
    b.edges.push(label !== undefined ? { ...edge, label } : edge);
  }
}

function callText(scope: Scope, expr: Extract<Expr, { kind: "call" }>): string {
  const v = expr.callee.value;
  return `${v.includes(".") ? v : scope.prefix + v}(${argsText(expr.args)})`;
}

function emitCall(
  ctx: Ctx,
  expr: Extract<Expr, { kind: "call" }>,
  incoming: Incoming[],
  binding?: string,
  pre?: string,
): ValueResult {
  const text = callText(ctx.scope, expr);
  const callee = resolveCallee(ctx.scope, expr.callee.value);
  if (callee.kind === "leaf") {
    const node = newNode(ctx.b, ctx.sub, "script", { binding, pre, kw: "script", text });
    connect(ctx.b, incoming, node);
    return { tails: [{ id: node }], node };
  }
  const expanded = ctx.b.plan.expanded.has(callee.target.key);
  const node = newNode(ctx.b, ctx.sub, "def", { binding, pre, kw: "def", text }, !expanded);
  connect(ctx.b, incoming, node);
  if (!expanded) return { tails: [{ id: node }], node };
  // Push the call edge first so it reads before the callee's own edges.
  const edge = { from: node, to: "", kind: "flow" as const };
  ctx.b.edges.push(edge);
  const sg = buildDef(ctx.b, callee.target);
  edge.to = sg.startId;
  return { tails: [{ id: sg.endId }], node };
}

function emitMatch(
  ctx: Ctx,
  m: Extract<Expr, { kind: "match" }>["match"],
  incoming: Incoming[],
  binding?: string,
): ValueResult {
  const node = newNode(ctx.b, ctx.sub, "decision", { binding, kw: "match", text: m.subject });
  connect(ctx.b, incoming, node);
  const arms: Incoming[] = [];
  for (const arm of m.arms) {
    const pat = patternText(arm.pattern);
    const body = arm.body.trim();
    if (/^fail\b/.test(body)) {
      const f = newNode(ctx.b, ctx.sub, "fail", { kw: "fail", text: failText(body.slice(4)) });
      ctx.b.edges.push({ from: node, to: f, kind: "flow", label: pat });
    } else {
      arms.push({ id: node, label: `${pat} → ${body}` });
    }
  }
  if (arms.length < 2) return { tails: arms, node };
  const join = newNode(ctx.b, ctx.sub, "join", { text: "" });
  connect(ctx.b, arms, join);
  return { tails: [{ id: join }], node };
}

function emitValue(ctx: Ctx, expr: Expr, incoming: Incoming[], binding?: string, pre?: string): ValueResult {
  if (expr.kind === "call") return emitCall(ctx, expr, incoming, binding, pre);
  if (expr.kind === "match") return emitMatch(ctx, expr.match, incoming, binding);
  const [kind, label]: [NodeKind, Label] =
    expr.kind === "prompt"
      ? ["prompt", { binding, pre, kw: "prompt", text: promptText(expr) }]
      : expr.kind === "inline_script"
        ? ["script", { binding, pre, kw: "script", text: inlineText(expr) }]
        : ["script", { binding, pre, text: plainText(expr) }];
  const node = newNode(ctx.b, ctx.sub, kind, label);
  connect(ctx.b, incoming, node);
  return { tails: [{ id: node }], node };
}

function walkBody(body: CatchBody, ctx: Ctx, incoming: Incoming[]): Incoming[] {
  return walk("single" in body ? [body.single] : body.block, ctx, incoming);
}

function handleExec(step: Extract<StepDef, { type: "exec" }>, ctx: Ctx, cur: Incoming[]): Incoming[] {
  if (step.stdin) return handleStdin(step, ctx, cur);
  const vr = emitValue(ctx, step.body, cur, step.captureName);
  let tails = vr.tails;
  if (step.catch) {
    tails = [...tails, ...walkBody(step.catch, ctx, [{ id: vr.node, kind: "fail", label: "catch" }])];
  }
  if (step.recover) {
    const rec = walkBody(step.recover, ctx, [{ id: vr.node, kind: "fail", label: "recover" }]);
    connect(ctx.b, rec, vr.node, { label: "retry" });
  }
  return tails;
}

/** `stdin p() -> s1() -> s2()` or `stdin v -> s()`: one node per stage. */
function handleStdin(step: Extract<StepDef, { type: "exec" }>, ctx: Ctx, cur: Incoming[]): Incoming[] {
  const src = step.stdin!;
  const producer = src.kind === "call" || src.kind === "inline_script";
  const stages = [...(producer ? [src] : []), ...(step.stages ?? []), step.body];
  let incoming = cur;
  stages.forEach((stage, i) => {
    const pre = i > 0 ? undefined : producer ? "stdin" : `stdin ${plainText(src)} →`;
    const binding = i === stages.length - 1 ? step.captureName : undefined;
    const tails = emitValue(ctx, stage, incoming, binding, pre).tails;
    incoming = tails.map((t) => ({ ...t, label: "stdout → stdin" }));
  });
  return incoming.map((t) => ({ id: t.id }));
}

function handleReturn(step: Extract<StepDef, { type: "return" }>, ctx: Ctx, cur: Incoming[]): Incoming[] {
  if (isPlainValue(step.value)) {
    connect(ctx.b, cur, ctx.endId, { label: returnLabel(plainText(step.value)) });
    return [];
  }
  connect(ctx.b, emitValue(ctx, step.value, cur).tails, ctx.endId, { label: "return" });
  return [];
}

function handleSend(step: Extract<StepDef, { type: "send" }>, ctx: Ctx, cur: Incoming[]): Incoming[] {
  const text = `${step.value.kind === "literal" ? step.value.raw : plainText(step.value)} → ${step.channel}`;
  const node = newNode(ctx.b, ctx.sub, "send", { kw: "send", text });
  connect(ctx.b, cur, node);
  const b = ctx.b;
  if (b.entrySub && routesOf(b.graph, step.channel).length > 0) {
    const bare = step.channel.slice(step.channel.lastIndexOf(".") + 1);
    if (b.inboxId === undefined) {
      const owner = b.entrySub.title.text;
      b.inboxId = newNode(b, b.entrySub, "channel", { text: `${owner} inbox` });
    }
    b.edges.push({ from: node, to: b.inboxId, kind: "comm", label: bare });
    if (!b.channels.includes(bare)) b.channels.push(bare);
  }
  return [{ id: node }];
}

function handleIf(step: Extract<StepDef, { type: "if" }>, ctx: Ctx, cur: Incoming[]): Incoming[] {
  const node = newNode(ctx.b, ctx.sub, "decision", { kw: "if", text: conditionText(step) });
  connect(ctx.b, cur, node);
  const yes = walk(step.body, ctx, [{ id: node, label: "yes" }]);
  const no = step.elseBody ? walk(step.elseBody, ctx, [{ id: node, label: "no" }]) : [{ id: node, label: "no" }];
  return [...yes, ...no];
}

function handleFor(step: Extract<StepDef, { type: "for_lines" }>, ctx: Ctx, cur: Incoming[]): Incoming[] {
  const node = newNode(ctx.b, ctx.sub, "loop", { text: `for ${step.iterVar} in ${step.sourceVar}` });
  connect(ctx.b, cur, node);
  connect(ctx.b, walk(step.body, ctx, [{ id: node }]), node, { label: "next" });
  return [{ id: node, label: "done" }];
}

/** `async f()`: a run of async calls shares one fork bar; their ends meet at the def's join bar. */
function handleAsync(expr: Extract<Expr, { kind: "call" }>, ctx: Ctx, cur: Incoming[]): Incoming[] {
  let fork: string;
  if (cur.length === 1 && ctx.forkIds.has(cur[0].id) && cur[0].label === undefined) {
    fork = cur[0].id;
  } else {
    fork = newNode(ctx.b, ctx.sub, "fork", { text: "" });
    ctx.forkIds.add(fork);
    connect(ctx.b, cur, fork);
  }
  ctx.asyncTails.push(...emitCall(ctx, expr, [{ id: fork, label: "async" }], undefined, "async").tails);
  return [{ id: fork }];
}

function handleStep(step: StepDef, ctx: Ctx, cur: Incoming[]): Incoming[] {
  switch (step.type) {
    case "trivia":
    case "local_decl":
      return cur;
    case "say":
      if (step.level !== "fail") return cur;
      connect(ctx.b, cur, newNode(ctx.b, ctx.sub, "fail", { kw: "fail", text: failText(failSource(step.message)) }));
      return [];
    case "const":
      return isPlainValue(step.value) ? cur : emitValue(ctx, step.value, cur, step.name).tails;
    case "return":
      return handleReturn(step, ctx, cur);
    case "exec":
      if (step.body.kind === "call" && step.body.async && !step.stdin) return handleAsync(step.body, ctx, cur);
      return handleExec(step, ctx, cur);
    case "send":
      return handleSend(step, ctx, cur);
    case "if":
      return handleIf(step, ctx, cur);
    case "for_lines":
      return handleFor(step, ctx, cur);
  }
}

function failSource(message: Expr): string {
  return message.kind === "literal" ? message.raw : plainText(message);
}

function walk(steps: StepDef[], ctx: Ctx, incoming: Incoming[]): Incoming[] {
  let cur = incoming;
  for (const step of steps) cur = handleStep(step, ctx, cur);
  return cur;
}

/** After the entry def's steps: deliver each routed channel to its targets, in order. */
function drainInbox(b: Builder, sub: GraphSubgraph, tails: Incoming[]): Incoming[] {
  if (b.channels.length === 0 || !b.entryScope) return tails;
  const drain = newNode(b, sub, "join", { text: "" });
  connect(b, tails, drain, { label: "steps done" });
  let prev: Incoming[] = [{ id: drain }];
  for (let i = 0; i < b.channels.length; i += 1) {
    const ch = b.channels[i];
    for (const route of routesOf(b.graph, ch)) {
      const opts = { kind: "control" as const, label: `deliver ${ch}` };
      const callee = resolveCallee(b.entryScope, route);
      if (callee.kind === "def" && b.plan.expanded.has(callee.target.key)) {
        const sg = buildDef(b, callee.target);
        connect(b, prev, sg.startId, opts);
        prev = [{ id: sg.endId }];
      } else {
        const node = newNode(b, sub, "def", { kw: "def", text: `${route}()` }, true);
        connect(b, prev, node, opts);
        prev = [{ id: node }];
      }
    }
  }
  return prev;
}

function buildDef(b: Builder, t: DefTarget): { startId: string; endId: string } {
  const existing = b.built.get(t.key);
  if (existing) return existing;
  const sub: GraphSubgraph = {
    id: `g${b.subgraphs.length + 1}`,
    title: { kw: "def", text: t.prefix + t.def.name },
    imported: t.modNode.filePath !== b.graph.entryFile,
    nodeIds: [],
  };
  b.subgraphs.push(sub);
  const isEntry = b.entrySub === undefined;
  if (isEntry) {
    b.entrySub = sub;
    b.entryScope = scopeOf(b.graph, t);
  }
  const startId = newNode(b, sub, "term", { text: "start" });
  // End gets its real id once the body is built, so ids read top to bottom;
  // until then edges (returns, recursion) point at a placeholder.
  const placeholder = `end:${sub.id}`;
  b.built.set(t.key, { startId, endId: placeholder });
  let first: Incoming[] = [{ id: startId }];
  if (t.def.params.length > 0) {
    const input = newNode(b, sub, "input", { text: `in: ${t.def.params.join(", ")}` });
    connect(b, first, input);
    first = [{ id: input }];
  }
  const ctx: Ctx = { b, scope: scopeOf(b.graph, t), sub, endId: placeholder, forkIds: new Set(), asyncTails: [] };
  let tails = walk(t.def.steps, ctx, first).filter((x) => !(ctx.forkIds.has(x.id) && x.label === undefined));
  if (ctx.asyncTails.length > 0) {
    const join = newNode(b, sub, "fork", { text: "" });
    connect(b, [...tails, ...ctx.asyncTails], join);
    tails = [{ id: join, label: "all done" }];
  }
  if (isEntry) tails = drainInbox(b, sub, tails);
  const endId = newNode(b, sub, "term", { text: "end" });
  connect(b, tails, endId);
  for (const e of b.edges) {
    if (e.from === placeholder) e.from = endId;
    if (e.to === placeholder) e.to = endId;
  }
  const result = { startId, endId };
  b.built.set(t.key, result);
  return result;
}

/** Names of the module-level defs in the entry module (for error messages). */
export function entryDefNames(graph: ModuleGraph): string[] {
  const entry = graph.modules.get(graph.entryFile);
  return entry ? entry.ast.defs.map((d) => d.name) : [];
}

/**
 * Build the execution-flow model for `defName` in the graph's entry module,
 * expanding defs per `options` (see scope.ts). Returns null when the entry
 * module has no such def (see {@link entryDefNames}).
 */
export function buildGraph(
  graph: ModuleGraph,
  defName: string,
  options: GraphOptions = DEFAULT_GRAPH_OPTIONS,
): GraphModel | null {
  const entry = graph.modules.get(graph.entryFile);
  const def = entry?.ast.defs.find((d) => d.name === defName);
  if (!entry || !def) return null;
  const target = defTarget(entry, def, "", `${entry.filePath}::${defName}`);
  const plan = planExpansion(graph, target, options);
  const b: Builder = {
    graph,
    plan,
    nodes: [],
    edges: [],
    subgraphs: [],
    built: new Map(),
    nextNode: 1,
    channels: [],
  };
  buildDef(b, target);
  return { nodes: b.nodes, edges: b.edges, subgraphs: b.subgraphs, options, collapsed: plan.collapsed };
}
