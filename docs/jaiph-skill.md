---
title: Agent Skill
permalink: /jaiph-skill
diataxis: contributor
redirect_from:
  - /jaiph-skill.md
---

# Jaiph Skill (for Agents)

You are an agent. A user has asked you to automate a repetitive task, for example a delivery pipeline, a review loop, a recurring check, or a queue of work items. This page teaches you to author **Jaiph programs** for those tasks. Read it fully before you write any `.jh` file. Jaiph looks like shell plus YAML but is neither, and most authoring mistakes come from guessing at the syntax instead of following the rules below.

## What Jaiph is

Jaiph is a small orchestration language. A `.jh` file declares:

| Construct | What it is | How it runs |
|---|---|---|
| `def` | A named sequence of steps — the orchestration layer | Interpreted in-process by the runtime |
| `script` | Real shell (or Python, Node, …) — the only place for shell code | Spawned as a subprocess; called with `run` |
| `prompt` | A task delegated to an AI agent (Cursor / Claude / Codex backend) | Backend CLI or API call; you capture the answer |
| `channel` | A message queue with declared def listeners | Drained after the sending def finishes |

Everything is **strings**. Every step is logged. Every run leaves durable artifacts under `.jaiph/runs/` (per-step `.out`/`.err` files and an append-only `run_summary.jsonl`). Compared with ad-hoc shell scripts, a Jaiph run is repeatable, inspectable, and testable.

**Source of truth:** when this document and the compiler disagree, the compiler wins. Full references: [Grammar](grammar.md), [CLI](cli.md), [Configuration](configuration.md), [Write & run tests](testing.md), [Inbox & dispatch](inbox.md).

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

Run it: `jaiph run ./flow.jh "clean up the auth module"`. The CLI executes `export def main` and binds `"clean up the auth module"` to the `task` parameter. **`jaiph run` requires `export def main` in the input file.** A library module can omit `main`; `jaiph compile` succeeds without it.

## Your authoring loop

Follow this sequence every time you create or edit `.jh` files. Do not skip the compile step. It catches almost every mistake described in this document and reports each one with a file:line:col position.

1. **Write** the `.jh` files (syntax below).
2. **Format:** `jaiph format <files…>` — canonical whitespace and top-level ordering.
3. **Compile:** `jaiph compile [--json] [--workspace <dir>] <file-or-dir>` — parses and validates the whole import closure without running anything. Reports **all** errors at once as `path:line:col CODE message`. Use `--json` for machine-readable output. Directory arguments skip `*.test.jh`; pass test files explicitly. `--workspace` sets the library root for `jaiph install` paths when auto-detect is wrong.
4. **Test:** `jaiph test` — runs every `*.test.jh` it finds; zero matches in discovery mode exit 0 with a notice, so this call is always safe to make.
5. **Run:** `jaiph run <file.jh> [args…]` for the end-to-end check.

CLI quick reference:

| Command | Purpose |
|---|---|
| `jaiph run [--target <dir>] [--raw] <file.jh> [--] [args…]` | Execute `export def main`; args bind to its named parameters |
| `jaiph test [path]` | Run `*.test.jh` files (workspace, dir, or single file) |
| `jaiph compile [--json] [--workspace <dir>] <paths…>` | Validate only — no execution, no side effects |
| `jaiph format [--check] <file.jh …>` | Reformat (or verify formatting in CI) |
| `jaiph init [workspace]` | Scaffold `.jaiph/` (bootstrap file + this skill file) |
| `jaiph install [<name[@version]> \| <url[@version]>…]` | Install libraries into `.jaiph/libs/` (bare names resolve via `JAIPH_REGISTRY`, else `https://jaiph.org/registry`; URL form is unchanged) |

Shorthand: `jaiph ./file.jh` routes by extension (`*.test.jh` → test, other `.jh` → run). A `#!/usr/bin/env jaiph` shebang makes a `.jh` file directly executable.

**Host execution:** `jaiph run` executes on the host. Isolation is an outer concern — wrap jaiph in a container or CI runner if wanted. `jaiph test` also runs on the host.

