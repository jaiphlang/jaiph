---
title: CLI Reference
permalink: /cli
redirect_from:
  - /cli.md
---

# Jaiph CLI Reference

## Overview

Jaiph ships as a **command-line tool**: you point it at `.jh` sources (or test files), and it prepares scripts, launches the workflow runtime, streams progress, and writes run artifacts under `.jaiph/runs`. This page is the **CLI contract** — flags, environment, and how the tool behaves on your machine. Language syntax and step semantics live in [Grammar](grammar.md) and related docs.

**What you use it for**

- **Run a workflow** — `jaiph run <file.jh>` or shorthand `jaiph <file.jh> [args...]`. The entry file must define **`workflow default`**.
- **Run tests** — `jaiph test` discovers `*.test.jh` under the workspace, or you pass a directory or one test file.
- **Set up a project** — `jaiph init [workspace-path]` creates `.jaiph/` with a bootstrap workflow and synced skill guide; `jaiph use <version|nightly>` reinstalls the global Jaiph binary via the install script.
- **Inspect runs** — `jaiph report` serves a read-only local dashboard over `.jaiph/runs` (see [Reporting server](reporting.md)).

**Commands:** `run`, `test`, `init`, `use`, `report`.

**How this fits the architecture**

The CLI is the **entry and orchestration shell**: it runs **compile-time** validation and script extraction (`buildScripts()` → **`validateReferences`** → per-`script` files only; no workflow-level shell modules), then executes workflows through the **Node workflow runtime** (`NodeWorkflowRuntime`), which **interprets the AST** — there is no Bash transpilation of workflows on the runtime path (only extracted **`script`** bodies are emitted as shell). **`jaiph run`** spawns the **Node workflow runner** (`node-workflow-runner`), which calls `buildRuntimeGraph()` (parse-only imports; validation is not repeated there) then `NodeWorkflowRuntime`. The CLI owns process **spawn** and **signal propagation** to the runner; **`prompt`** and **`script`** execution (subprocesses for **`script`** steps), **file-backed inbox**, and **`__JAIPH_EVENT__` on stderr** / **`run_summary.jsonl`** live in the **JS kernel** under **`src/runtime/kernel/`**. **`jaiph test`** loads `*.test.jh` in-process via **`node-test-runner.ts`** (same runtime + mocks). Optional [Sandboxing](sandboxing.md) runs the same runner inside Docker. For boundaries, contracts, and diagrams, see [Architecture](../ARCHITECTURE.md).

**Global options:** `-h` / `--help` and `-v` / `--version` are handled only when they appear as the **first argument after the program name** (for example `jaiph --help`, or `node dist/src/cli.js --help` when developing). They are not parsed as global flags after a subcommand or file path (`jaiph run --help` is **not** global help — use `jaiph --help` for the top-level usage text). **`jaiph report`** accepts `-h` / `--help` in its own argv: `jaiph report --help`.

---

## `jaiph <file.jh>` and `jaiph <file.test.jh>` (shorthand)

If the first argument is an existing file whose name ends with **`.test.jh`**, Jaiph runs it as tests (same as `jaiph test <file>`). Otherwise, if it is an existing file whose name ends with **`.jh`**, Jaiph runs it as a workflow (same as `jaiph run <file>`). The **`*.test.jh`** branch is checked first so test files are never mistaken for workflows.

Workflow shorthand:

```bash
jaiph ./flows/review.jh "review this diff"
# equivalent to: jaiph run ./flows/review.jh "review this diff"
```

Test shorthand:

```bash
jaiph ./e2e/say_hello.test.jh
# equivalent to: jaiph test ./e2e/say_hello.test.jh
```

## `jaiph run`

Parse, validate, and run a Jaiph workflow file via the Node workflow runtime.
`jaiph run` requires a `workflow default` entrypoint.

```bash
jaiph run [--target <dir>] <file.jh> [--] [args...]
```

Paths ending in **`.jh`** are accepted (including **`*.test.jh`**, since the extension is still `.jh`). For files that only contain test blocks, use **`jaiph test`** instead — that is the supported path for `*.test.jh`.

**Compile-time scope:** `buildScripts()` walks the entry file and its **import closure**. Each reachable module is parsed and **`validateReferences`** runs before script files are written. Unrelated `.jh` files on disk are not read. Use `--target` to keep emitted **script** files (and the run metadata file next to them) in a specific directory (useful for debugging); without it, they are written to a temp directory and cleaned up after the run. Use `--` to separate Jaiph flags from workflow arguments (e.g. `jaiph run file.jh -- --verbose`).

