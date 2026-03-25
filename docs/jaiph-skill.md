---
title: Agent Skill
permalink: /jaiph-skill
redirect_from:
  - /jaiph-skill.md
---

# Jaiph Bootstrap Skill (for Agents)

## Overview

**Jaiph** is a small language for describing workflows: **orchestration steps** (rules, prompts, managed calls) and **bash in `script` blocks**, compiled to Bash plus a runtime that records steps, routes messages between workflows, and (for rules) applies read-only isolation where the platform supports it.

This page is an **agent skill**: it tells an AI assistant how to **author** those workflows correctly and what a healthy project layout looks like. It is not a full language specification — use [Grammar](grammar.md) for syntax and validation details, [Configuration](configuration.md) for `config` keys, [Inbox & Dispatch](inbox.md) for channels, and [Sandboxing](sandboxing.md) for how rules are isolated.

**After `jaiph init`**, a repository gets `.jaiph/bootstrap.jh` (a prompt that tells the agent to read `.jaiph/jaiph-skill.md`) and a copy of this file. The expected outcome is a **minimal workflow set** for safe feature work: preflight checks, an implementation workflow, verification, and a `workflow default` entrypoint that wires them together (with an optional human-or-agent “review” step when you use a task queue).

**Concepts:**

- **Rules** — Structured checks: `ensure` (other **rules** only), `run` (**scripts** only — not workflows), `const`, brace `if`, `fail`, `log`/`logerr`, `return "…"`. No raw shell lines, `prompt`, inbox send/route, `wait`, or `ensure … recover`. Rules run in a read-only wrapper (Linux: mount namespace when `unshare`/`sudo` allow; macOS or without those: child-shell isolation only — see [Sandboxing](sandboxing.md)).
- **Workflows** — Named sequences of **Jaiph-only** steps: `ensure`, `run`, `prompt`, `const`, `fail`, `return`, `log`/`logerr`, `send`/`route`, brace `if` only, `wait`, async `run … &`. Unrecognized lines are errors — put bash in **`script`** blocks and call with `run`.
- **Scripts** — Top-level **`script`** blocks of plain bash (no `run`, `ensure`, routes, nested declarations, or Jaiph keywords `fail` / `const` / `log` / `logerr`; no Jaiph-style `return "…"` — use `return N` / `return $?` and **stdout** for string data to callers). From a **workflow** or **rule**, call with **`run fn`**. Cannot be used with `ensure`, are not valid inbox route targets, cannot be exported, and must not be invoked through `$(...)` or as a bare shell step. **Polyglot scripts:** if the first non-empty body line starts with `#!` (e.g. `#!/usr/bin/env node`), it becomes the script's shebang and Jaiph keyword validation is skipped. Without a shebang, `#!/usr/bin/env bash` is used. Scripts are emitted as separate executable files under `build/scripts/`.
- **Channels** — Top-level `channel name` declarations name inbox endpoints for `send` and `route`. Channel names participate in the same per-module namespace as rules, workflows, scripts, and module-scoped `local` / `const` variables.
- **ensure** — Runs a rule; succeeds if exit code is 0. Optional `recover` turns it into a bounded retry loop.
- **run** — Invokes a workflow or script (local or `alias.name`). Must not target a rule or arbitrary shell command. **Does not forward positional args implicitly** — pass them explicitly (e.g. `run wf "$1"`, `run helper_fn "$1"`).
- **prompt** — Sends a string to the configured agent. Optional `returns` schema validates one line of JSON from the agent.

**Audience:** Agents that produce or edit `.jh` / `.jph` files (prefer `.jh`; `.jph` is still accepted but deprecated for new work).

---

## Safe delivery loop (any repository)

Use this loop whenever you add or change Jaiph workflows so failures surface before work is handed back:

1. **Preflight** — Run the project’s readiness checks if they exist (often `jaiph run .jaiph/readiness.jh` or a named preflight workflow). Compile-check sources with `jaiph build` on the relevant path (for example `jaiph build .jaiph`). When the repo ships native tests (`*.test.jh`), run `jaiph test` before large edits when practical.
2. **Implement** — Edit `.jh` modules using only constructs described in [Grammar](grammar.md); keep managed-call rules (`ensure` for rules, `run` for workflows and scripts); keep bash inside **`script`** bodies only (no raw shell in workflow/rule bodies).
3. **Verify** — Run `jaiph test` (whole workspace or a focused path) and any verification workflow the repo defines (commonly `jaiph run .jaiph/verification.jh`). Fix failures you introduce.
4. **Inspect (optional)** — Use `jaiph report --workspace .` to browse `.jaiph/runs` when you need the reporting UI or raw step logs instead of only the terminal tree.

