import type { GraphEdge, GraphModel, GraphNode } from "./model";

/**
 * Emits a {@link GraphModel} as a Mermaid `flowchart TD` document. Output is
 * deterministic (arrays are rendered in creation order) and byte-identical
 * across runs for the same model. Labels are escaped for Mermaid and truncated
 * to 60 characters, so any Jaiph string renders safely.
 */

const MAX_LABEL = 60;

/** Truncate to 60 chars with an ellipsis (applied before escaping). */
function truncate(raw: string): string {
  return raw.length > MAX_LABEL ? raw.slice(0, MAX_LABEL - 1) + "…" : raw;
}

/**
 * Escape the characters that break Mermaid labels, using its `#<code>;` entity
 * form. `#` is escaped first so the entities we introduce are not re-escaped.
 * Newlines collapse to a space.
 */
function escape(raw: string): string {
  return truncate(raw)
    .replace(/#/g, "#35;")
    .replace(/"/g, "#34;")
    .replace(/</g, "#60;")
    .replace(/>/g, "#62;")
    .replace(/\|/g, "#124;")
    .replace(/\{/g, "#123;")
    .replace(/\}/g, "#125;")
    .replace(/[\r\n]+/g, " ");
}

/** A quoted, escaped label ready to sit inside a shape or edge delimiter. */
function quote(raw: string): string {
  return `"${escape(raw)}"`;
}

function shapeSyntax(node: GraphNode): string {
  const q = quote(node.label);
  switch (node.shape) {
    case "stadium":
      return `${node.id}([${q}])`;
    case "rect":
      return `${node.id}[${q}]`;
    case "subroutine":
      return `${node.id}[[${q}]]`;
    case "hexagon":
      return `${node.id}{{${q}}}`;
    case "diamond":
      return `${node.id}{${q}}`;
    case "failure":
      return `${node.id}[${q}]:::failure`;
  }
}

function edgeSyntax(edge: GraphEdge): string {
  const arrow = edge.dashed ? "-.->" : "-->";
  const label = edge.label !== undefined ? `|${quote(edge.label)}|` : "";
  return `${edge.from} ${arrow}${label} ${edge.to}`;
}

export function emitMermaid(model: GraphModel): string {
  const lines: string[] = ["flowchart TD"];
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const placed = new Set<string>();
  for (const sg of model.subgraphs) {
    lines.push(`  subgraph ${sg.id} [${quote(sg.title)}]`);
    for (const id of sg.nodeIds) {
      const node = byId.get(id);
      if (!node) continue;
      lines.push("    " + shapeSyntax(node));
      placed.add(id);
    }
    lines.push("  end");
  }
  for (const node of model.nodes) {
    if (!placed.has(node.id)) lines.push("  " + shapeSyntax(node));
  }
  for (const edge of model.edges) lines.push("  " + edgeSyntax(edge));
  if (model.nodes.some((n) => n.shape === "failure")) {
    lines.push("  classDef failure fill:#fdd,stroke:#d33,color:#900;");
  }
  return lines.join("\n") + "\n";
}