## Core rules you must internalize

Most compile errors come from breaking one of these six rules:

1. **Parentheses everywhere.** Definitions and call sites both require `()`, even with zero arguments: `export def main() { … }`, `run setup()`, `run check()`. Bare `run setup` is a parse error.
2. **All captures use `const`, and all bindings are immutable.** `const x = run foo()` — never `x = run foo()`, never rebind `x` later, never shadow a parameter with a `const` of the same name.
3. **One call verb.** `run` targets a def or a script. Mixing a bare call without `run` is `E_PARSE` / `E_VALIDATE`.
4. **Shell lives in scripts.** Defs technically allow inline shell lines, but you should not write them — use a named `script` or an inline script (`` run `cmd`() ``). Shell operators next to managed calls (`run foo() | grep x`, `run foo() > file`, `run foo() &`) are parse errors. Interpolating a `prompt` capture into a shell line (`const x = prompt …` then `echo "${x}"`) is `W_PROMPT_IN_SHELL` and fails the build: the agent-controlled value would be spliced into `sh -c`. Pass it as a script argument (`run my_script(x)` → `$1`, argv, not shell-expanded).
5. **Interpolation is `${name}` only.** In an orchestration string, `$name`, `$(…)`, and shell fallback forms like `${var:-default}` are compile errors. Other shell parameter forms like `${var//x/y}` are not caught, so they pass through as literal text, which is almost never what you want. Keep all of these in a `script` body, where they run as normal shell.
6. **Arguments are not forwarded implicitly.** If `export def main(task)` calls `run implement()`, the implement def does not see `task`. Pass it: `run implement(task)`.

## Syntax reference

### File layout

Top-level forms, in conventional order (`jaiph format` hoists `import`, `config`, and `channel` to the top):

```jaiph
import "helpers.jh" as helpers          # module import (relative; .jh appended if omitted)
import script "./tool.py" as tool       # external script file, callable with run tool(args)
import script "./gh.sh" as gh use GITHUB_TOKEN   # `use` requests host env keys (granted by --env)
config { agent.backend = "claude" }     # optional, at most one per file
channel findings -> analyst             # channels + optional routes, top level only
const VERSION = "1.0"                   # module-scoped immutable string
script build = `npm run build`          # shell definitions
def tests_pass() { run run_tests() }   # checks
export def main() { … }                # orchestration; default = the entrypoint
```

Channels, defs, scripts, script-import aliases, and module `const` share **one namespace per module** — duplicate top-level names are `E_PARSE`; duplicate import aliases are `E_VALIDATE`. Comments are full-line `#` only.

**Imports:** paths resolve relative to the importing file; if not found and the path contains `/`, it falls back to `<workspace>/.jaiph/libs/<lib>/<path>.jh` (installed via `jaiph install`). Reference imported symbols as `alias.name`. If a module uses `export` on any declaration, only exported names are visible to importers; with zero `export`s, everything is public.

### Strings and interpolation

- `"single line"` — double quotes only; single quotes are parse errors. Backslash escapes are not decoded here. `\"` lets the parser find the closing quote, but the backslash stays in the value, so `\"` produces the two characters `\"`, not a bare `"`. `\n`, `\t`, and `\\` also pass through verbatim. To include a literal double quote or a real line break in a value, use a `"""…"""` block.
- `"""…"""` — multiline. Opening `"""` ends its line; closing `"""` is on its own line.
- A double-quoted string spanning multiple lines is rejected — use `"""`.

Inside any orchestration string:

| Form | Meaning |
|---|---|
| `${name}` | Value of a `const`, capture, or parameter in scope (unknown names are compile errors) |
| `${name.field}` | Field of a typed-prompt capture (compile-checked against the schema) |
| `${run ref(args)}` / `${run ref(args)}` | Inline managed call; its output is spliced in. No nesting. |

Environment variables are **not** readable via `${…}` here: an unknown name in an orchestration string is a compile error (`E_VALIDATE unknown identifier`), so `${JAIPH_WORKSPACE}` does not resolve. Read env vars inside a `script` body as normal shell (`$JAIPH_WORKSPACE`) and capture the result.

