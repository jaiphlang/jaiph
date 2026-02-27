# Jaiph Bootstrap Skill (for Agents)

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Agent Skill](https://jaiph.org/jaiph-skill.md)

---

Use this guide when generating `.jaiph/*.jh` workflows for a repository after `jaiph init`.

## Source of Truth

1. Runtime behavior in Jaiph codebase:
   - https://github.com/jaiphlang/jaiph/blob/main/src/parser.ts
   - https://github.com/jaiphlang/jaiph/blob/main/src/transpiler.ts
   - https://github.com/jaiphlang/jaiph/blob/main/src/cli.ts
2. Language documentation:
   - https://jaiph.org/
   - https://github.com/jaiphlang/jaiph/blob/main/docs/index.html
3. Grammar details:
   - https://github.com/jaiphlang/jaiph/blob/main/docs/grammar.md

If a legacy Markdown file contradicts these sources, ignore the legacy file.

## What to Produce

Create a minimal workflow set under `.jaiph/` that supports safe feature delivery:

- Preflight checks (`rule` + `ensure`) for repo state and required tools.
- Implementation workflow for coding changes.
- Verification workflow for lint/test/build.
- A `workflow default` entrypoint that orchestrates the above.

Prefer composable modules over one monolithic file.

## Language Rules You Must Respect

- `import "path.jh" as alias` or `import "path.jph" as alias`
- `rule name { ... }`
- `workflow name { ... }`
- `function name() { ... }`
- `ensure ref [args...]`
- `run ref`
- `prompt "..."` (quoted string, can be multiline)
- Allowed conditional form:
  - `if ! ensure some_rule; then`
  - `  run some_workflow`
  - `fi`

Notes:

- `jaiph run` executes `workflow default`.
- `run` in a workflow targets workflows, not raw shell commands.
- `run` is not allowed inside a `rule`; use `ensure` to call another rule or move the call to a workflow.
- Rules are executed via Jaiph read-only wrapper; keep mutating operations in workflows.

## Authoring Heuristics

- Keep workflows short and explicit.
- Put expensive checks after fast checks.
- Include clear prompts with concrete acceptance criteria.
- Reuse rules via `ensure`; reuse workflows via `run`.
- Avoid syntax not present in:
  - https://jaiph.org/
  - https://github.com/jaiphlang/jaiph/blob/main/docs/grammar.md

## Suggested Starter Layout

- `.jaiph/bootstrap.jh` (created by init; bootstrap prompt only)
- `.jaiph/readiness.jh`
- `.jaiph/implementation.jh`
- `.jaiph/verification.jh`
- `.jaiph/main.jh` (contains `workflow default`)

## Final Output Requirement

After scaffolding workflows, print exact commands the developer should run, for example:

```bash
jaiph run .jaiph/main.jh "implement feature X"
jaiph run .jaiph/verification.jh
```

## Minimal Sample (Agent Reference)

Use this as a shape/template. Adapt commands and prompts to the target repository.

`/.jaiph/readiness.jh`

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

`/.jaiph/verification.jh`

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

`/.jaiph/main.jh`

```jaiph
import ".jaiph/readiness.jh" as readiness
import ".jaiph/verification.jh" as verification

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
