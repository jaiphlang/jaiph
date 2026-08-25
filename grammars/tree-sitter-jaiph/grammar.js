/// <reference types="tree-sitter-cli/dsl" />

// Tree-sitter grammar for Jaiph (.jh / *.test.jh).
//
// This is a token-oriented ("lexer-style") grammar: `source_file` is a flat
// repeat of tokens rather than a full syntactic parse of every statement form.
// That is deliberate and matches what editor highlighting needs — Zed drives
// syntax highlighting and language injection from queries against the token
// stream, not from a semantic tree. The single source of truth for Jaiph
// semantics is the TypeScript compiler under `src/`; duplicating its full
// grammar here would be a second, drift-prone parser. Keeping this loose makes
// the grammar robust (it never fails to tokenize a valid file) while still
// giving distinct nodes for every construct the highlight queries care about.
//
// Keyword literals are extracted from `identifier` via the `word` directive, so
// e.g. `run` is only a keyword when it stands alone, never inside `runner`.
// Dotted names (`agent.model`, `helpers.scan`) tokenize as `qualified_identifier`
// so a leading segment like `run` in `run.recover_limit` is not mis-highlighted
// as the `run` command keyword.

module.exports = grammar({
  name: "jaiph",
  word: ($) => $.identifier,
  extras: ($) => [/\s/],
  rules: {
    source_file: ($) => repeat($._token),

    _token: ($) =>
      choice(
        $.comment,
        $.triple_string,
        $.string,
        $.fenced_block,
        $.backtick_string,
        $.regex,
        $.number,
        $.qualified_identifier,
        // declaration keywords
        "import", "export", "as", "config", "channel", "script",
        "def", "test",
        // command keywords
        "const", "run", "prompt", "log", "logerr", "logwarn",
        "fail", "return", "send", "recover", "catch",
        // control keywords
        "if", "else", "for", "in", "match", "async", "returns", "not",
        // test-block keywords
        "mock", "allow_failure",
        "expect_contain", "expect_not_contain", "expect_equal",
        // constants
        "true", "false",
        // operators / punctuation
        $.operator,
        "{", "}", "(", ")", "[", "]", ".", ",",
        $.identifier,
      ),

    comment: ($) => token(/#.*/),

    operator: ($) => choice("<-", "->", "=>", "==", "!=", "=~", "!~", "="),

    number: ($) => token(/[0-9]+/),

    identifier: ($) => token(/[A-Za-z_][A-Za-z0-9_]*/),

    qualified_identifier: ($) =>
      token(/[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+/),

    regex: ($) => token(seq("/", /[^/\n]+/, "/")),

    string: ($) => token(seq('"', repeat(choice(/[^"\\]/, /\\./)), '"')),

    triple_string: ($) =>
      token(seq('"""', repeat(choice(/[^"]/, /"[^"]/, /""[^"]/)), '"""')),

    backtick_string: ($) => token(seq("`", /[^`]*/, "`")),

    // Fenced script / inline-script body: ```lang ... ``` . The optional
    // language tag drives injection (see injections.scm); the body is aliased
    // to `embedded` so a query can hand it to another grammar.
    fenced_block: ($) =>
      seq(
        "```",
        optional(field("language", alias($.fence_language, $.language))),
        optional(field("body", alias($.fence_content, $.embedded))),
        "```",
      ),

    fence_language: ($) => token.immediate(/[A-Za-z0-9_]+/),

    fence_content: ($) => token(prec(-1, /([^`]|`[^`]|``[^`])+/)),
  },
});
