// Query-check for the shipped Zed highlight / injection queries.
//
// Drives the real Tree-sitter CLI against the in-repo grammar
// (grammars/tree-sitter-jaiph) and the queries this extension ships
// (languages/jaiph/*.scm), so it fails if either the grammar or a query
// regresses away from the current Jaiph language surface.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, "..");
const GRAMMAR_DIR = path.join(PLUGIN, "..", "..", "grammars", "tree-sitter-jaiph");
const LANG_DIR = path.join(PLUGIN, "languages", "jaiph");
const FIXTURES = path.join(HERE, "fixtures");
const TS = path.join(PLUGIN, "node_modules", ".bin", "tree-sitter");

function ts(args, opts = {}) {
  return execFileSync(TS, args, { cwd: GRAMMAR_DIR, encoding: "utf8", ...opts });
}

// One capture emitted by `tree-sitter query`. `text` is absent for multi-line
// captures (the CLI omits it), which we use to detect multi-line strings.
function runQuery(queryFile, fixture) {
  const out = ts([
    "query",
    path.join(LANG_DIR, queryFile),
    path.join(FIXTURES, fixture),
  ]);
  const caps = [];
  const re =
    /capture: (?:\d+ - )?([\w.]+), start: \((\d+), \d+\), end: \((\d+), \d+\)(?:, text: `([^`]*)`)?/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    caps.push({ name: m[1], startRow: +m[2], endRow: +m[3], text: m[4] });
  }
  return caps;
}

const has = (caps, name, text) =>
  caps.some((c) => c.name === name && c.text === text);

before(() => {
  // Bind grammar.js <-> queries: regenerate src/ so a grammar edit that breaks
  // the queries fails here rather than shipping stale generated parser code.
  ts(["generate"]);
});

test("keywords, comments, and strings highlight in current.jh", () => {
  const caps = runQuery("highlights.scm", "current.jh");

  const keywords = [
    "import", "export", "config", "channel", "script", "rule", "workflow",
    "const", "run", "ensure", "prompt", "log", "logerr", "logwarn", "fail",
    "return", "recover", "catch", "if", "else", "for", "in", "match", "async",
    "returns",
  ];
  for (const kw of keywords) {
    assert.ok(has(caps, "keyword", kw), `expected "${kw}" to highlight as @keyword`);
  }

  // Comments (shebang line is a comment too).
  assert.ok(
    caps.some((c) => c.name === "comment"),
    "expected at least one @comment",
  );

  // Double-quoted strings.
  assert.ok(has(caps, "string", '"my-project"'), 'expected "my-project" as @string');
  // A triple-quoted string spans multiple lines (proves triple_string works).
  assert.ok(
    caps.some((c) => c.name === "string" && c.endRow > c.startRow),
    "expected a multi-line @string (triple-quoted block)",
  );

  // Dotted names (config keys / qualified refs) are @property, so a leading
  // segment like `run` in `run.recover_limit` is NOT mis-highlighted as a keyword.
  assert.ok(has(caps, "property", "run.recover_limit"), "config key should be @property");
  assert.ok(!has(caps, "keyword", "run.recover_limit"), "config key must not be @keyword");
});

test("test-block keywords highlight in current.test.jh", () => {
  const caps = runQuery("highlights.scm", "current.test.jh");
  for (const kw of [
    "test", "mock", "allow_failure",
    "expect_contain", "expect_not_contain", "expect_equal",
  ]) {
    assert.ok(has(caps, "keyword", kw), `expected "${kw}" to highlight as @keyword`);
  }
});

test("stale `wait` surface is not a keyword", () => {
  const caps = runQuery("highlights.scm", "regression.jh");
  assert.ok(!has(caps, "keyword", "wait"), "`wait` was removed; must not be @keyword");
  assert.ok(has(caps, "variable", "wait"), "`wait` should highlight as a plain @variable");
});

test("injections resolve embedded script languages", () => {
  const caps = runQuery("injections.scm", "current.jh");
  assert.ok(has(caps, "language", "bash"), "expected bash-fenced script injection");
  assert.ok(has(caps, "language", "python3"), "expected python3 inline-script injection");
  assert.ok(
    caps.some((c) => c.name === "content"),
    "expected an @content injection region",
  );
});

test("extension.toml pins the grammar and references only in-tree files", () => {
  const ext = fs.readFileSync(path.join(PLUGIN, "extension.toml"), "utf8");
  assert.match(ext, /\[grammars\.jaiph\]/, "extension.toml must declare [grammars.jaiph]");
  assert.match(ext, /repository\s*=/, "grammar must be pinned by repository");
  assert.match(ext, /rev\s*=\s*"[0-9a-f]{7,40}"/, "grammar must be pinned by revision");
  assert.match(ext, /path\s*=\s*"grammars\/tree-sitter-jaiph"/, "grammar subdir must be pinned");

  const cfg = fs.readFileSync(path.join(LANG_DIR, "config.toml"), "utf8");
  assert.match(cfg, /grammar\s*=\s*"jaiph"/, "config.toml must select the jaiph grammar");
  assert.match(cfg, /path_suffixes\s*=.*"jh"/, "config.toml must claim the .jh suffix");

  // Every query the extension relies on exists inside plugins/zed.
  for (const f of ["highlights.scm", "injections.scm", "config.toml"]) {
    assert.ok(fs.existsSync(path.join(LANG_DIR, f)), `${f} must exist under languages/jaiph`);
  }
});
