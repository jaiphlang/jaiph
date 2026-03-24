---
title: Agent Skill
permalink: /jaiph-skill
redirect_from:
  - /jaiph-skill.md
---

# Jaiph Bootstrap Skill (for Agents)

## Overview

**Jaiph** is a small language for describing workflows: shell checks, agent prompts, and how they chain together. The compiler turns `.jh` sources into Bash plus a runtime that records steps, routes messages between workflows, and (for rules) applies read-only isolation where the platform supports it.

This page is an **agent skill**: it tells an AI assistant how to **author** those workflows correctly and what a healthy project layout looks like. It is not a full language specification — use [Grammar](grammar.md) for syntax and validation details, [Configuration](configuration.md) for `config` keys, [Inbox & Dispatch](inbox.md) for channels, and [Sandboxing](sandboxing.md) for how rules are isolated.

**After `jaiph init`**, a repository gets `.jaiph/bootstrap.jh` (a prompt that tells the agent to read `.jaiph/jaiph-skill.md`) and a copy of this file. The expected outcome is a **minimal workflow set** for safe feature work: preflight checks, an implementation workflow, verification, and a `workflow default` entrypoint that wires them together (with an optional human-or-agent “review” step when you use a task queue).

**Concepts:**

- **Rules** — Named blocks of shell commands used as checks or actions. Only `ensure` and shell are allowed inside a rule. Rules run in a read-only wrapper (Linux: mount namespace when `unshare`/`sudo` allow; macOS or without those: child-shell isolation only — see [Sandboxing](sandboxing.md)).
- **Workflows** — Named sequences of steps: `ensure` (call a rule), `run` (call a workflow or function), `prompt` (agent), `log`/`logerr` (messages), `send`/`route` (inbox), or shell. Workflows orchestrate execution.
- **Functions** — Named shell function blocks (shell-only body: no `run`, `ensure`, routes, or nested declarations). From a **workflow**, call with **`run fn`** — same managed logging and explicit `return` capture as `run` for workflows. Cannot be used with `ensure`, are not valid inbox route targets, cannot be exported, and must not be invoked through `$(...)` or as a bare shell step.
- **Channels** — Top-level `channel name` declarations name inbox endpoints for `send` and `route`. Channel names participate in the same per-module namespace as rules, workflows, functions, and `local` variables.
- **ensure** — Runs a rule; succeeds if exit code is 0. Optional `recover` turns it into a bounded retry loop.
- **run** — Invokes a workflow or function (local or `alias.name`). Must not target a rule or arbitrary shell command. **Does not forward positional args implicitly** — pass them explicitly (e.g. `run wf "$1"`, `run helper_fn "$1"`).
- **prompt** — Sends a string to the configured agent. Optional `returns` schema validates one line of JSON from the agent.

**Audience:** Agents that produce or edit `.jh` / `.jph` files (prefer `.jh`; `.jph` is still accepted but deprecated for new work).

---

## Safe delivery loop (any repository)

Use this loop whenever you add or change Jaiph workflows so failures surface before work is handed back:

1. **Preflight** — Run the project’s readiness checks if they exist (often `jaiph run .jaiph/readiness.jh` or a named preflight workflow). Compile-check sources with `jaiph build` on the relevant path (for example `jaiph build .jaiph`). When the repo ships native tests (`*.test.jh`), run `jaiph test` before large edits when practical.
2. **Implement** — Edit `.jh` modules using only constructs described in [Grammar](grammar.md); keep managed-call rules (`ensure` for rules, `run` for workflows and functions; no Jaiph symbols in `$(...)` or as bare shell command words).
3. **Verify** — Run `jaiph test` (whole workspace or a focused path) and any verification workflow the repo defines (commonly `jaiph run .jaiph/verification.jh`). Fix failures you introduce.
4. **Inspect (optional)** — Use `jaiph report --workspace .` to browse `.jaiph/runs` when you need the reporting UI or raw step logs instead of only the terminal tree.

**CLI synopsis:** `jaiph --help` prints the supported commands (in the Jaiph repo this text is maintained in `src/cli/shared/usage.ts`). Full flags and environment variables: [CLI Reference](cli.md).

---

## When to Use This Guide

