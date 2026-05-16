# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. When a task is completed, remove that section entirely.
4. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
5. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
6. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Replace fail-fast errors with a Diagnostics collector that aggregates per compile #dev-ready

**Design reference:** `design/2026-05-15-parser-compiler-simplification.md` § Appendix B.

**Why:** Today `fail()` (in `src/parse/core.ts`) and `jaiphError()` (in `src/errors.ts`) both throw on the first error. Users fix one error, recompile, fix the next, recompile. The validator also pre-orders some checks defensively because it knows it will only get to surface one error. A diagnostics collector lets the parser and validator append errors and the run report the full set at the end.

**Scope:**

- Introduce `class Diagnostics { errors: JaiphDiagnostic[]; add(...); hasFatal(): boolean; report(): never | void }` (or equivalent).
- Parser and validator append diagnostics instead of throwing for non-fatal errors. A "fatal" tier remains for cases where continuing would produce garbage AST (unterminated triple-quote, unterminated brace block).
- At the end of a compile, `Diagnostics.report()` either prints all collected errors sorted by file/line and exits non-zero, or returns cleanly. The CLI surfaces the full set instead of just the first.
- Existing call sites of `fail()` / `jaiphError()` migrate to `diagnostics.add(...)` where the error is recoverable.

**Acceptance criteria** (each verified by a test):

1. A fixture containing **N ≥ 3 independent errors** (e.g. an undefined channel, a duplicate import alias, and an unknown ref in a `run` call) reports all N errors in one compile, not just the first. Add a test that asserts the full set is reported in source order.
2. The existing single-error tests still pass: every `parse-*.test.ts` and `validate-*.test.ts` fixture that asserts a specific `{ message, line, col, code }` still gets exactly that error (now the only one in `Diagnostics`).
3. `fail()` and `jaiphError()` throwing call-sites are reduced to a documented "fatal" subset (count it in the test). Non-fatal call-sites use the collector.
4. CLI exit code on any non-empty `Diagnostics` is non-zero. Add an `e2e` or CLI test.
5. `npm test` and `npm run build` pass.

**Out of scope:** changing what counts as an error (the *what*) — this refactor only changes the *how*. LSP integration (a follow-up).

**Dependency:** None hard, but cheapest to do immediately before the visitor-table validator refactor (next task), since the new visitor's per-step entry/exit is the natural place to plug in the collector.

***

## Replace the 1,441-line validator switch with a per-step visitor table indexed by scope #dev-ready

**Design reference:** `design/2026-05-15-parser-compiler-simplification.md` § Refactor 4.

**Why:** `src/transpile/validate.ts` is one function with two near-identical inner walkers (`validateRuleStep` ~250 lines, `validateStep` ~350 lines). Each step type's validation is written twice with subtle differences, and the 5-check sequence (`validateNoShellRedirection` → `validateNestedManagedCallArgs` → `validateRef` → `validateArity` → `validateBareIdentifierArgs`) is repeated by hand at 6+ sites per side — at least 12 places to keep in sync.

**Scope:**

- Replace the two inner walkers with a single AST visitor parameterized by a `Scope` value:
  - `Scope` carries `allow: Set<StepType>`, `refSpec: RefSpec`, and any other rule-vs-workflow differences.
  - A `VALIDATORS: Record<StepType, Validator>` table holds one validator per step type, written once.
  - `validateCallStep("run" | "ensure")` is a single helper invoked by both `run` and `ensure` validators with different ref-spec / arity-kind arguments.
- The 5-check sequence is encapsulated in one helper (`validateManagedCallShape` or similar) invoked from each call-bearing validator.
- "Is this step allowed in this scope?" becomes a single set-lookup at the top of the visitor, not three throw sites.
- All existing error messages and error codes (`E_VALIDATE`, etc.) are preserved verbatim — both content and source location (line/col) must match what users see today.

**Acceptance criteria** (each verified by a test):

