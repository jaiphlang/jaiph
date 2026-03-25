---
title: Testing
permalink: /testing
redirect_from:
  - /testing.md
---

# Testing Jaiph Workflows

## Overview

Jaiph ships a small **native test runner** for workflow modules. You write `*.test.jh` (or `*.test.jph`) files that import workflows under test, optionally replace prompts and other symbols with mocks, run workflows through the same managed runtime as `jaiph run`, and assert on captured output or return values.

**Why mocks matter.** Real workflows call LLMs, shell, and other workflows. That output is non-deterministic and environment-dependent. The test harness records mock prompt responses and can substitute shell bodies for workflows, rules, and Jaiph scripts so runs stay fast, repeatable, and offline-friendly.

**Core concepts**

- **Test files** — Names ending in `.test.jh` or `.test.jph`, discovered by `jaiph test`. Each file lists imports and one or more `test "..." { ... }` blocks.
- **Test blocks** — A named block is one test case: ordered steps (shell, mocks, workflow runs, assertions).
- **Mocks** — Fixed or content-based prompt responses; optional replacement bodies for imported workflows, rules, and scripts.
- **Assertions** — After a captured workflow run, `expectContain`, `expectNotContain`, and `expectEqual` check the captured string. Capture semantics are described under **Workflow run (capture)** below.

## File naming and layout

