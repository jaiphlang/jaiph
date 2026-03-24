---
title: CLI Reference
permalink: /cli
redirect_from:
  - /cli.md
---

# Jaiph CLI Reference

The Jaiph CLI compiles and runs workflow files (`.jh` / `.jph`), runs tests, and manages workspace setup.

**High-level usage:**

- **Run a workflow** — `jaiph run <file.jh>` or pass the file as the first argument: `jaiph <file.jh> [args...]`. Requires a `workflow default` in that file.
- **Run tests** — `jaiph test` discovers and runs all `*.test.jh` / `*.test.jph` under the workspace; or pass a directory or a single test file.
- **Compile only** — `jaiph build [--target <dir>] [path]` compiles `.jh`/`.jph` files into shell scripts without executing. Without `--target`, compiled scripts are written alongside the source files.
- **Setup** — `jaiph init [workspace-path]` creates `.jaiph/` with a bootstrap workflow and synced skill guide; `jaiph use <version|nightly>` reinstalls the global Jaiph binary.

**Commands:** `build`, `run`, `test`, `init`, `use`. Global options: `jaiph --help`, `jaiph --version` (or `-h`, `-v`).

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

- **Directory mode** (`jaiph build ./` or `jaiph build ./flows`) — compiles all `.jh`/`.jph` files found in the directory tree (test files `*.test.jh`/`*.test.jph` are excluded) and reports all errors.
- **Single-file mode** (`jaiph build file.jh`) — compiles only the specified file and its transitive imports. Parse errors in sibling files are ignored.

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

