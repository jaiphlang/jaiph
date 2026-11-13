import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import type { ModuleGraph, ModuleNode } from "../transpiler";
import { buildGraph, entryDefNames } from "./build";
import { emitMermaid } from "./mermaid";
import type { GraphOptions } from "./model";

// The landing-page samples (prompt, match, recover, inbox, async, stdin) are
// pinned end to end by integration/docs-graph-samples.test.ts; these cases
// cover the remaining step kinds and the expansion limits.

interface Mod {
  path: string;
  src: string;
  imports?: Record<string, string>;
}

/** Build a module graph by hand (library imports only resolve on disk otherwise). */
function graphOf(mods: Mod[]): ModuleGraph {
  const modules = new Map<string, ModuleNode>();
  for (const m of mods) {
    modules.set(m.path, {
      filePath: m.path,
      ast: parsejaiph(m.src, m.path),
      imports: new Map(Object.entries(m.imports ?? {})),
    });
  }
  return { entryFile: mods[0].path, workspaceRoot: "/w", modules };
}

function mermaid(mods: Mod[] | string, opts?: GraphOptions): string {
  const list = typeof mods === "string" ? [{ path: "/w/e.jh", src: mods }] : mods;
  const model = buildGraph(graphOf(list), "main", opts);
  assert.ok(model, "no def main");
  return emitMermaid(model!);
}

/**
 * Output without classDef lines, the grey style line every subgraph gets, and
 * blank lines, for compact expectations. The full output is pinned by the
 * import-depth test below.
 */
function body(out: string): string {
  return out
    .split("\n")
    .filter((l) => !l.includes("classDef") && !/^  style g\d+ fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420$/.test(l) && l.trim() !== "")
    .join("\n");
}

test("if / else branches yes and no; fail ends its branch; log is not drawn", () => {
  const out = mermaid(`script check = 'true'
export def main(x) {
  if x == "a" {
    check()
  } else {
    fail "nope"
  }
  log "done"
}
`);
  assert.equal(
    body(out),
    `flowchart TD
  subgraph g1 ["<b>def</b> main"]
    n1(["start"]):::term
    n2[/"in: x"/]:::input
    n3{"<b>if</b> x == #quot;a#quot;"}:::decision
    n4["<b>script</b> check()"]:::script
    n5(["<b>fail</b> #quot;nope#quot;"]):::fail
    n6(["end"]):::term
  end
  n1 --> n2
  n2 --> n3
  n3 -->|"yes"| n4
  n3 -->|"no"| n5
  n4 --> n6`,
  );
});

test("for is a preparation node with next back into it and done out of it", () => {
  const out = mermaid(`script step = 'true'
export def main(items) {
  for line in items {
    step(line)
  }
}
`);
  assert.equal(
    body(out),
    `flowchart TD
  subgraph g1 ["<b>def</b> main"]
    n1(["start"]):::term
    n2[/"in: items"/]:::input
    n3{{"for line in items"}}:::loop
    n4["<b>script</b> step(line)"]:::script
    n5(["end"]):::term
  end
  n1 --> n2
  n2 --> n3
  n3 --> n4
  n4 -->|"next"| n3
  n3 -->|"done"| n5`,
  );
});

test("catch draws a bold red catch edge that continues to the next step", () => {
  const out = mermaid(`script s = 'true'
export def main() {
  s() catch (err) {
    logerr "x"
  }
  return "ok"
}
`);
  assert.equal(
    body(out),
    `flowchart TD
  subgraph g1 ["<b>def</b> main"]
    n1(["start"]):::term
    n2["<b>script</b> s()"]:::script
    n3(["end"]):::term
  end
  n1 --> n2
  n2 -->|"return #quot;ok#quot;"| n3
  n2 -. "<b>catch</b>" .-> n3
  linkStyle 2 stroke:#b42318,color:#b42318`,
  );
});

