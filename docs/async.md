---
title: Run work concurrently
permalink: /how-to/async
diataxis: how-to
---

# Run work concurrently

Use `run async` when two defs or named scripts do not depend on each other and you want them to overlap. The runtime starts each call immediately and gives you a handle. The handle becomes a string on the first read that needs the value, or at the end of the current step list.

This page is a recipe. The value model lives in [Async Handles](spec-async-handles.md). The syntax table lives in [Language, `run async`](language.md#run-async-concurrent-execution-with-handles).

## Prerequisites

- An entry file with `export def main`.
- Two independent callees (defs or named scripts). Inline `` run `…`() `` cannot be `run async` — move the body into a named `script`.

## 1. Start both sides, read late

Hold each handle in its original binding. Do not interpolate, pass as a `run` argument, or use as an `if` / `match` subject until you need the value. An early read waits there and removes the overlap.

```jaiph
def lint() {
  return run check_lint()
}

def unit_tests() {
  return run check_tests()
}

export def main() {
  const lint_h = run async lint()
  const test_h = run async unit_tests()
  log "lint: ${lint_h}"
  log "tests: ${test_h}"
}
```

A bare `run async lint()` with no capture still starts the work. The implicit join at the end of the step list waits for it.

## 2. Recover a failing async branch

`catch` and `recover` attach only to the statement form. A captured `const h = run async foo()` cannot carry those blocks. Wrap the target in a def if you need both a handle and a retry loop.

```jaiph
export def main() {
  run async deploy() recover (err) {
    log "repair: ${err}"
    run auto_repair()
  }
}
```

`recover` retries inside that one branch. `catch` runs once; a successful catch counts the branch as joined-ok. A `catch` `return` becomes the parent def's return when the join adopts it.

## 3. Avoid the `for` footgun

`for line in h` does **not** resolve a handle. The loop iterates the token as one line, so you get one pass over `__JAIPH_HANDLE__…` instead of one pass per result line. Resolve first:

```jaiph
const text = "${h}"
for line in text {
  log line
}
```

## Verification

1. Run a file that starts two `run async` calls and reads the handles only at the end. The live tree prefixes each branch with a subscript (`₁`, `₂`).
2. Confirm an unread handle still finishes: drop the `log` lines and the run still exits `0` after both branches complete.
3. Confirm `for line in h` runs once (the token is one line). After `const text = "${h}"`, `for line in text` runs once per result line.

`examples/async.jh` is a two-backend sample of the same pattern.

## Related

- [Async Handles](spec-async-handles.md) — eager start, lazy resolve, implicit join, and why there is no `await`.
- [Language, `run async`](language.md#run-async-concurrent-execution-with-handles) — surface syntax.
- [Inbox](inbox.md) — channel drain runs after the entry def's implicit join.
