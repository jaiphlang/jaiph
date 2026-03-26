---
title: CLI Reference
permalink: /cli
redirect_from:
  - /cli.md
---

# Jaiph CLI Reference

## Overview

Jaiph workflow sources (`.jh` / `.jph`) are programs: the CLI parses them, checks references, and transpiles them to bash that runs on your machine. Optional [Sandboxing](sandboxing.md) runs that generated bash inside Docker instead of directly on the host. The same `jaiph` executable drives compilation (`build`), execution (`run`), the native test runner (`test`), workspace scaffolding (`init`), reinstalling from a Git ref (`use`), and a read-only local UI over run logs (`report`). Language syntax and semantics are documented separately (for example [Grammar](grammar.md)); this page is the command-line contract.

**Typical tasks:**

- **Run a workflow** — `jaiph run <file.jh>` or pass the file as the first argument: `jaiph <file.jh> [args...]`. Requires a `workflow default` in that file.
- **Run tests** — `jaiph test` discovers and runs all `*.test.jh` / `*.test.jph` under the workspace; or pass a directory or a single test file.
- **Compile only** — `jaiph build [--target <dir>] [path]` compiles `.jh`/`.jph` files into shell scripts without executing. Without `--target`, compiled scripts are written alongside the source files.
- **Setup** — `jaiph init [workspace-path]` creates `.jaiph/` with a bootstrap workflow and synced skill guide; `jaiph use <version|nightly>` reinstalls the global Jaiph binary.
- **Reporting** — `jaiph report` serves a read-only local dashboard over `.jaiph/runs` (see [Reporting server](reporting.md)).

**Commands:** `build`, `run`, `test`, `init`, `use`, `report`.

**Global options:** `-h` / `--help` and `-v` / `--version` are only recognized when they are the **first** argument (for example `jaiph --help`). They do not apply after a subcommand (`jaiph build --help` is not supported). The reporting subcommand documents its own flags: `jaiph report --help`.

---

## `jaiph <file.jh>` and `jaiph <file.test.jh>` (shorthand)

If the first argument is a path to an existing file whose name ends with `.jh` or `.jph`, Jaiph treats it as a workflow and runs it (same as `jaiph run <file>`). If the first argument ends with `.test.jh` or `.test.jph` and the file exists, Jaiph runs that test file (same as `jaiph test <file>`).

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

## `jaiph build`

Compile `.jh` and `.jph` files into shell scripts.

```bash
jaiph build [--target <dir>] [path]
```

If `path` is omitted, the current directory (`./`) is used. Without `--target`, compiled `.sh` scripts are written alongside the source files. Use `--target` to redirect output to a specific directory.

- **Directory mode** (`jaiph build ./` or `jaiph build ./flows`) — compiles every `.jh`/`.jph` file in the directory tree (test files `*.test.jh`/`*.test.jph` are excluded). The command stops on the first parse or validation error in any file.
- **Single-file mode** (`jaiph build file.jh`) — compiles only the specified file and its transitive imports. Parse errors in sibling files are ignored.

Scripts declared in workflow modules are emitted as **separate executable files** under `<target>/scripts/<name>` with `chmod +x`. Each script file starts with a shebang (custom or default `#!/usr/bin/env bash`) followed by the script body. The compiled module `.sh` invokes scripts via `"$JAIPH_SCRIPTS/<name>"`.

Examples:

```bash
jaiph build ./
jaiph build --target ./build ./flows
jaiph build ./flows/review.jh
```

## `jaiph run`

Compile and run a Jaiph workflow file.
`jaiph run` requires a `workflow default` entrypoint.

```bash
jaiph run [--target <dir>] <file.jh|file.jph> [--] [args...]
```

Only the specified file and its transitive imports are compiled. Parse errors in sibling `.jh` files do not affect the run. Use `--target` to keep the compiled shell script in a specific directory (useful for debugging the transpiler output); without it, the compiled script is written to a temp directory and cleaned up after the run. Use `--` to separate Jaiph flags from workflow arguments (e.g. `jaiph run file.jh -- --verbose`).

Examples:

```bash
jaiph run ./.jaiph/bootstrap.jh
jaiph run ./flows/review.jh "review this diff"
```

Argument passing matches standard bash script behavior:

- first argument -> `$1`
- second argument -> `$2`
- all arguments -> `"$@"`

Rules also receive forwarded arguments through `ensure`, for example:

```jaiph
rule current_branch {
  test "$(git branch --show-current)" = "$1"
}

workflow default {
  ensure current_branch "main"
}
```

