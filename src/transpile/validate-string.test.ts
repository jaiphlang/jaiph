import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "../transpiler";

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
      "workflow default {",
      '  log "hello ${name}"',
      "}",
    ]);
    build(join(root, "m.jh"), join(root, "out"));
  });
});

test("valid: ${arg1} positional in log", () => {
  withTempDir("jaiph-str-ok-arg1-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  log "arg is ${arg1}"',
      "}",
    ]);
    build(join(root, "m.jh"), join(root, "out"));
  });
});

test("valid: escaped backtick in prompt", () => {
  withTempDir("jaiph-str-ok-esc-bt-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  prompt "escaped backtick: \\`cmd\\`"',
      "}",
    ]);
    build(join(root, "m.jh"), join(root, "out"));
  });
});

test("valid: $1 in script body (shell context)", () => {
  withTempDir("jaiph-str-ok-script-dollar1-", (root) => {
    writeJh(root, "m.jh", [
      "script greet() {",
      '  echo "Hello $1"',
      "}",
      "workflow default {",
      '  run greet "world"',
      "}",
    ]);
    build(join(root, "m.jh"), join(root, "out"));
  });
});

// ---------------------------------------------------------------------------
// Invalid: bare $name interpolation (must use ${name})
// ---------------------------------------------------------------------------

test("reject bare $name in log message", () => {
  withTempDir("jaiph-str-bad-bare-name-log-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  log "value is $x"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*bare interpolation.*\$\{x\}/,
    );
  });
});

test("reject bare $name in prompt", () => {
  withTempDir("jaiph-str-bad-bare-name-prompt-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  prompt "hello $user"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*bare interpolation.*\$\{user\}/,
    );
  });
});

test("reject bare $1 in log message", () => {
  withTempDir("jaiph-str-bad-bare-1-log-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  log "arg: $1"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*bare interpolation.*\$\{arg1\}/,
    );
  });
});

test("reject braced numeric ${1} in log message", () => {
  withTempDir("jaiph-str-bad-braced-1-log-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  log "arg: ${1}"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*numeric interpolation.*\$\{arg1\}/,
    );
  });
});

test("reject bare $name in fail message", () => {
  withTempDir("jaiph-str-bad-bare-fail-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  fail "error: $reason"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*bare interpolation.*\$\{reason\}/,
    );
  });
});

test("reject bare $name in return string", () => {
  withTempDir("jaiph-str-bad-bare-return-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  return "$result"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
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
      "workflow default {",
      '  log "${name:-anonymous}"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*shell fallback syntax/,
    );
  });
});

test("reject ${var:-fallback} in fail message", () => {
  withTempDir("jaiph-str-bad-fallback-fail-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  fail "${name:-unknown}"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*shell fallback syntax/,
    );
  });
});

test("reject ${var:-fallback} in prompt string", () => {
  withTempDir("jaiph-str-bad-fallback-prompt-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  prompt "Hello ${user:-default}"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*shell fallback syntax/,
    );
  });
});

test("reject ${var:-fallback} in const RHS expression", () => {
  withTempDir("jaiph-str-bad-fallback-const-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  const x = ${name:-default}',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /shell fallback syntax/,
    );
  });
});

test("reject ${var:+alt} shell expansion in log", () => {
  withTempDir("jaiph-str-bad-alt-log-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  log "${debug:+verbose mode}"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*shell fallback syntax/,
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid: unescaped backticks
// ---------------------------------------------------------------------------

test("reject unescaped backtick in log message", () => {
  withTempDir("jaiph-str-bad-bt-log-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  log "output: `uname`"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*log cannot contain backticks/,
    );
  });
});

test("reject unescaped backtick in fail message", () => {
  withTempDir("jaiph-str-bad-bt-fail-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  fail "error: `whoami`"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*fail cannot contain backticks/,
    );
  });
});

test("reject unescaped backtick in prompt", () => {
  withTempDir("jaiph-str-bad-bt-prompt-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  prompt "run `uname` and tell me"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*prompt cannot contain backticks/,
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid: $(...) command substitution in orchestration strings
// ---------------------------------------------------------------------------

test("reject $(...) in log message", () => {
  withTempDir("jaiph-str-bad-cmdsub-log-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  log "host is $(uname)"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*log cannot contain command substitution/,
    );
  });
});

test("reject $(...) in logerr message", () => {
  withTempDir("jaiph-str-bad-cmdsub-logerr-", (root) => {
    writeJh(root, "m.jh", [
      "workflow default {",
      '  logerr "host is $(uname)"',
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
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
      "script noop() {",
      "  true",
      "}",
      "rule check {",
      '  log "${x:-fallback}"',
      "}",
      "workflow default {",
      "  ensure check",
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*shell fallback syntax/,
    );
  });
});

test("reject unescaped backtick in rule fail", () => {
  withTempDir("jaiph-str-bad-bt-rule-fail-", (root) => {
    writeJh(root, "m.jh", [
      "script noop() {",
      "  true",
      "}",
      "rule check {",
      '  fail "error: `cmd`"',
      "}",
      "workflow default {",
      "  ensure check",
      "}",
    ]);
    assert.throws(
      () => build(join(root, "m.jh"), join(root, "out")),
      /E_PARSE.*fail cannot contain backticks/,
    );
  });
});
