---
title: "Spec: Async Handles"
permalink: /spec-async-handles
redirect_from:
  - /spec-async-handles.md
---

# Async Handles — `Handle<T>` Value Model

## Context

Pipelines often wait on work that could overlap: several scripts or workflows are independent, and the author wants the **main sequence** to move on while that work runs. A generic way to do that in Jaiph is **`run async`**: start the callee in parallel, get a value you can read later, and let the runtime guarantee nothing is left dangling when the current **step list** returns.

**This page** is the value model: what `Handle<T>` means, when it becomes a real string, and how `recover` / `catch` and progress reporting interact. Syntax and step forms live in the [Language — `run async`](language.md#run-async--concurrent-execution-with-handles) and [Grammar — `run async`](grammar.md#run-async--concurrent-execution-with-handles) sections. For system layout (AST interpreter, events, `async_indices` on the CLI), see [Architecture](architecture.md).

**Implementation fact:** The behavior is implemented in **`NodeWorkflowRuntime`** — a handle is a tracked in-flight `run` result, joined at the [step list boundary](#implicit-join) that registered it. That is the same in-process runtime as in [Architecture — System overview](architecture.md#system-overview); there is no second execution engine for async work.

## Overview

`run async ref(args)` schedules the same **`run` target** (workflow or script) **without blocking** the current step list. The expression’s value is a **handle**—conceptually `Handle<T>` where `T` is what a synchronous `run` would have produced (return value of a workflow, or trimmed stdout of a script). The handle is materialized in the variable map as an **opaque** string; the first **non-passthrough** use that needs the real value **awaits** the in-flight work and then **replaces** the variable with the resolved string for later reads.

## Handle creation

```jaiph
workflow default() {
  const h = run async foo()
  run async bar()
}
```

- `const h = run async foo()` — `h` holds a handle. Work for `foo()` starts immediately; later steps can run in parallel.
- `run async bar()` — a handle is still created and **tracked** for [implicit join](#implicit-join) even if you do not store it in a variable.

This is not “fire and forget” in a scheduler sense: the runtime **registers** every `run async`, captured or not, and still **joins** it when the [scope below](#implicit-join) allows.

## Resolution

A handle resolves to the `run` result: workflow **`return`**, or **trimmed script stdout** on success; on failure, resolution carries the same failure shape as a synchronous `run` (and can fail the block or the join, depending on where resolution happens). Resolution is triggered on the first **non-passthrough** read of the value.

### Reads that force resolution

| Access pattern | Example | Forces resolution? |
| --- | --- | --- |
| String / template interpolation (including `log` / `fail` / `return` messages) | `log "result: ${h}"` | Yes |
| `run` (or `ensure`) argument strings that use `${var}` | `run downstream("${h}")` | Yes — handles in `${…}` are resolved when args are built |
| `if` subject | `if h == "ok" { ... }` | Yes — subject is read after handle handling |
| `match` subject | `match h { ... }` | Yes |
| Send with a `${var}` payload (or a quoted string containing it) | `findings <- ${h}` | Yes — `${name}` in the RHS is scanned to resolve handles (`findings` is the channel name) |

**Send RHS:** use `${var}` in the `channel <- …` payload (or a quoted string containing `${var}`). Resolution follows the same `${...}`-based path as in other steps; a bare shell-style `$name` in the `var` RHS is not a substitute for `${name}` in the current runtime.

### Passthrough (does not force resolution)

Only the **binding step** that starts the async work is non-blocking:

| Access pattern | Example | Forces resolution? |
| --- | --- | --- |
| Initial handle capture | `const h = run async foo()` | No — stores the handle token; the `run async` has already been scheduled |

Every later use of `h` that goes through the **read** paths in the table above (or any place the runtime must treat `h` as a real string) forces resolution, including the first `${h}` in a `const`, `log`, or `return` string.

After resolution, the variable **holds the string value**; further reads are ordinary string reads (no re-`run`).

## Implicit join

When the **step list** you are in finishes, the runtime **awaits every `run async` handle** that was still registered in that list’s scope. That is the “implicit join”: it is tied to the **`executeSteps` scope** for that block, not only to the outer name of a workflow. For example, handles created only inside an `if` (or a similar inner body) are joined at the end of that **inner** list, before the next line after the `if` runs. Entry workflows [drain the inbox](inbox.md#who-registers-routes-and-who-drains) when their step list ends (and after that join).

- If all joined work succeeds, the outer step list continues or the workflow **returns** normally.
- If any handle finishes with a **non-zero** `run` status, the block fails (or join reports an aggregate error) with a message that references the `run async` **ref** string(s) involved.

This matches the pre-handle model where all async work was effectively awaited before the workflow could complete, but allows overlapping steps **until** a read or a scope boundary forces ordering.

## `recover` and `catch`

### `recover` (retry loop)

`recover` on `run async` mirrors non-async `recover`: on failure, run the **repair** body, then **retry** the `run` target, up to the [recover limit](#retry-limit). The async branch is scheduled once as a **single** promise; retries happen **inside** that branch.

```jaiph
const b1 = run async foo() recover(err) {
  log "repairing: ${err}"
  run fix_it()
}
```

1. The async path runs `foo()`.
2. If `foo()` succeeds, the handle resolves to that success value.
3. If it fails, `err` is the merged **stdout+stderr** of the failure, and the `recover` body runs.
4. If the `recover` body **succeeds** (status 0 and no `return` from the repair), `foo()` is run again.
5. Steps 3–4 repeat until `foo()` succeeds or the [recover limit](#retry-limit) is exhausted; then the handle result reflects the final **failure** (or last attempt), like synchronous `recover`.

### `catch` (single-shot, surface keyword `catch`)

Use `catch` for a **one-time** error handler: if `foo()` fails, the `catch` body runs **once**; there is no automatic retry of `foo()`.

```jaiph
run async foo() catch(err) {
  log "caught: ${err}"
}
```

The `catch` keyword is the user-facing name; the same failure-binding pattern applies as for synchronous `run … catch` (see [Language — `catch`](language.md#catch--failure-recovery) and the `run … catch` section in [Grammar](grammar.md)).

### Retry limit

- **Default limit:** **10** when the module’s metadata does not set `run.recover_limit`.
- **Config:** **`run.recover_limit = N` in the file’s top-level `config { }`**. The runtime currently reads this from the **module** (the `.jh` file’s `config` block), not from a per-workflow `config` nested inside a workflow body.

## Progress and events

Async work uses the same **subscripted branch** model as before: each nested or concurrent `run async` level has a 1-based index chain (`async_indices` on step/log events; see [Architecture — CLI progress reporting pipeline](architecture.md#cli-progress-reporting-pipeline)). The CLI’s progress tree indents and labels those branches; resolving a handle does not add a separate “resolution” event beyond the branch’s own step/log events.

A PTY-based E2E test exercises TTY output for two concurrent async branches: `e2e/tests/131_tty_async_progress.sh` (summary in [Testing — PTY-based TTY tests](testing.md#pty-based-tty-tests)).

## Constraints

- **`run async`** is only allowed in **workflows** — not in **rules** (the validator enforces this).
- **`run async`** is **not** supported for **inline scripts** (`` `body`(args) ``, ` ```…``` `, or similar).
- A **`run async`** call must be a **normal reference with parentheses**: `run async name()` or `run async name(args)` — not a bare name.
- There is **no `await` keyword**; you either **read** the value (triggers resolution) or hit a **join** at the [step-list boundary](#implicit-join).
- “Uncaptured” `run async` still **joins**; there is no opt-out to skip waiting at scope end.

### Relationship to the rest of the system

- **Local / Docker / tests** — the same [Node workflow runtime](architecture.md#core-components) runs `run async` everywhere; Docker and `jaiph test` do not use a different handle implementation.
- **Script extraction** is unchanged: only script **bodies** are materialized for `JAIPH_SCRIPTS`; `run async` remains orchestration, not a new artifact type (see [Architecture](architecture.md#emit-artifacts)).

If this spec and `src/runtime/kernel/node-workflow-runtime.ts` disagree, the source is authoritative; keep [Grammar](grammar.md#run-async--concurrent-execution-with-handles) and [Language](language.md#run-async--concurrent-execution-with-handles) aligned when you change behavior.
