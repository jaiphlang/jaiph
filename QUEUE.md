# Jaiph Improvement Queue (Hard Rewrite Track)

This file is a generated view. Do not edit it. Do not agent-edit it.
Use the product-owner defs (`propose_task`, `update_task`, `pick_task`,
`report_completed_task`, `task_details`) via `jaiph serve` / MCP.

Process rules:

1. `pick_task` prefers the first `#dev-ready` task that is not `#in-progress`.
   The product owner may claim a later available task instead.
2. The first `##` section is the preferred next task in this view.
3. `#dev-ready` means ready to implement. `#in-progress` means claimed by `pick_task`.
4. Runtime mutations go through the product-owner defs only.
5. Every task must be standalone: no hidden assumptions, no "read prior task".
6. Hard rewrite semantics: breaking changes are allowed unless a task says otherwise.
7. Acceptance criteria are non-negotiable. A task is not done until every
   acceptance bullet is verified by a test that fails when the contract is violated.

## Parse match arms and statement operands from tokens #dev-ready #in-progress

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

Prerequisite: def bodies, top-level declarations, strings, and call arguments are all parsed from `tokenize()` in `src/parse/lexer.ts`. If any parser module still scans raw lines, this task is blocked.

### Required

- Delete every helper that only served line-based parsing: string-prefix detectors (`startsInlineScript`, `startsTaggedScriptFence`, `splitScriptLangPrefix`, `looksLikeInlineScriptCall` if still present), quote scanners (`indexOfClosingDoubleQuote`, `hasUnescapedClosingQuote`), `src/parse/statement-split.ts` if unused, and anything `ts-prune`-style dead after the migration. Keep functions the runtime or validator still import through `src/parser.ts`.
- Update `docs/architecture.md` (parser section) to describe the tokenizer and the cursor-based parsers, and remove references to deleted helpers. `docs/agent-analyzability.md` parse row stays accurate.

### Acceptance

- No file under `src/parse/` reads `.split("\n")` lines for parsing except `tokenize()`.
- Golden ASTs, compiler fixtures, and `integration/format-roundtrip.test.ts` are unchanged.
- `npm test`, `npm run lint`, `npm run arch:check`, and `bash e2e/test_all.sh` pass. Add a CHANGELOG entry under Unreleased.