Elsewhere in workflows, `$(...)` is shell-only: it must not invoke Jaiph rules, workflows, or functions, contain inbox send (`<-`), or use `run` / `ensure` as shell commands (`E_VALIDATE`). The same rules apply to every workflow shell line: the first command word cannot name a Jaiph symbol, even when the line also contains `$(...)`; use **`run`** to call functions from a workflow, not a bare `fn arg` line. See [Grammar](grammar.md#managed-calls-vs-command-substitution).

If a `.jh` or `.jph` file is executable and has `#!/usr/bin/env jaiph`, you can run it directly:

```bash
./.jaiph/bootstrap.jh "task details"
./flows/review.jh "review this diff"
```

### Run progress and tree output

During `jaiph run`, the CLI renders a tree of steps. **Tree output is the same in TTY and non-TTY:** each step appears as a line with a marker (▸ when started, ✓/✗ when done), the step kind (`workflow`, `prompt`, `function`, `rule`), and the step name. **`log` messages** also appear inline in the tree at the correct indentation depth — they have no marker, spinner, or timing; just the `ℹ` symbol (dim/gray) followed by the message text. **Completion lines include the step kind and name** so that each line is self-identifying even when multiple steps run concurrently (e.g. `✓ workflow scanner (0s)`, `✗ rule ci_passes (11s)`). The root PASS/FAIL summary retains its existing format (`✓ PASS workflow default (0.2s)`). There are no per-step live elapsed counters or in-place updates on tree lines.

**TTY only:** One extra line at the bottom shows which workflow is running and total elapsed: `▸ RUNNING workflow <name> (X.Xs)` — `▸ RUNNING` in yellow, `workflow` in bold, workflow name in default style, time in dim. This line is the **only** line updated in place (every second). When the run completes, that line is cleared and replaced by the final PASS/FAIL line.

**Non-TTY:** No RUNNING line and no in-place updates. Step start lines (▸) and completion lines (✓/✗) print as they occur. Raw stderr from the child process is echoed to stderr (in TTY mode it is captured but not echoed).

For **parameterized** invocations—when you pass arguments to a workflow, prompt, function, or rule—the tree shows those argument **values** inline in gray immediately after the step name. Format:

- All parameters use a uniform **`key="value"`** format in parentheses. Internal refs such as `::impl` and empty or whitespace-only values are omitted.
- **Positional parameters** (`$1`, `$2`, or `argN`) display as `1="value"`, `2="value"`, etc. **Named parameters** display as `name="value"`.
- **Whitespace normalization:** Newlines, tabs, and consecutive spaces inside parameter values are collapsed to a single space before display. This keeps multi-line prompt bodies, roles, and similar values readable on a single tree line.
- Values are truncated to 32 visible characters; longer values end with `...`.
- **Prompt steps:** The line shows a **prompt preview** (first 24 characters of the prompt text, then `...` if longer) in quotes, followed by parameters. The parameter list is capped at 96 characters total (truncated with `...` if longer).
- Order follows the call site so repeated runs are diff-friendly.

Example lines:

- `▸ workflow docs_page (1="docs/cli.md", 2="strict")`
- `·   ▸ prompt "$role does $task" (role="engineer", task="Fix bugs")`
- `·   ▸ prompt "Say hello to $1 and..." (1="greeting")`
- `·   ▸ function fib (1="3")`
- `·   ▸ rule check_arg (1="Alice")`

If no parameters are passed, the line is unchanged (e.g. `▸ workflow default`). Color can be disabled with `NO_COLOR=1`.

**Prompt steps show no output in the tree.** When a `prompt` step completes, only the step line and ✓ appear — no Command, Prompt, Reasoning, or Final answer block. To display agent output in the tree, use `log` explicitly:

```jaiph
response = prompt "Summarize the report"
log "$response"
```

The `log` line renders inline at the correct depth as `ℹ <message>` (dim/gray) and writes to **stdout**. The `logerr` variant renders as `! <message>` in red and writes to **stderr**. The step's `.out` file in `.jaiph/runs/` still contains the full agent transcript for debugging.

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

### Hooks

You can run custom commands at workflow/step lifecycle events via **hooks**. Config lives in `~/.jaiph/hooks.json` (global) and `<project>/.jaiph/hooks.json` (project-local); project-local overrides global per event. See [Hooks](hooks.md) for schema, events, payload, and examples.

## `jaiph test`

Run tests from native test files (`*.test.jh` / `*.test.jph`) that contain `test "..." { ... }` blocks. Test files can import workflows and use `mock prompt` (or `mock prompt { ... }`) to simulate agent responses without calling the real backend.

**Usage:**

- `jaiph test` — discover and run all `*.test.jh` / `*.test.jph` under the workspace root (the directory containing `.jaiph` or `.git`, found by walking up from the current working directory).
- `jaiph test <dir>` — run all test files under the given directory.
- `jaiph test <file.test.jh>` — run a single test file.

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
jaiph use 0.4.0
```

## File extensions

- **`.jh`** is the recommended extension for new Jaiph files. Use it for entrypoints, imports, and `jaiph build` / `jaiph run` / `jaiph test`.
- **`.jph`** remains supported for backward compatibility. Existing projects using `.jph` continue to work unchanged. The CLI may show a deprecation notice when you run a `.jph` file; migrate when convenient with `mv *.jph *.jh` and update import paths if they explicitly mention the extension.

Imports resolve for both extensions: `import "foo" as x` finds `foo.jh` or `foo.jph` (`.jh` is preferred when both exist).

## Environment variables

**Runtime and config overrides** (for `jaiph run` and workflow execution):

- `JAIPH_STDLIB` — path to `jaiph_stdlib.sh`.
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

**Install and `jaiph use`:**

- `JAIPH_REPO_URL` — Git repo URL or local path for install script.
- `JAIPH_REPO_REF` — ref (e.g. branch or tag) used when installing; `jaiph use <version>` sets this to `v<version>` or `main` for nightly.
- `JAIPH_BIN_DIR` — target bin directory (default: `$HOME/.local/bin`).
- `JAIPH_LIB_DIR` — target lib directory (default: `$JAIPH_BIN_DIR/.jaiph`).
- `JAIPH_INSTALL_COMMAND` — command run by `jaiph use` to reinstall (default: `curl -fsSL https://jaiph.org/install | bash`).

**`jaiph init`:**

- `JAIPH_SKILL_PATH` — path to the skill file copied to `.jaiph/jaiph-skill.md` when syncing from the local installation.
