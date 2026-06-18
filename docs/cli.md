---
title: CLI Reference
permalink: /cli
redirect_from:
  - /cli.md
---

# Jaiph CLI Reference

Jaiph is a workflow system: authors write `.jh` modules, and a **TypeScript CLI** prepares scripts, launches a **Node workflow runtime**, and surfaces progress while the **JavaScript kernel** executes the AST in process (no separate workflow shell). The CLI is what you install as the `jaiph` binary — it is the boundary between your terminal or CI and the interpreter.

At a high level, the CLI does four things: **compile** script bodies from your module graph (`buildScripts`), **spawn** the detached workflow runner (`node-workflow-runner`) for `jaiph run`, **observe** `__JAIPH_EVENT__` lines on stderr to render progress and drive hooks (unless `--raw`), and **leave** durable artifacts under `.jaiph/runs`. `jaiph test` reuses the same compilation step and runtime kernel but executes test blocks in-process with mocks — see [Architecture](architecture.md) for the full pipeline.

This page lists **commands**, important **flags**, and **environment variables**. It focuses on how the tool behaves, not on the language itself. For semantics and the overall language model, see [Language](language.md). For concrete syntax rules (imports, orchestration strings, managed calls, …), see [Grammar](grammar.md). For repository layout, pipelines, and contracts (`__JAIPH_EVENT__`, artifacts, Docker vs local), see [Architecture](architecture.md).

**Commands:** `run`, `test`, `compile`, `format`, `init`, `install`, `use`.

**Global options:** `jaiph --help` and `jaiph -h` print the overview; `jaiph --version` / `jaiph -v` prints the CLI version. **Each subcommand also recognizes `-h` / `--help` anywhere in its argument list** before positional processing and prints command-specific usage (flags + one example) to stdout — for example `jaiph run --help`, `jaiph test --help`, `jaiph compile -h`, `jaiph format --help`, `jaiph init --help`, `jaiph install --help`, and `jaiph use --help` all exit **0** with their own usage block. Running **`jaiph`** with no arguments prints the overview and exits **0**.

Any other unknown first token prints `Unknown command: …`, repeats the overview, and exits **1**.

## File shorthand

If the **first argument after `jaiph`** is an **existing path** (resolved relative to the current working directory), Jaiph routes it automatically based on the extension. Files ending in **`*.test.jh`** are run as tests (same as `jaiph test <file>`). Other paths ending in **`.jh`** are run as workflows (same as `jaiph run <file>`). The `*.test.jh` check happens first, so test modules are never mistaken for workflows. Paths that do not exist fall through to normal command parsing (e.g. you cannot rely on shorthand for a not-yet-created file).

Additional positional tokens after a **workflow** shorthand are forwarded to **`workflow default`**, matching `jaiph run`. Tokens after a **test** shorthand are accepted but **ignored** (same as `jaiph test <file>` with extra arguments).

```bash
# Workflow shorthand
jaiph ./flows/review.jh "review this diff"
# equivalent to: jaiph run ./flows/review.jh "review this diff"

# Test shorthand
jaiph ./e2e/say_hello.test.jh
# equivalent to: jaiph test ./e2e/say_hello.test.jh
```

