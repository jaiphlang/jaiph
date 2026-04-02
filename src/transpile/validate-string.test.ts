import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScripts } from "../transpiler";

function withTempDir(prefix: string, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJh(root: string, name: string, lines: string[]): void {
  writeFileSync(join(root, name), lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Valid interpolation forms (should NOT throw)
// ---------------------------------------------------------------------------

test("valid: ${name} interpolation in log", () => {
  withTempDir("jaiph-str-ok-braced-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default(name) {",
      '  log "hello ${name}"',
      "}",
    ]);
    buildScripts(join(root, "m.jh"), join(root, "out"));
  });
});

test("valid: ${arg1} positional in log when workflow declares a parameter", () => {
  withTempDir("jaiph-str-ok-arg1-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default(arg1) {",
      '  log "arg is ${arg1}"',
      "}",
    ]);
    buildScripts(join(root, "m.jh"), join(root, "out"));
  });
});

test("valid: escaped backtick in prompt", () => {
  withTempDir("jaiph-str-ok-esc-bt-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  const _ = prompt "escaped backtick: \\`cmd\\`"',
      "}",
    ]);
    buildScripts(join(root, "m.jh"), join(root, "out"));
  });
});

test("valid: $1 in script body (shell context)", () => {
  withTempDir("jaiph-str-ok-script-dollar1-", (root) => {
    writeJh(root, "m.jh", [
      'script greet = `echo "Hello $1"`',
      "workflow default() {",
      '  run greet("world")',
      "}",
    ]);
    buildScripts(join(root, "m.jh"), join(root, "out"));
  });
});

// ---------------------------------------------------------------------------
// Invalid: bare $name interpolation (must use ${name})
// ---------------------------------------------------------------------------

test("reject bare $name in log message", () => {
  withTempDir("jaiph-str-bad-bare-name-log-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  log "value is $x"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*bare interpolation.*\$\{x\}/,
    );
  });
});

test("reject bare $name in prompt", () => {
  withTempDir("jaiph-str-bad-bare-name-prompt-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  prompt "hello $user"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*bare interpolation.*\$\{user\}/,
    );
  });
});

test("reject bare $1 in log message", () => {
  withTempDir("jaiph-str-bad-bare-1-log-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  log "arg: $1"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*bare interpolation.*\$\{arg1\}/,
    );
  });
});

test("reject braced numeric ${1} in log message", () => {
  withTempDir("jaiph-str-bad-braced-1-log-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  log "arg: ${1}"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*numeric interpolation.*\$\{arg1\}/,
    );
  });
});

test("reject bare $name in fail message", () => {
  withTempDir("jaiph-str-bad-bare-fail-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  fail "error: $reason"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*bare interpolation.*\$\{reason\}/,
    );
  });
});

test("reject bare $name in return string", () => {
  withTempDir("jaiph-str-bad-bare-return-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  return "$result"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*bare interpolation.*\$\{result\}/,
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid: ${var:-fallback} shell fallback syntax
// ---------------------------------------------------------------------------

test("reject ${var:-fallback} in log message", () => {
  withTempDir("jaiph-str-bad-fallback-log-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  log "${name:-anonymous}"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*shell fallback syntax/,
    );
  });
});

test("reject ${var:-fallback} in fail message", () => {
  withTempDir("jaiph-str-bad-fallback-fail-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  fail "${name:-unknown}"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*shell fallback syntax/,
    );
  });
});

test("reject ${var:-fallback} in prompt string", () => {
  withTempDir("jaiph-str-bad-fallback-prompt-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  prompt "Hello ${user:-default}"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*shell fallback syntax/,
    );
  });
});

test("reject ${var:-fallback} in const RHS expression", () => {
  withTempDir("jaiph-str-bad-fallback-const-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  const x = ${name:-default}',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /shell fallback syntax/,
    );
  });
});

test("reject ${var:+alt} shell expansion in log", () => {
  withTempDir("jaiph-str-bad-alt-log-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  log "${debug:+verbose mode}"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*shell fallback syntax/,
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid: $(...) command substitution in orchestration strings
// ---------------------------------------------------------------------------

test("reject $(...) in log message", () => {
  withTempDir("jaiph-str-bad-cmdsub-log-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  log "host is $(uname)"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*log cannot contain command substitution/,
    );
  });
});

test("reject $(...) in logerr message", () => {
  withTempDir("jaiph-str-bad-cmdsub-logerr-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  logerr "host is $(uname)"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*logerr cannot contain command substitution/,
    );
  });
});

// ---------------------------------------------------------------------------
// Rule context: same validations apply
// ---------------------------------------------------------------------------

