---
title: Inbox & Dispatch
permalink: /inbox
redirect_from:
  - /inbox.md
---

# Inbox & Dispatch

Multi-step automation often splits work across workflows: one stage produces a
result, another should run only after that result exists. Instead of gluing
stages together with temporary files and shell scripts, Jaiph provides a
first-class **inbox** — a logical channel between workflows with no external
message broker. One workflow **sends** a message (`<-`); another is
**dispatched** when the orchestrator drains the queue (`->`). The runtime owns
routing and ordering.

The Node workflow runtime (`NodeWorkflowRuntime`) keeps an **in-memory** queue
and route map per entered workflow. Each send also writes a durable copy to
`inbox/NNN-<channel>.txt` under the run directory for audit and reporting —
channel transport is queue-based, not filesystem-driven. There are no directory
watchers, no polling loops, and no third-party brokers.

## At a glance

```jh
channel findings

workflow researcher {
  findings <- "## analysis results"
}

workflow analyst {
  log "Received: ${arg1}"
}

workflow default {
  run researcher()
  findings -> analyst
}
```

`researcher` sends data to the `findings` channel. The `default` workflow
routes `findings` messages to `analyst`, which receives `${arg1}` = message,
`${arg2}` = channel, `${arg3}` = sender (see [Trigger contract](#trigger-contract)).

## Design principles

- **Inbox is an event bus, not a filesystem watcher.** Delivery is driven by an
  explicit **drain** after the orchestrator workflow's steps finish — no
  `inotifywait`, no `fswatch`, no polling for new files.
- **Sequential by default, parallel opt-in.** For each queued message, route
  targets run **in list order** unless `run.inbox_parallel = true` or
  `JAIPH_INBOX_PARALLEL=true` (see [Parallel dispatch](#parallel-dispatch)).
- **Inbox is scoped per run.** Message files live under that run's **`inbox/`**
  directory; they are not a separate mailbox outside `.jaiph/runs`.

## Syntax

### Channel declarations: `channel <name>`

Declare channels at top level, one per line:

```jh
channel findings
channel report

workflow default { ... }
```

Every channel used by send (`<-`) or route declarations (`->`) must be defined
in the current module or imported from another module (e.g. `shared.findings`).
Undefined channels fail validation with:

- `Channel "<name>" is not defined`

### Send operator: `<channel_ref> <- <rhs>`

The channel reference is always on the left side of the `<-` operator. Valid
channel forms:

- local channel: `findings`
- imported channel: `shared.findings`

The send step resolves the message from the **RHS**, writes the payload to the
next inbox file on disk, and appends to the **in-memory** queue of the workflow
context selected by the routing rule (innermost matching route on the stack, or
the sender's own context if none match — see
[Runtime dispatch](#runtime-dispatch)).

Valid RHS forms:

| RHS form | Example | Behavior |
|---|---|---|
| Double-quoted literal | `findings <- "## results"` | Interpolated string |
| Variable expansion | `findings <- ${var}` | Value of the variable |
| `run` capture | `findings <- run build_msg()` | Return value or trimmed stdout of the workflow/script |
| Empty (forward) | `findings <-` | Forwards the workflow's `${arg1}` |

The RHS does **not** accept raw shell commands — see
[Grammar — Managed calls vs command substitution](grammar.md#managed-calls-vs-command-substitution).

```jh
channel findings

workflow researcher {
  findings <- "## findings"
}
```

If no RHS follows `<-`, the workflow's `${arg1}` argument is forwarded:

```jh
channel findings

workflow forwarder {
  findings <-
}
```

The `<-` operator is only recognized when it appears outside of quoted strings
on the surrounding line so channel names and literals are not misread as send
syntax.

Send and route parsing rules are specified in
[Grammar — Parse and runtime semantics](grammar.md#parse-and-runtime-semantics).

### Route declaration: `<channel_ref> -> <workflow>`

Tells the runtime: when a message arrives on that channel, call each listed
**workflow** with positional args `${arg1}=message`, `${arg2}=channel`,
`${arg3}=sender`.

Targets must be **workflows** (local or imported as `alias.name`). **Rules**
and **scripts** are not valid route targets — the compiler uses workflow-only
reference checks, so a bad target is **`E_VALIDATE`** with messages such as
`unknown local workflow reference "…"`, `imported workflow "…" does not exist`,
`rule "…" must be called with ensure`, or `script "…" cannot be called with run`.
A name that is not a valid `alias.name` / `name` pattern fails at parse time as
**`E_PARSE`** `invalid workflow reference in route: "…"`.

```jh
channel findings
channel summary

workflow default {
  run researcher()
  findings -> analyst
  summary -> reviewer
}
```

**Multiple targets on one line** are comma-separated — they share one route and
dispatch in **declaration order** (or concurrently when parallel dispatch is on):

```jh
findings -> analyst, reviewer
```

**Repeated `channel ->` lines for the same channel:** in `NodeWorkflowRuntime`,
route entries are stored in a `Map` keyed by channel. The runtime calls
`routes.set(channel, targets)` for each route declaration, so **the last route
line for a given channel wins** (later lines replace the target list for that
key). To attach several targets, prefer `channel -> wf1, wf2, …` on a single
line rather than multiple lines for the same channel.

Route declarations are static routing rules, not executable statements. They are
stored in `routes` on the workflow definition, not in `steps`. The compiler
validates that all target workflow references exist.

### Capture + send is a parse error

```jh
# E_PARSE: capture and send cannot be combined; use separate steps
name = channel <- cmd
```

Use two steps instead:

```jh
const payload = run build_message()
channel <- "${payload}"
```

## Inbox layout

Under the run directory (see [Architecture — Artifact layout](architecture#artifact-layout)):

```
.jaiph/runs/<YYYY-MM-DD>/<HH-MM-SS>-<source-basename>/inbox/
  001-findings.txt
  002-summary.txt
  003-findings.txt
  ...
```

Each message is a file named `NNN-<channel>.txt` where `NNN` is a zero-padded
sequence for that run (monotonic on the runtime instance via `inboxSeq`). The
orchestration queue itself is **in memory**; these files are the durable copy
of the payload.

## Runtime dispatch

### Who registers routes and who drains

Every entered workflow gets a **`WorkflowContext`**: a route map (from `->` lines)
and a message queue. **Route declarations are registered when the workflow
starts.** After the workflow's **steps** finish (including the implicit join for
`run async` branches), the runtime runs `drainWorkflowQueue` for that context.

Nested workflows invoked with `run` share a **workflow context stack**. On
**send**, the runtime looks for a route for that channel starting at the
**sending workflow** (innermost on the stack) and moving **outward** toward the
entry workflow. The **first** context that declares a route for the channel gets
the enqueue — so a **nested** workflow's own `channel -> …` lines take
precedence over an **outer** orchestrator's routes for the same channel. If
**no** workflow on the stack declares a route, the message is queued on the
**sender's** context; when that context is drained, there are no targets and the
message is **skipped** (see [Error semantics](#error-semantics)).

### Dispatch loop

Implementation: `src/runtime/kernel/node-workflow-runtime.ts` — `send` step
handling and `drainWorkflowQueue`.

1. On workflow entry, push a `WorkflowContext` (route map, empty queue).
2. Route declarations (`->`) populate the context's route map (last entry per
   channel wins if the same channel appears on multiple lines — see above).
3. Execute workflow steps top to bottom.
4. On `<-`: resolve payload, allocate the next sequence id from `inboxSeq`,
   append `InboxMsg` to the selected context's queue, write
   `inbox/NNN-<channel>.txt`, and append `INBOX_ENQUEUE` to `run_summary.jsonl`.
5. After all steps (and implicit `run async` joins) complete,
   `drainWorkflowQueue`:
   - `while (cursor < queue.length)` — new sends during dispatch append to the
     same queue and are processed in subsequent iterations.
   - For each message, look up targets for `channel` on **that** workflow's
     context. If there is no route, **skip** (silent drop).
   - If there are targets, invoke each target with `${arg1}` / `${arg2}` /
     `${arg3}` — **sequentially** in target-list order by default, or **all
     targets concurrently** via `Promise.all` when `JAIPH_INBOX_PARALLEL=true`
     (see [Ordering guarantees](#ordering-guarantees)).
6. Pop the workflow context and return.

There is no `E_DISPATCH_DEPTH` / `JAIPH_INBOX_MAX_DISPATCH_DEPTH` check in
`NodeWorkflowRuntime`'s drain loop. Avoid unbounded circular sends in orchestration.

### Implementation notes

- Routes and the pending queue are **in-memory** on `WorkflowContext`. Message
  files under `inbox/` are written on send for audit; routing uses the queue.
- **Sender identity** is the **current workflow name** from the context that
  performed the send (e.g. `researcher`), stable across modules.

## Parallel dispatch

When `run.inbox_parallel = true` is set in a `config` block (module or workflow
scope) or the environment sets `JAIPH_INBOX_PARALLEL=true`, **all targets listed
for a single message** are dispatched concurrently (via `Promise.all` in
`drainWorkflowQueue`) instead of awaiting each target in order.

**Precedence** matches the rest of Jaiph agent/run settings: an explicit
environment value wins over in-file config. See [Configuration — Defaults and precedence](configuration.md#defaults-and-precedence).

```jh
config {
  run.inbox_parallel = true
}

workflow default {
  run producer()
  findings -> analyst, reviewer   # analyst and reviewer run in parallel
}
```

### Ordering guarantees

Messages are handled **one at a time** in queue order (FIFO). **Parallel mode**
only parallelizes **targets for the same message**; the next message is not
started until the current message's targets have all finished (`Promise.all`
completes). Within **sequential** mode, targets for that message run strictly in
list order.

- **Non-determinism:** With `JAIPH_INBOX_PARALLEL=true`, the order in which
  concurrent targets finish is undefined; only the per-message barrier is
  guaranteed before the next message runs.
- **Sequence ids:** Monotonic per run in the runtime (`inboxSeq`); message
  filenames use the same padded counter.

### Failure propagation

In parallel mode, all targets for a message are awaited together. If any target
exits non-zero, the owning workflow fails after all concurrent targets complete
(analogous to `Promise.all` failure semantics vs sequential fail-fast).

### Rollback

To revert to sequential dispatch, remove `run.inbox_parallel = true` from config
or set `JAIPH_INBOX_PARALLEL=false` in the environment. Sequential mode is the
default.

## Error semantics

- **Undefined channel reference:** validation error `Channel "<name>" is not defined`.
- **Dispatched workflow exits non-zero:** the owning workflow fails. In
  **sequential** mode the first failing target stops further targets for that
  message. In **parallel** mode all targets for that message are awaited, then
  the run fails if any failed.
- **No route for a channel:** the message file and queue entry still exist, but
  dispatch **skips** that message (silent drop). This is intentional for optional
  subscribers; use a dedicated workflow if missing handlers should be an error.
- **Circular sends:** the in-memory queue can grow without a built-in iteration
  cap in `NodeWorkflowRuntime`. Avoid circular sends that grow the queue without bound.

## Trigger contract

Routed receivers get three positional arguments:

| Arg       | Value                                                         |
|-----------|---------------------------------------------------------------|
| `${arg1}` | Message payload (content sent to the channel)                 |
| `${arg2}` | Channel name (e.g. `findings`)                              |
| `${arg3}` | Sender name (the **workflow name** that performed the send) |

The environment variables `JAIPH_DISPATCH_CHANNEL` and `JAIPH_DISPATCH_SENDER`
are **not** set by `NodeWorkflowRuntime`; receivers get channel and sender via
`${arg2}` and `${arg3}`.

- **`run_summary.jsonl`:** `NodeWorkflowRuntime` appends `INBOX_ENQUEUE`,
  `INBOX_DISPATCH_START`, and `INBOX_DISPATCH_COMPLETE` via
  `appendRunSummaryLine` (see [CLI — Run summary](cli.md#run-summary-jsonl)).
  `INBOX_DISPATCH_COMPLETE` includes `elapsed_ms`. For `INBOX_ENQUEUE`
  from `jaiph run`, the line includes `channel`, `sender`, and
  `inbox_seq`. The full message body is always available on disk at
  `inbox/NNN-<channel>.txt`.
- Workflows remain directly callable: `jaiph run analyst "some content"`. When
  called directly, `${arg2}` and `${arg3}` are unset.

## Progress tree integration

- Route declarations appear as nodes in the progress tree where the static tree
  is derived from the AST.
- Dispatched workflows appear like other `run` steps, with `arg1`–`arg3`
  shown as positional parameters (e.g.
  `workflow analyst (1="…", 2="findings", 3="scanner")`). The Node runtime does
  not add a separate `dispatched` flag to `STEP_START`/`STEP_END` payloads
  for inbox routing.
- Dispatched step output follows the same artifact rules as other managed steps.
  Use `log` inside the receiver to surface lines in the tree. The runtime
  embeds stdout in `STEP_END` (`out_content`) with the same JSON escaping
  rules as other steps.
- For a browsable history of past runs, use [`jaiph report`](cli.md#jaiph-report)
  (see [Reporting server](reporting.md)).

### Example output

Illustrative progress tree for a pipeline where `researcher` sends on
`findings`, `analyst` sends on `report`, and `default` routes both channels:

```
workflow default
  ▸ workflow researcher
  ✓ workflow researcher (0s)
  ▸ workflow analyst (1="Found 3 issues in auth module", 2="findings", 3="researcher")
  ✓ workflow analyst (0s)
  ▸ workflow reviewer (1="Summary: Found 3 issues in auth ...", 2="report", 3="analyst")
  ✓ workflow reviewer (0s)
✓ PASS workflow default (0.1s)
```