test("recursion draws each def once and links back into the existing subgraph", () => {
  const out = mermaid(`export def main() {
  a()
}
def a() {
  b()
}
def b() {
  a()
}
`);
  assert.equal(
    body(out),
    `flowchart TD
  subgraph g1 ["<b>def</b> main"]
    n1(["start"]):::term
    n2[["<b>def</b> a()"]]:::def
    n9(["end"]):::term
  end
  subgraph g2 ["<b>def</b> a"]
    n3(["start"]):::term
    n4[["<b>def</b> b()"]]:::def
    n8(["end"]):::term
  end
  subgraph g3 ["<b>def</b> b"]
    n5(["start"]):::term
    n6[["<b>def</b> a()"]]:::def
    n7(["end"]):::term
  end
  n1 --> n2
  n2 --> n3
  n3 --> n4
  n4 --> n5
  n5 --> n6
  n6 --> n3
  n8 --> n7
  n7 --> n8
  n8 --> n9`,
  );
});

test("a named prompt shows its call; stdin from a value prefixes the script stage", () => {
  const out = mermaid(`prompt review(diff) = "Review: \${diff}"
export def main(d) {
  const r = prompt review(d)
  const v = stdin d -> 'wc -l'()
}
`);
  assert.equal(
    body(out),
    `flowchart TD
  subgraph g1 ["<b>def</b> main"]
    n1(["start"]):::term
    n2[/"in: d"/]:::input
    n3["r = <b>prompt</b> review(d)"]:::prompt
    n4["v = stdin d → <b>script</b> 'wc -l'()"]:::script
    n5(["end"]):::term
  end
  n1 --> n2
  n2 --> n3
  n3 --> n4
  n4 --> n5`,
  );
});

test("async fans out from a fork bar; the def continues and joins before end", () => {
  const out = mermaid(`def w() {
  log "w"
}
script s = 'true'
export def main() {
  async w()
  s()
}
`);
  assert.equal(
    body(out),
    `flowchart TD
  subgraph g1 ["<b>def</b> main"]
    n1(["start"]):::term
    n2@{ shape: fork, label: "" }
    n3[["async <b>def</b> w()"]]:::def
    n6["<b>script</b> s()"]:::script
    n7@{ shape: fork, label: "" }
    n8(["end"]):::term
  end
  subgraph g2 ["<b>def</b> w"]
    n4(["start"]):::term
    n5(["end"]):::term
  end
  n1 --> n2
  n2 -->|"async"| n3
  n3 --> n4
  n4 --> n5
  n2 --> n6
  n6 --> n7
  n5 --> n7
  n7 -->|"all done"| n8
  class n2 fork
  class n7 fork`,
  );
});

test("--depth collapses defs below the limit and counts them in the trailer", () => {
  const out = mermaid(
    `export def main() {
  a()
}
def a() {
  b()
}
def b() {
  log "b"
}
`,
    { depth: 1, importDepth: 1, libs: false },
  );
  assert.equal(
    out,
    `flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef def fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px
  classDef defx fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px,stroke-dasharray:4 3

  subgraph g1 ["<b>def</b> main"]
    n1(["start"]):::term
    n2[["<b>def</b> a()"]]:::def
    n6(["end"]):::term
  end
  subgraph g2 ["<b>def</b> a"]
    n3(["start"]):::term
    n4[["<b>def</b> b()"]]:::defx
    n5(["end"]):::term
  end

  n1 --> n2
  n2 --> n3
  n3 --> n4
  n4 --> n5
  n5 --> n6

  style g1 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
  style g2 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420

%% collapsed: 1 def beyond --depth 1 (use -d all to expand)
`,
  );
});

const IMPORTS: Mod[] = [
  {
    path: "/w/e.jh",
    src: `import "lib.jh" as lib
import "acme/x" as x
export def main() {
  lib.go()
  x.run()
}
`,
    imports: { lib: "/w/lib.jh", x: "/w/.jaiph/libs/acme/x.jh" },
  },
  {
    path: "/w/lib.jh",
    src: `import "deeper.jh" as deeper
export def go() {
  deeper.go()
}
`,
    imports: { deeper: "/w/deeper.jh" },
  },
  { path: "/w/deeper.jh", src: `export def go() {\n  log "d"\n}\n` },
  { path: "/w/.jaiph/libs/acme/x.jh", src: `export def run() {\n  log "x"\n}\n` },
];

