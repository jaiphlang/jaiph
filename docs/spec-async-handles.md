---
title: "Spec: Async Handles"
permalink: /spec-async-handles
redirect_from:
  - /spec-async-handles.md
---

# Async Handles — `Handle<T>` Value Model

## Context

Concurrent work is a common orchestration problem: independent steps could run in parallel while the main line of the workflow keeps going, as long as completion and errors are accounted for before the surrounding scope finishes.

Jaiph addresses that with **`run async`**: the runtime starts a normal `run` target in the background, exposes the in-flight result as a **handle**, and **joins** every handle created in the current step list when that list ends—so nothing is left dangling. This page is about that **value model** (when a handle becomes a real string, how failures propagate, and how events look on the wire). Syntax lives in [Language — `run async`](language.md#run-async--concurrent-execution-with-handles) and [Grammar — `run async`](grammar.md#run-async--concurrent-execution-with-handles). For where this fits in the interpreter, events, and CLI progress, see [Architecture](architecture.md).

**Implementation:** All of this runs in **`NodeWorkflowRuntime`** (`src/runtime/kernel/node-workflow-runtime.ts`)—the same AST interpreter described in [Architecture — System overview](architecture.md#system-overview). A handle is bookkeeping on an in-flight **`run`**; it is joined at the [`executeSteps`](#implicit-join) scope that registered it. **`async_indices`** for events are threaded through **`AsyncLocalStorage`** and emitted via **`RuntimeEventEmitter`** (see [Architecture — Core components](architecture.md#core-components) and [CLI progress reporting pipeline](architecture.md#cli-progress-reporting-pipeline)).

## Overview

`run async ref(args)` schedules the same **`run` target** (workflow or script) **without blocking** the current step list. The value is a **handle**—conceptually `Handle<T>` where `T` is what a synchronous `run` would have produced (workflow **`return`**, or trimmed script stdout on success). In the runtime variable map the handle is stored as an opaque string token (`__JAIPH_HANDLE__` + numeric id); the first **non-passthrough** use that needs the real value **awaits** the scheduled work, then **replaces** that binding with the resolved string (or clears it on failure—see [Resolution](#resolution)).

## Handle creation

```jaiph
script noop = `echo ok`

workflow bg() {
  run noop()
}

workflow default() {
  const h = run async bg()
  run async bg()
}
```

- `const h = run async bg()` — `h` holds a handle. Work for `bg()` starts immediately; later steps can overlap with it.
- `run async bg()` — a handle is still created and **tracked** for [implicit join](#implicit-join) even if you do not store it in a variable.

This is not “fire and forget” in a scheduler sense: the runtime **registers** every `run async`, captured or not, and still **joins** it when the [scope below](#implicit-join) allows.

**Forms:** Only `run async …` as a statement or as `const name = run async ref(args)` is supported. **`recover` / `catch` blocks attach only to the statement form** (`run async foo() recover …` / `catch …`); `const … = run async …` cannot carry a recovery block (the parser allows only a plain call there—see `const-rhs.ts` / `workflow-brace.ts`).

## Resolution

A handle resolves to the `run` result: workflow **`return`**, or **trimmed script stdout** on success; on failure, resolution carries the same failure shape as a synchronous `run` (and can fail the block or the join, depending on where resolution happens). Resolution is triggered on the first **non-passthrough** read of the value.

`resolveHandlesInInput` scans for `${name}` substrings (identifier form) and resolves each binding that still holds a handle token; **`${run …}` / `${ensure …}`** **inline captures** run only after that scan (see `interpolateWithCaptures`).

### Reads that force resolution

The runtime scans for `${name}` in the places below. **Call arguments:** the parser classifies each argument once into a typed `Arg` (`{ kind: "var"; name }` for bare identifiers, `{ kind: "literal"; raw }` for everything else); when the runtime needs the space-separated argv string, `argsToRuntimeString` in `src/parse/core.ts` renders each `var` as **`${name}`** and emits each `literal` verbatim, so bare-identifier args go through the same `resolveHandlesInInput` path as explicit interpolation (see [Grammar — Call-site arguments](grammar.md#call-site-arguments) and [Language — `run`](language.md#run--execute-a-workflow-or-script)).

| Access pattern | Example | Forces resolution? |
| --- | --- | --- |
| String / template interpolation (`log`, `logerr`, `fail`, `return`, `const … = "…"`, shell one-liners, and other orchestration strings using `interpolateWithCaptures`) | `log "result: ${h}"` | Yes |
| Arguments to `run` / `ensure` (tokens that embed `${…}` or bare identifiers rewritten for the callee) | `run downstream(h)` or `run downstream("pref_${h}")` | Yes |
| Prompt body (string, identifier, or triple-quoted) before the model call | `prompt "ctx: ${h}"` | Yes |
| `if` subject variable | `if h == "ok" { ... }` | Yes — subject is resolved when it is still a handle token |
| `match` subject | `match h { ... }` | Yes |
| Literal or `var` send RHS that contains `${…}` | `findings <- "${h}"` or `findings <- ${h}` (see send forms in [Inbox](inbox.md)) | Yes — `${name}` tokens in the payload are scanned |

**Send RHS:** For the `var`-style RHS, use `${name}`; a bare `$name` is not treated as a handle reference in the Node runtime.

**`for_lines`:** The loop source is read as a plain variable value **without** passing through handle resolution. If the source is still a handle token, you get the opaque string (or wrong iteration)—materialize the value first (for example `const text = "${h}"` on an expression RHS, or another step that interpolates the handle) before `for_lines`.

### Passthrough (does not force resolution)

Only the step that **starts** the async work avoids waiting on the result:

| Access pattern | Example | Forces resolution? |
| --- | --- | --- |
| `const` binding from `run async` | `const h = run async foo()` | No — stores the handle token; work is already scheduled |
| Bare `run async` (no capture variable) | `run async bar()` | No read of a value here; the handle still [joins](#implicit-join) at scope end |

Any later use that needs a real string—including the first `${h}` inside a `const` RHS, or passing `h` as a `run` / `ensure` argument—forces resolution. There is no separate “copy handle without reading” statement; aliasing is done by passing the name through steps that eventually interpolate or join.

If resolution fails (non-zero underlying `run`), the step or join fails with the same error shape as a synchronous `run`; the bound variable is cleared to an empty string in the scope where resolution ran.

After a **successful** resolution, the variable holds the result string; further reads are ordinary string reads.

## Implicit join

When the **step list** you are in finishes, the runtime **awaits every `run async` handle** created in that **`executeSteps`** invocation (`localHandleIds` in `node-workflow-runtime.ts`). Await happens **in creation order** (sequential `await`), not with a single `Promise.all`. That is the “implicit join”: it is per **block**, not merely per workflow name—for example, handles created only inside an `if` body are joined at the end of that **inner** list, before control continues after the `if`.

For an **entry** workflow, **inbox dispatch** runs only **after** `executeSteps` returns successfully: the runtime finishes the step list and the implicit join first, then drains the channel queue ([Inbox — drain timing](inbox.md#who-registers-routes-and-who-drains), [Architecture — channels](architecture.md#channels-and-hooks-in-context)).

- If all joined work succeeds, the outer step list continues or the workflow **returns** normally.
- If any joined handle ends with a **non-zero** status, the scope fails; several failures are aggregated in one error. Messages refer to the **`run async`** target ref string(s). Handles that were **never read** still participate in this join.
- If an async branch ends with a **`return`** from a `catch`/`recover` body (the same `recoverReturn` path as synchronous `run`/`ensure`), the join can propagate that **workflow return value** to the parent—mirroring non-async recovery. If multiple branches set `recoverReturn`, the **first** joined branch that does so wins (`returnValue` is only set while still `undefined`).

This preserves the “all async work settled before the workflow could complete” guarantee, while still allowing overlap **until** an explicit read or a scope boundary forces ordering.

## `recover` and `catch`

### `recover` (retry loop)

`recover` on `run async` mirrors non-async `recover`: after a failing run, the runtime executes the **repair** body, then **re-runs** the `run` target, until success or the [recover limit](#retry-limit) is reached. The async branch is scheduled once as a **single** promise; retries happen **inside** that branch.

```jaiph
script flaky = `test -f .marker`
script touch_marker = `touch .marker`

workflow maybe_ok() {
  run flaky()
}

workflow repair() {
  run touch_marker()
}

workflow default() {
  run async maybe_ok() recover(err) {
    log "repairing: ${err}"
    run repair()
  }
}
```

Execution inside the promise:

1. Run the target once (`maybe_ok()`).
2. While the last result is a failure and the repair-cycle count is still within `run.recover_limit`, run the `recover` body with `err` set to the merged **stdout+stderr** of the failure, then **run the target again** unless the repair body failed or used `return` to supply a result.
3. A `return …` from inside the repair body **stops** the loop and becomes the async branch’s result (no further retries of the original target).
4. If the limit is exhausted and the target still fails, the handle result is that failure—like synchronous `recover`.

So the repair body runs only **after** a failing attempt, and each allowed cycle is “repair, then retry,” not “retry, then repair” on the first failure.

### `catch` (single-shot, surface keyword `catch`)

Use `catch` for a **one-time** error handler: if `foo()` fails, the `catch` body runs **once**; there is no automatic retry of `foo()`.

```jaiph
run async foo() catch(err) {
  log "caught: ${err}"
}
```

The `catch` keyword is the user-facing name; the failure payload is the merged **stdout + stderr** text, as in synchronous `run … catch`. If the catch body succeeds without returning, the async branch is treated as **success** for join and handle resolution (status 0)—the original failure is not rethrown. A `return` from the catch body can supply a return value via the same **`recoverReturn`** path as synchronous recovery. See [Language — `catch`](language.md#catch--failure-recovery) and [Grammar](grammar.md).

### Retry limit

Limits apply to the **retry loop** in `recover` (including `run async … recover`).

- **Meaning:** `run.recover_limit` (default **10**) is the maximum number of **repair cycles** the runtime will execute after a failure: each cycle runs the `recover` body (when applicable) and then **re-runs** the target. Including the **first** attempt, the target may run **up to `recover_limit + 1` times** before the loop stops and surfaces the last failure.
- **Config:** `config { run.recover_limit = N }` resolves through the same precedence as other run keys — workflow-level `config` (the workflow currently executing the step) wins over the module-level `config` of the file whose `scope.filePath` is active for that step list, with the default of `10` when neither sets it. That is the file **currently executing** those steps—not necessarily the CLI entry file when you are deep in a nested `run`.

## Progress and events

Concurrent `run async` branches are tagged with a chain of **1-based indices** stored on `STEP_START`, `STEP_END`, `LOG`, and `LOGERR` events as `async_indices`; the CLI prints them as subscript prefixes on the live stream ([Architecture — CLI progress reporting pipeline](architecture.md#cli-progress-reporting-pipeline)). Indexing uses `AsyncLocalStorage` in the runtime so nested async work gets a deeper chain. Resolving a handle does not emit a separate event—the branch’s own step/log events are the timeline.

In **`jaiph test`**, the runner sets `suppressLiveEvents: true` on the in-process runtime ([Architecture — Test runner integration](architecture.md#test-runner-integration-testjh-in-the-kernel)), which silences **`__JAIPH_EVENT__`** on stderr only; durable `run_summary.jsonl` (and handle semantics) behave like `jaiph run`.

PTY E2E coverage for interleaved async progress: `e2e/tests/131_tty_async_progress.sh` ([Testing — PTY-based TTY tests](testing.md#pty-based-tty-tests)).

## Constraints

- **`run async`** is only allowed in **workflows** — not in **rules** (the validator enforces this).
- **`run async`** is **not** supported for **inline scripts** (`` `body`(args) ``, ` ```…``` `, or similar).
- A **`run async`** call must be a **normal reference with parentheses**: `run async name()` or `run async name(args)` — not a bare name.
- There is **no `await` keyword**; you either **read** the value (triggers resolution) or hit a **join** at the [step-list boundary](#implicit-join).
- “Uncaptured” `run async` still **joins**; there is no opt-out to skip waiting at scope end.

### Relationship to the rest of the system

- **Local / Docker / `jaiph test`** share the same [`NodeWorkflowRuntime`](architecture.md#core-components) code path; sandboxing changes **where** the process runs, not how handles are implemented.
- **`buildScripts` / `JAIPH_SCRIPTS`** only materialize **`script`** bodies; `run async` does not add new on-disk artifacts ([Architecture — Emit artifacts](architecture.md#emit-artifacts)).

Integration-style checks for handles and recovery live in `integration/sample-build/recover-handle.test.ts` (e.g. implicit join, passing handles into `run`, `run async … recover`).

If this spec disagrees with **`src/runtime/kernel/node-workflow-runtime.ts`**, trust the source and update [Grammar — `run async`](grammar.md#run-async--concurrent-execution-with-handles) and [Language — `run async`](language.md#run-async--concurrent-execution-with-handles) accordingly.
