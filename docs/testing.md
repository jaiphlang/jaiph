---
title: Testing
permalink: /testing
redirect_from:
  - /testing.md
---

# Testing Jaiph Workflows

Jaiph includes a built-in test harness for workflow testing. Test files (`*.test.jh`) let you mock prompt responses, stub workflows, rules, and scripts, run workflows through the same Node runtime used by `jaiph run`, and assert on captured output — all without calling real LLMs or depending on external state.

Workflow runs combine prompts, shell commands, and orchestration logic. Without a harness, outcomes depend on live models, timing, and the host machine — making regressions hard to catch in CI or during refactors. The test harness solves this by giving you fixed prompt responses, in-process execution, and deterministic assertions.

## File naming and layout

Test files use the `.test.jh` suffix (for example `workflow_greeting.test.jh`).

A test file supports the same top-level forms as any `.jh` file (`import`, `config`, `workflow`, etc.), but the CLI only executes `test "..." { ... }` blocks. Other declarations are parsed into the runtime graph — for example, a local `workflow` is visible to single-segment references.

**Recommended style:** keep test files to `import` statements and `test` blocks. Define the workflows under test in separate modules so files stay small and focused.

Import paths in `import "..." as alias` resolve relative to the test file's directory, with the same extension handling as ordinary modules (`.jh` is appended when omitted). See [Grammar — Lexical notes](grammar.md#lexical-notes).

## Running tests

```bash
# All *.test.jh files under the detected workspace root (recursive)
jaiph test

# All tests under a directory (recursive)
jaiph test ./e2e

# One file
jaiph test ./e2e/workflow_greeting.test.jh

# Equivalent shorthand (a *.test.jh path is treated as jaiph test)
jaiph ./e2e/workflow_greeting.test.jh
```

**Discovery:** `jaiph test` walks the given directory recursively, or the workspace root when no path is passed. The workspace root is found by walking up from the current directory until a `.jaiph` or `.git` directory exists; if neither is found, the current directory is used.

If no `*.test.jh` files are found, the command prints an error and exits with status 1. A file must contain at least one `test` block; otherwise the CLI reports a parse error. Passing a plain `*.jh` file that is not named `*.test.jh` is rejected — use `jaiph run` for those.

## Test block syntax

Each `test` block is a named test case containing ordered steps:

```jaiph
import "workflow_greeting.jh" as w

test "runs happy path and prints PASS" {
  mock prompt "e2e-greeting-mock"
  const response = run w.default()
  expect_contain response "e2e-greeting-mock"
  expect_contain response "done"
}
```

Inside a test block, steps execute in order. The following step types are available.

### Mock prompt (inline)

Queues a fixed response for the next `prompt` call in the workflow under test. Multiple `mock prompt` lines queue in order — one is consumed per `prompt` call.

```jaiph
mock prompt "hello from mock"
mock prompt "second response"
```

The response must be a double-quoted string. Standard escape sequences (`\"`, `\n`, `\\`) work inside double-quoted strings.

### Mock prompt (content-based dispatch)

Dispatches different responses based on the prompt text using pattern matching. Arms are tested top-to-bottom; the first match wins.

```jaiph
mock prompt {
  /greeting/ => "hello"
  /farewell/ => "goodbye"
  _ => "default response"
}
```

Each arm is `pattern => "response"`. Patterns can be:

- **String literal** (`"greeting"`) — exact match against the prompt text
- **Regex** (`/greeting/`) — tested against the prompt text
- **Wildcard** (`_`) — matches anything (like a default/else branch)

Without a `_` wildcard arm, an unmatched prompt fails the test.

Do not combine `mock prompt { ... }` with inline `mock prompt "..."` in the same test block — when a block mock is present, inline queue entries are ignored.

### Mock workflow

Replaces a workflow body for this test case with Jaiph steps:

```jaiph
mock workflow w.greet() {
  return "stubbed greeting"
}
```

The reference format is `<alias>.<workflow>` (preferred) or `<name>` for a workflow defined in the test file itself.

### Mock rule

Same as mock workflow, but for rules (body uses Jaiph steps, not shell):

