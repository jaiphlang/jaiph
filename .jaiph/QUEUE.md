# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Feature: Support positive `if ensure ref args; then` in workflow parser

The workflow parser only recognises the negated form `if ! ensure ref; then`
(without args). The positive form `if ensure ref args; then` silently falls
through as raw shell, leaving the `ensure` keyword as a literal bash command
that doesn't exist — causing a runtime `ensure: command not found` error.

### Acceptance criteria

1. `if ensure <rule_ref> [args]; then ... fi` parses into a new (or extended)
   step type and transpiles to `if <transpiled_rule_ref> [args]; then ... fi`.
2. `if ! ensure <rule_ref> [args]; then ... fi` also gains args support (the
   current regex drops everything after the ref before `;`).
3. Both forms support `else` branches (currently only then-steps until `fi`
   are collected; `else` is silently swallowed as a then-step).
4. Parser emits a clear `E_PARSE` error when `ensure` appears inside an
   unrecognised shell context instead of silently passing it through.
5. At least one `.test.jh` or compiler-golden test covers the positive form
   with args.

---

## Bug: Empty lines from prompt params in tree view are not removed

### Questions / concerns before development

1. **Missing reproduction case** — What does the prompt source look like that triggers this? Is it a multiline `prompt "..."` with blank lines in the text, or params passed via CLI args that happen to be empty strings? Please add a concrete before/after example (actual tree output vs expected tree output).
2. **Missing acceptance criteria** — The task needs testable criteria. Suggested starting point:
   - `formatParamsForDisplay()` in `src/cli/commands/run.ts` should filter out params whose value is empty or whitespace-only (after stripping key prefix).
   - Tree view output for a multiline prompt with blank lines should collapse to a single-line preview with no extra whitespace artifacts.
   - A test case (unit or `.test.jh`) should demonstrate the fix.
3. **Scope clarification** — Should the fix apply only to `prompt`-kind steps, or to all step kinds that display params in the tree view? The `formatParamsForDisplay()` function is shared across workflow/prompt/function/rule kinds.
4. **Where exactly are the empty lines introduced?** — The likely location is `formatParamsForDisplay()` (line 102, `run.ts`) which does not filter empty/whitespace-only values. Confirm this is the only site, or whether the emitter (`emit-workflow.ts`) should also stop emitting empty param keys.

---

## Add `log` (or another keyword), do display additional information in the tree (keep identation)

### Questions / concerns before development

1. **Keyword not decided** — The task says "`log` (or another keyword)" but the keyword must be chosen before implementation. This affects the grammar (`src/parse/workflows.ts`), the AST type union (`WorkflowStepDef` in `src/types.ts`), the emitter (`src/transpile/emit-workflow.ts`), and the tree renderer (`src/cli/run/progress.ts`). Suggestion: settle on `log` as the keyword.
2. **What is "additional information"?** — The task needs to specify what content `log` displays. Is it:
   - A static string literal? (`log "Starting analysis phase"`)
   - A variable interpolation? (`log "Result: $result"`)
   - The output of an expression or shell command?
   This determines whether the parser needs to handle string interpolation, heredocs, or bare expressions.
3. **Display semantics unclear** — "Display in the tree (keep indentation)" could mean several things:
   - **Compile-time only**: the log message appears as a label in the static tree view (`jaiph tree` / `jaiph run --dry-run`), but produces no runtime output.
   - **Runtime only**: the message is `echo`'d at execution time and appears in the live progress tree (like `STEP_START`/`STEP_END` events in `src/runtime/events.sh`).
   - **Both**: a static label in the tree + runtime output with tree indentation preserved.
   Each option has very different implementation scope. Please specify which is intended.
4. **No acceptance criteria** — The task needs testable criteria. Suggested starting point:
   - Grammar accepts `log "..."` inside workflow blocks.
   - The tree view (`jaiph tree`) renders log lines at the correct indentation level, preserving tree branch characters (`├──`, `└──`, `│`).
   - At runtime, log output appears inline in the progress tree at the correct depth.
   - A `.test.jh` file exercises the feature.