## `jaiph run`
{: #jaiph-run}

Parse, validate, and run a Jaiph workflow file. Requires a `workflow default` entrypoint.

```bash
jaiph run [--target <dir>] [--raw] <file.jh> [--] [args...]
```

Any path ending in `.jh` is accepted (including `*.test.jh`, since the extension is still `.jh`). For files that only contain test blocks, use `jaiph test` instead.

**Sandboxing:** whether the workflow runs in a **Docker container** or **directly on the host** is decided from environment variables and the workflow’s `runtime` metadata — there is no `jaiph run --docker` flag. Defaults and mounts are documented in [Sandboxing](sandboxing.md).

**Flags:**

- **`--target <dir>`** — keep emitted script files and run metadata under `<dir>` instead of a temp directory (useful for debugging).
- **`--raw`** — skip the banner, live progress tree, hooks, and CLI failure footer. The workflow runner child uses **inherited stdio** so `__JAIPH_EVENT__` JSON lines go to **stderr** unchanged. When **Docker sandboxing** is used, the **host** runs interactive `jaiph run` and the **container** runs `jaiph run --raw …` so the host can parse events from the container’s stderr ([Architecture](architecture.md), [Sandboxing](sandboxing.md)). **Important:** if you invoke `jaiph run --raw` yourself on the host, the CLI takes a separate code path that **never starts Docker** — workflow execution runs locally in that process even when `JAIPH_DOCKER_ENABLED=true`. Use `--raw` for embedding or piping; use interactive `jaiph run` (no `--raw`) when you want the CLI to apply sandbox env rules. There is no PASS/FAIL line, **`return_value.txt` is not printed to stdout**, and the process exit code alone reflects success or failure. See [Sandboxing — Runtime behavior](sandboxing.md#runtime-behavior).
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

**Rule** bodies are **managed steps only** — no raw shell lines; use `run` to a `script` for shell execution. **Workflow** bodies may include **inline shell** lines that do not parse as a Jaiph step (the compiler still validates them); for anything non-trivial, prefer a top-level `script` and `run`. In bash-bearing contexts (mainly `script` bodies, and restricted `const` / send RHS forms), `$(...)` and the first command word are validated: they must not invoke Jaiph rules, workflows, or scripts, contain inbox send (`<-`), or use `run` / `ensure` as shell commands (`E_VALIDATE`). See [Grammar — Language concepts](grammar.md#language-concepts) and [Grammar — Managed calls vs command substitution](grammar.md#managed-calls-vs-command-substitution).

For `const` in those bodies, a reference plus arguments on the RHS must be written as `const name = run ref([args...])` (or `ensure` for rule capture), not as `const name = ref([args...])` — the latter is `E_PARSE` with text that explains the fix.

### Shebang execution

If a `.jh` file is executable and has `#!/usr/bin/env jaiph`, you can run it directly:

```bash
./.jaiph/bootstrap.jh "task details"
./flows/review.jh "review this diff"
```

### Compile-time and process model

The default `jaiph run` path parses each reachable `.jh` **once**. The CLI calls **`loadModuleGraph`** (`src/transpile/module-graph.ts`) to walk the entry plus its transitive `import` closure, producing a **`ModuleGraph`** record (`{ entryFile, workspaceRoot?, modules: Map<absPath, { filePath, ast, imports }> }`). `parsejaiph(source, filePath)` is itself I/O-pure — `loadModuleGraph` is the only routine that reads `.jh` sources from disk. The entry AST is reused for the banner (`metadataToConfig`), and the same graph is passed to **`buildScriptsFromGraph(graph, outDir)`**, which calls `emitScriptsForModuleFromGraph` per reachable module and writes atomic `script` files. `validateReferences(graph)` runs against the in-memory ASTs — neither validation nor emission re-reads `.jh` files. Unrelated `.jh` files on disk are not read.

After validation, the CLI spawns the Node workflow runner as a detached child. For local (non-Docker) runs the CLI serializes the graph to `<outDir>/.jaiph-module-graph.json` with `writeModuleGraph` (deterministic JSON: entries sorted by absolute path, ASTs included verbatim) and points the child at it through the internal env var **`JAIPH_MODULE_GRAPH_FILE`**. The runner deserializes the file with `readModuleGraph` and passes the result to `buildRuntimeGraph(graph)`, which produces the `RuntimeGraph` (a type alias for `ModuleGraph`) by injecting `ScriptDef` stubs for `import script` declarations — without touching disk. When the env var is absent — Docker `jaiph run`, `jaiph run --raw`, `jaiph test`, or any other caller — the runner falls back to `loadModuleGraph(sourceFile, workspaceRoot)` on the source file. Either path runs `NodeWorkflowRuntime` with the same `RuntimeGraph` shape — `buildRuntimeGraph` still does **not** run `validateReferences`. Prompt steps, script subprocesses, inbox dispatch, and event emission are handled in the runtime kernel — workflows and rules are interpreted in-process; only `script` steps spawn a managed shell. The CLI listens on stderr for `__JAIPH_EVENT__` JSON lines, the single event channel for all execution modes. Stdout carries only plain script output, forwarded to the terminal as-is.

For the full data flow across the parent → child process boundary, see [Architecture — Local module graph](architecture.md#local-module-graph).

### Run progress and tree output

During `jaiph run`, the CLI renders a live tree of steps. Each step appears as a line with a marker, the step kind (`workflow`, `prompt`, `script`, `rule`), and the step name:

- **`▸`** — step started
- **`✓`** / **`✗`** — step completed (pass/fail), with elapsed time (e.g. `✓ workflow scanner (0s)`, `✗ rule ci_passes (11s)`)
- **`ℹ`** — `log` message (dim/gray, inline at the correct depth; no marker, spinner, or timing)
- **`!`** — `logerr` message (red, writes to stderr)

The root PASS/FAIL summary uses the format `✓ PASS workflow default (0.2s)`. Completion lines include the step kind and name so each line is self-identifying even when multiple steps run concurrently.

**`log` / `logerr` and backslash escapes:** The displayed text follows `echo -e` semantics — a literal `\n` or `\t` in the message becomes a newline or tab. `LOG` / `LOGERR` JSON on stderr (and the `message` field in `run_summary.jsonl`) carries the unexpanded shell string.

**TTY mode:** one extra line at the bottom shows the running workflow and elapsed time: `▸ RUNNING workflow <name> (X.Xs)` — updated in place every second. When the run completes, it is replaced by the final PASS/FAIL line.

**Successful exit:** when the default workflow exits **0**, the CLI prints `✓ PASS workflow default (...)` plus elapsed time (see above). If the workflow **returns** a value, the runtime writes `return_value.txt` under the run directory; the CLI prints that value on stdout **after** the PASS line, separated by a blank line (host paths are unchanged; Docker runs remap container paths when reading the file). See [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout).

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
const response = prompt "Summarize the report"
log response
```

### Failed run summary (stderr)

On non-zero exit, the CLI may print a footer with the path to `run_summary.jsonl`, `out:` / `err:` artifact paths, and `Output of failed step:` plus a trimmed excerpt. These are resolved from the **last** `STEP_END` object in the summary with `status` != 0, using `out_content` / `err_content` when present and otherwise the `out_file` / `err_file` fields (last matches terminal failure after `catch`/`ensure` retries and stray earlier failures). If no failed `STEP_END` is found, the CLI falls back to a run-directory artifact heuristic.

The leading **summary line** is the last non-empty trimmed line of captured stderr. When stderr is empty, the CLI substitutes `Workflow execution failed (exit <code>) with no error output; inspect run_summary.jsonl and step artifacts under <run_dir>` so an empty-stderr failure still points at the run directory and the exit code; if neither code nor run directory is known, it falls back to `Workflow execution failed.`.

In Docker mode, artifact paths recorded by the container use container-internal prefixes (`/jaiph/run/…`). The CLI remaps these to host paths and discovers the run directory from the bind-mounted runs directory by matching the `JAIPH_RUN_ID` in each `run_summary.jsonl` when the container meta file is inaccessible. This run-id-based lookup is safe under concurrent `jaiph run` invocations sharing the same runs directory. The failure summary therefore displays identically to local (no-sandbox) runs — same structure, same host-resolvable paths, same "Output of failed step" excerpt. See [Sandboxing — Path remapping](sandboxing.md#path-remapping).

### Run artifacts and live output

Each run directory is `<JAIPH_RUNS_DIR>/<YYYY-MM-DD>/<HH-MM-SS>-<source>/`, where date and time are UTC and `<source>` is `JAIPH_SOURCE_FILE` if set, otherwise the entry file basename. Steps that allocate captures open **paired** `NNNNNN-<safe_name>.out` and `.err` files at **`STEP_START`** (see [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout) and [Runtime artifacts — What each artifact is for](artifacts.md#what-each-artifact-is-for)).

Step **stdout** artifacts are written **incrementally during execution**, so you can tail a running step's output in real time:

```bash
# In one terminal — run a long workflow
jaiph run ./flows/deploy.jh

# In another terminal — watch a step's output as it executes
tail -f .jaiph/runs/2026-03-22/14-30-00-deploy.jh/000003-deploy__run_migrations.out
```

Which steps get numbered `.out`/`.err` pairs, how prompts differ from managed scripts, and when empty files are removed are spelled out in [Runtime artifacts](artifacts.md); the durable timeline either way is **`run_summary.jsonl`**.

### Run summary (`run_summary.jsonl`) {#run-summary-jsonl}

Each run directory also contains `run_summary.jsonl`: one JSON object per line, appended in execution order. It is the canonical append-only record of runtime events (lifecycle, logs, inbox flow, and step boundaries). Tooling can tail the file by byte offset and process new lines idempotently. For a single run, lines follow execution order; inbox routes always drain **sequentially**, so inbox lifecycle events stay aligned with dispatch order. Summary lines are still appended atomically under a lock shared with other concurrent writers on the same run directory (for example `run async` branches appending step events).

**Versioning.** Every object includes `event_version` (currently `1`). New fields may be added; consumers should tolerate unknown keys.

**Common fields.** All lines include `type`, `ts` (UTC timestamp), `run_id`, and `event_version`. Step-related types also carry `id`, `parent_id`, `seq`, and `depth` (matching the `__JAIPH_EVENT__` stream on stderr).

**Correlation rules:**

- **`run_id`:** same across all lines in a given run's file.
- **Workflow boundaries:** for each workflow name, `WORKFLOW_START` count equals `WORKFLOW_END` count.
- **Steps:** `STEP_START` and `STEP_END` share the same `id`. Use `parent_id`, `seq`, and `depth` to rebuild the tree.
- **Inbox:** one `INBOX_ENQUEUE` per `send` with a unique `inbox_seq` (zero-padded, e.g. `001`). Each routed target gets one `INBOX_DISPATCH_START` and one `INBOX_DISPATCH_COMPLETE` sharing the same `inbox_seq`, `channel`, `target`, and `sender`.
- **Ordering:** lines are valid JSONL (one object per line, atomic append). Inbox dispatch is sequential; `ts` order matches dispatch order for inbox lifecycle events on a single run.

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

The test runner uses the same Node workflow runtime as `jaiph run`. For each test file, the CLI runs **`buildScripts`** with that file as the **entrypoint** (the test module plus its **import closure** only — not every `*.jh` in the repo), so imported workflow modules get emitted scripts under `JAIPH_SCRIPTS`. It then builds the runtime graph **once** per file and reuses it across all blocks and `test_run_workflow` steps. Each block runs through the AST interpreter with mock support and assertion evaluation (`expect_contain`, `expect_equal`, `expect_not_contain`).

**Usage:**

- `jaiph test` — discover and run all `*.test.jh` under the workspace root. The workspace root is found by walking up from the **current working directory** until a directory with `.jaiph` or `.git` is found; if neither exists, the current directory is used (same `detectWorkspaceRoot` algorithm as `jaiph run` / `jaiph install`).
- `jaiph test <dir>` — run all `*.test.jh` files recursively under the given directory. Workspace root for script compilation is detected by walking up from **that directory** (resolved), not necessarily from your shell cwd.
- `jaiph test <file.test.jh>` — run a single test file; workspace root is detected from the test file’s directory.

**Discovery with zero matches is a no-op.** With no arguments, or with a directory that contains no `*.test.jh` files, the command writes `jaiph test: no *.test.jh files found (nothing to do)` to stderr and exits **0** — CI pipelines and agent loops can call `jaiph test` unconditionally. Passing an explicit file path that does not exist or is not a `*.test.jh` file remains an error (exit **1**) — a named target must exist.

Passing a plain workflow file (e.g. `say_hello.jh`) is not supported; the test file imports the workflow and declares mocks. Extra arguments after the path are accepted but ignored. See [Testing](testing.md) for test block syntax and assertions.

**Examples:**

```bash
jaiph test
jaiph test ./e2e
jaiph test e2e/workflow_greeting.test.jh
jaiph test e2e/say_hello.test.jh
```

## `jaiph compile`

Parse modules and run the same compile-time validation as before `jaiph run` **without** writing `scripts/`, **without** calling **`buildRuntimeGraph`**, and **without** spawning the workflow runner. Use this for CI gates, pre-commit hooks, or editor diagnostics.

```bash
jaiph compile [--json] [--workspace <dir>] <file.jh | directory> ...
```

At least one path is required. **`jaiph compile -h`** or **`jaiph compile --help`** prints command-specific usage and exits **0**.

**File arguments** — Each `*.jh` file is expanded to its **transitive import closure**; every module in the union is parsed and validated once.

**Directory arguments** — The tree is scanned for `*.jh` files whose basename is **not** `*.test.jh` (same rule as `walkjhFiles` in the transpiler: files like `foo.test.jh` are skipped). Each non-test `*.jh` under the tree is treated as an entrypoint and its closure merged into the same validation set. To validate a test module’s graph explicitly, pass that **`*.test.jh` file** as a path (directories never pick up `*.test.jh` as roots).

**Multiple-error reporting.** `jaiph compile` aggregates **all** recoverable validation errors across the import closure before exiting, rather than stopping at the first failure. Internally it calls **`collectDiagnostics(graph)`** (`src/transpile/validate.ts`), which walks every reachable module and returns a `Diagnostics` collector (`src/diagnostics.ts`) populated with every error the validator accumulated through `diag.error(...)` and `diag.capture(...)`. Output is sorted by `(file, line, col)` so a single compile cycle surfaces independent errors together — for example, a duplicate `import` alias on line 2, an undefined channel in a `send` on line 6, and an unknown `run` target on line 7 all appear in one report. **Fatal** errors (parser failures like an unterminated triple-quote, loader failures, etc.) still abort the closure for the affected entry — `jaiph compile` reports them as a single diagnostic for that entry and continues with the next entry. Any non-empty diagnostic set exits **1**.

**Flags:**

- **`--json`** — On success, print `[]` to stdout. On failure, print **one** JSON **array** containing every collected diagnostic — objects `{ "file", "line", "col", "code", "message" }` — to stdout and exit **1** (non-JSON errors use a synthetic `E_COMPILE` object when the message is not in `file:line:col CODE …` form). Without `--json`, the same set is written to **stderr** as one `path:line:col CODE message` line per diagnostic, in the same sorted order.
- **`--workspace <dir>`** — Override the workspace root used for **library import resolution** (`<workspace>/.jaiph/libs/`, etc.) for **all** modules reached from the given paths. When omitted, the workspace is **auto-detected** from each path’s location (`detectWorkspaceRoot` — same algorithm as `jaiph run`, starting from the file’s directory or from a directory argument).

## `jaiph format`

Reformat Jaiph source files to a canonical style. Paths must end with **`.jh`**, which includes **`*.test.jh`** test modules. The formatter parses each file into an AST and re-emits it with consistent whitespace and indentation. Formatting is idempotent — running it twice produces the same output. Comments and shebangs are preserved. Multiline string bodies (`"""…"""`), prompt blocks, and fenced script blocks are emitted verbatim — inner lines are not re-indented relative to the surrounding scope, so repeated formatting never shifts embedded content deeper.

**Blank-line preservation:** A single blank line between steps inside a workflow or rule body is preserved — use it for visual grouping of related calls. Multiple consecutive blank lines are collapsed to one; trailing blank lines before `}` are removed. This applies to all block-level steps (calls, `log`, `const`, `if`, etc.).

**Top-level ordering:** The formatter hoists `import`, `config`, and `channel` declarations to the top of the file (in that order, preserving source order within each group). All other top-level definitions — `const`, `rule`, `script`, `workflow`, and `test` blocks — keep their original relative order from the source file. Comments immediately before an `import`, `config`, or `channel` move with that construct when hoisted; comments before non-hoisted definitions stay in place.

**Top-level `const` quoting:** The formatter preserves the source delimiter on each top-level `const` value. A value written as a **double-quoted string** (`const q = ".jaiph/tmp/x.md"`) is re-emitted double-quoted, always — regardless of whether it contains whitespace. A value written as a **bare token** (`const MAX = 3`) stays bare. A value written as `"""…"""` is emitted verbatim. The formatter does not toggle between the quoted and bare forms based on value content, so the same file does not end up mixing styles.

```bash
jaiph format [--check] [--indent <n>] <path.jh ...>
```

One or more file paths are required (each path must end with `.jh`, e.g. `flow.jh` or `e2e/flow.test.jh`). Paths that do not end with `.jh` are rejected. If a file cannot be parsed, the command exits immediately with status 1 and a parse error on stderr.

**Flags:**

- **`--indent <n>`** — spaces per indent level (default: `2`).
- **`--check`** — verify formatting without writing. Exits 0 when all files are already formatted; exits 1 when any file needs changes, printing the file name to stderr. No files are modified in check mode.

**Examples:**

```bash
# Rewrite files in place
jaiph format flow.jh utils.jh

# Check formatting in CI (non-zero exit on drift); ensure globs expand to real paths
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
- `.jaiph/bootstrap.jh` — canonical bootstrap workflow; made executable. The template uses a triple-quoted multiline prompt body (`prompt """ ... """`) so the generated file parses and compiles as valid Jaiph. It asks the agent to scaffold workflows under `.jaiph/` and ends by logging a summary (`WHAT CHANGED` + `WHY`). Docker sandboxing uses the default `ghcr.io/jaiphlang/jaiph-runtime` image unless you set `runtime.docker_image` or `JAIPH_DOCKER_IMAGE`.
- `.jaiph/SKILL.md` — copied from the skill markdown shipped with this jaiph build. Resolution order: if **`JAIPH_SKILL_PATH`** is set **and** that path exists, it wins; otherwise the CLI tries install-relative paths (`jaiph-skill.md` beside the packaged tree, then `docs/jaiph-skill.md` beside the package), then **`docs/jaiph-skill.md` under the current working directory**, and finally an **embedded copy baked into the binary** (used by the bun-compiled standalone). So `jaiph init` always writes `SKILL.md`; there is no "skip and warn" path.

## `jaiph install`

Install project-scoped libraries. Libraries are git repos cloned into `.jaiph/libs/<name>/` under the **workspace root**. The workspace is determined from the **current working directory** (`detectWorkspaceRoot(process.cwd())` — walk upward until `.jaiph` or `.git`, with the same temp-directory guards as `jaiph run`). A lockfile (`.jaiph/libs.lock`) under that root tracks installed libraries for reproducible setups.

```bash
jaiph install [--force] [<name[@version]> | <repo-url[@version]> ...]
jaiph install [--force]
```

**Argument dispatch.** Each positional arg is classified by shape:

- **Registry name** — matches `/^[A-Za-z0-9_-]+(@[A-Za-z0-9._+/-]+)?$/` **and** contains no `/` and no `:`. Resolved through the registry (see below). Examples: `jaiphlang`, `mylib@v1.2`.
- **Git URL** — anything else, parsed exactly as before with optional trailing `@<version>`. Examples: `https://github.com/you/queue-lib.git`, `git@github.com:org/repo.git@main`.

**With arguments** — clone each repo into `.jaiph/libs/<name>/` (shallow: `--depth 1`) and upsert the entry in `.jaiph/libs.lock`.

- For a **registry name**, `<name>` is the registry key itself, regardless of the URL's last path segment. The lock entry stores the resolved clone URL.
- For a **git URL**, the library name is derived from the URL: last path segment, stripped of `.git` suffix (e.g. `github.com/you/queue-lib.git` → `queue-lib`). Version pinning is usually written as **`https://…/name.git@<tag-or-branch>`**; other URL shapes with a trailing **`@ref`** are also accepted when the parser can split URL and version unambiguously.

Either way, the directory name **is** the import prefix (resolution under `<workspace>/.jaiph/libs/<name>/…`; see [Grammar — Imports and Exports](grammar.md#imports-and-exports) and [Libraries](libraries.md#how-imports-resolve)).

**Post-clone hygiene.** After each successful clone the CLI runs three checks before the lib counts as installed:

1. **`.jh` module check** — the cloned tree must contain at least one `*.jh` file (recursive, `.git` skipped). If not, the lib directory is removed and the command fails with `lib "<name>" contains no .jh modules — not a jaiph library?`. No lock entry is written for the lib.
2. **Commit capture** — `git -C <libDir> rev-parse HEAD` is recorded as the 40-char `commit` field on the lock entry, so restore can verify the same commit later (see below).
3. **`.git` strip** — `<libDir>/.git` is deleted recursively. Installed libs are plain files on disk; the lockfile is the source of truth for what was cloned. This avoids nesting git repos inside consumer projects and the surprises (submodule-like prompts, accidental commits, IDE tooling confusion) that come with them.

**Without arguments** — restore all libraries from `.jaiph/libs.lock`. Useful after cloning a project or in CI. If the lockfile exists but lists **no** libraries, the command prints `No libs in lockfile.` and exits **0**. Restore mode does **not** invent new lock entries — the lockfile is read but not rewritten, and **the registry is never contacted** (lock entries already carry the resolved clone URL).

**Commit verification on restore.** When a lock entry carries a `commit`, restore re-clones at the recorded `version` and then compares the cloned tree's HEAD SHA against `commit`. On mismatch the lib directory is removed and the command fails non-zero with a message naming the lib, both SHAs, and the remedy — for example: `lib "queue-lib" commit mismatch: locked <40-char SHA>, cloned <40-char SHA> — the ref may have moved; re-run `jaiph install queue-lib@v1.0` explicitly to accept the new commit`. Lock entries without `commit` (older lockfiles) restore without the check — see [Lockfile](#lockfile) for the backward-compatibility contract.

If `.jaiph/libs/<name>/` already exists, the library is skipped without invoking `git` (warm path) — both for explicit arguments and for restore-from-lock. Use **`--force`** (anywhere in the argument list) to delete and re-clone.

**Parallel clones.** Missing libraries are cloned concurrently with a small bounded-concurrency executor (default **4 in flight**); the warm-path skip runs in a pre-pass before any clone work starts. Independent network/process latency therefore overlaps when several libraries are missing. Failures from individual clones still propagate: any non-zero clone exits the command non-zero, and failed libraries are **not** added to `.jaiph/libs.lock`. Successful and warm-skipped libraries are upserted as before.

### Registry

When at least one argument is a bare registry name, `runInstall` loads the **registry index** once per invocation from the source given by **`JAIPH_REGISTRY`** (or the default **`https://jaiph.org/registry`** when the env var is unset or empty). All-URL invocations and restore-from-lock never read the registry.

**Index format** — a single JSON document:

```json
{
  "libs": {
    "jaiphlang": {
      "url": "https://github.com/jaiphlang/jaiphlang.git",
      "description": "First-party helper modules"
    },
    "mylib": {
      "url": "https://example.com/some-other-repo-name.git",
      "description": "Demo library"
    }
  }
}
```

Each key must match `/^[A-Za-z0-9_-]+$/` (single path segment — the name becomes the `.jaiph/libs/<name>` directory and the import prefix). Each entry requires a string `url` and a string `description`. Unknown keys on entries are accepted (and ignored) so future fields can be added without a flag day.

**Source resolution** — the value of `JAIPH_REGISTRY` (or the default) decides how the index is read:

- Values **without** a `://` scheme (e.g. `./registry.json`, `/etc/jaiph/registry.json`) are read **from disk**. Useful for unit tests and air-gapped setups.
- Values starting with **`file://`** are read from disk after URL decoding.
- Everything else is fetched with global **`fetch`** (HTTP/HTTPS).

**Errors** — all failure paths exit non-zero and write to stderr:

- Unknown name → `lib "<name>" not found in registry <registry-source>`
- Read/fetch/parse failure → message containing both the registry source and the underlying cause (`failed to read registry <source>: <cause>`, `failed to fetch registry <source>: HTTP <status>`, `failed to parse registry <source>: <cause>`, `failed to parse registry <source>: invalid name "<name>"`, etc.)

### Lockfile
{: #lockfile}

`.jaiph/libs.lock` records every installed library by its resolved clone URL, the (optional) requested version, and the (optional) 40-char `commit` captured at clone time:

```json
{
  "libs": [
    {
      "name": "jaiphlang",
      "url": "https://github.com/jaiphlang/jaiphlang.git",
      "commit": "1a2b3c4d5e6f7890abcdef1234567890abcdef12"
    },
    {
      "name": "queue-lib",
      "url": "https://github.com/you/queue-lib.git",
      "version": "v1.0",
      "commit": "fedcba9876543210fedcba9876543210fedcba98"
    }
  ]
}
```

Because the lock entry stores the **resolved** URL, restore-from-lock (`jaiph install` with no args) works even when the registry source is unreachable or the index has changed.

**`commit` field.** Written automatically after each successful clone (40 hex chars). On restore, if the field is present the cloned commit must match — see [Commit verification on restore](#jaiph-install). When the field is missing (older lockfiles created before commit pinning), restore re-clones and skips the comparison, so existing lockfiles keep working as-is.

**Examples:**

```bash
# Install a library by registry name (uses JAIPH_REGISTRY or the default)
jaiph install jaiphlang

# Install a registry name at a specific version
jaiph install mylib@v1.2

# Install a library by git URL (no registry lookup)
jaiph install https://github.com/you/queue-lib.git

# Install at a specific version (URL form)
jaiph install https://github.com/you/queue-lib.git@v1.0

# Re-clone an existing library
jaiph install --force jaiphlang

# Restore all libraries from lockfile (registry not contacted)
jaiph install

# Use a local registry index for tests / air-gapped setups
JAIPH_REGISTRY=./registry.json jaiph install mylib
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

- `nightly` — reinstalls from the rolling `nightly` prerelease.
- `<version>` — reinstalls the release binary for tag `v<version>`.

Under the hood, `jaiph use` re-invokes `JAIPH_INSTALL_COMMAND` (default `curl -fsSL https://jaiph.org/install | bash`) with `JAIPH_REPO_REF` set to `nightly` or `v<version>`. The installer downloads the matching per-platform binary and `SHA256SUMS` from the GitHub Release, verifies the checksum, and replaces `~/.local/bin/jaiph` (or `JAIPH_BIN_DIR`). No build step runs on the user’s machine.

**Examples:**

```bash
jaiph use nightly
jaiph use 0.9.4
```

## File extension

**`.jh`** is the file extension for Jaiph source files. Use it for entrypoints, imports, and all CLI commands (`run`, `test`). Import resolution appends `.jh` when the path omits the extension.

## Environment variables

### Runtime and config overrides

These variables apply to `jaiph run` and workflow execution. Variables marked **internal** are set automatically — do not set them manually.

**Internal variables:**

- `JAIPH_META_FILE` — path to the run metadata file (under the CLI’s build output directory for that invocation). Set on the **detached workflow child** only; the parent strips any inherited value so leftover exports do not collide. The runner writes `run_dir=` / `summary_file=` lines for the host to read after exit.
- `JAIPH_SOURCE_ABS` — absolute path to the entry `.jh` file; set by the CLI for **`jaiph run`** before spawn. Required by the runner (local and Docker).
- `JAIPH_SCRIPTS` — directory containing emitted **`script`** files for this run; set after **`buildScripts()`**. Any **`JAIPH_SCRIPTS`** exported in the parent shell is cleared before launch so nested toolchains do not point at the wrong tree.
- `JAIPH_MODULE_GRAPH_FILE` — absolute path to a `ModuleGraph` JSON snapshot (`<outDir>/.jaiph-module-graph.json`) the CLI wrote with `writeModuleGraph`. Set by the CLI **only** for the default local (non-Docker, non-`--raw`) `jaiph run` path so the spawned `node-workflow-runner.js` builds the runtime graph from the cached ASTs instead of re-reading the import closure. The file is internal and may move; do not depend on its path or contents. When the variable is absent (Docker `jaiph run`, `jaiph run --raw`, `jaiph test`), `buildRuntimeGraph()` falls back to `loadModuleGraph` on disk. See [Architecture — Local module graph](architecture.md#local-module-graph).
- `JAIPH_RUN_DIR`, `JAIPH_RUN_ID`, `JAIPH_RUN_SUMMARY_FILE` — for a normal (**non-raw**) **`jaiph run`**, the host generates **`JAIPH_RUN_ID`** once per invocation (UUID), passes it through to the detached child (and into Docker when sandboxed), and Docker failure-path discovery can match summaries by this id. The runtime uses **`JAIPH_RUN_ID`** as the stable run identifier; if it is absent, the runtime may assign its own UUID. **`JAIPH_RUN_DIR`** and **`JAIPH_RUN_SUMMARY_FILE`** are set inside the runner once the UTC run directory exists.
- `JAIPH_SOURCE_FILE` — set automatically by the CLI to the entry file **basename**. Used to name run directories (see [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout)).

**Workspace and run paths:**

- `JAIPH_WORKSPACE` — workspace root, set by the CLI. Detected by walking up from the entry `.jh` file's directory until `.jaiph` or `.git` is found. Guards in `detectWorkspaceRoot` skip misleading markers under shared system temp directories (`/tmp`, `/var/tmp`, macOS `/var/folders/.../T/...`) and nested `.jaiph/tmp` trees. In Docker sandbox mode the runtime remaps it inside the container (see [Sandboxing](sandboxing.md)).
- `JAIPH_RUNS_DIR` — root directory for run logs. If unset in the environment, the CLI merges the entry module **`config`** field **`run.logs_dir`** (when present) into the spawned process environment; otherwise the default layout is `.jaiph/runs` under the workspace. Exporting **`JAIPH_RUNS_DIR` yourself locks that choice: in-file **`run.logs_dir`** cannot override an environment-provided value.

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
- `JAIPH_INBOX_MAX_DISPATCH` — maximum number of inbox messages a single workflow frame may drain before aborting (default: **1000**). Positive integer; non-numeric or non-positive values fall back to the default. Exceeding the cap fails the owning workflow with `E_INBOX_DISPATCH_LIMIT: drained <N> messages without quiescing — likely a circular send (channel "<name>"); raise JAIPH_INBOX_MAX_DISPATCH if intentional` (see [Inbox & Dispatch — Error semantics](inbox.md#error-semantics)).
- `NO_COLOR` — disables colored output.

**Non-TTY heartbeat:**

- `JAIPH_NON_TTY_HEARTBEAT_FIRST_SEC` — seconds before the first heartbeat (default: `60`).
- `JAIPH_NON_TTY_HEARTBEAT_INTERVAL_MS` — minimum milliseconds between subsequent heartbeats (default: `30000`; minimum `250`).

**Docker sandbox** (`jaiph run` only — see [Sandboxing](sandboxing.md)):

- **`JAIPH_UNSAFE`** — set to `true` to **disable** Docker when `JAIPH_DOCKER_ENABLED` is **unset** (run on the host). This is the supported “no container” escape hatch.
- **`JAIPH_DOCKER_ENABLED`** — when set, must be exactly `true` to force Docker on, or any other value to force Docker **off**. When **unset**, Docker follows the unsafe rule above (on by default unless `JAIPH_UNSAFE=true`). `CI=true` does **not** change this default.
- **`JAIPH_DOCKER_IMAGE`** — Docker image (overrides in-file `runtime.docker_image`). The image must already contain a `jaiph` binary; otherwise the run fails with `E_DOCKER_NO_JAIPH`. Defaults to the official GHCR runtime image (`ghcr.io/jaiphlang/jaiph-runtime:<version>`).
- **`JAIPH_DOCKER_NETWORK`** — Docker network mode (overrides in-file `runtime.docker_network`).
- **`JAIPH_DOCKER_TIMEOUT`** — execution timeout in seconds (overrides in-file `runtime.docker_timeout_seconds`).
- **`JAIPH_INPLACE`** — set to `1` or `true` to opt into **inplace** sandbox mode: the container stays on (machine isolated, caps dropped, env allowlist enforced) but the host workspace is bind-mounted read-write so the run's edits land live on the host. This is a different axis from `JAIPH_UNSAFE` (which turns the sandbox off entirely). With the variable set, mode selection **bypasses** `JAIPH_DOCKER_NO_OVERLAY` and the `/dev/fuse` heuristic. The CLI prompts for interactive confirmation before launch (see `JAIPH_INPLACE_YES`). See [Sandboxing — Inplace mode](sandboxing.md#inplace-mode-trusted-workspace-untrusted-machine).
- **`JAIPH_INPLACE_YES`** — set to `1` or `true` to auto-confirm the inplace-mode warning prompt (CI / non-TTY path). Required when `JAIPH_INPLACE` is set and stdin is not a TTY; otherwise the run aborts with `E_DOCKER_INPLACE_NO_CONFIRM` before launching the container.

Neither `JAIPH_INPLACE` nor `JAIPH_INPLACE_YES` is forwarded into the container (they would otherwise pass the `JAIPH_*` allowlist; both names are explicitly excluded).

In-file `runtime.docker_enabled` is **not** supported (parse error); use the variables above instead.

Only environment variables matching a fixed allow-prefix list (`JAIPH_*` except `JAIPH_DOCKER_*` and except `JAIPH_INPLACE` / `JAIPH_INPLACE_YES`, plus `ANTHROPIC_*`, `CURSOR_*`, `CLAUDE_*`) cross into the container — everything else is dropped before the run starts. See [Sandboxing — Environment variable forwarding](sandboxing.md#environment-variable-forwarding) for the full list and supported workarounds.

For overlay vs copy vs inplace workspace mode, mounts, and stderr wiring, see [Sandboxing](sandboxing.md). The `jaiph run` banner names the active mode in parentheses: `Docker sandbox, fusefs` (overlay), `Docker sandbox, tmp workspace` (copy), or `Docker sandbox, in-place (live host edits)` (inplace); `no sandbox` is shown when Docker is disabled.

### Install and `jaiph use`

- `JAIPH_REPO_URL` — local repo path (a directory containing `package.json`) for the from-source installer branch (used by `docs/install-from-local.sh`); ignored on the binary-download path.
- `JAIPH_REPO_REF` — release ref (e.g. `v0.9.4`, `nightly`) downloaded by `docs/install`; `jaiph use <version>` sets this to `v<version>` or `nightly` for nightly.
- `JAIPH_BIN_DIR` — target bin directory (default: `$HOME/.local/bin`).
- `JAIPH_RELEASE_BASE_URL` — override the GitHub Release base URL the installer downloads from (default: `https://github.com/jaiphlang/jaiph/releases/download/<ref>`). Useful for mirrors, offline bundles, or `file://` paths in tests.
- `JAIPH_INSTALL_COMMAND` — command run by `jaiph use` to reinstall (default: `curl -fsSL https://jaiph.org/install | bash`).
- `JAIPH_REGISTRY` — path or URL of the **lib registry index** used by `jaiph install <name>` (default: `https://jaiph.org/registry`). Values without a `://` scheme (or starting with `file://`) are read from disk; everything else is fetched via global `fetch`. The registry is only loaded when at least one positional arg is a bare name; URL-form installs and restore-from-lock never read it. See [`jaiph install`](#jaiph-install) for the index shape and error messages.

### `jaiph init`

- `JAIPH_SKILL_PATH` — path to the skill markdown copied to `.jaiph/SKILL.md` when running `jaiph init`. The file **must exist** at this path; otherwise the variable is ignored and the CLI falls back to the same install-relative, `docs/jaiph-skill.md` (cwd), and embedded-copy search described under [`jaiph init`](#jaiph-init).