### Scripts — the shell layer

````jaiph
# single-line: backticks. NO Jaiph ${name} here — pass data as $1, $2 arguments.
script count_lines = `wc -l < "$1"`

# multi-line: fenced block. Bash ${…} passes through to the shell untouched.
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
````

Script semantics:

- Bodies are **opaque** to Jaiph orchestration — full shell/Python/whatever, heredocs included. The compiler strips the block's common leading whitespace at parse time (same idea as triple-quoted prompts); `jaiph format` re-adds one indent level for readability. The one check: do not call Jaiph symbols (`run`, def names) from inside a script body or `$(…)`.
- **Capture = stdout.** `const v = run parse_json("pkg.json")` binds the script's stdout. Use `echo`/`printf` to return data; use exit codes (`return N` / `exit N`) for pass/fail.
- **Arguments arrive as `$1`, `$2`, …** Module `const` values and def bindings are *not* exported into the subprocess environment — pass them explicitly as arguments.
- **Script env is sterile.** A script sees only process basics (`PATH`, `HOME`, locale), the `JAIPH_WORKSPACE` / `JAIPH_SCRIPTS` / `JAIPH_RUN_DIR` / `JAIPH_ARTIFACTS_DIR` contract keys, and host keys it requests with a `use` clause: `script release use GITHUB_TOKEN = …` (also on `import script … as gh use GITHUB_TOKEN`). Each `use` key must be granted at run time with `--env KEY[=VALUE]` or `jaiph run` refuses to start (`E_ENV_MISSING`); host presence alone is not enough. `use` goes on a `script` declaration or a **named `prompt` definition** — never on defs, `run` / `prompt` call sites, or anonymous `prompt` steps.
- Alternatively a manual `#!` shebang as the first body line selects the interpreter (mutually exclusive with a fence tag).
- A newline inside a single-backtick body is a parse error — use a fenced block.

**Inline scripts** for one-off commands — body before the parens, args inside:

````jaiph
run `mkdir -p "$1"`("out/reports")
const now = run `date +%s`()
const stats = run ```python3
import sys; print(len(sys.argv[1]))
```(input_text)
````

Inline scripts work in `run`, `const … = run`, `return run`, and `log run` positions. They cannot be used with `run async`. A `run` step whose body is an inline script accepts the same optional `catch (name) <body>` / `recover (name) <body>` suffix as a named-ref `run` step (same semantics — `catch` runs once, `recover` retries up to `run.recover_limit`, mutually exclusive). The other inline-script positions (`const … = run`, `return run`, `log run`) do not take those suffixes — wrap in a standalone `run` step.

### Def body steps

```jaiph
def release(version) {
  run git_clean()                        # run a def
  const notes = run gen_notes(version)      # run a script/def, capture
  run publish(version, notes)               # args: bare identifiers for variables
  log "published ${version}"                # info line in the progress tree (stdout)
  logerr "registry error"                   # red ! line (stderr)
  logwarn "registry is slow"                # yellow warning line
  send "released ${version}" -> alerts
  return notes                              # set this def's return value
}
```

- **Call arguments:** quoted literals (`"main"`), bare identifiers for in-scope variables (`version` — preferred style), bare `IDENT.IDENT` for typed-prompt fields (`result.role`), quoted strings that embed interpolation (`"${version}"`, `"v${version}"`), or explicit nested calls (`run outer(run inner())`, `run outer(run check())`). Unquoted `${…}` outside a string (`run greet(${name})`, `run to_lower(${result.role})`) is `E_VALIDATE` — use the bare form instead. Bare call shapes like `run outer(inner())` are rejected.
- **Arity is checked** when the callee declares parameters: `run greet("a","b")` against `def greet(name)` is `E_VALIDATE`.
- **`fail "reason"`** aborts with a non-zero exit. **`return`** accepts `"string"`, `"""…"""`, a bare identifier, `run ref()` / `run ref()`, an inline script, or a `match` expression.
- **`log` / `logerr` / `logwarn`** accept `"string"`, `"""…"""`, a bare identifier (`log status` ≡ `log "${status}"`), or `log run \`cmd\`()`. `logerr` writes a red line and `logwarn` a yellow warning line; both also appear on stderr.

