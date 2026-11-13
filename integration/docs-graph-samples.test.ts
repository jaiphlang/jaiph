import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// docs/graph.md shows each landing-page sample next to its `jaiph graph`
// output. Every sample is a test case: its source must equal the example file
// it names, and its Mermaid block must equal what the command prints today,
// byte for byte. When the graph output changes on purpose, paste the
// "actual" text from the failure into the sample's data-graph-mermaid block.

const REPO_ROOT = process.cwd();
const CLI_PATH = join(REPO_ROOT, "dist/src/cli.js");
const PAGE = readFileSync(join(REPO_ROOT, "docs/graph.md"), "utf8");

interface Sample {
  panel: string;
  file?: string;
  args: string[];
  source: string;
  mermaid: string;
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function codeBlock(panel: string, attr: string): string {
  const m = panel.match(new RegExp(`<code[^>]*\\b${attr}\\b[^>]*>([\\s\\S]*?)</code>`));
  assert.ok(m, `sample panel is missing its <code ${attr}> block:\n${panel.slice(0, 200)}`);
  return unescapeHtml(m![1]);
}

function samples(): Sample[] {
  const out: Sample[] = [];
  const re = /<div class="code-tab-panel[^"]*"([^>]*\bdata-graph-sample\b[^>]*)>([\s\S]*?)\n<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(PAGE)) !== null) {
    const attrs = m[1];
    const panel = /data-panel="([^"]+)"/.exec(attrs)?.[1] ?? "?";
    const file = /data-sample-file="([^"]+)"/.exec(attrs)?.[1];
    const args = /data-graph-args="([^"]*)"/.exec(attrs)?.[1].split(" ").filter(Boolean) ?? [];
    out.push({ panel, file, args, source: codeBlock(m[2], "data-sample-source"), mermaid: codeBlock(m[2], "data-graph-mermaid") });
  }
  return out;
}

function graph(args: string[], file: string): string {
  const r = spawnSync("node", [CLI_PATH, "graph", ...args, file], { encoding: "utf8" });
  assert.equal(r.status, 0, `jaiph graph ${args.join(" ")} ${file} failed:\n${r.stderr}`);
  return r.stdout;
}

test("docs/graph.md: every non-test example has a sample panel", () => {
  const files = new Set(samples().map((s) => s.file).filter(Boolean));
  const examples = readdirSync(join(REPO_ROOT, "examples")).filter(
    (f) => f.endsWith(".jh") && !f.endsWith(".test.jh"),
  );
  for (const f of examples) assert.ok(files.has(f), `docs/graph.md has no sample for examples/${f}`);
});

test("docs/graph.md: each sample source equals its examples/ file", () => {
  for (const s of samples()) {
    if (!s.file) continue;
    const expected = readFileSync(join(REPO_ROOT, "examples", s.file), "utf8").replace(/\n$/, "");
    assert.equal(s.source, expected, `${s.panel}: source differs from examples/${s.file}`);
  }
});

test("docs/graph.md: each sample's Mermaid equals jaiph graph output byte for byte", () => {
  const all = samples();
  assert.ok(all.length >= 6, `expected at least 6 graph samples, found ${all.length}`);
  const dir = mkdtempSync(join(tmpdir(), "jaiph-graph-docs-"));
  try {
    for (const s of all) {
      let path: string;
      if (s.file) {
        path = join(REPO_ROOT, "examples", s.file);
      } else {
        path = join(dir, `${s.panel}.jh`);
        writeFileSync(path, s.source + "\n", "utf8");
      }
      const actual = graph(s.args, path).replace(/\n$/, "");
      assert.equal(s.mermaid, actual, `${s.panel}: docs Mermaid differs from jaiph graph output`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
