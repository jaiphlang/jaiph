# Done

Append-only archive. Generated view. Do not edit.
Each section was accepted by the product-owner `report_completed_task` def.

## Parse match arm bodies against an explicit grammar

Completed: 2026-11-12

### PO notes

Implemented directly (no product-owner run). `parseArmBody` in `src/parse/match.ts` now classifies the body against the grammar table and reports `E_PARSE` at the body's own column, in multiline and compact match and in `mock prompt { … }` blocks. The validator keeps only the scope checks. `looksLikeInlineScriptCall` is gone.

Judgment calls:
- A lone single-quoted body (`"x" => 'yes'`) keeps the language-wide single-quote message (existing parse-errors fixture). Only `'…'(`, `tag'…'(`, `'''` and backticks get the inline-script message.
- `$var` bodies are now `E_PARSE` (they were documented in language.md but are not in the task's grammar table). Docs and CHANGELOG updated.
- Trailing text after a quoted body (`"a" extra`) used to be silently dropped; it is now `invalid match arm body`.
- Empty / unterminated arm-body errors now point at the body column (fixtures updated).
- The arm-body error table lives in language.md: grammar.md is capped at 380 body lines by `integration/docs-grammar-language-split.test.ts`.

Tests: `src/parse/parse-match.test.ts` (every grammar row in match and mock prompt; each rejected form with exact column), `src/transpile/validate-match.test.ts`, `test-fixtures/compiler-txtar/parse-errors.txt` (+ snapshot).

Match arm bodies are parsed permissively today and checked later by regexes in the validator. Move the syntactic check into the parser so a bad arm body is `E_PARSE` at the exact column, and delete the regex checks.

### Current behavior

`parseArmBody` in `src/parse/match.ts` accepts a quoted string, a `"""` block, an inline-script lookalike (kept raw so the validator can reject it), and otherwise "bare words up to end of line". `validateMatchExpr` in `src/transpile/validate-match.ts` then rejects bad bodies with `E_VALIDATE`:

- a body starting with `return` ("the match expression itself produces the value")
- an inline script, detected by `looksLikeInlineScriptCall` (from `src/parse/fence.ts`, re-exported through `src/parse/scripts.ts` and `src/parser.ts`) plus regexes for `'…'(` and backticks
- `verb args` other than `fail "..."` ("unknown match arm verb", with a `did you mean "fail"?` hint for `error`)

Example: `"x" => some bare words` is `E_VALIDATE unknown match arm verb "some"; allowed: fail "...", ref(...).`

### Required behavior

An arm body (the text after `=>`, in both `match` expressions and `mock prompt { … }` blocks in `*.test.jh`) must be exactly one of:

| Form | Example |
|---|---|
| double-quoted string | `"x" => "hit"` |
| `"""` block | `"x" => """` … `"""` |
| identifier | `"x" => value` |
| dotted field | `"x" => result.field` |
| `${…}` reference | `"x" => ${value}` |
| managed call | `"x" => ref(args)` / `"x" => alias.ref(args)` |
| fail | `"x" => fail "reason"` |

Anything else is `E_PARSE` reported by the parser at the line and column where the body starts, with these messages:

- `return …` → `match arm body must not start with "return"; the match expression itself produces the value — use the expression directly after =>`
- inline script (`'…'(`, `lang'…'(`, `'''`, backticks) → `inline scripts are not allowed in match arm bodies; use a named script with "script_name(…)" instead`
- `ident words…` → `unknown match arm verb "ident"; allowed: fail "...", ref(...).` (keep the `did you mean "fail"?` hint for `error`)
- anything else → `invalid match arm body: <body>; expected a string, """ block, identifier, ${…}, ref(...), or fail "..."`

An apostrophe in a quoted string (`"it's"`) is a string, not an inline script.

### Keep in the validator

These need scope and stay `E_VALIDATE` in `validateMatchExpr`: unknown identifier in an arm body, invalid regex pattern, wildcard count (exactly one `_`), and at least one arm.

### Remove

- the `return` / inline-script / unknown-verb checks in `validateMatchExpr`
- `looksLikeInlineScriptCall` in `src/parse/fence.ts`, its re-export in `src/parse/scripts.ts`, and its export in `src/parser.ts`, if nothing else uses them
- the "bare words up to end of line" fallback in `parseArmBody`

### Acceptance

- Every row of the grammar table parses, in a `match` expression and in a `mock prompt { … }` block. Unit tests in `src/parse/parse-match.test.ts`.
- Each rejected form above is `E_PARSE` with the stated message and the column of the body's first character. Add cases to `test-fixtures/compiler-txtar/parse-errors.txt` and refresh `test-fixtures/compiler-txtar/parse-errors-snapshot.json` (`UPDATE_SNAPSHOTS=1`); move any existing `validate-errors.txt` cases for these messages there.
- `"x" => "it's fine"` parses.
- Unknown identifier, invalid regex, and wildcard-count errors are still `E_VALIDATE` (existing tests stay green).
- `integration/format-roundtrip.test.ts`, `npm test`, `npm run lint`, and `bash e2e/test_all.sh` pass.
- `docs/grammar.md` match-arm grammar and the validation catalog list the arm-body forms and move these errors from `E_VALIDATE` to `E_PARSE`. Add a CHANGELOG entry under Unreleased.

## Add a Jaiph tokenizer (parser not wired yet)

Completed: 2026-11-12

### PO notes

Implemented directly (no product-owner run). The original kind table could not meet the lossless criterion: sources that parse today use `=~` / `!~` with a regex operand, bare `$x` / `${…}`, `;` between arms, `\` line continuation, regex patterns in `mock prompt { … }`, and raw shell bodies in `mock script … { … }`. The spec was revised in the queue (see "Spec revision") before implementation, at the user's request.

Notes for the parser-migration tasks:
- `raw_body` is triggered by a line matching `mock script … ) {`; the parser still owns what a mock body means.
- Regex position is tracked with a brace stack (`match` / `mock prompt` blocks, `${` interpolations, plain braces). A `/` anywhere else is `unexpected character`.
- `"""` / `'''` closers end after the three quotes, so `""")`, `""" returns "…"` and `'''(x)` tokenize as block + following tokens.
- The corpus collector moved to `integration/jaiph-corpus.ts`, shared with the format round-trip test.

Tests: `src/parse/lexer.test.ts` (20 cases incl. the not-imported-by-parser guard, to be dropped when B2 wires it in), `integration/lexer-lossless.test.ts`.

The parser reads `.jh` source line by line with `startsWith` checks and ad hoc quote scanners (`indexOfClosingDoubleQuote`, `hasUnescapedClosingQuote` in `src/parse/core.ts`, the scanners in `src/parse/call-args.ts`, `src/parse/statement-split.ts`, `src/parse/nested-arg.ts`). This task adds a standalone tokenizer. It does not change the parser; later tasks move the parser onto it.

### Required

Add `src/parse/lexer.ts` exporting `tokenize(source: string, filePath: string): Token[]`. Every token has `kind`, `text` (the exact source slice), `line`, and `col` (1-based). Kinds:

| Kind | Source |
|---|---|
| `ident` | `[A-Za-z_][A-Za-z0-9_]*` (keywords are idents; the parser decides) |
| `string` | single-line `"…"`; `\"` is the only escape |
| `triple_string` | `"""` … `"""` block. The opening `"""` ends its line; the closer is the first later line whose trimmed text starts with `"""`, and the token ends after those three quotes (text after the closer, such as `)` or `returns "…"`, is tokenized normally) |
| `script_oneline` | `'…'` with an optional interpreter tag touching the quote (`python3'…'`); no escapes, first `'` closes |
| `script_fenced` | `'''` … `'''` with an optional tag before the opening quotes (`node'''`); closer is a trimmed line starting with `'''` |
| `number` | `[0-9]+` |
| `regex` | `/…/` (first unescaped `/` closes, same line) in two positions only: a pattern in a `match … {` or `mock prompt {` block (first token of an arm: after `{`, a newline, `,`, or `;`, or after the pattern-alternation bar), and the right-hand operand of `=~` / `!~` in `if` |
| `punct` | `( ) { } , = . ; $ ${ => -> == != =~ !~`, the pattern-alternation bar, and `\` before a newline (line continuation, as in `prompt "…" \` + `returns "…"`); longest match first |
| `raw_body` | the shell lines of a `mock script ref(…) {` block in a `*.test.jh` file: from the start of the first body line up to the start of the first line whose trimmed text is `}` (newlines included) |
| `newline`, `comment` (`#` to end of line) | |

Any other character outside a token (including `/` outside a regex position) is `E_PARSE` (`unexpected character`). Tags follow `[A-Za-z_][A-Za-z0-9_.-]*`. A tag separated from the quote by whitespace is an `ident` followed by a script token. `${…}` inside a string stays part of the `string` token. Removed forms keep their current errors: triple backticks and one-line backticks are `E_PARSE` with the messages in `src/parse/fence.ts`.

### Acceptance

- Unit tests in `src/parse/lexer.test.ts` cover every kind (including every punct, regex after `=~` / `!~` and in `mock prompt { … }`, `raw_body`, and line continuation), `/` outside a regex position, tags with `.` and `-`, `\"` inside strings, an apostrophe inside a string (`"it's"`), and unterminated string / block errors (`E_PARSE` with line and column).
- Lossless: for every source collected by `integration/format-roundtrip.test.ts` (tracked `.jh` files, compiler-txtar valid inputs, e2e heredocs, docs code blocks) that parses today, concatenating `text` of all tokens plus the skipped whitespace reproduces the source exactly. Add this as a test.
- The tokenizer is not imported by any parser module yet. `npm test`, `npm run lint`, and `npm run arch:check` pass.

### Spec revision (2026-11-12)

The first version of this task listed only `( ) { } , = . => ->`, the bar, `==` and `!=` as punct, and allowed regex only in match-pattern position. Sources that parse today also use `=~` / `!~` with a regex operand (`if name =~ /^feat-/ {`), bare `$x` and `${…}` outside strings (`return $bad`), `;` between arms on one line, `\` line continuation, regex patterns in `mock prompt { … }`, and raw shell bodies in `mock script … { … }`, so the lossless criterion could not pass. The kind table above adds them.
