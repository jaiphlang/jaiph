---
title: Your first run
permalink: /tutorials/first-run
diataxis: tutorial
redirect_from:
  - /tutorials/first-workflow
  - /getting-started
  - /getting-started.md
---

# Your first run

This tutorial walks you through writing and running your first Jaiph program. By the end of it you will have written a single `.jh` file, run it with the `jaiph` CLI, watched the live progress tree, and looked at the run artifacts the runtime writes under `.jaiph/runs/`.

This tutorial uses only `script` steps, so you do not need an agent backend or API keys. The follow-up tutorial [Your first agent run](first-agent-run.md) adds a `prompt` step on top of what you build here.

## What you will build

You will write a file with one script step that prints a greeting, and a `return` that passes the script's output back as the run's return value. The whole file is five lines.

## Prerequisites

- A POSIX shell (`sh`, `bash`, `zsh`) with `curl` and either `shasum` or `sha256sum` available.
- About five minutes.

Node and API keys are not required for this tutorial. `jaiph run` executes on the host.

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

## 2. Write the file

Create a fresh directory and write a file named `hello.jh`:

```jh
script greet = `echo "Hello, ${1:-world}!"`

export def main(who) {
  return run greet(who)
}
```

Here is what each line does:

- `` script greet = `…` `` declares a managed script with a single-line bash body. For a multi-line body, use a fenced block where the fence tag selects the interpreter, such as `` script greet = ```bash … ``` `` for bash or `` ```node `` for Node. See [the Script RHS section of the grammar reference](grammar.md#definitions). A script body uses shell positional arguments such as `$1` and `$2`, not Jaiph `${name}` interpolation. The `${1:-world}` form is bash default expansion, which supplies `world` when `run greet(...)` passes no value.
- `export def main(who)` is the run entry. Every `.jh` file invoked with `jaiph run` enters at `export def main`. The `who` parameter is bound by position from the CLI arguments after the file path.
- `return run greet(who)` calls the script with `who` as `${1}`, captures its stdout as the step value, and returns it as the run's return value.

## 3. Run it

```bash
jaiph run ./hello.jh "Adam"
```

Before any step runs, the CLI prepares the file in two steps:

- The CLI loads the entry file and its import closure into a `ModuleGraph` once. This file has no imports, so the closure is one module.
- The CLI validates the graph and emits each `script` body as an executable file under a temporary `scripts/` directory that `$JAIPH_SCRIPTS` points to. Def steps stay as interpreted AST, so there is no transpiled `main.sh`.

You should see this (timings will differ):

```text
Jaiph: Running hello.jh

def main (who="Adam")
  ▸ script greet (1="Adam")
  ✓ script greet (0s)

✓ PASS def main (0.2s)

Hello, Adam!
```

The first line is the run banner. The `def main` row and the indented `▸` and `✓` rows are the live progress tree. A `▸` marks a step that has started, a `✓` marks a step that has finished, and `(0s)` is the elapsed time for that step. The root row is static, and only nested steps print `▸` and `✓` lines. The blank line and `Hello, Adam!` after `PASS` are the return value of `export def main`, which `jaiph run` prints on stdout after a successful run.

## 4. Inspect the run artifacts

Every run writes durable files under `.jaiph/runs/<YYYY-MM-DD>/<HH-MM-SS>-<entry>/` in UTC. List the most recent run:

```bash
ls -la .jaiph/runs/*/*/
```

The layout you should see:

- `000001-def__main.out` and `.err` hold the captured stdout and stderr for the entry def.
- `000002-script__greet.out` and `.err` hold the captured stdout and stderr for the `greet` script step.
- `return_value.txt` holds the value `def main` returned, and it is written only on success.
- `run_summary.jsonl` is the durable event timeline, with records such as `RUN_START`, `STEP_START`, `STEP_END`, and `RUN_END`.
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

export def main(who) {
  return run greet(who)
}
```

Re-run with the same arguments:

```bash
jaiph run ./hello.jh "Adam"
```

The CLI prints a `✗ FAIL` line on stderr, then a block with `Logs:`, `Summary:`, `out:`, and `err:` lines that point to the run directory, followed by an `Output of failed step:` excerpt. The process exits non-zero. `return_value.txt` is not written on failure, only on success.

## Where to go next

Revert the failing script body so the run passes again, then pick a direction:

- [Your first agent run](first-agent-run.md) adds a `prompt` step that calls an agent backend.
- [Language reference](language.md) covers every step type and expression kind, with their allowed positions and capture rules.
- [CLI reference](cli.md) covers every `jaiph` subcommand and flag.
- [Architecture](architecture.md) explains how the CLI, parser, validator, transpiler, runtime, and contracts fit together.
