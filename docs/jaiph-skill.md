---
title: Agent Skill
permalink: /jaiph-skill
redirect_from:
  - /jaiph-skill.md
---

# Jaiph Skill (for Agents)

You are an agent. A user has asked you to automate a repetitive task — a delivery pipeline, a review loop, a recurring check, a queue of work items. This document teaches you to author **Jaiph workflows** that do that. Read it fully before writing any `.jh` file; Jaiph looks like shell plus YAML but is neither, and most authoring mistakes come from guessing syntax instead of following the rules below.

## What Jaiph is

Jaiph is a small workflow language. A `.jh` file declares:

| Construct | What it is | How it runs |
|---|---|---|
| `workflow` | A named sequence of steps — the orchestration layer | Interpreted in-process by the runtime |
| `rule` | A non-mutating check (preconditions, verifications) | Interpreted in-process; called with `ensure` |
| `script` | Real shell (or Python, Node, …) — the only place for shell code | Spawned as a subprocess; called with `run` |
| `prompt` | A task delegated to an AI agent (Cursor / Claude / Codex backend) | Backend CLI or API call; you capture the answer |
| `channel` | A message queue with declared workflow listeners | Drained after the sending workflow finishes |

Everything is **strings**. Every step is logged. Every run leaves durable artifacts under `.jaiph/runs/` (per-step `.out`/`.err` files and an append-only `run_summary.jsonl`). That is the payoff over ad-hoc shell: repeatable, inspectable, testable automation.

