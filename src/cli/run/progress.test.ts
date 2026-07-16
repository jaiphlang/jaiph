import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLabel,
  formatElapsedDuration,
  formatRunningBottomLine,
  collectWorkflowChildren,
  buildRunTreeRows,
  styleKeywordLabel,
  styleDim,
  styleYellow,
  styleBold,
} from "./progress";
import { parsejaiph } from "../../parser";

/**
 * Fixtures are built by parsing real Jaiph source so test data flows through
 * the same producer as production — no hand-written AST shapes to keep in
 * sync with the type definitions.
 */
function modFor(source: string) {
  return parsejaiph(source, "test.jh");
}

// --- parseLabel ---

test("parseLabel: splits kind and name on first space", () => {
  const { kind, name } = parseLabel("workflow default");
  assert.equal(kind, "workflow");
  assert.equal(name, "default");
});

test("parseLabel: returns 'step' kind when no space", () => {
  const { kind, name } = parseLabel("wait");
  assert.equal(kind, "step");
  assert.equal(name, "wait");
});

test("parseLabel: handles multi-word name", () => {
  const { kind, name } = parseLabel("prompt \"hello world\"");
  assert.equal(kind, "prompt");
  assert.equal(name, "\"hello world\"");
});

// --- formatElapsedDuration ---

test("formatElapsedDuration: formats milliseconds as seconds", () => {
  assert.equal(formatElapsedDuration(1500), "1.5s");
});

test("formatElapsedDuration: drops trailing .0", () => {
  assert.equal(formatElapsedDuration(2000), "2s");
});

test("formatElapsedDuration: formats >= 60s as minutes and seconds", () => {
  assert.equal(formatElapsedDuration(90000), "1m 30s");
});

test("formatElapsedDuration: handles exact minute", () => {
  assert.equal(formatElapsedDuration(120000), "2m 0s");
});

test("formatElapsedDuration: handles sub-second", () => {
  assert.equal(formatElapsedDuration(100), "0.1s");
});

// --- collectWorkflowChildren ---

test("collectWorkflowChildren: returns empty for unknown workflow", () => {
  const mod = modFor(`workflow default() {
  log "hi"
}`);
  assert.deepStrictEqual(collectWorkflowChildren(mod, "missing"), []);
});

test("collectWorkflowChildren: collects run step as workflow row", () => {
  const mod = modFor([
    "workflow default() {",
    "  run deploy()",
    "}",
    "workflow deploy() {",
    "  log \"d\"",
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "workflow deploy");
  assert.equal(items[0].nested, "deploy");
});

test("collectWorkflowChildren: collects async run with prefix", () => {
  const mod = modFor([
    "workflow default() {",
    "  run async deploy()",
    "}",
    "workflow deploy() {",
    "  log \"d\"",
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, "async workflow deploy");
});

test("collectWorkflowChildren: collects ensure step as rule row", () => {
  const mod = modFor([
    "rule gate() {",
    "  return \"ok\"",
    "}",
    "workflow default() {",
    "  ensure gate()",
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, "rule gate");
});

test("collectWorkflowChildren: collects prompt step with preview", () => {
  const mod = modFor([
    "workflow default() {",
    '  prompt "Pick one"',
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, 'prompt "Pick one"');
});

test("collectWorkflowChildren: collects log / logerr / logwarn / fail (say) rows", () => {
  const mod = modFor([
    "workflow default() {",
    '  log "ok"',
    '  logerr "err"',
    '  logwarn "warn"',
    '  fail "boom"',
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.ok(items.some((i) => i.label.startsWith("ℹ ")));
  assert.ok(items.some((i) => i.label.startsWith("! ")));
  assert.ok(items.some((i) => i.label.startsWith("\u26a0 ")));
  assert.ok(items.some((i) => i.label.startsWith("fail ")));
});

test("collectWorkflowChildren: collects send step", () => {
  const mod = modFor([
    "channel ch",
    "workflow default() {",
    '  ch <- "hi"',
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.ok(items.some((i) => i.label === "ch <- send"));
});

test("collectWorkflowChildren: collects const and return rows", () => {
  const mod = modFor([
    "workflow default() {",
    '  const x = "hi"',
    "  return x",
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.ok(items.some((i) => i.label === "const x"));
  assert.ok(items.some((i) => i.label.startsWith("return ")));
});

test("collectWorkflowChildren: collects inline script as 'script (inline)'", () => {
  const mod = modFor([
    "workflow default() {",
    "  run `echo hi`()",
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.ok(items.some((i) => i.label === "script (inline)"));
});

test("collectWorkflowChildren: collects shell step with $ prefix", () => {
  const mod = modFor([
    "workflow default() {",
    "  echo hello",
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.ok(items.some((i) => i.label.startsWith("$ ")));
});

test("collectWorkflowChildren: skips trivia (comments / blank lines)", () => {
  const mod = modFor([
    "workflow default() {",
    "  # comment",
    "",
    '  log "hi"',
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items.length, 1);
  assert.ok(items[0].label.startsWith("ℹ "));
});

test("collectWorkflowChildren: const = match expression walks arms for run/ensure targets", () => {
  const mod = modFor([
    "rule gate() {",
    "  return \"ok\"",
    "}",
    "workflow other() {",
    "  log \"o\"",
    "}",
    "workflow default(name) {",
    "  const result = match name {",
    '    "x" => run other()',
    '    _ => ensure gate()',
    "  }",
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  // const row + workflow other row + rule gate row
  assert.ok(items.some((i) => i.label === "const result"));
  assert.ok(items.some((i) => i.label.startsWith("workflow other")));
  assert.ok(items.some((i) => i.label.startsWith("rule gate")));
});

// --- buildRunTreeRows ---

test("buildRunTreeRows: includes root and children", () => {
  const mod = modFor([
    "workflow default() {",
    "  run deploy()",
    "}",
    "workflow deploy() {",
    "  log \"d\"",
    "}",
  ].join("\n"));
  const rows = buildRunTreeRows(mod);
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].rawLabel, "workflow default");
});

// --- style helpers (no-color paths) ---

test("styleKeywordLabel: returns plain text when no TTY", () => {
  const prev = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  try {
    assert.equal(styleKeywordLabel("workflow default"), "workflow default");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: prev, configurable: true });
  }
});

test("styleDim / styleYellow / styleBold: no-color when not TTY", () => {
  const prev = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  try {
    assert.equal(styleDim("x"), "x");
    assert.equal(styleYellow("x"), "x");
    assert.equal(styleBold("x"), "x");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: prev, configurable: true });
  }
});

test("formatRunningBottomLine: renders status with elapsed", () => {
  const line = formatRunningBottomLine("default", 1.5);
  assert.ok(line.includes("default"));
  assert.ok(line.includes("1.5s"));
});
