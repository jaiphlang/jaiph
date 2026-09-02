import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScripts } from "../transpiler";

// Nested-declaration validation: sequential visibility (use-before-declaration),
// per-def isolation (a sibling def cannot reach another's locals), collision
// with a parameter, and shadowing acceptance.

function withFlow(lines: string[], run: (entry: string, out: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "jaiph-nested-val-"));
  try {
    const entry = join(root, "m.jh");
    writeFileSync(entry, `${lines.join("\n")}\n`);
    run(entry, join(root, "out"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("valid: nested script/def/prompt declared then used later in the same body", () => {
  withFlow(
    [
      "export def main() {",
      "  script sh = `echo hi`",
      "  def helper(name) {",
      '    return "hi-${name}"',
      "  }",
      '  prompt describe(x) = "about ${x}"',
      "  run sh()",
      '  const h = run helper("bob")',
      '  const d = prompt describe("today")',
      '  return "${h}-${d}"',
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // no throw
    },
  );
});

test("E_VALIDATE: a nested name used before its declaration is unknown", () => {
  withFlow(
    [
      "export def main() {",
      "  run foo()",
      "  script foo = `echo hi`",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown local def or script reference "foo"/,
      );
    },
  );
});

test("E_VALIDATE: another def cannot run a name declared only inside a sibling def", () => {
  withFlow(
    [
      "export def main() {",
      "  script nested_helper = `echo hi`",
      "  run other()",
      "}",
      "def other() {",
      "  run nested_helper()",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown local def or script reference "nested_helper"/,
      );
    },
  );
});

test("E_VALIDATE: a nested declaration colliding with a parameter is rejected", () => {
  withFlow(
    [
      "export def main() {",
      '  run inner("x")',
      "}",
      "def inner(name) {",
      "  script name = `echo hi`",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*cannot rebind immutable name "name".*already bound as parameter/,
      );
    },
  );
});

test("valid: a nested script shadows a module-level script of the same name", () => {
  withFlow(
    [
      "script foo = `echo module`",
      "export def main() {",
      "  script foo = `echo nested`",
      "  run foo()",
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // shadowing is allowed, no throw
    },
  );
});

test("valid: nested const/prompt ${…} interpolates enclosing params and consts", () => {
  withFlow(
    [
      "export def main(who) {",
      '  const greeting = "hello ${who}"',
      "  const note = \"\"\"",
      "    note for ${who}",
      "  \"\"\"",
      "  def helper(name) {",
      '    const msg = "${greeting}-${name}"',
      "    return msg",
      "  }",
      '  prompt describe(x) = "Tell ${who} about ${x}"',
      "  prompt describe_block(x) = \"\"\"",
      "    Tell ${who} about ${x}",
      "  \"\"\"",
      '  const h = run helper("bob")',
      '  const d = prompt describe("today")',
      '  const b = prompt describe_block("now")',
      '  return "${h}-${d}-${b}-${note}"',
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // no throw
    },
  );
});

test("E_VALIDATE: unknown ${ghost} in a nested const is rejected", () => {
  withFlow(
    [
      "export def main() {",
      '  const greeting = "hello ${ghost}"',
      "  return greeting",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown identifier "ghost" in const/,
      );
    },
  );
});

test("E_VALIDATE: unknown ${ghost} in a nested-def const is rejected", () => {
  withFlow(
    [
      "export def main() {",
      "  def helper() {",
      '    const msg = "x-${ghost}"',
      "    return msg",
      "  }",
      "  return run helper()",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown identifier "ghost" in const/,
      );
    },
  );
});

test("E_VALIDATE: unknown ${ghost} in a nested prompt body is rejected", () => {
  withFlow(
    [
      "export def main() {",
      '  prompt describe(x) = "about ${ghost} ${x}"',
      '  const d = prompt describe("today")',
      "  return d",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown identifier "ghost" in prompt/,
      );
    },
  );
});

test('E_VALIDATE: ${const} interpolated before its declaration is unknown', () => {
  withFlow(
    [
      "export def main() {",
      '  log "${later}"',
      '  const later = "ok"',
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown identifier "later" in log/,
      );
    },
  );
});

test("E_VALIDATE: a bare const arg used before its declaration is unknown", () => {
  withFlow(
    [
      "export def main() {",
      "  run consumer(later)",
      '  const later = "ok"',
      "}",
      "def consumer(v) {",
      '  return "${v}"',
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown identifier "later" used as bare argument/,
      );
    },
  );
});

test("E_VALIDATE: a nested def body interpolating a forward enclosing const is unknown", () => {
  withFlow(
    [
      "export def main() {",
      "  def helper() {",
      '    return "${later}"',
      "  }",
      "  const x = run helper()",
      '  const later = "hi"',
      "  return x",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown identifier "later"/,
      );
    },
  );
});

test("E_VALIDATE: an if subject naming a forward const is unknown", () => {
  withFlow(
    [
      "export def main() {",
      '  if later == "ok" {',
      '    log "yes"',
      "  }",
      '  const later = "ok"',
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown identifier "later"/,
      );
    },
  );
});

test("valid: a const declared before its use interpolates fine", () => {
  withFlow(
    [
      "export def main() {",
      '  const later = "ok"',
      '  log "${later}"',
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // no throw
    },
  );
});