test("defaults: imported defs one hop away expand (dashed border); deeper imports and libraries collapse", () => {
  assert.equal(
    mermaid(IMPORTS),
    `flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef def fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px
  classDef defx fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px,stroke-dasharray:4 3

  subgraph g1 ["<b>def</b> main"]
    n1(["start"]):::term
    n2[["<b>def</b> lib.go()"]]:::def
    n6[["<b>def</b> x.run()"]]:::defx
    n7(["end"]):::term
  end
  subgraph g2 ["<b>def</b> lib.go"]
    n3(["start"]):::term
    n4[["<b>def</b> deeper.go()"]]:::defx
    n5(["end"]):::term
  end

  n1 --> n2
  n2 --> n3
  n3 --> n4
  n4 --> n5
  n5 --> n6
  n6 --> n7

  style g1 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
  style g2 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420,stroke-dasharray:5 4

%% collapsed: 1 def beyond --import-depth 1, 1 library def (use -i all, -l to expand)
`,
  );
});

test("-i all -l draws imported and library defs, with no collapsed trailer", () => {
  const out = mermaid(IMPORTS, { depth: Infinity, importDepth: Infinity, libs: true });
  assert.ok(out.includes('subgraph g3 ["<b>def</b> deeper.go"]'), out);
  assert.ok(out.includes('subgraph g4 ["<b>def</b> x.run"]'), out);
  assert.ok(!out.includes("%% collapsed"), out);
  assert.ok(!out.includes(":::defx"), out);
});

test("a routed send feeds the inbox; at -d 0 the route target is a collapsed call", () => {
  const out = mermaid(
    `channel ch -> handler
def handler(msg) {
  log "h"
}
export def main() {
  send "hi" -> ch
}
`,
    { depth: 0, importDepth: 1, libs: false },
  );
  assert.equal(
    body(out),
    `flowchart TD
  subgraph g1 ["<b>def</b> main"]
    n1(["start"]):::term
    n2["<b>send</b> #quot;hi#quot; → ch"]:::send
    n3[("main inbox")]:::channel
    n4((" ")):::join
    n5[["<b>def</b> handler()"]]:::defx
    n6(["end"]):::term
  end
  n1 --> n2
  n2 --o|"↯ ch"| n3
  n2 -->|"steps done"| n4
  n4 ==>|"deliver ch"| n5
  n5 --> n6
  linkStyle 1 stroke:#22857b,stroke-width:2px
%% collapsed: 1 def beyond --depth 0 (use -d all to expand)`,
  );
});

test("a channel routed only in an imported module is not delivered", () => {
  const out = mermaid([
    { path: "/w/e.jh", src: `import "m.jh" as m\nexport def main() {\n  m.go()\n}\n`, imports: { m: "/w/m.jh" } },
    {
      path: "/w/m.jh",
      src: `channel ch -> h\ndef h(msg) {\n  log "h"\n}\nexport def go() {\n  send "x" -> ch\n}\n`,
    },
  ]);
  assert.ok(out.includes('n4["<b>send</b> #quot;x#quot; → ch"]:::send'), out);
  assert.ok(!out.includes("inbox"), out);
  assert.ok(!out.includes("deliver"), out);
});

test("labels are capped: 70 characters overall, 40 for a fail message, bold keyword kept", () => {
  const out = mermaid(`script a_really_long_script_name_that_keeps_going_on = 'true'
export def main() {
  const some_binding_name = a_really_long_script_name_that_keeps_going_on("an argument", "another | argument")
  fail "a {weird} <message> with # and | in it, that is long"
}
`);
  assert.ok(
    out.includes(
      'n2["some_binding_name = <b>script</b> a_really_long_script_name_that_keeps_goi..."]:::script',
    ),
    out,
  );
  assert.ok(
    out.includes('n3(["<b>fail</b> #quot;a #123;weird#125; #lt;message#gt; with #35; and #124; in it...#quot;"]):::fail'),
    out,
  );
});

test("output is byte-identical across builds; a missing def returns null", () => {
  const src = `export def main() {\n  helper()\n}\ndef helper() {\n  log "x"\n}\n`;
  assert.equal(mermaid(src), mermaid(src));
  const graph = graphOf([{ path: "/w/e.jh", src }]);
  assert.equal(buildGraph(graph, "nope"), null);
  assert.deepEqual(entryDefNames(graph), ["main", "helper"]);
});
