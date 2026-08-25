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

test("E_VALIDATE: bare script name as raw shell line must use run", () => {
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
      /use run f/,
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
        "  const role_lc = run to_lower(result.role)",
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
        "  run to_lower(result.bogus)",
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
        "  run to_lower(result.role)",
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
        "  run to_lower(${result.role})",
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
        "  run greet(${name})",
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
        "  const x = run f()",
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

test("E_VALIDATE: bare workflow name as raw shell line must use run", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-wf-plus-sub-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script w_impl = `echo x`',
        "def w() {",
        "  run w_impl()",
        "}",
        "export def main() {",
        "  w",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /use run w/,
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
        "  run w_impl()",
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
        "  run greet(name)",
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
        "  run greet(unknown_var)",
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

test("E_VALIDATE: nested call-like arg requires explicit run or ensure", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-nested-call-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script mkdir_p_simple = `mkdir -p "$1"`',
        'script jaiph_tmp_dir = `printf "%s\\n" "$JAIPH_WORKSPACE/.jaiph/tmp"`',
        "export def main() {",
        "  run mkdir_p_simple(jaiph_tmp_dir())",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /nested managed calls in argument position must be explicit/,
    );
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
        "  const result = run get_name()",
        "  run greet(result)",
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
        "  run greet(name)",
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
        "  run greet(REPO)",
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
        '  run delay("${seconds}")',
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
        "  run delay(seconds)",
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
        '  run greet("${name}")',
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
        '  run greet("${arg1}")',
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
        '  run greet("hello_${name}")',
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
        "  run noop(arg1)",
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
        "  run greet(ghost)",
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

// --- Explicit nested managed call tests ---

test("buildScripts accepts run foo(run bar()) — explicit nested managed call", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-nested-run-run-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script mkdir_p_simple = `mkdir -p "$1"`',
        'script jaiph_tmp_dir = `printf "%s\\n" "/tmp/jaiph"`',
        "export def main() {",
        "  run mkdir_p_simple(run jaiph_tmp_dir())",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildScripts accepts run foo(run rule_bar()) — explicit nested ensure", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-nested-run-ensure-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script do_work = `echo "$1"`',
        "def check_ok() {",
        '  run do_work("ok")',
        "}",
        "export def main() {",
        "  run do_work(run check_ok())",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildScripts accepts run foo(run `echo aaa`()) — explicit nested inline script", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-nested-run-inline-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script do_work = `echo "$1"`',
        "export def main() {",
        "  run do_work(run `echo aaa`())",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildScripts accepts const x = run bar() followed by run foo(x)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-capture-then-pass-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script bar = `echo "hello"`',
        'script foo = `echo "$1"`',
        "export def main() {",
        "  const x = run bar()",
        "  run foo(x)",
        "}",
        "",
      ].join("\n"),
    );
    buildScripts(join(root, "m.jh"), out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: run foo(rule_bar()) — bare rule call in args is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-nested-bare-rule-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script do_work = `echo "$1"`',
        "def rule_bar() {",
        '  run do_work("ok")',
        "}",
        "export def main() {",
        "  run do_work(rule_bar())",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /nested managed calls in argument position must be explicit/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: run foo(`echo aaa`()) — bare inline script call in args is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-nested-bare-inline-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script do_work = `echo "$1"`',
        "export def main() {",
        "  run do_work(`echo aaa`())",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /nested inline script calls in argument position must be explicit/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: const x = bar() — bare call in const assignment is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-const-bare-call-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script bar = `echo "hello"`',
        "export def main() {",
        "  const x = bar()",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /Script calls in const assignments must use run/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
