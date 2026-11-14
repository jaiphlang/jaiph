import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A docs page can show the `jaiph graph` chart of one of its own code blocks:
//
//   <div class="graph-sample" data-graph-sample="<id>" data-graph-block="<n>">
//   <div class="graph-render" …></div>
//   {% raw %}<script type="text/plain" data-graph-mermaid>
//   …Mermaid text…
//   </script>{% endraw %}
//   </div>
//
// `data-graph-block` is the 1-based index of a ```jh / ```jaiph fenced block on
// the same page. The Mermaid text must equal what `jaiph graph` prints for that
// block today, byte for byte, and the page must set `mermaid: true` so the
// layout loads the renderer. docs/execution-flow.md has its own test.

const REPO_ROOT = process.cwd();
const DOCS_DIR = join(REPO_ROOT, "docs");
const CLI_PATH = join(REPO_ROOT, "dist/src/cli.js");

interface Chart {
  page: string;
  id: string;
  block: number;
  mermaid: string;
}

function fencedBlocks(page: string): string[] {
  return [...page.matchAll(/^```(?:jh|jaiph)\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
}

function charts(): Chart[] {
  const out: Chart[] = [];
  for (const name of readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"))) {
    const page = readFileSync(join(DOCS_DIR, name), "utf8");
    const re =
      /<div class="graph-sample" data-graph-sample="([^"]+)" data-graph-block="(\d+)">[\s\S]*?<script type="text\/plain" data-graph-mermaid>\n([\s\S]*?)\n<\/script>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(page)) !== null) out.push({ page: name, id: m[1], block: Number(m[2]), mermaid: m[3] });
  }
  return out;
}

test("docs: a page with an inline chart sets mermaid: true and wraps the chart in a raw block", () => {
  const all = charts();
  assert.ok(all.length >= 2, `expected at least 2 inline charts, found ${all.length}`);
  for (const c of all) {
    const page = readFileSync(join(DOCS_DIR, c.page), "utf8");
    assert.match(page, /^mermaid: true$/m, `${c.page}: front matter must set mermaid: true`);
    const scripts = page.match(/<script type="text\/plain" data-graph-mermaid>/g) ?? [];
    const raw = page.match(/\{% raw %\}<script type="text\/plain" data-graph-mermaid>/g) ?? [];
    assert.equal(raw.length, scripts.length, `${c.page}: a chart outside {% raw %} breaks on Mermaid's {{ }} shapes`);
  }
});

test("docs: each inline chart equals jaiph graph output for its code block, byte for byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaiph-inline-charts-"));
  try {
    for (const c of charts()) {
      const blocks = fencedBlocks(readFileSync(join(DOCS_DIR, c.page), "utf8"));
      const source = blocks[c.block - 1];
      assert.ok(source, `${c.page} (${c.id}): no jh code block number ${c.block}`);
      const file = join(dir, `${c.id}.jh`);
      writeFileSync(file, source, "utf8");
      const r = spawnSync("node", [CLI_PATH, "graph", file], { encoding: "utf8" });
      assert.equal(r.status, 0, `${c.page} (${c.id}): jaiph graph failed:\n${r.stderr}`);
      assert.equal(c.mermaid, r.stdout.replace(/\n$/, ""), `${c.page} (${c.id}): chart differs from jaiph graph output`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
