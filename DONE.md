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

## Fix the repo's own agent workflows under .jaiph

Completed: 2026-11-15

### PO notes

Implemented directly in a maintainer session (the engineer prompt forbids editing `.jaiph/**`).

- `engineer.jh`: `implement_from_queue` takes `queue.next_available()`, marks the task `#in-progress`, and archives it to DONE.md after CI and docs parity pass. The archive runs just before the commit so the commit carries the regenerated views. On failure the claim is released and the task stays queued.
- Queue writers: kept the direct writes and reworded QUEUE.md rules 3 and 4 and the `product_owner.jh` header to match.
- `simplifier.jh`: guard covers `integration/`, `e2e/`, `test-infra/`, `test-fixtures/`, `*.test.ts`, `*.test.jh`. It also skipped the last path when the list had no trailing newline; fixed.
- `qa.jh`, `architect_review.jh`: stale paths and the "transpiles to Bash" sentence replaced.
- All `.jaiph/*.jh` formatted; `pull_latest_logs` and the now unused `assert_nonempty_file_or_fail` removed from `gh_ci_passes.jh`.

Tests: `.jaiph/engineer.test.jh`, `.jaiph/simplifier.test.jh`, `integration/repo-workflow-prompts.test.ts`, `e2e/tests/156_repo_workflows_check.sh` (format, compile and `jaiph test` for `.jaiph/`).

Source: code audit 2026-11-15. Not `#dev-ready`: `.jaiph/engineer.jh` forbids the implementing agent from editing `.jaiph/**`, so a maintainer (or a parent session) does this one by hand.

### Current behavior

- **Task loss in `engineer.jh`.** `implement_from_queue` (around line 365) calls `queue.get_first_task()`, which is `queue("get")` with no tag filter: it returns the first task even when it is `#in-progress`. It then calls `queue.remove_completed_task(...)` (line 375) before `verify_docs_and_commit` (line 377), that is, before CI. If CI recovery is exhausted the task is gone from `.jaiph/queue-state.md` (gitignored), never reached DONE.md, and nothing was committed. The prompt text at lines 44–46 describes QUEUE.md rule 4 as it used to read.
- **Queue writers.** QUEUE.md rule 4 and the `product_owner.jh` header say the product-owner defs are the only queue writers, but `engineer.jh`, `architect_review.jh` (lines 96, 102) and `security_review.jh` (line 247) write the queue directly.
- **Simplifier guard.** `simplifier.jh` line 49 blocks changes under `test/*` and `e2e/*`. There is no `test/` directory; tests live in `integration/`, `src/**/*.test.ts`, `test-infra/`, `test-fixtures/`. The agent can rewrite tests or golden fixtures and the guard stays green.
- **QA paths.** `qa.jh` (lines 84, 104, 200–203) tells the agent to add cases to `compiler-tests/*.txt` ("create if missing"); the runner reads `test-fixtures/compiler-txtar`. Lines 109–112 tell it to audit "each jaiphError() call" in `src/transpile/validate.ts`, which uses `diag.error(...)`.
- **Stale architecture.** `engineer.jh` line 277 and `architect_review.jh` line 22 say Jaiph "transpiles to Bash". `architect_review.jh` lines 16–17 cite `run … catch` and `parseRecoverStatement`, which no longer exist.
- **Formatting.** `jaiph format --check .jaiph/*.jh` fails for 10 files. `pull_latest_logs` in `gh_ci_passes.jh` (line 100) is never called.

### Required behavior

- `implement_from_queue` takes the first `#dev-ready` task that is not `#in-progress`, marks it in progress, and archives it to DONE (`archive_to_done`) only after CI passes and the commit succeeds. On failure the task stays in the queue and the in-progress mark is removed.
- Either route architect and security queue writes through the product-owner defs, or reword rule 4 and the "sole writer" header to match what the workflows do.
- Simplifier guard and prompt cover `integration/*`, `e2e/*`, `test-infra/*`, `test-fixtures/*` and `*.test.ts`.
- QA prompt names `test-fixtures/compiler-txtar/…` and `diag.error(` sites.
- Replace the "transpiles to Bash" sentence with the opening sentence of `docs/architecture.md`; drop the removed names.
- Run `jaiph format .jaiph/*.jh`; delete `pull_latest_logs`.

### Acceptance

