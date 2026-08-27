---
title: Why Jaiph
permalink: /why-jaiph
diataxis: explanation
---

# Why Jaiph

Jaiph is a small language and runtime for AI-assisted automation. This page explains the design behind Jaiph: the kind of problem it solves, the parts a program is built from, and the trade-offs it makes on purpose. For the implementation map, see [Architecture](architecture.md). For syntax, see [Language](language.md) and [Grammar](grammar.md).

## The problem

An automation pipeline often has to do four different kinds of work in the same flow:

- **Deterministic checks** — does this file exist, does the build pass, does the schema match.
- **Real shell** — running a build tool, calling a CLI, changing files.
- **AI steps that vary from run to run** — asking an agent to summarize a diff, write a fix, or classify a finding.
- **Isolating sensitive data** — tokens and credentials a script needs must not reach the agent or the run journal.

You can wire these together in any general-purpose language, but you pay for it in extra code. For each tool you write the argument handling, and for each agent call you write the structured-output handling. Every time, you also decide how to capture stdout, where to put logs, when to retry on failure, and how to fail clearly when the output does not match the structure you expected.

Jaiph makes orchestration the job of the language itself. Over time, people add the same structure to a bash script by hand, so that every step gets captured, every prompt is logged, and every failure ends with a footer that lists the paths to the artifact files. In Jaiph that structure is built in, and the author does not have to write it.

## The building blocks

Jaiph is built from three parts, and a program is what you get when you combine them. Two of them are top-level declarations, `def` and `script`. The third, `prompt`, is a step you write inside a def.

- **`def`** — the interpreted procedure. It combines scripts, prompts, other defs, [`run async`](spec-async-handles.md) to overlap work, channels to pass messages, `if` / `match` / `for` for control flow, and `recover` / `catch` to handle failures. `jaiph run` enters at `export def main`.
- **`script`** — a named block of code you can run (shell, Python, Node, or anything with a shebang line). A def body can also run inline shell or a `` run `body`(args) `` step, but shell you want to reuse belongs in a `script`. A script does not inherit module-level `const` bindings, so pass any values it needs as positional arguments.
- **`prompt`** — a task you hand to an AI agent. Jaiph fills in any variables in the body, captures the agent's stdout, and, when you declare a shape with `returns "{ field: type }"`, parses that output and checks it against the shape.

Every value in a def is a string, every step is logged, and every run leaves lasting files under `.jaiph/runs/`, including a `.out` and `.err` capture for each step and an append-only `run_summary.jsonl`. A program written this way gives you automation you can repeat, inspect, and test, unlike shell you wire together by hand.

## Design commitments

The design makes three commitments, and each one settles many smaller questions:

1. **Strict structure around AI steps.** An agent's response can vary from run to run, so the language gives you the surrounding pieces that do not. With `def` and `run` you can check conditions before and after a prompt in the same pipeline. With `prompt … returns "{ … }"` you require the agent's output to match a JSON shape, and the step fails if it does not. With `recover` you retry a failed `run` after a repair body runs, up to `run.recover_limit` times, which helps when an agent's output needs a fix before the pipeline can go on.

2. **Isolating sensitive data.** Secrets and agent access are kept apart on purpose. Injected host keys (`--env`, [`trusted_envs`](configuration.md#trusted-envs)) reach trusted `run` steps only; a second fail-closed scrub keeps them out of every `prompt` backend subprocess. Credential-shaped values are redacted from the run journal and from returned call diagnostics. The sanctioned path for a secret is explicit injection into a trusted step, not ambient host env or a file that happened to sit next to the program.

3. **No vendor lock-in.** You choose a backend with `agent.backend`, which can be `cursor`, `claude`, or `codex`. The cursor and claude backends call their own command-line tools, and the codex backend calls an HTTP chat-completions endpoint. On the cursor backend, `agent.command` can name any program that reads stdin and writes stdout, so a wrapper around a local model or a self-hosted endpoint works without implementing Jaiph's stream-json format. A program author does not need a proprietary agent protocol.

## What Jaiph is not

It also helps to say what Jaiph is not:

- **Not a general-purpose programming language.** A def runs steps in order and has only the control flow it needs, which is `if`, `match`, `for`, `recover`, and `catch`. Anything more complex belongs in a `script`.
- **Not a distributed system.** Channels pass messages between defs in the same run, in one process. See [Inbox & Dispatch](inbox.md). There is no broker, no cross-process routing, and no retry queue.
- **Not a replacement for CI.** Jaiph runs the same way on your machine and inside a CI container. It does not provide the test matrix, artifact publishing, or environment management that CI platforms do.
- **Not a prompt framework.** There is no chain abstraction, no agent class hierarchy, and no built-in memory store. A `prompt` step calls a backend, and if you want to chain calls, you compose steps yourself.

Jaiph stays small on purpose. A `.jh` file behaves the way it reads, and the structure around it, which includes logging, testing, and formatting, is the runtime's job rather than the program author's.
