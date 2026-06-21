---
title: Write & run tests
permalink: /how-to/testing
diataxis: how-to
redirect_from:
  - /testing
  - /testing.md
---

# Write & run tests

This recipe authors a `*.test.jh` file with mocked prompts and stubbed dependencies, then runs it through `jaiph test`. Test blocks execute the workflow under test in-process through `NodeWorkflowRuntime` — the same interpreter `jaiph run` uses — and assert on captured output.

`jaiph test` runs on the host in-process — no Docker sandbox, no credential pre-flight, and no hooks. Mock every `prompt` step (and stub external workflows, rules, or scripts when needed): when no mocks are configured, or when a queued `mock prompt "…"` list is exhausted, the runtime falls through to the real agent backend the same way `jaiph run` would. Pattern-based `mock prompt { … }` blocks do not fall through — an unmatched prompt fails the test unless a `_` default arm catches it. The goal is fixed inputs and checkable outputs so refactors and CI catch regressions deterministically.

## Prerequisites

- The workflow under test lives in a separate `.jh` file you can import (recommended; keeps test files small).
- You know the workflow's parameters and what `prompt` calls it makes.

## 1. Create the test file

Test files end in `.test.jh`. Convention: keep them next to the module under test or under a top-level `tests/` / `e2e/` directory.

```jh
import "workflow_greeting.jh" as w

test "runs happy path and prints PASS" {
  mock prompt "e2e-greeting-mock"
  const response = run w.default()
  expect_contain response "e2e-greeting-mock"
  expect_contain response "done"
}
```

A test file can have any top-level construct (`import`, `config`, `workflow`, …), but the CLI only executes `test "..." { ... }` blocks. `#` line comments and blank lines are allowed between steps inside a test block.

## 2. Queue mock prompt responses

```jh
mock prompt "first response"
mock prompt "second response"
```

Multiple `mock prompt` lines queue in order — one is consumed per `prompt` call. Strings must use **double quotes** (with `\"`, `\n`, `\\` escapes). A bare identifier refers to a test-block `const` declared earlier as a double-quoted string:

```jh
const greeting = "hi"
mock prompt greeting
```

For content-based dispatch, use the pattern form. Do not mix queued `mock prompt "…"` / `mock prompt <const>` lines with a `mock prompt { … }` block in one test — the compiler rejects that (`E_VALIDATE`). Separate tests in the same file may use different styles:

```jh
mock prompt {
  /greeting/ => "hello"
  /farewell/ => "goodbye"
  _ => "default response"
}
```

Arms are evaluated top-to-bottom; the first match wins. Without a `_` wildcard arm, an unmatched prompt fails the test.

## 3. (Optional) Stub workflows, rules, or scripts

Replace a workflow, rule, or script body for this test case. Parentheses are required:

```jh
mock workflow w.greet() {
  return "stubbed greeting"
}

mock rule w.validate() {
  return "stubbed validation"
}

mock script w.helper() {
  echo "stubbed script"
}
```

`mock workflow` / `mock rule` use Jaiph steps in the body; `mock script` uses raw shell, like a real `script`.

## 4. Run the workflow and capture output

```jh
const response = run w.default()
const response = run w.default("my input")     # with argument
const response = run w.default() allow_failure # accept non-zero exit
```

`run` captures the workflow's return value when the exit is 0 and the return is non-empty; otherwise it falls back to the runtime error string (for non-zero exits) or the concatenated `*.out` files in sorted order.

## 5. Assert on the captured value

```jh
expect_contain     response "expected substring"
expect_not_contain response "unwanted text"
expect_equal       response "exact expected value"
```

The second argument is either a double-quoted literal or a test-block `const` name (bare identifier, not quoted).

## 6. Run the tests

```bash
jaiph test                            # discover *.test.jh under the workspace
jaiph test ./e2e                      # restrict to a directory
jaiph test ./e2e/workflow_greeting.test.jh  # single file
jaiph ./e2e/workflow_greeting.test.jh       # shorthand: a *.test.jh path is treated as jaiph test
```

The runner discovers `*.test.jh` files recursively. Zero matches in discovery mode print `jaiph test: no *.test.jh files found (nothing to do)` and exit **0** — safe to call unconditionally from CI.

## Verification

A passing run prints one block per case followed by `✓ N test(s) passed` and exits **0**:

```
testing workflow_greeting.test.jh
  ▸ runs happy path and prints PASS
  ✓ 0s
✓ 1 test(s) passed
```

A failure prints the failing assertion and exits non-zero:

```
  ▸ handles error case
  ✗ expect_contain failed: "response" (42 chars) does not contain "expected" 1s

✗ 1 / 2 test(s) failed
  - handles error case
```

## Related

- [Architecture — Test runner integration](architecture.md#test-runner-integration-testjh-in-the-kernel) — how `runTestFile` reuses the same module graph and runtime as `jaiph run`.
- [Configure backend & model](/how-to/configure-backend) — workflows under test still read `config { … }`; pin agent settings in env when CI must be deterministic.
- [Authenticate agent backends](/how-to/agent-auth) — only needed when a test reaches a live `prompt`; fully mocked suites skip agent credentials and the `jaiph run` pre-flight.