1. `src/transpile/validate.ts` is at most 700 lines (down from 1,441). Add a CI check (or test) that fails if it exceeds the bound.
2. `validateReferences` contains exactly one step-walking function. A grep test fails if a second walker is introduced.
3. Every `E_VALIDATE` error message and error location produced today is produced bit-for-bit by the new code. Add a snapshot-style test over every `validate-*.test.ts` fixture asserting `{ message, line, col, code }` matches the pre-refactor output.
4. Adding a new step type requires adding exactly one row to `VALIDATORS` and (if needed) updating the `Scope.allow` sets. Add a test that introduces a synthetic step type behind a test-only flag and asserts the validator rejects it with a single expected message until the row is added.
5. `npm test` passes (all of `validate-immutable-bindings.test.ts`, `validate-managed-calls.test.ts`, `validate-match.test.ts`, `validate-prompt-schema.test.ts`, `validate-ref-resolution.test.ts`, `validate-run-async.test.ts`, `validate-string.test.ts`, `validate-substitution.test.ts`, `validate-type-crossing.test.ts`, plus the golden corpus).

**Out of scope:** changes to validation rules (the *what*) — this refactor only changes the *how*. Parser changes. AST changes (Refactor 3 must already be merged).

**Dependency:** Refactor 3 (Expr collapse) and the single-pass-walk + Diagnostics tasks (previous two) must be complete first; otherwise the new visitor still needs to special-case the `managed:` sidecar and the pre-pass-walker pattern.

***

## Decouple the validator from runtime semantics #dev-ready

**Design reference:** `design/2026-05-15-parser-compiler-simplification.md` § Appendix E.

**Why:** `src/transpile/validate.ts` imports `tripleQuotedRawForRuntime` from `src/runtime/orchestration-text.ts` so it can compute "what the runtime will see" when validating string content. That is a one-way dependency from compile-time on runtime semantics — a layering inversion that will keep biting if the runtime grows more such helpers.

**Scope:**

- Move the canonicalization of triple-quoted strings (currently `tripleQuotedRawForRuntime`) into a parser-side helper (e.g. `src/parse/triple-quote.ts:canonicalizeTripleQuotedString`).
- The validator imports from `src/parse/`, not `src/runtime/`.
- The runtime, if it still needs the same canonical form at runtime, imports from `src/parse/` as well (or the canonical form is baked in at compile time by the emitter).
- Any other `validate*.ts → runtime/*` imports get the same treatment.

**Acceptance criteria** (each verified by a test):

1. No file under `src/transpile/` imports from `src/runtime/`. A grep test fails if any such import appears.
2. The canonical string for every triple-quoted form in `test-fixtures/` and `examples/` is bit-for-bit unchanged before and after the move. A test compares pre/post output for every fixture.
3. `npm test` passes, including the golden corpus and all `validate-string.test.ts` cases.
4. `npm run build` passes; TypeScript strict-mode errors are zero.

**Out of scope:** rethinking what the canonical form *is*. This refactor only relocates the helper.

**Dependency:** None.

***

## Unify `catch` and `recover` parsing into a single attached-block routine #dev-ready

**Design reference:** `design/2026-05-15-parser-compiler-simplification.md` § Refactor 2.

**Why:** `src/parse/steps.ts` contains three near-identical 100+ line functions — `parseEnsureStep`, `parseRunCatchStep`, `parseRunRecoverStep` — that parse the same syntactic shape (`<host-step> <keyword> (binding) { body } | single-stmt`) and differ only in which host step they decorate and the literal keyword. Their body parser, `parseCatchStatement` (~280 lines), re-implements a stripped-down version of `parseBlockStatement` with diverging coverage.

**Scope:**

- Replace `parseEnsureStep`, `parseRunCatchStep`, `parseRunRecoverStep`, and `parseCatchStatement` with:
  - `parseAttachedBlock(keyword: "catch" | "recover", host: WorkflowStepDef)` returning `{ bindings, body: WorkflowStepDef[] }`.
  - A body parsed by the **same** `parseBlockStatement` used at the top level — no mini parser.
- All four functions and any helpers that exist only to serve them are deleted from `src/parse/steps.ts`.
- "Is this statement allowed inside a catch/recover body?" is a validator concern after this refactor, not enforced by which mini-parser branches happen to fire.

**Acceptance criteria** (each verified by a test):

1. `src/parse/steps.ts` is at most 200 lines (down from 757), and contains no function whose name matches `/parse(Run)?(Catch|Recover|EnsureStep)/`. A grep/size test fails if either bound is violated.
2. `parseBlockStatement` is the single entry point for any statement appearing inside a catch or recover body. Add a test that introduces a new statement form (behind a test-only flag) and asserts it is accepted identically at top level and inside `catch (e) { … }` and `recover(e) { … }` without parser changes inside the catch/recover code path.
3. Every existing parse error message and location related to `catch` / `recover` (bindings missing, too many bindings, unterminated block, etc.) is preserved bit-for-bit. Snapshot test over `parse-*.test.ts` fixtures.
4. The full parser/validator/emitter golden corpus passes byte-for-byte: `npm test`, including `parse-steps.test.ts`, `parse-bare-call.test.ts`, `parse-run-async.test.ts`, `compiler-golden.test.ts`, `compiler-edge.acceptance.test.ts`.