- Use the `.test.jh` or `.test.jph` suffix (for example `workflow_greeting.test.jh`).
- **Content:** Use imports and `test` blocks only. The parser may accept other top-level declarations in a `*.test.jh` file, but `*.test.jh` / `*.test.jph` modules are **skipped when the workspace is compiled** to `.sh`, so workflows or rules defined only in a test file are never emitted as runnable shell modules. Keeping tests to imports + `test` blocks avoids dead code and matches how the runner is meant to be used.
- **Imports:** Paths in `import "..." as alias` resolve **relative to the directory of the test file**, with the same extension fallback as ordinary modules (try `.jh`, then `.jph`). See [Grammar — Import path](grammar.md#lexical-notes).
- **Discovery:** `jaiph test` walks the given directory recursively (or the workspace root when no path is passed). The workspace root is found by walking up from the current directory until a `.jaiph` or `.git` directory exists; if neither is found, the current directory is used.

## Running tests

A path to a `*.test.jh` or `*.test.jph` file is treated like `jaiph test` on that file (see [CLI](cli.md)).

```bash
# All *.test.jh / *.test.jph files under the detected workspace root (recursive)
jaiph test

# All tests under a directory (recursive)
jaiph test ./e2e

# One file (equivalent: jaiph ./e2e/workflow_greeting.test.jh)
jaiph test ./e2e/workflow_greeting.test.jh
```

## Test blocks

Inside a `*.test.jh` file you may use:

1. **Imports** — Same syntax as workflow files: `import "<path>" as <alias>`.
2. **Test blocks** — `test "description" { ... }` with one or more steps.

**Workflow references** in run steps must be exactly `<alias>.<workflow>` (import alias and workflow name). The compiler validates that the alias exists and the imported module defines that workflow.

Optional **shebang** (`#!` on line 1) and **full-line `#` comments** at the top level are ignored like in other Jaiph files.

### Example

The following matches the repo fixture `e2e/workflow_greeting.test.jh` (run from the repository root with `jaiph test e2e/workflow_greeting.test.jh`). The mock string is arbitrary; it is the canned reply injected for the next `prompt` call.

```jaiph
import "workflow_greeting.jh" as w

test "runs happy path and output contains expected mock" {
  mock prompt "e2e-greeting-mock"
  response = w.default
  expectContain response "e2e-greeting-mock"
  expectContain response "done"
}
```

### Steps inside a test block

- **Shell** — Any bash line that is not another step form is emitted as shell (for setup, `mkdir`, etc.). Lines whose trimmed form starts with `#` are comments and are skipped (not emitted as shell).
- **`mock prompt "<response>"`** — Queues one response for the next `prompt` in the workflow under test. Single-quoted responses are allowed. Multiple `mock prompt` lines queue **in order** (one consumption per `prompt` call). **Do not mix** with a `mock prompt { ... }` block in the same test: if a block mock is present, inline `mock prompt "..."` steps are **not** emitted and have no effect (see [Limitations](#limitations-v1)).
- **`mock prompt { ... }`** — Content-based dispatch. The body must follow this shape only:
  - `if $1 contains "pattern" ; then` / `elif $1 contains "pattern" ; then` / optional `else`
  - After each `if` / `elif` / `else`, a single `respond "..."` line is **required** before the next branch keyword or `fi`
  - Close with `fi` then the closing `}` of `mock prompt`
  Matching uses **substring** match on the prompt text (same idea as “contains”). The first matching branch wins. Without `else`, an unmatched prompt fails the test with a short preview of the prompt text.
- **`mock workflow <ref> { ... }`** — Replace that workflow for this test with the given shell body (e.g. `echo ok`). `<ref>` is `<alias>` or `<alias>.<workflow>`; a single-segment ref is resolved against the first import’s module symbol (prefer the two-part form for clarity).
- **`mock rule <ref> { ... }`** — Same for a rule.
- **`mock function <ref> { ... }`** — Stubs a module **`script`** in tests (the test grammar still uses the keyword **`mock function`**); `<ref>` is `<name>` or `<alias>.<name>`.
- **Workflow run (capture)** — `name = <alias>.<workflow>` runs the workflow like `jaiph run`. Capture prefers the workflow’s explicit **`return`** value when the callee wrote one; otherwise the harness stores **combined stdout and stderr** with lines starting with `__JAIPH_EVENT__` removed. The test fails on non-zero exit unless you add `allow_failure`. Variants: optional one string argument (`name = w.default "arg"`), and/or `allow_failure` (`name = w.default allow_failure`, `name = w.default "arg" allow_failure`). This is the test form of managed invocation—do not wrap the workflow call in `$(…)`; see [Grammar — Managed calls vs command substitution](grammar.md#managed-calls-vs-command-substitution). **Alternate** allow-failure capture form: `name=$( { alias.workflow 2>&1; } || true )` (equivalent to `allow_failure` on an assignment capture).
- **Workflow run (no capture)** — `<alias>.<workflow>` or `<alias>.<workflow> "arg"` runs without storing output; still fails on non-zero exit unless `allow_failure` is appended (same optional argument patterns as above).
- **`expectContain` / `expectNotContain` / `expectEqual`** — `expectContain <var> "substring"`, etc. The expected string must be **double-quoted** (escape `"` inside the string with `\"` if needed). Failures print expected vs actual previews where applicable.

Typed prompts (`returns '{ ... }'`): mock text must be one line of JSON that satisfies the schema so parsing and field variables behave like a real agent response (see `e2e/prompt_returns_run_capture.test.jh`).

## Pass/fail reporting

Each `test` block runs in isolation. Assertions, shell errors, or a workflow exiting non-zero (without `allow_failure`) mark that case failed.

The runner prints:

```
testing <file name>
  ▸ <description>
  ✓ <elapsed>s                          # success: checkmark line follows the ▸ line
  ▸ <description>
  ✗ <first error line> <elapsed>s       # failure
    <further stderr lines, indented>

✗ 1 / 2 test(s) failed
  - <failed test description>
```

When every test passes, the summary is `✓ N test(s) passed`. Exit status is `0` on full success, non-zero if any test failed.

## Given / When / Then

Structure is optional; comments and blank lines are fine:

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

(Use a real import path next to your test file.)

## Stress and soak testing

For concurrency-sensitive behavior (for example parallel inbox dispatch), the repository includes shell-based E2E scenarios that go beyond single native tests:

- High volume and fan-out to exercise locking and dispatch under concurrent writes.
- Soak loops to flush out intermittent failures.
- Order-insensitive checks (counts, uniqueness) when parallel work makes ordering non-deterministic.

Examples: `e2e/tests/93_inbox_stress.sh`, `e2e/tests/94_parallel_shell_steps.sh` (background jobs, `wait`, concurrent stdout capture, artifact checks). `e2e/tests/93_ensure_recover_payload.sh` covers `ensure <rule> <param> recover`: retry succeeds after recover, and recover `$1` includes failed-attempt payload from nested rule/script execution before `prompt`. For `run_summary.jsonl` contracts (`LOG` / `LOGERR`, inbox events, step pairing) under `run.inbox_parallel`, see `e2e/tests/88_run_summary_event_contract.sh` (needs `python3`).

## E2E testing

Shell harnesses and CI expectations for the full repo are described in [Contributing — E2E testing](contributing.md#e2e-testing).

## Limitations (v1)

- Prompt mocks are **only** inline in the test file (queue of `mock prompt "..."` or a single `mock prompt { ... }` dispatcher). Older external mock config formats are not supported.
- **Do not combine** `mock prompt { ... }` with `mock prompt "..."` in the same test block; only the block path is active and inline queue steps are ignored in generated bash.
- Capture vs combined output: explicit `return` wins over stdout/stderr aggregation (with internal event lines stripped from the latter).
- Assertions only support **double-quoted** expected strings on the `expect*` lines.
- Extra arguments after `jaiph test <file>` are currently unused by the runner.