### Nested declarations — helpers scoped to one def

A def body may declare a nested `const`, `script`, `def`, or named `prompt` to scope a helper to the def that uses it instead of the module namespace:

```jaiph
export def main() {
  const greeting = "hi"
  script shout = `echo "$1"`      # nested script — subprocess, argv only
  def helper(name) {              # nested def — in-process, closes over greeting
    return "helped-${greeting}-${name}"
  }
  const h = run helper("bob")     # run a nested def/script
  run shout(greeting)             # pass greeting as $1 (not auto-exported)
}
```

- **Not hoisted.** A nested name is visible only after its declaration in the same def; using it earlier is `E_VALIDATE`. **No `export`** on a nested declaration (`E_PARSE`); the nested forms are `const` / `script` / `def` / named `prompt` only. Inside a nested def, `import` and a `config { … }` block are also `E_PARSE`.
- **Shadowing.** A nested name may shadow a module-level `script` / `def` / `prompt`; the local wins. Another def cannot `run` / `prompt` a name declared only inside a different def (`E_VALIDATE`). A collision with a parameter or another local name is `E_VALIDATE` (`cannot rebind immutable name`).
- **Closure vs subprocess.** A nested `def` (and a nested named `prompt` body) interpolates the enclosing def's params/`const`s plus its own params at runtime. A nested `script` is a sterile subprocess: enclosing bindings do **not** cross into its env — pass argv (`run inner(x)` → `$1`). Nested `script` / `prompt` carry their own `use` + `--env` grant.

### Checks — a def used as a gate

A check is an ordinary def whose job is to pass or fail. It runs a script or another def, and a non-zero exit or a `fail` stops the caller.

```jaiph
def branch_is(expected) {
  run `test "$(git branch --show-current)" = "$1"`(expected)
}

def preconditions() {
  run branch_is("main")
  run git_clean()
}
```

A def that `return`s a value can both check its input and return a cleaned version of it, and the caller captures that value with `const x = run valid_name()`, the same capture form as any other `run`. For example `const name = run valid_name(input)` fails the caller if the def fails, and otherwise binds the returned (cleaned) value.

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
# if/match accept dot subjects on typed prompt captures — no rebind needed
if r.verdict == "reject" {
  fail "rejected: ${r.risk}"
}
```

- Schema is **flat**, types `string` | `number` | `boolean` only. Capture (`const r =`) is **required** with `returns`.
- The runtime extracts and validates JSON from the agent's reply; on schema mismatch the step fails. All fields are stored as **strings** (a `number` field holds the text `"42"`).
- For a `"""` prompt, `returns "…"` goes on the closing-`"""` line or the line immediately after.
- Triple **backticks** inside prompt context are rejected — they are script delimiters. Use indentation or quotes for code in prompt text.

**Named prompts** are reusable, parameterised prompt definitions at module level — same namespace as `script` / `def`, invoked with parentheses:

```jaiph
prompt analyze_ci(log) use GITHUB_TOKEN = """
  Look at this CI log and summarize the failure:
  ${log}
"""
returns "{ summary: string }"