5. **Interaction with existing step kinds** — Currently `collectWorkflowChildren()` in `progress.ts` only renders `run`, `ensure`, `prompt`, and `shell` (when it calls a known function). A `log` step is unlike these — it's not a callable unit. Clarify: should `log` appear as a tree node with status tracking (pending → done), or as a static annotation without timing?
6. **Runtime event model** — If `log` produces runtime output, should it emit `STEP_START`/`STEP_END` events via `jaiph::run_step` (like other steps), or a new lighter-weight event type (e.g., `LOG`)? The current event schema in `events.sh` expects `kind` to be one of `workflow`/`rule`/`function`/`prompt`.

---

## Compiler: enforce calling conventions and unify symbol namespace

### Problem

The compiler currently uses three separate bash symbol prefixes (`::rule::`, `::workflow::`, `::function::`) and only resolves qualified names (`alias.name`) for `ensure` and `run` keywords. Calling an imported function in shell context required a recent workaround (`resolveShellFunctionRefs`). There is no compile-time enforcement that rules are called with `ensure` or workflows with `run` — misuse silently produces broken bash.

### Required changes

#### 1. Enforce calling conventions (compile-time errors)

The parser/validator should reject:
- A rule reference used without `ensure` → `E_VALIDATE: rule "X" must be called with ensure`
- A workflow reference used with `ensure` → `E_VALIDATE: workflow "X" must be called with run`
- A workflow reference used without `run` in a non-shell context → `E_VALIDATE: workflow "X" must be called with run`

This requires the compiler to know which names are rules, workflows, and functions — both local and imported. The validator already has the AST; it needs cross-module symbol resolution for imports.

#### 2. Flatten bash symbol namespace

Replace the triple-prefix scheme:
- `symbol::rule::name` → `symbol::name`
- `symbol::workflow::name` → `symbol::name`
- `symbol::function::name` → `symbol::name`

Same-name declarations across types in one module (e.g., a rule and a workflow both named `check`) become a parse error (`E_PARSE: duplicate name "check" — rules, workflows, and functions share a single namespace`).

#### 3. Uniform qualified-name resolution in shell context

With a flat namespace, `resolveShellFunctionRefs` becomes `resolveShellRefs` — it resolves any `alias.name` to `symbol::name` regardless of whether the target is a function, rule, or workflow. The calling convention enforcement (point 1) ensures correctness at a higher level.

### Acceptance criteria

- Compiler emits `E_VALIDATE` when a rule is called without `ensure`.
- Compiler emits `E_VALIDATE` when a workflow is called without `run`.
- Functions can be called freely (no keyword required).
- `E_PARSE` on duplicate names across rule/workflow/function in the same module.
- Bash output uses a single `symbol::name` prefix (no `::rule::`, `::workflow::`, `::function::` segments).
- Existing `.jh` files and all tests continue to work (calling convention is already followed).
- `resolveShellFunctionRefs` generalized to `resolveShellRefs` using the flat namespace.
- Docs updated (`docs/language.md` or equivalent) to document the calling conventions as compiler-enforced rules.

### Questions / concerns before development