**Process model:** the CLI runs **`buildScripts()`** (validation + script extraction), then spawns the **Node workflow runner** as a detached child. The runner loads the graph with **`buildRuntimeGraph()`** (parse-only imports; no `validateReferences` here) and executes **`NodeWorkflowRuntime`**. **`prompt`** steps, **`script`** subprocesses, inbox dispatch, and event emission are handled in **`src/runtime/kernel/`** (workflows and rules are interpreted in-process; only **`script`** steps spawn a managed shell). The CLI listens on **stderr only** for **`__JAIPH_EVENT__`** JSON lines — the single event channel for all execution modes (local and Docker). Stdout carries only plain script output, forwarded to the terminal as-is.

Examples:

```bash
jaiph run ./.jaiph/bootstrap.jh
jaiph run ./flows/review.jh "review this diff"
```

Argument passing: positional arguments are available inside **`script`** bodies as standard bash `$1`, `$2`, `"$@"`. In Jaiph orchestration strings (`log`, `prompt`, `fail`, `return`, `send`, `run`/`ensure` args), use **`${arg1}`**, **`${arg2}`**, and **`${name}`** — **JS template literal** rules with **only** `${identifier}` forms (no shell parameter expansion). The same rule applies to `prompt` text and to **`const`** RHS strings where orchestration applies.

Rules also receive forwarded arguments through `ensure`, for example:

```jaiph
script check_branch {
  test "$(git branch --show-current)" = "$1"
}

rule current_branch {
  run check_branch("${arg1}")
}

workflow default {
  ensure current_branch("main")
}
```

