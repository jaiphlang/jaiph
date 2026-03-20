---
title: Agent Skill
permalink: /jaiph-skill
redirect_from:
  - /jaiph-skill.md
---

# Jaiph Bootstrap Skill (for Agents)

## Overview

This document is a **skill guide** for AI agents that generate or modify Jaiph workflows. After `jaiph init`, the repo contains `.jaiph/bootstrap.jh` and a copy of this file (`.jaiph/jaiph-skill.md`). The bootstrap workflow prompts the agent to read this guide and scaffold a **minimal workflow set** for safe feature delivery: preflight checks, implementation workflow, verification workflow, and a default entrypoint that orchestrates them.

**Concepts:**

- **Rules** — Named blocks of shell commands used as checks or actions. Only `ensure` and shell are allowed inside a rule. Rules run in a read-only wrapper.
- **Workflows** — Named sequences of steps: `ensure` (call a rule), `run` (call a workflow), `prompt` (agent), or shell. Workflows orchestrate execution.
- **ensure** — Runs a rule; succeeds if exit code is 0. Optional `recover` turns it into a bounded retry loop.
- **run** — Invokes a workflow (local or via import alias). Must reference a workflow, not a shell command.
- **prompt** — Sends a string to the configured agent. Optional `returns` schema validates one line of JSON from the agent.

**Audience:** Agents that produce or edit `.jh` files. For full language semantics and validation rules, see [Grammar](grammar.md) and [Configuration](configuration.md).

---

## When to Use This Guide

Use this guide when generating or updating `.jaiph/*.jh` workflows for a repository after `jaiph init`.

## Source of Truth

The Jaiph codebase is authoritative. When this document conflicts with implementation or grammar, follow the codebase.

