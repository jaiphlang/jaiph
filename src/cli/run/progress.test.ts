import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLabel,
  formatElapsedDuration,
  formatRunningBottomLine,
  collectDefChildren,
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
  const { kind, name } = parseLabel("def main");
  assert.equal(kind, "def");
  assert.equal(name, "main");
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

// --- collectDefChildren ---

test("collectDefChildren: returns empty for unknown def", () => {
  const mod = modFor(`export def main() {
  log "hi"
}`);
  assert.deepStrictEqual(collectDefChildren(mod, "missing"), []);
});

test("collectDefChildren: collects run step as workflow row", () => {
  const mod = modFor([
    "export def main() {",
    "  run deploy()",
    "}",
    "def deploy() {",
    "  log \"d\"",
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "def deploy");
  assert.equal(items[0].nested, "deploy");
});

test("collectDefChildren: collects async run with prefix", () => {
  const mod = modFor([
    "export def main() {",
    "  run async deploy()",
    "}",
    "def deploy() {",
    "  log \"d\"",
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.equal(items[0].label, "async def deploy");
});

test("collectDefChildren: collects run step as rule row", () => {
  const mod = modFor([
    "def gate() {",
    "  return \"ok\"",
    "}",
    "export def main() {",
    "  run gate()",
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.equal(items[0].label, "def gate");
});

test("collectDefChildren: collects prompt step with preview", () => {
  const mod = modFor([
    "export def main() {",
    '  prompt "Pick one"',
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.equal(items[0].label, 'prompt "Pick one"');
});

test("collectDefChildren: collects log / logerr / logwarn / fail (say) rows", () => {
  const mod = modFor([
    "export def main() {",
    '  log "ok"',
    '  logerr "err"',
    '  logwarn "warn"',
    '  fail "boom"',
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.ok(items.some((i) => i.label.startsWith("ℹ ")));
  assert.ok(items.some((i) => i.label.startsWith("! ")));
  assert.ok(items.some((i) => i.label.startsWith("\u26a0 ")));
  assert.ok(items.some((i) => i.label.startsWith("fail ")));
});

test("collectDefChildren: collects send step", () => {
  const mod = modFor([
    "channel ch",
    "export def main() {",
    '  send "hi" -> ch',
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.ok(items.some((i) => i.label === "send -> ch"));
});

test("collectDefChildren: collects const and return rows", () => {
  const mod = modFor([
    "export def main() {",
    '  const x = "hi"',
    "  return x",
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.ok(items.some((i) => i.label === "const x"));
  assert.ok(items.some((i) => i.label.startsWith("return ")));
});

test("collectDefChildren: collects inline script as 'script (inline)'", () => {
  const mod = modFor([
    "export def main() {",
    "  run `echo hi`()",
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.ok(items.some((i) => i.label === "script (inline)"));
});

test("collectDefChildren: collects shell step with $ prefix", () => {
  const mod = modFor([
    "export def main() {",
    "  echo hello",
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.ok(items.some((i) => i.label.startsWith("$ ")));
});

test("collectDefChildren: skips trivia (comments / blank lines)", () => {
  const mod = modFor([
    "export def main() {",
    "  # comment",
    "",
    '  log "hi"',
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.equal(items.length, 1);
  assert.ok(items[0].label.startsWith("ℹ "));
});

test("collectDefChildren: const = match expression walks arms for run/run targets", () => {
  const mod = modFor([
    "def gate() {",
    "  return \"ok\"",
    "}",
    "def other() {",
    "  log \"o\"",
    "}",
    "export def main(name) {",
    "  const result = match name {",
    '    "x" => run other()',
    '    _ => run gate()',
    "  }",
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  // const row + workflow other row + rule gate row
  assert.ok(items.some((i) => i.label === "const result"));
  assert.ok(items.some((i) => i.label.startsWith("def other")));
  assert.ok(items.some((i) => i.label.startsWith("def gate")));
});

// --- buildRunTreeRows ---

test("buildRunTreeRows: includes root and children", () => {
  const mod = modFor([
    "export def main() {",
    "  run deploy()",
    "}",
    "def deploy() {",
    "  log \"d\"",
    "}",
  ].join("\n"));
  const rows = buildRunTreeRows(mod);
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].rawLabel, "def main");
});

test("buildRunTreeRows: prefix indents 4 spaces per nesting level", () => {
  const mod = modFor([
    "export def main() {",
    "  run a()",
    "}",
    "def a() {",
    "  run b()",
    "}",
    "def b() {",
    "  log \"deep\"",
    "}",
  ].join("\n"));
  const rows = buildRunTreeRows(mod);
  // root's direct children sit at prefix 0; each deeper level adds 4 spaces.
  const byLabel = (label: string) => rows.find((r) => r.rawLabel === label);
  assert.equal(rows[0].prefix, ""); // root
  assert.equal(byLabel("def a")?.prefix, ""); // default's child
  assert.equal(byLabel("def b")?.prefix, "    "); // a's child (depth 1)
  assert.equal(byLabel("ℹ deep")?.prefix, "        "); // b's child (depth 2)
});

test("buildRunTreeRows: self-recursive workflow expands exactly one level then stops", () => {
  const mod = modFor([
    "export def main() {",
    "  run rec()",
    "}",
    "def rec() {",
    "  log \"x\"",
    "  run rec()",
    "}",
  ].join("\n"));
  const rows = buildRunTreeRows(mod);
  // rec renders once under default, its self-call expands one more level, then
  // the innermost self-call is gated off — bounded, not infinite.
  const recRows = rows.filter((r) => r.rawLabel === "def rec");
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
      "export def main() {",
      "  run lib.helper()",
      "}",
    ].join("\n"),
    "/tmp/proj/main.jh",
  );
  const libMod = parsejaiph(
    ["export def helper() {", '  log "from lib"', "}"].join("\n"),
    "/tmp/proj/lib.jh",
  );
  const rows = buildRunTreeRows(
    mainMod,
    "def main",
    new Map([["lib", libMod]]),
    "/tmp/proj",
  );
  const helper = rows.find((r) => r.rawLabel === "def lib.helper");
  assert.ok(helper, "imported workflow row present");
  assert.equal(helper?.stepFunc, "lib::helper");
  assert.equal(helper?.prefix, ""); // default's direct child
  // the imported workflow's body is rendered one level deeper
  const body = rows.find((r) => r.rawLabel === "ℹ from lib");
  assert.equal(body?.prefix, "    ");
});

test("buildRunTreeRows: mutual-reference cycle is bounded by the visited guard", () => {
  const mod = modFor([
    "export def main() {",
    "  run a()",
    "}",
    "def a() {",
    "  run b()",
    "}",
    "def b() {",
    "  run a()",
    "}",
  ].join("\n"));
  const rows = buildRunTreeRows(mod);
  // default -> a -> b -> a(leaf, not re-expanded). Without the guard this would
  // recurse forever; the guard leaves exactly one un-expanded trailing "a".
  assert.deepEqual(
    rows.map((r) => r.rawLabel),
    ["def main", "def a", "def b", "def a"],
  );
  assert.equal(rows[rows.length - 1].prefix, "        ");
});

test("collectDefChildren: recover steps flatten as sibling rows", () => {
  const mod = modFor([
    "export def main() {",
    "  run risky() recover(e) {",
    "    run fallback()",
    "  }",
    "}",
    "def risky() {",
    '  log "r"',
    "}",
    "def fallback() {",
    '  log "f"',
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.equal(items[0].label, "def risky");
  assert.equal(items[0].nested, "risky");
  assert.equal(items[1].label, "def fallback");
  assert.equal(items[1].nested, "fallback");
});

test("collectDefChildren: catch steps flatten as sibling rows", () => {
  const mod = modFor([
    "export def main() {",
    "  run risky() catch (e) {",
    '    log "caught"',
    "  }",
    "}",
    "def risky() {",
    '  log "r"',
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.equal(items[0].label, "def risky");
  assert.equal(items[1].label, "ℹ caught");
});

test("collectDefChildren: long prompt preview is truncated with ellipsis", () => {
  const mod = modFor([
    "export def main() {",
    '  prompt "This is a very long prompt that should be truncated"',
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  // 24-char preview + ellipsis
  assert.equal(items[0].label, 'prompt "This is a very long prom..."');
});

test("collectDefChildren: prompt preview escapes embedded double-quotes", () => {
  const mod = modFor([
    "export def main() {",
    '  prompt "Say \\"hi\\" now"',
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.equal(items[0].label, 'prompt "Say \\"hi\\" now"');
});

test("collectDefChildren: return run and return match label variants", () => {
  const mod = modFor([
    "def other() {",
    '  log "o"',
    "}",
    "export def main(name) {",
    "  return run other()",
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.ok(items.some((i) => i.label === "return run other(...)"));

  const matchMod = modFor([
    "export def main(name) {",
    "  return match name {",
    '    "x" => "yes"',
    '    _ => "no"',
    "  }",
    "}",
  ].join("\n"));
  const matchItems = collectDefChildren(matchMod, "main");
  assert.ok(matchItems.some((i) => i.label === "return match name"));
});

// --- style helpers (ANSI paths) ---

test("style helpers: emit ANSI escape codes when stdout is a TTY", () => {
  const prevTty = process.stdout.isTTY;
  const prevNoColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  delete process.env.NO_COLOR;
  try {
    assert.equal(styleKeywordLabel("def main"), "\u001b[1mdef\u001b[0m main");
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
    assert.equal(styleKeywordLabel("def main"), "def main");
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
    assert.equal(styleKeywordLabel("def main"), "def main");
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
  const line = formatRunningBottomLine("main", 1.5);
  assert.ok(line.includes("def"));
  assert.ok(line.includes("main"));
  assert.ok(line.includes("1.5s"));
});

// --- buildRunTreeRows: multi-site self-recursion ---

test("buildRunTreeRows: workflow with two self-recursive call sites expands bounded per-site", () => {
  const mod = modFor([
    "export def main() {",
    "  run rec()",
    "}",
    "def rec() {",
    '  log "x"',
    "  run rec()",
    "  run rec()",
    "}",
  ].join("\n"));
  const rows = buildRunTreeRows(mod);
  // The per-site index bookkeeping picks a different self-call to expand at each
  // depth (site 0 at depth 0, site 1 at depth 1) and clamps deeper frames off,
  // so the tree is finite rather than infinite. This locks the exact shape.
  assert.deepEqual(
    rows.map((r) => ({ label: r.rawLabel, prefix: r.prefix.length })),
    [
      { label: "def main", prefix: 0 },
      { label: "def rec", prefix: 0 },
      { label: "ℹ x", prefix: 4 },
      { label: "def rec", prefix: 4 },
      { label: "ℹ x", prefix: 8 },
      { label: "def rec", prefix: 8 },
      { label: "ℹ x", prefix: 12 },
      { label: "def rec", prefix: 4 },
    ],
  );
  assert.equal(rows[0].isRoot, true);
});

// --- channel route declarations as tree nodes ---

test("collectDefChildren: single-target channel route becomes a tree node", () => {
  const mod = modFor([
    "channel findings -> analyst",
    "def analyst(message, chan, sender) {",
    '  log "a"',
    "}",
    "export def main() {",
    '  log "start"',
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.equal(items[0].label, "findings -> analyst");
});

test("collectDefChildren: multi-target channel route joins targets with comma", () => {
  const mod = modFor([
    "channel findings -> analyst, reviewer",
    "def analyst(message, chan, sender) {",
    '  log "a"',
    "}",
    "def reviewer(message, chan, sender) {",
    '  log "r"',
    "}",
    "export def main() {",
    '  log "start"',
    "}",
  ].join("\n"));
  const items = collectDefChildren(mod, "main");
  assert.equal(items[0].label, "findings -> analyst, reviewer");
});

test("buildRunTreeRows: channel route node renders as a top-level child row", () => {
  const mod = modFor([
    "channel findings -> analyst, reviewer",
    "def analyst(message, chan, sender) {",
    '  log "a"',
    "}",
    "def reviewer(message, chan, sender) {",
    '  log "r"',
    "}",
    "export def main() {",
    '  log "start"',
    "}",
  ].join("\n"));
  const rows = buildRunTreeRows(mod);
  assert.deepEqual(
    rows.map((r) => ({ label: r.rawLabel, prefix: r.prefix.length })),
    [
      { label: "def main", prefix: 0 },
      { label: "findings -> analyst, reviewer", prefix: 0 },
      { label: "ℹ start", prefix: 0 },
    ],
  );
});

// --- buildRunTreeRows: empty / root-only workflow ---

test("buildRunTreeRows: childless workflow yields exactly one root row", () => {
  const mod = modFor("export def main() {\n}");
  const rows = buildRunTreeRows(mod);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rawLabel, "def main");
  assert.equal(rows[0].prefix, "");
  assert.equal(rows[0].isRoot, true);
});
