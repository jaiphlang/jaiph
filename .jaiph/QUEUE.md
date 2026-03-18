# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Config parser: support integer and array value types

<!-- dev-ready -->

### Problem
The config parser (`src/parse/metadata.ts:parseMetadataValue()`) only supports quoted strings and booleans. The upcoming Docker sandbox runtime requires bare integers (`runtime.docker_timeout = 300`) and arrays of strings (`runtime.workspace = [...]`). This must land before the Docker task can begin.

### Scope
Extend the config parser to support two new value types and add the `runtime.*` key namespace.

### New value types

**Integers** — bare numeric literals:
```jh
config {
  runtime.docker_timeout = 300
}
```
- `parseMetadataValue()` returns `number` (add to return type union: `string | boolean | number | string[]`).
- Regex: `/^[0-9]+$/` on trimmed value. No floats, no negatives, no hex in v1.
- Type validation: keys expecting integers reject strings/booleans/arrays with `E_VALIDATE`.

**Arrays of strings** — bracket-delimited, multi-line:
```jh
config {
  runtime.workspace = [
    ".:/jaiph/workspace:rw",
    "config:config:ro"
  ]
}
```
- Opening `[` must be on the same line as `=`.
- Each element is a quoted string on its own line (same quoting rules as existing strings).
- Trailing commas allowed. Comments (`#`) allowed between elements.
- Closing `]` on its own line.
- Empty array `= []` is valid (single-line).
- `parseMetadataValue()` returns `string[]`.
- Type validation: keys expecting arrays reject strings/booleans/integers with `E_VALIDATE`.

### New config keys

Add these to `ALLOWED_KEYS` (or replace with a typed key registry):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `runtime.docker_enabled` | boolean | `false` | Enable Docker sandbox |
| `runtime.docker_image` | string | `"ubuntu:24.04"` | Container image |
| `runtime.docker_network` | string | `"default"` | Docker network mode |
| `runtime.docker_timeout` | integer | `300` | Max execution time (seconds) |
| `runtime.workspace` | string[] | `[".:/jaiph/workspace:rw"]` | Mount specifications |

- Unknown `runtime.*` keys → `E_PARSE` (same as unknown keys today).
- Values populate a new `runtime` field on `WorkflowMetadata` (add `RuntimeConfig` interface to `src/types.ts`).

### Affected files
- `src/parse/metadata.ts` — extend `parseMetadataValue()` for integers and arrays; add multi-line array accumulation in `parseConfigBlock()`; add `runtime.*` keys to allowed keys with type validation.
- `src/types.ts` — add `RuntimeConfig` interface; add optional `runtime?: RuntimeConfig` to `WorkflowMetadata`.

### Acceptance criteria
- `parseMetadataValue()` parses bare integers and returns `number`.
- `parseMetadataValue()` / `parseConfigBlock()` parses `[...]` arrays and returns `string[]`.
- Trailing commas and inline comments within arrays are handled.
- All five `runtime.*` keys are accepted with correct type validation.
- Unknown `runtime.*` keys → `E_PARSE`.
- `RuntimeConfig` type added to `WorkflowMetadata`.
- Existing config tests still pass; new tests cover integers, arrays, and runtime keys.

---

## Add Docker sandbox runtime for Jaiph execution

<!-- dev-ready -->

### Problem
Jaiph currently executes transpiled shell directly on the host. We need an optional disposable container runtime to isolate execution while still allowing controlled workspace writes.

### Key design constraint
The Docker container receives **only transpiled bash and the shell stdlib** (`jaiph_stdlib.sh`). No Jaiph source files, no TypeScript runtime, no Node.js — just `bash` inside the container. The TypeScript CLI orchestrates Docker from the host side.

### Proposed syntax

Uses the `runtime.*` config keys added by the prerequisite task:

```jh
config {
  runtime.docker_enabled = true
  runtime.docker_image = "ubuntu:24.04"
  runtime.docker_network = "default"
  runtime.docker_timeout = 300

  runtime.workspace = [
    ".:/jaiph/workspace:rw",
    "config:config:ro"
  ]
}
```

### Mount parsing rules

- Full form: `"host_path:container_path:mode"` (3 segments split on `:`).
- Shorthand: `"host_path:mode"` (2 segments) — mounts at `/jaiph/workspace/<host_path>` with given mode.
- 1 segment → `E_PARSE`.
- Mode must be `ro` or `rw` → `E_PARSE` otherwise.
- Exactly one mount must target `/jaiph/workspace` (enforced at validation time; defaults to `".:/jaiph/workspace:rw"` if `runtime.workspace` is omitted entirely).
- All mounts outside `/jaiph/workspace` are read-only unless `:rw` is explicit.

