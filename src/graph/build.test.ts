import test from "node:test";
import assert from "node:assert/strict";
import { parsejaiph } from "../parser";
import { moduleGraphFromAsts } from "../transpiler";
import { buildGraph, entryDefNames } from "./build";
import { emitMermaid } from "./mermaid";

const ENTRY = "/t/entry.jh";

/** Parse `src` (plus any extra imported modules) and emit Mermaid for `def`. */
function graphOf(
  src: string,
  def = "main",
  extra: Array<{ path: string; src: string }> = [],
): string {
  const astByFile = new Map([[ENTRY, parsejaiph(src, ENTRY)]]);
  for (const e of extra) astByFile.set(e.path, parsejaiph(e.src, e.path));
  const graph = moduleGraphFromAsts(ENTRY, astByFile);
  const model = buildGraph(graph, def);
  assert.ok(model, `no def ${def}`);
  return emitMermaid(model!);
}

test("sequential calls each become a rectangle linked through its subgraph", () => {
  const out = graphOf(`
export def main() {
  a()
  b()
}
def a() {
  log "x"
}
def b() {
  log "y"
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3["a()"]
    n6["b()"]
  end
  subgraph sg2 ["def a"]
    n4(["start"])
    n5(["end"])
  end
  subgraph sg3 ["def b"]
    n7(["start"])
    n8(["end"])
  end
  n1 --> n3
  n4 --> n5
  n3 --> n4
  n5 --> n6
  n7 --> n8
  n6 --> n7
  n8 --> n2
`,
  );
});

test("script, inline script, and prompt become subroutine/subroutine/hexagon leaves", () => {
  const out = graphOf(`
script s = '''
  echo hi
'''
export def main() {
  s()
  'echo inline'()
  prompt "do the thing"
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3[["s()"]]
    n4[["'echo inline'()"]]
    n5{{"prompt do the thing"}}
  end
  n1 --> n3
  n3 --> n4
  n4 --> n5
  n5 --> n2
`,
  );
});

test("if without else lets the no edge fall through to the next step", () => {
  const out = graphOf(`
export def main(x) {
  if x == "y" {
    a()
  }
  b()
}
def a() {
  log "a"
}
def b() {
  log "b"
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3{"x == #34;y#34;"}
    n4["a()"]
    n7["b()"]
  end
  subgraph sg2 ["def a"]
    n5(["start"])
    n6(["end"])
  end
  subgraph sg3 ["def b"]
    n8(["start"])
    n9(["end"])
  end
  n1 --> n3
  n3 -->|"yes"| n4
  n5 --> n6
  n4 --> n5
  n6 --> n7
  n3 -->|"no"| n7
  n8 --> n9
  n7 --> n8
  n9 --> n2
`,
  );
});

test("if with else branches both arms before rejoining", () => {
  const out = graphOf(`
export def main(x) {
  if x =~ /ok/ {
    a()
  } else {
    b()
  }
}
def a() {
  log "a"
}
def b() {
  log "b"
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3{"x =~ /ok/"}
    n4["a()"]
    n7["b()"]
  end
  subgraph sg2 ["def a"]
    n5(["start"])
    n6(["end"])
  end
  subgraph sg3 ["def b"]
    n8(["start"])
    n9(["end"])
  end
  n1 --> n3
  n3 -->|"yes"| n4
  n5 --> n6
  n4 --> n5
  n3 -->|"no"| n7
  n8 --> n9
  n7 --> n8
  n6 --> n2
  n9 --> n2
`,
  );
});

test("match with three arms labels one edge per arm; a fail arm is a failure node", () => {
  const out = graphOf(`
export def main(x) {
  const r = match x {
    "a" => alpha
    "b" => fail "nope"
    _ => omega
  }
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3{"r = match x"}
    n4["fail nope"]:::failure
  end
  n1 --> n3
  n3 -->|"#34;b#34;"| n4
  n3 -->|"#34;a#34;"| n2
  n3 -->|"_"| n2
  classDef failure fill:#fdd,stroke:#d33,color:#900;
`,
  );
});

test("for has a loop node with a back edge", () => {
  const out = graphOf(`
export def main(paths) {
  for p in paths {
    a()
  }
}
def a() {
  log "a"
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3["for p in paths"]
    n4["a()"]
  end
  subgraph sg2 ["def a"]
    n5(["start"])
    n6(["end"])
  end
  n1 --> n3
  n3 --> n4
  n5 --> n6
  n4 --> n5
  n6 -->|"loop"| n3
  n3 --> n2
`,
  );
});

test("catch adds a dashed on-failure edge then continues", () => {
  const out = graphOf(`
export def main() {
  a() catch (e) {
    log "recovered"
  }
  b()
}
def a() {
  log "a"
}
def b() {
  log "b"
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3["a()"]
    n6["b()"]
  end
  subgraph sg2 ["def a"]
    n4(["start"])
    n5(["end"])
  end
  subgraph sg3 ["def b"]
    n7(["start"])
    n8(["end"])
  end
  n1 --> n3
  n4 --> n5
  n3 --> n4
  n5 --> n6
  n3 -.->|"on failure"| n6
  n7 --> n8
  n6 --> n7
  n8 --> n2
`,
  );
});