Workflow and rule bodies contain structured Jaiph steps only — use **`run`** to call a **`script`** for shell execution. In bash-bearing contexts (mainly **`script`** bodies, and restricted `const` / send RHS forms), `$(...)` and the first command word are validated: they must not invoke Jaiph rules, workflows, or scripts, contain inbox send (`<-`), or use `run` / `ensure` as shell commands (`E_VALIDATE`). See [Grammar — Managed calls vs command substitution](grammar.md#managed-calls-vs-command-substitution).

For **`const`** in those bodies, a **reference plus arguments** on the RHS must be written as **`const name = run ref([args…])`** (or **`ensure`** for rule capture), not as **`const name = ref([args…])`** — the latter is **`E_PARSE`** with text that explains the fix (same rule as managed calls elsewhere).

If a `.jh` file is executable and has `#!/usr/bin/env jaiph`, you can run it directly:

```bash
./.jaiph/bootstrap.jh "task details"
./flows/review.jh "review this diff"
```

### Run progress and tree output

During `jaiph run`, the CLI renders a tree of steps. **Shared in TTY and non-TTY:** each step appears as a line with a marker (▸ when started, ✓/✗ when done), the step kind (`workflow`, `prompt`, `script`, `rule`), and the step name. **`log` messages** also appear inline in the tree at the correct indentation depth — they have no marker, spinner, or timing; just the `ℹ` symbol (dim/gray) followed by the message text. **Completion lines include the step kind and name** so that each line is self-identifying even when multiple steps run concurrently (e.g. `✓ workflow scanner (0s)`, `✗ rule ci_passes (11s)`). The root PASS/FAIL summary retains its existing format (`✓ PASS workflow default (0.2s)`). There are no per-step live elapsed counters or in-place updates on the start/completion tree lines themselves.

**`log` / `logerr` and backslash escapes:** The string shown after `ℹ` / `!`, and the bytes written to stdout/stderr for those keywords, follow **`echo -e`** semantics after Jaiph/bash quoting and variable expansion — e.g. a literal `\n` or `\t` in the message becomes a newline or tab in the tree and on the streams. **`LOG` / `LOGERR`** JSON on stderr (and the **`message`** field in `run_summary.jsonl`) still carries the **unexpanded** shell string: the runtime only applies `jaiph::json_escape` for JSON, so consumers do not see a second round of escape interpretation.

**TTY only:** One extra line at the bottom shows which workflow is running and total elapsed: `▸ RUNNING workflow <name> (X.Xs)` — `▸ RUNNING` in yellow, `workflow` in bold, workflow name in default style, time in dim. This line is the **only** line updated in place (every second). When the run completes, that line is cleared and replaced by the final PASS/FAIL line.

**Non-TTY** (stdout not a TTY — CI, pipes, log capture): No RUNNING line and no in-place updates. Step start lines (▸) and completion lines (✓/✗) still print as they occur. **Long-running steps** additionally print **status heartbeat** lines so a quiet stretch between ▸ and ✓ does not look like a hang:

- Format: **`· <kind> <name> (running <N>s)`** — middle dot `·`, same `<kind> <name>` pair as on the matching completion line (e.g. `· prompt prompt (running 60s)` before `✓ prompt prompt (91s)`), wall-clock seconds `N` since that step started.
- Styling: the **entire** heartbeat line is dim/gray when colors are enabled; with `NO_COLOR` set, it is plain text (no ANSI dim).
- Cadence: nothing is printed until the step has been running at least **`JAIPH_NON_TTY_HEARTBEAT_FIRST_SEC`** seconds (default **60**). After that, additional heartbeats appear when at least **`JAIPH_NON_TTY_HEARTBEAT_INTERVAL_MS`** milliseconds have passed since the last heartbeat **and** the elapsed second count has increased (default interval **30000**; values below **250** fall back to the default). Short steps therefore usually emit **no** heartbeats.
- **Nested steps:** heartbeats describe the **innermost** step currently running (the deepest active step on the stack).

On stderr, the runtime emits **`__JAIPH_EVENT__` lines** (each followed by JSON). The CLI parses valid JSON to drive the tree, hooks, and failure summaries, so those lines do not appear verbatim in the log. Any **other** stderr text is forwarded to your terminal; in TTY mode the bottom “RUNNING …” line is cleared and redrawn around those writes. `STEP_END` payloads may embed step output (`out_content` / `err_content`); the runtime JSON-escapes those strings so tabs, ANSI escape bytes, and other control characters cannot break the line. If a payload is not valid JSON, the CLI treats it as plain stderr — in CI you may see a raw `__JAIPH_EVENT__ …` line instead of structured progress.

For **parameterized** invocations—when you pass arguments to a workflow, prompt, script, or rule—the tree shows those argument **values** inline in gray immediately after the step name. Format:

- All parameters use a uniform **`key="value"`** format in parentheses. Internal refs such as `::impl` and empty or whitespace-only values are omitted.
- **Positional parameters** (`${arg1}`, `${arg2}`, or `argN`) display as `1="value"`, `2="value"`, etc. **Named parameters** display as `name="value"`.
- **Whitespace normalization:** Newlines, tabs, and consecutive spaces inside parameter values are collapsed to a single space before display. This keeps multi-line prompt bodies, roles, and similar values readable on a single tree line.
- Values are truncated to 32 visible characters; longer values end with `...`.
- **Prompt steps:** The line shows a **prompt preview** (first 24 characters of the prompt text, then `...` if longer) in quotes, followed by parameters. The parameter list is capped at 96 characters total (truncated with `...` if longer).
- Order follows the call site so repeated runs are diff-friendly.

Example lines:

- `▸ workflow docs_page (1="docs/cli.md", 2="strict")`
- `· prompt prompt (running 60s)` — non-TTY only, after the quiet threshold; entire line dim/gray; same `prompt prompt` label as the eventual `✓ prompt prompt (…)` line
- `·   ▸ prompt "${role} does ${task}" (role="engineer", task="Fix bugs")`
- `·   ▸ prompt "Say hello to ${arg1} and..." (arg1="greeting")`
- `·   ▸ script fib (1="3")`
- `·   ▸ rule check_arg (1="Alice")`

If no parameters are passed, the line is unchanged (e.g. `▸ workflow default`). Color can be disabled with `NO_COLOR=1`.

**Async sibling depth.** When a workflow contains multiple `run async` steps, all async branches render as **siblings at the same indentation level** — they do not nest under each other regardless of interleaving order. Inner steps (`prompt`, `script`, `log`) within each branch appear one level deeper under their respective `async workflow` header. The runtime achieves this by isolating each async branch's frame stack, so the `depth` field on `STEP_START` / `STEP_END` / `LOG` events is always relative to the branch's own call depth, not the global stack.

**Prompt steps do not add extra tree nodes for the transcript.** The progress renderer still shows only the usual ▸ / ✓ lines for a `prompt` step — not a nested Command / Prompt / Final answer subtree. **On terminal stdout (non-test runs),** after the step completes, when that step’s stdout was **not** already streamed live (no tee path for that managed step), the runtime **replays** the step’s `.out` artifact so the full transcript appears **after** the ✓ line. That ordering matches patterns such as inbox dispatch (step completion before routed output). **Prompt** replay is skipped when stdout is a pipe (so shell capture is not polluted) or when the prompt path already streamed via tee. **`jaiph test`** runs under **`JAIPH_TEST_MODE`** and **does not** use this replay path, so assignment capture (`response = alias.workflow`) and assertions stay the same as before the kernel split.

To surface the agent answer as an inline **`ℹ`** line in the tree at the right depth, use **`log`** explicitly:

```jaiph
response = prompt "Summarize the report"
log "${response}"
```

The `log` line renders inline as `ℹ <message>` (dim/gray) and writes to **stdout**. The `logerr` variant renders as `! <message>` in red and writes to **stderr**. (As above, the displayed/streamed text uses **`echo -e`**; event JSON keeps the raw string.) The step's `.out` file in `.jaiph/runs/` remains the full agent transcript for debugging and reporting.

### Failed run summary (stderr)

On non-zero exit, the CLI may print a footer with the path to **`run_summary.jsonl`**, **`out:`** / **`err:`** artifact paths, and **`Output of failed step:`** plus a trimmed excerpt. Those paths and the excerpt are resolved from the **first** `STEP_END` object in the summary with **`status` ≠ 0**, using **`out_content` / `err_content`** when present and otherwise the **`out_file` / `err_file`** fields on that same line — not from “latest” filenames by sort order in the run directory, which can belong to a different step. If no failed `STEP_END` is found (or the summary is missing), the CLI falls back to the run-directory artifact heuristic.

### Run artifacts and live output

Each run directory is **`<JAIPH_RUNS_DIR>/<YYYY-MM-DD>/<HH-MM-SS>-<source>/`**, where **`<date>`** and **`<time>`** are **UTC** wall-clock parts and **`<source>`** is `JAIPH_SOURCE_FILE` if set, otherwise the entry file basename (see `NodeWorkflowRuntime` constructor). Every step writes stdout and stderr to artifact files under that directory (see `JAIPH_RUNS_DIR`). Files are named with a zero-padded sequence prefix reflecting execution order: `000001-module__rule.out`, `000002-module__workflow.err`, etc.

**All step kinds write to artifact files incrementally during execution**, not only after the step completes. This means you can tail a running step's output in real time from another terminal:

```bash
# In one terminal — run a long workflow
jaiph run ./flows/deploy.jh

# In another terminal — watch a step's output as it executes
tail -f .jaiph/runs/2026-03-22/14-30-00-deploy.jh/000003-deploy__run_migrations.out
```

Both `.out` (stdout) and `.err` (stderr) files grow as the step produces output. Steps that produce no output on a given stream have no corresponding artifact file. Empty files are cleaned up automatically at step end.

### Run summary (`run_summary.jsonl`) {#run-summary-jsonl}

Each run directory also contains **`run_summary.jsonl`**: one JSON object per line, appended in execution order. It is the canonical **append-only** record of reporting-oriented runtime events (lifecycle, logs, inbox flow, and step boundaries). Tooling can **tail the file by byte offset** and process new lines idempotently; parallel inbox dispatch may reorder some events relative to wall-clock time, but each line is written atomically under the same lock used for concurrent writers (see [Inbox — Lock behavior](inbox.md#lock-behavior)).

**Versioning.** Every persisted object includes **`event_version`** (currently **`1`**). New fields may be added in later versions; consumers should tolerate unknown keys.

**Common fields.** All summary lines include **`type`**, **`ts`** (UTC timestamp), **`run_id`**, and **`event_version`**. Step-related types also carry stable correlation fields **`id`**, **`parent_id`**, **`seq`**, and **`depth`** where applicable (matching the `__JAIPH_EVENT__` stream on stderr).

**Correlation rules (reporting).**

- **`run_id`:** Every line in a given run’s file uses the same `run_id` as the root workflow run.
- **Workflow boundaries:** For each workflow name, the number of `WORKFLOW_START` lines with that `workflow` value equals the number of `WORKFLOW_END` lines with the same value. Nesting is stack-shaped in sequential runs; when **`JAIPH_INBOX_PARALLEL=true`**, lifecycle lines for different dispatched workflows may interleave—use per-name counts, not a single global stack.
- **Steps:** `STEP_START` and `STEP_END` share the same **`id`**. For a given `id`, the start line appears before the end line in file order. Use **`parent_id`**, **`seq`**, and **`depth`** to rebuild the tree (same semantics as stderr `__JAIPH_EVENT__` payloads).
- **Inbox:** One **`INBOX_ENQUEUE`** is emitted per `send` with a unique **`inbox_seq`** (zero-padded string, e.g. `001`). For each routed target, there is one **`INBOX_DISPATCH_START`** and one **`INBOX_DISPATCH_COMPLETE`** sharing the same **`inbox_seq`**, **`channel`**, **`target`**, and **`sender`**. The start line precedes its matching complete line. Enqueue for a given seq precedes any dispatch lines for that seq.
- **Ordering under parallel inbox:** Lines are still a valid JSONL stream (one complete JSON object per line, appended atomically under lock). Wall-clock `ts` order may diverge from append order between concurrent dispatch targets; consumers should not assume total `ts` ordering across parallel branches.

**Event taxonomy — persisted schema (`event_version` 1).** Step, workflow, and log lines on stderr are built in **`src/runtime/kernel/emit.ts`**. **`INBOX_*`** summary lines are built in **`inbox.ts`** during send/dispatch and appended through the same locked **`run_summary.jsonl`** helper as other persisted events. **`PROMPT_START`** / **`PROMPT_END`** lines are written from **`node-workflow-runtime.ts`** (`emitPromptEvent`) for prompt lifecycle. The live `__JAIPH_EVENT__` stream and the JSONL file share one **consumer-facing** contract; release notes call out any intentional shifts. The table below summarizes the main **reporting-oriented** types; `PROMPT_*` and any future types still carry **`type`**, **`ts`**, **`run_id`**, and **`event_version`**.

| Field | `WORKFLOW_START` | `WORKFLOW_END` | `STEP_START` | `STEP_END` | `LOG` | `LOGERR` | `INBOX_ENQUEUE` | `INBOX_DISPATCH_START` | `INBOX_DISPATCH_COMPLETE` |
|-------|------------------|----------------|--------------|------------|-------|----------|-----------------|------------------------|---------------------------|
| `type` | required | required | required | required | required | required | required | required | required |
| `ts` | required | required | required | required | required | required | required | required | required |
| `run_id` | required | required | required | required | required | required | required | required | required |
| `event_version` | required (`1`) | required (`1`) | required (`1`) | required (`1`) | required (`1`) | required (`1`) | required (`1`) | required (`1`) | required (`1`) |
| `workflow` | required (name) | required (name) | — | — | — | — | — | — | — |
| `source` | required (basename or empty) | required (basename or empty) | — | — | — | — | — | — | — |
| `func`, `kind`, `name` | — | — | required | required | — | — | — | — | — |
| `status`, `elapsed_ms` (step) | — | — | null on start | required numbers when ended | — | — | — | — | — |
| `out_file`, `err_file` | — | — | required strings | required strings | — | — | — | — | — |
| `id`, `parent_id`, `seq`, `depth` | — | — | required | required | — | — | — | — | — |
| `params` | — | — | optional JSON array | optional JSON array | — | — | — | — | — |
| `dispatched`, `channel`, `sender` | — | — | optional (inbox dispatch) | optional (inbox dispatch) | — | — | — | — | — |
| `out_content`, `err_content` | — | — | — | optional on `STEP_END` | — | — | — | — | — |
| `message`, `depth` | — | — | — | — | required | required | — | — | — |
| `inbox_seq`, `channel`, `sender` | — | — | — | — | — | — | required | required | required |
| `payload_preview`, `payload_ref` | — | — | — | — | — | — | required | — | — |
| `target` | — | — | — | — | — | — | — | required | required |
| `status`, `elapsed_ms` (dispatch) | — | — | — | — | — | — | — | — | required (exit code and ms) |

**`PROMPT_START` / `PROMPT_END`** (not in the table above): include **`backend`**, optional **`status`**, optional **`preview`**, **`depth`**, and optional **`step_id`** / **`step_name`** tying the prompt to the enclosing step frame. See `emitPromptEvent` in `node-workflow-runtime.ts` for the exact fields.

Semantics and notes:

- **`WORKFLOW_START` / `WORKFLOW_END`:** Mark entry and exit of a workflow body (`workflow` is the declared name; `source` is the `.jh` basename when the runtime set `JAIPH_SOURCE_FILE`).
- **`STEP_START` / `STEP_END`:** Mirror stderr step events; persisted payloads include **`event_version`**. `STEP_END` may include **`out_content`** / **`err_content`** (embedded artifact text, size-capped; see runtime).
- **`LOG` / `LOGERR`:** Emitted by the `log` / `logerr` keywords; **`depth`** is the step-stack depth at emission (integer). **`message`** is the log text as a JSON string — the shell string before terminal **`echo -e`** expansion (same value the runtime passes to `jaiph::json_escape`).
- **`INBOX_ENQUEUE`:** Recorded when a message is queued; **`payload_preview`** is a UTF-8-safe JSON string (prefix up to 4096 bytes of body; if truncated, ends with `...`). **`payload_ref`** is JSON `null` when the full body fits in the preview, otherwise a run-relative path such as `inbox/001-channel.txt`.
- **`INBOX_DISPATCH_START` / `INBOX_DISPATCH_COMPLETE`:** Wrap one invocation of a route target. **`status`** is the process exit code; **`elapsed_ms`** is wall time for that dispatch.

Together with step `.out` / `.err` files, a single `run_summary.jsonl` is enough to reconstruct the step tree (start/end pairs), log and logerr timelines, inbox enqueue → dispatch → completion flow, and workflow boundaries.

The **`jaiph report`** command exposes this data through a small local HTTP API and browser UI (run list, step tree, embedded previews, raw logs, aggregate view, active runs). See [Reporting server](reporting.md).

Automated regression for this contract (including parallel inbox dispatch) lives in the repository E2E script `e2e/tests/88_run_summary_event_contract.sh` (uses `python3` to parse and assert on the JSONL file).

### Hooks

You can run custom commands at workflow/step lifecycle events via **hooks**. Config lives in `~/.jaiph/hooks.json` (global) and `<project>/.jaiph/hooks.json` (project-local); project-local overrides global per event. See [Hooks](hooks.md) for schema, events, payload, and examples.

## `jaiph test`

Run tests from native test files (`*.test.jh`) that contain `test "..." { ... }` blocks. Test files can import workflows and use `mock prompt` (or `mock prompt { ... }`) to simulate agent responses without calling the real backend.

Execution uses the **Node workflow runtime** (`NodeWorkflowRuntime`) with a pure-Node test runner (`node-test-runner.ts`). For each test file, the CLI runs **`buildScripts(workspace)`** (workspace `*.jh` only — not `*.test.jh`) so imported modules have emitted scripts under **`JAIPH_SCRIPTS`**, then **`runTestFile`** calls **`buildRuntimeGraph(testFile)` once** and reuses that graph across all `test "…" { … }` blocks. Each block runs through the same AST interpreter as `jaiph run`, with mock support for prompt responses, workflow/rule/script body replacements, and assertion evaluation (`expectContain`, `expectEqual`, `expectNotContain`) — all in TypeScript. The runtime sets **`JAIPH_TEST_MODE`** so mocks, assertion helpers, and workflow capture semantics stay contract-compatible; CLI reporting for the test command itself (per-test ✓/✗ lines and the final summary) is unchanged.

**Usage:**

- `jaiph test` — discover and run all `*.test.jh` under the workspace root. The workspace root is the first directory found when walking **up** from the current working directory that contains `.jaiph` or `.git`. If neither marker exists on that path, the root is the resolved current working directory.
- `jaiph test <dir>` — run all `*.test.jh` files **recursively** under the given directory (workspace root is detected the same way, starting from `<dir>`).
- `jaiph test <file.test.jh>` — run a single test file.

With no arguments, or with a directory that contains no test files, the command exits with status **1** and prints an error.

You must pass a test file (e.g. `say_hello.test.jh`) or a directory. Passing a plain workflow file (e.g. `say_hello.jh`) is not supported; the test file imports the workflow and declares mocks. Extra arguments after the test file path are **not** forwarded into test blocks (they are ignored today). See [Testing](testing.md) for test block syntax and `expectContain` / `expectEqual` / `expectNotContain`.

Examples:

```bash
jaiph test
jaiph test ./e2e
jaiph test e2e/workflow_greeting.test.jh
jaiph test e2e/say_hello.test.jh
```

## `jaiph init`

Initialize Jaiph files in a workspace directory.

```bash
jaiph init [workspace-path]
```

Creates:

- `.jaiph/bootstrap.jh` — if it does not exist (otherwise left unchanged). Made executable.
- `.jaiph/jaiph-skill.md` — synced from the local Jaiph installation when the skill file is found; otherwise sync is skipped and a note is printed.

## `jaiph use`

Reinstall Jaiph globally with the selected channel/version.

```bash
jaiph use <version|nightly>
```

Behavior:

- `nightly` -> installs from `main` branch
- `<version>` -> installs tag `v<version>`

Examples:

```bash
jaiph use nightly
jaiph use 0.6.0
```

## `jaiph report` {#jaiph-report}

Serve a **read-only** reporting dashboard over run artifacts: `run_summary.jsonl` plus step `.out` / `.err` files under the runs root (default `<workspace>/.jaiph/runs`). No database; the server indexes and tails summary files the runtime already writes.

```bash
jaiph report [start|stop|status] [--host <addr>] [--port <n>] [--poll-ms <n>] [--runs-dir <path>] [--workspace <path>] [--pid-file <path>]
```

**Commands:**

- **`start`** — Start server in foreground and block until `Ctrl+C` (default when omitted).
- **`stop`** — Stop the server process referenced by the PID file.
- **`status`** — Check if the PID-referenced server is running.

**Options:**

- **`--host`** — Bind address (default **`127.0.0.1`**).
- **`--port`** — Listen port (default **`8787`**).
- **`--poll-ms`** — Interval for the server’s summary tail loop in milliseconds (default **500**, minimum **50**).
- **`--runs-dir`** — Runs root directory. When omitted, uses **`JAIPH_REPORT_RUNS_DIR`** if set, otherwise `<workspace>/.jaiph/runs` (same layout as [Run artifacts](#run-artifacts-and-live-output)).
- **`--workspace`** — Project directory used to resolve the default runs path (default: current working directory).
- **`--pid-file`** — Path to PID file used by `status`/`stop` (default `<workspace>/.jaiph/report.pid`).

**Behavior (summary):** Discovers runs under `<YYYY-MM-DD>/<time>-<source>/run_summary.jsonl`, keeps a **cached directory scan** with a minimum interval between full rescans, and **tails** each summary with a byte offset and inode/size tracking so appended lines update **live** state without rereading whole files. Truncation or file replacement triggers a full resync for that run. HTTP API and UI details: [Reporting server](reporting.md).

## File extension

**`.jh`** is the file extension for Jaiph source files. Use it for entrypoints, imports, and all CLI commands (`run`, `test`). Import resolution appends `.jh` when the path omits the extension.

## Environment variables

**Runtime and config overrides** (for `jaiph run` and workflow execution):

- `JAIPH_META_FILE` — **internal:** path to the metadata file the CLI writes under the build output directory; the workflow runner reads it after exit (status, `run_dir`, `summary_file`). The launcher sets this **on the child process** when spawning `node-workflow-runner`. Do not set it yourself; **`resolveRuntimeEnv`** removes any inherited `JAIPH_META_FILE` from the parent so a stale value cannot leak into runs (`src/cli/run/env.ts`, `src/runtime/kernel/workflow-launch.ts`).
- `JAIPH_RUN_DIR`, `JAIPH_RUN_ID`, `JAIPH_RUN_SUMMARY_FILE` — **internal:** set by `NodeWorkflowRuntime` to the run directory, stable run UUID, and `run_summary.jsonl` path. Do not rely on setting these from outside.
- `JAIPH_WORKSPACE` — set by the CLI to the workspace root: walk **up** from the directory that contains the entry `.jh` file until a directory with `.jaiph` or `.git` is found; if the walk hits the filesystem root first, the root used is that entry directory (absolute path). **Guards** in `detectWorkspaceRoot` (see `src/cli/shared/paths.ts`) also skip misleading markers when the start directory lives under **shared system temp** (`/tmp`, `/var/tmp`, …), under **macOS** **`/var/folders/.../T/...`** (stray `.jaiph` / `.git` on parents of a nested temp project), or under another repo’s **`.jaiph/tmp`** tree, so nested sandboxes do not pick the wrong root. Used by the Node runtime and script execution; you rarely set this yourself. In Docker sandbox mode the runtime remaps it inside the container (see [Sandboxing](sandboxing.md)).
- `JAIPH_LIB` — directory for project-local shared bash libraries (conventionally `<workspace>/.jaiph/lib`). The runtime sets `JAIPH_LIB` to `${JAIPH_WORKSPACE:-.}/.jaiph/lib` when executing **script** steps so `source "$JAIPH_LIB/…"` resolves predictably. Override `JAIPH_LIB` when libraries live elsewhere. See [Grammar — script bodies and shared libraries](grammar.md#step-output-contract).
- `JAIPH_AGENT_MODEL` — default model for `prompt` steps (overrides in-file `agent.default_model`).
- `JAIPH_AGENT_COMMAND` — command for the Cursor backend (e.g. `cursor-agent`; overrides in-file `agent.command`).
- `JAIPH_AGENT_BACKEND` — prompt backend: `cursor` (default) or `claude`. Overrides in-file `agent.backend`. When set to `claude`, the Anthropic Claude CLI (`claude`) must be installed and on PATH; otherwise the run fails with a clear error. See [Configuration](configuration.md).
- `JAIPH_AGENT_TRUSTED_WORKSPACE` — trusted workspace directory for Cursor backend `--trust`. Defaults to project root.
- `JAIPH_AGENT_CURSOR_FLAGS` — extra flags for Cursor backend (string, split on whitespace).
- `JAIPH_AGENT_CLAUDE_FLAGS` — extra flags for Claude backend (string, split on whitespace).
- `JAIPH_RUNS_DIR` — root directory for run logs (default: `.jaiph/runs` under workspace). Runs are stored as `<YYYY-MM-DD>/<HH-MM-SS>-<source-file>/` under this root.
- `JAIPH_SOURCE_FILE` — set automatically by the CLI to the basename of the input file (e.g. `say_hello.jh`). Used by the runtime to name run directories. You should not need to set this manually.
- `JAIPH_DEBUG` — set to `true` to enable debug tracing during run.
- `JAIPH_ENSURE_MAX_RETRIES` — maximum **attempt rounds** for `ensure ... recover` (default: **3** — each round runs the rule once, then the recover body if the rule failed). When all rounds fail, the workflow exits with status 1.
- `JAIPH_INBOX_PARALLEL` — set to `true` to enable parallel dispatch of inbox route targets (overrides in-file `run.inbox_parallel`). See [Inbox](inbox.md).
- `JAIPH_DOCKER_ENABLED` — set to `true` to enable Docker sandbox (overrides in-file `runtime.docker_enabled`).
- `JAIPH_DOCKER_IMAGE` — Docker image for sandbox (overrides in-file `runtime.docker_image`).
- `JAIPH_DOCKER_NETWORK` — Docker network mode (overrides in-file `runtime.docker_network`).
- `JAIPH_DOCKER_TIMEOUT` — execution timeout in seconds (overrides in-file `runtime.docker_timeout`).
- `NO_COLOR` — if set, disables colored output (e.g. progress and pass/fail).
- `JAIPH_NON_TTY_HEARTBEAT_FIRST_SEC` — non-TTY only: minimum elapsed seconds before the **first** heartbeat line for a step (default: `60`). Non-negative number; invalid values fall back to `60`.
- `JAIPH_NON_TTY_HEARTBEAT_INTERVAL_MS` — non-TTY only: timer interval used to schedule heartbeat checks and minimum spacing between **subsequent** heartbeats (default: `30000`). Values below `250` ms fall back to the default.

For `JAIPH_DOCKER_*`, defaults, image selection (including `.jaiph/Dockerfile`), mounts, and container behavior are covered in [Sandboxing](sandboxing.md).

**`jaiph report`:**

- `JAIPH_REPORT_HOST` — bind address (default `127.0.0.1`).
- `JAIPH_REPORT_PORT` — port (default `8787`).
- `JAIPH_REPORT_POLL_MS` — summary tail loop interval in ms (default `500`, minimum `50`).
- `JAIPH_REPORT_RUNS_DIR` — runs root (optional; default `<cwd>/.jaiph/runs` unless `--runs-dir` / `--workspace` override). See [`jaiph report`](#jaiph-report).
- `JAIPH_REPORT_PID_FILE` — pid file used by `jaiph report status/stop` (default `<workspace>/.jaiph/report.pid` unless `--pid-file` override).

**Install and `jaiph use`:**

- `JAIPH_REPO_URL` — Git repo URL or local path for install script.
- `JAIPH_REPO_REF` — ref (e.g. branch or tag) used when installing; `jaiph use <version>` sets this to `v<version>` or `main` for nightly.
- `JAIPH_BIN_DIR` — target bin directory (default: `$HOME/.local/bin`).
- `JAIPH_LIB_DIR` — target lib directory (default: `$JAIPH_BIN_DIR/.jaiph`).
- `JAIPH_INSTALL_COMMAND` — command run by `jaiph use` to reinstall (default: `curl -fsSL https://jaiph.org/install | bash`).

**`jaiph init`:**

- `JAIPH_SKILL_PATH` — path to the skill file copied to `.jaiph/jaiph-skill.md` when syncing from the local installation.
