import type { GraphEdge, GraphModel, GraphNode, Label, NodeKind } from "./model";

/**
 * Emits a {@link GraphModel} as a Mermaid `flowchart TD` document. Output is
 * deterministic (arrays render in creation order) and byte-identical across
 * runs for the same model. Labels are escaped with Mermaid's `#…;` entities
 * and cut at 70 visible characters; construct keywords render bold. Shapes
 * follow ISO 5807 (see model.ts); the fork bar needs Mermaid 11.3 or later.
 */

const MAX_LABEL = 70;

const ESC: Record<string, string> = {
  '"': "#quot;",
  "#": "#35;",
  "{": "#123;",
  "}": "#125;",
  "<": "#lt;",
  ">": "#gt;",
  "|": "#124;",
};

const CLASS_DEFS: Array<[string, string]> = [
  ["term", "fill:#ffffff,stroke:#8a938d,color:#1d2420"],
  ["fail", "fill:#fde2e2,stroke:#b42318,color:#7a1a12"],
  ["input", "fill:#fff3d1,stroke:#b7871a,color:#4d3600"],
  ["def", "fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px"],
  ["defx", "fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px,stroke-dasharray:4 3"],
  ["script", "fill:#e2f1e7,stroke:#3a8657,color:#163b25"],
  ["prompt", "fill:#eee2fd,stroke:#7646d6,color:#381a72"],
  ["send", "fill:#d8f1ee,stroke:#22857b,color:#0d3a35"],
  ["channel", "fill:#d8f1ee,stroke:#22857b,color:#0d3a35"],
  ["decision", "fill:#f1f2f1,stroke:#5f6762,color:#1d2420"],
  ["loop", "fill:#f1f2f1,stroke:#5f6762,color:#1d2420"],
  ["join", "fill:#8a938d,stroke:#8a938d,color:#8a938d"],
  ["fork", "fill:#1d2420,stroke:#1d2420"],
];

const SHAPES: Record<Exclude<NodeKind, "fork" | "join">, [string, string]> = {
  term: ["([", "])"],
  fail: ["([", "])"],
  input: ["[/", "/]"],
  def: ["[[", "]]"],
  script: ["[", "]"],
  prompt: ["[", "]"],
  send: ["[", "]"],
  channel: ["[(", ")]"],
  decision: ["{", "}"],
  loop: ["{{", "}}"],
};

function escape(raw: string): string {
  return Array.from(raw.replace(/[\r\n]+/g, " "), (c) => ESC[c] ?? c).join("");
}

function cut(raw: string, max: number): string {
  return raw.length > max ? raw.slice(0, Math.max(0, max - 3)) + "..." : raw;
}

/** `[binding = ][pre ]<b>kw</b> text`, cut to 70 visible chars (the text part goes first). */
function renderLabel(l: Label): string {
  const head = (l.binding ? `${l.binding} = ` : "") + (l.pre ? `${l.pre} ` : "");
  const kw = l.kw ? `${l.kw} ` : "";
  const visible = head + kw + l.text;
  if (visible.length > MAX_LABEL && head.length + kw.length >= MAX_LABEL - 3) {
    return escape(cut(visible, MAX_LABEL));
  }
  const text = cut(l.text, MAX_LABEL - head.length - kw.length);
  return escape(head) + (l.kw ? `<b>${escape(l.kw)}</b> ` : "") + escape(text);
}

function edgeLabel(raw: string): string {
  return `"${escape(cut(raw, MAX_LABEL))}"`;
}

function nodeSyntax(node: GraphNode): string {
  if (node.kind === "fork") return `${node.id}@{ shape: fork, label: "" }`;
  if (node.kind === "join") return `${node.id}((" ")):::join`;
  const [open, close] = SHAPES[node.kind];
  const cls = node.collapsed ? "defx" : node.kind;
  return `${node.id}${open}"${renderLabel(node.label)}"${close}:::${cls}`;
}

function edgeSyntax(e: GraphEdge): string {
  switch (e.kind) {
    case "fail":
      return `${e.from} -. "<b>${escape(e.label ?? "")}</b>" .-> ${e.to}`;
    case "comm":
      return `${e.from} --o|${edgeLabel(`↯ ${e.label ?? ""}`)}| ${e.to}`;
    case "control":
      return e.label ? `${e.from} ==>|${edgeLabel(e.label)}| ${e.to}` : `${e.from} ==> ${e.to}`;
    case "flow":
      return e.label ? `${e.from} -->|${edgeLabel(e.label)}| ${e.to}` : `${e.from} --> ${e.to}`;
  }
}

function plural(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? "" : "s"}`;
}

function limit(n: number): string {
  return Number.isFinite(n) ? String(n) : "all";
}

/** `%% collapsed: …` trailer naming what was not drawn and the flags that draw it. */
function collapsedComment(model: GraphModel): string | null {
  const { depth, imports, libs } = model.collapsed;
  const parts: string[] = [];
  const flags: string[] = [];
  if (depth > 0) {
    parts.push(`${plural(depth, "def")} beyond --depth ${limit(model.options.depth)}`);
    flags.push("-d all");
  }
  if (imports > 0) {
    parts.push(`${plural(imports, "def")} beyond --import-depth ${limit(model.options.importDepth)}`);
    flags.push("-i all");
  }
  if (libs > 0) {
    parts.push(plural(libs, "library def"));
    flags.push("-l");
  }
  if (parts.length === 0) return null;
  return `%% collapsed: ${parts.join(", ")} (use ${flags.join(", ")} to expand)`;
}

export function emitMermaid(model: GraphModel): string {
  const used = new Set<string>(model.nodes.map((n) => (n.collapsed ? "defx" : n.kind)));
  const lines: string[] = ["flowchart TD"];
  for (const [name, style] of CLASS_DEFS) {
    if (used.has(name)) lines.push(`  classDef ${name} ${style}`);
  }
  lines.push("");
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  for (const sg of model.subgraphs) {
    lines.push(`  subgraph ${sg.id} ["${renderLabel(sg.title)}"]`);
    for (const id of sg.nodeIds) lines.push("    " + nodeSyntax(byId.get(id)!));
    lines.push("  end");
  }
  lines.push("");
  for (const e of model.edges) lines.push("  " + edgeSyntax(e));
  const trailer: string[] = [];
  for (const n of model.nodes) if (n.kind === "fork") trailer.push(`  class ${n.id} fork`);
  for (const sg of model.subgraphs) if (sg.imported) trailer.push(`  style ${sg.id} stroke-dasharray:5 4`);
  model.edges.forEach((e, i) => {
    if (e.kind === "fail") trailer.push(`  linkStyle ${i} stroke:#b42318,color:#b42318`);
    if (e.kind === "comm") trailer.push(`  linkStyle ${i} stroke:#22857b,stroke-width:2px`);
  });
  if (trailer.length > 0) lines.push("", ...trailer);
  const comment = collapsedComment(model);
  if (comment) lines.push("", comment);
  return lines.join("\n") + "\n";
}
