import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_GRAPH_PREVIEW_OPTIONS, graphArgs, listDefNames, runGraph } from "../src/graph";

// These tests run the REAL monorepo `jaiph` CLI so they break if the
// `jaiph graph` contract the preview depends on (Mermaid on stdout, exit 0;
// reason on stderr, exit 1; --def / -d / -i / -l flags) ever changes.
const PLUGIN_ROOT = path.join(__dirname, "..", "..");
const REPO_ROOT = path.join(PLUGIN_ROOT, "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "src", "cli.js");
const FIXTURES = path.join(PLUGIN_ROOT, "test", "fixtures");

let shim: string;

before(() => {
  assert.ok(fs.existsSync(CLI), `built CLI not found at ${CLI}; run \`npm run build\` at the repo root first`);
  shim = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jaiph-shim-")), "jaiph");
  fs.writeFileSync(shim, `#!/usr/bin/env node\nrequire(${JSON.stringify(CLI)}).runCli(process.argv);\n`);
  fs.chmodSync(shim, 0o755);
});

function graph(file: string, overrides: Partial<typeof DEFAULT_GRAPH_PREVIEW_OPTIONS> = {}) {
  return runGraph({
    compilerPath: shim,
    filePath: path.join(FIXTURES, file),
    options: { ...DEFAULT_GRAPH_PREVIEW_OPTIONS, ...overrides },
    usingDefaultPath: true,
  });
}

test("graphArgs maps preview options onto CLI flags", () => {
  assert.deepEqual(graphArgs("a.jh", DEFAULT_GRAPH_PREVIEW_OPTIONS), ["graph", "--def", "main", "-d", "3", "-i", "1", "a.jh"]);
  assert.deepEqual(graphArgs("a.jh", { def: "x", depth: "all", importDepth: 0, libs: true }), [
    "graph", "--def", "x", "-d", "all", "-i", "0", "-l", "a.jh",
  ]);
});

test("a valid file yields a Mermaid flowchart that expands called defs", async () => {
  const result = await graph("graph.jh");
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.match(result.mermaid, /^flowchart TD/);
  assert.match(result.mermaid, /<b>def<\/b> helper/);
});

test("depth 0 collapses called defs", async () => {
  const result = await graph("graph.jh", { depth: 0 });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") assert.match(result.mermaid, /%% collapsed:/);
});

test("--def picks another entry def", async () => {
  const result = await graph("graph.jh", { def: "helper" });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") assert.match(result.mermaid, /subgraph g1 \["<b>def<\/b> helper"\]/);
});

test("an unknown def is an error naming the available defs", async () => {
  const result = await graph("graph.jh", { def: "nope" });
  assert.equal(result.kind, "error");
  if (result.kind === "error") assert.match(result.message, /Available defs: helper, main/);
});

test("an invalid file is an error carrying the diagnostic", async () => {
  const result = await graph("invalid.jh");
  assert.equal(result.kind, "error");
  if (result.kind === "error") assert.match(result.message, /E_/);
});

test("missing binary reports a configuration error", async () => {
  const result = await runGraph({
    compilerPath: "jaiph-does-not-exist-xyz",
    filePath: path.join(FIXTURES, "graph.jh"),
    options: DEFAULT_GRAPH_PREVIEW_OPTIONS,
    usingDefaultPath: true,
  });
  assert.equal(result.kind, "config-error");
});

test("listDefNames finds top-level defs in source order", () => {
  const src = 'import "x.jh" as x\n\ndef a() {\n}\nexport def main(n) {\n  def nested() {\n  }\n}\n# def comment() {\n';
  assert.deepEqual(listDefNames(src), ["a", "main"]);
});