```jaiph
mock rule w.validate() {
  return "stubbed validation"
}
```

### Mock script

Stubs a module `script` block:

```jaiph
mock script w.helper() {
  echo "stubbed script"
}
```

Test stubs use `mock script`, not `mock function`; the latter is a parse error with a fix hint.

### Workflow run (with capture)

Runs a workflow and captures its output into a variable:

```jaiph
const response = run w.default()
```

**Capture semantics** match production behavior:

1. If the workflow exits 0 with a non-empty explicit `return` value, that string is captured.
2. If the workflow fails (non-zero exit), the runtime error string is captured (when present).
3. Otherwise, the harness reads all `*.out` files in the run directory sorted by filename, or falls back to the runtime's aggregated output.

The test fails on non-zero exit unless `allow_failure` is specified.

**Variants:**

```jaiph
# With an argument
const response = run w.default("my input")

# Allow failure
const response = run w.default() allow_failure

# With argument and allow failure
const response = run w.default("my input") allow_failure
```

### Workflow run (no capture)

Runs a workflow without storing output. Still fails on non-zero exit unless `allow_failure` is appended:

```jaiph
run w.setup()
run w.setup("arg")
run w.setup() allow_failure
```

### Assertions

After capturing workflow output, use these to check the result:

```jaiph
expect_contain response "expected substring"
expect_not_contain response "unwanted text"
expect_equal response "exact expected value"
```

Expected strings must be double-quoted. Escape `"` inside the string with `\"`. Failures print expected vs. actual previews.

## Typed prompts

When a workflow uses typed prompts (`returns "{ ... }"`), mock text must be a single line of valid JSON matching the schema so that parsing and field variables work correctly. Fields are accessed with dot notation — `${result.field}` — in `log`, `return`, and other interpolation contexts. See `e2e/prompt_returns_run_capture.test.jh` and `e2e/dot_notation.test.jh` for examples.

## Pass/fail reporting

Each test block runs in isolation. Assertions, shell errors, or a workflow exiting non-zero (without `allow_failure`) mark that case as failed.

The runner output looks like:

```
testing workflow_greeting.test.jh
  ▸ runs happy path
  ✓ 0s
  ▸ handles error case
  ✗ expect_contain failed: "out" does not contain "expected" 1s

✗ 1 / 2 test(s) failed
  - handles error case
```

When all tests pass: `✓ N test(s) passed`. Exit status is 0 on full success, non-zero if any test failed.

## How it works

The CLI parses each test file and hands `test { ... }` blocks to `runTestFile()` in the test runner. That function:

1. Calls `buildRuntimeGraph(testFile)` once per file to build the import closure.
2. Prepares `script` artifacts for the workspace via `buildScripts()` into a temporary directory (test files are excluded from this walk).
3. Sets `JAIPH_SCRIPTS` to that directory and runs each block with `JAIPH_TEST_MODE=1`.

There is no Bash transpilation of workflows on this path — only extracted `script` files are shell, same as production. The runtime graph is cached per file; mutating imported files on disk mid-run is not supported.

## Environment variables

For each workflow run inside a test block, the harness builds the runtime environment from `process.env` plus:

| Variable | Value |
|---|---|
| `JAIPH_TEST_MODE` | `1` |
| `JAIPH_WORKSPACE` | Project root (from `detectWorkspaceRoot`) |
| `JAIPH_RUNS_DIR` | Per-block temp directory |
| `JAIPH_SCRIPTS` | Temp `buildScripts` output |

You do not set `JAIPH_TEST_MODE` yourself; the harness manages it.

## Organizing tests

A Given / When / Then structure works well but is not required — comments and blank lines are fine:

```jaiph
import "app.jh" as app

test "default workflow prints greeting" {
  # Given
  mock prompt "hello"

  # When
  const out = run app.default()

  # Then
  expect_contain out "hello"
}
```

## Compiler tests (txtar format)

Compiler tests verify parse and validate outcomes using a language-agnostic txtar format. Unlike the TypeScript-embedded tests in `src/`, these fixtures are plain text files that can be reused by alternative implementations (e.g. a Rust compiler).

