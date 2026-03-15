# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Business analyst workflow

Add Jaiph workflow to .japih directory that verifies the QUEUE.md file if it is clear and consistent with the current implementation, and does not conflict with other documented features.

The workflow agent prompt should either mark the task as dev-ready, or add questions to answer that are required to proceed (preferabbly along with suggestions/recommendations).

The current workflow for implementing a task, should contain a check if the first task is marked as dev-ready (programatic check, no prompt).

---

## Add Docker sandbox runtime for Jaiph execution

### Problem
Jaiph currently executes transpiled shell directly on the host. We need an optional disposable container runtime to isolate execution while still allowing controlled workspace writes.

### Proposed syntax

Use the existing in-file `config { ... }` flow (no new top-level keywords):

```jh
config {
  # Runtime execution settings (all runtime.* keys)
  runtime.docker_enabled = true
  runtime.docker_image = "ubuntu:24.04"
  runtime.docker_network = "default"
  runtime.docker_timeout = 300            # seconds

  # All workspace & mount layout is defined in one array
  runtime.workspace = [
    ".:/jaiph/workspace:rw",              # default main workspace (host "." → container "/jaiph/workspace")
    "config:config:ro"                    # shorthand: host "config" → /jaiph/workspace/config:ro
    # "data:/jaiph/data:ro"               # full syntax: absolute container path
  ]
}
```

**Mount parsing rules** (applied automatically):
- Full form: `"host_path:container_path:mode"`
- Shorthand: if `container_path` does not start with `/`, it is placed under `/jaiph/workspace/` automatically
  (`"config:config:ro"` → `/jaiph/workspace/config:ro`, `"data:ro"` → `/jaiph/workspace/data:ro`)
- Exactly one mount must target `/jaiph/workspace` (parser-enforced; defaults to `"./:/jaiph/workspace:rw"` if omitted).
- All mounts outside `/jaiph/workspace` are read-only unless `:rw` is explicit.

### Workspace structure inside the container

```
/jaiph/
  generated/          # transpiled bash script(s), mounted read-only
  workspace/          # always the mount targeting /jaiph/workspace (read-write root)
    .jaiph/
      runs/
        <run-id>/
          inbox/      # transient per run — see inbox task
```

- Generated script is always read-only.
- `.jaiph/` is auto-created and belongs in `.gitignore`.

### Required behavior
- Transpilation unchanged.
- `docker run --rm` with proper UID/GID mapping (`--user $(id -u):$(id -g)` on Linux).
- Works in TTY mode if TTY is available.
- `CI=true` disables Docker by default unless `runtime.docker_enabled = true` is set in file (in-file wins).
- Docker missing → clear error, no silent fallback.
- Image pulled automatically if missing; pull failure is fatal.
- Timeout kills container with `E_TIMEOUT`.

### Acceptance criteria
- Config parser supports all `runtime.docker_*` keys including `runtime.workspace` array and shorthand parsing.
- Exactly one mount must target `/jaiph/workspace` (enforced at parse time).
- Precedence: env > in-file > defaults.
- Unknown `runtime.docker_*` keys → `E_PARSE`.
- Workspace writes persist with correct ownership on Linux.
- Docs updated (`docs/configuration.md`, `docs/cli.md`).
- `.jaiph/` added to scaffolded `.gitignore`.

---

## Add inbox/watch semantics for multi-agent workflows

### Problem
Jaiph needs first-class event passing between agent workflows so one workflow can produce output and another can react to it — without filesystem watching, polling, or parallelism complexity.

### Design principles
- Inbox is an event bus, not a filesystem watcher. The runtime owns dispatch in memory.
- No `inotifywait`, no `fswatch`, no polling. Routing is declared statically via `on`; the runtime executes it.
- Messages are sequential. No parallel dispatch in v1.
- Inbox is transient per run. If persistence is needed, workflows write real files outside the inbox.

### Inbox layout

```
.jaiph/runs/<run-id>/inbox/
  001-findings.txt
  002-summary.txt
  003-findings.txt
  ...
```

- Each message is a file named `NNN-<channel>.txt` where `NNN` is a zero-padded monotonic counter scoped to the run.
- The counter determines processing order. Messages are always processed sequentially in counter order.
- Consumed state is trivially tracked as the last processed counter value — no hash tracking needed.

### Proposed syntax

(use exact sample with mocked commands in tests as `*.test.jh`)

```jh
workflow researcher {
  echo '## findings' -> findings
}

workflow analyst {
  echo "$1" > findings_file.md
  summary = prompt "Analyze @findings_file.md and return summary"
  echo "$summary" -> summary
}

workflow reviewer {
  echo "[reviewed] $1" -> final_summary
}

# Orchestration / entrypoint workflow
workflow default {
  run researcher
  on findings -> analyst
  on summary -> reviewer
}
```

### Operator and keyword semantics

- `-> <channel>`: send operator. Writes content to the next inbox slot (`NNN-<channel>.txt`) and signals the runtime to dispatch.
- `on <channel> -> <workflow>`: routing declaration. Tells the runtime: when a message arrives on `<channel>`, call `<workflow>` with message content as `$1`.
- `run <workflow>`: direct invocation, no inbox involved.
- `on` declarations live in `default` (or any orchestrator workflow). They are static routing rules registered at startup, not executable statements.

### Trigger contract
- Called workflow receives `$1` = message content (string, not file path).
- `$2` is not passed in v1 (no event type needed without FS watching).
- Workflows remain directly callable for testing: `jaiph run analyst "some content"`.

### Runtime dispatch loop (in-memory, no FS watching)

```
1. Register all watch routing rules from default workflow.
2. Execute default workflow top-to-bottom.
3. When -> send is executed: append message to inbox dir and push to in-memory dispatch queue.
4. After each workflow invocation completes, drain the dispatch queue sequentially:
   - Find routing rule for channel.
   - Invoke target workflow with message content as $1.
   - That workflow may itself send (->), appending further messages to the queue.
5. Repeat until queue is empty.
6. Run ends. .jaiph/runs/<run-id>/ is retained for debugging; cleared at start of next run.
```

No filesystem events, no watchers, no timers. The inbox directory is a durable audit log of the run, not the dispatch mechanism.

### Acceptance criteria
- Grammar supports `-> <channel>` send operator.
- Grammar supports `on <channel> -> <workflow>[, <workflow>...]`.
- `on` declarations are parsed as static routing rules, not executable statements.
- Runtime dispatch is sequential and in-memory; no inotifywait/fswatch/polling.
- `$1` receives message content string.
- Inbox files written as `NNN-<channel>.txt` with monotonic counter.
- Workflows remain directly invokable via `jaiph run <workflow> "<arg>"` for testing.
- Docs cover the dispatch loop, send operator, and `on` routing.
- Test file `inbox.test.jh` uses the exact syntax sample above with mocked commands.