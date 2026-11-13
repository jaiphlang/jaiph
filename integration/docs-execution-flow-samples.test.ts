import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// docs/execution-flow.md shows each example next to its `jaiph graph` output.
// Every example is a test case. Each source tab must equal the examples/ file
// it names, and the Mermaid tab must equal what the command prints today,
// byte for byte. When the graph output changes on purpose, paste the "actual"
// text from the failure into the example's data-graph-mermaid block.
//
// An example without data-sample-file is a snippet that is not in examples/.
// Its sources are written to a temp dir and the command runs on the first one.

const REPO_ROOT = process.cwd();
const CLI_PATH = join(REPO_ROOT, "dist/src/cli.js");
const PAGE = readFileSync(join(REPO_ROOT, "docs/execution-flow.md"), "utf8");

interface Sample {
  id: string;
  file?: string;
  args: string[];
  sources: Array<{ name: string; text: string }>;
  mermaid: string;
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function samples(): Sample[] {
  const out: Sample[] = [];
  const re = /<div class="graph-sample" data-graph-sample="([^"]+)"([^>]*)>([\s\S]*?)\{% endraw %\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(PAGE)) !== null) {
    const [, id, attrs, body] = m;
    const file = /data-sample-file="([^"]+)"/.exec(attrs)?.[1];
    const args = /data-graph-args="([^"]*)"/.exec(attrs)?.[1].split(" ").filter(Boolean) ?? [];
    const sources = [...body.matchAll(/<code[^>]*\bdata-sample-source="([^"]+)"[^>]*>([\s\S]*?)<\/code>/g)].map(
      (s) => ({ name: s[1], text: unescapeHtml(s[2]) }),
    );
    const mermaid = /<code[^>]*\bdata-graph-mermaid\b[^>]*>([\s\S]*?)<\/code>/.exec(body);
    assert.ok(sources.length > 0, `${id}: example has no source tab`);
    assert.ok(mermaid, `${id}: example has no Mermaid tab`);
    out.push({ id, file, args, sources, mermaid: unescapeHtml(mermaid![1]) });
  }
  return out;
}

function graph(args: string[], file: string): string {
  const r = spawnSync("node", [CLI_PATH, "graph", ...args, file], { encoding: "utf8" });
  assert.equal(r.status, 0, `jaiph graph ${args.join(" ")} ${file} failed:\n${r.stderr}`);
  return r.stdout;
}

test("docs/execution-flow.md: every non-test example has an example section", () => {
  const files = new Set(samples().map((s) => s.file).filter(Boolean));
  const examples = readdirSync(join(REPO_ROOT, "examples")).filter(
    (f) => f.endsWith(".jh") && !f.endsWith(".test.jh"),
  );
  for (const f of examples) assert.ok(files.has(f), `docs/execution-flow.md has no example for examples/${f}`);
});

test("docs/execution-flow.md: the first source tab is the file the command runs on", () => {
  for (const s of samples()) {
    if (s.file) assert.equal(s.sources[0].name, s.file, `${s.id}: first source tab is not ${s.file}`);
  }
});

test("docs/execution-flow.md: each source tab equals its examples/ file", () => {
  for (const s of samples()) {
    if (!s.file) continue;
    for (const src of s.sources) {
      const expected = readFileSync(join(REPO_ROOT, "examples", src.name), "utf8").replace(/\n$/, "");
      assert.equal(src.text, expected, `${s.id}: source tab differs from examples/${src.name}`);
    }
  }
});

test("docs/execution-flow.md: each example's Mermaid equals jaiph graph output byte for byte", () => {
  const all = samples();
  assert.ok(all.length >= 6, `expected at least 6 examples, found ${all.length}`);
  const dir = mkdtempSync(join(tmpdir(), "jaiph-flow-docs-"));
  try {
    for (const s of all) {
      let path: string;
      if (s.file) {
        path = join(REPO_ROOT, "examples", s.file);
      } else {
        for (const src of s.sources) writeFileSync(join(dir, src.name), src.text + "\n", "utf8");
        path = join(dir, s.sources[0].name);
      }
      const actual = graph(s.args, path).replace(/\n$/, "");
      assert.equal(s.mermaid, actual, `${s.id}: docs Mermaid differs from jaiph graph output`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