**CLI synopsis:** `jaiph --help` prints the supported commands (in the Jaiph repo this text is maintained in `src/cli/shared/usage.ts`). Full flags and environment variables: [CLI Reference](cli.md).

---

## When to Use This Guide

Use this guide when generating or updating `.jaiph/*.jh` workflows for a repository after `jaiph init`.

## Source of Truth

When this skill conflicts with the compiler or runtime, follow the implementation. For language rules and validation codes, [Grammar](grammar.md) is the detailed reference. Published docs: [jaiph.org](https://jaiph.org).

`jaiph init` copies this skill into `.jaiph/jaiph-skill.md` only when the installed Jaiph bundle includes a skill file. If sync is skipped, point `JAIPH_SKILL_PATH` at this file (or `docs/jaiph-skill.md` in a checkout) and run `jaiph init` again — see [CLI Reference](cli.md).

Ignore any outdated Markdown that contradicts the above.

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
- **Definitions:** `channel name` (inbox endpoint); `rule name { ... }`, `workflow name { ... }`, `script name() { ... }` (parentheses optional). Optional `export` before `rule` or `workflow` marks it as public (see [Grammar](grammar.md)). Optional `config { ... }` at the top of a file sets agent, run, and runtime options. An optional `config { ... }` block can also appear inside a `workflow { ... }` body (before any steps) to override module-level settings for that workflow only — only `agent.*` and `run.*` keys are allowed; `runtime.*` yields `E_PARSE` (see [Configuration](configuration.md#workflow-level-config)). Config values can be quoted strings, booleans (`true`/`false`), bare integers, or bracket-delimited arrays of strings (see [Grammar](grammar.md) and [Configuration](configuration.md)).
- **Module-scoped variables:** `local name = value` or `const name = value` (same value forms). Prefer **`const`** for new files. Accessible as `$name` inside all rules, scripts, and workflows in the same module. Names share the unified namespace with channels, rules, workflows, and scripts — duplicates are `E_PARSE`. Not exportable; module-scoped only.
- **Steps:**
  - **ensure** — `ensure ref [args...]` runs a rule (local or `alias.rule_name`); args are passed to the shell. Optionally `ensure ref [args] recover <body>`: bounded retry loop (run rule; on failure run recover body; repeat until the rule passes or max retries, then exit 1). Max retries default to 10; override with `JAIPH_ENSURE_MAX_RETRIES`. Inside a recover body, **`$1`** comes from the ensure capture channel (`JAIPH_RETURN_VALUE_FILE`) for the failed attempt. In script-driven failures, this is the failed attempt's script stdout captured for ensure (including nested script output; stderr only when merged into stdout in the script). Full output still lives in step **`.out` / `.err`** artifacts. If **`$1`** is empty for your rule, persist diagnostics before prompting or assert non-empty.
  - **run** — `run ref [args...]` runs a workflow or script (local or `alias.name`); explicit args are passed through. **`run` does not forward `$@` by default** — pass positional args explicitly (e.g. `run wf "$1"`, `run util_fn "$2"`).
  - **log** — `log "message"` displays a message in the progress tree at the current depth and writes to **stdout**. Double-quoted string; shell variable interpolation works at runtime. Terminal and tree text use **`echo -e`**: backslash escapes in the string (e.g. `\n`, `\t`) are interpreted on output. **`LOG`** events / `run_summary.jsonl` store the **raw** message string (JSON-escaped only), not a second expansion. No spinner, no timing — a static annotation. Useful for marking workflow phases (e.g. `log "Starting analysis phase"`).
  - **logerr** — `logerr "message"` is identical to `log` except the message is written to **stderr** instead of stdout. In the progress tree, `logerr` lines display with a red `!` instead of the dim `ℹ` used by `log`. Same quoting and escape behavior as `log`. Useful for error messages or warnings.
  - **Send** — After `<-`, use a **double-quoted literal**, **`$var` / `${…}`**, **`run ref [args]`**, or standalone `<-` (forward `$1`). Raw shell on the RHS is rejected — use `const x = run helper` then `channel <- "$x"`, or `channel <- run fmt_fn`. Combining capture and send (`name = channel <- …`) is `E_PARSE`. See [Inbox & Dispatch](inbox.md).
  - **Route** — `channel -> workflow_ref` (inside an orchestrator workflow) registers a static routing rule: when a message arrives on `channel`, call that **workflow** (local or `alias.workflow`) with `$1=message`, `$2=channel`, `$3=sender`. Scripts and rules are not valid route targets. Multiple targets are comma-separated (`ch -> wf1, wf2`). Routes are declarations, not executable steps. The dispatch queue drains after the orchestrator completes; by default at most 100 dispatch iterations run per drain (`JAIPH_INBOX_MAX_DISPATCH_DEPTH` overrides). See [Inbox & Dispatch](inbox.md).
  - **Bindings and capture** — `const name = …` or `name = …`. For **`ensure`** / **`run` to a workflow or rule**, capture is the callee’s explicit **`return "…"`**. For **`run` to a script**, capture follows **stdout** from the script body. **`prompt`** capture is the agent answer. **`const`** RHS cannot use `$(...)` or disallowed `${...}` forms — use a **`script`** and `const x = run helper …`. **`const`** must not use a **bare** `ref args…` call shape: use **`const x = run ref args…`** (or **`ensure`** for rules), not **`const x = ref args…`** — the compiler fails with **`E_PARSE`** and suggests the **`run`** form. Do not put Jaiph symbols inside `$(...)` — use `ensure` / `run`. See [Grammar](grammar.md#step-output-contract).
  - **fail** — `fail "reason"` aborts with stderr message and non-zero exit (workflows; fails the rule when used inside a rule).
  - **wait** — After `run ref &`, use a **`wait`** line (Jaiph keyword) to join background managed jobs.
- **Prompts:** `prompt "..."` — quoted string, may be multiline. Variable expansion (e.g. `$1`) is allowed; backticks and `$(...)` are not. Capture: `name = prompt "..."`. Optional **typed prompt:** `name = prompt "..." returns '{ field: type, ... }'` (flat schema; types `string`, `number`, `boolean`) validates the agent's JSON and sets `$name` and `$name_field` per field. See [Grammar](grammar.md).
- **Conditionals:** Only **brace form** in workflows:
  - `if [not] ensure some_rule [args] { ... } [ else if [not] ensure|run ref [args] { ... } ] [ else { ... } ]`
  - `if [not] run some_ref [args] { ... }` with the same `else if` / `else` chaining. Use **`not`** instead of `!` before `ensure`/`run`. Express “shell conditions” with `run` to a **script** that performs the test. Short-circuit brace groups remain valid **inside `script`** bodies: `cmd || { ... }`.

Rules:

- `jaiph run <file.jh>` executes `workflow default` in that file. The file must define a `workflow default` (the runtime checks for it and exits with an error if missing).
- Inside a workflow, `run` targets a workflow or script (local or `alias.name`), not a raw shell command. Call scripts with `run`, never `fn args` or `$(fn ...)`.
- Inside a rule, use `ensure` for **rules** and `run` for **scripts only** — not `prompt`, `send`, `wait`, or `ensure … recover`.
- Rules run in a read-only wrapper (Linux with `unshare` and passwordless `sudo`: filesystem mounted read-only; macOS or without those: child-shell isolation only — no filesystem lock); put mutating operations in workflows. Details: [Sandboxing](sandboxing.md).
- **Parallelism:** `run wf_or_fn &` plus a **`wait`** step for managed async. For concurrent **bash**, use `&` / `wait` inside a **`script`** and call it with `run`. Do not call Jaiph internals from background subprocesses unless you understand `run.inbox_parallel` locking.
- **Shared bash:** Optional `.jaiph/lib/*.sh` — from a **`script`**, `source "$JAIPH_LIB/yourlib.sh"`. Emitted scripts default `JAIPH_LIB` to `${JAIPH_WORKSPACE:-.}/.jaiph/lib` unless set; the runtime also sets `JAIPH_LIB` for script steps. Keep Jaiph orchestration out of library files.
- **Unified namespace:** Channels, rules, workflows, scripts, and module-scoped `local`/`const` share a single namespace per module (`E_PARSE` on collision).
- **Calling conventions (compiler-enforced):** `ensure` must target a rule — using it on a workflow or script is `E_VALIDATE`. `run` in a **workflow** must target a workflow or script; `run` in a **rule** must target a **script** only. Jaiph symbols must not appear inside `$(...)` in bash contexts the compiler still scans (principally **`script`** bodies). Script bodies cannot contain `run`, `ensure`, `config`, nested declarations, routes, or Jaiph `fail` / `const` / `log` / `logerr` / `return "…"`.

## Authoring Heuristics

- Keep workflows short and explicit.
- Put expensive checks after fast checks.
- Include clear prompts with concrete acceptance criteria.
- Reuse rules via `ensure`; reuse workflows and scripts via `run`.
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
script git_is_clean() {
  test -z "$(git status --porcelain)"
}

rule git_clean {
  if not run git_is_clean {
    fail "git working tree is not clean"
  }
}

script require_git_node_npm() {
  command -v git
  command -v node
  command -v npm
}

rule required_tools {
  run require_git_node_npm
}

workflow default {
  ensure required_tools
  ensure git_clean
}
```

**File: .jaiph/verification.jh**

```jaiph
script npm_test_ci() {
  npm test
}

rule unit_tests_pass {
  run npm_test_ci
}

script run_build() {
  npm run build
}

rule build_passes {
  run run_build
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
