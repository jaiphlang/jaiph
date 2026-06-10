---
title: Inbox & Dispatch
permalink: /inbox
redirect_from:
  - /inbox.md
---

# Inbox & Dispatch

## Overview

Many pipelines split work across stages: one part of the system produces a
payload and another reacts later. Without standing up a message broker, a
common pattern is an **in-process queue**: producers enqueue messages, and the
runtime drains that queue at predictable boundaries so receivers run in order.

**Jaiph’s channels** follow that pattern at workflow granularity. You declare a
`channel` at module scope, optionally list workflow targets after `->`, and use
`<-` inside a workflow to enqueue a **string** payload. Routing on the
`channel … ->` line is **static** (parsed into the AST); nothing “fires” at
parse time. Delivery happens later: after a workflow’s steps finish — including
waiting out any **`run async`** handles joined at workflow exit — the runtime
drains that workflow frame’s queue and **`run`s** each route target in order.

Under the hood, `NodeWorkflowRuntime` keeps queues and route maps **in memory**
(see [Architecture — Channels and hooks in context](architecture.md#channels-and-hooks-in-context)).
**`run_summary.jsonl`** records **`INBOX_ENQUEUE`** on every send (metadata only;
see [Trigger contract](#trigger-contract)). **`inbox/NNN-<channel>.txt`** files
are optional **audit** copies of the payload for **routed** sends only; routing
does not read them back — no filesystem watchers or inbox polling. Which stack
frame owns routes, and how sends bubble to an ancestor frame, is spelled out in
[Who registers routes and who drains](#who-registers-routes-and-who-drains).

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
  order** (declaration order on the `channel` line), strictly **one after
  another**. Older Jaiph releases exposed parallel inbox dispatch via config /
  environment variables; that mode is **removed** — `run.inbox_parallel` is an
  unknown config key and **`JAIPH_INBOX_PARALLEL` has no effect** on ordering.
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
- imported channel: `shared.findings` — checked against the import at compile time; the runtime strips the **`alias.`** prefix before consulting **`routes.has()`**, so `shared.findings <-` and a bare `findings <-` resolve to the same route key (see [Module scope](#who-registers-routes-and-who-drains))

The send step resolves the **string** payload from the **RHS**, bumps **`inboxSeq`**, and appends an **`InboxMsg`** to the queue on the workflow context selected by walking **from the sender outward** until **`ctx.routes.has(sendChannel)`** — **`sendChannel`** is the **bare** channel name (the validator has already confirmed any `alias.` prefix refers to an existing imported channel, and the runtime strips the prefix before the lookup). If nothing matches, enqueue on the sender’s context (**`routed === false`**; no **`inbox/*.txt`** row). If a match exists (**`routed === true`**), create **`inbox/`** when needed and write **`NNN-<sendChannel>.txt`** sharing the same **`inbox_seq`** as JSONL.

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

A **`channel <name>`** line **without** **`->`** still defines **`name`** for **`send`**
validation, but the runtime **never** adds **`name`** to **`ctx.routes`** — only
channels with **at least one** **`->`** target populate the route map
(**`node-workflow-runtime.ts`** skips bare channels when building **`routes`**).
Sends on those names therefore behave like **unrouted** sends (no **`inbox/*.txt`**),
and **`drainWorkflowQueue`** has nothing to **`run`** for them.

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
and a message queue. **`->` bindings are populated only on “entry” workflows:**
the interpreter passes **`inheritCallerMetadataScope === false`** for **`jaiph run`’s
`default`**, for **`runNamedWorkflow`** (used by **`jaiph test`**’s
**`test_run_workflow`**), and for any other path that starts a workflow the same
way — so **`routes`** mirror **that callee module’s** top-level **`channel ->`** lines,
not modules you only **`import`**. Each nested **`run child()`** passes **`inheritCallerMetadataScope === true`**, which keeps **`routes`** as an **empty** **`Map`**
(see **`node-workflow-runtime.ts`** — routes register only when **not** inheriting the caller metadata scope), so **`send`** walks **up the workflow stack** until **`routes.has(channelKey)`** succeeds (**`channelKey`** is **`step.channel`** with any leading **`alias.`** prefix stripped, so imported sends collapse to the same bare key as their declaration).
After **each** workflow body finishes (implicit **`run async` join included), **`drainWorkflowQueue`** runs for **that** frame’s queue and route table **before** the frame pops — nested exits are usually no-ops, while the **`jaiph run`** root drains work that nested sends enqueued onto it.

**Module scope.** `ctx.routes` **keys** are bare names from **`channel <name>`** in the callee module (**`parseChannelLine`**). Sends written as **`lib.topic <-`** match the same route key as a bare **`topic <-`**: after **`validateChannelRef`** proves the imported channel exists, the runtime strips the **`alias.`** prefix before consulting **`routes.has(...)`**, so **`routes.has("topic")`** resolves the route regardless of how the send was spelled. **`INBOX_ENQUEUE`** records the bare **`channel`** (e.g. **`"topic"`**), and the audit copy is written to **`inbox/NNN-topic.txt`**.

### Dispatch loop

Implementation: `src/runtime/kernel/node-workflow-runtime.ts` — `send` step
handling and `drainWorkflowQueue`.

1. On workflow entry, push a `WorkflowContext` (route map, empty queue).
2. When **`inheritCallerMetadataScope === false`**, copy each **`channel <name> -> …`** from **`graph.modules.get(resolved.filePath)`**’s AST into **`ctx.routes`**; nested **`run`** frames leave **`routes`** empty.
3. Execute workflow steps top to bottom.
4. On `<-`: resolve payload; bump `inboxSeq` (`NNN` zero-padded to **3** digits);
   enqueue on the routed context selected by scanning the stack outward; **`if routed`**
   write `inbox/NNN-<channel>.txt`; always append **`INBOX_ENQUEUE`**
   (`channel`, `sender`, **`inbox_seq`**, **`ts`**, **`run_id`**, **`event_version`**) to **`run_summary.jsonl`**.
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

The shape matches the **`display_inbox.jh`** fixture inline in the same test file (search for **`display_inbox.jh`** in **`e2e/tests/91_inbox_dispatch.sh`**): `scanner` sends on **`findings`**, **`analyst`** sends on **`report`**, **`default`** routes both:

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