**Source of truth:** when this document and the compiler disagree, the compiler wins. Full references: [Grammar](https://jaiph.org/grammar), [CLI](https://jaiph.org/cli), [Configuration](https://jaiph.org/configuration), [Testing](https://jaiph.org/testing), [Inbox & Dispatch](https://jaiph.org/inbox), [Sandboxing](https://jaiph.org/sandboxing).

## Smallest working example

```jaiph
script list_todos = `grep -rn "TODO" src/ || true`
script worktree_clean = `test -z "$(git status --porcelain)"`

rule git_clean() {
  run worktree_clean() catch (err) {
    fail "working tree is not clean"
  }
}

workflow default(task) {
  ensure git_clean()
  const todos = run list_todos()
  prompt """
  Address the following request: ${task}
  Known TODOs in the codebase:
  ${todos}
  """
  log "done"
}
```

Run it: `jaiph run ./flow.jh "clean up the auth module"`. The CLI executes `workflow default` and binds `"clean up the auth module"` to the `task` parameter. **Every runnable file must define `workflow default`.**

## Your authoring loop

Follow this sequence every time you create or edit `.jh` files. Do not skip the compile step — it catches almost every mistake described in this document, with file:line:col positions.

1. **Write** the `.jh` files (syntax below).
2. **Format:** `jaiph format <files…>` — canonical whitespace and top-level ordering.
3. **Compile:** `jaiph compile <file-or-dir>` — parses and validates the whole import closure without running anything. Reports **all** errors at once as `path:line:col CODE message`. Use `--json` for machine-readable output. Directory arguments skip `*.test.jh`; pass test files explicitly.
4. **Test:** `jaiph test` (only if `*.test.jh` files exist — discovery with zero matches exits 1).
5. **Run:** `jaiph run <file.jh> [args…]` for the end-to-end check.

CLI quick reference:

| Command | Purpose |
|---|---|
| `jaiph run [--target <dir>] [--raw] <file.jh> [--] [args…]` | Execute `workflow default`; args bind to its named parameters |
| `jaiph test [path]` | Run `*.test.jh` files (workspace, dir, or single file) |
| `jaiph compile [--json] <paths…>` | Validate only — no execution, no side effects |
| `jaiph format [--check] <file.jh …>` | Reformat (or verify formatting in CI) |
| `jaiph init [workspace]` | Scaffold `.jaiph/` (bootstrap workflow + this skill file) |
| `jaiph install [<url[@version]>…]` | Install git-hosted libraries into `.jaiph/libs/` |

Shorthand: `jaiph ./file.jh` routes by extension (`*.test.jh` → test, other `.jh` → run). A `#!/usr/bin/env jaiph` shebang makes a `.jh` file directly executable.

**Sandboxing:** by default, interactive `jaiph run` executes the workflow inside a Docker container (`ghcr.io/jaiphlang/jaiph-runtime`). Set `JAIPH_UNSAFE=true` to run directly on the host, or `JAIPH_DOCKER_ENABLED=true/false` to force either mode. `jaiph test` always runs on the host.

## Core rules you must internalize

These six rules prevent 90% of compile errors:

1. **Parentheses everywhere.** Definitions and call sites both require `()`, even with zero arguments: `workflow default() { … }`, `run setup()`, `ensure check()`. Bare `run setup` is a parse error.
2. **All captures use `const`, and all bindings are immutable.** `const x = run foo()` — never `x = run foo()`, never rebind `x` later, never shadow a parameter with a `const` of the same name.
3. **Call keyword must match callee type.** `ensure` → rules only. `run` → workflows and scripts (inside a workflow); scripts **only** (inside a rule). Mixing them is `E_VALIDATE`.
4. **Shell lives in scripts.** Rules reject raw shell lines entirely. Workflows technically allow inline shell lines, but you should not write them — use a named `script` or an inline script (`` run `cmd`() ``). Shell operators next to managed calls (`run foo() | grep x`, `run foo() > file`, `run foo() &`) are parse errors.
5. **Interpolation is `${name}` only.** No `$name` in orchestration strings, no `$(…)`, no `${var:-default}`, no `${var//x/y}`. Those shell forms are valid *inside script bodies* only.
6. **Arguments are not forwarded implicitly.** If `workflow default(task)` calls `run implement()`, the implement workflow does not see `task`. Pass it: `run implement(task)`.

## Syntax reference

### File layout

Top-level forms, in conventional order (the formatter hoists the first three):

```jaiph
import "helpers.jh" as helpers          # module import (relative; .jh appended if omitted)
import script "./tool.py" as tool       # external script file, callable with run tool(args)
config { agent.backend = "claude" }     # optional, at most one per file
channel findings -> analyst             # channels + optional routes, top level only
const VERSION = "1.0"                   # module-scoped immutable string
script build = `npm run build`          # shell definitions
rule tests_pass() { run run_tests() }   # checks
workflow default() { … }                # orchestration; default = the entrypoint
```

Channels, rules, workflows, scripts, script-import aliases, and module `const` share **one namespace per module** — name collisions are `E_PARSE`. Comments are full-line `#` only.

**Imports:** paths resolve relative to the importing file; if not found and the path contains `/`, it falls back to `<workspace>/.jaiph/libs/<lib>/<path>.jh` (installed via `jaiph install`). Reference imported symbols as `alias.name`. If a module uses `export` on any declaration, only exported names are visible to importers; with zero `export`s, everything is public.

### Strings and interpolation

- `"single line"` — double quotes only; single quotes are parse errors. Escapes: `\"`, `\\`, `\n`, `\t`.
- `"""…"""` — multiline. Opening `"""` ends its line; closing `"""` is on its own line.
- A double-quoted string spanning multiple lines is rejected — use `"""`.

Inside any orchestration string:

| Form | Meaning |
|---|---|
| `${name}` | Value of a `const`, capture, or parameter in scope (unknown names are compile errors) |
| `${name.field}` | Field of a typed-prompt capture (compile-checked against the schema) |
| `${run ref(args)}` / `${ensure ref(args)}` | Inline managed call; its output is spliced in. No nesting. |
| `${JAIPH_WORKSPACE}` etc. | Falls back to process environment when no workflow variable matches |

### Scripts — the shell layer

```jaiph
# single-line: backticks. NO ${…} here — pass data as $1, $2 arguments.
script count_lines = `wc -l < "$1"`

# multi-line: fenced block. ${…} passes through to the shell untouched.
script deploy = ```
set -euo pipefail
echo "deploying ${TARGET_ENV:-staging}"
./deploy.sh "$1"
```

# polyglot: fence tag → #!/usr/bin/env <tag>. Any tag works.
script parse_json = ```python3
import json, sys
print(json.load(open(sys.argv[1]))["version"])
```
```

Script semantics:

- Bodies are **opaque** to the compiler — full shell/Python/whatever, heredocs included. The one check: do not call Jaiph symbols (`run`, `ensure`, workflow names) from inside a script body or `$(…)`.
- **Capture = stdout.** `const v = run parse_json("pkg.json")` binds the script's stdout. Use `echo`/`printf` to return data; use exit codes (`return N` / `exit N`) for pass/fail.
- **Arguments arrive as `$1`, `$2`, …** Module `const` values and workflow bindings are *not* exported into the subprocess environment — pass them explicitly as arguments.
- Alternatively a manual `#!` shebang as the first body line selects the interpreter (mutually exclusive with a fence tag).
- A newline inside a single-backtick body is a parse error — use a fenced block.

**Inline scripts** for one-off commands — body before the parens, args inside:

```jaiph
run `mkdir -p "$1"`("out/reports")
const now = run `date +%s`()
const stats = run ```python3
import sys; print(len(sys.argv[1]))
```(input_text)
```

Inline scripts work in `run`, `const … = run`, `return run`, and `log run` positions. They cannot be used with `run async`, and they do **not** accept `catch`/`recover` suffixes — if you need failure handling, define a named `script` and attach `catch`/`recover` to that call.

### Workflow steps

```jaiph
workflow release(version) {
  ensure git_clean()                        # run a rule
  const notes = run gen_notes(version)      # run a script/workflow, capture
  run publish(version, notes)               # args: bare identifiers for variables
  log "published ${version}"                # info line in the progress tree (stdout)
  logerr "warning: slow registry"           # red ! line (stderr)
  alerts <- "released ${version}"           # send to a channel
  return notes                              # set this workflow's return value
}
```

- **Call arguments:** quoted literals (`"main"`), bare identifiers for in-scope variables (`version` — preferred over `"${version}"`, which is rejected when it is the whole argument), or explicit nested calls (`run outer(run inner())`, `run outer(ensure check())`). Bare call shapes like `run outer(inner())` are rejected. Strings mixing text and interpolation (`"v${version}"`) are fine.
- **Arity is checked** when the callee declares parameters: `run greet("a","b")` against `workflow greet(name)` is `E_VALIDATE`.
- **`fail "reason"`** aborts with a non-zero exit. **`return`** accepts `"string"`, `"""…"""`, a bare identifier, `run ref()` / `ensure ref()`, an inline script, or a `match` expression.
- **`log` / `logerr`** accept `"string"`, `"""…"""`, a bare identifier (`log status` ≡ `log "${status}"`), or `log run \`cmd\`()`.

### Rules — checks only

```jaiph
rule branch_is(expected) {
  run `test "$(git branch --show-current)" = "$1"`(expected)
}

rule preconditions() {
  ensure branch_is("main")
  ensure git_clean()
}
```

Allowed in rule bodies: `ensure`, `run` (**scripts only**), `const`, `if`, `match`, `for`, `log`/`logerr`, `fail`, `return`, `catch`/`recover` suffixes. **Not allowed:** `prompt`, channel sends, `run async`, `run` to a workflow, raw shell lines. A rule passes when it exits 0. Treat rules as read-only: do mutations in workflows and scripts.

### Prompts — delegating to an agent

```jaiph
prompt "Summarize the diff in one paragraph"          # fire and forget
const answer = prompt "Summarize the diff"            # capture the agent's answer

const body = "Review this plan: ${plan}"
prompt body                                           # identifier form

const review = prompt """
You are reviewing a release plan.
Approve only if all checks below are addressed.
Plan:
${plan}
"""
```

**Typed prompts** force structured JSON output and give you field access:

```jaiph
const r = prompt "Assess this change" returns "{ verdict: string, risk: string }"
log "verdict=${r.verdict} risk=${r.risk}"
# if/match subjects must be plain identifiers — rebind a dot field first
const verdict = "${r.verdict}"
if verdict == "reject" {
  fail "rejected: ${r.risk}"
}
```

- Schema is **flat**, types `string` | `number` | `boolean` only. Capture (`const r =`) is **required** with `returns`.
- The runtime extracts and validates JSON from the agent's reply; on schema mismatch the step fails. All fields are stored as **strings** (a `number` field holds the text `"42"`).
- For a `"""` prompt, `returns "…"` goes on the closing-`"""` line or the line immediately after.
- Triple **backticks** inside prompt context are rejected — they are script delimiters. Use indentation or quotes for code in prompt text.

Backend is configured, not per-prompt: `agent.backend` = `cursor` (default) | `claude` | `codex`, plus `agent.default_model`, via `config { … }` or `JAIPH_AGENT_*` env vars (env wins). Any executable that reads a prompt on stdin and answers on stdout can be a backend via `agent.command`.

**Write prompts like task briefs:** state the goal, the constraints, the acceptance criteria, and what to output. Interpolate concrete context (`${task}`, `${diff}`, captured file contents) rather than asking the agent to go find it.

### Failure handling: `catch` and `recover`

```jaiph
# catch — runs ONCE on failure, then continues
run deploy(env) catch (err) {
  logerr "deploy failed: ${err}"
  run rollback(env)
}

# recover — repair-and-RETRY loop: run target → on failure run body → retry target
run tests() recover (err) {
  prompt "Tests failed. Fix the code. Failure output: ${err}"
}
```

- The binding (`err`) receives the merged stdout+stderr of the failed execution. Exactly one binding, always in parentheses — bare `catch {` is a parse error.
- `catch` works on `ensure` and `run`; `recover` works on `run` (and `run async`) only. They are mutually exclusive on one step.
- `recover` retries until success or `run.recover_limit` (default **10**; workflow-level config overrides module-level).
- A common pattern: a `catch` whose body is the "else branch" — note `return` inside a catch body returns from the **enclosing workflow**.

`recover` + `prompt` is Jaiph's signature loop for repetitive agent work: *check → if broken, ask agent to fix → re-check*, fully unattended.

### Control flow: `if`, `match`, `for`

```jaiph
if status == "ok" { log "healthy" }       # operators: == != =~ !~
if msg =~ /ERROR|FATAL/ { fail "bad" }    # =~ / !~ take /regex/

const label = match status {              # statement, expression, or return form
  "ok" => "success"
  /^warn/ => "warning"
  _ => "unknown"
}

for path in paths {                       # iterates LINES of the string `paths`
  run process(path)
}
```

- Subjects are **bare identifiers** (`if status == …`, `match status {`, `for x in lines`) — `$status` / `${status}` as subject is a parse error, and so is a dot-notation field (`if r.verdict == …`). Rebind first: `const verdict = "${r.verdict}"`.
- `if` has **no `else`** — use `match` for branching, or a `catch` body as the failure branch.
- `match`: arms are newline-separated (no commas), first match wins, exactly one `_` arm required. Arm bodies: string, `"""…"""`, in-scope identifier, `${var}`, `fail "…"`, `run ref()`, `ensure ref()`. **Not** allowed in arms: `return` (write `return match x { … }`), `log`/`logerr`, inline scripts — capture the match result into a `const` and act on it after.
- `for` splits the source string on newlines (a trailing final newline does not produce an empty iteration). There is no numeric/while loop — iterate lines, use `recover`, or use recursive workflows (depth limit 256).

### Channels — fan-out between workflows

```jaiph
channel findings -> analyst, reviewer     # routes declared at TOP LEVEL only

workflow scanner() {
  findings <- "Found 3 issues in auth"    # RHS: "literal", """block""", ${var}, or run ref()
}

workflow analyst(message, chan, sender) { # route targets declare EXACTLY 3 params
  log "from ${sender}: ${message}"
}

workflow default() {
  run scanner()                           # dispatch happens AFTER steps finish
}
```

Sends enqueue in memory; the queue drains after the owning workflow's steps complete, calling each target sequentially. A `->` inside a workflow body is a parse error. Sends on a channel with no route are silently dropped. Each workflow frame may drain at most **1000** messages before the runtime aborts the owning workflow with `E_INBOX_DISPATCH_LIMIT` (naming the channel that hit the cap); override via `JAIPH_INBOX_MAX_DISPATCH=<positive int>` only if the high volume is intentional. Routed payloads are persisted under the run dir as `inbox/NNN-<channel>.txt`.

### Concurrency: `run async`

```jaiph
workflow default() {
  const a = run async lint()             # returns a handle immediately
  const b = run async unit_tests()
  log "lint: ${a}"                       # first real read blocks + resolves
  log "tests: ${b}"
}                                        # unread handles are joined at workflow exit
```

Workflows only (rejected in rules); not combinable with inline scripts. `catch`/`recover` compose with `run async`. For concurrent *shell*, use `&` + `wait` inside one script body instead.

### Config

```jaiph
config {
  agent.backend = "claude"               # cursor | claude | codex
  agent.default_model = "claude-sonnet-4-6"
  run.recover_limit = 5                  # workflow-level config also honored
  run.logs_dir = ".jaiph/runs"
}
```

Precedence: **environment > workflow-level config > module-level config > defaults**. A workflow body may open with its own `config { … }` (before any steps; `agent.*`/`run.*` keys only) to override the model or backend for just that workflow. Docker on/off is env-only (`JAIPH_UNSAFE`, `JAIPH_DOCKER_ENABLED`); image/network/timeout come from `runtime.*` keys or `JAIPH_DOCKER_*`.

## Compile errors you will see, and the fix

| Error (abridged) | Fix |
|---|---|
| `E_PARSE` missing `()` on definition/call | Add parentheses: `workflow default()`, `run setup()` |
| `E_PARSE` assignment without `const` | `const x = run foo()` |
| `E_VALIDATE` cannot rebind immutable name | Rename the new binding — nothing is reassignable |
| `E_VALIDATE` `ensure` on non-rule / `run` on rule | Match keyword to callee: rules→`ensure`, scripts/workflows→`run` |
| `E_VALIDATE` `run` to workflow inside rule | Rules may `run` scripts only; restructure or move to a workflow |
| `E_VALIDATE` inline shell forbidden in rules | Wrap the shell in a `script` (named or inline) and `run` it |
| `E_PARSE` `${…}` in single-backtick script | Use `$1`/`$2` args, or switch to a fenced ``` block |
| `E_VALIDATE` unknown identifier / unknown `${name}` | Declare it (`const`/param) before use; check spelling |
| `E_VALIDATE` standalone `"${x}"` argument | Pass the bare identifier: `run f(x)` |
| `E_VALIDATE` nested call must be explicit | `run f(run g())`, not `run f(g())` |
| `E_VALIDATE` arity mismatch | Match the callee's declared parameter count |
| `E_PARSE` redirection after managed call | Move pipes/redirects into a script body |
| `E_VALIDATE` scripts are not values/promptable | Scripts aren't strings: don't `const x = scriptName`, `${scriptName}`, or `prompt scriptName` |
| `E_PARSE` `->` inside workflow body | Move the route to the top-level `channel` line |
| `E_PARSE` `prompt … returns` without capture | `const x = prompt … returns "…"` |
| `E_SCHEMA` invalid returns schema | Flat `{ field: string|number|boolean }` only |
| `E_IMPORT_NOT_FOUND` | Fix the path (relative to the importing file) or `jaiph install` the library |

## Runtime model (what happens when it runs)

- `jaiph run file.jh args…` validates the import closure, emits script bodies as executable files, then interprets `workflow default` with the args bound to its named parameters. Scripts additionally see positional args as `$1`, `$2`.
- **Run directory:** `.jaiph/runs/<UTC-date>/<UTC-time>-<file>/` with numbered `NNNNNN-<step>.out`/`.err` per step (written incrementally — `tail -f` works) and `run_summary.jsonl`, one JSON event per line (`WORKFLOW_START/END`, `STEP_START/END`, `LOG`, `INBOX_*`, `PROMPT_*`). When debugging a failed run, read the failure footer the CLI prints, then the referenced `.err`/`.out` files.
- **Return value:** if `default` returns a string, the CLI prints it to stdout after the PASS line.
- **Capture sources:** workflow/rule → its explicit `return` value; script → stdout; prompt → the agent's answer.
- Step environment: scripts inherit the runner's environment plus `JAIPH_WORKSPACE`, `JAIPH_SCRIPTS`, `JAIPH_RUN_DIR`, `JAIPH_ARTIFACTS_DIR`, etc. Workflow variables are **not** auto-exported — pass them as arguments.

## Testing your workflows

Test files are `*.test.jh` next to your modules, run with `jaiph test`. They execute the same interpreter with prompts and bodies mocked — no live LLM calls.

```jaiph
import "main.jh" as app

test "happy path" {
  mock prompt "LGTM — implemented"
  const out = run app.default("add logging")
  expect_contain out "LGTM"
}

test "failure path is handled" {
  mock prompt { /fix/ => "fixed", _ => "noop" }   # content-based dispatch
  mock script app.run_tests() {
    exit 1
  }
  const out = run app.default("x") allow_failure   # non-zero exit doesn't fail the test
  expect_contain out "rollback"
}
```

- Mocks: `mock prompt "…"` (queued, one per prompt call), `mock prompt { /re/ => "…", _ => "…" }`, `mock workflow ref() { … }`, `mock rule ref() { … }`, `mock script ref() { shell lines }`. All mock refs need `()`.
- Assertions: `expect_contain`, `expect_not_contain`, `expect_equal` — `expect_* <captureVar> "literal"` or a test-block `const` name.
- For typed prompts, the mock text must be one line of valid JSON matching the schema.
- Don't mix queued `mock prompt "…"` and a `mock prompt { … }` block in one test.

Write at least one test per workflow you author when the repo uses tests; mock every prompt so the suite is deterministic.

## Patterns for repetitive tasks

**Gate → do → verify** (the standard delivery shape):

```jaiph
workflow default(task) {
  ensure preconditions()          # fast checks first
  run implement(task)             # prompt-driven work
  run verify() recover (err) {    # verification with self-repair
    prompt "Verification failed — fix it. Output: ${err}"
  }
}
```

**Process a queue of items** (line-oriented `for`):

```jaiph
workflow default() {
  const items = run `ls inbox/*.md 2>/dev/null || true`()
  for item in items {
    run handle(item)
  }
}
```

**Review-then-act with a typed verdict:**

```jaiph
workflow triage(item) {
  const r = prompt "Is this ready to implement? Item: ${item}" returns "{ verdict: string, reason: string }"
  const verdict = "${r.verdict}"
  const outcome = match verdict {
    "ready" => run implement(item)
    _ => "skipped: ${r.reason}"
  }
  log outcome
}
```

**Pipeline stages via channels** when later stages should react to earlier ones without direct calls (see the channel section above).

## What to produce in a repository

When asked to scaffold Jaiph automation (e.g. after `jaiph init`), build a small composable set under `.jaiph/`:

- `.jaiph/readiness.jh` — preflight rules (required tools, clean git) + `workflow default` running them.
- `.jaiph/verification.jh` — lint/test/build rules + `workflow default`.
- `.jaiph/main.jh` — imports both, defines the prompt-driven `implement` workflow, and a `workflow default(task)` wiring **preflight → implement → verification**.
- Optional: a review workflow gating a task queue, `*.test.jh` tests for the workflows.

Keep workflows short; put expensive checks after cheap ones; pass data explicitly. Always finish with format + compile:

```bash
jaiph format .jaiph/*.jh
jaiph compile .jaiph
jaiph test                       # only if *.test.jh files exist
jaiph run .jaiph/main.jh "implement feature X"
```

End your scaffolding response by printing those exact commands for the user, plus a short **WHAT CHANGED** / **WHY** summary. Canonical agent-readable copy of this skill: <https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md>.
