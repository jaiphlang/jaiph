---
title: Inbox & Dispatch
permalink: /inbox
redirect_from:
  - /inbox.md
---

# Inbox & Dispatch

## What this is for

Multi-step automation often splits work across several workflows: one stage
produces a result, another stage should run only after that result exists.
You could glue stages together with temporary files and shell glue, but
that is easy to get wrong (races, stale paths, unclear ownership).

Jaiph instead offers a first-class **inbox**: a logical channel between
workflows (no external message broker). One workflow **sends** a message (`<-`);
another is **dispatched** when the orchestrator drains the queue (`->`). The
runtime owns routing and ordering. Implementation-wise, the queue, sequence
counter, route table, and message bodies live **under the current run directory**
on disk so sends survive subshell boundaries; there are still no directory
watchers, no polling loops waiting on the filesystem, and no third-party brokers.

## At a glance

One workflow produces output with the **send operator** (`<-`), another
reacts to it via a **route declaration** (`->`). The runtime handles
dispatch — no file watchers, no polling, no external message brokers.

Send (`<-`), routes (`->`), and related parsing rules are specified in
[Grammar — Parse and runtime semantics](grammar.md#parse-and-runtime-semantics).
The **right-hand side** of `<-` may be only a double-quoted literal, `$var` / `${…}`,
`run ref [args]`, or empty (forward `$1`) — not a raw shell command; see
[Grammar — Managed calls vs command substitution](grammar.md#managed-calls-vs-command-substitution).

```jh
channel findings

workflow researcher {
  findings <- "## analysis results"
}

workflow analyst {
  log "Received: $1"
}

workflow default {
  run researcher
  findings -> analyst
}
```

In this example, `researcher` sends data to the `findings` channel.
The `default` workflow routes `findings` messages to `analyst`, which
receives `$1=message`, `$2=channel`, `$3=sender` (see [Trigger contract](#trigger-contract)).

## Design principles

- **Inbox is an event bus, not a filesystem watcher.** Delivery is driven by
  explicit **drain** at the end of the orchestrator workflow — no `inotifywait`,
  no `fswatch`, no polling for new files.
- **Sequential by default, parallel opt-in.** Dispatch is sequential
  unless `run.inbox_parallel = true` or `JAIPH_INBOX_PARALLEL=true` (see
  [Parallel dispatch](#parallel-dispatch) below).
- **Inbox is scoped per run.** Message files and queue state live under that
  run’s **`inbox/`** directory for ordering, audit, and tooling; they are not
  a separate productized mailbox outside `.jaiph/runs`.

## Syntax

### Channel declarations: `channel <name>`

Declare channels at top level, one per line:

```jh
channel findings
channel report

workflow default { ... }
```

Every channel used by `send` (`<-`) or route declarations (`->`) must be
defined in the current module or imported from another module (e.g.
`shared.findings`). Undefined channels fail validation with:

- `Channel "<name>" is not defined`

### Send operator: `<channel_ref> <- <command>`

The channel reference is always on the left side of the `<-` operator.
Valid forms:

- local channel: `findings`
- imported channel: `shared.findings`

The send step resolves the message from the **RHS** (literal, variable expansion,
`run` to a script, or forwarded `$1`), writes it to the next inbox slot,
and signals the runtime to dispatch.

```jh
channel findings

workflow researcher {
  findings <- "## findings"
}
```

If no command follows `<-`, the workflow's `$1` argument is forwarded:

```jh
channel findings

workflow forwarder {
  findings <-
}
```

The `<-` operator is only recognized when it appears outside of quoted
strings in the surrounding line so channel names and literals are not
misread as send syntax.

**Transpilation:**

| Jaiph                 | Bash (generated in the workflow `::impl`)          |
|-----------------------|----------------------------------------------------|
| `ch <- "foo"`         | `jaiph::send 'ch' "$(… literal …)" '<workflow>'`   |
| `ch <- run fmt`       | `jaiph::send` with managed `run` to `fmt`        |
| `ch <-`               | `jaiph::send 'ch' "$1" '<workflow>'`              |

(`<workflow>` is the name of the workflow that contains the send step.)

### Route declaration: `<channel_ref> -> <workflow>`

Tells the runtime: when a message arrives on that channel, call each listed
**workflow** with positional args `$1=message`, `$2=channel`, `$3=sender`.

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
  run researcher
  findings -> analyst
  summary -> reviewer
}
```

Multiple targets are supported (comma-separated). **Sequential dispatch
(default):** each target runs in list order for that message. **Parallel
dispatch** (`run.inbox_parallel` / `JAIPH_INBOX_PARALLEL`): all targets for
the messages being drained in the current loop iteration may run concurrently;
see [Parallel dispatch](#parallel-dispatch).

```jh
findings -> analyst, reviewer
```

If you declare the same channel more than once (several `findings -> …`
lines), `jaiph::register_route` **merges** targets onto that channel in
source order.

Route declarations are static routing rules, not executable statements.
They are stored in `routes` on the workflow definition, not in `steps`.
The compiler validates that all target workflow references exist (see above).

### Capture + send is a parse error

```jh
# E_PARSE: capture and send cannot be combined; use separate steps
name = channel <- cmd
```

Use two steps instead:

```jh
const payload = run build_message
channel <- "$payload"
```

## Inbox layout

```
.jaiph/runs/<YYYY-MM-DD>/<HH-MM-SS>-<source-file>/inbox/
  001-findings.txt
  002-summary.txt
  003-findings.txt
  ...
```

Each message is a file named `NNN-<channel>.txt` where `NNN` is a
zero-padded monotonic counter scoped to the run.

## Runtime dispatch loop

Only the workflow that declares route rules gets the inbox infrastructure.
Routes are registered when entering the workflow; the queue is drained
after all steps complete. Any child workflow called via `run` (or via
dispatch) inherits the inbox environment and can call `send`.

When a child workflow sends to a channel, the runtime walks **up** the
workflow context stack to find the **nearest ancestor** that declares a
route for that channel. This means a deeply nested workflow can produce
messages that are routed by an outer orchestrator without the inner
workflow needing its own route declarations.

The inbox logic lives in the JS kernel (`runtime/kernel/inbox.ts`). The kernel mutates the run’s **`inbox/`** directory,
appends **`INBOX_*`** lines to **`run_summary.jsonl`** when applicable, and
(for each routed target) dispatches the workflow through the Node runtime, preserving the usual
`$1` / `$2` / `$3` contract.

```
1. On workflow entry, the runtime initializes a WorkflowContext (route map, message queue).
2. Route declarations (`->`) register targets on the context's route map.
3. Execute the workflow steps top-to-bottom.
4. When `<-` is executed: the runtime writes the message file to `inbox/NNN-<channel>.txt`,
   pushes the message onto the queue of the nearest ancestor context with a matching route,
   and appends an INBOX_ENQUEUE summary event.
5. After all steps complete, drainWorkflowQueue runs the dispatch loop:
   a. Walk the queue from the current cursor; if no new messages, stop.
   b. For each message, look up routes on the workflow context.
   c. If there is no route, skip (message file remains on disk).
   d. If there is a route, invoke each target with $1=message, $2=channel, $3=sender —
      **sequentially** in target-list order by default, or **all targets concurrently
      via Promise.all** when `JAIPH_INBOX_PARALLEL=true`
      (see [Ordering guarantees](#ordering-guarantees)).
   e. Targets may call send, appending new messages after the cursor;
      the next loop iteration processes them.
   f. Repeat from (a) until no new messages, or until the dispatch depth limit
      is exceeded (`E_DISPATCH_DEPTH`).
6. Run ends.
```

### Implementation notes

In the Node runtime, routes and queue are **in-memory** on the
`WorkflowContext` (a per-workflow `Map<channel, targets[]>` and
`InboxMsg[]` array). The inbox sequence counter is a simple
incrementing integer on the runtime instance. Message files are
written to `<run_dir>/inbox/NNN-<channel>.txt` on send for
durability and audit; routing and dispatch operate on the in-memory
queue.

Sender identity is the **workflow name** (e.g. `researcher`), not the
file basename — this stays stable across cross-module calls.

## Parallel dispatch

When `run.inbox_parallel = true` is set in a `config` block (module or
workflow scope) or the environment sets `JAIPH_INBOX_PARALLEL=true`, route
targets are dispatched concurrently (via **`Promise.all`**) instead of
strictly one-at-a-time calls.

**Precedence** matches the rest of Jaiph agent/run settings: an explicit
environment value wins over in-file config. See [Configuration — Defaults and precedence](configuration.md#defaults-and-precedence).

```jh
config {
  run.inbox_parallel = true
}

workflow default {
  run producer
  findings -> analyst, reviewer   # analyst and reviewer run in parallel
}
```

### Ordering guarantees

`jaiph::drain_queue` runs in a loop. Each iteration reads **every queue line
from the current cursor through the end of the file** (one snapshot), drains
that snapshot, then repeats if new lines were appended while dispatch ran.

- **Sequential mode:** within that snapshot, lines are handled **FIFO**; for
  each line, route targets run **in list order**.
- **Parallel mode:** for **all lines in that snapshot**, **every** routed
  target is started before the runtime waits on all of them together.
  Order of execution is therefore **non-deterministic** across targets and
  across messages in the same snapshot — only the iteration boundaries
  (finish one snapshot, then read what was appended next) preserve coarse
  ordering over time.
- **Sequence IDs are never duplicated or skipped.** File-based locks
  (`mkdir`-based, portable across macOS and Linux) protect the inbox
  sequence counter (`.seq`) and the step sequence counter so that
  concurrent sends and step registrations remain correct.

### Lock behavior

In the Node runtime, the inbox queue and routes are in-memory, so
parallel dispatch does not need filesystem locks for queue or route
state. The step sequence counter (`seq-alloc.ts`) and
`run_summary.jsonl` appends still use `mkdir`-based file locks
(via `fs-lock.ts`) to protect against concurrent writes from
parallel script subprocesses.

### Failure propagation

All targets in a parallel batch are awaited via `Promise.all`. If any
target exits non-zero, the runtime collects all results first, then
propagates the failure. The owning workflow still fails when any
dispatched target fails; only the moment of exit differs from strict
sequential fail-fast.

### Rollback

To revert to sequential dispatch, remove `run.inbox_parallel = true`
from config or set `JAIPH_INBOX_PARALLEL=false` in the environment.
Sequential mode is the default and requires no locks.

## Error semantics

- **Undefined channel reference:** validation error
  `Channel "<name>" is not defined`.
- **Dispatched workflow exits non-zero:** the owning workflow fails. In
  **sequential** mode this stops dispatch immediately on the first
  failure. In **parallel** mode the runtime waits for all concurrent
  targets to complete, then exits non-zero — same overall rule
  (any failed target fails the run), slightly different timing.
- **No route for a channel:** the message file and queue entry still exist,
  but `drain_queue` **skips** that line (silent drop). This is intentional
  for optional subscribers; use a dedicated workflow if missing handlers
  should be an error.
- **Circular sends:** allowed — the queue grows naturally. A max dispatch
  depth guards against infinite loops (`E_DISPATCH_DEPTH`). The default
  limit is 100 and can be overridden with `JAIPH_INBOX_MAX_DISPATCH_DEPTH`.

## Trigger contract

Routed receivers get three positional arguments:

| Arg  | Value                                           |
|------|-------------------------------------------------|
| `$1` | Message payload (content sent to the channel)   |
| `$2` | Channel name (e.g. `findings`)                  |
| `$3` | Sender name (the **workflow name** that called `send`) |

- The channel name and sender are also available via `JAIPH_DISPATCH_CHANNEL`
  and `JAIPH_DISPATCH_SENDER` environment variables respectively.
- The three positional arguments (`$1`, `$2`, `$3`) are passed through
  `jaiph::run_step` like any other workflow invocation, so the progress
  tree shows them with the usual numbered keys (e.g.
  `workflow analyst (1="…", 2="findings", 3="scanner")`).
- `JAIPH_DISPATCH_CHANNEL` is also used by the event system to tag JSONL
  events with `"dispatched":true`, `"channel":"…"`, and `"sender":"…"` metadata.
- **Run summary:** In addition to those step events, the runtime appends
  **`INBOX_ENQUEUE`**, **`INBOX_DISPATCH_START`**, and **`INBOX_DISPATCH_COMPLETE`**
  lines to `run_summary.jsonl` (see [CLI — Run summary](cli.md#run-summary-jsonl)).
  `INBOX_DISPATCH_COMPLETE` includes an **`elapsed_ms`** field with the
  wall-clock time for that target's execution. Large message bodies appear
  as a safe **`payload_preview`** plus **`payload_ref`** pointing at the
  `inbox/NNN-<channel>.txt` file under the run directory.
  E2E `e2e/tests/88_run_summary_event_contract.sh` locks inbox-related summary
  lines and ordering together with the rest of the persisted event contract under
  parallel dispatch.
- Workflows remain directly callable: `jaiph run analyst "some content"`.
  When called directly, `$2` and `$3` are unset.

## Progress tree integration

- Route declarations appear as nodes in the progress tree.
- Dispatched workflow calls emit `STEP_START`/`STEP_END` events with
  `dispatched: true` and `channel: "<channel>"` metadata.
- Dispatched receivers show message, channel, and sender as positional
  parameters in the tree, same as other workflows with three args:
  `▸ workflow analyst (1="…", 2="findings", 3="scanner")`.
- Dispatched step output is not displayed in the tree. Use `log` within
  the dispatched workflow to show output in the tree. The runtime embeds
  stdout content in the `STEP_END` event (`out_content` field) for error
  reporting, with the same RFC 8259 JSON string escaping as other runs so
  embedded logs (tabs, ANSI, control bytes) cannot break event parsing.
  `.out` files under `.jaiph/runs/` contain the full output for debugging.
- Route declarations also appear as nodes in the live progress tree during
  [`jaiph run`](cli.md). For a browsable history of past runs and step trees,
  use [`jaiph report`](cli.md#jaiph-report) (see [Reporting server](reporting.md)).

### Example output

```
workflow default
  ▸ workflow scanner
  ✓ workflow scanner (0s)
  ▸ workflow analyst (1="Found 3 issues in auth module", 2="findings", 3="scanner")
  ✓ workflow analyst (0s)
  ▸ workflow reviewer (1="Summary: Found 3 issues in auth ...", 2="report", 3="analyst")
  ✓ workflow reviewer (0s)
✓ PASS workflow default (0.1s)
```