export def main() {
  const log = run fetch_ci_log()
  const r = prompt analyze_ci(log)   # invoke with (); prompt analyze_ci (no ()) is the identifier form
  return r.summary
}
```

- **`prompt name(args)` vs `prompt name`.** Parentheses invoke the named prompt (arity must match — `E_VALIDATE` otherwise, including `()`); a bare `prompt name` with no `()` stays the identifier-as-body form (prompt text = value of the string `name`). A named prompt is **never** called with `run` — `run name()` on a prompt is `E_VALIDATE`.
- **Body + `returns`** follow the anonymous-prompt rules (double-quoted or `"""…"""`, optional flat `returns` on the definition). `${param}` interpolates the prompt's parameters. `export prompt` is allowed.
- **`use KEY`** on the definition injects that host key into the invocation's agent subprocess (same clause and `--env KEY[=VALUE]` grant as `use` on a script); anonymous `prompt "…"` steps never receive `--env` secrets, and backend credentials are never written as `use`.

Backend is run-scoped: `agent.backend` = `cursor` (default) | `claude` | `codex` via `config { … }` or `JAIPH_AGENT_*` env vars (env wins for mapped keys). Model is **per-prompt**: in-file `agent.model` is resolved at each `prompt` step and passed as `--model` — it does **not** set `JAIPH_AGENT_MODEL` in the run environment. Set `JAIPH_AGENT_MODEL` in the shell to override the model for every prompt in a run. On the **cursor** backend only, `agent.command` can point at a custom executable (prompt on stdin, answer on stdout); `claude` and `codex` ignore `agent.command`.

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
- `catch` and `recover` attach to `run` (including `run async`). They are mutually exclusive on one step.
- `recover` retries until success or `run.recover_limit` (default **10**; def-level config overrides module-level).
- A common pattern: a `catch` whose body is the "else branch" — note `return` inside a catch body returns from the **enclosing def**.

A `recover` step with a `prompt` body is the core loop for repetitive agent work. It runs a check, asks the agent to fix the code when the check fails, then runs the check again, all without a human.

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

- Subjects for `if` and `match` are bare identifiers (`if status == …`, `match status {`) or `IDENT.IDENT` reading a field from a typed prompt capture (`if r.verdict == "ok"`, `match r.verdict { … }`). `$status` / `${status}` as subject is still a parse error. Dot subjects on a non-typed-capture variable, or a field not in the prompt's `returns` schema, get the same `E_VALIDATE` errors as `${var.field}` interpolation. `for` iterators stay bare identifiers (`for x in lines`).
- `if` supports optional `} else if <cond> {` arms and a final `} else {` branch — each keyword must be on **the same line** as the closing `}` of the preceding block. `else if` is sugar that desugars to nested `if`/`else` at parse time and chains to any depth (`if a == "x" { … } else if a == "y" { … } else { … }`); each arm uses the same condition grammar as `if`. `if` stays statement-only (no value production) — use `match` for value branching. An `else if` split onto its own line, without a condition, or with an empty body is `E_PARSE`.
- `match`: arms are newline-separated (no commas), first match wins, exactly one `_` arm required. A pattern may be pipe-separated **alternation** (`"" | "check" => …`, `/^a/ | /^b/ => …`) that matches if any alternand matches; string and regex alternands may be mixed, `_` cannot join an alternation, and a trailing `|` is `E_PARSE`. Arm bodies: string, `"""…"""`, in-scope identifier, `${var}`, `fail "…"`, `run ref()`, `run ref()`. **Not** allowed in arms: `return` (write `return match x { … }`), `log`/`logerr`, inline scripts — capture the match result into a `const` and act on it after.
- `for` splits the source string on newlines (a trailing final newline does not produce an empty iteration). There is no numeric/while loop — iterate lines, use `recover`, or use recursive defs (depth limit 256).

### Channels — fan-out between defs

```jaiph
channel findings -> analyst, reviewer     # routes declared at TOP LEVEL only

def scanner() {
  send "Found 3 issues in auth" -> findings
}

def analyst(msg) {
  log "from scanner: ${msg}"
}

