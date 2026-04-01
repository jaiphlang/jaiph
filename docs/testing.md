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
  response = w.default
  expectContain response "e2e-greeting-mock"
  expectContain response "done"
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

Replaces a workflow body for this test case with the given shell commands:

```jaiph
mock workflow w.greet {
  echo "stubbed greeting"
}
```

The reference format is `<alias>.<workflow>` (preferred) or `<name>` for a workflow defined in the test file itself.

### Mock rule

Same as mock workflow, but for rules:

```jaiph
mock rule w.validate {
  echo "stubbed validation"
}
```

### Mock script

Stubs a module `script` block:

```jaiph
mock script w.helper {
  echo "stubbed script"
}
```

The former `mock function` syntax is no longer accepted — the parser emits an error with migration guidance.

### Workflow run (with capture)

Runs a workflow and captures its output into a variable:

```jaiph
response = w.default
```

**Capture semantics** match production behavior:

1. If the workflow exits 0 with a non-empty explicit `return` value, that string is captured.
2. If the workflow fails (non-zero exit), the runtime error string is captured (when present).
3. Otherwise, the harness reads all `*.out` files in the run directory sorted by filename, or falls back to the runtime's aggregated output.

The test fails on non-zero exit unless `allow_failure` is specified.

**Variants:**

```jaiph
# With an argument
response = w.default "my input"

# Allow failure
response = w.default allow_failure

# With argument and allow failure
response = w.default "my input" allow_failure

# Alternate allow-failure form (spacing must match)
response=$( { w.default 2>&1; } || true )
```

### Workflow run (no capture)

Runs a workflow without storing output. Still fails on non-zero exit unless `allow_failure` is appended:

```jaiph
w.setup
w.setup "arg"
w.setup allow_failure
```

### Shell steps

Any line that is not a recognized step form is emitted as a shell command (useful for setup like `mkdir`, environment prep, etc.). Lines starting with `#` are comments and are skipped.

### Assertions

After capturing workflow output, use these to check the result:

```jaiph
expectContain response "expected substring"
expectNotContain response "unwanted text"
expectEqual response "exact expected value"
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
  ✗ expectContain failed: "out" does not contain "expected" 1s

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

`NodeWorkflowRuntime` sets `JAIPH_LIB` to `<JAIPH_WORKSPACE>/.jaiph/lib` when it is unset or empty.

You do not set `JAIPH_TEST_MODE` yourself; the harness manages it.

## Organizing tests

A Given / When / Then structure works well but is not required — comments and blank lines are fine:

```jaiph
import "app.jh" as app

test "default workflow prints greeting" {
  # Given
  mock prompt "hello"

  # When
  out = app.default

  # Then
  expectContain out "hello"
}
```

## Compiler tests (txtar format)

Compiler tests verify parse and validate outcomes using a language-agnostic txtar format. Unlike the TypeScript-embedded tests in `src/`, these fixtures are plain text files that can be reused by alternative implementations (e.g. a Rust compiler).

Test fixture files live in `compiler-tests/` as `.txt` files. Each file contains multiple test cases separated by `===` delimiters:

```
=== test name here
# @expect ok
--- input.jh
workflow default {
  log "hello"
}

=== another test
# @expect error E_PARSE "unterminated workflow block"
--- input.jh
workflow default {
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

### Single-file vs multi-file tests

- **Single-file:** use `--- input.jh`. The runner compiles `input.jh`.
- **Multi-file:** use `--- main.jh` as the entry file plus additional `--- lib.jh` etc. The runner compiles `main.jh`.

The entry file is determined by priority: `main.jh` if present, otherwise `input.jh`, otherwise the first file.

### Running compiler tests

```bash
npm run test:compiler
```

The runner discovers all `.txt` files in `compiler-tests/`, parses them, writes virtual files to a temp directory per case, runs `parsejaiph` + `validateReferences`, and asserts the expected outcome. Results are reported per test case via `node:test`. Compiler tests are also included in `npm test`.

### Conventions

- One `.txt` file per category (e.g. `valid.txt`, `parse-errors.txt`, `validate-errors.txt`).
- Test names should be descriptive and unique within a file.
- Keep test cases minimal — only include what is necessary to trigger the expected outcome.

The format is documented in detail in `compiler-tests/README.md`.

## Stress and soak testing

For concurrency-sensitive behavior (for example parallel inbox dispatch), the repository includes shell-based E2E scenarios that go beyond single native tests:

- High volume and fan-out to exercise locking and dispatch under concurrent writes.
- Soak loops to flush out intermittent failures.
- Order-insensitive checks (counts, uniqueness) when parallel work makes ordering non-deterministic.

See `e2e/tests/91_inbox_dispatch.sh`, `e2e/tests/93_inbox_stress.sh`, and `e2e/tests/94_parallel_shell_steps.sh` for examples.

## E2E testing

Shell harnesses and CI expectations for the full repo are described in [Contributing — E2E testing](contributing.md#e2e-testing).

E2E tests compare full CLI output and full artifact file contents by default. Use `e2e::expect_stdout`, `e2e::expect_out`, `e2e::expect_file`, `e2e::expect_run_file`, or `e2e::assert_equals`. Substring checks (`e2e::assert_contains`) require an inline comment justifying the exception. For the full policy and artifact layout, see [Architecture — E2E test philosophy](architecture#e2e-test-philosophy-and-artifact-layout).

## Landing-page sample verification

The project includes a Playwright-based test (`tests/e2e-samples/landing-page.spec.ts`) that verifies landing-page code samples stay in sync with real CLI behavior. Run it with `npm run test:samples`. See [Contributing — Landing-page sample verification](contributing.md#landing-page-sample-verification-playwright) for details.

## Limitations (v1)

- Prompt mocks are inline only — no external mock config files.
- Do not combine `mock prompt { ... }` with `mock prompt "..."` in the same test block; only the block dispatch is active.
- Capture without explicit `return` reads stdout step artifacts (`*.out` files) or falls back to aggregated runtime output.
- Assertions only support double-quoted expected strings.
- Extra arguments after the test path (`jaiph test <path> [extra...]`) are accepted but ignored (reserved for future use).
