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

Jaiph is built from four primitives, and the orchestration is what they compose into (`rule`, `script`, and `workflow` are top-level declarations; `prompt` is a step form used inside a workflow):

- **`rule`** — a non-mutating check. Calls other rules via `ensure`, calls scripts via `run`. The compiler rejects `send`, `prompt`, inline shell, and `run async` in rule bodies; rules are the place to put assumptions the rest of the workflow gets to rely on.
- **`script`** — a named executable block (shell, Python, Node, anything with a shebang). Workflow bodies can also run inline shell or `` run `body`(args) `` steps, but reusable shell lives in `script` definitions. Scripts do not inherit module-scoped `const` bindings; pass values as positional arguments.
- **`prompt`** — a task delegated to an AI agent. The body is interpolated, the agent's stdout is captured, and structured output (`returns "{ field: type }"`) is parsed and validated against a schema.
- **`workflow`** — the orchestration unit. Composes the other three, plus [`run async`](spec-async-handles.md) for concurrency, channels for message passing, `if` / `match` / `for_lines` for flow control, and `recover` / `catch` for failure handling.

Orchestration values are strings, every step is logged, and every run leaves durable artifacts under `.jaiph/runs/` (per-step `.out` and `.err` captures, plus an append-only `run_summary.jsonl`). That is the payoff over hand-rolled shell: repeatable, inspectable, testable automation.

## Three commitments

The design rests on three commitments that decide a lot of smaller questions:

1. **Strict structure around AI steps.** Agent responses are non-deterministic, so the language gives you the surrounding pieces that *are* deterministic. `rule` and `ensure` let you assert preconditions and postconditions in the same pipeline as the prompt. `prompt … returns "{ … }"` constrains the agent's output to a JSON shape; if it fails, the step fails. `recover` retries a failed `run` after a repair body executes, up to `run.recover_limit` — a common pattern when an agent's output needs correction before the pipeline continues.

2. **Sandbox by default.** `jaiph run` runs inside a Docker container with capabilities dropped, mounts allowlisted, and host environment variables stripped down to an explicit allowlist (`JAIPH_*` run-control keys plus the resolved backend's credential keys). The sandbox can be turned off (`JAIPH_UNSAFE=true` or `jaiph run --unsafe`), but only by the host — a workflow file cannot disable it from inside. The point is not to claim Docker is impenetrable; the [Sandboxing](sandboxing.md) page is explicit about what it does and does not protect, and about making the safe path the path of least resistance for workflows pulled from elsewhere.

3. **No vendor lock-in.** Choose a backend with `agent.backend` (`cursor`, `claude`, or `codex`). Cursor and Claude invoke their respective CLIs; Codex uses an HTTP chat-completions path. On the **cursor** backend, `agent.command` can name any stdin→stdout executable — a wrapper around a local model or self-hosted endpoint works without implementing Jaiph's stream-json framing. Workflow authors do not need a proprietary agent protocol.

## What Jaiph is not

Naming the boundaries helps as much as naming the design:

- **Not a general-purpose programming language.** Workflows are linear orchestration with the control flow they need (`if`, `match`, `for_lines`, `recover`, `catch`). Anything fancier belongs in a `script`.
- **Not a distributed system.** Channels are an in-process, drain-driven handoff between workflows in the same run — see [Inbox & Dispatch](inbox.md). There is no broker, no cross-process routing, no retry queue.
- **Not a CI replacement.** Jaiph runs the same way locally and inside CI containers; it does not provide the test-matrix, artifact-publishing, or environment-management work that CI platforms do.
- **Not a prompt framework.** There is no chain abstraction, no agent class hierarchy, no built-in memory store. A `prompt` step calls a backend; if you want chaining, compose steps.

The deliberate smallness is the point. The promise is that a `.jh` file behaves the way it reads, and the structure around it — sandboxing, logging, testing, formatting — is the runtime's job, not the workflow author's.