Test fixture files live in `compiler-tests/` as `.txt` files. Each file contains multiple test cases separated by `===` delimiters:

```
=== test name here
# @expect ok
--- input.jh
workflow default() {
  log "hello"
}

=== another test
# @expect error E_PARSE "unterminated workflow block"
--- input.jh
workflow default() {
  log "hello"
```

### Format rules

- `=== <name>` starts a new test case. Everything until the next `===` (or EOF) belongs to that case.
- `--- <filename>` starts a virtual file within the test case. Filenames must end in `.jh`.
- `# @expect <directive>` declares the expected outcome and must appear before the first `---` marker.

### Expect directives

| Directive | Meaning |
|-----------|---------|
| `# @expect ok` | Parse + validate succeed with no errors |
| `# @expect error E_CODE "substring"` | An error is thrown whose message contains both `E_CODE` and `substring` |
| `# @expect error E_CODE "substring" @L` | Same, and the error must be reported at line `L` (any column) |
| `# @expect error E_CODE "substring" @L:C` | Same, and the error must be reported at line `L`, column `C` |

### Single-file vs multi-file tests

- **Single-file:** use `--- input.jh`. The runner compiles `input.jh`.
- **Single test file:** use `--- input.test.jh` for test-specific fixtures.
- **Multi-file:** use `--- main.jh` as the entry file plus additional `--- lib.jh` etc. The runner compiles `main.jh`.

The entry file is determined by priority: `main.jh` if present, otherwise `input.jh`, otherwise `input.test.jh`, otherwise the first file.

### Running compiler tests

```bash
npm run test:compiler
```

The runner discovers all `.txt` files in `compiler-tests/`, parses them, writes virtual files to a temp directory per case, runs `parsejaiph` + `validateReferences`, and asserts the expected outcome. Results are reported per test case via `node:test`. Compiler tests are also included in `npm test`.

### Fixture files

Test cases are organized by error type and single-vs-multi-module:

| File | Cases | What it covers |
|------|-------|----------------|
| `compiler-tests/valid.txt` | 103 | Success cases — source compiles without error (single-module) |
| `compiler-tests/parse-errors.txt` | 108 | `E_PARSE` error cases — syntax and grammar violations |
| `compiler-tests/validate-errors.txt` | 24 | `E_VALIDATE`, `E_IMPORT_NOT_FOUND`, `E_SCHEMA` error cases (single-module) |
| `compiler-tests/validate-errors-multi-module.txt` | 3 | Validation errors requiring imports (multi-file) |

The initial cases were extracted from TypeScript test files across `src/parse/*.test.ts` and `src/transpile/*.test.ts`. Additional cases were written directly as txtar fixtures to cover compiler error paths that had no prior test coverage. Only tests that verify "source in, pass/fail out" qualify — tests that check AST structure or internal APIs remain in TypeScript.

### Conventions

- One `.txt` file per category.
- Test names should be descriptive and unique within a file.
- Keep test cases minimal — only include what is necessary to trigger the expected outcome.

The format is documented in detail in `compiler-tests/README.md`.

## Golden AST tests

Golden AST tests verify that the parser produces the expected tree shape for successful parses. While compiler tests (txtar) cover pass/fail outcomes and E2E tests cover runtime behavior, golden AST tests lock in **what** the parser actually produced — so refactors cannot silently change tree structure.

### How it works

Each `.jh` fixture in `golden-ast/fixtures/` is parsed and serialized to deterministic JSON (locations and file paths stripped, keys sorted). The result is compared against a checked-in `.json` golden file in `golden-ast/expected/`.

- **Txtar tests** = error messages and "this compiles."
- **Golden AST tests** = parse tree shape for successful parses.
- **E2E tests** = full CLI + runtime behavior.

### Running golden AST tests

```bash
npm run test:golden-ast
```

Golden AST tests are also included in `npm test`.

### Updating goldens

When an intentional parser change alters AST shape, regenerate the golden files:

```bash
UPDATE_GOLDEN=1 npm run test:golden-ast
```

