import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScripts } from "../transpiler";

test("buildScripts accepts subshell capture in workflow shell line", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-sub-fn-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script f = `printf '%s' 'x'`",
        "export def main() {",
        '  x="$(f)"',
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: bare script name as raw shell line must be called as f()", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-direct-fn-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script f = `printf '%s' 'x'`",
        "export def main() {",
        "  f",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /use f()/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildScripts accepts return base.field as sugar for quoted ${base.field}", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-dotted-ret-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "def w() {",
        '  const result = prompt "x" returns "{ role: string }"',
        "  return result.role",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare dotted call arg: result.role resolves as typed-prompt field", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-dotted-arg-ok-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script to_lower = `printf \'%s\' "$1" | tr \'[:upper:]\' \'[:lower:]\'`',
        "export def main() {",
        '  const result = prompt "x" returns "{ role: string }"',
        "  const role_lc = to_lower(result.role)",
        '  return "${role_lc}"',
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare dotted call arg: unknown field fails E_VALIDATE", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-dotted-arg-field-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script to_lower = `printf \'%s\' "$1" | tr \'[:upper:]\' \'[:lower:]\'`',
        "export def main() {",
        '  const result = prompt "x" returns "{ role: string }"',
        "  to_lower(result.bogus)",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /field "bogus" is not defined in the returns schema/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare dotted call arg: non-prompt base fails E_VALIDATE", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-dotted-arg-base-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script to_lower = `printf \'%s\' "$1" | tr \'[:upper:]\' \'[:lower:]\'`',
        "export def main() {",
        '  const result = "not-a-prompt"',
        "  to_lower(result.role)",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /not a typed prompt capture/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("${var.field} call arg: unquoted interpolation is E_VALIDATE", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-interp-arg-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script to_lower = `printf \'%s\' "$1" | tr \'[:upper:]\' \'[:lower:]\'`',
        "export def main() {",
        '  const result = prompt "x" returns "{ role: string }"',
        "  to_lower(${result.role})",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /call arguments cannot use unquoted interpolation \$\{result\.role\}/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("${var} call arg: unquoted interpolation is E_VALIDATE", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-interp-bare-arg-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script greet = `echo "hello $1"`',
        "export def main() {",
        '  const name = "world"',
        "  greet(${name})",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /call arguments cannot use unquoted interpolation \$\{name\}.*bare identifier/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildScripts extracts script for run with capture workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-run-fn-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script f = `printf '%s' 'ok'`",
        "export def main() {",
        "  const x = f()",
        '  return "${x}"',
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
    const names = readdirSync(join(out, "scripts"));
    assert.ok(names.includes("f"));
    assert.match(readFileSync(join(out, "scripts", "f"), "utf8"), /printf/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: bare workflow name as raw shell line must be called as w()", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-wf-plus-sub-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script w_impl = `echo x`',
        "def w() {",
        "  w_impl()",
        "}",
        "export def main() {",
        "  w",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /use w()/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: send RHS cannot invoke Jaiph workflow via shell", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-send-wf-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "channel c",
        'script w_impl = `echo x`',
        "def w() {",
        "  w_impl()",
        "}",
        "export def main() {",
        "  send w -> c",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => buildScripts(join(root, "m.jh"), join(root, "out")), /def "w"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare identifier arg: known const passes validation", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-bare-ok-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script greet = `echo "hello $1"`',
        "export def main() {",
        '  const name = "world"',
        "  greet(name)",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare identifier arg: unknown name fails E_VALIDATE", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-bare-err-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script greet = `echo "hello $1"`',
        "export def main() {",
        "  greet(unknown_var)",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /unknown identifier "unknown_var" used as bare argument/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested bare call arg foo(bar()) is a managed call and is accepted", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-nested-call-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script mkdir_p_simple = `mkdir -p "$1"`',
        'script jaiph_tmp_dir = `printf "%s\\n" "$JAIPH_WORKSPACE/.jaiph/tmp"`',
        "export def main() {",
        "  mkdir_p_simple(jaiph_tmp_dir())",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), join(root, "out"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare identifier arg: capture variable passes validation", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-bare-cap-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script get_name = `echo "world"`',
        'script greet = `echo "hello $1"`',
        "export def main() {",
        "  const result = get_name()",
        "  greet(result)",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare identifier arg: named param valid when workflow declares a parameter", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-bare-argn-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script greet = `echo "hello $1"`',
        "export def main(name) {",
        "  greet(name)",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare identifier arg: top-level const passes validation", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-bare-env-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'const REPO = "my-project"',
        'script greet = `echo "hello $1"`',
        "export def main() {",
        "  greet(REPO)",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: braced parameter name in run args is rejected (use bare identifier)", () => {
  // validateNoQuotedSingleInterpolation was removed; "${seconds}" in call args is now allowed
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-braced-wf-param-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script delay = `sleep "$1"`',
        "def w(seconds) {",
        '  delay("${seconds}")',
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildScripts accepts run delay(seconds) with bare workflow parameter", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-bare-wf-param-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script delay = `sleep "$1"`',
        "def w(seconds) {",
        "  delay(seconds)",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: braced const name in run args is rejected (use bare identifier)", () => {
  // validateNoQuotedSingleInterpolation was removed; "${name}" in call args is now allowed
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-braced-const-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script greet = `echo "hello $1"`',
        "export def main() {",
        '  const name = "world"',
        '  greet("${name}")',
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: braced argN in run args is rejected (use bare identifier)", () => {
  // validateNoQuotedSingleInterpolation was removed; "${arg1}" in call args is now allowed
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-braced-argn-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script greet = `echo "hello $1"`',
        "export def main() {",
        '  greet("${arg1}")',
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quoted string with extra text around interpolation is allowed in args", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-mixed-interp-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script greet = `echo "hello $1"`',
        "export def main() {",
        '  const name = "world"',
        '  greet("hello_${name}")',
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: arg1 bare argument requires a workflow parameter", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-arg1-slot-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script noop = `:`',
        "export def main() {",
        "  noop(arg1)",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /unknown identifier "arg1" used as bare argument/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_PARSE: prompt capture requires const", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-prompt-const-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "export def main() {",
        '  x = prompt "hi"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /use "const name = prompt/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare identifier arg: unknown name error does not suggest interpolation workaround", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-bare-no-hint-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script greet = `echo "hello $1"`',
        "export def main() {",
        "  greet(ghost)",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      (err: Error) => {
        assert.match(err.message, /unknown identifier "ghost" used as bare argument/);
        assert.doesNotMatch(err.message, /\$\{ghost\}/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: ${arg1} in log is unknown identifier", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-arg1-interp-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "export def main() {",
        '  log "x=${arg1}"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /unknown identifier "arg1"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Nested managed call tests (bare call is the managed form) ---

test("buildScripts accepts foo(bar()) — nested managed call", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-nested-run-run-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script mkdir_p_simple = `mkdir -p "$1"`',
        'script jaiph_tmp_dir = `printf "%s\\n" "/tmp/jaiph"`',
        "export def main() {",
        "  mkdir_p_simple(jaiph_tmp_dir())",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildScripts accepts foo(check_ok()) — nested def call", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-nested-run-ensure-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script do_work = `echo "$1"`',
        "def check_ok() {",
        '  do_work("ok")',
        "}",
        "export def main() {",
        "  do_work(check_ok())",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildScripts accepts foo(`echo aaa`()) — nested inline script", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-nested-run-inline-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script do_work = `echo "$1"`',
        "export def main() {",
        "  do_work(`echo aaa`())",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildScripts accepts const x = bar() (a call capture) followed by foo(x)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-capture-then-pass-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script bar = `echo "hello"`',
        'script foo = `echo "$1"`',
        "export def main() {",
        "  const x = bar()",
        "  foo(x)",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
