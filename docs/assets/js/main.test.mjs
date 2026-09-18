// Unit test for the docs syntax highlighter (docs/assets/js/main.js).
//
// Drives the pure `highlightJaiphWithParser` (no DOM) over small .jh snippets
// and asserts the mechanical call rule: an identifier or qualified callee
// immediately followed by `(` is painted as a function/identifier span, while
// keywords before `(` stay keywords. Run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { highlightJaiphWithParser } = require("./main.js");

// True when `text` is wrapped in a <span class="ralph-identifier"> (the
// function/identifier span the callee uses).
function isCall(html, text) {
  return html.includes(`<span class="ralph-identifier">${text}</span>`);
}

// True when `text` is wrapped in a <span class="ralph-keyword">.
function isKeyword(html, text) {
  return html.includes(`<span class="ralph-keyword">${text}</span>`);
}

test("a name immediately followed by `(` paints the callee as a function", () => {
  // Statement-start bare call.
  assert.ok(isCall(highlightJaiphWithParser("setup_env()"), "setup_env"),
    "statement-start `setup_env()` callee must be a function span");

  // Expression-position call: this is the case the old known-symbol set missed.
  const expr = highlightJaiphWithParser("const name = valid_name(name_arg)");
  assert.ok(isCall(expr, "valid_name"),
    "`const name = valid_name(name_arg)` must paint valid_name as a function");

  // Def call with a string argument.
  assert.ok(isCall(highlightJaiphWithParser('check_deps("package.json")'), "check_deps"),
    "def call `check_deps(\"package.json\")` callee must be a function");

  // Qualified call: the last segment sits before `(`.
  assert.ok(isCall(highlightJaiphWithParser("async helpers.scan()"), "scan"),
    "qualified call `async helpers.scan()` last segment must be a function");
});

// Count the `->` arrow/operator spans in rendered HTML (`>` is escaped).
function arrowCount(html) {
  return (html.match(/<span class="ralph-operator">-&gt;<\/span>/g) || []).length;
}

test("a multi-hop stdin pipeline paints every arrow and every stage callee", () => {
  // `stdin gen() -> upper() -> count()`: BOTH `->` are arrow/operator spans and
  // EVERY stage callee is a function/identifier span, as a plain statement and
  // as a `const … =` binding. Fails if only the first hop is painted.
  for (const line of [
    "stdin gen() -> upper() -> count()",
    "const n = stdin gen() -> upper() -> count()",
  ]) {
    const html = highlightJaiphWithParser(line);
    assert.equal(arrowCount(html), 2, `both arrows on \`${line}\` must be operator spans`);
    for (const callee of ["gen", "upper", "count"]) {
      assert.ok(isCall(html, callee), `stage callee \`${callee}\` on \`${line}\` must be a function span`);
    }
  }
});

test("keywords before `(` stay keywords, not calls", () => {
  const html = highlightJaiphWithParser("check_deps() catch (failure) {");
  assert.ok(isKeyword(html, "catch"), "`catch` before `(` must stay a keyword");
  assert.ok(!isCall(html, "catch"), "`catch (failure)` must not paint catch as a call");
});

test("`run` is not a keyword and does not pick up call/function scope", () => {
  // A lone `run` before `(` in `run save()` must not become a call; only save is.
  const html = highlightJaiphWithParser("run save()");
  assert.ok(!isKeyword(html, "run"), "`run` must not be a keyword");
  assert.ok(!isCall(html, "run"), "`run` standing before an identifier is not a call");
  assert.ok(isCall(html, "save"), "`run save()` must paint save as a call");
});
