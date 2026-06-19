---
title: Getting started
permalink: /getting-started
redirect_from:
  - /getting-started.md
---

# Getting started

**Jaiph** is a language and runtime for defining and orchestrating AI agent workflows.

It allows you to combine agentic workflows with strict checks and script calls. It comes with built-in Docker sandboxing for agentic workflows, and a set of tooling to make your development faster and more efficient.

## Setup

- **[Setup and installation](setup.md)** — Install the CLI, run a one-liner sample without cloning, execute workflows, format sources, and initialize a project with `.jaiph/` and workspace conventions.
- **[Libraries](libraries.md)** — Install git-based `.jh` modules under `.jaiph/libs/`, pin versions with a lockfile, and import them with paths like **`"lib-name/rest"`** (first segment is the folder under `.jaiph/libs/`).

## Language

- **[Language](language.md)** — Practical guide to rules, scripts, prompts, workflows, and imports, with patterns you can copy.
- **[Inbox & Dispatch](inbox.md)** — Named channels and `send` for routing work between workflows without tight coupling.
- **[Testing](testing.md)** — `*.test.jh` suites, mocks, and assertions for deterministic checks around workflows.
- **[Spec: Async Handles](spec-async-handles.md)** — `Handle<T>` resolution, implicit join, and interaction with `run async`.
- **[Grammar](grammar.md)** — Formal syntax, types, and step contracts for the whole surface area.

## Runtime

- **[CLI](cli.md)** — `jaiph run`, `test`, `compile`, `format`, `init`, `install`, `use`, flags, environment variables, and [file-path shorthand](cli.md#file-shorthand) for existing `.jh` / `*.test.jh` files. **`jaiph compile`** walks the import closure and runs **`validateReferences` only** — no **`scripts/`** emission, no **`buildRuntimeGraph()`**, no runner ([Architecture — Summary](architecture.md#summary); directory discovery skips **`*.test.jh`** unless you pass a test file explicitly).
- **[Configuration](configuration.md)** — `config { }` blocks, agent backends, logging, and runtime options (including env overrides).
- **[Runtime artifacts](artifacts.md)** — What Jaiph writes under `.jaiph/runs/` (per-step captures, **`run_summary.jsonl`**, optional **`inbox/`** files) versus live **`__JAIPH_EVENT__`** lines on stderr for progress and hooks.
- **[Hooks](hooks.md)** — Project or user `hooks.json` to run shell commands on workflow and step lifecycle events (hooks run on the **host** CLI even when the workflow runs in Docker).
- **[Sandboxing](sandboxing.md)** — Docker-backed isolation for **`jaiph run` only** (beta; **on by default** when **`JAIPH_DOCKER_ENABLED`** is unset and **`JAIPH_UNSAFE`** is not **`true`**). Enablement is **environment-only** — use **`JAIPH_DOCKER_ENABLED`** and **`JAIPH_UNSAFE`** as described in [Enabling Docker](sandboxing.md#enabling-docker); workflow **`config` cannot turn Docker on or off**. There is no **`jaiph run --docker`** flag. Image, network, and timeout still come from **`runtime.*`** and **`JAIPH_DOCKER_*`** where applicable ([Configuration](configuration.md)). **`jaiph test`** does not use Docker ([Architecture — Test runner integration](architecture.md#test-runner-integration-testjh-in-the-kernel)).

## Other

- **[VS Code extension](https://marketplace.visualstudio.com/items?itemName=jaiph.jaiph-syntax-vscode)** — Syntax highlighting, formatting, and compile feedback in the editor.
- **[Architecture](architecture.md)** — How the CLI, parser, transpiler, Node runtime, and contracts fit together; aimed at contributors and deep dives.
- **[Contributing](contributing.md)** — Clone-and-build workflow, branch strategy, test layers, and how to propose changes.
- **[Agent Skill](jaiph-skill.md)** — Short, opinionated defaults for AI assistants authoring and running Jaiph in a repo (same content as the canonical raw URL: `https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md`).
- **[Examples](https://github.com/jaiphlang/jaiph/tree/main/examples)** — Runnable samples (async, inbox, testing, recovery) alongside the main tree.
