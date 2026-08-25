---
title: Write & run tests
permalink: /how-to/testing
diataxis: how-to
redirect_from:
  - /testing
  - /testing.md
---

# Write & run tests

This guide shows how to write a `*.test.jh` file with mocked prompts and stubbed dependencies, and then run it with `jaiph test`. Each test block runs the workflow under test in-process through `NodeWorkflowRuntime`, which is the same interpreter that `jaiph run` uses, and then checks the captured output.

`jaiph test` runs on the host in-process. It does not run the credential pre-flight, and it does not run hooks.

Mock every `prompt` step, and stub external workflows, rules, or scripts when you need to. If you leave a prompt unmocked, or a queued list of `mock prompt "…"` responses runs out, the runtime falls through to a real, live `prompt` call against the configured agent backend, the same way `jaiph run` would. One difference is that `jaiph test` turns off prompt retries by default by setting `JAIPH_PROMPT_RETRY=0`, so a prompt that falls through and errors fails right away instead of retrying on the production schedule. Set `JAIPH_PROMPT_RETRY` yourself when you want to test the retry behavior.

A pattern-based `mock prompt { … }` block does not fall through. An unmatched prompt fails the test unless a `_` default arm catches it.

The goal is to give the workflow fixed inputs and outputs you can check, so that refactors and CI catch regressions the same way every time.

## Prerequisites

- The workflow under test lives in a separate `.jh` file you can import (recommended, and it keeps test files small).
- You know the workflow's parameters and what `prompt` calls it makes.

## 1. Create the test file

Test files end in `.test.jh`. By convention, keep them next to the module under test, or under a top-level `tests/` or `e2e/` directory.

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

Multiple `mock prompt` lines queue in order, and one response is consumed per `prompt` call. Strings must use double quotes, and they support the `\"`, `\n`, and `\\` escapes. A bare identifier refers to a test-block `const` declared earlier as a double-quoted string:

```jh
const greeting = "hi"
mock prompt greeting
```

To pick a response based on the content of the prompt, use the pattern form. Do not mix queued `mock prompt "…"` or `mock prompt <const>` lines with a `mock prompt { … }` block in one test, because the compiler rejects that with an `E_VALIDATE` error. Separate tests in the same file may use different styles:

```jh
mock prompt {
  /greeting/ => "hello"
  /farewell/ => "goodbye"
  _ => "default response"
}
```

Arms are checked from top to bottom, and the first match wins. A `/regex/` arm matches when its pattern is found anywhere in the prompt text. A `"string"` arm matches only when the whole prompt text equals it exactly. Without a `_` wildcard arm, an unmatched prompt fails the test.

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

`mock workflow` and `mock rule` use Jaiph steps in the body. `mock script` uses raw shell, the same as a real `script`.

## 4. Run the workflow and capture output

```jh
const response = run w.default()
const response = run w.default("my input")            # with one argument
const response = run w.default("first", "second")     # comma-separated arguments
const response = run w.default() allow_failure        # accept non-zero exit
```

`run` captures the workflow's return value when the exit code is 0 and the return value is not empty. When the exit code is non-zero, it captures the runtime error string instead. In any other case, it captures the workflow's `*.out` files, read in sorted order and joined together.

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

The runner discovers `*.test.jh` files recursively. When no files match, whether you ran a bare `jaiph test` or pointed it at a directory, it prints `jaiph test: no *.test.jh files found (nothing to do)` and exits 0, so you can call it from CI without checking first.

## Verification

A passing run prints one block per case, then `✓ N test(s) passed`, and exits 0:

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

- [Architecture, test runner integration](architecture.md#test-runner-integration-testjh-in-the-kernel). How `runTestFile` reuses the same module graph and runtime as `jaiph run`.
- [Configure backend & model](configure-backend.md). Workflows under test still read `config { … }`, so pin agent settings in env when CI must be deterministic.
- [Authenticate agent backends](agent-auth.md). Only needed when a test reaches a live `prompt`. Fully mocked suites skip agent credentials and the `jaiph run` pre-flight.