1. **Runtime `step_identity()` broken by flat namespace** — `jaiph::step_identity()` in `src/runtime/events.sh:25-48` pattern-matches `::rule::`, `::workflow::`, `::function::` in bash function names to determine step kind for event tracking (used by the progress tree and run summaries). With flat `symbol::name`, this function cannot determine the kind. The task must specify how kind will be communicated at runtime — e.g., passed as an extra argument to `jaiph::run_step`, or encoded differently in the function name.
2. **Progress tree reconstruction not accounted for** — `src/cli/run/progress.ts` has ~20 sites that construct `{symbol}::rule::name`, `{symbol}::workflow::name`, `{symbol}::function::name` strings to correlate AST steps with runtime events. This is a significant change surface that should be listed as an affected file with an approach (e.g., all sites switch to `{symbol}::name`).
3. **Test emitter impact** — `src/transpile/emit-test.ts` has `refToWorkflowSymbol()`, `refToRuleSymbol()`, `refToFunctionSymbol()` that each produce kind-specific symbols. These need updating and should be mentioned in the required changes.
4. **Validator already partially enforces calling conventions** — `ensure` references are validated against the rules list and `run` references against the workflows list (`src/transpile/validate.ts:41-137`). Writing `ensure my_workflow` already fails with "unknown local rule reference". The new enforcement improves error messages (cross-type awareness: "workflow X must be called with run") but isn't a net-new capability. The task should acknowledge what exists and clarify the delta.
5. **Function symbol table needed in validator** — The acceptance criterion "Functions can be called freely" implies `ensure my_function` and `run my_function` should produce helpful errors. The validator currently does not track functions at all — it needs a `localFunctions` set and cross-module function resolution. This should be explicit in the required changes.
6. **Shell block enforcement out of scope?** — The task says enforce calling conventions but doesn't clarify whether this applies inside shell blocks (opaque strings). A user could call `my_rule` directly in a shell block, bypassing `ensure`. Scanning shell blocks for rule/workflow names would be fragile. Recommend explicitly scoping enforcement to DSL-level keywords only (not shell blocks) to keep this tractable.

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

### Questions / concerns before development

1. **Config parser requires new value types** — The current config parser (`src/parse/metadata.ts`) only supports quoted strings and booleans. This task requires two new value types: bare integers (`runtime.docker_timeout = 300`) and arrays (`runtime.workspace = [...]`). These are non-trivial parser extensions that should be acknowledged as prerequisite work and either included explicitly in scope or split into a separate task.
2. **Mount shorthand `"data:ro"` is ambiguous** — The two-part form `"data:ro"` is listed as producing `/jaiph/workspace/data:ro`, but the parsing logic is unclear. With only two colon-separated segments, is this `host_path:mode` (container path defaults to host name under workspace) or `host_path:container_path` (mode defaults to `ro` for non-workspace mounts)? The three-part form `"config:config:ro"` is unambiguous, but the two-part form needs an explicit grammar: define exactly how 1-, 2-, and 3-segment mount strings are parsed.
3. **Docker orchestration architecture unspecified** — The task describes what `docker run` should do but not *where* the orchestration lives. Currently `src/cli/commands/run.ts` spawns the transpiled bash script as a child process. Should a new `src/runtime/docker.ts` module construct the `docker run` command and replace the direct spawn? Or should a bash wrapper script handle it? This architectural decision affects how config values flow from the TypeScript CLI to the container.
4. **Runtime event fd 3 passthrough not addressed** — The progress tree and run summaries depend on structured JSON events emitted on file descriptor 3 (`src/runtime/events.sh`). Docker does not forward arbitrary file descriptors by default. The task must specify how fd 3 events reach the host CLI — e.g., via a named pipe mounted into the container, or by falling back to stderr with a prefix-based demux.
5. **Environment variable names undefined** — The acceptance criterion "Precedence: env > in-file > defaults" references environment variables, but the task doesn't define them. What are the env var names? E.g., `JAIPH_RUNTIME_DOCKER_ENABLED`, `JAIPH_RUNTIME_DOCKER_IMAGE`? These need to be specified so the precedence logic can be implemented and documented.
6. **`CI=true` disables Docker — rationale unclear** — The requirement "`CI=true` disables Docker by default" seems counter-intuitive. In CI environments, Docker isolation is typically *more* desirable. If the concern is that Docker-in-Docker isn't available in all CI runners, state that explicitly and consider making the default `CI=true → warn if Docker unavailable` rather than silently disabling.
7. **Scope is too large for a single implementation cycle** — This task spans: (a) config parser extensions (arrays, integers, new `runtime.*` namespace), (b) mount string parsing and validation, (c) Docker CLI orchestration in TypeScript, (d) fd 3 event forwarding, (e) UID/GID mapping, (f) TTY detection and passthrough, (g) timeout/container kill logic, (h) docs. Recommend splitting into at least two tasks: **Task A** — config parser extensions (arrays, integers, `runtime.*` keys with validation); **Task B** — Docker runtime implementation (using the config values from Task A).
8. **`runtime.docker_network = "default"` semantics unclear** — Docker's `--network` flag uses `bridge` as the default network, not `default`. Does `"default"` mean "use Docker's default (bridge)" or is it a literal network name? Also, should `"none"` be supported to run fully isolated containers? Clarify the allowed values and their mapping to `docker run` flags.

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

