# Jaiph CLI Reference

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Testing](testing.md) · [Hooks](hooks.md) · [Agent Skill](https://jaiph.org/jaiph-skill.md)

---

## Overview

The Jaiph CLI compiles and runs workflow files (`.jh` / `.jph`), runs tests, and manages workspace setup. You can use explicit commands (`jaiph run`, `jaiph test`, etc.) or pass a file path directly when the first argument is a `.jh` or `.test.jh` file.

**Commands:** `build` (compile to shell scripts), `run` (compile and execute a workflow), `test` (run test files), `init` (create `.jaiph/` in a directory), `use` (reinstall a version). Global options: `jaiph --help`, `jaiph --version` (or `-h`, `-v`).

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
jaiph build [--target <dir>] <path>
```

Examples:

```bash
jaiph build ./
jaiph build --target ./build ./flows
```

## `jaiph run`

Compile and run a Jaiph workflow file.  
`jaiph run` requires a `workflow default` entrypoint.

```bash
jaiph run [--target <dir>] <file.jh|file.jph> [args...]
```

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

If a `.jh` or `.jph` file is executable and has `#!/usr/bin/env jaiph`, you can run it directly:

```bash
./.jaiph/bootstrap.jh "task details"
./flows/review.jh "review this diff"
```

### Run progress and tree output

During `jaiph run`, the CLI renders a tree of steps. **Tree output is the same in TTY and non-TTY:** each step appears as a line with a marker (▸ when started, ✓/✗ when done), the step kind (`workflow`, `prompt`, `function`, `rule`), and the step name. Final elapsed time is shown only when a step completes (e.g. `✓ 2s`). There are no per-step live elapsed counters or in-place updates on tree lines.

**TTY only:** One extra line at the bottom, in the same style as the final `PASS` line, shows which workflow is running and total elapsed: `  RUNNING workflow <name> (X.Xs)` — RUNNING in yellow, the word "workflow" in bold, workflow name in default style, time in gray/dim. This line is the **only** line updated in place (e.g. every second). When the run completes, that line is removed or replaced by the final PASS/FAIL line.

**Non-TTY:** No RUNNING line and no in-place updates; only completed step lines are printed.

For **parameterized** invocations—when you pass arguments to a workflow, prompt, or function—the tree shows those argument **values** inline in gray immediately after the step name. Format:

- Comma-separated **values** in parentheses (no parameter names or labels; internal refs such as `::impl` are omitted).
- Values are truncated to 32 visible characters; longer values end with `...`.
- Order follows the call site so repeated runs are diff-friendly.

Example lines:

- `▸ workflow docs_page (docs/cli.md, strict)`
- `·   ▸ prompt prompt (greeting)`
- `·   ▸ function fib (3)`

If no parameters are passed, the line is unchanged (e.g. `▸ workflow default`). Color can be disabled with `NO_COLOR=1`.

### Hooks

You can run custom commands at workflow/step lifecycle events via **hooks**. Config lives in `~/.jaiph/hooks.json` (global) and `<project>/.jaiph/hooks.json` (project-local); project-local overrides global per event. See [Hooks](hooks.md) for schema, events, payload, and examples.

## `jaiph test`

Run tests from native test files (`*.test.jh` / `*.test.jph`) that contain `test "..." { ... }` blocks. Test files can import workflows and use `mock prompt` (or `mock prompt { ... }`) to simulate agent responses without calling the real backend.

**Usage:**

- `jaiph test` — discover and run all `*.test.jh` / `*.test.jph` under the workspace root.
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

- `.jaiph/bootstrap.jh` (if it does not exist; otherwise left unchanged)
- `.jaiph/jaiph-skill.md` (synced from local Jaiph installation)

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
jaiph use 0.2.0
```

## File extensions

- **`.jh`** is the recommended extension for new Jaiph files. Use it for entrypoints, imports, and `jaiph build` / `jaiph run` / `jaiph test`.
- **`.jph`** remains supported for backward compatibility. Existing projects using `.jph` continue to work unchanged. The CLI may show a deprecation notice when you run a `.jph` file; migrate when convenient with `mv *.jph *.jh` and update import paths if they explicitly mention the extension.

Imports resolve for both extensions: `import "foo" as x` finds `foo.jh` or `foo.jph` (`.jh` is preferred when both exist).

## Environment variables

**Runtime and config overrides** (for `jaiph run` and workflow execution):

- `JAIPH_STDLIB` — path to `jaiph_stdlib.sh`.
- `JAIPH_AGENT_MODEL`
- `JAIPH_AGENT_COMMAND`
- `JAIPH_AGENT_BACKEND` — prompt backend: `cursor` (default) or `claude`. Overrides in-file `agent.backend`. When set to `claude`, the Anthropic Claude CLI (`claude`) must be installed and on PATH; otherwise the run fails with a clear error. See [Configuration](configuration.md).
- `JAIPH_AGENT_TRUSTED_WORKSPACE` — trusted workspace directory for Cursor backend `--trust`. Defaults to project root.
- `JAIPH_AGENT_CURSOR_FLAGS` — extra flags for Cursor backend (string, split on whitespace).
- `JAIPH_AGENT_CLAUDE_FLAGS` — extra flags for Claude backend (string, split on whitespace).
- `JAIPH_RUNS_DIR` — directory for run logs (default: `.jaiph/runs/` under workspace).
- `JAIPH_DEBUG` — set to `true` to enable bash `set -x` during run.
- `JAIPH_ENSURE_MAX_RETRIES` — max retries for `ensure ... recover` steps (default: 10). When exceeded, the workflow exits with status 1.
- `NO_COLOR` — if set, disables colored output (e.g. progress and pass/fail).

**Install and `jaiph use`:**

- `JAIPH_REPO_URL` — Git repo URL or local path for install script.
- `JAIPH_REPO_REF` — ref (e.g. branch or tag) used when installing; `jaiph use <version>` sets this to `v<version>` or `main` for nightly.
- `JAIPH_BIN_DIR` — target bin directory (default: `$HOME/.local/bin`).
- `JAIPH_LIB_DIR` — target lib directory (default: `$JAIPH_BIN_DIR/.jaiph`).
- `JAIPH_INSTALL_COMMAND` — command run by `jaiph use` to reinstall (default: `curl -fsSL https://jaiph.org/install | bash`).

**`jaiph init`:**

- `JAIPH_SKILL_PATH` — path to the skill file copied to `.jaiph/jaiph-skill.md` when syncing from the local installation.
