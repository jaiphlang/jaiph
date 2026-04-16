---
title: Getting started
permalink: /getting-started
redirect_from:
  - /getting-started.md
---

# Getting Started

Jaiph is a composable scripting language and runtime for AI agent workflows. You write `.jh` files that combine prompts, rules, scripts, and workflows into executable pipelines.

## Setup

- **[Setup and installation](setup.md)** — Install the CLI, run a one-liner sample without cloning, execute workflows, format sources, and initialize a project with `.jaiph/` and workspace conventions.
- **[Libraries](libraries.md)** — Install git-based `.jh` modules under `.jaiph/libs/`, pin versions with a lockfile, and import them with the `library-name/module` path form.

## Language

- **[Language](language.md)** — Practical guide to rules, scripts, prompts, workflows, and imports, with patterns you can copy.
- **[Inbox & Dispatch](inbox.md)** — Named channels and sends for routing work between workflows without tight coupling.
- **[Testing](testing.md)** — `*.test.jh` suites, mocks, and assertions for deterministic checks around workflows.
- **[Grammar](grammar.md)** — Formal syntax, types, and step contracts for the whole surface area.

## Runtime

- **[CLI](cli.md)** — `jaiph run`, `test`, `format`, `init`, `install`, `use`, flags, and environment variables.
- **[Configuration](configuration.md)** — `config { }` blocks, agent backends, logging, and runtime options (including env overrides).
- **[Runtime artifacts](artifacts.md)** — What Jaiph writes under `.jaiph/runs/` (per-step logs, JSONL timeline, inbox files) versus live progress on stderr.
- **[Hooks](hooks.md)** — Project or user `hooks.json` to run shell commands on workflow and step lifecycle events.
- **[Sandboxing](sandboxing.md)** — Optional Docker-backed isolation for agent and script steps (beta).

## Other

- **[VS Code extension](https://marketplace.visualstudio.com/items?itemName=jaiph.jaiph-syntax-vscode)** — Syntax highlighting, formatting, and compile feedback in the editor.
- **[Architecture](architecture.md)** — How the CLI, parser, transpiler, Node runtime, and contracts fit together; aimed at contributors and deep dives.
- **[Contributing](contributing.md)** — Clone-and-build workflow, branch strategy, test layers, and how to propose changes.
- **[Agent Skill](https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md)** — Short, opinionated defaults for AI assistants authoring and running Jaiph in a repo.
- **[Examples](https://github.com/jaiphlang/jaiph/tree/main/examples)** — Runnable samples (async, inbox, testing, recovery) alongside the main tree.
