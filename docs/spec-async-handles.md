---
title: "Spec: Async Handles"
permalink: /spec-async-handles
diataxis: explanation
redirect_from:
  - /spec-async-handles.md
---

# The async handle value model

Some programs reach a point where two pieces of work do not depend on each other. For example, an analysis and a build can run at the same time. To let the two overlap, the runtime has to start each piece of work without waiting for it, and it still has to wait for every started piece to finish before the run ends.

Jaiph provides `run async` and a value type called `Handle<T>` for overlapping independent work. The value model covers what a handle represents, when it turns into a real string, and how it interacts with recovery and joins. For the surface syntax see [Language, `run async`](language.md#run-async-concurrent-execution-with-handles) and [Grammar, `run async`](grammar.md). For the runtime implementation see [Architecture, Core components](architecture.md#core-components).

## What a handle is

`run async ref(args)` schedules the same target a synchronous `run` would have called, either a def or a script, but it does not block the current step list. The return value is a `Handle<T>`, where `T` is whatever a synchronous `run` would have produced, which is a def's `return` value, or a script's trimmed stdout on success.

In the runtime variable map the handle is stored as an opaque token of the form `__JAIPH_HANDLE__<id>`. The token is bookkeeping, not a value. The first step that needs the value awaits the scheduled work and then replaces the binding with the resolved string. After that, the variable behaves like any other string.

The model separates when work starts from when its value is read:

1. **Eager start.** Work is scheduled the moment `run async` runs.
2. **Lazy resolve.** The handle is not the value yet. The token can stay in its binding while later steps run, and the wait happens at the first resolving read or at the implicit join.

Separating the start from the read is what lets `run async` overlap work. You start the work and keep going, and you only wait at the step that depends on the result.

## Passthrough versus reads that force resolution

The runtime scans for `${name}` substrings in the places where a handle's contents would matter, and it resolves any binding that still holds a token. There are two cases:

- **Passthrough.** The step does not look at the value. For example, the `const h = run async foo()` binding itself keeps the token in the variable until something reads it, and a bare `run async` with no capture variable still tracks the handle for the implicit join.
- **Resolving reads.** The step needs the string. A resolving read is any of the following:
  - a `${h}` interpolation, such as `log "result: ${h}"`, a send right-hand side, a prompt body, or a shell one-liner;
  - passing `h` as an argument to `run`, since bare-identifier args are rewritten as `${name}` before the call;
  - using `h` as the subject of `if` or `match`;
  - a bare-identifier `const h2 = h1`, which the parser treats as `"${h1}"`.

There is no `await` keyword, and there is no way to copy a handle without reading it. To keep work overlapping, read the handle late. Hold it in the original binding, and avoid `${…}`, bare-identifier arguments to `run`, and `if` or `match` subjects until you need the value. When a resolving read reaches a handle whose underlying `run` failed with a non-zero exit, the read itself fails. The error then propagates exactly like a failed synchronous `run`, and the reading step does not continue with an empty value. As a side effect of the failed resolve, the runtime empties the handle's binding in that scope.

`for_lines` is the one exception. It reads the loop source as a plain variable value and does not pass it through handle resolution. If the source is still a handle token, the loop reads the token itself and iterates over the wrong text. Resolve the value first with `const text = "${h}"`, then iterate over `text`.

## Implicit join

When a step list runs to its normal end, meaning every step ran without an early `return`, `fail`, or error exit, the runtime awaits every `run async` handle created in that list, whether or not it was captured. The runtime calls the wait the implicit join, and the unit of joining is one `executeSteps` call, not the whole def. A handle created inside an `if` body is joined at the end of that inner block, before control continues after the `if`. An early `return` or `fail` leaves the list right away and does not run the join for handles already scheduled there.

The rule that uncaptured handles still join is part of the value model. On the normal-exit path there is no opt-out, so starting async work without storing the handle does not skip the wait. The runtime keeps a list of every handle created in the current step list, and on normal exit it awaits each one in creation order, one at a time.

The guarantee is simple. When a step list reaches its normal end, every piece of async work it scheduled has finished. The rest of the program, including return values, channel drains, and parent step lists, can then treat the work as complete without tracking background tasks. For an entry def frame the order is fixed. First the step list runs, then the implicit join runs, and then that frame's channel queue drains (see [Inbox](inbox.md)). If several joined branches end with a `catch` `return`, the first such branch in creation order supplies the parent def's return value. Only `catch` return values propagate this way. A value returned from a `recover` body settles that branch, but the runtime does not adopt it as the parent return.

If any joined handle ended with a non-zero status, the join itself fails. When several handles fail, the runtime combines them into a single error.

## Recover and catch on async handles

Async handles work with the same two error-handling forms that a synchronous `run` uses:

- **`recover` is a retry loop.** After a failed attempt, the repair body runs and the runtime retries the target, until it either succeeds or reaches the recover limit (`run.recover_limit`, default 10). On `run async`, the whole loop runs inside the single async branch, and it does not fan out into separate attempts.
- **`catch` is a one-shot handler.** If the target fails, the catch body runs once. If the catch body succeeds, the join counts the async branch as successful. If the catch body ends with a `return`, that value becomes the branch's contribution to a parent def return.

Both forms work only with the statement form of `run async`. A captured `const h = run async foo()` cannot carry a `recover` or `catch` block, because the parser allows only a plain call there. If you need both a captured handle and a recover loop around its target, wrap the target in a separate def and call that.

## Why there is no `await` keyword

`await` is not part of the language because the implicit join already marks the synchronization point on the normal-exit path, which is the end of the step list. Adding `await` would create a second way to express the same boundary. It would also add a third state, "started but neither read nor joined yet", that you would have to reason about. The model keeps only two states, a token in the variable map or a resolved string, which keeps the number of failure modes small.

The trade-off is that overlapping a long-running async task with later steps takes care. Read the handle late rather than early, because an early read makes the def wait at that point and removes the overlap.

## Where async handles are allowed

`run async` is allowed in any `def`:

- **Inline scripts reject it.** Inline `` run `body`(args) `` is shorthand for a one-off shell step, and running it with `run async` is not supported. Move the body into a named `script` and call `run async` on that script.
- **A `run async` call must be a real reference with parentheses.** A bare name cannot be run with `run async`.

The parser or the validator enforces both restrictions at compile time, not at runtime.

## Async indices and the progress tree

The runtime tags each concurrent branch with a chain of 1-based indices. It stores the chain as `async_indices` on the `STEP_START`, `STEP_END`, `LOG`, `LOGWARN`, and `LOGERR` events. The CLI shows the chain as a subscript prefix on the live event stream, so interleaved branches stay readable in the progress tree. The runtime builds the chain with `AsyncLocalStorage`, so nested async work, such as a `run async` inside another `run async`, gets a deeper chain instead of colliding with its parent.

Resolving a handle does not emit a separate event. The branch's own step and log events are the timeline, and the resolve is only the point where one consumer stopped passing the token along.

## The design in short

Async handles in Jaiph are a token bookkeeping model built on top of a normal `run`. They start eagerly, resolve lazily, and must be joined when a step list reaches its normal end. Once resolved, they behave like any other synchronous value. There is no scheduler, no thread pool, no `await`, and no detached background task. The model is a small contract that lets steps overlap until a step needs the answer.

## Related

- [Run work concurrently](async.md) is the operator recipe (late reads, recover, `for` pitfall).
- [Inbox](inbox.md) covers the drain step that runs after the implicit join.
- [Architecture, CLI progress reporting pipeline](architecture.md#cli-progress-reporting-pipeline) covers how `async_indices` shape the live progress tree.
- [Language, `run async`](language.md#run-async-concurrent-execution-with-handles) and [Grammar, `run async`](grammar.md) cover the surface syntax.