Review the diff to confirm the changes are expected, then commit the updated `.json` files.

### Adding a new fixture

1. Create a small, focused `.jh` file in `golden-ast/fixtures/` (one concern per file).
2. Run `UPDATE_GOLDEN=1 npm run test:golden-ast` to generate `golden-ast/expected/<name>.json`.
3. Review the generated JSON and commit both files.

## Stress and soak testing

For concurrency-sensitive behavior (for example parallel inbox dispatch), the repository includes shell-based E2E scenarios that go beyond single native tests:

- High volume and fan-out to exercise locking and dispatch under concurrent writes.
- Soak loops to flush out intermittent failures.
- Order-insensitive checks (counts, uniqueness) when parallel work makes ordering non-deterministic.

See `e2e/tests/91_inbox_dispatch.sh`, `e2e/tests/93_inbox_stress.sh`, and `e2e/tests/94_parallel_shell_steps.sh` for examples.

## PTY-based TTY tests

Some CLI behavior only activates when stdout is a real TTY — the live progress tree with ANSI redraws, for example. These tests use Python's `pty.openpty()` to spawn `jaiph run` under a pseudo-terminal, capture the raw byte stream, and assert on the rendered output.

Two PTY tests exist today:

| Test file | What it covers |
|-----------|----------------|
| `e2e/tests/81_tty_progress_tree.sh` | Synchronous workflow progress rendering — verifies the tree structure, step timing, and PASS/FAIL markers under a real TTY. |
| `e2e/tests/131_tty_async_progress.sh` | Async workflow progress rendering — verifies that `run async` branches (with `Handle<T>` deferred resolution) render per-branch progress events under subscript-numbered nodes (₁, ₂), that both branches show resolved return values in the final frame, and that no orphaned ANSI escape sequences appear. |

Both tests require Python 3 and use only deterministic, non-LLM steps (sleep loops, `log`, scripts) so results are reproducible. Assertions use `assert_contains` with order-insensitive matching because async interleaving and PTY redraws make exact full-output comparison infeasible.

## E2E testing

Shell harnesses and CI expectations for the full repo are described in [Contributing — E2E testing](contributing.md#e2e-testing).

E2E tests compare full CLI output and full artifact file contents by default. Use `e2e::expect_stdout`, `e2e::expect_out`, `e2e::expect_file`, `e2e::expect_run_file`, or `e2e::assert_equals`. Substring checks (`e2e::assert_contains`) require an inline comment justifying the exception. For the full policy (two surfaces, full equality, `assert_contains` exceptions, normalization), see [Contributing — E2E testing](contributing.md#e2e-testing). For the on-disk tree under `.jaiph/runs/`, see [Architecture — Durable artifact layout](architecture#durable-artifact-layout).

Every `.jh` sample under `e2e/` must be wired into at least one test. Run `bash e2e/check_orphan_samples.sh` to detect unreferenced fixtures. See [Contributing — Orphan sample guard](contributing.md#orphan-sample-guard) for details.

Similarly, every `.jh` and `.test.jh` file under `examples/` must be accounted for in `e2e/tests/110_examples.sh` — either exercised with strict assertions or explicitly excluded with a rationale. An orphan guard in that script enforces this. See [Contributing — Example matrix guard](contributing.md#example-matrix-guard) for details.

## Landing-page sample verification

The project includes a Playwright-based test (`tests/e2e-samples/landing-page.spec.ts`) that verifies landing-page code samples stay in sync with real CLI behavior. Run it with `npm run test:samples`. See [Contributing — Landing-page sample verification](contributing.md#landing-page-sample-verification-playwright) for details.

## Limitations (v1)

- Prompt mocks are inline only — no external mock config files.
- Do not combine `mock prompt { ... }` with `mock prompt "..."` in the same test block; only the block dispatch is active.
- Capture without explicit `return` reads stdout step artifacts (`*.out` files) or falls back to aggregated runtime output.
- Assertions only support double-quoted expected strings.
- Extra arguments after the test path (`jaiph test <path> [extra...]`) are accepted but ignored (reserved for future use).
