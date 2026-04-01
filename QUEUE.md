# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. When a task is completed, remove that section entirely.
4. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
5. This queue assumes **hard rewrite semantics**:
   - breaking changes are allowed,
   - backward compatibility is **not** a design goal unless a task explicitly says otherwise.

---

## Txtar compiler test format: runner + infrastructure <!-- dev-ready -->

**Goal**  
Introduce a txtar-based language-agnostic compiler test suite that verifies parse + validate outcomes. Build the test runner and define the format so subsequent tasks can extract existing tests and add new ones.

**Context**

- Compiler tests (parse errors, validation errors, successful compilation) are currently embedded in TypeScript test files as inline strings. They cannot be reused from Rust or any other implementation.
- The txtar format (used by Go's compiler test suite) stores multiple virtual files in a single text file, separated by `=== <test name>` and `--- <filename>` markers. One file per category keeps I/O minimal.
- The test runner parses the txtar file, extracts virtual `.jh` files, runs the compiler (parse + validate), and asserts the expected outcome.
- Expected outcomes are declared via `# @expect ok` (success) or `# @expect error E_CODE "substring"` (error with code and message match).

**Format spec:**

```
=== test name here
# @expect error E_PARSE "unterminated workflow block"
--- input.jh
workflow default {
  log "hello"

=== multi-file import test
# @expect error E_VALIDATE "must target a rule"
--- main.jh
import "lib.jh" as lib
workflow default {
  ensure lib.helper()
}
--- lib.jh
workflow helper {
  log "i am a workflow"
}

=== valid minimal workflow
# @expect ok
--- input.jh
workflow default {
  log "hello"
}
```

**Key files:**
- `compiler-tests/` (new directory) — test fixture files
- `compiler-tests/README.md` — format spec documentation
- `src/compiler-test-runner.ts` (new) — txtar parser + test runner, invoked via `node:test`
- `package.json` — add npm script to run compiler tests

**Scope**

1. Create `compiler-tests/` directory.
2. Write `compiler-tests/README.md` documenting the txtar format: `===` delimiter, `---` file markers, `# @expect` syntax, single-file vs multi-file conventions.
3. Implement `src/compiler-test-runner.ts`:
   - Parse txtar format: split on `=== `, extract test name, `# @expect` line, and virtual files (split on `--- filename`).
   - For each test case: write virtual files to a temp directory, run `parsejaiph` + `validateReferences` on the entry file (`input.jh` or `main.jh`).
   - Assert: `ok` → no error thrown; `error CODE "substring"` → error thrown, message contains code and substring.
   - Report pass/fail per test case with the test name.
4. Add a seed fixture file `compiler-tests/valid.txt` with 5-10 success cases covering basic constructs (workflow, rule, script, import, config, match, inline script).
5. Add a seed fixture file `compiler-tests/parse-errors.txt` with 5-10 parse error cases.
6. Add npm script `"test:compiler"` that runs the compiler test runner.
7. Wire into CI (add to `npm test` or as a separate step).

**Acceptance criteria**

- `npm run test:compiler` reads txtar files from `compiler-tests/`, runs all cases, reports pass/fail.
- Multi-file test cases (imports) work correctly via temp directory isolation.
- Seed fixtures pass. At least one intentionally wrong expectation is verified to fail (meta-test).
- Format is documented in `compiler-tests/README.md`.

---

## Extract existing compiler tests to txtar format <!-- dev-ready -->

**Goal**  
Migrate all compiler test cases from TypeScript test files into the txtar fixture format so they are language-agnostic and reusable.

**Context**

- The txtar runner and format are established (previous task).
- There are ~548 existing compiler tests across `src/parse/*.test.ts`, `src/transpile/*.test.ts`, and `test/sample-build.test.ts`. Not all are suitable for extraction — only tests that verify "source → parse/validate → success or error" qualify. Tests that check AST structure or internal APIs stay in TypeScript.
- Target: extract every test that uses `assert.throws` with a source string + error pattern, and every golden/acceptance test that compiles a source string successfully.
- After extraction, the original TypeScript tests that are now covered by txtar fixtures can be removed to avoid duplication, OR kept as-is if they test internal API details beyond pass/fail.

**Source files to extract from:**

- `src/parse/parse-core.test.ts` — `stripQuotes` etc. (internal API, skip most; extract any `parsejaiph` calls)
- `src/parse/parse-metadata.test.ts` — config block error cases (extract ~10 error cases)
- `src/parse/parse-const-rhs.test.ts` — const RHS rejections (extract ~16 error cases)
- `src/parse/parse-definitions.test.ts` — declaration syntax errors (extract ~12 error cases)
- `src/parse/parse-steps.test.ts` — ensure/recover errors (extract ~5 error cases)
- `src/parse/parse-prompt.test.ts` — prompt parsing errors (extract ~6 error cases)
- `src/parse/parse-env.test.ts` — env declaration errors (extract ~7 error cases)
- `src/parse/parse-interpreter-tags.test.ts` — tag errors (extract ~4 error cases)
- `src/parse/parse-return.test.ts` — return parsing (extract ~10 success cases)
- `src/parse/parse-channels.test.ts` — channel errors (extract ~5 error cases)
- `src/parse/parse-inline-script.test.ts` — inline script errors (extract ~2 error cases)
- `src/parse/parse-imports.test.ts` — import errors (extract ~4 error cases)
- `src/parse/parse-run-async.test.ts` — run async errors (extract ~1 error case)
- `src/parse/parse-send-rhs.test.ts` — send RHS errors (extract ~5 error cases)
- `src/parse/parse-tests.test.ts` — test block errors (extract ~4 error cases)
- `src/transpile/compiler-golden.test.ts` — golden regressions (extract ~19 error cases, ~37 success cases)
- `src/transpile/compiler-edge.acceptance.test.ts` — cross-module cases (extract ~25 error cases, ~9 success cases)
- `src/transpile/validate-string.test.ts` — string interpolation errors (extract ~23 error cases)
- `src/transpile/shell-jaiph-guard.test.ts` — shell keyword guards (extract ~15 error cases)
- `src/transpile/validate-ref-resolution.test.ts` — ref resolution errors (extract ~16 error cases)
- `src/transpile/validate-prompt-schema.test.ts` — schema errors (extract ~7 error cases)
- `src/transpile/validate-managed-calls.test.ts` — managed call errors (extract ~5 error cases)
- `src/transpile/validate-run-async.test.ts` — run async in rules (extract ~1 error case)

**Target fixture files:**

- `compiler-tests/parse-errors.txt` — all E_PARSE error cases
- `compiler-tests/validate-errors.txt` — all E_VALIDATE / E_IMPORT_NOT_FOUND / E_SCHEMA error cases
- `compiler-tests/valid.txt` — all success cases (source compiles without error)
- `compiler-tests/valid-multi-module.txt` — success cases requiring imports (multi-file)
- `compiler-tests/validate-errors-multi-module.txt` — validation errors requiring imports

**Scope**

1. Read each source test file listed above. For each test case that calls `parsejaiph(source, ...)` followed by `assert.throws` or successful compilation, extract the source string and expected outcome.
2. Write the extracted cases into the appropriate txtar fixture file.
3. Run `npm run test:compiler` to verify all extracted cases pass.
4. Do NOT delete the original TypeScript tests yet — that's a separate cleanup decision.

**Acceptance criteria**

- All extracted cases pass via `npm run test:compiler`.
- At least 200 test cases are extracted (estimated: ~200 error cases + ~50 success cases).
- Fixture files are organized by error type and single-vs-multi-module.
- No regressions in existing `npm test`.

---

## Add untested compiler error paths to txtar fixtures <!-- dev-ready -->

**Goal**  
Write new txtar test cases for the ~35 compiler error paths that currently have zero test coverage.

**Context**

- The compiler test coverage audit identified ~35 `fail()` / `jaiphError()` calls with no test coverage (see list below).
- These are all parse-time or validation-time error paths that should produce specific error codes and messages.
- With the txtar infrastructure in place, adding these is straightforward: one `=== test name` block per untested path.

**Untested error paths to cover:**

Parse errors (`compiler-tests/parse-errors.txt`):
- `match.ts`: unterminated string in pattern, unterminated regex, empty regex, invalid regex, empty arm body, unterminated arm string, single-quoted pattern, single-quoted arm body, missing `=>` arrow (9 cases)
- `workflows.ts`: config block must appear before steps, calls require parentheses for run async, log/logerr format errors (4 variants), invalid workflow reference in route (7 cases)
- `workflow-brace.ts`: expected "else {", else body on same line, wait in rules, prompt in rules, send in rules, run async capture in brace, malformed else-if (3 variants) (10 cases)
- `scripts.ts`: unterminated script block, script command required (2 cases)
- `metadata.ts`: single-quoted array element, unquoted array element, unclosed array (3 cases)
- `tests.ts`: unterminated test block, mock function deprecated (2 cases)
- `send-rhs.ts`: unterminated `${...}`, `$(...)` inside `${...}` (2 cases)
- `inline-script.ts`: unexpected content after inline script, unterminated parens (2 cases)

Validation errors (`compiler-tests/validate-errors.txt`):
- `validate.ts`: match exactly one wildcard arm (missing), match multiple wildcards, dot-field not a typed prompt, dot-field unknown field, ensure recover in rules (validate layer), const prompt in rules (validate layer) (6 cases)

**Scope**

1. For each untested path listed above, write a minimal `.jh` source that triggers that specific error.
2. Add the `=== test name` block with `# @expect error E_CODE "message substring"` to the appropriate txtar file.
3. Run `npm run test:compiler` to verify all new cases pass (the compiler produces the expected error).
4. If any error path is unreachable (dead code), document it with a `# NOTE: unreachable` comment and skip.

**Acceptance criteria**

- All ~35 previously untested error paths now have txtar test cases.
- `npm run test:compiler` passes with the new cases.
- Compiler error path coverage reaches ~95%+ (up from ~80%).

---