- `.jaiph/engineer.test.jh` with mocked prompts and CI: an `#in-progress` first task is skipped; a failing CI leaves the task in the queue and not in DONE.
- A test for the simplifier guard script: `integration/x.test.ts`, `src/a/b.test.ts` and `test-fixtures/x.txt` are rejected.
- Extend `e2e/tests/128_examples_format_check.sh` (or add a sibling) to run `jaiph format --check` and `jaiph compile` on `.jaiph/*.jh`.
- A test that every backticked repo path in `.jaiph/*.jh` prompt text exists, and that the phrase "transpiles to Bash" does not appear under `.jaiph/` or `docs/`.

## Give each module its own emitted script files

Completed: 2026-11-15

Source: code audit 2026-11-15 (line numbers as of commit 494a316d). Reproduced.

### Current behavior

`emitGraphInto` in `src/transpile/build.ts` (around line 152) writes every module's scripts to `join(scriptsRoot, s.name)`. Two modules that both declare `script check = …` write the same file, and the module that sorts last wins. The runtime (`executeScript` in `src/runtime/kernel/node-workflow-runtime.ts`) runs `join(scriptsDir, scriptName)` with no module qualifier, but builds the script env from the calling module's `use` clause.

Reproduction: the entry file declares `script check = 'echo ENTRY; exit 1'` and calls it. An imported `zlib.jh` declares `script check = 'echo LIB'`. Both calls run the lib body and the run prints PASS. A failing gate in the entry file is silently replaced. A third-party lib body can also run with the env grants (`use GITHUB_TOKEN`) of a same-named entry script.

### Required behavior

- A script call runs the body declared in the module that the call resolves to, always.
- The `use` env comes from the script definition that actually runs.
- Emitted file names are unique per (module, script name). Reuse the existing module symbol or a short hash of the module path. Inline and nested scripts already use sha256-derived names; keep them.
- The runtime resolves the file from (module path, script name), not from the bare name.

### Acceptance

- New integration test: two modules with a same-named script and different bodies; each call runs its own body; the failing one fails the run.
- New test: same-named scripts with different `use` clauses; each body sees only its own granted variable.
- Existing script tests, `npm test`, `npm run lint`, `npm run arch:check`, and `bash e2e/test_all.sh` pass.
- `docs/architecture.md` describes the new file naming. CHANGELOG entry under Unreleased.

## Fail the prompt step when the agent backend dies from a signal

Completed: 2026-11-15

Source: code audit 2026-11-15. Reproduced with fake `claude`, `cursor-agent` and custom agent binaries.

### Current behavior

`src/runtime/kernel/prompt-backends.ts` settles with `code ?? exitCode ?? 0` (around lines 322 and 347). A process killed by a signal reports `code === null`, so the status becomes 0. An agent that prints partial output and is then OOM-killed passes the prompt step with truncated text. Retry and `recover` never run.

Script steps already handle this correctly (`typeof code === "number" ? code : 1`).

### Required behavior

- Capture the signal from the `exit` / `close` event for the claude, cursor and custom backends.
- `code === null` is a failure with a message that names the signal, for example `agent backend killed by SIGKILL`.
- Exception: the watchdog's completion-grace path, which kills a backend that already produced its final result, keeps reporting success.

### Acceptance

- Unit tests through the `_backendSpawn` seam: for each of the three backends, `close(null, "SIGKILL")` after partial output gives a non-zero status and an error naming the signal.
- Test that the completion-grace kill still returns status 0.
- `npm test` and `bash e2e/test_all.sh` pass. CHANGELOG entry under Unreleased.

## Write inbox events through the audit-chain emitter

Completed: 2026-11-15

Source: code audit 2026-11-15. Reproduced with `examples/agent_inbox.jh`.

### Current behavior

`RuntimeEventEmitter.serializeAndAppend` (`src/runtime/kernel/runtime-event-emitter.ts`) adds `prev_hash` to every journal line and advances the hash chain. The runtime bypasses it for `INBOX_ENQUEUE`, `INBOX_DISPATCH_START` and `INBOX_DISPATCH_COMPLETE`: `node-workflow-runtime.ts` calls `appendRunSummaryLine` directly (around lines 1161, 1531, 1552). Those lines have no `prev_hash`.

Any run that uses `send` exits 0 and then fails `verifyRunJournal` with `expected prev_hash …, got undefined`. Per `docs/architecture.md`, `jaiph serve` then lists the run as failed/tampered, `GET /runs/{id}/events` returns `409 E_TAMPERED`, and OTLP/Sentry export is skipped.

