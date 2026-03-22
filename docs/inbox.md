---
title: Inbox & Dispatch
permalink: /inbox
redirect_from:
  - /inbox.md
---

# Inbox & Dispatch

When a workflow produces output that another workflow needs to react to,
you need a way to pass data between them. Jaiph solves this with an
in-memory dispatch loop called the **inbox**.

One workflow produces output with the **send operator** (`<-`), another
reacts to it via a **route declaration** (`->`). The runtime handles
dispatch — no file watchers, no polling, no external message brokers.

```jh
channel findings

workflow researcher {
  findings <- echo '## analysis results'
}

workflow analyst {
  echo "Received: $1"
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

- **Inbox is an event bus, not a filesystem watcher.** The runtime owns
  dispatch in memory — no `inotifywait`, no `fswatch`, no polling.
- **Messages are sequential.** No parallel dispatch in v1.
- **Inbox is transient per run.** The inbox directory is retained for
  debugging but is not the dispatch mechanism.

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

The send operator captures the command's stdout, writes it to the next
inbox slot, and signals the runtime to dispatch.

```jh
channel findings

workflow researcher {
  findings <- echo '## findings'
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
strings. The parser tracks quote state to avoid false matches inside
shell commands.

**Transpilation:**

| Jaiph                        | Bash                                        |
|------------------------------|---------------------------------------------|
| `ch <- echo "foo"`          | `jaiph::send 'ch' "$(echo "foo")"`          |
| `ch <-`                     | `jaiph::send 'ch' "$1"`                     |

### Route declaration: `<channel_ref> -> <workflow>`

Tells the runtime: when a message arrives on `<channel>`, call `<workflow>`
with positional args `$1=message`, `$2=channel`, `$3=sender`.

```jh
channel findings
channel summary

workflow default {
  run researcher
  findings -> analyst
  summary -> reviewer
}
```

Multiple targets are supported (comma-separated). They are called
sequentially in declaration order, each receiving the same message:

```jh
findings -> analyst, reviewer
```

Route declarations are static routing rules, not executable statements.
They are stored in `routes` on the workflow definition, not in `steps`.
The compiler validates that all target workflow references exist — an
unknown target is an `E_VALIDATE` error.

### Capture + send is a parse error

```jh
# ERROR: E_PARSE capture and send cannot be combined; use separate steps
name = channel <- cmd
```

Use two steps instead:

```jh
name = cmd
channel <- echo "$name"
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

```
1. jaiph::inbox_init creates the inbox directory and resets state.
2. jaiph::register_route populates the routing table.
3. Execute the workflow steps top-to-bottom.
4. When <- is executed: write message to inbox dir, append to queue file.
5. After all steps complete, jaiph::drain_queue processes the queue:
   a. Read next unprocessed entry from the queue file.
   b. Look up route for channel.
   c. If route exists, invoke each target workflow with $1=message, $2=channel, $3=sender.
   d. Invoked workflows may call jaiph::send, growing the queue.
   e. Repeat until queue is empty or depth limit reached.
6. Run ends.
```

### Implementation notes

Routes are stored as a newline-delimited list (`channel<TAB>targets`) instead
of bash associative arrays, avoiding known bugs in bash 3.2 where reading a
non-existent key can return the last inserted value.

The dispatch queue (`inbox/.queue`) uses `channel:NNN` entries (e.g.
`findings:001`). The sequence counter (`inbox/.seq`) is also file-backed.
Both are files rather than shell variables so that increments and enqueues
performed inside subshells (e.g. `run_step` pipelines) survive back into the
parent process.

## Error semantics

- **Undefined channel reference:** validation error
  `Channel "<name>" is not defined`.
- **Dispatched workflow exits non-zero:** dispatch loop halts immediately
  (fail-fast), consistent with `set -e`.
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
  reporting; `.out` files under `.jaiph/runs/` contain the full output
  for debugging.
- `jaiph tree` (static view) shows route declarations as leaf nodes.

### Example output

```
workflow default
  ▸ workflow scanner
  ✓ 0s
  ▸ workflow analyst (1="Found 3 issues in auth module", 2="findings", 3="scanner")
  ✓ 0s
  ▸ workflow reviewer (1="Summary: Found 3 issues in auth ...", 2="report", 3="analyst")
  ✓ 0s
✓ PASS workflow default (0.1s)
```