- **Runtime and build:** `src/parser.ts`, `src/parse/*.ts`, `src/transpiler.ts`, `src/transpile/*.ts`, `src/cli.ts` (and `src/cli/`).
- **Language and grammar:** [Grammar](grammar.md). Covers EBNF, validation (E_PARSE, E_SCHEMA, E_VALIDATE, E_IMPORT_NOT_FOUND), and transpilation.
- **Docs:** [jaiph.org](https://jaiph.org).

Ignore any legacy Markdown that contradicts these.

## What to Produce

A **minimal workflow set** under `.jaiph/` that supports safe feature delivery:

1. **Preflight** — Rules and `ensure` for repo state and required tools (e.g. clean git, required binaries). Expose a small workflow (e.g. `workflow default` in `readiness.jh`) that runs these checks.
2. **Review (optional)** — A workflow that reviews queued tasks before development starts (e.g. `ba_review.jh`). An agent prompt evaluates the next task for clarity, consistency, conflicts, and feasibility, then either marks it as ready or exits with questions. The implementation workflow gates on this marker so unreviewed tasks cannot proceed. See the Jaiph project's own `.jaiph/ba_review.jh` for a reference implementation.
3. **Implementation** — A workflow that drives coding changes (typically via `prompt`), e.g. `workflow implement` in `main.jh`. When using a task queue, the implementation workflow should check that the first task is marked as ready (e.g. via a `<!-- dev-ready -->` marker) before proceeding.
4. **Verification** — Rules and a workflow for lint/test/build (e.g. `verification.jh` with `workflow default`).
5. **Entrypoint** — A single `workflow default` (e.g. in `.jaiph/main.jh`) that runs: preflight → review → implementation → verification. This is what `jaiph run .jaiph/main.jh "..."` executes.

Prefer composable modules over one large file.

## Language Rules You Must Respect

- **Imports:** `import "path.jh" as alias` or `import 'path.jh' as alias`. Path may be single- or double-quoted. Path is relative to the importing file; extensions `.jh` and `.jph` are supported (`.jh` preferred).
- **Definitions:** `rule name { ... }`, `workflow name { ... }`, `function name() { ... }` (parentheses optional). Optional `export` before `rule` or `workflow` marks it as public (see [Grammar](grammar.md)). Optional `config { ... }` at the top of a file sets agent, run, and runtime options. Config values can be quoted strings, booleans (`true`/`false`), bare integers, or bracket-delimited arrays of strings (see [Grammar](grammar.md) and [Configuration](configuration.md)).
- **Top-level locals:** `local name = value` declares a module-scoped variable. Values may be double-quoted strings (multi-line, same quoting rules as `prompt`), single-quoted strings, or bare values. The variable is accessible as `$name` inside all rules, functions, and workflows in the same module. Variable names share the unified namespace with rules, workflows, and functions — duplicates are `E_PARSE`. Not exportable; module-scoped only.
- **Steps:**
  - **ensure** — `ensure ref [args...]` runs a rule (local or `alias.rule_name`); args are passed to the shell. Optionally `ensure ref [args] recover <body>`: bounded retry loop (run rule; on failure run recover body; repeat until the rule passes or max retries, then exit 1). Max retries default to 10; override with `JAIPH_ENSURE_MAX_RETRIES`.
  - **run** — `run ref [args...]` runs a workflow (local or `alias.workflow_name`); args are passed to the workflow.
  - **log** — `log "message"` displays a message in the progress tree at the current depth and writes to **stdout**. Double-quoted string; shell variable interpolation works at runtime. No spinner, no timing — a static annotation. Useful for marking workflow phases (e.g. `log "Starting analysis phase"`).
  - **logerr** — `logerr "message"` is identical to `log` except the message is written to **stderr** instead of stdout. In the progress tree, `logerr` lines display with a red `!` instead of the dim `ℹ` used by `log`. Useful for error messages or warnings.
  - **Send** — `channel <- echo "data"` sends content to a named inbox channel; the channel identifier is always on the left side of `<-`. Standalone `channel <-` forwards `$1`. Combining capture and send (`name = channel <- cmd`) is `E_PARSE`. See [Inbox & Dispatch](inbox.md).
  - **Route** — `channel -> workflow` (inside an orchestrator workflow) registers a static routing rule: when a message arrives on `channel`, call `workflow` with the message as `$1`. Multiple targets are comma-separated (`ch -> wf1, wf2`). Routes are declarations, not executable steps. The dispatch queue drains after the orchestrator completes; max depth 100 guards against infinite loops. See [Inbox & Dispatch](inbox.md).
  - **Assignment capture** — `name = ensure ref`, `name = run ref`, or `name = <shell_command>` captures that step's stdout into `name`. Exit semantics unchanged: failure fails the step unless you add `|| true`. Only stdout is captured; stderr not unless redirected (e.g. `2>&1`). See [Grammar](grammar.md).
- **Prompts:** `prompt "..."` — quoted string, may be multiline. Variable expansion (e.g. `$1`) is allowed; backticks and `$(...)` are not. Capture: `name = prompt "..."`. Optional **typed prompt:** `name = prompt "..." returns '{ field: type, ... }'` (flat schema; types `string`, `number`, `boolean`) validates the agent's JSON and sets `$name` and `$name_field` per field. See [Grammar](grammar.md).
- **Conditionals:** Allowed forms:
  - `if ensure some_rule [args]; then ... [else ...] fi` — runs the then-branch when the rule **succeeds**; optional else-branch for failure.
  - `if ! ensure some_rule [args]; then ... [else ...] fi` — runs the then-branch when the rule **fails**; optional else-branch for success.
  - `if ! <shell_condition>; then` (e.g. `test -f .file`) followed by `run` steps or shell commands, then `fi`.
  - Short-circuit brace groups in rule/workflow/function bodies: `cmd || { echo "failed"; exit 1; }` (single-line) or `cmd || { ... }` (multi-line). These compile as one shell command. Then- and else-branches of `if [!] ensure ...; then` may mix run, prompt, and shell (including capture forms); ensure/ensure_capture are not allowed in either branch.

Rules:

- `jaiph run <file.jh>` executes `workflow default` in that file. The file must define a `workflow default` (the runtime checks for it and exits with an error if missing).
- Inside a workflow, `run` targets a workflow (local or `alias.workflow_name`), not a raw shell command.
- Inside a rule, only `ensure` and shell commands are allowed; `run` is forbidden. Use `ensure` to call another rule, or move the call to a workflow.
- Rules run in a read-only wrapper; put mutating operations in workflows.
- **Unified namespace:** Rules, workflows, functions, and top-level locals share a single name space per module. Using the same name for two items (e.g. a rule `foo` and a local `foo`) is a compile error (`E_PARSE`).
- **Calling conventions (compiler-enforced):** `ensure` must target a rule — using it on a workflow or function is `E_VALIDATE`. `run` must target a workflow — using it on a rule or function is `E_VALIDATE`. Functions are called directly by name in shell context.

## Authoring Heuristics

- Keep workflows short and explicit.
- Put expensive checks after fast checks.
- Include clear prompts with concrete acceptance criteria.
- Reuse rules via `ensure`; reuse workflows via `run`.
- Use only syntax described in [jaiph.org](https://jaiph.org) and [Grammar](grammar.md). For advanced constructs (e.g. `config` block, `export`, prompt capture), see the grammar. For testing workflows, see [Testing](testing.md) (`expectContain`, `expectNotContain`, `expectEqual`, mocks).

## Suggested Starter Layout

- `.jaiph/bootstrap.jh` — Created by `jaiph init`; contains a single prompt that points the agent at this guide.
- `.jaiph/readiness.jh` — Preflight: rules and `workflow default` that runs readiness checks.
- `.jaiph/ba_review.jh` — (Optional) BA review: reads the first task from a queue file, sends it to an agent for review, and marks it `dev-ready` or exits with questions. Useful when tasks are queued in a Markdown file (e.g. `QUEUE.md`).
- `.jaiph/verification.jh` — Verification: rules and `workflow default` for lint/test/build.
- `.jaiph/main.jh` — Imports readiness, review, and verification; defines implementation workflow and `workflow default` that orchestrates preflight → review → implementation → verification.

Optional: `.jaiph/implementation.jh` if you prefer the implementation workflow in a separate module; otherwise keep it in `main.jh`.

## Final Output Requirement

After scaffolding workflows, print the exact commands the developer should run. The primary command runs the default entrypoint (preflight + implementation + verification). Point users to the canonical skill URL for agents: <https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md>.

```bash
jaiph run .jaiph/main.jh "implement feature X"
# Or run verification only:
jaiph run .jaiph/verification.jh
```

Arguments after the file path are passed to `workflow default` as positional parameters (`$1`, `$2`, ...).

## Minimal Sample (Agent Reference)

Use this as a shape to adapt. Paths and prompts should match the target repository. All three files live under `.jaiph/`. Imports in `main.jh` are relative to that file (e.g. `"readiness.jh"` resolves to `.jaiph/readiness.jh`). When you run `jaiph run .jaiph/main.jh "implement feature X"`, the default workflow receives `"implement feature X"` as `$1`; `run implement` forwards positional args, so the implement workflow's prompt sees `$1` as well.

**File: .jaiph/readiness.jh**

```jaiph
rule git_clean {
  test -z "$(git status --porcelain)"
}

rule required_tools {
  command -v git
  command -v node
  command -v npm
}

workflow default {
  ensure required_tools
  ensure git_clean
}
```

**File: .jaiph/verification.jh**

```jaiph
rule unit_tests_pass {
  npm test
}

rule build_passes {
  npm run build
}

workflow default {
  ensure unit_tests_pass
  ensure build_passes
}
```

**File: .jaiph/main.jh**

```jaiph
import "readiness.jh" as readiness
import "verification.jh" as verification

workflow implement {
  prompt "
    Implement the requested feature or fix with minimal, reviewable changes.
    Keep edits consistent with existing architecture and style.
    Add or update tests for behavior changes.

    User asks for: $1
  "
}

workflow default {
  run readiness.default
  run implement
  run verification.default
}
```
