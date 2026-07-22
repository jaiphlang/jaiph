---
title: "Spec: Async Handles"
permalink: /spec-async-handles
diataxis: explanation
redirect_from:
  - /spec-async-handles.md
---

# Async Handles — the value model

Many workflows have a moment where two pieces of work are independent: an analysis and a build, two prompts with different backends, a slow fetch alongside cheap local checks. They could overlap, but only if the runtime keeps track of every started piece of work and refuses to let the workflow complete until each one has resolved.

Jaiph addresses this with **`run async`** and a value type called `Handle<T>`. This page is about the *value model* — what a handle represents, when it becomes a real string, and how that interacts with recovery and joins. For the surface syntax see [Language — `run async`](language.md#run-async-concurrent-execution-with-handles) and [Grammar — `run async`](grammar.md); for the runtime implementation see [Architecture — Core components](architecture.md#core-components).

## What a handle is

`run async ref(args)` schedules the same target a synchronous `run` would have called — a workflow or a script — but does **not block** the current step list. The return value is a `Handle<T>`, where `T` is whatever a synchronous `run` would have produced (a workflow's `return`, or a script's trimmed stdout on success).

In the runtime variable map the handle is stored as an opaque token of the form `__JAIPH_HANDLE__<id>`. That token is bookkeeping, not a value. The first place that actually *needs* the value awaits the scheduled work, then **replaces** the binding with the resolved string. After that, the variable behaves like any other string.

The model has two ideas that are easy to mix up:

1. **Eager start.** The moment `run async` executes, the work is scheduled. The handle is the receipt.
2. **Lazy resolve.** The handle is not the value yet. The token can sit in its binding while later steps run; the wait happens at the first resolving read or at the implicit join.

This split is what makes `run async` cheap to write. You start work and continue. You only pay the wait cost where you genuinely depend on the result.

## Passthrough vs reads that force resolution

The runtime scans for `${name}` substrings in the places where a handle's contents would actually matter, and resolves any binding that still holds a token. The dividing line is:

- **Passthrough** — the step does not look at the value. Examples: the `const h = run async foo()` binding itself (the token stays in the variable until something reads it); a bare `run async` with no capture variable (the handle is still tracked for the implicit join).
- **Resolving reads** — the step needs the string. Examples: any `${h}` interpolation (`log "result: ${h}"`, send RHS, prompt body, shell one-liner); passing `h` as an argument to `run` or `ensure` (bare-identifier args are rewritten as `${name}` before the call); using `h` as the subject of `if` / `match`; a bare-identifier `const h2 = h1` (parser sugar for `"${h1}"`).

There is no `await` keyword and no copy-without-reading form. To keep work overlapping, read the handle late: hold it in the original binding and avoid `${…}`, bare-identifier args to `run`/`ensure`, or `if`/`match` subjects until you need the value. When a resolving read hits a handle whose underlying `run` failed (non-zero exit), the read itself fails and that error propagates exactly like a failed synchronous `run` — the reading step does not silently continue with an empty value. (The handle's binding is emptied in that scope as a side effect of the failed resolve.)

`for_lines` is the one surprising exception: it reads the loop source as a plain variable value *without* passing through handle resolution. If the source is still a handle token, the loop sees the token and iterates wrong. Materialize the value first (`const text = "${h}"`) before iterating.

## Implicit join

When a step list **runs through to its normal end** — every step executed without an early `return`, `fail`, or error exit — the runtime **awaits every `run async` handle created in that list**, captured or not. This is the implicit join, and the unit of joining is the `executeSteps` invocation, not the workflow. Handles created inside an `if` body are joined at the end of that inner block, before control continues after the `if`. An early `return` or `fail` exits the list immediately and does **not** run the join for handles already scheduled there.

The "uncaptured handles still join" rule is part of the value model. There is no opt-out on the normal-exit path: starting async work without storing the handle does not skip the wait. The runtime keeps a list of every handle created in the current step list and walks it on normal exit, in creation order, awaiting each one sequentially.

The guarantee this preserves is straightforward: when a step list reaches its normal end, **every piece of async work it scheduled has settled**. That is the property that lets the rest of the workflow — return values, channel drains, parent step lists — reason about completion without thinking about background tasks. For an entry workflow frame, the order is: the step list runs, the implicit join runs, *then* that frame's channel queue drains ([Inbox](inbox.md)). If several joined branches end with a `catch` `return`, the first such branch in creation order supplies the parent workflow return value. (Only `catch` return values propagate this way; a value returned from a `recover` body settles that branch but is not adopted as the parent return.)

If any joined handle ended with a non-zero status, the join itself fails; multiple failures are aggregated into a single error.

## Recover and catch on async handles

Async handles compose with the same two error-handling forms that synchronous `run` uses:

- **`recover` is a retry loop.** After a failed attempt, the repair body runs and the target is retried, until either it succeeds or the recover limit is exhausted (`run.recover_limit`, default 10). On `run async`, the entire loop runs *inside the single async branch* — it is not a fan-out of attempts.
- **`catch` is a one-shot handler.** If the target fails, the catch body runs once. If catch succeeds, the async branch is considered successful for the join. If catch ends with a `return`, that value becomes the branch's contribution to a parent workflow return.

These compose only with the **statement form** of `run async`. A captured `const h = run async foo()` cannot carry a `recover` or `catch` block — the parser allows only a plain call there. Use a separate workflow that wraps the recovery if you need both a captured handle and a recover loop around its target.

## Why no `await` keyword

The reason `await` is not part of the language is that the implicit join already makes the synchronization point clear on the normal-exit path: it is the end of the step list. Adding `await` would create a second way to express the same boundary and a third state ("started but neither read nor joined yet") that users would have to reason about. Keeping the model to two states — token in the variable map, or resolved string — keeps the failure modes small.

The trade-off is that overlapping a long-running async task with subsequent steps requires care: read the handle late, not early, or the read becomes a serializing point.

## Where async handles are allowed

`run async` is intentionally a **workflow-only** construct:

- **Rules reject statement-form `run async`.** The validator emits `E_VALIDATE` for `run async ref(…)` in a rule body. The primitive is defined for workflows only — fan-out without an explicit join inside a rule body would break the read-only rule contract.
- **Inline scripts reject it.** Inline `run \`body\`(args)` is shorthand for a one-off shell step; spawning it with `run async` is not a supported shape. Move the body into a named `script` and `run async` that.
- **A `run async` call must be a real reference with parentheses.** Bare names are not async-able.

These restrictions are enforced at compile time (parser or validator), not at runtime.

## Async indices and the progress tree

Concurrent branches are tagged with a chain of 1-based indices stored on `STEP_START`, `STEP_END`, `LOG`, `LOGWARN`, and `LOGERR` events as `async_indices`. The CLI renders them as subscript prefixes on the live event stream, so interleaved branches stay legible in the progress tree. Indexing uses `AsyncLocalStorage` in the runtime, which means nested async work — a `run async` inside a `run async` — gets a deeper chain rather than colliding with its parent.

Resolving a handle does **not** emit a separate event. The branch's own step and log events are the timeline; the resolve is just the point where a particular consumer stopped passing the token along.

## Why this design, in one paragraph

Async handles in Jaiph are a token bookkeeping model on top of normal `run`. They are eager to start, lazy to resolve, mandatory to join when a step list reaches its normal end, and otherwise indistinguishable from synchronous values once they have resolved. There is no scheduler, no thread pool, no `await`, no detached "fire and forget" — just a small contract that lets steps overlap until something genuinely needs the answer.

## Related

- [Inbox & Dispatch](inbox.md) — the drain step that runs *after* the implicit join.
- [Architecture — CLI progress reporting pipeline](architecture.md#cli-progress-reporting-pipeline) — how `async_indices` shape the live progress tree.
- [Language — `run async`](language.md#run-async-concurrent-execution-with-handles) and [Grammar — `run async`](grammar.md) — surface syntax.