**Out of scope:** the wider tokenizer rewrite (next task) — this task explicitly stays on the line-walking parser, since the goal is incremental simplification. Validator changes beyond minor message preservation.

**Dependency:** Refactor 3 (AST collapse) should be complete first so the unified parser emits `Expr` nodes directly. If it is not, this task may proceed but must avoid introducing new producers of the deprecated `managed:` sidecar.

***

## Replace the line-by-line ad-hoc parser with a tokenizer + recursive-descent parser #dev-ready

**Design reference:** `design/2026-05-15-parser-compiler-simplification.md` § Refactor 1.

**Why:** The current parser walks `lines: string[]`, returns `{ step, nextIdx }` from every routine, and dispatches statements via a long cascade of `startsWith` + regex in `parseBlockStatement` (`src/parse/workflow-brace.ts:102-615`). Order matters — `"run async "` before `"run "`, etc. Quote/triple-quote/backtick/fence/brace state is re-implemented from scratch in at least seven independent scanners across `src/parse/`. Adding a new keyword or fixing a string-aware scanner means changes in multiple places.

**Scope:**

- Introduce a tokenizer (`src/parse/tokenize.ts` or similar) that owns *all* scanning state: identifiers, keywords, string literals (single + triple-quoted), backtick bodies, fenced code blocks, line comments, braces, parens, the send arrow `<-`, the match arm arrow `=>`, etc.
- Introduce a recursive-descent parser that consumes the token stream and dispatches via a `STATEMENT: Record<Keyword, StatementParser>` table.
- All ad-hoc scanners in `src/parse/` are deleted: `splitCatchStatements` (if still present), `splitStatementsOnSemicolons`, `matchSendOperator`, `hasUnquotedSendArrow`, `indexOfClosingDoubleQuote`, `stripQuotedArgContent`, `parseSendRhs`'s internal scanner, and any `inDoubleQuote` / `inTripleQuote` / `braceDepth` state machines outside the tokenizer.
- Surface syntax is unchanged. Error messages and error locations are preserved bit-for-bit where the existing tests assert them, and at minimum match in `code` + `line` + `col` everywhere else.
- Staging: it is acceptable (and recommended) to land the new parser behind a flag, run both parsers on the golden corpus in CI, diff their ASTs, and remove the old parser only once the diff is empty.

**Acceptance criteria** (each verified by a test):

1. `src/parse/` is at most 4,000 lines total (down from ~8,150), excluding test files. A CI check fails if exceeded.
2. The substrings `inDoubleQuote`, `inTripleQuote`, `braceDepth` appear only inside the tokenizer module. A grep test fails if any of those state-tracking idioms appear in other files under `src/parse/` or `src/transpile/`.
3. `parseBlockStatement` (or whatever the equivalent dispatcher is in the new parser) dispatches via a table, not a cascade. The size of any single function in `src/parse/` is bounded — no function exceeds 120 lines. A test computing function lengths fails if exceeded.
4. Every existing parse-error location and message asserted by `src/parse/parse-*.test.ts` matches verbatim. Add a snapshot test that re-emits `{ code, message, line, col }` for every error fixture and fails on any diff.
5. Adding a new top-level keyword (e.g. a synthetic `noop` for the test) requires changes in exactly two files (the tokenizer's keyword set + the `STATEMENT` table). A test introduces a synthetic keyword behind a flag and asserts it parses without touching any other file.
6. The full golden corpus passes byte-for-byte: `npm test`, including `compiler-golden.test.ts`, `compiler-edge.acceptance.test.ts`, all `parse-*.test.ts` files, and the formatter round-trip tests.
7. `npm run build` passes; TypeScript strict-mode errors are zero.

**Out of scope:** adopting a parser generator (the grammar is small and the line-oriented language sensibility maps cleanly to a hand-written tokenizer). Surface syntax changes. Runtime / `runtime/` changes.

**Dependency:** All previous tasks (Refactors 5, 3, 4, 2 plus all five appendix tasks) should be complete first so the new parser only has to target one AST shape and the validator does not need to special-case parser quirks during the transition.

***