### Required behavior

- The emitter is the only writer of `run_summary.jsonl`. Add an emitter method for inbox events that goes through `serializeAndAppend`.
- `appendRunSummaryLine` is no longer exported from `src/runtime/kernel/emit.ts` (or is only reachable from the emitter).
- Inbox line content is unchanged apart from the added `prev_hash`.

### Acceptance

- `src/runtime/kernel/node-workflow-runtime.audit-chain.test.ts`: a workflow with a channel, `send` and a route, run with a chain key; `verifyRunSummaryChain(...).ok` is true.
- A grep-style test: no file except the emitter calls `appendRunSummaryLine`.
- `integration/run-summary-jsonl.test.ts` and the inbox e2e scripts stay green. `npm test` and `bash e2e/test_all.sh` pass. CHANGELOG entry under Unreleased.

## Validate lockfile entries and lib names in jaiph install

Completed: 2026-11-15

Source: code audit 2026-11-15. Reproduced.

### Current behavior

All in `src/cli/commands/install.ts`:

- Restore builds `libDir: join(libsDir, e.name)` from `.jaiph/libs.lock` without validating `e.name`. A lock entry `{"name":"../../../victim", …}` plus `jaiph install --force` recursively deletes that directory outside the workspace and clones attacker content into it. Without `--force` it writes into any path that does not exist yet.
- Lock `url` values skip `assertAllowedRemoteScheme`, so `http://` and `git://` are accepted on restore.
- `readLockFile` casts `JSON.parse` output to `LockFile` with no shape check.
- `deriveLibName("https://host/you/lib/")` returns `""`, so `libDir === libsDir`. With `--force` this deletes every installed lib and writes a lock entry with an empty name. A URL ending in `/..` targets `.jaiph` itself.
- The pin check is `spec.expectedCommit && commit && commit !== …`. When `git rev-parse` fails, `commit` is empty and the pin is skipped.
- `git clone … <url> <libDir>` has no `--` separator, and a url or ref that starts with `-` is not rejected.
- `jaiph install name@v2` when the lib directory already exists prints "skipping" but rewrites the lock entry to `version: v2` with the old commit. A later clean restore fails with a commit mismatch.

### Required behavior

- One validation function for a lib name, used by the registry path, the URL-derived path and the lock path: it must match the existing `REGISTRY_NAME_REGEX`. After `join`, assert `dirname(libDir) === libsDir`.
- `readLockFile` checks shape: `libs` is an array; each entry has string `name`, `url`, and optional string `version`, `commit`, `signature`. A bad lockfile is an error that names the entry, and nothing is deleted or cloned.
- Lock urls go through `assertAllowedRemoteScheme`.
- `deriveLibName` strips trailing slashes; an empty or invalid derived name is an error.
- When `expectedCommit` is set and the cloned commit cannot be read, the install fails.
- Reject a url or ref that starts with `-`; pass `--` before positional arguments to git.
- A skipped lib keeps its existing lock entry unchanged.

### Acceptance

- Unit tests with the injectable runner: lock names `../x`, `a/b`, `""`, `.`, `..` are rejected and no path outside `.jaiph/libs/<name>` is removed or created (assert with a sentinel directory beside the workspace).
- `jaiph install --force https://host/you/lib/` installs to `libs/lib`; `https://host/you/` style inputs that derive an invalid name fail and leave other libs in place.
- Lock entry with `http://` url is rejected.
- Pin set and unreadable HEAD fails the install.
- Url `--upload-pack=x` and ref `-x` are rejected; the git argv contains `--` before the url.
- Skip path leaves the lock file byte-identical.
- `npm test` passes. `docs/` install page states the name rule. CHANGELOG entry under Unreleased.

## Scope MCP-over-HTTP in-flight calls to the caller

Completed: 2026-11-15

Source: code audit 2026-11-15. Reproduced against the handler.

### Current behavior

`ServeHandler` (`src/cli/serve/handler.ts`) holds one `McpServer` (`src/cli/shared/mcp-server.ts`) for all HTTP clients. `McpServer.inFlight` is a map keyed only by the client-chosen JSON-RPC id. `handleCancelled` looks up `params.requestId` and calls `cancelRun` with no principal check. `handleMcp` requires a capability only for `tools/call` and `tools/list`, so `notifications/cancelled` needs none.