`prompt` text follows bash-style variable expansion (for example `$1`, `${HOME}`, `${FILES[@]}`).
For safety, command substitution is not allowed in prompt text: `$(...)` and backticks are rejected with `E_PARSE`.

Workflow and rule bodies contain structured Jaiph steps only — use **`run`** to call a **`script`** for shell execution. In bash-bearing contexts (mainly **`script`** bodies, and restricted `const` / send RHS forms), `$(...)` and the first command word are validated: they must not invoke Jaiph rules, workflows, or scripts, contain inbox send (`<-`), or use `run` / `ensure` as shell commands (`E_VALIDATE`). See [Grammar](grammar.md#managed-calls-vs-command-substitution).

For **`const`** in those bodies, a **reference plus arguments** on the RHS must be written as **`const name = run ref [args…]`** (or **`ensure`** for rule capture), not as **`const name = ref [args…]`** — the latter is **`E_PARSE`** with text that explains the fix (same rule as managed calls elsewhere).

If a `.jh` or `.jph` file is executable and has `#!/usr/bin/env jaiph`, you can run it directly:

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
- **Positional parameters** (`$1`, `$2`, or `argN`) display as `1="value"`, `2="value"`, etc. **Named parameters** display as `name="value"`.
- **Whitespace normalization:** Newlines, tabs, and consecutive spaces inside parameter values are collapsed to a single space before display. This keeps multi-line prompt bodies, roles, and similar values readable on a single tree line.
- Values are truncated to 32 visible characters; longer values end with `...`.
- **Prompt steps:** The line shows a **prompt preview** (first 24 characters of the prompt text, then `...` if longer) in quotes, followed by parameters. The parameter list is capped at 96 characters total (truncated with `...` if longer).
- Order follows the call site so repeated runs are diff-friendly.

Example lines:

- `▸ workflow docs_page (1="docs/cli.md", 2="strict")`
- `· prompt prompt (running 60s)` — non-TTY only, after the quiet threshold; entire line dim/gray; same `prompt prompt` label as the eventual `✓ prompt prompt (…)` line
- `·   ▸ prompt "$role does $task" (role="engineer", task="Fix bugs")`
- `·   ▸ prompt "Say hello to $1 and..." (1="greeting")`
- `·   ▸ script fib (1="3")`
- `·   ▸ rule check_arg (1="Alice")`

If no parameters are passed, the line is unchanged (e.g. `▸ workflow default`). Color can be disabled with `NO_COLOR=1`.

**Prompt steps show no output in the tree.** When a `prompt` step completes, only the step line and ✓ appear — no Command, Prompt, Reasoning, or Final answer block. To display agent output in the tree, use `log` explicitly:

```jaiph
response = prompt "Summarize the report"
log "$response"
```

The `log` line renders inline at the correct depth as `ℹ <message>` (dim/gray) and writes to **stdout**. The `logerr` variant renders as `! <message>` in red and writes to **stderr**. (As above, the displayed/streamed text uses **`echo -e`**; event JSON keeps the raw string.) The step's `.out` file in `.jaiph/runs/` still contains the full agent transcript for debugging.

### Failed run summary (stderr)

On non-zero exit, the CLI may print a footer with the path to **`run_summary.jsonl`**, **`out:`** / **`err:`** artifact paths, and **`Output of failed step:`** plus a trimmed excerpt. Those paths and the excerpt are resolved from the **first** `STEP_END` object in the summary with **`status` ≠ 0**, using **`out_content` / `err_content`** when present and otherwise the **`out_file` / `err_file`** fields on that same line — not from “latest” filenames by sort order in the run directory, which can belong to a different step. If no failed `STEP_END` is found (or the summary is missing), the CLI falls back to the run-directory artifact heuristic.

### Run artifacts and live output

Every step writes its stdout and stderr to artifact files under `.jaiph/runs/<date>/<time>-<source>/` (see `JAIPH_RUNS_DIR`). Files are named with a zero-padded sequence prefix reflecting execution order: `000001-module__rule.out`, `000002-module__workflow.err`, etc.

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

**Event taxonomy — persisted schema (`event_version` 1).** The live `__JAIPH_EVENT__` stream on stderr is unchanged except as noted in release notes; the tables below describe **only** what is written to `run_summary.jsonl`.

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

Run tests from native test files (`*.test.jh` / `*.test.jph`) that contain `test "..." { ... }` blocks. Test files can import workflows and use `mock prompt` (or `mock prompt { ... }`) to simulate agent responses without calling the real backend.

**Usage:**

- `jaiph test` — discover and run all `*.test.jh` / `*.test.jph` under the workspace root. The workspace root is the first directory found when walking **up** from the current working directory that contains `.jaiph` or `.git`. If neither marker exists on that path, the root is the resolved current working directory.
- `jaiph test <dir>` — run all test files under the given directory (workspace root is detected the same way, starting from `<dir>`).
- `jaiph test <file.test.jh>` — run a single test file.

With no arguments, or with a directory that contains no test files, the command exits with status **1** and prints an error.

You must pass a test file (e.g. `say_hello.test.jh`) or a directory. Passing a plain workflow file (e.g. `say_hello.jh`) is not supported; the test file imports the workflow and declares mocks. See [Testing](testing.md) for test block syntax and `expectContain` / `expectEqual`.

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
jaiph use 0.5.0
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

## File extensions

- **`.jh`** is the recommended extension for new Jaiph files. Use it for entrypoints, imports, and `jaiph build` / `jaiph run` / `jaiph test`.
- **`.jph`** is also accepted. Both extensions work identically with all CLI commands and import resolution.

Imports resolve for both extensions: `import "foo" as x` finds `foo.jh` or `foo.jph` (`.jh` is preferred when both exist).

## Environment variables

**Runtime and config overrides** (for `jaiph run` and workflow execution):

- `JAIPH_STDLIB` — normally unused: the CLI sets this to the **stdlib bundled with the same installation** as the `jaiph` binary so a stale global `JAIPH_STDLIB` in your shell cannot break new workflows. To force a custom stdlib path, set **`JAIPH_USE_CUSTOM_STDLIB=1`** and **`JAIPH_STDLIB`** to the absolute path of `jaiph_stdlib.sh` (advanced; tests and unusual installs).
- `JAIPH_SCRIPTS` — the generated bash exports this to the directory holding compiled module scripts for **that** build. **`jaiph run`** and **`jaiph test`** **unset** any inherited **`JAIPH_SCRIPTS`** from the parent environment before executing so an outer run cannot pin the wrong script directory when workflows or package scripts invoke Jaiph again. You normally should not export this yourself.
- `JAIPH_WORKSPACE` — set by the CLI to the workspace root: walk **up** from the directory that contains the entry `.jh` / `.jph` until a directory with `.jaiph` or `.git` is found; if the walk hits the filesystem root first, the root used is that entry directory (absolute path). Used by the generated bash and runtime helpers; you rarely set this yourself. In Docker sandbox mode the runtime remaps it inside the container (see [Sandboxing](sandboxing.md)).
- `JAIPH_LIB` — directory for project-local shared bash libraries (conventionally `<workspace>/.jaiph/lib`). The **transpiled script** exports `JAIPH_LIB="${JAIPH_LIB:-${JAIPH_WORKSPACE:-.}/.jaiph/lib}"` near the top of its preamble so `source "$JAIPH_LIB/…"` works no matter where the generated `.sh` file lives. Override `JAIPH_LIB` when libraries live elsewhere. The runtime also sets `JAIPH_LIB` when executing **script** steps so behavior matches [Grammar — script bodies and shared libraries](grammar.md#step-output-contract).
- `JAIPH_AGENT_MODEL` — default model for `prompt` steps (overrides in-file `agent.default_model`).
- `JAIPH_AGENT_COMMAND` — command for the Cursor backend (e.g. `cursor-agent`; overrides in-file `agent.command`).
- `JAIPH_AGENT_BACKEND` — prompt backend: `cursor` (default) or `claude`. Overrides in-file `agent.backend`. When set to `claude`, the Anthropic Claude CLI (`claude`) must be installed and on PATH; otherwise the run fails with a clear error. See [Configuration](configuration.md).
- `JAIPH_AGENT_TRUSTED_WORKSPACE` — trusted workspace directory for Cursor backend `--trust`. Defaults to project root.
- `JAIPH_AGENT_CURSOR_FLAGS` — extra flags for Cursor backend (string, split on whitespace).
- `JAIPH_AGENT_CLAUDE_FLAGS` — extra flags for Claude backend (string, split on whitespace).
- `JAIPH_RUNS_DIR` — root directory for run logs (default: `.jaiph/runs` under workspace). Runs are stored as `<YYYY-MM-DD>/<HH-MM-SS>-<source-file>/` under this root.
- `JAIPH_SOURCE_FILE` — set automatically by the CLI to the basename of the input file (e.g. `say_hello.jh`). Used by the runtime to name run directories. You should not need to set this manually.
- `JAIPH_DEBUG` — set to `true` to enable bash `set -x` during run.
- `JAIPH_ENSURE_MAX_RETRIES` — max retries for `ensure ... recover` steps (default: 10). When exceeded, the workflow exits with status 1.
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
