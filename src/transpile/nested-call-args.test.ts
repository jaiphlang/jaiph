import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScripts } from "../transpiler";

// Managed calls nested in call arguments — `show(bar())`, `show('echo $1'(x))`,
// `show(python3'print(1)'())` — are stored as literal argument text. The
// validator and the script emitter recognize them with the parser's shared
// `parseNestedCallArg`, so they are checked at compile time and their inline
// script files are emitted (the runtime used to fail with "script file not found").

function build(lines: string[]): { out: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "jaiph-nested-args-"));
  const out = join(root, "out");
  writeFileSync(join(root, "m.jh"), [...lines, ""].join("\n"));
  const cleanup = (): void => rmSync(root, { recursive: true, force: true });
  try {
    buildScripts(join(root, "m.jh"), out);
  } catch (err) {
    cleanup();
    throw err;
  }
  return { out, cleanup };
}

const show = "script show = 'echo \"[$1]\"'";

test("nested inline scripts in call arguments get their script files emitted", () => {
  const { out, cleanup } = build([
    show,
    "export def main() {",
    "  show('echo hi'())",
    "  show(node'console.log(1)'())",
    "  show(show('echo $1'(\"deep\")))",
    "}",
  ]);
  try {
    const scriptsDir = join(out, "scripts");
    const inline = readdirSync(scriptsDir).filter((n) => n.startsWith("__inline_"));
    const contents = inline.map((n) => readFileSync(join(scriptsDir, n), "utf8"));
    assert.equal(inline.length, 3, `expected 3 inline scripts, got ${inline.join(", ")}`);
    assert.ok(contents.some((c) => c.startsWith("#!/usr/bin/env node\n") && c.includes("console.log(1)")));
    assert.ok(contents.some((c) => c.includes("echo hi")));
    assert.ok(contents.some((c) => c.includes("echo $1")), "inline script nested two levels deep is emitted");
  } finally {
    cleanup();
  }
});

test("an unknown callee nested in a call argument is a compile error", () => {
  assert.throws(
    () => build([show, "export def main() {", "  show(nope())", "}"]),
    /E_VALIDATE unknown local def or script reference "nope"/,
  );
});

test("Jaiph interpolation in a nested one-line inline script is E_PARSE", () => {
  assert.throws(
    () => build([show, "export def main() {", "  show('echo ${x}'())", "}"]),
    /E_PARSE script bodies cannot contain Jaiph interpolation \(\$\{x\}\)/,
  );
});

test("an unknown bare identifier passed to a nested inline script is a compile error", () => {
  assert.throws(
    () => build([show, "export def main() {", "  show('echo $1'(missing))", "}"]),
    /unknown identifier "missing" used as bare argument/,
  );
});

test("arguments of a top-level inline script are validated like call arguments", () => {
  assert.throws(
    () => build(["export def main() {", "  'echo $1'(missing)", "}"]),
    /unknown identifier "missing" used as bare argument/,
  );
});
