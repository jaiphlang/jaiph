---
title: Inbox & Dispatch
permalink: /inbox
redirect_from:
  - /inbox.md
---

# Inbox & Dispatch

## Overview

Pipelines often split work across **workflows** that hand off a payload: one
stage produces output, a later stage reacts to it. A generic way to do that
without a separate broker is an **in-module channel**: a named queue the
runtime can drain after a caller finishes its steps, driving receiver workflows
in order.

**Jaiph’s model** is a small orchestration feature on top of that idea: a
`channel` is declared with optional `->` routes to **workflow** targets; a send
uses `<-` to enqueue a string payload. `NodeWorkflowRuntime` keeps the queue
and route map in memory, may persist a routed send to disk for audit, and
**dispatches** targets when the **entry** workflow’s step list completes (plus
any implicit `run async` join) — not when a separate `->` “fires”; the `->`
in source code is **static routing** on the channel line, not a runtime
operator.

`NodeWorkflowRuntime` attaches an **in-memory** queue (`WorkflowContext.queue`) and route **`Map`** per **`run <workflow>()`**. **`channel … ->`** bindings load into **`routes` only when `inheritCallerMetadataScope` is **`false`** (CLI **`jaiph run`** → **`workflow default`**, programmatic **`runNamedWorkflow`** → the named callee). Nested **`run`** workflows begin with **`routes = new Map()` — see **[Who registers routes and who drains](#who-registers-routes-and-who-drains)**.

On **`send`**, **`inboxSeq`** increments, an **`InboxMsg`** queues on **`targetCtx`**, and **`run_summary.jsonl`** always gains **`INBOX_ENQUEUE`** (channel / sender / sequence metadata only — **[Trigger contract](#trigger-contract)**). **`inbox/NNN-<literal>.txt`** is created only when the runtime marked the send **`routed`** (**`routes.has(step.channel)`** in **`node-workflow-runtime.ts`**). If **every** send stays **`routed === false`**, **`inbox/`** may be omitted. Interpreter queue + drain — **[Architecture — Channels and hooks](architecture.md#channels-and-hooks-in-context)** — no brokers, no **`inotify`**, no polling **`inbox/`**.

## At a glance

```jh
channel findings -> analyst

workflow researcher() {
  findings <- "## analysis results"
}

workflow analyst(message, chan, sender) {
  log "Received: ${message}"
}

workflow default() {
  run researcher()
}
```

`researcher` sends data to the `findings` channel. The `channel findings -> analyst`
declaration routes `findings` messages to `analyst`, which receives the message,
channel name, and sender bound to its declared parameters `message`, `chan`, and
`sender` (see [Trigger contract](#trigger-contract)).

## Design principles

- **Drain-driven delivery, not a filesystem mailbox.** Messages are drained from an
  in-memory queue **after each workflow finishes its steps** (including the implicit
  join for `run async`). `inbox/*.txt` is an optional audit copy for routed sends —
  routing does **not** read from disk — no `inotifywait`, `fswatch`, or polling loops.
- **Sequential dispatch.** For each queued message, route targets run **in list
  order** (declaration order on the `channel` line), one completion at a time.
- **Inbox is scoped per run.** **`inbox/*.txt`** persists **routed** payloads under that UTC run directory (**[Architecture — Durable artifact layout](architecture.md#durable-artifact-layout)**); there is no repo-wide mailbox outside **`.jaiph/runs`**.
- **Channels are compile-checked.** Unknown channels, bad route targets, and
  invalid `send` RHS forms are `E_PARSE` / `E_VALIDATE` from
  `validateReferences` in the build path; **`buildRuntimeGraph()`** only parses
  modules and does not repeat that pass (see [Architecture — Summary](architecture.md#summary)).

## Syntax

### Channel declarations: `channel <name> [-> <workflow>, ...]`

Declare channels at top level, one per line. Optionally declare inline routes
with `->`:

```jh
channel findings -> analyst
channel report
channel events -> handler_a, handler_b

workflow default() { ... }
```

Every channel used by send (`<-`) must be defined in the current module or
imported from another module (e.g. `shared.findings`). Undefined channels fail
validation with:

- `Channel "<name>" is not defined`

### Send operator: `<channel_ref> <- <rhs>`

The channel reference is always on the left side of the `<-` operator. Valid
channel forms:

- local channel: `findings`
- imported channel: `shared.findings` — checked against the import at compile time; **dispatch** still matches **`routes.has()`** with the **literal** token (see [Module scope](#who-registers-routes-and-who-drains))

The send step resolves the **string** payload from the **RHS**, bumps **`inboxSeq`**, and appends an **`InboxMsg`** to the queue on the workflow context selected by walking **from the sender outward** until **`ctx.routes.has(sendChannel)`** — **`sendChannel`** is the exact text left of **`<-`**. If nothing matches, enqueue on the sender’s context (**`routed === false`**; no **`inbox/*.txt`** row). If a match exists (**`routed === true`**), create **`inbox/`** when needed and write **`NNN-<sendChannel>.txt`** sharing the same **`inbox_seq`** as JSONL.

**`INBOX_ENQUEUE`** is always written (`channel`, **`sender`**, **`inbox_seq`**, **`ts`**, **`run_id`**, **`event_version`**) and **does not** embed the payload body (`node-workflow-runtime.ts`).

Valid RHS forms:

| RHS form | Example | Behavior |
|---|---|---|
| Double-quoted literal | `findings <- "## results"` | Interpolated string |
| Triple-quoted block | `findings <- """line1\n  ${x}"""` | Multiline string; margin rules match other `"""` steps (see [Grammar](grammar.md#send--channel-messages)) |
| Variable expansion | `findings <- ${var}` or `$name` | Value of the variable |
| `run` capture | `findings <- run build_msg()` | Return value or trimmed stdout of the workflow/script |

The RHS does **not** accept raw shell commands or bare workflow/rule/script
names (use a string, `$` / `${…}`, or `run ref(…)` — see
[Grammar — `send`](grammar.md#send--channel-messages) and
[Grammar — `channel` routing](grammar.md#channel-routing)).

```jh
channel findings

workflow researcher() {
  findings <- "## findings"
}
```

An explicit RHS is always required — bare `channel <-` (without a value) is invalid.

The `<-` operator is only recognized when it appears outside of quoted strings
on the surrounding line so channel names and literals are not misread as send
syntax.

Send and route syntax, plus compile-time checks, are summarized under
[Grammar — `send`](grammar.md#send--channel-messages) and
[Grammar — `channel` routing](grammar.md#channel-routing); the EBNF and
validation list live at the end of [Grammar](grammar.md#validation-rules).

### Route declaration: `channel <name> -> <workflow>`

Routes are declared **inline on channel declarations** at the top level, not
inside workflow bodies. When a message arrives on that channel, the runtime calls
each listed **workflow** that must declare exactly 3 parameters. The runtime
binds the dispatch values (message, channel, sender) to whatever names the
target declares.

Targets must be **workflows** (local or imported as `alias.name`). **Rules**
and **scripts** are not valid route targets — the compiler uses workflow-only
reference checks, so a bad target is **`E_VALIDATE`** with messages such as
`unknown local workflow reference "…"`, `imported workflow "…" does not exist`,
`rule "…" must be called with ensure`, or `script "…" cannot be called with run`
(see [Grammar — `channel` routing](grammar.md#channel-routing) for a short
version of the same rules). A name that is not a valid
`alias.name` / `name` pattern fails at parse time as **`E_PARSE`**
`invalid workflow reference in channel route: "…"`. The wrong **parameter
count** on a resolved workflow is
`E_VALIDATE: inbox route target "…" must declare exactly 3 parameters (message, channel, sender), but declares N`.

```jh
channel findings -> analyst
channel summary -> reviewer

workflow default() {
  run researcher()
}
```

**Multiple targets on one declaration** are comma-separated — they share one
route and dispatch in **declaration order**, sequentially:

```jh
channel findings -> analyst, reviewer
```

Route declarations are static routing rules stored on `ChannelDef`, not on
workflow definitions or steps. The compiler validates that all target workflow
references exist and declare exactly 3 parameters.

A `->` route inside a workflow body is a **parse error** with guidance:
`route declarations belong at the top level: channel <name> -> <targets>`.

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

Under the run directory (see [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout)):

```
.jaiph/runs/<YYYY-MM-DD>/<HH-MM-SS>-<source-basename>/inbox/
  001-findings.txt
  002-summary.txt
  003-findings.txt
  ...
```

When present, files are **`NNN-<channel>.txt`** (`NNN` = **three**‑digit **`inboxSeq`**,
same value as **`inbox_seq`** in **`INBOX_ENQUEUE`**). **`inboxSeq`** is shared across
every `send` in the process for that run, so numbering matches **enqueue order**, not “per channel”.
Persisted payloads are exactly the **routed** sends — the orchestration queue is always in memory.

## Runtime dispatch

### Who registers routes and who drains

Every entered workflow gets a **`WorkflowContext`**: `workflowName`, a route **`Map`**,
and a message queue. **`->` bindings are populated only when the workflow is entered
with `inheritCallerMetadataScope === false`** — ordinary **`jaiph run`** invokes **`workflow default`** from your **`run` filepath**, and **`runNamedWorkflow`** (tests / embedders) uses the same **`false`** branch for whichever workflow it launches, so **`routes`** mirror **that callee module’s** top-level **`channel ->`** lines—not files you only **`import`**. Each nested **`run child()`** pushes another frame with an **empty** route **`Map`**
(**`// Only register on the entry workflow`** in **`node-workflow-runtime.ts`**), so **`send`** walks **outward** until **`routes.has(step.channel)`** succeeds (**`step.channel`** token from the **`send`** AST node).
After **each** workflow body finishes (implicit **`run async` join included), **`drainWorkflowQueue`** runs for **that** frame’s queue and route table **before** the frame pops — nested exits are usually no-ops, while the **`jaiph run`** root drains work that nested sends enqueued onto it.

**Module scope.** `ctx.routes` **keys** are bare names from **`channel <name>`** in the callee module (**`parseChannelLine`**). Imports allow **`lib.topic <-`** (validator proves **`topic`** exists inside **`lib`**) yet **`routes.has("lib.topic")`** is still **false** for default layouts, because registered keys omit the **`alias.`** prefix (**`step.channel`** is compared verbatim). Prefer **`topic <-`** next to **`channel topic -> …`** in the **`inheritCallerMetadataScope === false` module**, or **`jaiph run lib.jh`** when **`lib.jh`'s **`channel`** lines should supply the **`->`** bindings.

### Dispatch loop

Implementation: `src/runtime/kernel/node-workflow-runtime.ts` — `send` step
handling and `drainWorkflowQueue`.

1. On workflow entry, push a `WorkflowContext` (route map, empty queue).
2. When **`inheritCallerMetadataScope === false`**, copy each **`channel <name> -> …`** from **`graph.modules.get(resolved.filePath)`**’s AST into **`ctx.routes`**; nested **`run`** frames leave **`routes`** empty.
3. Execute workflow steps top to bottom.
4. On `<-`: resolve payload; bump `inboxSeq` (`NNN` zero-padded to **3** digits);
   enqueue on the routed context selected by scanning the stack outward; **`if routed`**
   write `inbox/NNN-<channel>.txt`; always append **`INBOX_ENQUEUE`**
   (`channel`, `sender`, **`inbox_seq`**, **`ts`**, **`run_id`**, **`event_version`**) to **`run_summary.jsonl`** .
5. After all steps (and implicit `run async` joins) complete,
   `drainWorkflowQueue`:
   - `while (cursor < queue.length)` — new sends during dispatch append to the
     same queue and are processed in subsequent iterations.
   - For each message, look up targets for `channel` on **that** workflow's
     context. If there is no route, **skip** (silent drop).
   - If there are targets, invoke each target **sequentially** in target-list
     order, binding message, channel, and sender to the target's 3 declared
     parameters (see [Ordering and sequence ids](#ordering-and-sequence-ids)).
6. Pop the workflow context and return.

There is no `E_DISPATCH_DEPTH` / `JAIPH_INBOX_MAX_DISPATCH_DEPTH` check in
`NodeWorkflowRuntime`'s drain loop. Avoid unbounded circular sends in orchestration.

### Implementation notes

- Routes (from channel-level `->` declarations) and the pending queue live **in-memory** on **`WorkflowContext`**.
  Routing consults **`ctx.routes` + `ctx.queue`**; **`inbox/NNN-….txt`** is written **only when** **`if (routed)`** after enqueue — see **`send`** in **`node-workflow-runtime.ts`**.
- **Sender identity** is the **current workflow name** from the context that
  performed the send (e.g. `researcher`), stable across modules.

### Ordering and sequence ids

Messages are handled **one at a time** in queue order (FIFO). For each message,
targets run **strictly in list order** on the `channel` line; the next message is
not processed until all targets for the current message have finished (success, or
fail-fast on the first non-zero exit).

- **Sequence ids:** Monotonic per run in the runtime (`inboxSeq`); message
  filenames use the same padded counter.

## Error semantics

- **Undefined channel reference:** validation error `Channel "<name>" is not defined`.
- **Dispatched workflow exits non-zero:** the owning workflow fails; the first
  failing target stops further targets for that message (fail-fast).
- **No route for a channel:** the **`InboxMsg`** is still queued and **`INBOX_ENQUEUE`**
  is recorded, but **`inbox/*.txt`** is **not** written and **`drainWorkflowQueue`** has
  no targets (`routes.get(channel)` empty) → the message is **skipped** with no receivers
  (silent drop). This is intentional for optional subscribers; declare explicit routes if
  a missing handler should be an error.
- **Circular sends:** the in-memory queue can grow without a built-in iteration
  cap in `NodeWorkflowRuntime`. Avoid circular sends that grow the queue without bound.

## Trigger contract

Routed receivers get three dispatch values bound to their declared parameters:

| Param position | Dispatch value |
|---|---|
| 1st declared parameter | Message payload (content sent to the channel) |
| 2nd declared parameter | Channel name (e.g. `findings`) |
| 3rd declared parameter | Sender name (the **workflow name** that performed the send) |

Receivers get channel and sender via their declared parameter names —
no environment-variable plumbing.

- **`run_summary.jsonl`:** **`NodeWorkflowRuntime`** appends **`INBOX_ENQUEUE`** on every **`send`**,
  then **`INBOX_DISPATCH_START`** / **`INBOX_DISPATCH_COMPLETE`** (with **`elapsed_ms`** and **`status`**)
  per routed-target invocation (`appendRunSummaryLine`).

  **`INBOX_ENQUEUE`** (current **`NodeWorkflowRuntime`**) records **`type`**, **`ts`**, **`run_id`**,
  **`channel`**, **`sender`**, **`inbox_seq`**, **`event_version`** — **not** the message body.

  Routed sends also get the full payload on disk as **`inbox/NNN-<channel>.txt`**. Tooling must read
  that file **or** the receiver’s **`STEP_*` / script captures for the full string; unrouted sends
  have **only** enqueue metadata in JSONL (plus whatever you log around the **`send`**).
- **Calling a receiver with explicit args:** the CLI’s `jaiph run` only starts
  the file’s `default` workflow; extra CLI arguments are passed to `default`
  (see [CLI — `jaiph run`](cli.md#jaiph-run)). There is no `jaiph run
  <name> <file> …` form. To hand `(message, channel, sender)` to a workflow
  such as `analyst` outside of inbox dispatch, use a **`run` step** from another
  workflow, e.g. `run analyst("…", "findings", "researcher")` (or
  `test_run_workflow` in `*.test.jh`).

## Progress tree integration

- Channel‑level **`channel … ->`** declarations surface in the CLI’s **static** step-tree
  view (derived from the module AST alongside concrete steps).
- Dispatched workflows render like other **`run`** steps (same shape as `workflow analyst (message="…", chan="findings", sender="scanner")` in **`e2e/tests/91_inbox_dispatch.sh`**). Live **`STEP_START` / `STEP_END`** payloads from **`NodeWorkflowRuntime`** do **not** add inbox-specific **`dispatched` metadata** (**`events.ts`** still tolerates **`dispatched: true`** for forward compatibility).
- Dispatched step output follows the same artifact rules as other managed steps.
  Use `log` inside the receiver to surface lines in the tree. The runtime
  embeds stdout in `STEP_END` (`out_content`) with the same JSON escaping
  rules as other steps.
- Run artifacts and `run_summary.jsonl` provide a browsable history of past runs
  (see [CLI — Run artifacts](cli.md#run-artifacts-and-live-output)).

### Example output

Shape aligns with **`e2e/tests/91_inbox_dispatch.sh`** (**`display_inbox.jh`**): `scanner` sends on **`findings`**, **`analyst`** sends on **`report`**, **`default`** routes both:

```
workflow default
  ▸ workflow scanner
  ·   ▸ script emit_findings
  ·   ✓ script emit_findings (<time>)
  ✓ workflow scanner (<time>)
  ▸ workflow analyst (message="Found 3 issues in auth module", chan="findings", sender="scanner")
  ·   ▸ script emit_summary (1="Found 3 issues in auth module")
  ·   ✓ script emit_summary (<time>)
  ✓ workflow analyst (<time>)
  ▸ workflow reviewer (message="Summary: Found 3 issues in auth ...", chan="report", sender="analyst")
  ·   ▸ script print_reviewed (1="Summary: Found 3 issues in auth ...")
  ·   ✓ script print_reviewed (<time>)
  ✓ workflow reviewer (<time>)

✓ PASS workflow default (<time>)
```

A smaller hand-written module with the same routing idea lives at **`examples/agent_inbox.jh`**.