- In OIDC mode, a caller with a valid token and no scopes can POST `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}` and kill another principal's run. Ids are guessable. `docs/cli.md` promises that a principal may cancel only runs it created.
- In any mode, two concurrent `tools/call` requests with the same id overwrite each other's entry. The first to finish deletes it; the other loses progress notifications and cannot be cancelled. An SSE disconnect cancels by id and can kill the wrong call.

### Required behavior

- Over HTTP, in-flight calls are tracked under a server-generated key, or under (principal, id). Two calls with the same client id are independent.
- `notifications/cancelled` over HTTP cancels only a call owned by the same principal and requires the `cancel` capability. Otherwise it is a no-op (still 202).
- An SSE disconnect cancels exactly the call of that request, through a captured handle, not by id lookup.
- stdio MCP behaviour is unchanged.

### Acceptance

- Handler test with two principals: B's `notifications/cancelled` for A's request id does not cancel A's run; A's own cancel does.
- A principal without the `cancel` capability cannot cancel its own call through `/mcp`.
- Two concurrent same-id calls both complete with their own results, and cancelling one leaves the other running.
- SSE hang-up on one of two same-id calls cancels only that one.
- `integration/mcp-server.test.ts`, `integration/serve-server.test.ts`, `integration/serve-auth.test.ts` pass. `docs/cli.md` / `docs/mcp.md` state the rule. CHANGELOG entry under Unreleased.

## Reject cross-origin and wrong-Host requests in jaiph serve

Completed: 2026-11-15

Source: code audit 2026-11-15. `/mcp` accepting `text/plain` was reproduced.

### Current behavior

The default `jaiph serve` binds `127.0.0.1` with auth off. No code under `src/cli/serve` reads the `Origin` or `Host` header. `handleMcp` in `handler.ts` does not check `Content-Type`; REST routes return 415 only when the body is non-empty.

Any web page the developer opens can run `fetch("http://127.0.0.1:5247/mcp", {method:"POST", mode:"no-cors", body:'{"jsonrpc":"2.0","id":1,"method":"tools/call",…}'})`. This is a simple request with no preflight, and the workflow runs with attacker-chosen arguments. A def with no parameters can also be started with an empty-body `POST /{name}`. With DNS rebinding the page can read `/runs`, events and artifacts too. The MCP Streamable HTTP spec requires Origin validation for this reason.

### Required behavior

- If an `Origin` header is present and is not the server's own origin or in an allowlist, respond 403 with a JSON error. Add an allowlist setting (`JAIPH_SERVE_ALLOWED_ORIGINS`, comma separated; document it in `docs/env-vars.md`, which has a parity gate against `src/`).
- When bound to a loopback address, the `Host` header must be `localhost`, `127.0.0.1` or `[::1]` with the bound port; otherwise 403. When bound to a non-loopback address, add an optional `JAIPH_SERVE_ALLOWED_HOSTS` and skip the check when unset.
- `POST /mcp` and every REST `POST` require `Content-Type: application/json` (parameters allowed), including bodyless POSTs; otherwise 415.
- `/healthz`, `/docs`, `/openapi.json` and the embedded Swagger assets keep working from the same origin. Requests with no `Origin` (curl, MCP clients) keep working.

### Acceptance

- Handler tests: `Origin: https://evil.example` on `/mcp` and on `POST /{name}` gives 403; an allowlisted origin passes; same-origin passes; no `Origin` passes.
- `Host: evil.example:5247` on a loopback bind gives 403; `localhost:<port>` and `127.0.0.1:<port>` pass.
- `Content-Type: text/plain` on `/mcp` gives 415; a bodyless `POST /{name}` without the JSON content type gives 415.
- Swagger UI "try it out" still works (existing serve tests and any docs e2e pass).
- `docs/serve.md` (or the serve section in `docs/cli.md`) documents the checks. CHANGELOG entry under Unreleased with a breaking-change note for bodyless POSTs.

## Keep the audit-chain key out of the workflow leader's environment

Completed: 2026-11-15

Source: code audit 2026-11-15. Reproduced on macOS.

### Current behavior

`jaiph run` puts `JAIPH_CHAIN_KEY` into the environment of the workflow leader (`src/cli/commands/run.ts` around line 150, `src/runtime/kernel/workflow-launch.ts`). The runtime scrubs it from script and prompt child envs, but a child of the same user can read the parent's exec-time environment: a script running `ps eww -p $PPID` (or reading `/proc/$PPID/environ` on Linux) prints `JAIPH_CHAIN_KEY=…` and the backend credentials such as `ANTHROPIC_API_KEY`.

