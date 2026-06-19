---
title: Why Jaiph
permalink: /why-jaiph
diataxis: explanation
---

# Why Jaiph

Jaiph is a small language and runtime for AI-assisted automation. This page is the design context — what kind of problem it is meant for, what shape the solution takes, and which trade-offs it deliberately picks. For the implementation map see [Architecture](architecture.md); for syntax see [Language](language.md) and [Grammar](grammar.md).

## The problem

Modern automation pipelines have to do three different kinds of work in the same flow:

- **Deterministic checks** — does this file exist, does the build pass, does the schema match.
- **Real shell** — invoking a build tool, calling a CLI, manipulating files.
- **Non-deterministic AI steps** — asking an agent to summarize a diff, write a fix, classify a finding.

You can wire these together in any general-purpose language. The cost is glue: you write argument plumbing for each tool, hand-roll structured output handling for each agent call, and decide every time how to capture stdout, where to put logs, when to retry on failure, and how to fail loudly when something violates the structure you expected.

Jaiph treats orchestration as the language. The structure that an ad-hoc bash script picks up over time — "every step gets captured, every prompt is logged, every failure has a footer with paths to the artifact files" — is the **built-in** behavior, not something the workflow author has to write.

## The model

A `.jh` file declares four primitives, and the orchestration is what they compose into:

- **`rule`** — a non-mutating check. Calls other rules via `ensure`, calls scripts via `run`. Cannot send on channels, cannot prompt an agent, cannot fan out concurrently. The compiler enforces this; rules are the place to put assumptions the rest of the workflow gets to rely on.
- **`script`** — real shell (or Python, Node, anything with a shebang). The only place where shell code lives. Scripts are isolated from module-scoped variables; arguments are passed positionally.
- **`prompt`** — a task delegated to an AI agent. The body is interpolated, the agent's stdout is captured, and structured output (`returns "{ field: type }"`) is parsed and validated against a schema.
- **`workflow`** — the orchestration unit. Composes the other three, plus `run async` for concurrency, channels for message passing, `if` / `match` / `for_lines` for flow control, and `recover` / `catch` for failure handling.

Everything is a string, every step is logged, every run leaves durable artifacts under `.jaiph/runs/` (per-step `.out` and `.err` captures, plus an append-only `run_summary.jsonl`). That is the payoff over hand-rolled shell: repeatable, inspectable, testable automation.

## Three commitments

The design rests on three commitments that decide a lot of smaller questions:

1. **Strict structure around AI steps.** Agent responses are non-deterministic, so the language gives you the surrounding pieces that *are* deterministic. `rule` and `ensure` let you assert preconditions and postconditions in the same pipeline as the prompt. `prompt … returns "{ … }"` constrains the agent's output to a JSON shape; if it fails, the step fails. `recover` lets you ask an agent to repair its own output without giving up control of the loop.

2. **Sandbox by default.** `jaiph run` runs inside a Docker container with capabilities dropped, mounts allowlisted, and host environment variables stripped down to an explicit prefix list. The sandbox can be turned off (`JAIPH_UNSAFE=true`), but only by the host — a workflow file cannot disable it from inside. The point is not to claim Docker is impenetrable (the [Sandboxing](sandboxing.md) page is explicit about what it does and does not protect); the point is to make the safe path the path of least resistance, particularly for workflows pulled from elsewhere. The [Sandboxing](sandboxing.md) page covers the model in detail.

3. **No vendor lock-in.** Backends are pluggable via `agent.command`: any executable that reads a prompt from stdin and writes a response to stdout works. The default backends are Cursor, Claude, and Codex CLIs, but a shell script that calls a local model or a self-hosted endpoint is equally valid. There is no proprietary JSON protocol to implement.

## What Jaiph is not

Naming the boundaries helps as much as naming the design:

- **Not a general-purpose programming language.** Workflows are linear orchestration with the control flow they need (`if`, `match`, `for_lines`, `recover`, `catch`). Anything fancier belongs in a `script`.
- **Not a distributed system.** Channels are an in-process, drain-driven handoff between workflows in the same run — see [Inbox & Dispatch](inbox.md). There is no broker, no cross-process routing, no retry queue.
- **Not a CI replacement.** Jaiph runs the same way locally and inside CI containers; it does not provide the test-matrix, artifact-publishing, or environment-management work that CI platforms do.
- **Not a prompt framework.** There is no chain abstraction, no agent class hierarchy, no built-in memory store. A `prompt` step calls a backend; if you want chaining, compose steps.

The deliberate smallness is the point. The promise is that a `.jh` file behaves the way it reads, and the structure around it — sandboxing, logging, testing, formatting — is the runtime's job, not the workflow author's.

## Where to go next

- [Architecture](architecture.md) — the implementation map: parser, validator, runtime, CLI, contracts.
- [Sandboxing](sandboxing.md) — the design of the Docker boundary and what it does and does not protect against.
- [Inbox & Dispatch](inbox.md) — how `channel` and `send` compose workflows without a broker.
- [Spec: Async Handles](spec-async-handles.md) — the value model behind `run async`.
