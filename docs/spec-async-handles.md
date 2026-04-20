---
title: "Spec: Async Handles"
---

# Async Handles — `Handle<T>` Value Model

This document specifies the `Handle<T>` value model for `run async` in Jaiph.

## Overview

`run async ref(args)` returns a **`Handle<T>`** immediately. `T` is the same type the called function would return under a synchronous `run`. The handle resolves to the eventual return value on first non-passthrough read.

## Handle creation

```jaiph
const h = run async foo()
run async bar()
```

- `const h = run async foo()` — `h` receives a handle. The async execution starts immediately; the workflow continues without waiting.
- `run async bar()` — a handle is created internally but not captured. The workflow proceeds without waiting.

There is **no fire-and-forget mode**. Every `run async` creates a handle tracked by the runtime, whether captured or not.

## Resolution semantics

A handle resolves to the value of the called function (its `return` value or trimmed stdout). Resolution is triggered by the **first non-passthrough read**.

### Reads that force resolution

| Access pattern | Example | Forces resolution? |
|---|---|---|
| String interpolation | `log "${h}"` | Yes |
| Passing as argument to `run` | `run other(h)` | Yes |
| Comparison / conditional | `if h == "ok" { ... }` | Yes |
| Match subject | `match h { ... }` | Yes |
| Any other value access | `channel <- $h` | Yes |

### Passthrough (does NOT force resolution)

| Access pattern | Example | Forces resolution? |
|---|---|---|
| Initial capture | `const h = run async foo()` | No |
| Re-assignment | (internal scope passing) | No |

Once resolved, the handle is replaced in-place by the resolved string value. Subsequent reads return the cached value without re-executing.

## Workflow exit — implicit join

When a workflow scope exits (the last step completes), the runtime **implicitly joins all remaining unresolved handles** created in that scope. This is not an error condition.

- If all handles resolve successfully, the workflow returns normally.
- If any handle resolved (or resolves during join) with a non-zero status, the workflow fails with an aggregated error message listing all failed async refs.

This preserves backward compatibility with the pre-handle `run async` behavior where all async steps were awaited at workflow exit.

## `recover` composition

`recover` works with `run async` to provide retry-loop semantics on the async branch:

```jaiph
const b1 = run async foo() recover(err) {
  log "repairing: ${err}"
  run fix_it()
}
```

### Semantics

1. The async branch executes `foo()`.
2. If `foo()` succeeds, the handle resolves to its return value.
3. If `foo()` fails, the recover body runs with `err` bound to the merged stdout+stderr of the failure.
4. If the recover body completes successfully (status 0, no early return), `foo()` is retried.
5. Steps 3–4 repeat until `foo()` succeeds or the retry limit is reached.
6. If the retry limit is exhausted, the handle resolves to the final failure result.

### Retry limit

The retry limit is shared with non-async `recover`:

- Default: **10** attempts.
- Configurable per module/workflow via `config { run.recover_limit = N }`.

### `catch` composition

`catch` also works with `run async` for single-shot recovery (no retry loop):

```jaiph
run async foo() catch(err) {
  log "caught: ${err}"
}
```

If `foo()` fails, the catch body runs once. No retry.

## Interaction with progress/events

Async handles preserve the existing async progress/event visibility model:

- Each async branch gets a unique branch index (subscript numbering: ₁, ₂, …).
- Step events (`STEP_START`, `STEP_END`) and log events carry `async_indices` for the branch.
- The CLI progress tree renders async branches at the appropriate indent level.

Handle resolution does not emit additional events beyond what the async branch already emits.

## Constraints

- `run async` is only allowed in workflows, not in rules.
- `run async` is not supported with inline scripts (`` run async `body`(args) ``).
- There is no explicit `await` keyword. Resolution is implicit on first read or at workflow exit.
- There is no fire-and-forget. All handles are joined.
