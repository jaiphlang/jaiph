import type { Arg, Expr, MatchPatternDef, StepDef } from "../types";

/**
 * Label text helpers for the graph builder. Everything here returns raw text;
 * the emitter escapes it for Mermaid. Prompt bodies and fail messages are
 * summarized by their first non-blank line, capped at {@link SNIPPET_MAX}.
 */

const SNIPPET_MAX = 40;

/** Strip one layer of surrounding double quotes, if present. */
export function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

/**
 * First non-blank line of `text`; when longer than 40 characters it is cut at
 * the last word boundary, trailing ` ,.;:` dropped, and `...` appended.
 */
export function snippet(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  if (line.length <= SNIPPET_MAX) return line;
  let cut = line.slice(0, SNIPPET_MAX);
  const space = cut.lastIndexOf(" ");
  if (space > 0) cut = cut.slice(0, space);
  return cut.replace(/[ ,.;:]+$/, "") + "...";
}

export function argsText(args?: Arg[]): string {
  return (args ?? []).map((a) => (a.kind === "var" ? a.name : a.raw)).join(", ");
}

/**
 * Text of a plain value: a literal that is exactly `"${x}"` (or `${x}`) reads
 * as `x`; any other literal keeps its source form.
 */
export function plainText(expr: Expr): string {
  if (expr.kind === "literal") {
    const m = /^"?\$\{([A-Za-z_][A-Za-z0-9_.]*)\}"?$/.exec(expr.raw);
    return m ? m[1] : expr.raw;
  }
  if (expr.kind === "bare_ref") return expr.ref.value;
  if (expr.kind === "shell") return expr.command;
  return "";
}

/** A value Expr renders to no node (its value flows through unchanged). */
export function isPlainValue(expr: Expr): boolean {
  return expr.kind === "literal" || expr.kind === "bare_ref" || expr.kind === "shell";
}

/** `"first line of the prompt..."` or `name(args)` for a named prompt. */
export function promptText(expr: Extract<Expr, { kind: "prompt" }>): string {
  if (expr.name) return `${expr.name}(${argsText(expr.args)})`;
  return `"${snippet(unquote(expr.raw))}"`;
}

/** Message text of a `fail`: a quoted literal is summarized like a prompt. */
export function failText(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return `"${snippet(unquote(t))}"`;
  return t;
}

export function inlineText(expr: Extract<Expr, { kind: "inline_script" }>): string {
  return `'${snippet(expr.body)}'(${argsText(expr.args)})`;
}

export function patternText(p: MatchPatternDef): string {
  if (p.kind === "string_literal") return `"${p.value}"`;
  if (p.kind === "regex") return `/${p.source}/`;
  if (p.kind === "wildcard") return "_";
  return p.patterns.map(patternText).join(" | ");
}

/** `subject == "value"` / `subject =~ /re/` for an `if` diamond. */
export function conditionText(step: Extract<StepDef, { type: "if" }>): string {
  const operand =
    step.operand.kind === "string_literal" ? `"${step.operand.value}"` : `/${step.operand.source}/`;
  return `${step.subject} ${step.operator} ${operand}`;
}

/** A returned plain value is named on the edge to end only when it is short. */
export function returnLabel(text: string): string {
  return text !== "" && text.length <= 30 ? `return ${text}` : "return";
}
