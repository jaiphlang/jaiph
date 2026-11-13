import test from "node:test";
import assert from "node:assert/strict";
import { snippet } from "./labels";
import { emitMermaid } from "./mermaid";
import { DEFAULT_GRAPH_OPTIONS, type GraphModel } from "./model";

function model(partial: Partial<GraphModel>): GraphModel {
  return {
    nodes: [],
    edges: [],
    subgraphs: [],
    options: DEFAULT_GRAPH_OPTIONS,
    collapsed: { depth: 0, imports: 0, libs: 0 },
    ...partial,
  };
}

test("each edge kind has its own Mermaid syntax; failure and comm edges get a linkStyle", () => {
  const out = emitMermaid(
    model({
      nodes: [
        { id: "n1", kind: "script", label: { kw: "script", text: "a()" } },
        { id: "n2", kind: "channel", label: { text: "main inbox" } },
      ],
      subgraphs: [{ id: "g1", title: { kw: "def", text: "main" }, imported: true, nodeIds: ["n1", "n2"] }],
      edges: [
        { from: "n1", to: "n2", kind: "flow" },
        { from: "n1", to: "n2", kind: "flow", label: "yes" },
        { from: "n1", to: "n2", kind: "fail", label: "recover" },
        { from: "n1", to: "n2", kind: "comm", label: "ch" },
        { from: "n1", to: "n2", kind: "control", label: "deliver ch" },
      ],
    }),
  );
  assert.equal(
    out,
    `flowchart TD
  classDef script fill:#e2f1e7,stroke:#3a8657,color:#163b25
  classDef channel fill:#d8f1ee,stroke:#22857b,color:#0d3a35

  subgraph g1 ["<b>def</b> main"]
    n1["<b>script</b> a()"]:::script
    n2[("main inbox")]:::channel
  end

  n1 --> n2
  n1 -->|"yes"| n2
  n1 -. "<b>recover</b>" .-> n2
  n1 --o|"↯ ch"| n2
  n1 ==>|"deliver ch"| n2

  style g1 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420,stroke-dasharray:5 4
  linkStyle 2 stroke:#b42318,color:#b42318
  linkStyle 3 stroke:#22857b,stroke-width:2px
`,
  );
});

test("labels escape Mermaid metacharacters as entities and collapse newlines", () => {
  const out = emitMermaid(
    model({
      nodes: [{ id: "n1", kind: "script", label: { text: 'a "q" #x {b} <c> | d\ne' } }],
      subgraphs: [{ id: "g1", title: { text: "t" }, imported: false, nodeIds: ["n1"] }],
      edges: [{ from: "n1", to: "n1", kind: "flow", label: "x|y" }],
    }),
  );
  assert.ok(out.includes('n1["a #quot;q#quot; #35;x #123;b#125; #lt;c#gt; #124; d e"]:::script'), out);
  assert.ok(out.includes('n1 -->|"x#124;y"| n1'), out);
});

test("a long label keeps the binding and bold keyword and cuts the text to 70 visible characters", () => {
  const text = "f(" + "x".repeat(100) + ")";
  const out = emitMermaid(
    model({
      nodes: [{ id: "n1", kind: "def", label: { binding: "r", pre: "async", kw: "def", text } }],
      subgraphs: [{ id: "g1", title: { text: "t" }, imported: false, nodeIds: ["n1"] }],
    }),
  );
  const line = out.split("\n").find((l) => l.includes("n1[["))!;
  const visible = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"')).replace(/<\/?b>/g, "");
  assert.equal(visible.length, 70);
  assert.ok(line.startsWith('    n1[["r = async <b>def</b> f(xxx'), line);
  assert.ok(visible.endsWith("..."), visible);
});

test("the collapsed trailer counts each reason and names its flag", () => {
  const out = emitMermaid(
    model({
      options: { depth: 2, importDepth: 0, libs: false },
      collapsed: { depth: 2, imports: 1, libs: 4 },
    }),
  );
  assert.ok(
    out.endsWith(
      "%% collapsed: 2 defs beyond --depth 2, 1 def beyond --import-depth 0, 4 library defs (use -d all, -i all, -l to expand)\n",
    ),
    out,
  );
  assert.ok(!emitMermaid(model({})).includes("%%"));
});

test("snippet keeps the first non-blank line and cuts it at a word boundary past 40 chars", () => {
  assert.equal(snippet("\n  short line \nsecond"), "short line");
  assert.equal(
    snippet("Say hello to ${name} and provide a fun fact about a person."),
    "Say hello to ${name} and provide a fun...",
  );
  assert.equal(snippet("Role must be one of: surgical, reductionist."), "Role must be one of: surgical...");
});
