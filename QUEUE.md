# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, remove that section entirely.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Feat: `else if` chaining sugar for workflow `if` statements #dev-ready

**Problem:** Multi-way branching today requires nested `if` inside `else` or switching to `match`. The parser explicitly rejects `} else if cond {` with `E_PARSE` (`"else if" chaining is not supported"`). This is the main ergonomic gap for imperative two-or-more-way branches that should stay statements (not value-producing `match`).

**Required behavior:**

* Accept `} else if <subject> <op> <operand> { … }` chains after an `if` body, with the same condition grammar as a top-level `if` (`==`, `!=`, `=~`, `!~`; string or regex operand; bare `IDENT` or `IDENT.IDENT` subject).
* Allow arbitrary depth: `if … { } else if … { } else if … { } else { }`.
* `} else {` same-line rule unchanged; only the `else if` token sequence is new sugar.
* Desugar to nested `if`/`else` at parse time (no new runtime step type). AST shape should match what a human-written nested tree would produce so existing runtime paths keep working.
* `else if` remains **statement-only** — no value production; `const x = if …` stays invalid.
* Invalid forms stay `E_PARSE`: `else if` without preceding `if`, `else if` on its own line (if that violates the existing `} else {` same-line invariant — document the chosen rule), empty `else if` body.

**Implementation sketch:**

* `src/parse/workflow-brace.ts` — replace the `else if` rejection in `parseBlockSteps` / `tryParseIf` with a loop or recursive descent that consumes `else if` arms then optional final `else`.
* `src/format/emit.ts` — emit `else if` when the nested AST matches the sugar shape (round-trip test).
* `docs/grammar.md` and `docs/language.md` — document `else if` chains; remove “not supported” wording.

Acceptance:

* `jaiph compile` accepts a workflow with `if a == "x" { … } else if a == "y" { … } else { … }` and a rule with the same shape.
* **E2E** `e2e/tests/NNN_if_else_if_chain.sh`: three-arm chain executes exactly one branch; full stdout tree via `e2e::expect_stdout`.
* **Parser unit test** in `src/parse/parse-steps.test.ts` (or sibling): `else if` chain AST equals manually nested `if`/`else` equivalent.
* **Negative parse test:** `} \n else if` or malformed `else if` without condition still yields `E_PARSE`.
* **Golden AST** fixture `test-fixtures/golden-ast/fixtures/if-else-if.jh` + expected JSON updated.
* `jaiph format` round-trips an `else if` chain without rewriting it into nested form (or documents intentional normalization — prefer preserving `else if` when author wrote it).
* `npm test` and `npm run test:e2e` pass.

***

## Feat: match pattern alternation (`"a" | "b" => …`) #dev-ready

**Problem:** CLI dispatch and enum-style branching duplicate `match` arms (`"" => …` and `"check" => …` running the same body). The grammar allows only one pattern per arm: string literal, regex, or `_`.

**Required behavior:**

* Accept alternation in `match` patterns: `"foo" | "bar" | "baz" => body` — pipe-separated string literals and/or regexes on one arm.
* Matching semantics: arm matches if **any** alternand matches (OR). Evaluation order left-to-right; first matching arm in the `match` block still wins (existing arm order rules).
* Wildcard `_` cannot participate in alternation (`_" | "x"` → `E_PARSE`).
* Regex alternation allowed: `/^a/ | /^b/` on one arm.
* **Do not** mix string and regex in one alternation arm in v1 unless trivial to implement — if unsupported, `E_PARSE` with a clear message (document the rule). Prefer allowing both if the matcher already dispatches on kind per alternand.
* Expression form unchanged: `const x = match v { "a" | "b" => "ok" _ => "no" }`.

**Implementation sketch:**

* Extend `MatchPatternDef` in `src/types` with `{ kind: "alternation"; patterns: MatchPatternDef[] }` or flatten to multiple arms at parse time (prefer explicit alternation node for formatter round-trip).
* `src/parse/match.ts` — parse `"a" | "b"` after first pattern before `=>`.
* `src/runtime/kernel/node-workflow-runtime.ts` — evaluate alternation arms (or expand at parse time).
* `src/format/emit.ts` — print alternation with ` | ` between patterns.
* `docs/grammar.md` — extend `match_pattern` production.

Acceptance:

* `jaiph compile` accepts `match cmd { "" | "check" => run foo() "wait" => run bar() _ => fail "bad" }`.
* **E2E** `e2e/tests/NNN_match_alternation.sh`: subject `"check"` and `""` hit the same arm; different subject hits another arm; full stdout equality.
* **Unit tests** `src/parse/parse-match.test.ts`: parse alternation pattern; reject `"a" | _`; reject trailing `|`.
* **Runtime unit test** (or e2e-only if sufficient): alternation arm with two string literals matches both values identically.
* **Golden AST** fixture `test-fixtures/golden-ast/fixtures/match-alternation.jh` + expected JSON.
* `jaiph format` preserves `"a" | "b" =>` on one line.
* `npm test` and `npm run test:e2e` pass.

***