### Workspace structure inside the container

```
/jaiph/
  generated/          # transpiled bash + jaiph_stdlib.sh, mounted read-only
  workspace/          # the mount targeting /jaiph/workspace (read-write root)
    .jaiph/
      runs/
        <run-id>/
          inbox/      # transient per run — see inbox task
```

- `/jaiph/generated/` contains: the transpiled `.sh` script and `jaiph_stdlib.sh`. Both mounted read-only. `JAIPH_STDLIB` env var is set to `/jaiph/generated/jaiph_stdlib.sh` inside the container.
- `.jaiph/` is auto-created and belongs in `.gitignore`.

### Docker orchestration

- New `src/runtime/docker.ts` module constructs the `docker run` command.
- Called from `src/cli/run/lifecycle.ts`, replacing the direct `spawn("bash", ...)` when Docker is enabled.
- Config values flow from the TypeScript CLI to the Docker module; no bash wrapper needed.
- The CLI copies/symlinks `jaiph_stdlib.sh` to a temp directory alongside the transpiled script, mounts that directory read-only at `/jaiph/generated/`.

### Required behavior
- Transpilation unchanged.
- `docker run --rm` with proper UID/GID mapping (`--user $(id -u):$(id -g)` on Linux).
- Works in TTY mode if TTY is available (detect `process.stdout.isTTY`; pass `-t` flag).
- `CI=true` disables Docker by default unless `runtime.docker_enabled = true` is set in file (in-file wins).
- Docker missing → clear error (`E_DOCKER_NOT_FOUND`), no silent fallback.
- Image pulled automatically if missing; pull failure is fatal.
- Timeout kills container with `E_TIMEOUT` (use `docker kill` after timeout expires).
- Precedence: env vars (`JAIPH_DOCKER_*`) > in-file config > defaults.

### fd 3 / event forwarding
Already solved by existing architecture. The CLI wrapper does `exec 3>&2`, and `parseStepEvent()` in `src/cli/run/events.ts` scans stderr for `__JAIPH_EVENT__` markers. Docker captures stderr by default and forwards it to the host process. No special fd forwarding needed.

### Environment variable mapping
Following existing `JAIPH_*` convention: `JAIPH_DOCKER_ENABLED`, `JAIPH_DOCKER_IMAGE`, `JAIPH_DOCKER_NETWORK`, `JAIPH_DOCKER_TIMEOUT`. Workspace mounts are not overridable via env (too complex for a single env var).

### Network semantics
`"default"` means use Docker's default behavior (omit `--network` flag entirely, uses bridge). `"none"` is supported for fully isolated containers. Any other string value is passed verbatim to `--network`.

### CI behavior
`CI=true` disables Docker by default because Docker-in-Docker is unavailable in many CI runners (GitHub Actions, GitLab shared runners). In-file `runtime.docker_enabled = true` overrides this default, so teams with DinD-capable runners can opt in explicitly.

### Affected files
- `src/runtime/docker.ts` (new) — builds `docker run` command from `RuntimeConfig`; handles mount parsing/validation, UID/GID, TTY, timeout, image pull.
- `src/cli/run/lifecycle.ts` — conditionally call Docker module instead of direct `spawn("bash", ...)`.
- `src/cli/commands/run.ts` — pass `RuntimeConfig` through to lifecycle; handle `JAIPH_DOCKER_*` env vars.
- `docs/configuration.md`, `docs/cli.md` — document runtime config keys and Docker behavior.

### Acceptance criteria
- Mount string parsing handles 2-segment shorthand and 3-segment full form correctly.
- Exactly one mount must target `/jaiph/workspace` (validated before Docker invocation).
- Container receives only transpiled bash + `jaiph_stdlib.sh`; no Jaiph source or Node.js.
- `JAIPH_STDLIB` is set to `/jaiph/generated/jaiph_stdlib.sh` inside the container.
- Precedence: env > in-file > defaults.
- Workspace writes persist with correct ownership on Linux.
- TTY passthrough works when available.
- Timeout kills container and reports `E_TIMEOUT`.
- Docker missing → `E_DOCKER_NOT_FOUND`.
- Image auto-pulled; pull failure is fatal.
- `CI=true` disables Docker unless in-file override.
- Docs updated.
- `.jaiph/` added to scaffolded `.gitignore`.

---

## Add inbox/watch semantics for multi-agent workflows

<!-- dev-ready -->

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

### Send operator grammar

The `->` send operator is detected before the shell fallback in the parser. Grammar production:

```
send_step = [ shell_command ] '->' identifier
```

