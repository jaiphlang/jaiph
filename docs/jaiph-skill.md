---
title: Agent Skill
permalink: /jaiph-skill
diataxis: contributor
redirect_from:
  - /jaiph-skill.md
---

# Jaiph Skill (for Agents)

This page is your checklist for authoring Jaiph programs — it is not a language reference. It names the four constructs, shows one working example, and gives the compile/run loop, then points at the owner page for every rule. Full syntax lives at [https://jaiph.org/reference/grammar](https://jaiph.org/reference/grammar); what each construct means lives at [https://jaiph.org/reference/language](https://jaiph.org/reference/language). When this page and the compiler disagree, the compiler wins.

## The four constructs

| Construct | What it is |
|---|---|
| `def` | A named sequence of steps — the orchestration layer, interpreted in-process |
| `script` | Real shell (or Python, Node, …) — the only place for shell code; called with `run` |
| `prompt` | A task delegated to an AI agent; capture its answer with `const` |
| `channel` | A message queue with declared def listeners, drained after the sending def finishes |

Everything is strings; every step is logged; every run leaves durable artifacts under `.jaiph/runs/`. See [https://jaiph.org/reference/language](https://jaiph.org/reference/language) for what each construct means and [https://jaiph.org/reference/grammar](https://jaiph.org/reference/grammar) for the exact syntax.

## Smallest working example

```jaiph
script list_todos = `grep -rn "TODO" src/ || true`
script worktree_clean = `test -z "$(git status --porcelain)"`

def git_clean() {
  run worktree_clean() catch (err) {
    fail "working tree is not clean"
  }
}

export def main(task) {
  run git_clean()
  const todos = run list_todos()
  prompt """
  Address the following request: ${task}
  Known TODOs in the codebase:
  ${todos}
  """
  log "done"
}
```

`jaiph run` executes `export def main` and binds positional args to its parameters; a library module without `main` still compiles.

## Your authoring loop

1. Write the `.jh` files.
2. Compile: `jaiph compile <file-or-dir>` — validates the whole import closure and reports every error as `path:line:col CODE message`, without running anything.
3. Run: `jaiph run <file.jh> [args…]` for the end-to-end check.

The full command surface and flags live at [https://jaiph.org/reference/cli](https://jaiph.org/reference/cli).

## Authoring mistakes to check for

Each of these is a compile error whose full rule lives on an owner page — read the owner instead of guessing. This skill is published independently of the Jaiph repo; open the `https://jaiph.org/…` URL, do not resolve a relative path.

- Missing `()` on a definition or call site — see [https://jaiph.org/reference/grammar](https://jaiph.org/reference/grammar).
- Capturing without `const`, or rebinding an immutable name — see [https://jaiph.org/reference/language](https://jaiph.org/reference/language).
- `$name`, `$(…)`, or `${var:-default}` in an orchestration string instead of a script body — see [https://jaiph.org/reference/language](https://jaiph.org/reference/language).
- Interpolating a `prompt` capture into a shell line instead of passing it as a script argument — see [https://jaiph.org/reference/language](https://jaiph.org/reference/language).
- Not forwarding a parameter to a called def (`run impl(task)`, not `run impl()`) — see [https://jaiph.org/reference/language](https://jaiph.org/reference/language).
- Requesting a host env key without a `use` clause plus a matching `--env` grant — see [https://jaiph.org/reference/env-vars](https://jaiph.org/reference/env-vars).
- An unmocked `prompt` in a `*.test.jh` file — see [https://jaiph.org/how-to/testing](https://jaiph.org/how-to/testing).

## Related

- [https://jaiph.org/reference/language](https://jaiph.org/reference/language) — what every construct means.
- [https://jaiph.org/reference/grammar](https://jaiph.org/reference/grammar) — the exact syntax and EBNF.
- [https://jaiph.org/reference/cli](https://jaiph.org/reference/cli) — commands, flags, and invocation.
- [https://jaiph.org/reference/configuration](https://jaiph.org/reference/configuration) — config keys and precedence.
- [https://jaiph.org/how-to/testing](https://jaiph.org/how-to/testing) — write and run `*.test.jh` tests.
