---
title: Your first workflow
permalink: /tutorials/first-workflow
diataxis: tutorial
redirect_from:
  - /getting-started
  - /getting-started.md
---

# Your first workflow

This is a learning-oriented walkthrough. By the end of it you will have authored a single `.jh` file, run it with the `jaiph` CLI, watched the live progress tree, and inspected the durable artifacts the runtime wrote under `.jaiph/runs/`.

This tutorial deliberately uses **only `script` steps** — no agent backend, no API keys, no Docker. The follow-up tutorial [Your first agent + sandboxed run](/tutorials/first-agent-run) adds a `prompt` step and the Docker sandbox on top of what you build here.

## What you will build

A workflow that runs one script step which prints a greeting, and a `return` step that propagates the script's output as the workflow's return value. The whole file is five lines.

## Prerequisites

- A POSIX shell (`sh`, `bash`, `zsh`) with `curl` and either `shasum` or `sha256sum` available.
- About five minutes.

Node, Docker, and API keys are **not** required for this tutorial. Runs use `jaiph run --unsafe` so execution stays on the host (Docker is on by default for `jaiph run`).

## 1. Install the CLI

Install the standalone binary:

```bash
curl -fsSL https://jaiph.org/install | bash
```

The installer downloads a per-platform binary, verifies its checksum, and writes it to `~/.local/bin/jaiph`. See [Install & switch versions](/how-to/install) for alternatives (npm, `JAIPH_BIN_DIR`, version switching).

Confirm the install:

```bash
jaiph --version
```

If the command is not found, prepend the install directory to `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 2. Author the workflow

Create a fresh directory and write a file named `hello.jh`:

```jh
script greet = `echo "Hello, ${1:-world}!"`

workflow default(who) {
  return run greet(who)
}
```

Three things are happening:

- `` script greet = `…` `` declares a managed script with a single-line bash body. For multi-line bodies, use a fenced block (`` script greet = ```bash … ```) — the fence tag selects the interpreter (`node`, `python3`, etc.); see [Grammar — Script RHS](/reference/grammar#definitions). Script bodies use shell positional args (`$1`, `$2`, …), not Jaiph `${name}` interpolation; `${1:-world}` is bash default expansion when `run greet(...)` passes no value.
- `workflow default(who)` is the entry workflow. Every `.jh` file invoked with `jaiph run` enters at `workflow default`. The `who` parameter is bound positionally from CLI arguments after the file path.
- `return run greet(who)` calls the script with `who` as `${1}`, captures its stdout as the step value, and returns it as the workflow's return value.

## 3. Run it

```bash
jaiph run --unsafe ./hello.jh "Adam"
```

`--unsafe` sets `JAIPH_UNSAFE=true` for this run only and skips the Docker sandbox. Two notes on what happens before any step runs:

- The CLI loads the entry file plus its import closure into a `ModuleGraph` once (this file has no imports, so the closure is one module).
- The CLI validates the graph and emits each `script` body as an executable file under a temp `scripts/` directory referenced by `$JAIPH_SCRIPTS`. Workflow steps stay as interpreted AST — there is no transpiled `default.sh`.

You should see this (timings will differ):

```text
Jaiph: Running hello.jh (unsafe)

⚠ You are running the Jaiph workflow in the unsafe mode with no sandboxing. It has full access to your machine.

workflow default (who="Adam")
  ▸ script greet (1="Adam")
  ✓ script greet (0s)

✓ PASS workflow default (0.2s)

Hello, Adam!
```

The first line is the sandbox banner. The `workflow default` row and the indented `▸` / `✓` rows are the live progress tree (`▸` = step started, `✓` = step completed; `(0s)` is per-step elapsed time). The root workflow row is static; only nested steps emit `▸` / `✓` lines. The blank line and `Hello, Adam!` after `PASS` are the workflow **return value** — `jaiph run` prints it on stdout after a successful run.

The `(Docker sandbox, unsafe)` banner reflects `--unsafe`: the workflow runs on the host with no container, and the runtime prints a warning reminding you that the workflow has full access to your machine. Omit `--unsafe` and `jaiph run` uses the [Docker sandbox by default](/how-to/sandbox-run); the banner then reads `(Docker sandbox, fusefs)` or `(Docker sandbox, tmp workspace)` depending on the host. If Docker is enabled but the daemon is unavailable, the CLI exits with `E_DOCKER_NOT_FOUND` rather than falling back to the host.

## 4. Inspect the run artifacts

Every run writes durable files under `.jaiph/runs/<YYYY-MM-DD>/<HH-MM-SS>-<entry>/` in UTC. List the most recent run:

```bash
ls -la .jaiph/runs/*/*/
```

The layout you should see:

- `000001-workflow__default.out` / `.err` — captured stdout/stderr for the entry workflow step.
- `000002-script__greet.out` / `.err` — captured stdout/stderr for the `greet` script step.
- `return_value.txt` — the value `workflow default` returned (success only).
- `run_summary.jsonl` — the durable event timeline (`WORKFLOW_START`, `STEP_START`, `STEP_END`, `WORKFLOW_END`, …).
- `heartbeat` — epoch-ms liveness file refreshed about every 10s while the run is active.

Read the captured script output and the return value:

```bash
cat .jaiph/runs/*/*/000002-script__greet.out
cat .jaiph/runs/*/*/return_value.txt
```

Both should match the line printed after `PASS`. The full artifact layout is pinned in [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout); the event types in `run_summary.jsonl` are documented in [CLI Reference — Run artifacts](/reference/cli#run-artifacts).

## 5. Make it fail (and observe the failure footer)

Replace the script body with one that exits non-zero:

```jh
script greet = `echo "Hello, ${1:-world}!" && exit 7`

workflow default(who) {
  return run greet(who)
}
```

Re-run with the same arguments:

```bash
jaiph run --unsafe ./hello.jh "Adam"
```

The CLI prints a `✗ FAIL` line on stderr, a `Logs:` / `Summary:` / `out:` / `err:` block pointing to the run directory, and an `Output of failed step:` excerpt. The process exits non-zero. `return_value.txt` is **not** written on failure — only success.

## Where to go next

Revert the failing script body so the workflow passes again, then pick a direction:

- [Your first agent + sandboxed run](/tutorials/first-agent-run) — add a `prompt` step that calls an agent backend, and run the workflow inside the Docker sandbox.
- [Reference — Language](/reference/language) — every step type and expression kind, with allowed positions and capture rules.
- [Reference — CLI](/reference/cli) — every `jaiph` subcommand and flag.
- [Architecture](architecture.md) — how the CLI, parser, validator, transpiler, runtime, and contracts fit together.