### Questions / concerns before development

1. **`->` send operator grammar rule undefined** — The syntax `echo '## findings' -> findings` embeds `->` at the end of what the parser currently treats as an opaque shell line (falls through to `type: "shell"` at `src/parse/workflows.ts:881`). The parser needs an explicit rule for detecting `-> identifier` at the end of a line and splitting it into a send step (shell command + channel). Critical edge cases to specify: (a) What about multiline shell commands tracked via `braceDepth`/`shellAccumulator`? If `->` appears at the end of a brace-tracked block, the accumulator won't detect it. (b) What about `->` inside quoted strings in shell context — how does the parser avoid false matches? (c) Can `->` appear standalone without a preceding command (e.g., `-> channel` sending `$1` or a variable)? Define the grammar production explicitly.
2. **Bash transpilation strategy missing** — The dispatch loop is described conceptually but not in terms of generated bash. The current architecture generates a self-contained bash script; all runtime support lives in bash (`steps.sh`, `events.sh`, etc.). The task must specify: (a) What new bash runtime functions are needed (e.g., `jaiph::send`, `jaiph::register_route`, `jaiph::drain_queue`)? (b) What bash code does `echo "foo" -> channel` transpile to? (c) What does `on findings -> analyst` transpile to — a `jaiph::register_route` call at the top of the function? (d) Where does the drain loop execute — after every `jaiph::run_step` call, or at the end of the orchestrator workflow? Without this, the implementer must make fundamental architectural decisions that should be settled in design.
3. **`on` declaration position semantics ambiguous** — The task says `on` declarations are "static routing rules registered at startup, not executable statements," but in the syntax example they appear inline after `run researcher`. If position is irrelevant, should the parser extract them into a separate `routes` array on `WorkflowDef` (parallel to `steps`)? Or does the transpiler emit registration calls at the top of the generated function regardless of source order? This affects both the AST type in `src/types.ts` (new `WorkflowStepDef` variant vs. new field on `WorkflowDef`) and the emitter.
4. **Error semantics undefined** — The task doesn't specify behavior for: (a) `->` targets a channel with no registered `on` route — silent drop or fatal error? (b) A dispatched workflow exits non-zero — does the dispatch loop halt or continue draining? (c) Circular sends (workflow A sends on channel X, triggering workflow B, which also sends on channel X) — is this allowed (queue grows), or should there be a max-depth guard?
5. **Progress tree integration unspecified** — `src/cli/run/progress.ts` reconstructs the execution tree from static AST + runtime events (fd 3). Dispatched workflow calls are dynamic — they have no corresponding AST node in the orchestrator's `steps[]` array. The task should specify how dispatched calls appear in the progress tree (e.g., as children of the `on` route declaration, as top-level dynamic nodes, or suppressed). This also affects the event `kind` taxonomy in `events.sh` — does a dispatched workflow emit standard `STEP_START`/`STEP_END` events, or a new event type?
6. **`on` with multiple workflows needs dispatch semantics** — The acceptance criteria include `on <channel> -> <workflow>[, <workflow>...]` but the example only shows single-target routes. For multi-target: does each workflow receive the same message content? Are they called sequentially in declaration order? Can they each produce further sends? Specify.
7. **Capture interaction with `->` unspecified** — The existing grammar supports `name = shell_command` (capture stdout to variable). What does `name = echo "foo" -> channel` mean? Does the capture get the shell command's stdout AND the message is also sent to the channel? Or is capture incompatible with send? This must be defined since the parser's capture detection (`genericAssignMatch` at `workflows.ts:589`) would match before any `->` detection.
