---
title: Run work concurrently
permalink: /how-to/async
diataxis: how-to
---

# Run work concurrently

Use `async` when two defs or named scripts do not depend on each other and you want them to overlap. The runtime starts each call immediately and gives you a handle. The handle becomes a string on the first read that needs the value, or at the end of the current step list.

This page is a recipe. The value model lives in [Async Handles](spec-async-handles.md). The syntax table lives in [Language, `async`](language.md#run-async-concurrent-execution-with-handles).

## Prerequisites

- An entry file with `export def main`.
- Two independent callees (defs or named scripts). Inline `` `…`() `` cannot be `async` — move the body into a named `script`.

## 1. Start both sides, read late

Hold each handle in its original binding. Any read that needs the string resolves the handle, so avoid these until you want the value:

- interpolating it, such as `log "${lint_h}"`;
- passing it as a call argument, since a bare argument is rewritten to `${lint_h}` before the call;
- using it as an `if` or `match` subject;
- copying it with `const copy = lint_h`, since a bare copy is rewritten to `"${lint_h}"` and resolves too.

An early read makes the def wait at that point, which removes the overlap.

```jaiph
def lint() {
  return check_lint()
}

def unit_tests() {
  return check_tests()
}

export def main() {
  const lint_h = async lint()
  const test_h = async unit_tests()
  log "lint: ${lint_h}"
  log "tests: ${test_h}"
}
```

A bare `async lint()` with no capture still starts the work. The implicit join at the end of the step list waits for it.

## 2. Recover a failing async branch

`catch` and `recover` attach only to the statement form. A captured `const h = async foo()` cannot carry those blocks. Wrap the target in a def if you need both a handle and a retry loop.

```jaiph
export def main() {
  async deploy() recover (err) {
    logerr "repair; see ${err}"
    auto_repair()
  }
}
```

`recover` retries inside that one branch. `catch` runs once; a successful catch counts the branch as joined-ok. A `catch` `return` becomes the parent def's return when the join adopts it.

## 3. Resolve a handle before a `for` loop

`for line in h` does **not** resolve a handle. The loop iterates the token as one line, so you get one pass over `__JAIPH_HANDLE__…` instead of one pass per result line. Resolve first:

```jaiph
const text = "${h}"
for line in text {
  log line
}
```

## Verification

1. Run a file that starts two `async` calls and reads the handles only at the end. The live tree prefixes each branch with a subscript (`₁`, `₂`).
2. Confirm an unread handle still finishes: drop the `log` lines and the run still exits `0` after both branches complete.
3. Confirm `for line in h` runs once (the token is one line). After `const text = "${h}"`, `for line in text` runs once per result line.

`examples/async.jh` is a two-backend sample of the same pattern.

## Related

- [Async Handles](spec-async-handles.md) — eager start, lazy resolve, implicit join, and why there is no `await`.
- [Language, `async`](language.md#run-async-concurrent-execution-with-handles) — surface syntax.
- [Inbox](inbox.md) — channel drain runs after the entry def's implicit join.
