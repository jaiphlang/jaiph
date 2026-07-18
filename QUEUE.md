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
