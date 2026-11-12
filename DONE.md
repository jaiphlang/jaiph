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