test("reject ${var:-fallback} in rule log", () => {
  withTempDir("jaiph-str-bad-fallback-rule-", (root) => {
    writeJh(root, "m.jh", [
      'script noop = `true`',
      "rule check() {",
      '  log "${x:-fallback}"',
      "}",
      "workflow default() {",
      "  ensure check()",
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*shell fallback syntax/,
    );
  });
});

// ---------------------------------------------------------------------------
// Inline capture interpolation: ${run ref} / ${ensure ref}
// ---------------------------------------------------------------------------

test("valid: ${run ref} inline capture in log", () => {
  withTempDir("jaiph-str-ic-run-", (root) => {
    writeJh(root, "m.jh", [
      'script greet = `echo "hello"`',
      "workflow default() {",
      '  log "got: ${run greet()}"',
      "}",
    ]);
    buildScripts(join(root, "m.jh"), join(root, "out"));
  });
});

test("valid: ${ensure ref} inline capture in log", () => {
  withTempDir("jaiph-str-ic-ensure-", (root) => {
    writeJh(root, "m.jh", [
      "rule check() {",
      '  return "ok"',
      "}",
      "workflow default() {",
      '  log "status: ${ensure check()}"',
      "}",
    ]);
    buildScripts(join(root, "m.jh"), join(root, "out"));
  });
});

test("valid: ${run ref args} inline capture with args", () => {
  withTempDir("jaiph-str-ic-run-args-", (root) => {
    writeJh(root, "m.jh", [
      'script greet = `echo "hello $1"`',
      "workflow default() {",
      '  log "got: ${run greet(world)}"',
      "}",
    ]);
    buildScripts(join(root, "m.jh"), join(root, "out"));
  });
});

test("valid: ${run ref} inline capture in return", () => {
  withTempDir("jaiph-str-ic-return-", (root) => {
    writeJh(root, "m.jh", [
      'script greet = `echo "hello"`',
      "workflow helper() {",
      '  return "${run greet()}"',
      "}",
      "workflow default() {",
      "  run helper()",
      "}",
    ]);
    buildScripts(join(root, "m.jh"), join(root, "out"));
  });
});

test("valid: ${run ref} inline capture in rule log", () => {
  withTempDir("jaiph-str-ic-rule-", (root) => {
    writeJh(root, "m.jh", [
      'script greet = `echo "hello"`',
      "rule check() {",
      '  log "got: ${run greet()}"',
      "}",
      "workflow default() {",
      "  ensure check()",
      "}",
    ]);
    buildScripts(join(root, "m.jh"), join(root, "out"));
  });
});

test("rejected: nested inline capture ${run ... ${run ...}}", () => {
  withTempDir("jaiph-str-ic-nested-", (root) => {
    writeJh(root, "m.jh", [
      'script foo = `echo "a"`',
      'script bar = `echo "b"`',
      "workflow default() {",
      '  log "got: ${run foo(${run bar()})}"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*invalid inline run reference/,
    );
  });
});

test("rejected: ${run invalid-ref} in log", () => {
  withTempDir("jaiph-str-ic-bad-ref-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  log "got: ${run 123bad()}"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*invalid inline run reference/,
    );
  });
});

test("rejected: ${run ref} with unknown ref in workflow", () => {
  withTempDir("jaiph-str-ic-unknown-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  log "got: ${run nonexistent()}"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /E_VALIDATE/,
    );
  });
});

test("extractInlineCaptures extracts run and ensure with args", () => {
  const { extractInlineCaptures } = require("./validate-string");
  const result = extractInlineCaptures('prefix ${run greet(world)} middle ${ensure check()} suffix');
  assert.deepEqual(result, [
    { kind: "run", ref: "greet", args: "${world}" },
    { kind: "ensure", ref: "check", args: undefined },
  ]);
});

test("extractInlineCaptures returns empty for plain string", () => {
  const { extractInlineCaptures } = require("./validate-string");
  const result = extractInlineCaptures('hello ${name} world');
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// extractDotFieldRefs
// ---------------------------------------------------------------------------

test("extractDotFieldRefs extracts single dot-notation ref", () => {
  const { extractDotFieldRefs } = require("./validate-string");
  const result = extractDotFieldRefs('hello ${response.message} world');
  assert.deepEqual(result, [{ varName: "response", fieldName: "message" }]);
});

test("extractDotFieldRefs extracts multiple dot-notation refs", () => {
  const { extractDotFieldRefs } = require("./validate-string");
  const result = extractDotFieldRefs('${a.x} and ${b.y}');
  assert.deepEqual(result, [
    { varName: "a", fieldName: "x" },
    { varName: "b", fieldName: "y" },
  ]);
});

test("extractDotFieldRefs returns empty for plain ${var}", () => {
  const { extractDotFieldRefs } = require("./validate-string");
  const result = extractDotFieldRefs('hello ${name} world');
  assert.deepEqual(result, []);
});

test("extractDotFieldRefs ignores underscore-style ${var_field}", () => {
  const { extractDotFieldRefs } = require("./validate-string");
  const result = extractDotFieldRefs('${response_message}');
  assert.deepEqual(result, []);
});

test("valid: ${response.field} dot notation in log compiles", () => {
  withTempDir("jaiph-str-dot-ok-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  const result = prompt "Analyse" returns "{ type: string, risk: string }"',
      '  log "type is ${result.type}"',
      "}",
    ]);
    buildScripts(join(root, "m.jh"), join(root, "out"));
  });
});

test("invalid: ${x.field} where x has no schema fails at compile time", () => {
  withTempDir("jaiph-str-dot-noscema-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  log "value ${x.field}"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /not a typed prompt capture/,
    );
  });
});

test("invalid: ${undeclared} in log rejected with strict scope error", () => {
  withTempDir("jaiph-str-unknown-interp-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  log "value is ${ghost}"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      (err: Error) => {
        assert.match(err.message, /unknown identifier "ghost" in log/);
        assert.match(err.message, /declare it with `const`, use a capture, or add a workflow parameter/);
        // Must not suggest ${ghost} as a workaround (it is already the ${} form and still rejected)
        assert.doesNotMatch(err.message, /explicit interpolation/);
        return true;
      },
    );
  });
});

test("invalid: ${result.bogus} where bogus is not in schema fails at compile time", () => {
  withTempDir("jaiph-str-dot-badfield-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default() {",
      '  const result = prompt "Analyse" returns "{ type: string, risk: string }"',
      '  log "bad field ${result.bogus}"',
      "}",
    ]);
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /field "bogus" is not defined in the returns schema/,
    );
  });
});
