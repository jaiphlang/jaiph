# Jaiph Bootstrap Skill (for Agents)

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Testing](testing.md) · [Agent Skill](https://jaiph.org/jaiph-skill.md)

---

## Overview

This document is a **skill guide** for AI agents that generate or modify Jaiph workflows in a repository. After `jaiph init`, the repo contains `.jaiph/bootstrap.jh` and a copy of this file (`.jaiph/jaiph-skill.md`). The bootstrap workflow prompts the agent to read this guide and scaffold a minimal set of `.jaiph/*.jh` workflows for safe feature delivery.

**Goals:** Preflight checks (rules + ensure), an implementation workflow, a verification workflow, and a single entrypoint (`workflow default`) that orchestrates them. Prefer composable modules over one large file.

**Audience:** Agents that produce or edit `.jh` files. For full language semantics and validation rules, the Jaiph source code and [Grammar](grammar.md) are the source of truth.

---

## When to Use This Guide

Use this guide when generating or updating `.jaiph/*.jh` workflows for a repository after `jaiph init`.

## Source of Truth

The Jaiph codebase is authoritative. When this document conflicts with implementation or grammar, follow the codebase.

- **Runtime and build:** `src/parser.ts`, `src/parse/*.ts`, `src/transpiler.ts`, `src/transpile/*.ts`, `src/cli.ts` (and `src/cli/`).
- **Language and grammar:** [Grammar](grammar.md). Covers EBNF, validation (E_PARSE, E_VALIDATE, E_IMPORT_NOT_FOUND), and transpilation.
- **Docs:** [jaiph.org](https://jaiph.org).

Ignore any legacy Markdown that contradicts these.

## What to Produce

A **minimal workflow set** under `.jaiph/` that supports safe feature delivery:

1. **Preflight** — Rules and `ensure` for repo state and required tools (e.g. clean git, required binaries). Expose a small workflow (e.g. `workflow default` in `readiness.jh`) that runs these checks.
2. **Implementation** — A workflow that drives coding changes (typically via `prompt`), e.g. `workflow implement` in `main.jh`.
3. **Verification** — Rules and a workflow for lint/test/build (e.g. `verification.jh` with `workflow default`).
4. **Entrypoint** — A single `workflow default` (e.g. in `.jaiph/main.jh`) that runs: preflight → implementation → verification. This is what `jaiph run .jaiph/main.jh "..."` executes.

Prefer composable modules over one monolithic file.

## Language Rules You Must Respect

- **Imports:** `import "path.jh" as alias` or `import "path.jph" as alias`. Path is relative to the importing file; extensions `.jh` and `.jph` are supported (`.jh` preferred).
- **Definitions:** `rule name { ... }`, `workflow name { ... }`, `function name() { ... }` (parentheses optional).
- **Steps:** `ensure ref [args...]`, optionally `ensure ref [args] recover <body>`. For ensure, `ref` is a rule name or `alias.rule_name`; args are passed to the shell. With `recover`, the step is a **bounded retry loop**: run the rule; on failure run the recover body (single statement or `recover { stmt; stmt; ... }`); repeat until the rule passes or max retries (default 10, override via `JAIPH_ENSURE_MAX_RETRIES`) is exceeded, then exit 1. `run ref [args...]` runs a workflow; args are passed to the workflow.
- **Prompts:** `prompt "..."` — quoted string, may be multiline. Variable expansion (e.g. `$1`) is allowed; backticks and `$(...)` are not. See [Grammar](grammar.md) for the `name = prompt "..."` capture form.
- **Conditionals:** Allowed forms:
  - `if ! ensure some_rule; then` followed by `run some_workflow` or shell commands, then `fi`.
  - `if ! <shell_condition>; then` (e.g. `test -f .file`) followed by `run` steps or shell commands, then `fi`.

Rules:

- `jaiph run <file.jh>` executes `workflow default` in that file. The file must define a `workflow default`.
- Inside a workflow, `run` targets a workflow (local or `alias.workflow_name`), not a raw shell command.
- Inside a rule, only `ensure` and shell commands are allowed; `run` is forbidden. Use `ensure` to call another rule, or move the call to a workflow.
- Rules run in a read-only wrapper; put mutating operations in workflows.

## Authoring Heuristics

- Keep workflows short and explicit.
- Put expensive checks after fast checks.
- Include clear prompts with concrete acceptance criteria.
- Reuse rules via `ensure`; reuse workflows via `run`.
- Use only syntax described in [jaiph.org](https://jaiph.org) and [Grammar](grammar.md). For advanced constructs (e.g. `config` block, `export`, prompt capture), see the grammar.

## Suggested Starter Layout

- `.jaiph/bootstrap.jh` — Created by `jaiph init`; contains a single prompt that points the agent at this guide.
- `.jaiph/readiness.jh` — Preflight: rules and `workflow default` that runs readiness checks.
- `.jaiph/verification.jh` — Verification: rules and `workflow default` for lint/test/build.
- `.jaiph/main.jh` — Imports readiness and verification; defines implementation workflow and `workflow default` that orchestrates preflight → implementation → verification.

Optional: `.jaiph/implementation.jh` if you prefer the implementation workflow in a separate module; otherwise keep it in `main.jh`.

## Final Output Requirement

After scaffolding workflows, print the exact commands the developer should run. The primary command runs the default entrypoint (preflight + implementation + verification); optionally show running verification alone:

```bash
jaiph run .jaiph/main.jh "implement feature X"
# Or run verification only:
jaiph run .jaiph/verification.jh
```

Arguments after the file path are passed to the workflow as positional parameters (e.g. `$1`, `$2`).

## Minimal Sample (Agent Reference)

Use this as a shape to adapt. Paths and prompts should match the target repository. All three files live under `.jaiph/`; imports in `main.jh` are relative to its directory (same folder = plain filename).

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
