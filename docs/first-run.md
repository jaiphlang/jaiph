---
title: Your first run
permalink: /tutorials/first-run
diataxis: tutorial
mermaid: true
redirect_from:
  - /tutorials/first-workflow
  - /getting-started
  - /getting-started.md
---

# Your first run

In this tutorial you write a Jaiph program, run it, and look at the files the run leaves behind. The program is one `.jh` file with five lines, and the tutorial takes about five minutes.

The program only runs a script, so you don't need an AI agent or an API key. The next tutorial, [Your first agent run](first-agent-run.md), adds a step that calls an agent.

## What you will build

You will write a file with one script that prints a greeting. The program runs the script and returns what the script printed.

## Prerequisites

- A POSIX shell (`sh`, `bash`, `zsh`) with `curl`, `minisign`, and either `shasum` or `sha256sum` available. The installer uses `minisign` to verify the release signature and `shasum` or `sha256sum` to verify the checksum. It fails closed if `minisign` is missing. See [Install and switch versions](setup.md) if you need to install without `minisign`.
- About five minutes.

Node and API keys are not required for this tutorial. `jaiph run` executes on the host.

## 1. Install the CLI

Install the standalone binary:

```bash
curl -fsSL https://jaiph.org/install | bash
```

The installer downloads a per-platform binary, verifies its signature and checksum, and writes it to `~/.local/bin/jaiph`. See [Install and switch versions](setup.md) for other options, such as `JAIPH_BIN_DIR` and version switching.

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
script greet = 'echo "Hello, ${1:-world}!"'

export def main(who) {
  return greet(who)
}
```

Here is what each line does:

- `script greet` declares a managed script. The body in the example is a single-line bash command. It uses shell positional arguments such as `$1` and `$2`, not Jaiph `${name}` interpolation. `${1:-world}` is bash default expansion, which supplies `world` when `greet(...)` passes no value. For a multi-line body or another interpreter, see [the Script RHS section of the grammar reference](grammar.md#definitions).
- `export def main(who)` is the run entry. Every `.jh` file invoked with `jaiph run` enters at `export def main`. The `who` parameter is bound by position from the CLI arguments after the file path.
- `return greet(who)` calls the script with `who` as `${1}`, captures its stdout as the step value, and returns it as the run's return value.

Before you run the file, you can look at its steps as a chart. `jaiph graph ./hello.jh` prints the chart below as [Mermaid](https://mermaid.js.org/) text, and it doesn't run anything. [Execution flow](execution-flow.md) explains every shape and arrow.

<div class="graph-sample" data-graph-sample="first-run" data-graph-block="1">
<div class="graph-render" role="img" aria-label="Execution flow of hello.jh"></div>
{% raw %}<script type="text/plain" data-graph-mermaid>
flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef input fill:#fff3d1,stroke:#b7871a,color:#4d3600
  classDef script fill:#e2f1e7,stroke:#3a8657,color:#163b25

  subgraph g1 ["<b>def</b> main"]
    n1(["start"]):::term
    n2[/"in: who"/]:::input
    n3["<b>script</b> greet(who)"]:::script
    n4(["end"]):::term
  end

  n1 --> n2
  n2 --> n3
  n3 -->|"return"| n4

  style g1 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
</script>{% endraw %}
</div>

## 3. Run it

```bash
jaiph run ./hello.jh "Adam"
```

The CLI checks the whole file before it runs the first step, so it reports a mistake such as a call to a script that doesn't exist without running anything. [Architecture](architecture.md) describes what happens between the command and the first step.

You should see this (timings will differ):

```text
Jaiph: Running hello.jh

def main (who="Adam")
  ▸ script greet (1="Adam")
  ✓ script greet (0s)

✓ PASS def main (0.2s)

Hello, Adam!
```

The first line is the run banner. The `def main` row and the indented `▸` and `✓` rows are the live progress tree. A `▸` marks a step that has started, a `✓` marks a step that has finished, and `(0s)` is the elapsed time for that step. The root row is static, and only nested steps print `▸` and `✓` lines. The `Hello, Adam!` line after `PASS` is the return value of `export def main`, which `jaiph run` prints on stdout after a successful run.

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
script greet = 'echo "Hello, ${1:-world}!" && exit 7'

export def main(who) {
  return greet(who)
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
- [Pass a host key to a script](script-env.md) shows how to grant one host secret with `use` and `--env`.
- [Language reference](language.md) covers every step type and expression kind, with their allowed positions and capture rules.
- [CLI reference](cli.md) covers every `jaiph` subcommand and flag.
- [Architecture](architecture.md) explains how the CLI, parser, validator, transpiler, runtime, and contracts fit together.