test("E_VALIDATE: a nested-prompt arity mismatch is caught (nested def resolves for arity)", () => {
  withFlow(
    [
      "export def main() {",
      '  prompt describe(x) = "about ${x}"',
      "  const d = prompt describe()",
      "  return d",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*prompt "describe" expects 1 argument/,
      );
    },
  );
});

// -- Block-scoped in-branch declarations ------------------------------------
// A nested decl inside an `if` / `else` / `for` / `catch` / `recover` body is
// visible only inside that body. Each of these fails on the old hoisted
// `localsSoFar` walk, which made an in-branch name visible after the branch.

test("E_VALIDATE: a script declared inside `if` is not visible after the `if`", () => {
  withFlow(
    [
      "export def main(flag) {",
      '  if flag == "y" {',
      "    script s = `echo YES`",
      "  }",
      "  return run s()",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown local def or script reference "s"/,
      );
    },
  );
});

test("valid: a script declared and used inside the same `if` body", () => {
  withFlow(
    [
      "export def main(flag) {",
      '  if flag == "y" {',
      "    script s = `echo YES`",
      "    return run s()",
      "  }",
      '  return "none"',
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // no throw
    },
  );
});

test("E_VALIDATE: independent `if`/`else` scripts are not visible after the branch", () => {
  withFlow(
    [
      "export def main(flag) {",
      '  if flag == "y" {',
      "    script s = `echo YES`",
      "  } else {",
      "    script s = `echo NO`",
      "  }",
      "  return run s()",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown local def or script reference "s"/,
      );
    },
  );
});

test("valid: `if` and `else` each declare their own `s` (two independent locals)", () => {
  withFlow(
    [
      "export def main(flag) {",
      '  if flag == "y" {',
      "    script s = `echo YES`",
      "    return run s()",
      "  } else {",
      "    script s = `echo NO`",
      "    return run s()",
      "  }",
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // no `cannot rebind`, two independent locals
    },
  );
});

test("valid: a script declared in a `for` body is used inside the loop", () => {
  withFlow(
    [
      "export def main(src) {",
      "  for line in src {",
      '    script s = `echo "$1"`',
      "    run s(line)",
      "  }",
      '  return "done"',
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // no throw
    },
  );
});

test("E_VALIDATE: a `for`-body script is not visible after the loop", () => {
  withFlow(
    [
      "export def main(src) {",
      "  for line in src {",
      '    script s = `echo "$1"`',
      "  }",
      "  return run s()",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown local def or script reference "s"/,
      );
    },
  );
});

test("valid: a script declared in a `catch` body is used inside the catch", () => {
  withFlow(
    [
      "export def main() {",
      "  script boom = `exit 1`",
      "  run boom() catch (e) {",
      "    script s = `echo recovered`",
      "    return run s()",
      "  }",
      '  return "x"',
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // no throw
    },
  );
});

test("E_VALIDATE: a `catch`-body script is not visible after the catch", () => {
  withFlow(
    [
      "export def main() {",
      "  script boom = `exit 1`",
      "  run boom() catch (e) {",
      "    script s = `echo recovered`",
      "  }",
      "  return run s()",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown local def or script reference "s"/,
      );
    },
  );
});

test("valid: a def declared in a `recover` body is used inside the recover", () => {
  withFlow(
    [
      "export def main() {",
      "  script boom = `exit 1`",
      "  run boom() recover (e) {",
      "    def fix() {",
      '      return "ok"',
      "    }",
      "    return run fix()",
      "  }",
      '  return "x"',
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // no throw
    },
  );
});

test("E_VALIDATE: a `recover`-body def is not visible after the recover", () => {
  withFlow(
    [
      "export def main() {",
      "  script boom = `exit 1`",
      "  run boom() recover (e) {",
      "    def fix() {",
      '      return "ok"',
      "    }",
      "  }",
      "  return run fix()",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*unknown local def or script reference "fix"/,
      );
    },
  );
});

test("valid: an `if` body shadows an enclosing script; the outer name resolves after", () => {
  withFlow(
    [
      "script s = `echo OUTER`",
      "export def main(flag) {",
      '  if flag == "y" {',
      "    script s = `echo INNER`",
      "    run s()",
      "  }",
      "  return run s()",
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // inner shadow does not make the outer `s` unknown after
    },
  );
});

test("valid: a `returns` prompt captured inside `if` types `${r.field}` within that body", () => {
  withFlow(
    [
      "export def main(flag) {",
      '  if flag == "y" {',
      '    prompt p(x) = "ask ${x}" returns "{v: string}"',
      '    const r = prompt p("a")',
      '    return "${r.v}"',
      "  }",
      '  return "x"',
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // no throw
    },
  );
});

test("E_VALIDATE: an `if`-scoped `returns` capture is not typed after the `if`", () => {
  withFlow(
    [
      "export def main(flag) {",
      '  if flag == "y" {',
      '    prompt p(x) = "ask ${x}" returns "{v: string}"',
      '    const r = prompt p("a")',
      '    log "${r.v}"',
      "  }",
      '  return "${r.v}"',
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*"r" is not a typed prompt capture/,
      );
    },
  );
});

test("valid: a top-of-def `returns` prompt types `${r.field}` after its capture", () => {
  withFlow(
    [
      "export def main() {",
      '  prompt p(x) = "ask ${x}" returns "{v: string}"',
      '  const r = prompt p("a")',
      '  return "${r.v}"',
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // existing happy path stays valid
    },
  );
});