Use this guide when generating or updating `.jaiph/*.jh` workflows for a repository after `jaiph init`.

## Source of Truth

When this skill conflicts with the compiler or runtime, follow the implementation. For language rules and validation codes, [Grammar](grammar.md) is the detailed reference. Published docs: [jaiph.org](https://jaiph.org).

`jaiph init` copies this skill into `.jaiph/jaiph-skill.md` only when the installed Jaiph bundle includes a skill file. If sync is skipped, point `JAIPH_SKILL_PATH` at this file (or `docs/jaiph-skill.md` in a checkout) and run `jaiph init` again — see [CLI Reference](cli.md).

Ignore any legacy Markdown that contradicts the above.

## What to Produce

A **minimal workflow set** under `.jaiph/` that matches the delivery loop above:

1. **Preflight** — Rules and `ensure` for repo state and required tools (e.g. clean git, required binaries). Expose a small workflow (e.g. `workflow default` in `readiness.jh`) that runs these checks.
2. **Review (optional)** — A workflow that reviews queued tasks before development starts (any filename, e.g. `ba_review.jh`). An agent prompt evaluates the next task for clarity, consistency, conflicts, and feasibility, then either marks it as ready or exits with questions. The implementation workflow gates on this marker so unreviewed tasks cannot proceed. This repository’s `.jaiph/architect_review.jh` is one concrete example; it uses `.jaiph/QUEUE.md` as the task queue.
3. **Implementation** — A workflow that drives coding changes (typically via `prompt`), e.g. `workflow implement` in `main.jh`. When using a task queue, the implementation workflow should check that the first task is marked as ready (e.g. via a `<!-- dev-ready -->` marker) before proceeding.
4. **Verification** — Rules and a `workflow default` for lint/test/build (e.g. `verification.jh`). Complement this with repo-native `*.test.jh` suites run by `jaiph test` where appropriate.
5. **Entrypoint** — A single `workflow default` (e.g. in `.jaiph/main.jh`) that runs: preflight → (optional) review → implementation → verification. This is what `jaiph run .jaiph/main.jh "..."` executes.

Prefer composable modules over one large file.

## Language Rules You Must Respect

- **Imports:** `import "path.jh" as alias` or `import 'path.jh' as alias`. Path may be single- or double-quoted. Path is relative to the importing file. If the path has no extension, the compiler resolves `.jh` first, then `.jph`. Prefer `.jh` for new files (`.jph` is deprecated).
- **Definitions:** `channel name` (inbox endpoint); `rule name { ... }`, `workflow name { ... }`, `function name() { ... }` (parentheses optional). Optional `export` before `rule` or `workflow` marks it as public (see [Grammar](grammar.md)). Optional `config { ... }` at the top of a file sets agent, run, and runtime options. An optional `config { ... }` block can also appear inside a `workflow { ... }` body (before any steps) to override module-level settings for that workflow only — only `agent.*` and `run.*` keys are allowed; `runtime.*` yields `E_PARSE` (see [Configuration](configuration.md#workflow-level-config)). Config values can be quoted strings, booleans (`true`/`false`), bare integers, or bracket-delimited arrays of strings (see [Grammar](grammar.md) and [Configuration](configuration.md)).
- **Top-level locals:** `local name = value` declares a module-scoped variable. Values may be double-quoted strings (may span multiple lines), single-quoted strings (single-line), or bare values (rest of line). The variable is accessible as `$name` inside all rules, functions, and workflows in the same module. Names share the unified namespace with channels, rules, workflows, and functions — duplicates are `E_PARSE`. Not exportable; module-scoped only.
- **Steps:**
  - **ensure** — `ensure ref [args...]` runs a rule (local or `alias.rule_name`); args are passed to the shell. Optionally `ensure ref [args] recover <body>`: bounded retry loop (run rule; on failure run recover body; repeat until the rule passes or max retries, then exit 1). Max retries default to 10; override with `JAIPH_ENSURE_MAX_RETRIES`. Inside a recover body, `$1` is the failed rule's explicit `return` value (stdout is in artifacts), or empty if the rule did not set a value return.
  - **run** — `run ref [args...]` runs a workflow or function (local or `alias.name`); explicit args are passed through. **`run` does not forward `$@` by default** — pass positional args explicitly (e.g. `run wf "$1"`, `run util_fn "$2"`).
  - **log** — `log "message"` displays a message in the progress tree at the current depth and writes to **stdout**. Double-quoted string (single-line only); shell variable interpolation works at runtime. No spinner, no timing — a static annotation. Useful for marking workflow phases (e.g. `log "Starting analysis phase"`).
  - **logerr** — `logerr "message"` is identical to `log` except the message is written to **stderr** instead of stdout. In the progress tree, `logerr` lines display with a red `!` instead of the dim `ℹ` used by `log`. Same single-line quoting rules as `log`. Useful for error messages or warnings.
  - **Send** — `channel <- echo "data"` sends content to a named inbox channel; the channel identifier is always on the left side of `<-`. Standalone `channel <-` forwards `$1`. Combining capture and send (`name = channel <- cmd`) is `E_PARSE`. See [Inbox & Dispatch](inbox.md).
  - **Route** — `channel -> workflow_ref` (inside an orchestrator workflow) registers a static routing rule: when a message arrives on `channel`, call that **workflow** (local or `alias.workflow`) with `$1=message`, `$2=channel`, `$3=sender`. Functions and rules are not valid route targets. Multiple targets are comma-separated (`ch -> wf1, wf2`). Routes are declarations, not executable steps. The dispatch queue drains after the orchestrator completes; by default at most 100 dispatch iterations run per drain (`JAIPH_INBOX_MAX_DISPATCH_DEPTH` overrides). See [Inbox & Dispatch](inbox.md).
  - **Assignment capture** — `name = ensure ref` and `name = run ref` capture the callee's **explicit `return` value** only (stdout goes to artifacts). `name = <shell_command>` captures **full stdout** (raw bash). `name = prompt "..."` captures the agent's final answer. Do not put Jaiph symbols inside `$(...)` (e.g. `name="$(wf ...)"`, `name="$(fn ...)"`, `name="$(rule ...)"`) or call functions as bare shell lines — use `ensure` / `run`. See [Grammar](grammar.md#step-output-contract).
- **Prompts:** `prompt "..."` — quoted string, may be multiline. Variable expansion (e.g. `$1`) is allowed; backticks and `$(...)` are not. Capture: `name = prompt "..."`. Optional **typed prompt:** `name = prompt "..." returns '{ field: type, ... }'` (flat schema; types `string`, `number`, `boolean`) validates the agent's JSON and sets `$name` and `$name_field` per field. See [Grammar](grammar.md).
- **Conditionals:** Allowed forms:
  - `if ensure some_rule [args]; then ... [else ...] fi` — runs the then-branch when the rule **succeeds**; optional else-branch for failure.
  - `if ! ensure some_rule [args]; then ... [else ...] fi` — runs the then-branch when the rule **fails**; optional else-branch for success.
  - `if run some_ref [args]; then ... [else ...] fi` — runs the then-branch when the workflow or function **succeeds** (exit 0); optional else-branch for failure. Works with local and imported references.
  - `if ! run some_ref [args]; then ... [else ...] fi` — runs the then-branch when the workflow or function **fails** (non-zero exit); optional else-branch for success.
  - `if ! <shell_condition>; then` (e.g. `test -f .file`) followed by `run` steps or shell commands, then `fi`. Only the negated form is supported for shell conditions — positive `if <cmd>; then` is not parsed as a Jaiph `if` step (it falls through as raw shell). Else-branches are not supported for shell conditions.
  - Short-circuit brace groups in rule/workflow/function bodies: `cmd || { echo "failed"; exit 1; }` (single-line) or `cmd || { ... }` (multi-line). These compile as one shell command. Then- and else-branches of `if [!] ensure/run ...; then` may mix run, prompt, and shell (including capture forms); ensure/ensure_capture are not allowed in if-ensure branches.

Rules:

- `jaiph run <file.jh>` executes `workflow default` in that file. The file must define a `workflow default` (the runtime checks for it and exits with an error if missing).
- Inside a workflow, `run` targets a workflow or function (local or `alias.name`), not a raw shell command. Call functions with `run`, never `fn args` or `$(fn ...)`.
- Inside a rule, only `ensure` and shell commands are allowed; `run` is forbidden. Use `ensure` to call another rule, or move the call to a workflow.
- Rules run in a read-only wrapper (Linux with `unshare` and passwordless `sudo`: filesystem mounted read-only; macOS or without those: child-shell isolation only — no filesystem lock); put mutating operations in workflows. Details: [Sandboxing](sandboxing.md).
- **Parallel shell steps:** Shell steps support `&` (background) and `wait` (synchronise). Background a command with `&` and `wait` before the step ends — orphaned jobs may lose output. Bare `wait` returns 0 regardless of child exit; for deterministic failure detection, capture PIDs and `wait $pid`. Do not call Jaiph internal functions (`jaiph::send`, `jaiph::log`, `ensure`, `run`) from background subprocesses.
- **Unified namespace:** Channels, rules, workflows, functions, and top-level locals share a single namespace per module. Using the same name for two items (e.g. a channel `foo` and a local `foo`) is a compile error (`E_PARSE`).
- **Calling conventions (compiler-enforced):** `ensure` must target a rule — using it on a workflow or function is `E_VALIDATE`. `run` must target a workflow or function — using it on a rule is `E_VALIDATE`. Jaiph symbols must not appear inside `$(...)`, and must not be the **first command word** of any workflow shell line — that check runs on **every** such line, even when the line also contains `$(...)` (`E_VALIDATE` with hints for the required `ensure` / `run` form). Function bodies cannot contain `run`, `ensure`, `config`, nested declarations, or routes.

## Authoring Heuristics

- Keep workflows short and explicit.
- Put expensive checks after fast checks.
- Include clear prompts with concrete acceptance criteria.
- Reuse rules via `ensure`; reuse workflows and functions via `run`.
- Use only syntax described in [jaiph.org](https://jaiph.org) and [Grammar](grammar.md). For advanced constructs (e.g. `config` block, `export`, prompt capture), see the grammar. For testing workflows, see [Testing](testing.md) (`expectContain`, `expectNotContain`, `expectEqual`, mocks).

## Suggested Starter Layout

- `.jaiph/bootstrap.jh` — Created by `jaiph init`; contains a single prompt that points the agent at this guide.
- `.jaiph/readiness.jh` — Preflight: rules and `workflow default` that runs readiness checks.
- `.jaiph/ba_review.jh` (or any name you choose) — (Optional) Pre-implementation review: reads tasks from a queue file, sends one to an agent for review, and marks it dev-ready or exits with questions. This repository uses `.jaiph/architect_review.jh` with `.jaiph/QUEUE.md`.
- `.jaiph/verification.jh` — Verification: rules and `workflow default` for lint/test/build.
- `.jaiph/main.jh` — Imports readiness, optional review, and verification; defines implementation workflow and `workflow default` that orchestrates preflight → (optional) review → implementation → verification.

Optional: `.jaiph/implementation.jh` if you prefer the implementation workflow in a separate module; otherwise keep it in `main.jh`.

## Final Output Requirement

After scaffolding workflows, print the exact commands the developer should run. The primary command runs the default entrypoint (typically preflight, then implementation, then verification — plus any optional review step you added). Point users to the canonical skill URL for agents: <https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md>.

Include a compile check and, when the repository has native tests (`*.test.jh` / `*.test.jph`), `jaiph test` (see [Testing](testing.md)); skip `jaiph test` if there are no test files, since discovery mode exits with an error when nothing matches.

```bash
jaiph build .jaiph
jaiph test
jaiph run .jaiph/main.jh "implement feature X"
# Or run verification only:
jaiph run .jaiph/verification.jh
```

Arguments after the file path are passed to `workflow default` as positional parameters (`$1`, `$2`, ...).

## Minimal Sample (Agent Reference)

Use this as a shape to adapt. Paths and prompts should match the target repository. All three files live under `.jaiph/`. Imports in `main.jh` are relative to that file (e.g. `"readiness.jh"` resolves to `.jaiph/readiness.jh`). When you run `jaiph run .jaiph/main.jh "implement feature X"`, the default workflow receives `"implement feature X"` as `$1`. Note that `run` does not forward args implicitly, so the default workflow passes `"$1"` explicitly to `run implement "$1"` so the implement workflow's prompt can use `$1`.

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
  run implement "$1"
  run verification.default
}
```
