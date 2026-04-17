---
title: CLI Reference
permalink: /cli
redirect_from:
  - /cli.md
---

# Jaiph CLI Reference

Jaiph ships as a command-line tool. You point it at `.jh` source files, and it validates, compiles script bodies, launches the workflow runtime, streams progress, and writes run artifacts under `.jaiph/runs`. This page covers all CLI commands, flags, and environment variables. For language syntax and step semantics, see [Grammar](grammar.md).

Before execution, the CLI runs compile-time validation and script extraction. It then hands off to the Node workflow runtime, which interprets the parsed AST directly — there is no Bash transpilation of workflows; only extracted `script` bodies are emitted as shell. The CLI owns process spawn and signal propagation; the runtime kernel owns prompt and script execution, file-backed inbox, the `__JAIPH_EVENT__` stream on stderr, and `run_summary.jsonl`. For full architecture details, see [Architecture](architecture).

**Commands:** `run`, `test`, `format`, `init`, `install`, `use`.

**Global options:** `-h` / `--help` and `-v` / `--version` are recognized only as the **first argument** (e.g. `jaiph --help`). They are not parsed after a subcommand or file path.

## File shorthand

If the first argument is an existing file, Jaiph routes it automatically based on the extension. Files ending in **`*.test.jh`** are run as tests (same as `jaiph test <file>`). Other files ending in **`*.jh`** are run as workflows (same as `jaiph run <file>`). The `*.test.jh` check happens first, so test files are never mistaken for workflows.

```bash
# Workflow shorthand
jaiph ./flows/review.jh "review this diff"
# equivalent to: jaiph run ./flows/review.jh "review this diff"

# Test shorthand
jaiph ./e2e/say_hello.test.jh
# equivalent to: jaiph test ./e2e/say_hello.test.jh
```

## `jaiph run`

Parse, validate, and run a Jaiph workflow file. Requires a `workflow default` entrypoint.

```bash
jaiph run [--target <dir>] <file.jh> [--] [args...]
```

Any path ending in `.jh` is accepted (including `*.test.jh`, since the extension is still `.jh`). For files that only contain test blocks, use `jaiph test` instead.

**Flags:**

- **`--target <dir>`** — keep emitted script files and run metadata under `<dir>` instead of a temp directory (useful for debugging).
- **`--`** — end of Jaiph flags; remaining args are passed to `workflow default` (e.g. `jaiph run file.jh -- --verbose`).

**Examples:**

```bash
jaiph run ./.jaiph/bootstrap.jh
jaiph run ./flows/review.jh "review this diff"
```

### Argument passing

Positional arguments are available inside `script` bodies as standard bash `$1`, `$2`, `"$@"`. In Jaiph orchestration strings (`log`, `prompt`, `fail`, `return`, `send`, `run`/`ensure` args), use **named parameters** (e.g. `workflow default(task)` → `${task}`) — only `${identifier}` forms are supported (no shell parameter expansion). The same rule applies to `prompt` text and to `const` RHS strings where orchestration applies.

Rules receive forwarded arguments through `ensure`:

```jaiph
script check_branch = `test "$(git branch --show-current)" = "$1"`

rule current_branch(expected) {
  run check_branch("${expected}")
}

workflow default() {
  ensure current_branch("main")
}
```

