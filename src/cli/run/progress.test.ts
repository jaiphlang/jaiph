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

test("buildRunTreeRows: prefix indents 4 spaces per nesting level", () => {
  const mod = modFor([
    "workflow default() {",
    "  run a()",
    "}",
    "workflow a() {",
    "  run b()",
    "}",
    "workflow b() {",
    "  log \"deep\"",
    "}",
  ].join("\n"));
  const rows = buildRunTreeRows(mod);
  // root's direct children sit at prefix 0; each deeper level adds 4 spaces.
  const byLabel = (label: string) => rows.find((r) => r.rawLabel === label);
  assert.equal(rows[0].prefix, ""); // root
  assert.equal(byLabel("workflow a")?.prefix, ""); // default's child
  assert.equal(byLabel("workflow b")?.prefix, "    "); // a's child (depth 1)
  assert.equal(byLabel("ℹ deep")?.prefix, "        "); // b's child (depth 2)
});

test("buildRunTreeRows: self-recursive workflow expands exactly one level then stops", () => {
  const mod = modFor([
    "workflow default() {",
    "  run rec()",
    "}",
    "workflow rec() {",
    "  log \"x\"",
    "  run rec()",
    "}",
  ].join("\n"));
  const rows = buildRunTreeRows(mod);
  // rec renders once under default, its self-call expands one more level, then
  // the innermost self-call is gated off — bounded, not infinite.
  const recRows = rows.filter((r) => r.rawLabel === "workflow rec");
  assert.equal(recRows.length, 2);
  assert.equal(recRows[0].prefix, ""); // rec called from default
  assert.equal(recRows[1].prefix, "    "); // expanded self-call one level deeper
  // exactly two "ℹ x" bodies: one per rendered rec frame
  assert.equal(rows.filter((r) => r.rawLabel === "ℹ x").length, 2);
});

test("buildRunTreeRows: imported workflow renders with alias label and stepFunc", () => {
  const mainMod = parsejaiph(
    [
      'import "lib.jh" as lib',
      "workflow default() {",
      "  run lib.helper()",
      "}",
    ].join("\n"),
    "/tmp/proj/main.jh",
  );
  const libMod = parsejaiph(
    ["export workflow helper() {", '  log "from lib"', "}"].join("\n"),
    "/tmp/proj/lib.jh",
  );
  const rows = buildRunTreeRows(
    mainMod,
    "workflow default",
    new Map([["lib", libMod]]),
    "/tmp/proj",
  );
  const helper = rows.find((r) => r.rawLabel === "workflow lib.helper");
  assert.ok(helper, "imported workflow row present");
  assert.equal(helper?.stepFunc, "lib::helper");
  assert.equal(helper?.prefix, ""); // default's direct child
  // the imported workflow's body is rendered one level deeper
  const body = rows.find((r) => r.rawLabel === "ℹ from lib");
  assert.equal(body?.prefix, "    ");
});

test("buildRunTreeRows: mutual-reference cycle is bounded by the visited guard", () => {
  const mod = modFor([
    "workflow default() {",
    "  run a()",
    "}",
    "workflow a() {",
    "  run b()",
    "}",
    "workflow b() {",
    "  run a()",
    "}",
  ].join("\n"));
  const rows = buildRunTreeRows(mod);
  // default -> a -> b -> a(leaf, not re-expanded). Without the guard this would
  // recurse forever; the guard leaves exactly one un-expanded trailing "a".
  assert.deepEqual(
    rows.map((r) => r.rawLabel),
    ["workflow default", "workflow a", "workflow b", "workflow a"],
  );
  assert.equal(rows[rows.length - 1].prefix, "        ");
});

test("collectWorkflowChildren: recover steps flatten as sibling rows", () => {
  const mod = modFor([
    "workflow default() {",
    "  run risky() recover(e) {",
    "    run fallback()",
    "  }",
    "}",
    "workflow risky() {",
    '  log "r"',
    "}",
    "workflow fallback() {",
    '  log "f"',
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, "workflow risky");
  assert.equal(items[0].nested, "risky");
  assert.equal(items[1].label, "workflow fallback");
  assert.equal(items[1].nested, "fallback");
});

test("collectWorkflowChildren: catch steps flatten as sibling rows", () => {
  const mod = modFor([
    "workflow default() {",
    "  run risky() catch (e) {",
    '    log "caught"',
    "  }",
    "}",
    "workflow risky() {",
    '  log "r"',
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, "workflow risky");
  assert.equal(items[1].label, "ℹ caught");
});

test("collectWorkflowChildren: long prompt preview is truncated with ellipsis", () => {
  const mod = modFor([
    "workflow default() {",
    '  prompt "This is a very long prompt that should be truncated"',
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  // 24-char preview + ellipsis
  assert.equal(items[0].label, 'prompt "This is a very long prom..."');
});

test("collectWorkflowChildren: prompt preview escapes embedded double-quotes", () => {
  const mod = modFor([
    "workflow default() {",
    '  prompt "Say \\"hi\\" now"',
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.equal(items[0].label, 'prompt "Say \\"hi\\" now"');
});

test("collectWorkflowChildren: return run and return match label variants", () => {
  const mod = modFor([
    "workflow other() {",
    '  log "o"',
    "}",
    "workflow default(name) {",
    "  return run other()",
    "}",
  ].join("\n"));
  const items = collectWorkflowChildren(mod, "default");
  assert.ok(items.some((i) => i.label === "return run other(...)"));

  const matchMod = modFor([
    "workflow default(name) {",
    "  return match name {",
    '    "x" => "yes"',
    '    _ => "no"',
    "  }",
    "}",
  ].join("\n"));
  const matchItems = collectWorkflowChildren(matchMod, "default");
  assert.ok(matchItems.some((i) => i.label === "return match name"));
});

// --- style helpers (ANSI paths) ---

test("style helpers: emit ANSI escape codes when stdout is a TTY", () => {
  const prevTty = process.stdout.isTTY;
  const prevNoColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  delete process.env.NO_COLOR;
  try {
    assert.equal(styleKeywordLabel("workflow default"), "[1mworkflow[0m default");
    assert.equal(styleDim("x"), "[2mx[0m");
    assert.equal(styleYellow("x"), "[33mx[0m");
    assert.equal(styleBold("x"), "[1mx[0m");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: prevTty, configurable: true });
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  }
});

test("style helpers: NO_COLOR disables ANSI even on a TTY", () => {
  const prevTty = process.stdout.isTTY;
  const prevNoColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  process.env.NO_COLOR = "1";
  try {
    assert.equal(styleKeywordLabel("workflow default"), "workflow default");
    assert.equal(styleDim("x"), "x");
    assert.equal(styleYellow("x"), "x");
    assert.equal(styleBold("x"), "x");
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: prevTty, configurable: true });
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  }
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
