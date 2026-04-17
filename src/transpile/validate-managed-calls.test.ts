import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildScripts } from "../transpiler";

test("E_VALIDATE: inline shell step is forbidden in workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-sub-fn-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script f = `printf '%s' 'x'`",
        "workflow default() {",
        '  x="$(f)"',
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /inline shell steps are forbidden in workflows; use explicit script blocks/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E_VALIDATE: direct inline shell step is forbidden in workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-direct-fn-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script f = `printf '%s' 'x'`",
        "workflow default() {",
        "  f",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /inline shell steps are forbidden in workflows; use explicit script blocks/,
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
        "workflow w() {",
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

test("buildScripts extracts script for run with capture workflow", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-run-fn-"));
  const out = join(root, "out");
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        "script f = `printf '%s' 'ok'`",
        "workflow default() {",
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

test("E_VALIDATE: inline shell line with workflow ref is forbidden", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-val-wf-plus-sub-"));
  try {
    writeFileSync(
      join(root, "m.jh"),
      [
        'script w_impl = `echo x`',
        "workflow w() {",
        "  run w_impl()",
        "}",
        "workflow default() {",
        "  w $(true)",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => buildScripts(join(root, "m.jh"), join(root, "out")),
      /inline shell steps are forbidden in workflows; use explicit script blocks/,
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
        "workflow w() {",
        "  run w_impl()",
        "}",
        "workflow default() {",
        "  c <- w",
        "}",
        "",
      ].join("\n"),
    );
    assert.throws(() => buildScripts(join(root, "m.jh"), join(root, "out")), /workflow "w"/);
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
        "workflow default() {",
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
        "workflow default() {",
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
        "workflow default() {",
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
        "workflow default() {",
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
        "workflow default(name) {",
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
        "workflow default() {",
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
        "workflow w(seconds) {",
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
        "workflow w(seconds) {",
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
        "workflow default() {",
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
        "workflow default() {",
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
        "workflow default() {",
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
        "workflow default() {",
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
        "workflow default() {",
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
        "workflow default() {",
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
        "workflow default() {",
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