**Detection rules:**
- Match regex `^(.+?)\s+->\s+([A-Za-z_][A-Za-z0-9_]*)$` on the trimmed line, before the shell fallback (before `workflows.ts:881`).
- Only match when `braceDepth == 0`. For multiline shell commands tracked via `braceDepth`/`shellAccumulator`, `->` detection happens when the accumulator is flushed (when `braceDepth` returns to 0), applied to the final accumulated line.
- Quote-awareness: use the parser's existing `hasUnescapedClosingQuote` / `indexOfClosingDoubleQuote` utilities. Only match `->` that appears outside of quoted strings. If `->` appears inside a quoted argument (e.g., `echo "a -> b"`), it is not a send — the whole line falls through to shell.
- **Standalone send**: `-> channel` (no preceding command) is allowed. It sends `$1` (the workflow's input argument) to the channel. Useful for forwarding messages.
- **Capture interaction**: `name = cmd -> channel` is a **parse error** (`E_PARSE: capture and send cannot be combined; use separate steps`). Capture (`genericAssignMatch` at `workflows.ts:589`) is checked first; if a capture match is found AND the RHS contains `-> identifier` at the end, emit the parse error. If you need both, use two steps: `name = cmd` then `echo "$name" -> channel`.

### AST representation

**Send step** — new `WorkflowStepDef` variant:
```typescript
| { type: "send"; command: string; channel: string; loc: SourceLoc }
```
Where `command` is the shell command before `->` (empty string for standalone `-> channel`).

**Route declarations** — parsed as steps but extracted into a separate `routes` array on `WorkflowDef`:
```typescript
export interface WorkflowRouteDef {
  channel: string;
  workflows: WorkflowRefDef[];
  loc: SourceLoc;
}

export interface WorkflowDef {
  // ... existing fields ...
  routes?: WorkflowRouteDef[];
}
```

The parser recognizes `on` lines inline, but stores them in `routes` (not `steps`). The transpiler emits `jaiph::register_route` calls at the top of the generated orchestrator function, regardless of where `on` appears in source. This keeps `steps[]` purely executable and `routes[]` purely declarative.

### Bash transpilation strategy

**New runtime functions** (in a new `src/runtime/inbox.sh`):

- `jaiph::inbox_init` — called once at script start; creates `.jaiph/runs/<run-id>/inbox/`, initializes counter `JAIPH_INBOX_SEQ=0`.
- `jaiph::send <channel> <content>` — increments `JAIPH_INBOX_SEQ`, writes content to `NNN-<channel>.txt`, appends `channel:NNN` to `JAIPH_DISPATCH_QUEUE` (a bash array).
- `jaiph::register_route <channel> <workflow_func> [<workflow_func>...]` — appends to an associative array `JAIPH_ROUTES[channel]="func1 func2"`.
- `jaiph::drain_queue` — while `JAIPH_DISPATCH_QUEUE` is non-empty, shift first entry, look up route, invoke target workflow(s) with message content as `$1`. Each invoked workflow may call `jaiph::send`, growing the queue. Max dispatch depth of 100 iterations (guard against infinite loops); exceeding this emits `E_DISPATCH_DEPTH` and aborts.

**Transpilation examples:**

`echo "foo" -> channel` transpiles to:
```bash
jaiph::send 'channel' "$(echo "foo")"
```

`-> channel` (standalone) transpiles to:
```bash
jaiph::send 'channel' "$1"
```

`on findings -> analyst` transpiles to (emitted at top of orchestrator function):
```bash
jaiph::register_route 'findings' 'main::workflow::analyst'
```

`on findings -> analyst, reviewer` transpiles to:
```bash
jaiph::register_route 'findings' 'main::workflow::analyst' 'main::workflow::reviewer'
```

**Drain loop placement:** `jaiph::drain_queue` is called once at the end of the orchestrator workflow's `::impl` function (after all steps execute). This means sends accumulate during workflow execution and are processed after the orchestrator's direct steps complete. Workflows invoked by dispatch may produce further sends, which are drained in the same loop iteration.

### Error semantics

- **Send to unregistered channel**: silent drop. The message is still written to the inbox directory for audit/debugging, but no workflow is dispatched. This allows workflows to be composed incrementally — not every channel needs a consumer.
- **Dispatched workflow exits non-zero**: dispatch loop halts immediately (fail-fast). Consistent with `set -e` semantics used throughout the runtime. The error propagates to the orchestrator.
- **Circular sends**: allowed — the queue grows naturally. A max dispatch depth of 100 guards against infinite loops. Exceeding the limit emits `E_DISPATCH_DEPTH` and aborts the run.

### Multi-target route semantics

For `on channel -> wf1, wf2`:
- Each workflow receives the **same message content** as `$1`.
- Workflows are called **sequentially in declaration order** (wf1, then wf2).
- Each can produce further sends, which are appended to the dispatch queue and drained after all targets for the current message complete.

### Progress tree integration

Dispatched workflow calls appear as **children of the `on` route declaration** in the progress tree. The `on` route is rendered as a static tree node (like a section header); dispatched calls nest under it.

- `on` route declarations are included in `collectWorkflowChildren()` output as nodes with label `on <channel> -> <workflow>`.
- Dispatched workflows emit standard `STEP_START`/`STEP_END` events with an additional `dispatched: true` field and `channel: "<channel>"` in the event metadata. The progress tree renderer correlates these with `on` route nodes using the channel name.
- `jaiph tree` (static view) shows `on` routes as leaf nodes (no children, since dispatch is dynamic).

### Trigger contract
- Called workflow receives `$1` = message content (string, not file path).
- `$2` is not passed in v1 (no event type needed without FS watching).
- Workflows remain directly callable for testing: `jaiph run analyst "some content"`.

### Runtime dispatch loop (in-memory, no FS watching)

```
1. Register all routing rules from orchestrator workflow (jaiph::register_route calls at top of function).
2. Execute orchestrator workflow top-to-bottom (run steps, shell steps, etc.).
3. When -> send is executed: write message to inbox dir, push channel:NNN to in-memory dispatch queue.
4. After orchestrator completes, drain the dispatch queue:
   a. Shift first entry from queue.
   b. Look up route for channel in JAIPH_ROUTES.
   c. If route exists, invoke each target workflow sequentially with message content as $1.
   d. Invoked workflows may call jaiph::send, appending to the queue.
   e. Repeat until queue is empty or depth limit (100) reached.
5. Run ends. .jaiph/runs/<run-id>/ is retained for debugging; cleared at start of next run.
```

No filesystem events, no watchers, no timers. The inbox directory is a durable audit log of the run, not the dispatch mechanism.

### Affected files

- `src/parse/workflows.ts` — detect `-> channel` send operator before shell fallback; parse `on channel -> workflow` routing declarations; extract routes to `WorkflowDef.routes`.
- `src/types.ts` — add `send` variant to `WorkflowStepDef`; add `WorkflowRouteDef` interface; add optional `routes` field to `WorkflowDef`.
- `src/transpile/emit-workflow.ts` — emit `jaiph::send` calls for send steps; emit `jaiph::register_route` calls for routes at top of orchestrator; emit `jaiph::drain_queue` at end of orchestrator.
- `src/transpile/validate.ts` — validate that `on` route workflow references exist; validate channel names are valid identifiers.
- `src/runtime/inbox.sh` (new) — `jaiph::inbox_init`, `jaiph::send`, `jaiph::register_route`, `jaiph::drain_queue`.
- `src/cli/run/progress.ts` — render `on` route nodes in tree; correlate dispatched events with route nodes using `channel` metadata.
- `src/runtime/events.sh` — add `dispatched` and `channel` fields to step event metadata for dispatch-triggered workflows.
- `docs/inbox.md` (new) — document dispatch loop, send operator, `on` routing, and inbox layout.

### Acceptance criteria
- Grammar supports `-> <channel>` send operator (with or without preceding shell command).
- Grammar supports `on <channel> -> <workflow>[, <workflow>...]`.
- `name = cmd -> channel` is a parse error (`E_PARSE`).
- `on` declarations are parsed into `WorkflowDef.routes`, not `steps`.
- Transpiler emits `jaiph::register_route` at top of orchestrator, `jaiph::drain_queue` at end.
- `echo "foo" -> ch` transpiles to `jaiph::send 'ch' "$(echo "foo")"`.
- Runtime dispatch is sequential and in-memory; no inotifywait/fswatch/polling.
- `$1` receives message content string.
- Inbox files written as `NNN-<channel>.txt` with monotonic counter.
- Send to unregistered channel is a silent drop (message still written to inbox).
- Non-zero exit from dispatched workflow halts dispatch (fail-fast).
- Max dispatch depth of 100 guards against circular sends.
- Multi-target routes dispatch sequentially in declaration order; each target receives the same message.
- Progress tree shows `on` routes as nodes; dispatched calls appear as children at runtime.
- Workflows remain directly invokable via `jaiph run <workflow> "<arg>"` for testing.
- Docs cover the dispatch loop, send operator, `on` routing, and inbox layout.
- Test file `inbox.test.jh` uses the exact syntax sample above with mocked commands.
