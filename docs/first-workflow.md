---
title: Your first workflow
permalink: /tutorials/first-workflow
diataxis: tutorial
redirect_from:
  - /getting-started
  - /getting-started.md
---

# Your first workflow

This tutorial walks you through writing and running your first Jaiph workflow. By the end of it you will have written a single `.jh` file, run it with the `jaiph` CLI, watched the live progress tree, and looked at the run artifacts the runtime writes under `.jaiph/runs/`.

This tutorial uses only `script` steps, so you do not need an agent backend, API keys, or Docker. The follow-up tutorial [Your first agent + sandboxed run](first-agent-run.md) adds a `prompt` step and the Docker sandbox on top of what you build here.

## What you will build

You will write a workflow with one script step that prints a greeting, and a `return` step that passes the script's output back as the workflow's return value. The whole file is five lines.

## Prerequisites

- A POSIX shell (`sh`, `bash`, `zsh`) with `curl` and either `shasum` or `sha256sum` available.
- About five minutes.

Node, Docker, and API keys are not required for this tutorial. Runs use `jaiph run --unsafe` so the workflow runs on the host (Docker is on by default for `jaiph run`).

## 1. Install the CLI

Install the standalone binary:

```bash
curl -fsSL https://jaiph.org/install | bash
```

The installer downloads a per-platform binary, verifies its signature and checksum, and writes it to `~/.local/bin/jaiph`. See [Install and switch versions](setup.md) for other options, such as npm, `JAIPH_BIN_DIR`, and version switching.

Confirm the install:

```bash
jaiph --version
```

If the command is not found, prepend the install directory to `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 2. Write the workflow

Create a fresh directory and write a file named `hello.jh`:

```jh
script greet = `echo "Hello, ${1:-world}!"`

workflow default(who) {
  return run greet(who)
}
```

Here is what each line does:

- `` script greet = `…` `` declares a managed script with a single-line bash body. For a multi-line body, use a fenced block where the fence tag selects the interpreter, such as `` script greet = ```bash … ``` `` for bash or `` ```node `` for Node. See [the Script RHS section of the grammar reference](grammar.md#definitions). A script body uses shell positional arguments such as `$1` and `$2`, not Jaiph `${name}` interpolation. The `${1:-world}` form is bash default expansion, which supplies `world` when `run greet(...)` passes no value.
- `workflow default(who)` is the entry workflow. Every `.jh` file invoked with `jaiph run` enters at `workflow default`. The `who` parameter is bound by position from the CLI arguments after the file path.
- `return run greet(who)` calls the script with `who` as `${1}`, captures its stdout as the step value, and returns it as the workflow's return value.

## 3. Run it

```bash
jaiph run --unsafe ./hello.jh "Adam"
```

`--unsafe` sets `JAIPH_UNSAFE=true` for this run only and skips the Docker sandbox.

Because Docker is on by default, disabling the sandbox with `--unsafe` requires confirmation. The CLI prints a warning and waits for you to answer `y`:

```text
⚠️ You are going to run the Jaiph workflow in the unsafe mode with no sandboxing. It has full access to your machine.

Continue? [y/N] y
```

Type `y` and press Enter. In a non-interactive context such as CI, add `--yes` or set `JAIPH_INPLACE_YES=1` to skip this prompt.

Before any step runs, the CLI prepares the workflow in two steps:

- The CLI loads the entry file and its import closure into a `ModuleGraph` once. This file has no imports, so the closure is one module.
- The CLI validates the graph and emits each `script` body as an executable file under a temporary `scripts/` directory that `$JAIPH_SCRIPTS` points to. Workflow steps stay as interpreted AST, so there is no transpiled `default.sh`.

After you confirm, you should see this (timings will differ):

```text
Jaiph: Running hello.jh (Docker sandbox, unsafe)

  ⚠ You are running the Jaiph workflow in the unsafe mode with no sandboxing. It has full access to your machine.
workflow default (who="Adam")
  ▸ script greet (1="Adam")
  ✓ script greet (0s)

✓ PASS workflow default (0.2s)

Hello, Adam!
```

The first line is the sandbox banner. The `workflow default` row and the indented `▸` and `✓` rows are the live progress tree. A `▸` marks a step that has started, a `✓` marks a step that has finished, and `(0s)` is the elapsed time for that step. The root workflow row is static, and only nested steps print `▸` and `✓` lines. The blank line and `Hello, Adam!` after `PASS` are the workflow return value, which `jaiph run` prints on stdout after a successful run.

The `(Docker sandbox, unsafe)` banner reflects `--unsafe`. The workflow runs on the host with no container, and the runtime prints a warning that the workflow has full access to your machine. If you omit `--unsafe`, `jaiph run` uses the [Docker sandbox by default](sandbox-run.md), and the banner then reads `(Docker sandbox, snapshot)`. If Docker is enabled but the daemon is unavailable, the CLI exits with `E_DOCKER_NOT_FOUND` instead of falling back to the host.

## 4. Inspect the run artifacts

Every run writes durable files under `.jaiph/runs/<YYYY-MM-DD>/<HH-MM-SS>-<entry>/` in UTC. List the most recent run:

```bash
ls -la .jaiph/runs/*/*/
```

The layout you should see:

- `000001-workflow__default.out` and `.err` hold the captured stdout and stderr for the entry workflow step.
- `000002-script__greet.out` and `.err` hold the captured stdout and stderr for the `greet` script step.
- `return_value.txt` holds the value `workflow default` returned, and it is written only on success.
- `run_summary.jsonl` is the durable event timeline, with records such as `WORKFLOW_START`, `STEP_START`, `STEP_END`, and `WORKFLOW_END`.
- `heartbeat` is a liveness file that holds an epoch-milliseconds timestamp, refreshed about every 10 seconds while the run is active.

Read the captured script output and the return value:

```bash
cat .jaiph/runs/*/*/000002-script__greet.out
cat .jaiph/runs/*/*/return_value.txt
```

Both should match the line printed after `PASS`. The full artifact layout is documented in the [durable artifact layout section of the architecture page](architecture.md#durable-artifact-layout). The event types in `run_summary.jsonl` are documented in the [run artifacts section of the CLI reference](cli.md#run-artifacts).

## 5. Make it fail (and observe the failure footer)

Replace the script body with one that exits non-zero:

```jh
script greet = `echo "Hello, ${1:-world}!" && exit 7`

workflow default(who) {
  return run greet(who)
}
```

Re-run with the same arguments (confirm the `--unsafe` prompt again with `y`):

```bash
jaiph run --unsafe ./hello.jh "Adam"
```

The CLI prints a `✗ FAIL` line on stderr, then a block with `Logs:`, `Summary:`, `out:`, and `err:` lines that point to the run directory, followed by an `Output of failed step:` excerpt. The process exits non-zero. `return_value.txt` is not written on failure, only on success.

## Where to go next

Revert the failing script body so the workflow passes again, then pick a direction:

- [Your first agent + sandboxed run](first-agent-run.md) adds a `prompt` step that calls an agent backend, and runs the workflow inside the Docker sandbox.
- [Language reference](language.md) covers every step type and expression kind, with their allowed positions and capture rules.
- [CLI reference](cli.md) covers every `jaiph` subcommand and flag.
- [Architecture](architecture.md) explains how the CLI, parser, validator, transpiler, runtime, and contracts fit together.
