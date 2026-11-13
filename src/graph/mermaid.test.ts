import test from "node:test";
import assert from "node:assert/strict";
import { emitMermaid } from "./mermaid";
import type { GraphModel } from "./model";

test("labels and edge labels are escaped for Mermaid, and output is deterministic", () => {
  const model: GraphModel = {
    subgraphs: [{ id: "sg1", title: 'def "weird"', startId: "n1", endId: "n2", nodeIds: ["n1", "n2", "n3"] }],
    nodes: [
      { id: "n1", shape: "stadium", label: "start" },
      { id: "n2", shape: "stadium", label: "end" },
      // Every character the emitter must escape, plus a newline.
      { id: "n3", shape: "rect", label: 'a "b" | {c} <d> #e\nf' },
    ],
    edges: [
      { from: "n1", to: "n3" },
      { from: "n3", to: "n2", label: "x|y {z}", dashed: true },
    ],
  };

  const out = emitMermaid(model);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def #34;weird#34;"]
    n1(["start"])
    n2(["end"])
    n3["a #34;b#34; #124; #123;c#125; #60;d#62; #35;e f"]
  end
  n1 --> n3
  n3 -.->|"x#124;y #123;z#125;"| n2
`,
  );

  // Byte-identical across two runs for the same model.
  assert.equal(emitMermaid(model), out);
});

test("long labels are cut to 60 characters with an ellipsis", () => {
  const long = "x".repeat(100);
  const model: GraphModel = {
    subgraphs: [{ id: "sg1", title: "def main", startId: "n1", endId: "n1", nodeIds: ["n1"] }],
    nodes: [{ id: "n1", shape: "rect", label: long }],
    edges: [],
  };
  const out = emitMermaid(model);
  const label = "x".repeat(59) + "…";
  assert.ok(out.includes(`n1["${label}"]`), out);
  assert.equal(label.length, 60);
});
