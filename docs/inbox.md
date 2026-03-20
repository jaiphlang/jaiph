---
title: Inbox & Dispatch
layout: default
nav_order: 7
---

# Inbox & Dispatch

Jaiph provides first-class event passing between agent workflows via an
in-memory dispatch loop. One workflow produces output with the **send
operator** (`->`), another reacts to it via an **`on` route declaration**.

## Design principles

- **Inbox is an event bus, not a filesystem watcher.** The runtime owns
  dispatch in memory — no `inotifywait`, no `fswatch`, no polling.
- **Messages are sequential.** No parallel dispatch in v1.
- **Inbox is transient per run.** The inbox directory is retained for
  debugging but is not the dispatch mechanism.

## Syntax

### Send operator: `-> <channel>`

Writes content to the next inbox slot and signals the runtime to dispatch.

```jh
workflow researcher {
  echo '## findings' -> findings
}
```

The send operator may be preceded by a shell command. If no command is
present, it forwards the workflow's `$1` argument:

```jh
workflow forwarder {
  -> findings
}
```

**Transpilation:**

| Jaiph                        | Bash                                        |
|------------------------------|---------------------------------------------|
| `echo "foo" -> ch`          | `jaiph::send 'ch' "$(echo "foo")"`          |
| `-> ch`                     | `jaiph::send 'ch' "$1"`                     |

### Route declaration: `on <channel> -> <workflow>`

Tells the runtime: when a message arrives on `<channel>`, call `<workflow>`
with the message content as `$1`.

```jh
workflow default {
  run researcher
  on findings -> analyst
  on summary -> reviewer
}
```

Multiple targets are supported (comma-separated). They are called
sequentially in declaration order, each receiving the same message:

```jh
on findings -> analyst, reviewer
```

**Note:** `on` declarations are static routing rules, not executable
statements. They are stored in `routes` on the workflow definition, not in
`steps`.

### Capture + send is a parse error

```jh
# ERROR: E_PARSE capture and send cannot be combined; use separate steps
name = cmd -> channel
```

Use two steps instead:

```jh
name = cmd
echo "$name" -> channel
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

```
1. Register all routing rules (jaiph::register_route calls).
2. Execute orchestrator workflow top-to-bottom.
3. When -> is executed: write message to inbox dir, append to file-based queue.
4. After orchestrator completes, drain the dispatch queue:
   a. Read next unprocessed entry from the queue file.
   b. Look up route for channel.
   c. If route exists, invoke each target workflow with message as $1.
   d. Invoked workflows may call jaiph::send, growing the queue.
   e. Repeat until queue is empty or depth limit (100) reached.
5. Run ends.
```

### Implementation notes

Routes are stored as a newline-delimited list (`channel<TAB>targets`) instead
of bash associative arrays, avoiding known bugs in bash 3.2 where reading a
non-existent key can return the last inserted value. The dispatch queue and
sequence counter are file-backed (`inbox/.queue`, `inbox/.seq`) so that
increments and enqueues performed inside subshells (e.g. `run_step` pipelines)
survive back into the parent process.

## Error semantics

- **Send to unregistered channel:** silent drop. The message is still
  written to the inbox directory for audit, but no workflow is dispatched.
- **Dispatched workflow exits non-zero:** dispatch loop halts immediately
  (fail-fast), consistent with `set -e`.
- **Circular sends:** allowed — the queue grows naturally. A max dispatch
  depth of 100 guards against infinite loops (`E_DISPATCH_DEPTH`).

## Trigger contract

- Called workflow receives `$1` = message content (string, not file path).
- Workflows remain directly callable: `jaiph run analyst "some content"`.

## Progress tree integration

- `on` route declarations appear as nodes in the progress tree.
- Dispatched workflow calls emit `STEP_START`/`STEP_END` events with
  `dispatched: true` and `channel: "<channel>"` metadata.
- The CLI renders dispatched steps with the channel name and message in
  parentheses: `▸ workflow analyst (findings, "Found 3 issues in auth module")`.
  Message values are truncated to 32 characters.
- Dispatched step output is not displayed in the tree. Use `log` within
  the dispatched workflow to show output in the tree. The runtime embeds
  stdout content in the `STEP_END` event (`out_content` field) for error
  reporting; `.out` files under `.jaiph/runs/` contain the full output
  for debugging.
- `jaiph tree` (static view) shows `on` routes as leaf nodes.

### Example output

```
workflow default
  ▸ workflow scanner
  ✓ 0s
  ▸ workflow analyst (findings, "Found 3 issues in auth module")
  ✓ 0s
  ▸ workflow reviewer (report, "Summary: Found 3 issues in auth module")
  ✓ 0s
    [reviewed] Summary: Found 3 issues in auth module
✓ PASS workflow default (0.1s)
```
