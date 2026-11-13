// Public entry for the graph package. Code outside src/graph/ imports the
// builder (AST → model) and emitter (model → Mermaid text) only through here,
// never src/graph/** internals. Explicit named re-exports — no `export *`.
export { buildGraph, entryDefNames } from "./build";
export { emitMermaid } from "./mermaid";
export type { GraphModel, GraphNode, GraphEdge, GraphSubgraph, NodeShape } from "./model";