The script also has `JAIPH_RUN_DIR`, so it can forge a journal that verifies. This contradicts `docs/artifacts.md` ("a per-run secret the audited program never sees"), `docs/architecture.md`, and `docs/env-vars.md` ("agent credentials never reaches a script").

### Required behavior

- The chain key reaches the leader the same way `--env` grant values do today (`src/runtime/kernel/env-grant-file.ts`: a `0600` file in a `mkdtemp` directory, read once at start and removed), or over an inherited pipe. It is never in any process's exec-time environment.
- All three launch paths do this: `jaiph run`, `jaiph run --raw`, and the serve/MCP launcher in `src/cli/shared/workflow-call*.ts`.
- Backend credentials: either hand them over the same way, or change the three docs pages to say plainly that a script running as the same OS user can read the leader's environment and that the credential scrub is not a security boundary without OS isolation. Pick the file handover if it is small; otherwise fix the docs and say so in the task report.

### Acceptance

- New e2e test: a script step prints the environment of `$PPID` (`ps eww` on macOS, `/proc/$PPID/environ` on Linux); output does not contain `JAIPH_CHAIN_KEY`.
- The journal of that run still verifies.
- The key file is gone after the leader starts (test asserts the path does not exist during a step).
- Docs match the chosen credential behaviour. `npm test` and `bash e2e/test_all.sh` pass. CHANGELOG entry under Unreleased.

## Kill the whole process tree on step idle-kill and prompt watchdog

Completed: 2026-11-16

Source: code audit 2026-11-15. Reproduced.

### Current behavior

`killProcessTree` in `src/runtime/kernel/portability.ts` calls `process.kill(-pid, signal)`, which works only when the child is a process-group leader. Script children (`node-workflow-runtime.ts`, the script spawn) and agent backends (`prompt-backends.ts`) are spawned without `detached: true`, so the call throws ESRCH and falls back to killing the single pid.

With `JAIPH_STEP_IDLE_KILL_SEC=1`, `script hang = 'sleep 47; echo never'` fails as expected, but `sleep 47` survives with ppid 1 after the run exits. A timed-out agent's tool subprocesses and MCP servers keep running and can keep changing the workspace. The watchdog comment "Terminate the backend and any descendants" is false on POSIX.

### Required behavior

