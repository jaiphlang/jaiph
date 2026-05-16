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
