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

## Remove the line-based parser helpers #dev-ready #in-progress

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
