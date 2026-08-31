import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScripts } from "../transpiler";

// Named-prompt invocation validation: kind mismatch, arity, run-on-prompt,
// returns-without-capture, and the identifier-vs-named distinction.

function withFlow(lines: string[], run: (entry: string, out: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "jaiph-named-prompt-val-"));
  try {
    const entry = join(root, "m.jh");
    writeFileSync(entry, `${lines.join("\n")}\n`);
    run(entry, join(root, "out"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("valid: named prompt call parses and validates", () => {
  withFlow(
    [
      'prompt classify(x) = "Classify ${x}"',
      "export def main() {",
      '  const c = "hi"',
      "  prompt classify(c)",
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // no throw
    },
  );
});

test("E_VALIDATE: prompt name() when the name is a script (wrong kind)", () => {
  withFlow(
    [
      "script sh = `echo x`",
      "export def main() {",
      "  prompt sh()",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*"sh" is a script, not a prompt/,
      );
    },
  );
});

test("E_VALIDATE: prompt name() when the name is a def (wrong kind)", () => {
  withFlow(
    [
      "export def helper() {",
      '  return "x"',
      "}",
      "export def main() {",
      "  prompt helper()",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*"helper" is a def, not a prompt/,
      );
    },
  );
});

test("E_VALIDATE: run name() when the name is a named prompt", () => {
  withFlow(
    [
      'prompt classify(x) = "Classify ${x}"',
      "export def main() {",
      '  const c = "hi"',
      "  run classify(c)",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*prompt "classify" cannot be called with run/,
      );
    },
  );
});

test("E_VALIDATE: wrong arity — prompt foo() vs prompt foo(a, b)", () => {
  withFlow(
    [
      'prompt foo(a, b) = "${a} ${b}"',
      "export def main() {",
      "  prompt foo()",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_VALIDATE.*prompt "foo" expects 2 argument\(s\).*but got 0/,
      );
    },
  );
});

test("E_PARSE: returns-bearing named prompt invoked without const capture", () => {
  withFlow(
    [
      'prompt classify(x) = "Classify ${x}" returns "{ verdict: string }"',
      "export def main() {",
      '  const c = "hi"',
      "  prompt classify(c)",
      "}",
    ],
    (entry, out) => {
      assert.throws(
        () => buildScripts(entry, out),
        /E_PARSE.*prompt "classify" has a "returns" schema and must capture/,
      );
    },
  );
});

test("valid: bare `prompt foo` (no parens) is identifier-as-body for a string const", () => {
  withFlow(
    [
      "export def main() {",
      '  const foo = "some prompt text"',
      "  prompt foo",
      "}",
    ],
    (entry, out) => {
      buildScripts(entry, out); // no throw — identifier-as-body sugar
    },
  );
});

test("valid: named prompt used across import with alias", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-named-prompt-import-"));
  try {
    writeFileSync(
      join(root, "lib.jh"),
      'export prompt classify(x) = "Classify ${x}"\n',
    );
    const entry = join(root, "main.jh");
    writeFileSync(
      entry,
      [
        'import "./lib.jh" as lib',
        "export def main() {",
        '  const c = "hi"',
        "  const r = prompt lib.classify(c)",
        "  return r",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(entry, join(root, "out")); // no throw
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
