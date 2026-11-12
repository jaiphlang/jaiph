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

## Parse strings and call arguments from tokens

Completed: 2026-11-12

### PO notes

Implemented directly. One token-based parser (`parseCallArgs`, private to `src/parse/call-args.ts`) builds every `Arg[]`; `parseCallRef`, `parseParenArgs`, `parseMultilineCallArgList`, and `parseNestedCallArg` (shared by validator, emitter, runtime via `src/parser.ts`) use it. Golden ASTs, compiler fixtures, parse-error snapshots, and the format round-trip were unchanged with no snapshot refresh.

Lexer changes needed for this: `lex()` pull-based generator (a call stops at its `)` and never scans the rest of the line), `{ lenient: true }` (stray characters become `other` tokens and `#` is text, so `foo(a > b)` still reaches the validator's E_VALIDATE), `{ start }` (absolute line/col/offset when lexing from mid-file), and an `offset` on every token.

Deleted: `commaArgsToArgList`, `pushArg`, the multiline char scanner, `src/parse/nested-arg.ts`, runtime `parseArgsRaw` + tests, and the "lexer not imported by the parser" guard test. `parseCallRef` / `parseParenArgs` moved from core.ts to call-args.ts (re-exported through scripts.ts to stay under parser.ts's max-dependencies cap).

Tests: `src/parse/call-args.test.ts`.

Prerequisite: `src/parse/lexer.ts` exports `tokenize()` with `string`, `triple_string`, `script_oneline`, `ident`, and `punct` tokens carrying line and column. If it does not exist, this task is blocked.

Call arguments and string literals are parsed today by character scanners that each handle quotes differently: `commaArgsToArgList` and `pushArg` in `src/parse/core.ts`, `parseMultilineCallArgList` in `src/parse/call-args.ts`, `parseNestedCallArg` in `src/parse/nested-arg.ts`, and `parseCallRef`. Move all of them onto the tokenizer.

### Required

- One function parses an argument list from tokens and returns the existing `Arg[]` shape (`{ kind: "var" }` / `{ kind: "literal", raw }`) with `raw` in the shared stored form (`"` + text with `"` written as `\"` + `"`, produced by `tripleQuoteBodyToRaw` in `src/parse/triple-quote.ts`; decoded by `literalText` in `src/parse/core.ts`).
- Nested calls (`foo(bar(x))`, `foo('echo $1'(x))`, `foo(python3'print(1)'())`) are recognized from tokens. The validator, the script emitter (`src/transpile/emit-script.ts`), and the runtime (`parseManagedArgAt` in `src/runtime/kernel/runtime-arg-parser.ts`) keep calling one shared recognizer exported from `src/parser.ts`.
- A `"""` argument may open on the call line or its own line, as today.
- Delete the replaced scanners. Delete `parseArgsRaw` in `src/runtime/kernel/runtime-arg-parser.ts` (unused outside its tests) and its tests.

### Acceptance

- Golden ASTs (`npm run test:golden-ast`), compiler fixtures (`npm run test:compiler`), and `integration/format-roundtrip.test.ts` are unchanged.
- `e2e/tests/154_string_values.sh` and `e2e/tests/112_interpreter_tags.sh` pass.
- A comma or `)` inside a quoted argument, `\"` inside an argument, and a nested call three levels deep each have a unit test.
- `npm test`, `npm run lint`, `npm run arch:check`, and `bash e2e/test_all.sh` pass.

## Dispatch def-body statements from tokens

Completed: 2026-11-12

### PO notes

Implemented by a subagent, reviewed and gated in the main session. `parseBraceBlockBody` reads lines through `BodyCursor` (src/parse/body-cursor.ts; lenient per-line lexing, a `"""` / `'''` block is one token); `STATEMENT` dispatches on `keyOf(tokens[0])`. Handlers live in `stmt-{call,invoke,control,say,return,decl}.ts`, `attached-block.ts`, `block-ctx.ts`; recursion goes through a parsers object so there is no import cycle. Override removed from eslint.config.mjs. No snapshot/golden/fixture changes; a differential run of old vs new parser over 1516 sources plus ~445k line mutations found no diffs.

Left for the helper-removal task: handlers still slice text after the keyword and use `hasUnescapedClosingQuote` / `indexOfClosingDoubleQuote` (to choose "unterminated" vs "multiline strings use triple quotes" messages), `IF_CONDITION_RE`, catch/recover splitting, `splitStatementsOnSemicolons` for inline `{ a; b }`, `startsInlineScript`, and `innerRaw.indexOf(...)` columns. Top-level `scripts.ts`, `env.ts`, `prompt-def.ts`, `tests.ts` still copy `[...lines]`.

Pre-existing bug, preserved (not in scope): `STATEMENT[keyword]` is a plain property lookup, so a def-body line `toString()` / `constructor()` hits Object.prototype and fails with `unterminated block`.

Prerequisite: `src/parse/lexer.ts` exports `tokenize()` (line/column tokens for strings, `"""` blocks, one-line and fenced scripts with interpreter tags, idents, punctuation). If it does not exist, this task is blocked.

`src/parse/workflow-brace.ts` (about 1,400 lines) parses def bodies line by line. The `STATEMENT` table dispatches on `c.inner.startsWith("<keyword> ")`, and fenced / `"""` blocks are parsed by copying the whole `lines` array (`[...lines]`) and splicing one line, once per block, in `workflow-brace.ts`, `const-rhs.ts`, `send-rhs.ts`, `prompt.ts`, `inline-script.ts`, and `triple-quote.ts`. It is exempt from the ESLint `max-lines` and `import/max-dependencies` caps in `eslint.config.mjs`.

### Required

- Def-body statements are parsed from a token cursor. `STATEMENT` dispatches on the first token's kind and text, not on string prefixes.
- No `[...lines]` copies remain in these files; block parsers advance the cursor.
- Split `workflow-brace.ts` into cohesive modules under the ESLint caps without an import cycle (`npm run arch:check` enforces `no-circular`), and delete its override in `eslint.config.mjs`.
- The AST and its trivia are unchanged: same `StepDef` shapes, same `loc` values, same error codes and messages and columns.

### Acceptance

- Golden ASTs, `test-fixtures/compiler-txtar/parse-errors-snapshot.json` (no snapshot update needed), compiler fixtures, and `integration/format-roundtrip.test.ts` are unchanged.
- `npm test`, `npm run lint` (with the override removed), `npm run arch:check`, and `bash e2e/test_all.sh` pass.

## Parse top-level declarations from tokens

Completed: 2026-11-12

### PO notes

Implemented by a subagent, reviewed and gated in the main session. parse-module dispatches on `topLevelKeyword(BodyCursor.lineTokensOf(idx))`; import / import script / channel / config / const / script / prompt def / def header / test blocks and DSL steps (new `test-steps.ts`) read tokens. No `[...lines]` copies remain in src/parse. Differential run vs HEAD over 1516 sources + ~900k mutations: no diffs except the accepted test-DSL string change (`\"` is now the only escape in test strings; CHANGELOG entry added).

Still line/string based (blocks the helper-removal task's prerequisite): parse-module `source.split`, `parseMatchArms` + `statement-split.ts` (match and mock prompt arms), prompt.ts quote scanners, def-body handler text slicing (see the def-body task notes), free-text regions kept for byte-identical errors (import path, param lists, use clause, config values, test call args via `parseTestCallArgs`).

Pre-existing bugs preserved: channel locations via `raw.indexOf(name)` (wrong col when the name is a substring of `channel`); `mock prompt` errors report a 0-based column; config accepts `"a" "b"`; `const x == y` accepted; `import \t as y` gives an empty path; `mock prompt "a" x` accepted.

Prerequisite: `src/parse/lexer.ts` exports `tokenize()` (line/column tokens for strings, `"""` blocks, one-line and fenced scripts with interpreter tags, idents, punctuation). If it does not exist, this task is blocked.

Top-level declarations are parsed line by line: `src/parse/parse-module.ts` dispatches each line, and `scripts.ts`, `env.ts`, `imports.ts`, `channels.ts`, `metadata.ts` (`config { … }`), `prompt-def.ts`, and `tests.ts` (`*.test.jh` blocks) each re-scan raw text with their own regexes.

### Required

- Every top-level declaration is parsed from a token cursor: `import`, `import script`, `channel` and routes, `config { … }`, `const`, `script` (with `use` clause and interpreter tag), `prompt` definitions, `def` / `export def` headers, and `test "…" { … }` blocks with their DSL statements.
- Config values keep their rules: `\"` is the only escape; `\n`, `\t`, `\\` are `E_PARSE` with the existing migration message (`rejectRemovedEscapes` in `src/parse/core.ts`).
- The AST and trivia are unchanged, including `ConfigBodyPart.bareSource` and `EnvDeclDef.tripleQuoted`.

### Acceptance

- Golden ASTs, `test-fixtures/compiler-txtar/parse-errors-snapshot.json` (no snapshot update needed), compiler fixtures, and `integration/format-roundtrip.test.ts` are unchanged.
- `npm test`, `npm run lint`, `npm run arch:check`, and `bash e2e/test_all.sh` pass.

## Parse match arms and statement operands from tokens

Completed: 2026-11-12

### PO notes

Implemented by a subagent, reviewed and gated in the main session. New `src/parse/match-arms.ts` (arms from tokens) and `src/parse/slice-lexer.ts` (never-failing per-slice token reader, `splitStatements`, `startsScript`, `firstColOnLine`); operands in stmt-*.ts, prompt.ts, send-rhs.ts, const-rhs.ts, inline-script.ts, attached-block.ts read tokens; `firstCol` reproduces the old `indexOf` columns from token positions. Deleted `lastUnquotedChar`, `splitCompactArmSegments`, `IF_CONDITION_RE`, `startsTaggedScriptFence`. Parser code no longer calls the six helpers (one call left inside dead `expandBlockLineStatements`).

Differential: 1516 sources; all mutators seeds 21-24 at 10/line (~170k checks each) and targeted-only seeds 31-34 at 12/line (~106k each): 0 diffs.

Old behaviour deliberately kept (task requires unchanged): `if` operands with `\\` use the old any-char escape rule (`BACKSLASH_OPERAND_RE` in stmt-control.ts); the first ` catch ` / ` recover(` occurrence decides even inside quoted text; multi-line `returns "…"` schema is a text scan across lines (prompt.ts).

Bugs found, preserved: quoted " recover " / " catch " makes a valid catch clause fail; `fail "x" y` drops `y` and `return "x" y` stores `"x" y` while `log "x" y` is rejected; compact match splits on commas inside call args (`{ "a" => f(x, y) }` → invalid arm body); multiline arm body `f("""y""")` accepted as a call.

Prerequisite: `src/parse/body-cursor.ts` exists (`BodyCursor`, per-line token reading used by `src/parse/workflow-brace.ts` and `src/parse/parse-module.ts`) and `STATEMENT` in `src/parse/workflow-brace.ts` dispatches on the first token. If not, this task is blocked.

Statement dispatch and top-level declarations read tokens, but several parsers still scan text. This task moves them onto tokens so the line-based helpers can be deleted afterwards.

### Current behavior

- `parseMatchArms` and the compact form in `src/parse/match.ts` (used by `match` in def bodies and by `mock prompt { … }` in `*.test.jh`) read raw lines, split arms with `splitStatementsOnSemicolons` (`src/parse/statement-split.ts`), and find strings and regexes with their own scanners (`indexOfClosingDoubleQuote`, `lastUnquotedChar`, `splitCompactArmSegments`).
- Def-body statement handlers (`src/parse/stmt-*.ts`, `src/parse/attached-block.ts`, `src/parse/prompt.ts`, `src/parse/const-rhs.ts`, `src/parse/send-rhs.ts`, `src/parse/inline-script.ts`) take the text after the keyword and scan it: `hasUnescapedClosingQuote` / `indexOfClosingDoubleQuote` to choose between "unterminated" and "multiline strings use triple quotes", `IF_CONDITION_RE` for `if` conditions, a text search for ` catch ` / ` recover(` in `parseCallStatement`, `splitStatementsOnSemicolons` for inline `{ a; b }` blocks, `startsInlineScript` / `parseSingleQuoteScriptBody`, and `innerRaw.indexOf(…)` for some columns.
- `src/parse/parse-module.ts` splits the source with `source.split(/\r?\n/)`; the `lines` array is the cursor's backbone and the `{ nextIndex }` contract between parsers.

### Required

- Match arms (multiline, `;`-separated, and compact `{ a, b }` forms, in `match` and `mock prompt { … }`) are parsed from tokens: patterns from `string` / `regex` / `_` tokens and the alternation bar, the body per the arm-body grammar in `docs/grammar.md`. `lastUnquotedChar` and `splitCompactArmSegments` are deleted.
- Def-body statement operands (`fail`, `log` / `logerr` / `logwarn`, `return`, `send`, `prompt` and its `returns` clause, `const` right-hand sides, `if` conditions, `stdin` operands, inline scripts, `catch` / `recover` clauses, inline `{ a; b }` blocks) are read from tokens. Error messages that depend on string shape ("unterminated …", "multiline strings use triple quotes") are chosen from the token stream: an `other` token from an unterminated string, or a `string` token followed by text.
- Columns come from token positions, not `indexOf` on the line text.
- The parser no longer calls `splitStatementsOnSemicolons`, `hasUnescapedClosingQuote`, `indexOfClosingDoubleQuote`, `startsInlineScript`, `startsTaggedScriptFence`, or `splitScriptLangPrefix`. Leave the functions in place if the validator, formatter, or runtime still import them; a later task deletes what is unused.
- The AST, trivia, `loc` values, error codes, messages, and columns are unchanged. Known pre-existing quirks (wrong `channel` column, 0-based `mock prompt` column, the `Object.prototype` lookup in `STATEMENT`) stay as they are; fixing them is separate work.

### Acceptance

- Golden ASTs, `test-fixtures/compiler-txtar/parse-errors-snapshot.json` (no snapshot update), compiler fixtures, `integration/format-roundtrip.test.ts`, and `integration/lexer-lossless.test.ts` are unchanged and pass.
- A differential run of the parser before and after the change, over every repo source (tracked `.jh`, compiler-txtar inputs, e2e heredocs, docs blocks) plus per-line mutations of match arms and statement operands, reports no difference in AST (with `loc`), formatter output, or exact error text. Record the run size in the task notes.
- `grep` finds no call to the six helpers above in parser code under `src/parse/` (definitions and tests excepted).
- `npm test`, `npm run lint`, `npm run arch:check`, and `bash e2e/test_all.sh` pass.

## Remove the line-based parser helpers

Completed: 2026-11-13

### PO notes

Implemented by a subagent, reviewed and gated in the main session. One `BodyCursor` over the whole source; positions are line-start offsets; parsers take `(cursor, at)` and return `next`. Deleted statement-split.ts and the quote/prefix scanners (see commit). New guard test `src/parse/line-scan-grep.test.ts`; contributing.md test table updated. Remaining `split(` calls in src/parse split params, `use` clauses, route lists, shebang words, or a block token's own text — none split the source into lines. `text(at)` / `lineNo(at)` still read source text by offset for free-form regions, error messages, and the multi-line `returns` scan.

Differential vs HEAD: 1516 sources, whole-source variants (CRLF, CR, no final newline, truncations), 24 structural mutators; ~2.4M checks, 0 diffs. `atEnd` is `!(at <= source.length)` on purpose to keep the `Object.prototype` STATEMENT quirk's old "unterminated block" result.

Note for the user: `.claude/settings.local.json` still allow-lists `node --test dist/src/parse/statement-split.test.js` (file deleted); not edited.

Prerequisite: def bodies, top-level declarations, strings, and call arguments are all parsed from `tokenize()` in `src/parse/lexer.ts`. If any parser module still scans raw lines, this task is blocked.

### Required

- Delete every helper that only served line-based parsing: string-prefix detectors (`startsInlineScript`, `startsTaggedScriptFence`, `splitScriptLangPrefix`, `looksLikeInlineScriptCall` if still present), quote scanners (`indexOfClosingDoubleQuote`, `hasUnescapedClosingQuote`), `src/parse/statement-split.ts` if unused, and anything `ts-prune`-style dead after the migration. Keep functions the runtime or validator still import through `src/parser.ts`.
- Update `docs/architecture.md` (parser section) to describe the tokenizer and the cursor-based parsers, and remove references to deleted helpers. `docs/agent-analyzability.md` parse row stays accurate.

### Acceptance

- No file under `src/parse/` reads `.split("\n")` lines for parsing except `tokenize()`.
- Golden ASTs, compiler fixtures, and `integration/format-roundtrip.test.ts` are unchanged.
- `npm test`, `npm run lint`, `npm run arch:check`, and `bash e2e/test_all.sh` pass. Add a CHANGELOG entry under Unreleased.

### Known remaining line-based reads (as of the match-arm / operand task)

- `src/parse/parse-module.ts`: `source.split(/\r?\n/)`; the `lines` array is the `BodyCursor` backbone and the `{ nextIndex }` contract between parsers. `src/parse/call-args.ts` computes a `lineOffset` from it.
- `src/parse/prompt.ts`: `returns` parsing joins `\` continuation lines and scans a schema string that may continue on later lines.
- `src/parse/attached-block.ts`: multi-line block `}` pre-scan over `lines`.
- `src/parse/triple-quote.ts` `readTripleQuoteBlock` / `readFencedScript`: opener column from `lines[idx].trimEnd().length`.
- Free-form text regions kept for byte-identical errors: import path, parameter lists, `use` clause, config values, `channel` names (`raw.indexOf`), test call args (`parseTestCallArgs`), `matchSendOperator` / `matchLegacySendOperator`, assignment-guard regexes, `MATCH_HEAD_RE`.
- Helper definitions now unused by parser code: `splitStatementsOnSemicolons` (only dead `expandBlockLineStatements` and tests), `hasUnescapedClosingQuote`, `indexOfClosingDoubleQuote`, `startsInlineScript`, `splitScriptLangPrefix` — check validator / formatter / runtime imports through `src/parser.ts` before deleting.

Behaviour must stay unchanged (AST, trivia, loc, messages, columns). Use a before/after differential run of the parser over every repo source plus line mutations, as the previous parser tasks did.
