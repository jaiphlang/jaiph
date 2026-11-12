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

## Parse match arm bodies against an explicit grammar #dev-ready

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

## Add a Jaiph tokenizer (parser not wired yet) #dev-ready

The parser reads `.jh` source line by line with `startsWith` checks and ad hoc quote scanners (`indexOfClosingDoubleQuote`, `hasUnescapedClosingQuote` in `src/parse/core.ts`, the scanners in `src/parse/call-args.ts`, `src/parse/statement-split.ts`, `src/parse/nested-arg.ts`). This task adds a standalone tokenizer. It does not change the parser; later tasks move the parser onto it.

### Required

Add `src/parse/lexer.ts` exporting `tokenize(source: string, filePath: string): Token[]`. Every token has `kind`, `text` (the exact source slice), `line`, and `col` (1-based). Kinds:

| Kind | Source |
|---|---|
| `ident` | `[A-Za-z_][A-Za-z0-9_]*` (keywords are idents; the parser decides) |
| `string` | single-line `"…"`; `\"` is the only escape |
| `triple_string` | `"""` … `"""` block (opening `"""` ends its line) |
| `script_oneline` | `'…'` with an optional interpreter tag touching the quote (`python3'…'`); no escapes, first `'` closes |
| `script_fenced` | `'''` … `'''` with an optional tag before the opening quotes (`node'''`); closer is a trimmed line starting with `'''` |
| `number` | `[0-9]+` |
| `regex` | `/…/` in match-pattern position only (after `match … {`, or after the pattern-alternation bar inside a match block) |
| `punct` | `( ) { } , = . => ->`, the pattern-alternation bar, and `==` / `!=` |
| `newline`, `comment` (`#` to end of line) | |

Tags follow `[A-Za-z_][A-Za-z0-9_.-]*`. A tag separated from the quote by whitespace is an `ident` followed by a script token. `${…}` inside a string stays part of the `string` token. Removed forms keep their current errors: triple backticks and one-line backticks are `E_PARSE` with the messages in `src/parse/fence.ts`.

### Acceptance

- Unit tests in `src/parse/lexer.test.ts` cover every kind, tags with `.` and `-`, `\"` inside strings, an apostrophe inside a string (`"it's"`), and unterminated string / block errors (`E_PARSE` with line and column).
- Lossless: for every source collected by `integration/format-roundtrip.test.ts` (tracked `.jh` files, compiler-txtar valid inputs, e2e heredocs, docs code blocks) that parses today, concatenating `text` of all tokens plus the skipped whitespace reproduces the source exactly. Add this as a test.
- The tokenizer is not imported by any parser module yet. `npm test`, `npm run lint`, and `npm run arch:check` pass.

## Parse strings and call arguments from tokens

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

Note for implementer: `src/parse/lexer.ts` does not currently exist in the repo. This task stays blocked until that tokenizer module lands.

## Dispatch def-body statements from tokens

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

Prerequisite: `src/parse/lexer.ts` exports `tokenize()` (line/column tokens for strings, `"""` blocks, one-line and fenced scripts with interpreter tags, idents, punctuation). If it does not exist, this task is blocked.

Top-level declarations are parsed line by line: `src/parse/parse-module.ts` dispatches each line, and `scripts.ts`, `env.ts`, `imports.ts`, `channels.ts`, `metadata.ts` (`config { … }`), `prompt-def.ts`, and `tests.ts` (`*.test.jh` blocks) each re-scan raw text with their own regexes.

### Required

- Every top-level declaration is parsed from a token cursor: `import`, `import script`, `channel` and routes, `config { … }`, `const`, `script` (with `use` clause and interpreter tag), `prompt` definitions, `def` / `export def` headers, and `test "…" { … }` blocks with their DSL statements.
- Config values keep their rules: `\"` is the only escape; `\n`, `\t`, `\\` are `E_PARSE` with the existing migration message (`rejectRemovedEscapes` in `src/parse/core.ts`).
- The AST and trivia are unchanged, including `ConfigBodyPart.bareSource` and `EnvDeclDef.tripleQuoted`.

### Acceptance

- Golden ASTs, `test-fixtures/compiler-txtar/parse-errors-snapshot.json` (no snapshot update needed), compiler fixtures, and `integration/format-roundtrip.test.ts` are unchanged.
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
