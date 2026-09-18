# Jaiph Improvement Queue (Hard Rewrite Track)

This file is a generated view. Do not edit it. Do not agent-edit it.
Use the product-owner defs (`propose_task`, `update_task`, `pick_task`,
`report_completed_task`, `task_details`) via `jaiph serve` / MCP.

Process rules:

1. `pick_task` prefers the first `#dev-ready` task that is not `#in-progress`.
   The product owner may claim a later available task instead.
2. The first `##` section is the preferred next task in this view.
3. `#dev-ready` means ready to implement. `#in-progress` means claimed by `pick_task`.
4. Runtime mutations go through the product-owner defs only.
5. Every task must be standalone: no hidden assumptions, no "read prior task".
6. Hard rewrite semantics: breaking changes are allowed unless a task says otherwise.
7. Acceptance criteria are non-negotiable. A task is not done until every
   acceptance bullet is verified by a test that fails when the contract is violated.

## Stream stdin pipelines with bounded buffers and overlap #dev-ready

A stdin pipeline must move bytes between stages through a bounded buffer (OS pipe or equivalent), not by collecting one stage’s full stdout into a JavaScript string and then `stdin.end(whole)`. Producer and consumer overlap.

Value model (restate): a call result is an **output handle**. Uncaptured pipeline stages do **not** slurp. `const n = stdin foo() -> count()` **does** slurp the last stage (a reduce — small). Statement / uncaptured `stdin foo() -> bar() -> baz()` must not build those bodies as JS strings.

Surface this task requires (same form; no `|`, no hidden temp-file UX). If the grammar does not have it yet, **add it** — do not wait, do not invent a different syntax:

```jh
stdin foo() -> bar()
stdin wrap() -> analyze()          # def producer
stdin foo() -> bar() -> baz()
stdin content -> bar() -> baz()
```

Rules (restate): producer is a value or a **def/script** call; every stage after the first `->` is a **script**; `async` + stdin is `E_PARSE`; **no `recover` on a pipeline** (compiler error). `catch` may attach.

Do not add a stringify size cap. Size must not change whether a pipeline **succeeds**. `const` of a huge last stage may OOM — that is slurp, not this task’s volume pin.

The product case is a 50 MB log through `stdin fetch() -> analyze()`. The volume test is a correctness proof.

This task does not add `examples/stream.jh` or a new landing tab. If that sample already exists, do not rewrite it unless the progress tree forces a match update.

### Overlap (sleeps)

E2e that fails if stages are sequential materialize-then-spawn:

- Producer is **line-buffered / unbuffered** (`stdbuf -oL`, `python3 -u`, or equivalent). Document which (test Jaiph, not libc).
- Producer prints `start`, sleeps ~2s, prints `end`.
- Consumer prints `saw <line>` as each line arrives.
- `saw start` is observed **before** the sleep finishes / before the producer exits.

Do not use a tiny payload that fits in the OS pipe buffer and a consumer that only reads after EOF.

### Volume

≥ 64 MiB (1 GiB optional if CI allows). Producer writes N bytes; consumer counts or writes a file (reduce / sink). Assert:

- consumer sees exactly N bytes
- jaiph peak extra RSS does not track N (bound e.g. extra RSS < 16 MiB)

Do not spool the whole payload into one runtime-owned temp file and reread it. Per-stage `.out` only if streamed to disk with backpressure and **not** also held as a string. If `.out` would force a full in-memory copy, skip full-body capture for uncaptured piped stages and say so in `docs/language.md` (one owner, one sentence + link to Value types / stdin).

### Files that must not change

- Landing `stream` sample copy unless the tree output is forced to change.
- Argv/`ARG_MAX` for non-pipeline `script(arg)`.
- Prompt backends.
- Do not make `const` lazy (skip the call).
- Do not add `read()`.

### Acceptance

A task is not done until every bullet is verified by a test that fails when the contract is violated:

- Sleep/overlap e2e fails if the runtime slurps `foo()` to a string, then spawns `bar()` with `stdin.end(thatString)`.
- Volume e2e fails if the runtime concatenates the payload (`output += chunk` across producer stdout) or peak extra RSS tracks N.
- Uncaptured piped stages have no full-body JS string.
- Small regression: `stdin foo() -> bar() -> baz()` with a reduce last stage still shows the same user-visible result as a correct sequential pipe.
- `const n = stdin foo() -> count()` on a tiny fixture still yields the count string (slurp of the last stage is required, not forbidden).
- `docs/language.md` states uncaptured pipeline stages stream; `.out` is disk-only when captured for audit.
