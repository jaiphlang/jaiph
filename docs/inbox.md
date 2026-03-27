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
The compiler emits `jaiph::inbox_init` and `jaiph::register_route` calls
at the top of that workflow's implementation, and `jaiph::drain_queue` at
the end. Any child workflow called via `run` (or via dispatch) inherits
the inbox environment and can call `jaiph::send`.

Those three Bash functions are thin wrappers around **`node "$JAIPH_INBOX_JS"`**
(`kernel/inbox.js` next to the installed stdlib — the same path-resolution idea
as **`JAIPH_EMIT_JS`**). The kernel mutates the run’s **`inbox/`** directory,
appends **`INBOX_*`** lines to **`run_summary.jsonl`** when applicable, and
(for each routed target) executes the generated workflow module directly in
**`__jaiph_dispatch`** mode using `JAIPH_RUN_STEP_MODULE`, preserving the usual
`$1` / `$2` / `$3` contract.

```
1. jaiph::inbox_init creates/resets inbox state (directory, `.queue`, `.seq`, `.routes`).
2. jaiph::register_route merges targets into the persisted route map.
3. Execute the workflow steps top-to-bottom.
4. When <- is executed: jaiph::send delegates to the kernel — message file, queue line, enqueue summary event.
5. After all steps complete, jaiph::drain_queue runs the kernel drain loop:
   a. Read all lines from the current cursor through the end of `.queue` into memory (a snapshot); if there are none, stop.
   b. Walk each line (and bump the shared cursor / depth counter per line). Resolve the channel, load the message body from `NNN-<channel>.txt`, look up the route.
   c. If there is no route, skip that line (message file remains on disk).
   d. If there is a route, invoke each target with $1=message, $2=channel, $3=sender — **sequentially** in target-list order by default, or **all targets for all lines in the snapshot as concurrent child processes, then one shared wait** when `JAIPH_INBOX_PARALLEL=true` (see [Ordering guarantees](#ordering-guarantees)).
   e. Targets may call jaiph::send, appending new lines after the cursor; the next outer-loop iteration reads them.
   f. Repeat from (a) until a read finds no new lines, or until the dispatch depth limit is exceeded (`E_DISPATCH_DEPTH`).
6. Run ends.
```

### Implementation notes

Routes are persisted in **`inbox/.routes`**: one line per channel,
`channel<TAB>targets` (space-separated workflow symbols), merged in source
order as `jaiph::register_route` runs — the same tab-delimited shape the Bash
runtime used before the kernel port, kept as a file instead of a shell variable.

The dispatch queue (`inbox/.queue`) uses `channel:NNN:sender` entries
(e.g. `findings:001:researcher`). The sequence counter (`inbox/.seq`)
is also file-backed.
Both are files rather than shell variables so that increments and enqueues
performed inside subshells (e.g. `run_step` pipelines) survive back into the
parent process.

## Parallel dispatch

When `run.inbox_parallel = true` is set in a `config` block (module or
workflow scope) or the environment sets `JAIPH_INBOX_PARALLEL=true`, route
targets are launched as concurrent processes (Node **`spawn`**) instead of
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

Parallel dispatch introduces synchronous file locks around three
shared-state files:

| Lock target | Protects | When held |
|---|---|---|
| `inbox/.seq.lock` | Inbox sequence counter + queue append | During inbox **send** (kernel), when parallel mode is on |
| `.seq.lock` (run dir) | Step sequence counter | During `jaiph::next_step_id` |
| `run_summary.jsonl.lock` | Any append to `run_summary.jsonl` | During each summary line write (all event types, including **`INBOX_*`**) |

Locks use `mkdir` (atomic on POSIX). The inbox send lock is only acquired when
`JAIPH_INBOX_PARALLEL=true`; sequential inbox mode has no send-lock overhead.

### Failure propagation

If any parallel target exits non-zero, `drain_queue` waits for all
other concurrent dispatches from the **same parallel snapshot** to finish,
then exits with status 1. The owning workflow still fails when any
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
  **sequential** mode this stops dispatch as soon as `set -e` sees the
  failure. In **parallel** mode the runtime waits for the rest of the
  jobs from the current snapshot, then exits non-zero — same overall rule
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
| `$3` | Sender name (workflow that produced the message) |

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
  Large message bodies appear as a safe **`payload_preview`** plus **`payload_ref`**
  pointing at the `inbox/NNN-<channel>.txt` file under the run directory.
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
