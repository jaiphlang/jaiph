import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// docs/index.html shows each sample's source beside its `jaiph graph` chart.
// Each sample tab must show exactly the examples/ file it names, and each
// chart's Mermaid text must equal what the command prints today, byte for
// byte. When an example or the graph output changes on purpose, copy the new
// source into the tab and paste the "actual" text from the failure into the
// sample's data-graph-mermaid script.
//
// A chart outside a sample tab (the opening fix_tests.jh snippet) is not in
// examples/. Its source is written to a temp dir and the command runs on it.

const REPO_ROOT = process.cwd();
const CLI_PATH = join(REPO_ROOT, "dist/src/cli.js");
const PAGE = readFileSync(join(REPO_ROOT, "docs/index.html"), "utf8");

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

interface Panel {
  file: string;
  source: string;
  mermaid?: string;
}

/**
 * Sample tabs: every `.code-tab-panel` that names an examples/ file. A sample
 * holds its own Graph and Output panels, so a sample ends at the next panel
 * that names a file, or at the end of the section.
 */
function panels(): Panel[] {
  const out: Panel[] = [];
  const re =
    /<div class="code-tab-panel[^>]*\bdata-sample-file="([^"]+)">([\s\S]*?)(?=<div class="code-tab-panel[^>]*\bdata-sample-file=|<\/section>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(PAGE)) !== null) {
    const [, file, body] = m;
    const source = /<code[^>]*\bdata-sample-source>([\s\S]*?)<\/code>/.exec(body);
    assert.ok(source, `${file}: sample tab has no source block`);
    const mermaid = /<script type="text\/plain" data-graph-mermaid>\n([\s\S]*?)\n<\/script>/.exec(body);
    out.push({ file, source: unescapeHtml(source![1]), mermaid: mermaid?.[1] });
  }
  return out;
}

function graph(file: string): string {
  const r = spawnSync("node", [CLI_PATH, "graph", file], { encoding: "utf8" });
  assert.equal(r.status, 0, `jaiph graph ${file} failed:\n${r.stderr}`);
  return r.stdout.replace(/\n$/, "");
}

test("docs/index.html: every non-test example has a sample tab", () => {
  const files = new Set(panels().map((p) => p.file));
  const examples = readdirSync(join(REPO_ROOT, "examples")).filter(
    (n) => n.endsWith(".jh") && !n.endsWith(".test.jh"),
  );
  for (const f of examples) {
    assert.ok(files.has(f), `docs/index.html has no sample tab for examples/${f}`);
  }
});

test("docs/index.html: each sample tab's source equals its examples/ file", () => {
  for (const p of panels()) {
    const expected = readFileSync(join(REPO_ROOT, "examples", p.file), "utf8").replace(/\n$/, "");
    assert.equal(p.source, expected, `sample tab differs from examples/${p.file}`);
  }
});

test("docs/index.html: each sample's chart equals jaiph graph output byte for byte", () => {
  for (const p of panels()) {
    if (p.file.endsWith(".test.jh")) {
      assert.equal(p.mermaid, undefined, `${p.file}: a test file cannot be graphed`);
      continue;
    }
    assert.ok(p.mermaid, `${p.file}: sample tab has no chart`);
    assert.equal(p.mermaid, graph(join(REPO_ROOT, "examples", p.file)), `${p.file}: chart differs from jaiph graph output`);
  }
});

test("docs/index.html: the opening snippet compiles and its chart equals jaiph graph output", () => {
  const m = /data-graph-sample="fix-tests">[\s\S]*?<code class="language-jaiph">([\s\S]*?)<\/code>[\s\S]*?<script type="text\/plain" data-graph-mermaid>\n([\s\S]*?)\n<\/script>/.exec(PAGE);
  assert.ok(m, "docs/index.html has no fix-tests snippet with a chart");
  const dir = mkdtempSync(join(tmpdir(), "jaiph-landing-"));
  try {
    const file = join(dir, "fix_tests.jh");
    writeFileSync(file, unescapeHtml(m![1]) + "\n", "utf8");
    assert.equal(m![2], graph(file), "fix-tests chart differs from jaiph graph output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs/index.html: every chart is inside a Liquid raw block", () => {
  const scripts = PAGE.match(/<script type="text\/plain" data-graph-mermaid>/g) ?? [];
  const raw = PAGE.match(/\{% raw %\}<script type="text\/plain" data-graph-mermaid>/g) ?? [];
  assert.ok(scripts.length >= 6, `expected at least 6 charts, found ${scripts.length}`);
  assert.equal(raw.length, scripts.length, "a chart outside {% raw %} breaks on Mermaid's {{ }} shapes");
});