export def main() {
  run scanner()                           # dispatch happens AFTER steps finish
}
```

Sends enqueue in memory; the queue drains after the owning def's steps complete, calling each target sequentially. A route (`name -> targets`) inside a def body is a parse error; send is `send <payload> -> channel`. Sends on a channel with no route are silently dropped. Each def frame may drain at most **1000** messages before the runtime aborts the owning def with `E_INBOX_DISPATCH_LIMIT` (naming the channel that hit the cap); override via `JAIPH_INBOX_MAX_DISPATCH=<positive int>` only if the high volume is intentional. Routed payloads are persisted under the run dir as `inbox/NNN-<channel>.txt`.

### Concurrency: `run async`

```jaiph
export def main() {
  const a = run async lint()             # returns a handle immediately
  const b = run async unit_tests()
  log "lint: ${a}"                       # first real read blocks + resolves
  log "tests: ${b}"
}                                        # unread handles are joined when this step list finishes
```

Allowed in any def; not combinable with inline scripts. `catch`/`recover` compose with `run async`. Unread handles are joined at the end of the **current step list** (the def body, an `if`/`else` branch, or a `catch`/`recover` body) before control continues — channel drains run only after the entry def's top-level list finishes. For concurrent *shell*, use `&` + `wait` inside one script body instead. Operator recipe: [Run work concurrently](async.md).

### Config

```jaiph
config {
  agent.backend = "claude"               # cursor | claude | codex
  agent.model = "claude-sonnet-5"
  run.recover_limit = 5                  # def-level config also honored
  run.logs_dir = ".jaiph/runs"
}
```

Precedence: **environment > def-level config > module-level config > defaults**. A def body may open with its own `config { … }` (before any steps; `agent.*`/`run.*` keys only) to override the model or backend for just that def.

## Compile errors you will see, and the fix

| Error (abridged) | Fix |
|---|---|
| `E_PARSE` missing `()` on definition/call | Add parentheses: `export def main()`, `run setup()` |
| `E_PARSE` assignment without `const` | `const x = run foo()` |
| `E_VALIDATE` cannot rebind immutable name | Rename the new binding — nothing is reassignable |
| `W_PROMPT_IN_SHELL` prompt capture in a shell line | Pass it as a script argument (`run my_script(x)` → `$1`), not `echo "${x}"` |
| `E_PARSE` `${…}` in single-backtick script | Use `$1`/`$2` args, or switch to a fenced ``` block |
| `E_VALIDATE` unknown identifier / unknown `${name}` | Declare it (`const`/param) before use; check spelling |
| `E_VALIDATE` nested call must be explicit | `run f(run g())`, not `run f(g())` |
| `E_VALIDATE` duplicate import alias | Use a unique `as` name for each `import` |
| `E_VALIDATE` arity mismatch | Match the callee's declared parameter count |
| `E_PARSE` redirection after managed call | Move pipes/redirects into a script body |
| `E_VALIDATE` scripts are not values/promptable | Scripts aren't strings: don't `const x = scriptName`, `${scriptName}`, or `prompt scriptName` |
| `E_PARSE` `->` inside def body | Move the route to the top-level `channel` line |
| `E_PARSE` `prompt … returns` without capture | `const x = prompt … returns "…"` |
| `E_SCHEMA` invalid returns schema | Flat `{ field: string|number|boolean }` only |
| `E_IMPORT_NOT_FOUND` | Fix the path (relative to the importing file) or `jaiph install` the library |

## Runtime model (what happens when it runs)

- `jaiph run file.jh args…` validates the import closure, emits script bodies as executable files, then interprets `export def main` with the args bound to its named parameters. Scripts additionally see positional args as `$1`, `$2`.
- **Run directory:** `.jaiph/runs/<UTC-date>/<UTC-time>-<file>/` with numbered `NNNNNN-<step>.out`/`.err` per step (written incrementally — `tail -f` works) and `run_summary.jsonl`, one JSON event per line (`RUN_START/END`, `STEP_START/END`, `LOG`, `INBOX_*`, `PROMPT_*`). When debugging a failed run, read the failure footer the CLI prints, then the referenced `.err`/`.out` files.
- **Return value:** if `main` returns a string, the CLI prints it to stdout after the PASS line.
- **Capture sources:** def → its explicit `return` value; script → stdout; prompt → the agent's answer.
- Step environment: script env is sterile — process basics plus `JAIPH_WORKSPACE`, `JAIPH_SCRIPTS`, `JAIPH_RUN_DIR`, `JAIPH_ARTIFACTS_DIR` (and `JAIPH_AGENT_MODEL`, kept defined for `set -u`); host keys cross only via a `use` clause granted with `--env`. Def variables are **not** auto-exported — pass them as arguments.