test("recover adds a dashed on-failure edge and a retry edge back to the call", () => {
  const out = graphOf(`
export def main() {
  a() recover (e) {
    fix()
  }
}
def a() {
  log "a"
}
def fix() {
  log "fix"
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3["a()"]
    n6["fix()"]
  end
  subgraph sg2 ["def a"]
    n4(["start"])
    n5(["end"])
  end
  subgraph sg3 ["def fix"]
    n7(["start"])
    n8(["end"])
  end
  n1 --> n3
  n4 --> n5
  n3 --> n4
  n3 -.->|"on failure"| n6
  n7 --> n8
  n6 --> n7
  n8 -->|"retry"| n3
  n5 --> n2
`,
  );
});

test("fail is a terminal failure node; a short return value labels the edge to end", () => {
  const out = graphOf(`
export def main(x) {
  if x == "bad" {
    fail "it is bad"
  }
  return "all good"
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3{"x == #34;bad#34;"}
    n4["fail it is bad"]:::failure
  end
  n1 --> n3
  n3 -->|"yes"| n4
  n3 -->|"#34;all good#34;"| n2
  classDef failure fill:#fdd,stroke:#d33,color:#900;
`,
  );
});

test("const x = f() shows the call with the bound name in the label", () => {
  const out = graphOf(`
export def main() {
  const v = compute()
  return v
}
def compute() {
  return "42"
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3["v = compute()"]
  end
  subgraph sg2 ["def compute"]
    n4(["start"])
    n5(["end"])
  end
  n1 --> n3
  n4 -->|"#34;42#34;"| n5
  n3 --> n4
  n5 -->|"#34;$#123;v#125;#34;"| n2
`,
  );
});

test("send has a dashed edge to each route target def of the channel", () => {
  const out = graphOf(`
channel ch -> handler
export def main() {
  send "payload" -> ch
}
def handler(msg) {
  log "got"
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3["send #34;payload#34; -#62; ch"]
  end
  subgraph sg2 ["def handler"]
    n4(["start"])
    n5(["end"])
  end
  n1 --> n3
  n4 --> n5
  n3 -.-> n4
  n3 --> n2
`,
  );
});

test("async uses a dashed fork edge and continues past the call", () => {
  const out = graphOf(`
export def main() {
  async worker()
}
def worker() {
  log "w"
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3["worker()"]
  end
  subgraph sg2 ["def worker"]
    n4(["start"])
    n5(["end"])
  end
  n1 --> n3
  n4 --> n5
  n3 -.-> n4
  n3 --> n2
`,
  );
});

test("a stdin pipeline shows its stages in order", () => {
  const out = graphOf(`
script gen = '''
  echo hi
'''
script up = '''
  tr a-z A-Z
'''
script cnt = '''
  wc -l
'''
export def main() {
  const n = stdin gen() -> up() -> cnt()
  return n
}
`);
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3[["gen()"]]
    n4[["up()"]]
    n5[["n = cnt()"]]
  end
  n1 --> n3
  n3 --> n4
  n4 --> n5
  n5 -->|"#34;$#123;n#125;#34;"| n2
`,
  );
});

test("an imported def through an alias is a subgraph titled alias.name", () => {
  const out = graphOf(
    `
import "./lib.jh" as lib
export def main() {
  lib.helper()
}
`,
    "main",
    [{ path: "/t/lib.jh", src: `export def helper() {\n  log "h"\n}\n` }],
  );
  assert.equal(
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3["lib.helper()"]
  end
  subgraph sg2 ["lib.helper"]
    n4(["start"])
    n5(["end"])
  end
  n1 --> n3
  n4 --> n5
  n3 --> n4
  n5 --> n2
`,
  );
});

test("recursion draws each subgraph once (a calls b, b calls a)", () => {
  const out = graphOf(`
export def main() {
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
    out,
    `flowchart TD
  subgraph sg1 ["def main"]
    n1(["start"])
    n2(["end"])
    n3["a()"]
  end
  subgraph sg2 ["def a"]
    n4(["start"])
    n5(["end"])
    n6["b()"]
  end
  subgraph sg3 ["def b"]
    n7(["start"])
    n8(["end"])
    n9["a()"]
  end
  n1 --> n3
  n4 --> n6
  n7 --> n9
  n9 --> n4
  n5 --> n8
  n6 --> n7
  n8 --> n5
  n3 --> n4
  n5 --> n2
`,
  );
});

test("default entry is main; a missing def is reported with the available defs", () => {
  const astByFile = new Map([
    [ENTRY, parsejaiph(`export def main() {\n  log "x"\n}\ndef helper() {\n  log "y"\n}\n`, ENTRY)],
  ]);
  const graph = moduleGraphFromAsts(ENTRY, astByFile);
  assert.deepEqual(entryDefNames(graph), ["main", "helper"]);
  assert.equal(buildGraph(graph, "nope"), null);
  assert.ok(buildGraph(graph, "helper"));
});
