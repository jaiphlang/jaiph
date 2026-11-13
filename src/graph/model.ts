import type { Arg, Expr, MatchPatternDef, StepDef } from "../types";

/**
 * Graph model: a language-agnostic description of a def's execution flow.
 * The builder (build.ts) produces it from the AST; the emitter (mermaid.ts)
 * renders it to a Mermaid `flowchart TD` document. Labels here are raw
 * (unescaped); the emitter escapes and truncates them.
 */

/** Node rendering shapes. Mermaid syntax is chosen by the emitter. */
export type NodeShape =
  | "stadium" // def start / end
  | "rect" // def call, send, for-loop
  | "subroutine" // script call / inline script
  | "hexagon" // prompt
  | "diamond" // if / match
  | "failure"; // fail (terminal, styled)

export interface GraphNode {
  id: string; // n1, n2, … in depth-first source order
  shape: NodeShape;
  label: string; // raw label; the emitter escapes it
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string; // raw label; the emitter escapes it
  dashed?: boolean;
}

/** One def drawn as a Mermaid subgraph with its own start and end. */
export interface GraphSubgraph {
  id: string; // sg1, sg2, …
  title: string; // "def name" or "alias.name"
  startId: string;
  endId: string;
  nodeIds: string[]; // nodes belonging to this subgraph, in creation order
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  subgraphs: GraphSubgraph[];
}

/** A value Expr renders to no node (its value flows through unchanged). */
export function isPlainValue(expr: Expr): boolean {
  return expr.kind === "literal" || expr.kind === "bare_ref" || expr.kind === "shell";
}

/** Strip one layer of surrounding double quotes, if present. */
export function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function argsText(args?: Arg[]): string {
  return (args ?? []).map((a) => (a.kind === "var" ? a.name : a.raw)).join(", ");
}

/** Prefix a capture binding onto a label: `x = base`. */
export function withCapture(capture: string | undefined, base: string): string {
  return capture ? `${capture} = ${base}` : base;
}

export function renderCall(expr: Extract<Expr, { kind: "call" }>): string {
  return `${expr.callee.value}(${argsText(expr.args)})`;
}

export function renderInline(expr: Extract<Expr, { kind: "inline_script" }>): string {
  return `'${expr.body}'(${argsText(expr.args)})`;
}

export function renderPrompt(expr: Extract<Expr, { kind: "prompt" }>): string {
  if (expr.name) return `prompt ${expr.name}(${argsText(expr.args)})`;
  return `prompt ${unquote(expr.raw)}`;
}

/** Raw text of a plain (non-call) value. */
export function renderPlainValue(expr: Expr): string {
  if (expr.kind === "literal") return expr.raw;
  if (expr.kind === "bare_ref") return expr.ref.value;
  if (expr.kind === "shell") return expr.command;
  return "";
}

export function renderPattern(p: MatchPatternDef): string {
  if (p.kind === "string_literal") return `"${p.value}"`;
  if (p.kind === "regex") return `/${p.source}/`;
  if (p.kind === "wildcard") return "_";
  return p.patterns.map(renderPattern).join(" | ");
}

/** `subject == "value"` / `subject =~ /re/` for an `if` diamond. */
export function renderCondition(step: Extract<StepDef, { type: "if" }>): string {
  const operand =
    step.operand.kind === "string_literal" ? `"${step.operand.value}"` : `/${step.operand.source}/`;
  return `${step.subject} ${step.operator} ${operand}`;
}

/** A return value is labelled on the edge to end only when it is short. */
export function isShort(text: string): boolean {
  return text.length <= 30;
}