## Testing your programs

Test files are `*.test.jh` next to your modules, run with `jaiph test`. They run the same interpreter with mocked prompts and bodies. Mock every prompt (see below) so no live LLM call happens — an unmocked `prompt` still calls the backend.

```jaiph
import "main.jh" as app

test "happy path" {
  mock prompt "LGTM — implemented"
  const out = run app.main("add logging")
  expect_contain out "LGTM"
}

test "failure path is handled" {
  # content-based dispatch; arms on separate lines, like a match
  mock prompt {
    /fix/ => "fixed"
    _ => "noop"
  }
  mock script app.run_tests() {
    exit 1
  }
  const out = run app.main("x") allow_failure   # non-zero exit doesn't fail the test
  expect_contain out "rollback"
}
```

- Mocks: `mock prompt "…"` (queued, one per prompt call), a `mock prompt { … }` block with content-based arms (`/regex/ => "…"` matches when the pattern appears anywhere in the prompt, `"exact" => "…"` matches the whole prompt text, `_ => "…"` is the default; each arm on its own line, like a `match`), `mock def ref() { … }`, `mock script ref() { shell lines }`. All mock refs need `()`.
- Assertions: `expect_contain`, `expect_not_contain`, `expect_equal` — `expect_* <captureVar> "literal"` or a test-block `const` name.
- For typed prompts, the mock text must be one line of valid JSON matching the schema.
- Mixing queued `mock prompt "…"` / `mock prompt <const>` and a `mock prompt { … }` block in one test is rejected at compile time (`E_VALIDATE`: `cannot mix "mock prompt { … }" with queued "mock prompt …" in one test block; choose one style`). Use one style per block; separate tests in the same file may use different styles.

Write at least one test per def you author when the repo uses tests; mock every prompt so the suite is deterministic.

## Patterns for repetitive tasks

**Gate → do → verify** (the standard delivery shape):

```jaiph
export def main(task) {
  run preconditions()          # fast checks first
  run implement(task)             # prompt-driven work
  run verify() recover (err) {    # verification with self-repair
    prompt "Verification failed — fix it. Output: ${err}"
  }
}
```

**Process a queue of items** (line-oriented `for`):

```jaiph
export def main() {
  const items = run `ls inbox/*.md 2>/dev/null || true`()
  for item in items {
    run handle(item)
  }
}
```

**Review-then-act with a typed verdict:**

```jaiph
def triage(item) {
  const r = prompt "Is this ready to implement? Item: ${item}" returns "{ verdict: string, reason: string }"
  const outcome = match r.verdict {
    "ready" => run implement(item)
    _ => "skipped: ${r.reason}"
  }
  log outcome
}
```

**Pipeline stages via channels** when later stages should react to earlier ones without direct calls (see the channel section above).

## What to produce in a repository

When asked to scaffold Jaiph automation (e.g. after `jaiph init`), build a small composable set under `.jaiph/`:

- `.jaiph/readiness.jh` — preflight checks (required tools, clean git) + `export def main` running them.
- `.jaiph/verification.jh` — lint/test/build checks + `export def main`.
- `.jaiph/main.jh` — imports both, defines the prompt-driven `implement` def, and a `export def main(task)` wiring **preflight → implement → verification**.
- Optional: a review def gating a task queue, `*.test.jh` tests for the defs.

Keep defs short; put expensive checks after cheap ones; pass data explicitly. Always finish with format + compile:

```bash
jaiph format .jaiph/*.jh
jaiph compile .jaiph
jaiph test                       # safe even when no *.test.jh exists yet
jaiph run .jaiph/main.jh "implement feature X"
```

End your scaffolding response by printing those exact commands for the user, plus a short **WHAT CHANGED** / **WHY** summary. Canonical agent-readable copy of this skill: <https://raw.githubusercontent.com/jaiphlang/jaiph/refs/heads/main/docs/jaiph-skill.md>.
