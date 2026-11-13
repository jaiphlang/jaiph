/**
 * Graph model: a language-agnostic description of a def's execution flow.
 * The builder (build.ts) produces it from the AST; the emitter (mermaid.ts)
 * renders it to a Mermaid `flowchart TD` document. Labels here are raw
 * (unescaped); the emitter escapes, bolds and truncates them.
 *
 * Node kinds follow ISO 5807 flowchart symbols:
 *   term     Terminator          def start / end
 *   fail     Terminator          `fail` (styled red)
 *   input    Data                def parameters (`in: a, b`)
 *   def      Predefined process  call to a def (its body is a subgraph)
 *   script   Process             script / inline script call
 *   prompt   Process             agent prompt
 *   send     Process             `send` to a channel
 *   channel  Stored data         the entry def's inbox (message queue)
 *   decision Decision            `if` / `match`
 *   loop     Preparation         `for … in`
 *   join     Connector           arms of a `match` (or the inbox drain) converge
 *   fork     Parallel mode       `async` fan-out and the implicit join
 */
export type NodeKind =
  | "term"
  | "fail"
  | "input"
  | "def"
  | "script"
  | "prompt"
  | "send"
  | "channel"
  | "decision"
  | "loop"
  | "join"
  | "fork";

/**
 * A node label in parts, rendered as `[binding = ][pre ]<b>kw</b> text`.
 * Only `kw` is bolded; truncation cuts `text` so the bold keyword survives.
 */
export interface Label {
  binding?: string;
  pre?: string;
  kw?: string;
  text: string;
}

export interface GraphNode {
  id: string; // n1, n2, … in depth-first source order
  kind: NodeKind;
  label: Label;
  /** A def call whose body is not drawn (beyond depth, import depth, or a library). */
  collapsed?: boolean;
}

/**
 * Edge kinds:
 *   flow     sequence (optionally labelled: yes/no, match arm, retry, return…)
 *   fail     failure path into a `catch` / `recover` body (label is the keyword)
 *   comm     communication link: a `send` puts a message in the inbox
 *   control  control transfer: the inbox drain delivers a message to a route target
 */
export type EdgeKind = "flow" | "fail" | "comm" | "control";

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string; // raw label; the emitter escapes it
}

/** One def drawn as a Mermaid subgraph with its own start and end. */
export interface GraphSubgraph {
  id: string; // g1, g2, …
  title: Label; // `<b>def</b> name` or `<b>def</b> alias.name`
  /** Defined in a module other than the entry file (drawn with a dashed border). */
  imported: boolean;
  nodeIds: string[]; // nodes in this subgraph, in render order (end last)
}

/** Expansion limits; `Infinity` means unlimited (`all` on the command line). */
export interface GraphOptions {
  depth: number;
  importDepth: number;
  libs: boolean;
}

/** Number of distinct defs drawn collapsed, by reason. */
export interface CollapsedCounts {
  depth: number;
  imports: number;
  libs: number;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  subgraphs: GraphSubgraph[];
  options: GraphOptions;
  collapsed: CollapsedCounts;
}

export const DEFAULT_GRAPH_OPTIONS: GraphOptions = { depth: 3, importDepth: 1, libs: false };