Workflow and rule bodies contain structured Jaiph steps only — use `run` to call a `script` for shell execution. In bash-bearing contexts (mainly `script` bodies, and restricted `const` / send RHS forms), `$(...)` and the first command word are validated: they must not invoke Jaiph rules, workflows, or scripts, contain inbox send (`<-`), or use `run` / `ensure` as shell commands (`E_VALIDATE`). See [Grammar — Managed calls vs command substitution](grammar.md#managed-calls-vs-command-substitution).

For `const` in those bodies, a reference plus arguments on the RHS must be written as `const name = run ref([args...])` (or `ensure` for rule capture), not as `const name = ref([args...])` — the latter is `E_PARSE` with text that explains the fix.

### Shebang execution

If a `.jh` file is executable and has `#!/usr/bin/env jaiph`, you can run it directly:

```bash
./.jaiph/bootstrap.jh "task details"
./flows/review.jh "review this diff"
```

### Compile-time and process model

The CLI runs `buildScripts()`, which walks the entry file and its import closure. Each reachable module is parsed and `validateReferences` runs before script files are written. Unrelated `.jh` files on disk are not read.

After validation, the CLI spawns the Node workflow runner as a detached child. The runner loads the graph with `buildRuntimeGraph()` (parse-only imports; no `validateReferences` here) and executes `NodeWorkflowRuntime`. Prompt steps, script subprocesses, inbox dispatch, and event emission are handled in the runtime kernel — workflows and rules are interpreted in-process; only `script` steps spawn a managed shell. The CLI listens on stderr for `__JAIPH_EVENT__` JSON lines, the single event channel for all execution modes. Stdout carries only plain script output, forwarded to the terminal as-is.

### Run progress and tree output

During `jaiph run`, the CLI renders a live tree of steps. Each step appears as a line with a marker, the step kind (`workflow`, `prompt`, `script`, `rule`), and the step name:

- **`▸`** — step started
- **`✓`** / **`✗`** — step completed (pass/fail), with elapsed time (e.g. `✓ workflow scanner (0s)`, `✗ rule ci_passes (11s)`)
- **`ℹ`** — `log` message (dim/gray, inline at the correct depth; no marker, spinner, or timing)
- **`!`** — `logerr` message (red, writes to stderr)

The root PASS/FAIL summary uses the format `✓ PASS workflow default (0.2s)`. Completion lines include the step kind and name so each line is self-identifying even when multiple steps run concurrently.

**`log` / `logerr` and backslash escapes:** The displayed text follows `echo -e` semantics — a literal `\n` or `\t` in the message becomes a newline or tab. `LOG` / `LOGERR` JSON on stderr (and the `message` field in `run_summary.jsonl`) carries the unexpanded shell string.

**TTY mode:** one extra line at the bottom shows the running workflow and elapsed time: `▸ RUNNING workflow <name> (X.Xs)` — updated in place every second. When the run completes, it is replaced by the final PASS/FAIL line.

**Non-TTY mode** (CI, pipes, log capture): no RUNNING line and no in-place updates. Step start (▸) and completion (✓/✗) lines still print as they occur. Long-running steps additionally print **heartbeat** lines to avoid looking like a hang:

- Format: `· <kind> <name> (running <N>s)` — entire line dim/gray (plain text with `NO_COLOR`).
- Cadence: first heartbeat after `JAIPH_NON_TTY_HEARTBEAT_FIRST_SEC` seconds (default **60**), then every `JAIPH_NON_TTY_HEARTBEAT_INTERVAL_MS` milliseconds (default **30000**; minimum **250**). Short steps emit no heartbeats.
- Nested steps: heartbeats describe the innermost (deepest active) step.

**Event stream:** on stderr, the runtime emits `__JAIPH_EVENT__` lines (JSON). The CLI parses them to drive the tree, hooks, and failure summaries. Other stderr text is forwarded to the terminal. If a payload is not valid JSON, the CLI treats it as plain stderr.

**Parameterized invocations** show argument values inline in gray after the step name:

- All parameters use `key="value"` format in parentheses. Internal refs (`::impl`) and empty values are omitted.
- Positional parameters display as `1="value"`, `2="value"`. Named parameters display as `name="value"`.
- Whitespace in values is collapsed to a single space. Values are truncated to 32 characters (with `...`).
- Prompt steps show the backend name (or custom command basename) and a preview (first 24 characters of prompt text) in quotes: `prompt cursor "summarize the..."` or `prompt my-agent.sh "summarize the..."`, followed by parameters (capped at 96 characters total).

Example lines:

- `▸ workflow docs_page (1="docs/cli.md", 2="strict")`
- `· prompt cursor (running 60s)`
- `·   ▸ prompt cursor "${role} does ${task}" (role="engineer", task="Fix bugs")`
- `·   ▸ script fib (1="3")`
- `·   ▸ rule check_arg (1="Alice")`

If no parameters are passed, the line is unchanged (e.g. `▸ workflow default`). Disable color with `NO_COLOR=1`.

**Async branch numbering.** When a workflow contains multiple `run async` steps, each branch is prefixed with a **subscript number** (₁₂₃…) at the async call site's indentation level. Numbers use Unicode subscript digits (U+2080–U+2089) and are assigned in **dispatch order** within the parent workflow (first `run async` = ₁, second = ₂, etc.). The subscript number is always rendered with a leading space (` ₁`, ` ₂`, ` ₁₂`) and in dim/grey (same style as `·` continuation markers); in non-TTY or `NO_COLOR` mode it is emitted without ANSI codes. Non-async lines (root workflow, final PASS/FAIL) have no prefix.

If a nested workflow also uses `run async`, those branches get their own numbering scope at the nested indent level:

```text
workflow default
 ₁▸ workflow parallel_suite
 ₂▸ workflow lint_check
 ₁·  ₁▸ workflow test_unit
 ₁·  ₂▸ workflow test_integration
 ₁·  ₁✓ workflow test_unit (2s)
 ₁·  ₂✓ workflow test_integration (5s)
 ₁✓ workflow parallel_suite (5s)
 ₂✓ workflow lint_check (1s)

✓ PASS workflow default (5s)
```

All async branches render as siblings at the same indentation level. Inner steps within each branch appear one level deeper. The runtime isolates each async branch's frame stack, so `depth` on events is relative to the branch's own call depth. The `async_indices` array on events carries the chain of 1-based branch indices (one per nested `run async` level) so the display layer can map lines to branches.

**Prompt transcript replay.** The progress renderer shows only ▸ / ✓ lines for a `prompt` step — not a nested subtree. After the step completes (on terminal stdout, non-test runs), the runtime replays the step's `.out` artifact if stdout was not already streamed live. Replay is skipped when stdout is a pipe or when the prompt already streamed via tee. `jaiph test` does not use this replay path.

To surface the agent answer inline in the tree, use `log` explicitly:

```jaiph
response = prompt "Summarize the report"
log response
```

### Failed run summary (stderr)

On non-zero exit, the CLI may print a footer with the path to `run_summary.jsonl`, `out:` / `err:` artifact paths, and `Output of failed step:` plus a trimmed excerpt. These are resolved from the **first** `STEP_END` object in the summary with `status` != 0, using `out_content` / `err_content` when present and otherwise the `out_file` / `err_file` fields. If no failed `STEP_END` is found, the CLI falls back to a run-directory artifact heuristic.

In Docker mode, the meta file written by the container contains container-internal paths (`/jaiph/workspace/…`). The CLI remaps these to host paths before reading artifacts, so the failure summary displays identically to local runs. See [Sandboxing — Path remapping](sandboxing.md#path-remapping).

### Run artifacts and live output

Each run directory is `<JAIPH_RUNS_DIR>/<YYYY-MM-DD>/<HH-MM-SS>-<source>/`, where date and time are UTC and `<source>` is `JAIPH_SOURCE_FILE` if set, otherwise the entry file basename. Every step writes stdout and stderr to artifact files named with a zero-padded sequence prefix: `000001-module__rule.out`, `000002-module__workflow.err`, etc.

All step kinds write to artifact files **incrementally during execution**, so you can tail a running step's output in real time:

```bash
# In one terminal — run a long workflow
jaiph run ./flows/deploy.jh

# In another terminal — watch a step's output as it executes
tail -f .jaiph/runs/2026-03-22/14-30-00-deploy.jh/000003-deploy__run_migrations.out
```

Both `.out` (stdout) and `.err` (stderr) files grow as the step produces output. Steps that produce no output on a given stream have no corresponding artifact file. Empty files are cleaned up at step end.

### Run summary (`run_summary.jsonl`) {#run-summary-jsonl}

Each run directory also contains `run_summary.jsonl`: one JSON object per line, appended in execution order. It is the canonical append-only record of runtime events (lifecycle, logs, inbox flow, and step boundaries). Tooling can tail the file by byte offset and process new lines idempotently; parallel inbox dispatch may reorder some events relative to wall-clock time, but each line is written atomically under the same lock used for concurrent writers (see [Inbox — Lock behavior](inbox.md#lock-behavior)).

**Versioning.** Every object includes `event_version` (currently `1`). New fields may be added; consumers should tolerate unknown keys.

**Common fields.** All lines include `type`, `ts` (UTC timestamp), `run_id`, and `event_version`. Step-related types also carry `id`, `parent_id`, `seq`, and `depth` (matching the `__JAIPH_EVENT__` stream on stderr).

**Correlation rules:**

- **`run_id`:** same across all lines in a given run's file.
- **Workflow boundaries:** for each workflow name, `WORKFLOW_START` count equals `WORKFLOW_END` count. With `JAIPH_INBOX_PARALLEL=true`, lifecycle lines may interleave — use per-name counts, not a global stack.
- **Steps:** `STEP_START` and `STEP_END` share the same `id`. Use `parent_id`, `seq`, and `depth` to rebuild the tree.
- **Inbox:** one `INBOX_ENQUEUE` per `send` with a unique `inbox_seq` (zero-padded, e.g. `001`). Each routed target gets one `INBOX_DISPATCH_START` and one `INBOX_DISPATCH_COMPLETE` sharing the same `inbox_seq`, `channel`, `target`, and `sender`.
- **Ordering under parallel inbox:** lines are valid JSONL (one object per line, atomic append). Wall-clock `ts` order may diverge from append order between concurrent branches.

**Event taxonomy (schema `event_version` 1):**

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
| `async_indices` | — | — | optional `number[]` | optional `number[]` | optional `number[]` | optional `number[]` | — | — | — |
| `message`, `depth` | — | — | — | — | required | required | — | — | — |
| `inbox_seq`, `channel`, `sender` | — | — | — | — | — | — | required | required | required |
| `payload_preview`, `payload_ref` | — | — | — | — | — | — | required | — | — |
| `target` | — | — | — | — | — | — | — | required | required |
| `status`, `elapsed_ms` (dispatch) | — | — | — | — | — | — | — | — | required (exit code and ms) |

`PROMPT_START` / `PROMPT_END` (not in the table): include `backend`, optional `model`, optional `model_reason`, optional `status`, optional `preview`, `depth`, and optional `step_id` / `step_name` tying the prompt to the enclosing step frame. `model` is the resolved model name (or `null` when the backend auto-selects). `model_reason` is one of `explicit`, `flags`, or `backend-default` — see [Configuration — Model resolution](configuration.md#model-resolution).

**Event semantics:**

- **`WORKFLOW_START` / `WORKFLOW_END`:** mark entry and exit of a workflow body. `workflow` is the declared name; `source` is the `.jh` basename.
- **`STEP_START` / `STEP_END`:** mirror stderr step events. `STEP_END` may include `out_content` / `err_content` (embedded artifact text, size-capped).
- **`LOG` / `LOGERR`:** emitted by `log` / `logerr` keywords. `depth` is the step-stack depth. `message` is the shell string before `echo -e` expansion.
- **`INBOX_ENQUEUE`:** recorded when a message is queued. `payload_preview` is UTF-8-safe JSON (up to 4096 bytes; truncated with `...`). `payload_ref` is `null` when the full body fits, otherwise a run-relative path.
- **`INBOX_DISPATCH_START` / `INBOX_DISPATCH_COMPLETE`:** wrap one invocation of a route target. `status` is exit code; `elapsed_ms` is wall time.

Together with step `.out` / `.err` files, `run_summary.jsonl` is enough to reconstruct the step tree, log timelines, inbox flow, and workflow boundaries.

### Hooks

You can run custom commands at workflow/step lifecycle events via hooks. Config lives in `~/.jaiph/hooks.json` (global) and `<project>/.jaiph/hooks.json` (project-local); project-local overrides global per event. See [Hooks](hooks.md) for schema, events, payload, and examples.

## `jaiph test`

Run tests from `*.test.jh` files that contain `test "..." { ... }` blocks. Test files can import workflows and use `mock prompt` to simulate agent responses without calling the real backend.

The test runner uses the same Node workflow runtime as `jaiph run`. For each test file, the CLI compiles workspace `*.jh` modules (not `*.test.jh`) so imported modules have emitted scripts, then builds the runtime graph once and reuses it across all test blocks. Each block runs through the AST interpreter with mock support and assertion evaluation (`expect_contain`, `expect_equal`, `expect_not_contain`).

**Usage:**

- `jaiph test` — discover and run all `*.test.jh` under the workspace root. The workspace root is found by walking up from the current directory until a directory with `.jaiph` or `.git` is found; if neither exists, the current directory is used.
- `jaiph test <dir>` — run all `*.test.jh` files recursively under the given directory.
- `jaiph test <file.test.jh>` — run a single test file.

With no arguments, or with a directory that contains no test files, the command exits with status **1** and prints an error.

Passing a plain workflow file (e.g. `say_hello.jh`) is not supported; the test file imports the workflow and declares mocks. Extra arguments after the path are accepted but ignored. See [Testing](testing.md) for test block syntax and assertions.

**Examples:**

```bash
jaiph test
jaiph test ./e2e
jaiph test e2e/workflow_greeting.test.jh
jaiph test e2e/say_hello.test.jh
```

## `jaiph format`

Reformat `.jh` source files to a canonical style. The formatter parses each file into an AST and re-emits it with consistent whitespace and indentation. Formatting is idempotent — running it twice produces the same output. Comments and shebangs are preserved. Multiline string bodies (`"""…"""`), prompt blocks, and fenced script blocks are emitted verbatim — inner lines are not re-indented relative to the surrounding scope, so repeated formatting never shifts embedded content deeper.

**Blank-line preservation:** A single blank line between steps inside a workflow or rule body is preserved — use it for visual grouping of related calls. Multiple consecutive blank lines are collapsed to one; trailing blank lines before `}` are removed. This applies to all block-level steps (calls, `log`, `const`, `if`, etc.).

**Top-level ordering:** The formatter hoists `import`, `config`, and `channel` declarations to the top of the file (in that order, preserving source order within each group). All other top-level definitions — `const`, `rule`, `script`, `workflow`, and `test` blocks — keep their original relative order from the source file. Comments immediately before an `import`, `config`, or `channel` move with that construct when hoisted; comments before non-hoisted definitions stay in place.

```bash
jaiph format [--check] [--indent <n>] <file.jh ...>
```

One or more `.jh` file paths are required. Non-`.jh` files are rejected. If a file cannot be parsed, the command exits immediately with status 1 and a parse error on stderr.

**Flags:**

- **`--indent <n>`** — spaces per indent level (default: `2`).
- **`--check`** — verify formatting without writing. Exits 0 when all files are already formatted; exits 1 when any file needs changes, printing the file name to stderr. No files are modified in check mode.

**Examples:**

```bash
# Rewrite files in place
jaiph format flow.jh utils.jh

# Check formatting in CI (non-zero exit on drift)
jaiph format --check src/**/*.jh

# Use 4-space indentation
jaiph format --indent 4 flow.jh
```

## `jaiph init`

Initialize Jaiph files in a workspace directory.

```bash
jaiph init [workspace-path]
```

Creates:

- `.jaiph/.gitignore` — lists `runs` and `tmp`. If the file already exists and does not match this exact list, `jaiph init` exits with a non-zero status.
- `.jaiph/bootstrap.jh` — canonical bootstrap workflow; made executable. The template uses a triple-quoted multiline prompt body (`prompt """ ... """`) so the generated file parses and compiles as valid Jaiph. It also asks the agent to review/update `.jaiph/Dockerfile` for this repository and ends by logging a summary (`WHAT CHANGED` + `WHY`).
- `.jaiph/Dockerfile` — Docker sandbox template that extends the official `ghcr.io/jaiphlang/jaiph-runtime:nightly` image with agent CLIs (Claude Code, cursor-agent). The base image already contains Node.js, jaiph, and `fuse-overlayfs`, so the generated Dockerfile only adds project-specific tooling. If the file is missing, init creates it. If it already exists and includes the init marker comment, init updates it to the latest template. Otherwise (custom user-managed Dockerfile), init leaves it unchanged and prints a note.
- `.jaiph/SKILL.md` — copied from the skill file bundled with your Jaiph installation (or from `JAIPH_SKILL_PATH` when set). If no skill file is found, this file is not written and a note is printed.

## `jaiph install`

Install project-scoped libraries. Libraries are git repos cloned into `.jaiph/libs/<name>/` under the workspace root. A lockfile (`.jaiph/libs.lock`) tracks installed libraries for reproducible setups.

```bash
jaiph install [--force] <repo-url[@version]> ...
jaiph install [--force]
```

**With arguments** — clone each repo into `.jaiph/libs/<name>/` (shallow: `--depth 1`) and upsert the entry in `.jaiph/libs.lock`. The library name is derived from the URL: last path segment, stripped of `.git` suffix (e.g. `github.com/you/queue-lib.git` → `queue-lib`). Version pinning uses `@<tag-or-branch>` after the URL.

**Without arguments** — restore all libraries from `.jaiph/libs.lock`. Useful after cloning a project or in CI.

If `.jaiph/libs/<name>/` already exists, the library is skipped. Use `--force` to delete and re-clone.

**Lockfile format** (`.jaiph/libs.lock`):

```json
{
  "libs": [
    { "name": "queue-lib", "url": "https://github.com/you/queue-lib.git", "version": "v1.0" }
  ]
}
```

**Examples:**

```bash
# Install a library
jaiph install https://github.com/you/queue-lib.git

# Install at a specific version
jaiph install https://github.com/you/queue-lib.git@v1.0

# Re-clone an existing library
jaiph install --force https://github.com/you/queue-lib.git

# Restore all libraries from lockfile
jaiph install
```

After installation, import library modules using the `<lib-name>/<path>` convention:

```jaiph
import "queue-lib/queue" as queue
```

See [Grammar — Imports and Exports](grammar.md#imports-and-exports) for resolution rules.

## `jaiph use`

Reinstall Jaiph globally with the selected channel or version.

```bash
jaiph use <version|nightly>
```

- `nightly` — installs from the `nightly` ref.
- `<version>` — installs tag `v<version>`.

**Examples:**

```bash
jaiph use nightly
jaiph use 0.9.2
```

## File extension

**`.jh`** is the file extension for Jaiph source files. Use it for entrypoints, imports, and all CLI commands (`run`, `test`). Import resolution appends `.jh` when the path omits the extension.

## Environment variables

### Runtime and config overrides

These variables apply to `jaiph run` and workflow execution. Variables marked **internal** are set automatically — do not set them manually.

**Internal variables:**

- `JAIPH_META_FILE` — path to the metadata file the CLI writes under the build output directory; the workflow runner reads it after exit. Set by the launcher on the child process; `resolveRuntimeEnv` removes any inherited value from the parent.
- `JAIPH_RUN_DIR`, `JAIPH_RUN_ID`, `JAIPH_RUN_SUMMARY_FILE` — set by `NodeWorkflowRuntime` to the run directory, stable run UUID, and `run_summary.jsonl` path.
- `JAIPH_SOURCE_FILE` — set automatically by the CLI to the entry file basename. Used to name run directories.

**Workspace and run paths:**

- `JAIPH_WORKSPACE` — workspace root, set by the CLI. Detected by walking up from the entry `.jh` file's directory until `.jaiph` or `.git` is found. Guards in `detectWorkspaceRoot` skip misleading markers under shared system temp directories (`/tmp`, `/var/tmp`, macOS `/var/folders/.../T/...`) and nested `.jaiph/tmp` trees. In Docker sandbox mode the runtime remaps it inside the container (see [Sandboxing](sandboxing.md)).
- `JAIPH_RUNS_DIR` — root directory for run logs (default: `.jaiph/runs` under workspace).

**Agent and prompt configuration:**

- `JAIPH_AGENT_BACKEND` — prompt backend: `cursor` (default), `claude`, or `codex`. Overrides in-file `agent.backend`. When set to `claude`, the Anthropic Claude CLI must be on PATH. When set to `codex`, `OPENAI_API_KEY` must be set. See [Configuration](configuration.md).
- `JAIPH_AGENT_MODEL` — default model for `prompt` steps (overrides in-file `agent.default_model`).
- `JAIPH_AGENT_COMMAND` — command for the Cursor backend (e.g. `cursor-agent`; overrides in-file `agent.command`).
- `JAIPH_AGENT_TRUSTED_WORKSPACE` — trusted workspace directory for Cursor backend `--trust`. Defaults to project root.
- `JAIPH_AGENT_CURSOR_FLAGS` — extra flags for Cursor backend (string, split on whitespace).
- `JAIPH_AGENT_CLAUDE_FLAGS` — extra flags for Claude backend (string, split on whitespace).
- `OPENAI_API_KEY` — API key for the codex backend. Required when `agent.backend` is `"codex"`.
- `JAIPH_CODEX_API_URL` — endpoint URL for the codex backend (default: `https://api.openai.com/v1/chat/completions`). Use this to point at a compatible proxy or self-hosted endpoint.

**Execution behavior:**

- `JAIPH_DEBUG` — set to `true` for debug tracing.
- `JAIPH_RECURSION_DEPTH_LIMIT` — maximum recursion depth for workflows and rules (default: **256**). Exceeding this limit produces a runtime error.
- `JAIPH_INBOX_PARALLEL` — set to `true` for parallel dispatch of inbox route targets (overrides in-file `run.inbox_parallel`). See [Inbox](inbox.md).
- `NO_COLOR` — disables colored output.

**Non-TTY heartbeat:**

- `JAIPH_NON_TTY_HEARTBEAT_FIRST_SEC` — seconds before the first heartbeat (default: `60`).
- `JAIPH_NON_TTY_HEARTBEAT_INTERVAL_MS` — minimum milliseconds between subsequent heartbeats (default: `30000`; minimum `250`).

**Docker sandbox:**

- `JAIPH_DOCKER_ENABLED` — set to `true` to enable Docker sandbox (overrides in-file `runtime.docker_enabled`).
- `JAIPH_DOCKER_IMAGE` — Docker image for sandbox (overrides in-file `runtime.docker_image`). The image must already contain `jaiph`; if it does not, the run fails with `E_DOCKER_NO_JAIPH`. Defaults to the official GHCR runtime image (`ghcr.io/jaiphlang/jaiph-runtime:<version>`).
- `JAIPH_DOCKER_NETWORK` — Docker network mode (overrides in-file `runtime.docker_network`).
- `JAIPH_DOCKER_TIMEOUT` — execution timeout in seconds (overrides in-file `runtime.docker_timeout`).

For `JAIPH_DOCKER_*` defaults, image selection, mounts, and container behavior, see [Sandboxing](sandboxing.md).

### Install and `jaiph use`

- `JAIPH_REPO_URL` — Git repo URL or local path for install script.
- `JAIPH_REPO_REF` — ref used when installing; `jaiph use <version>` sets this to `v<version>` or `nightly` for nightly.
- `JAIPH_BIN_DIR` — target bin directory (default: `$HOME/.local/bin`).
- `JAIPH_LIB_DIR` — target lib directory (default: `$JAIPH_BIN_DIR/.jaiph`).
- `JAIPH_INSTALL_COMMAND` — command run by `jaiph use` to reinstall (default: `curl -fsSL https://jaiph.org/install | bash`).

### `jaiph init`

- `JAIPH_SKILL_PATH` — path to the skill markdown copied to `.jaiph/SKILL.md` when running `jaiph init`.