- On POSIX, script and backend children are spawned in their own process group.
- The leader tracks those group ids. On SIGINT/SIGTERM and on run timeout it signals every live child group, so Ctrl-C behaviour stays the same (today it works only because children share the leader's group).
- Idle-kill and the prompt watchdog kill the child's whole group.
- Windows behaviour is unchanged.

### Acceptance

- Real-process test: a script backgrounds a grandchild that writes its pid to a file, then hangs; after idle-kill the grandchild pid is dead.
- Same for a fake agent backend under the prompt watchdog.
- `integration/signal-lifecycle.test.ts` still passes; add a case where SIGINT to `jaiph run` kills a grandchild of a script step.
- `npm test` and `bash e2e/test_all.sh` pass. CHANGELOG entry under Unreleased.

## Unblock a stdin pipeline when the downstream stage stops reading

Completed: 2026-11-16

Source: code audit 2026-11-15. Reproduced.

### Current behavior

In `node-workflow-runtime.ts` the script spawn tees upstream stdout into a `handoff` PassThrough and pipes it into the next stage's stdin (around lines 2343–2355 and 2411–2418). The upstream stdout is paused when `handoff` is full and resumed only on `drain`. If the consumer exits early or fails to spawn, nothing reads `handoff` and the producer blocks forever.

`const first = stdin gen() -> sink()` with `sink = 'head -c 10'` and a 5 MB producer hangs until `JAIPH_RUN_TIMEOUT`, which is unset by default, so effectively until the 3600 s idle kill. A sink whose shebang interpreter does not exist hangs the same way.

### Required behavior

- When the downstream stdin closes, errors (EPIPE) or the downstream fails to spawn, the upstream stops being back-pressured: either it keeps draining to its `.out` capture only, or its stdout is destroyed so it receives SIGPIPE. Choose one and document it in `docs/language.md` next to the `stdin` pipeline section.
- `handoff` is ended on idle-kill.
- The step result of each stage is settled exactly once.

### Acceptance

- Test: producer larger than 64 KB with a consumer that reads 10 bytes and exits; the pipeline settles within 5 seconds.
- Test: consumer with a missing interpreter; the pipeline fails within 5 seconds with the spawn error.
- Existing pipeline tests and e2e pass. CHANGELOG entry under Unreleased.

## Keep the current-def context per async branch

Completed: 2026-11-16

Source: code audit 2026-11-15. Sender misattribution reproduced.

### Current behavior

`NodeWorkflowRuntime.defCtxStack` (`node-workflow-runtime.ts`, field near line 251) is one array shared by all `async` branches. The frame stack is already isolated per branch with `AsyncLocalStorage`; this one is not. A branch's `pop()` removes whatever is on top, and "current def" is read from the top (lines near 1106, 2530, 2631).

`async fast(); async slow()` where `slow` sleeps and then sends: the receiver gets `sender="fast"` and the journal's `INBOX_ENQUEUE.sender` is `fast`. By reading, `resolveRecoverLimit` and `resolveConfigAgentModel` can apply another branch's def-level `run.recover_limit` or `agent.model`.

### Required behavior

The def context is per async branch: store it in `AsyncLocalStorage` alongside the frame stack, or carry it in `Scope`. Channel route lookup still walks the enclosing defs of the sending branch.

### Acceptance

- Test: two async defs, one slow sender; `sender` in the dispatched message and in the journal is the sending def.
- Test: two async defs with different def-level `agent.model` (and `run.recover_limit`), each interleaved with a sleep; each prompt/recover uses its own def's value (assert through the mock backend / emitted events).
- `npm test` and `bash e2e/test_all.sh` pass. CHANGELOG entry under Unreleased.

## Capture only the final answer from a multi-turn agent stream

Completed: 2026-11-16

Source: code audit 2026-11-15. Reproduced on a synthetic stream only; step 1 below confirms the real shape.

### Current behavior

`src/runtime/kernel/stream-parser.ts`: every `text_delta` is appended to `state.final` (around line 132), and the terminal `result` event is ignored once any delta was seen. For a claude stream with narration, a tool call and then the answer, the captured value is `"I'll inspect the repo first.APPROVED"`. `if verdict == "APPROVED"` is then false. `returns` schemas usually survive because `extractJson` scans from the end.

### Required behavior

1. Record a real multi-turn stream from the pinned claude CLI (`claude -p --output-format stream-json --include-partial-messages` with a prompt that forces one tool call) and commit it as a fixture under `test-fixtures/`. Do the same for cursor if its stream has turns. If the real stream shows the bug does not occur, report that and add the fixture as a regression test only.
2. The captured value is the text of the last assistant turn: prefer the terminal `result` text when the stream has one; otherwise reset `state.final` when a new assistant message starts.
3. The live progress stream still shows all turns.

### Acceptance

- `stream-parser.test.ts`: the real multi-turn fixture yields only the final turn's text.
- Single-turn fixtures are unchanged.
- `npm test` passes. CHANGELOG entry under Unreleased.

## Apply prompt timeouts to the codex backend

Completed: 2026-11-16

Source: code audit 2026-11-15. Confirmed by reading.

### Current behavior

`src/runtime/kernel/prompt-codex.ts` uses `http(s).request` with no timeout. `installPromptWatchdog` applies only to subprocess backends, so `JAIPH_PROMPT_IDLE_TIMEOUT_SECONDS` and `JAIPH_PROMPT_MAX_SECONDS` are ignored for codex. An endpoint that accepts the connection and stalls mid-stream hangs the run. `res.on("end")` returns status 0 even when `[DONE]` or a `finish_reason` never arrived.

### Required behavior

- The idle timeout resets on each received chunk and destroys the request when it fires. The max timeout is absolute. Both produce the same failure text as the subprocess backends.
- A stream that ends without `[DONE]` or a `finish_reason` is a failure.
- The run's abort signal destroys the request.

### Acceptance

- Test with a local HTTP server that sends headers and one chunk, then stalls: the prompt fails within the configured idle timeout.
- Test with a server that streams slowly forever: fails at the max timeout.
- Test with a server that closes after one chunk and no `[DONE]`: non-zero status.
- `docs/env-vars.md` rows for both variables no longer exclude codex. CHANGELOG entry under Unreleased.
