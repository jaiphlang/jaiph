---
title: Language
permalink: /reference/language
diataxis: reference
redirect_from:
  - /language
  - /language.md
---

# Language

Jaiph is a small language for writing defs. A `def` is a function whose body is steps. You invoke it with a bare call — `greet(name)` — you do not pass it around. Each step either runs something (a script, another def, or an agent prompt), binds a value to a name, returns or logs a value, makes a decision with `if` or `match`, loops over lines of text with `for`, or sends a message on a channel.

You write a Jaiph program as one or more modules. Each `.jh` module holds top-level definitions: defs, scripts, channels, constants, imports, and an optional `config` block. The rest of this page describes what you can write inside those definitions.

A value in a def is a `string`, a `script`, or an **output handle**. A `string` is ordinary text that you can interpolate, pass as an argument, and return. A `script` is an executable body that you invoke with a bare call. An **output handle** is what a call returns: its bytes stay on disk (or in a pipe) until a **force site** slurps them into a string; `stdin` and an unused result do not slurp. The Value types table below lists what you can do with each and which uses the validator rejects.

The def runtime (`src/runtime/kernel/node-workflow-runtime.ts`) executes these definitions. It dispatches on `StepDef.type` and evaluates every value through one private `evaluateExpr` over `Expr.kind` (seven expression kinds). See [Architecture](architecture.md#core-components).

For the formal grammar (EBNF, lexical rules, and the validation catalog) see [Grammar](grammar.md). For why the language is shaped the way it is, see [Why Jaiph](why-jaiph.md).

## Value types

| Type | What it is | Operations |
|---|---|---|
| `string` | Text. Literals, params, slurped handles. | `${…}` interpolation, call arguments, `const`, `prompt` body, `send` payload, `return`. |
| `script` | The declaration. | Invocable with a bare call `name(args)`. |
| output handle | The result of a script / def / prompt call, and of a `recover` / `catch` binding. Its bytes live on disk (or in a pipe) until a force site slurps them. | `stdin h -> script()` and a `prompt h` / `prompt ${h}` body stream it; a force site slurps it to a `string`. |

A call **always runs at the call site** — this is lazy *slurp*, not lazy execution. The result is an output handle, not a string; the bytes are read into memory only at a force site. A huge slurp may exhaust memory — that is you asking for the bytes.

**Force (slurp the handle → `string`):**

- `const x = <call>()`
- `if` / `match` subject, `${x}` interpolation, a call argument, `log` / `logerr` / `logwarn`
- an **interpolated** `prompt` body that embeds a handle inside a constructed string (`prompt "… ${x} …"` or `prompt """… ${x} …"""`) — building the string slurps the handle, and the agent is sent that built string, never a path
- `return <call>()` yields a handle to the caller; the caller slurps only at *its* force site. Printing the entry def's return streams the file to you rather than pulling it through memory.

**Keep as an output handle (no in-memory string):**

- A statement call whose result is unused (`` `echo hi`() ``, `fetch_log()`)
- `stdin <handle> -> script()` and `stdin <call>() -> script()` — the bytes stream into the child from disk
- A `prompt x` / `prompt ${x}` body that is exactly a handle (the identifier or bare-ref form, not embedded in a larger string) — the handle's bytes stream into the agent transport instead of being slurped, the same keep-as-handle rule as `stdin`
- A `recover (failure)` / `catch (err)` binding — until a force site reads it

Crossings: interpolating, an `if` subject, or a call argument on a handle **is** the slurp — after it, the value is a `string`. A `string` cannot be invoked as a call (`E_VALIDATE: strings are not executable`). A `script` is not interpolatable, not `const`-assignable by name, and not a valid `prompt` body. Do not interpolate a handle as a filesystem path. Crossings produce specific `E_VALIDATE` messages identifying the violated rule.

## Module surface

| Top-level | Description |
|---|---|
| `import "path" as alias` | Loads another module. `.jh` is appended unless the path already ends in `.jh`. Resolution: relative-first; then, for paths containing a `/` (and when a workspace root is known), library fallback (`<workspace>/.jaiph/libs/<name>/...`). |
| `import script "path" as name [use KEY …]` | Loads an external script file (no `.jh` appended). Path is relative-only. Treated as a `script` symbol. The optional `use` clause requests host env keys for the script's spawns, same as on a named `script`. |
| `export def` / `export script` | Marks a definition public. Names are private by default: same-file code can call any name; `import` can only call names listed in `mod.exports`. Zero exports means nothing is public. |
| `channel name [-> target [, target …]]` | Declares a named queue. Inline routes target defs with 1 to 3 parameters (message, channel, sender). |
| `const NAME = value` | Module-scoped immutable string. Values: double-quoted, triple-quoted, or bare token. Stored verbatim. |
| `config { … }` | Module-level configuration block (`agent.*`, `run.*`, and `module.*`). See [Configuration](configuration.md). |
| `script name [use KEY …] = …` | Executable definition. Invoked with a bare call `name(args)`. The optional `use` clause requests host env keys for this script's subprocess; each key must be granted with `--env KEY[=VALUE]` (see [Subprocess environment](#subprocess-environment)). |
| `prompt name([params]) [use KEY …] = …` | Named, parameterised [prompt](#named-prompts). Invoked with `prompt name(args)`, never a bare call `name(args)`. The optional `use` clause requests host env keys for this prompt's agent subprocess (same `--env` grant as a script). |
| `def name([params]) { … }` | Interpreted callable. Invoked with a bare call `name(args)`. `export def main` is the `jaiph run` entry; it is optional in library modules. |

Visibility: same-file, all names. Across `import`, only names in `mod.exports` (`E_VALIDATE: "<name>" is not exported from module "<alias>"`). Zero exports means nothing is public.

The unified per-module namespace covers channels, defs, scripts, named prompts, script-import aliases, and top-level `const`. Duplicates are `E_PARSE`. `main` is reserved as the run entry: if a symbol named `main` exists, it must be `export def main`.

## Def body — step types

There are nine `StepDef` variants. Every body line that does not match a managed form becomes a `shell` step.

| Type | Surface | Description |
|---|---|---|
| `exec` | call / `prompt` / standalone `match` / inline shell | Side-effecting managed call statement. The discriminator (call / inline_script / prompt / match / shell) lives in `body.kind`. Carries optional `catch` or `recover`. |
| `const` | `const NAME = <expr>` | Bind a value expression to a name. |
| `return` | `return <expr>` | Set the managed return value. |
| `send` | `send <expr> -> channel` | Enqueue a payload on a channel for the current def context. |
| `say` | `log` / `logerr` / `logwarn` / `fail` | `level: "log"` / `"logerr"` / `"logwarn"` / `"fail"`. `level: "fail"` aborts with the message. |
| `if` | `if <subject> <op> <operand> { … } [ else if … { … } ]* [ else { … } ]` | Conditional block. |
| `for_lines` | `for <iter> in <source> { … }` | Iterate lines of a string variable. |
| `local_decl` | nested `script` / `def` / named `prompt` | A [nested declaration](#nested-declarations) local to the enclosing def (sequential, not hoisted). Nested `const` stays a `const` step. |
| `trivia` | comments, blank lines | Formatter-only. Skipped by the runtime and validator. |

## Value expressions — `Expr` kinds

Every value position (`const` RHS, `return`, `send` RHS, `log` / `logerr` / `fail` argument, and `exec` body) carries an `Expr` of one of seven kinds.

| Kind | Source form | Runtime behaviour |
|---|---|---|
| `literal` | `"…"`, `"""…"""`, `${var}`, post-dedent triple-quoted body | Interpolated against the current scope; `${ref(args)}` performs inline managed calls. |
| `call` | `ref(args)`, `async ref(args)` | Managed def/script call. `async: true` on the `async` capture position. |
| `inline_script` | `` `body`(args) `` / `` ```lang...body...```(args) `` | Inline script body emitted as `scripts/__inline_<hash>`. |
| `prompt` | `prompt body [returns "<schema>"]` | Sends body to the agent backend; JSON-quoted in transport. |
| `match` | `match <subject> { … }` | Walks arms top-to-bottom; first match wins. |
| `shell` | Free-form def body line; raw shell fragment on a `send` payload | An unparsed line becomes an inline-shell `exec` step. Send: a raw shell fragment (e.g. `send echo "$payload" -> findings`) is a valid managed shell payload. `send` is the only position that accepts `shell`; it is `E_VALIDATE` anywhere else. |
| `bare_ref` | A bare symbol on a `send` RHS | Always rejected by the validator; preserved so the error can name the symbol. |

## Calls — execute a def or script
{: #run-execute-a-def-or-script}

Invoke a def or script with a **bare call**: the name (or an inline-script body) followed by `()` with any arguments. There is no `run` keyword. `save(path)`, `const x = save(path)`, `return save(path)`, `async save(path)`, and `` `echo hello`() `` are all calls. `run` is an ordinary identifier — `run()` calls a symbol named `run` — separate from the CLI verb `jaiph run` and the `run.recover_limit` config key.

| Position | Allowed target |
|---|---|
| Bare call | Def or named script. |
| `async` call | Defs and named scripts. Inline scripts not supported. |
| Inline-script call | Allowed. |

Capture rules:

| Callee | Captured value |
|---|---|
| Def | Explicit `return` value of the callee. |
| Named script | Trimmed stdout. |
| Inline script | Trimmed stdout. |

Call arguments:

| Form | Description |
|---|---|
| `"…"` double-quoted string | Single-line; `${ident}` / `${ident.field}` interpolation allowed. |
| `"""…"""` triple-quoted block | Opens `"""` as the first non-whitespace token on its own line. Body is dedented to the common leading margin. The formatter normalises the result to an inline double-quoted string (intentional — `Arg` nodes do not carry Trivia). |
| Bare identifier | In-scope binding (`const`, capture, parameter). Unknown names are `E_VALIDATE`. |
| Bare dotted `IDENT.IDENT` | Typed-prompt field access. Base must be a typed-prompt capture; field must appear in its `returns` schema (`E_VALIDATE` otherwise). |
| Nested call `ref(args)` | A call in argument position — `foo(bar())`. The inner call is evaluated and its captured value is passed as the argument. |

**Hard error contract:** a bare call whose `)` never closes (the file ends or the block closes first) is `E_PARSE` — such a line is **never** silently treated as an inline shell step. A leading `run` (`run name(args)`, `return run name()`, `const x = run name()`) is `E_PARSE` (`'run' is not a keyword`), and an assignment without `const` (`x = name()`) is `E_PARSE` (`assignment without "const" is no longer supported`). A `return` RHS that is not a string, identifier, call, `prompt`, or `match` is `E_PARSE`.

### Arguments and `stdin`
{: #arguments-and-stdin}

Script arguments arrive as argv (`$1`, `$2`, … in bash, or `sys.argv` in Python). argv and the environment together are bounded by the OS `ARG_MAX` limit, which is about 1 MB on macOS, so the spawn fails when an argument is too large. To pass a large or arbitrary value to a **script**, connect it to the call's stdin with the `stdin <value> -> ref()` form, as in `stdin content -> save_string_to_file(path)`. The value can be a string (bare identifier, `${…}` interpolation, or double-quoted), an output handle ([Value types](#value-types)) such as a `recover` / `catch` binding, or a **one-hop producer call** `stdin <call>() -> ref()` (the producer may be a def or a script). Jaiph writes the bytes to the script's stdin as UTF-8, never as argv, so the transfer is not bounded by `ARG_MAX`; a handle or producer streams from disk without being slurped into memory first.

The `stdin <value> ->` prefix precedes the call; a `const` capture (`const out = stdin content -> save(path)`) and a trailing `catch` / `recover` on the call both attach as usual. Once a value is a `const` string it is already slurped — `const x = fetch_log()` then `stdin x -> ref()` sends the in-memory string, whereas `stdin fetch_log() -> ref()` streams. The connect **target** is legal only on a call to a script, named or inline (`` stdin content -> `cat`() ``), and Jaiph rejects it anywhere else:

- A def or other non-script target is `E_VALIDATE`.
- `async` with `stdin` (either order) is `E_PARSE` (`async is not supported with stdin`).
- `stdin` with no value, or without a `-> ref()` target, is `E_PARSE`.

Chain more stages with `->` to build a **pipeline**, as in `stdin gen() -> upper() -> count()`. A pipeline is any `stdin` form whose producer is a call, or that has two or more `->` stages. A plain `stdin <value> -> script()` (one value, one script) is the connect form above, not a pipeline. The producer (left of the first `->`) is a value or a call to a **def or script**. Every stage after the first `->` is a **script** (named or inline), so a def in a consumer slot is `E_VALIDATE`. The script stages run **concurrently**: each stage's stdout streams into the next stage's stdin through a bounded, backpressured buffer, so producer and consumer overlap and no uncaptured stage's body is ever slurped into memory or spooled to a temp file and reread — a stage's `.out` capture ([Value types](#value-types)) is written straight to disk for audit, never also held as a string. A def producer is not a single process, so it runs to completion first and streams its on-disk handle in. Each script or def stage is its own step in the progress tree. If any stage exits non-zero the pipeline fails with that stage's error; a later stage that already started just reads end-of-input from the failed upstream. A `const` or `return` names and slurps the **last** stage, as in `const n = stdin gen() -> count()`, so the last stage should reduce. A pipeline takes **no** `recover` (`E_PARSE`). A one-shot `catch` is allowed and runs once for the failing stage.

This is a connect form — not a shell pipe (`|`) and not a `run` suffix. argv stays the default channel for small arguments, and a large argument is never moved to stdin for you.

### Inline scripts

Inline scripts embed a script body in a step without a separate `script` definition. Use single backticks for one-liners, and triple backticks for multiline bodies or bodies written in another language.

```jaiph
`echo hello`()
const x = `echo captured`()
const y = `date +%s`()
`echo $1-$2`("hello", "world")   # => hello-world
```

| Aspect | Rule |
|---|---|
| Backtick form | `${…}` Jaiph interpolation is `E_PARSE`. Use `$1`, `$2`, … |
| Fenced form | `${…}` passes through to the shell. Optional lang tag selects the interpreter (`` ```python3 `` → `#!/usr/bin/env python3`). |
| Mixing fence tag + manual shebang | Error. |
| Default shebang | `#!/usr/bin/env bash` when neither tag nor `#!` line is present. |
| Emitted name | `scripts/__inline_<12-hex>`; deterministic across runs. |
| `catch` / `recover` | Allowed on a standalone call step with inline-script body. Forbidden on inline scripts in `log` / `logerr` / `logwarn` / `return` / `const` RHS. |
| Subprocess env | Same sterile env as named scripts, minus `use` (inline scripts cannot request host keys). Module `const` values are not auto-exported — pass via `$1`, `$2`. |
| `async` | Not supported. |

### `async` — concurrent execution with handles
{: #run-async-concurrent-execution-with-handles}

`async ref(args)` starts the callee concurrently and returns a `Handle<T>` immediately. `T` is the same type a synchronous call would return.

```jaiph
export def main() {
  async lib.task_a()
  const h = async lib.task_b()
  log "${h}"      # forces resolution of h (blocks until task_b finishes)
}
```

| Aspect | Behaviour |
|---|---|
| Resolution trigger | First non-passthrough read — string interpolation, argument to a call, comparison in `if` / `match`, an interpolated prompt body embedding `${h}` in a larger string (a bare `prompt ${h}` streams instead — see [Value types](#value-types)), channel `send` payload referencing `${h}`, or `const copy = h` (bare-identifier RHS desugars to `"${h}"`). |
| Passthrough | Initial capture (`const h = async foo()`), bare `async` with no capture name. |
| Implicit join | When the enclosing `executeSteps` scope exits, all remaining unresolved handles created there are joined. Failures aggregate like a synchronous step. |
| `recover` / `catch` | Both work with the statement form of `async`, and `recover` uses the same retry-limit semantics as non-async `recover` (`run.recover_limit`). A captured `const h = async foo()` cannot carry `catch` / `recover`. Wrap the target in a def if you need them on a captured handle. |
| Inline scripts | Not supported with `async`. |
| Progress display | Each branch is prefixed with subscript digits (₁, ₂, …) at the call site's indent level, in dispatch order. Nested branches get their own numbering scope. |

See [Run work concurrently](async.md) for the operator recipe and [Spec — Async Handles](spec-async-handles.md) for the value model.

## `catch` and `recover`

Both attach to a call (any form). The binding is an **output handle** for the failed step's **stdout then stderr merged into one stream** ([Value types](#value-types)) — not a path and not an eager string. Force it and it slurps the merged **contents** (`logerr "${failure}"`, a call argument, an `if` subject); connect it and it streams (`stdin failure -> tail_log()`), so a multi-megabyte failed log never hits `ARG_MAX`. A typical Unix failure writes the useful text to stderr, so the merge means `${failure}` is non-empty even when the producer never did `2>&1` (that redirect stays legal and gives chronological interleave when the author wants it). The handle's bytes live in one on-disk capture; the recovery body never sees a `.jaiph/runs/…/NNNNNN-*.out` path.

```jaiph
check_report_exists() recover (failure) {
  logerr "report.txt is missing"
  stdin failure -> tail_log()
}
```

| Form | Loop | Allowed on |
|---|---|---|
| `catch (name) <body>` | Runs the recovery body once on failure. | a call (sync and async). |
| `recover (name) <body>` | Retries the target after each repair body until success or `run.recover_limit` (default `10`). | a call (sync and async). |

```jaiph
deploy() catch (err) rollback()

deploy(env) recover(err) {
  logerr "deploy failed; see ${err}"
  auto_repair(env)
}
```

Validation rules:

| Rule | Behaviour |
|---|---|
| Binding required | Exactly one binding. Bare `catch` / `recover` is `E_PARSE`. |
| Argument placement | All call arguments inside `()` before `catch` / `recover`. |
| Mutual exclusion | A single call step accepts `catch` or `recover` but not both. |
| Inline-script position | `catch` / `recover` only on standalone call steps. Forbidden on inline scripts in `log` / `logerr` / `logwarn` / `return` / `const` RHS. |

## `prompt` — agent interaction

Sends text to the configured agent backend. The body can take one of these forms:

| Body form | Syntax |
|---|---|
| Single-line literal | `prompt "Review the code"` |
| Identifier | `prompt my_text` (`my_text` must be in scope) |
| Bare ref | `prompt ${my_text}` or `prompt ${result.field}` — equivalent to identifier form |
| Triple-quoted | `prompt """\nMultiline body with ${vars}\n"""` |
| Named invocation | `prompt analyze(log)` — invokes a [named prompt](#named-prompts) definition. Parentheses select the invocation; bare `prompt analyze` (no `()`) stays the identifier form above. |

| Aspect | Rule |
|---|---|
| Capture | `const name = prompt …`. `name = prompt …` is `E_PARSE`. |
| Typed `returns` | Flat `{ field: type, … }` with `string` / `number` / `boolean`. Stored verbatim as text per-field. |
| Capture required when `returns` | `prompt … returns "…"` without `const` is `E_PARSE`. |
| Dot notation | Bare `result.field` (in `return`, `if` / `match` subjects, and call arguments) and `${result.field}` **inside strings** require that the base is a typed-prompt capture and the field appears in the schema. Unquoted `${result.field}` in call-argument position is `E_VALIDATE`. |
| Interpolation into shell steps | A prompt capture (`const x = prompt …`, typed or untyped) interpolated into an inline shell step — e.g. `echo "${x}"` as a free-form body line — is `W_PROMPT_IN_SHELL`. Shell steps run via `sh -c`, and the runtime shell-quotes every value it interpolates into the line, so an agent-controlled value reaches the shell as data and cannot inject a command; the diagnostic still fires to steer you to the argv path. Pass it as a script argument instead (`my_script(x)` → `$1`, which is argv, not shell-expanded). Only shell steps are flagged; `script(x)`, `log`, `logerr`, and non-prompt variables are not. |
| Transport retry | Transport failures retry on a backoff schedule; deterministic post-processing failures do not. See [Configuration — Prompt retry on transport failure](configuration.md#prompt-retry-on-transport-failure). |

### Named prompts

A **named prompt** is a module-level, parameterised prompt definition — the same shape as `script` / `def`, sharing the one namespace:

```
prompt analyze_ci(log) use GITHUB_TOKEN = """
  Look at this CI log:
  ${log}
"""
returns "{ summary: string }"

export def main() {
  const log = fetch_ci_log()
  const result = prompt analyze_ci(log)
  return result.summary
}
```

| Aspect | Rule |
|---|---|
| Body | Same forms as an anonymous `prompt` step — double-quoted single line or `"""…"""`. No triple-backtick fence. `${name}` in the body resolves against the prompt's own parameters and module-level `const`s (caller locals are not visible). |
| `returns` | Optional, on the definition (not the call site), same schema rules as a step-level `returns`. Invoking a `returns` named prompt without a `const` capture is `E_PARSE`. |
| `export` | Allowed (`export prompt …`), same visibility rules as `export script` / `export def`. |
| Invocation | `prompt name(args)` or `const x = prompt name(args)`; `prompt name()` for zero args. Bare `prompt name` (no `()`) is the identifier-as-body form. A bare call `name()` on a named prompt (without `prompt`) is `E_VALIDATE`. Arity must match (`E_VALIDATE`), including `()`. |
| `use KEY` | Same clause, reserved-key rules, and `--env` grant as `use` on a script. The requested keys are injected into that invocation's **agent** subprocess on top of the sterile prompt env; anonymous `prompt "…"` steps never receive `--env` secrets. Backend credentials (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, …) stay the default and are not written as `use`. Ungranted `use` keys fail `jaiph run` / `serve` / `mcp` preflight with `E_ENV_MISSING`; `jaiph test` does not hard-fail. |

### Nested declarations
{: #nested-declarations}

A def body may declare a **nested** `const`, `script`, `def`, or named `prompt`
— the same surface as at module level — to scope a helper to the one def that
uses it instead of the module namespace:

```
export def main() {
  const greeting = "hi"

  script shout = `echo "$1"`

  def helper(name) {
    return "helped-${greeting}-${name}"
  }

  prompt describe(x) = "Describe ${greeting} for ${x}"

  const h = helper("bob")
  shout(greeting)
}
```

| Aspect | Rule |
|---|---|
| Where | `const` / `script` / `def` / named `prompt` inside a def body. **No `export`** (`E_PARSE`). `import` and `channel` stay module-level; a def-level `config` block is separate metadata that must precede the first step. Inside a **nested** def — including `if` / `for` / `catch` / `recover` bodies — `import` / `import script` and a `config { … }` block are `E_PARSE` (same class as `export`), never silent shell lines. |
| Scope | Sequential local binding, **not hoisted**: visible only in the declaring body and only **after** its declaration (using it earlier is `E_VALIDATE`). A duplicate name in the same body or a collision with a parameter is `E_VALIDATE` (`cannot rebind immutable name`). |
| In-branch decls | A nested `const` / `script` / `def` / `prompt` **is allowed** inside an `if` / `else` / `else if` / `for` / `catch` / `recover` body, and is **block-scoped to that body**: after the branch ends the name is out of scope, so a later call / `prompt` / `${name}` / bare arg naming it is `E_VALIDATE`. Each body is its own scope — `if { script s = … }` and `else { script s = … }` are two independent locals (not `cannot rebind`), and a `${r.field}` typed by a `returns` prompt captured inside a branch is legal only within that branch. |
| Shadowing | A nested name **may shadow** a module-level `script` / `def` / `prompt`, or an enclosing def / branch name, of the same name; the local binding wins for the rest of that body, and the outer binding is visible again after it. Another def cannot call / `prompt` a name declared only inside a different def (`E_VALIDATE`). |
| Calls | `name(args)` for a nested script or def (`async name(args)` allowed for a nested def); `prompt name(args)` for a nested named prompt. |
| Nested `def` | Interpreted in-process; interpolates the enclosing def's params and `const`s (lexical scope) plus its own params. An enclosing `const` is visible only if declared before this nested `def`; a `${…}` of a later enclosing `const` is `E_VALIDATE` (unknown identifier). Does not inherit a parent `use`. A nested `def` may call **itself** (self-recursion, bounded by the runtime recursion-depth cap); it may **not** call a sibling nested `def` declared later in the same body (still `E_VALIDATE` unknown local — declarations are sequential, not hoisted). |
| Nested `prompt` | Body interpolated at invocation from the enclosing scope (params visible, plus enclosing `const`s declared before this nested `prompt` — a `${…}` of a later one is `E_VALIDATE`) plus its own params; its `use` is the only extra host-key injection for that agent spawn. |
| Nested `script` | Still a subprocess: enclosing bindings are **not** auto-exported into its env — pass argv (`inner(param)` → `$1`). Sterile env + its own `use` + `--env` grant, same as a module-level script. |

## `const` — bind a value

```jaiph
const tag = "v1.0"
const message = """
  Hello ${name}
"""
const result = helper(arg)
const check = validator(input)
const answer = prompt "Summarize"
const label = match status {
  "ok" => "success"
  _ => "failure"
}
```

| RHS form | Notes |
|---|---|
| Double-quoted string | Single-line. A double-quoted value does not span lines. Use a triple-quoted block for multiline text. |
| Triple-quoted block | Multiline; supports `${…}`. |
| Call / `async` call | Managed capture — `const x = helper(arg)`, `const h = async task()`. |
| `prompt` (any body form) | Optional `returns` schema. |
| `match` expression | Walks arms; first match wins. |
| Leading `run` (`const x = run ref()`) | `E_PARSE` (`'run' is not a keyword`) — capture the call directly. |
| `$(…)`, `${var:-fallback}`, etc. | `E_PARSE` in `const` RHS. |

All bindings — parameters, `const`, captures, `script` names — are immutable in their scope. The validator names the conflicting binding and its origin (`E_VALIDATE: cannot rebind immutable name "x"; already bound as parameter at file.jh:1`).

A `const` is sequential, not hoisted: naming it before its declaration is `E_VALIDATE` (unknown identifier) in a `${…}` interpolation, a call or `prompt` argument, and an `if` / `match` subject, not only in a call or `prompt` target.

## `return` — managed return value

```jaiph
return "success"
return "${result}"
return response                  # sugar for return "${response}"
return helper()
return check(input)
return match status { "ok" => "pass", _ => "fail" }
return prompt "summarize ${log}"
return `cat report.txt`()
```

| Form | Notes |
|---|---|
| String / triple-quoted | Verbatim with interpolation. |
| Bare identifier | Sugar for `return "${ident}"`. Unknown identifier is `E_VALIDATE`. |
| `return ref()` | Managed direct return. Requires `()`. `return helper` without parens is `E_PARSE`; leading `return run helper()` is `E_PARSE` (`'run' is not a keyword`). |
| `` return `…`(args) `` | Inline-script direct return. |
| `return match … { … }` | Match expression as the return value — compact one-line or multiline `{` opener. `return` inside an arm body is forbidden. |
| `return prompt …` | Prompt expression as the return value (same body forms as `const x = prompt …`). |
| Position | Only in `def` bodies. Script bodies use `echo`/`printf`; bare `return 0` / `return $?` in a script are shell exit codes. |

## `send` — channel message

```jaiph
send "Build started" -> alerts
send ${output} -> reports
send build_message(data) -> results
send """
  Build report for ${project}
""" -> alerts
```

| Rule | Behaviour |
|---|---|
| Payload required | `send -> channel` is `E_PARSE`. |
| Allowed payload | Double-quoted string, triple-quoted block, `${ident}` / `${…}`, a call `ref(args)` (with parens). |
| Shell fragment payload | A raw shell fragment (e.g. `send echo "$payload" -> findings`) is a managed shell payload — allowed only on `send`. |
| Bare ref payload | A bare def / script name is `E_VALIDATE`. |
| Combined capture | `name = send …` is `E_PARSE`. |
| Allowed in | Defs. |
| Dispatch | `send` enqueues on the active def context. After that def's steps complete successfully, the runtime drains the queue sequentially and runs each route target. Sends from nested defs bubble to the nearest ancestor context that declares routes for the channel. See [Inbox & Dispatch](inbox.md). |

## `log` / `logerr` / `logwarn` / `fail`

```jaiph
log "Processing ${message}"
logerr "Error: ${name} not found"
logwarn "Slow response from ${name}"
log status                       # bare identifier — same as log "${status}"
log ${status}                    # bare ref — same as log "${status}"
log `date +%s`()                 # inline-script form (bare call)
log """
  Build started at ${timestamp}
"""
fail "Missing configuration"
fail ${error_msg}                # bare ref — same as fail "${error_msg}"
```

| Statement | Effect |
|---|---|
| `log` | Writes to the run's stdout stream. Double-quoted messages store backslash sequences literally; use triple-quoted `log """…"""` for multiline text. |
| `logerr` | Writes to stderr. Displayed with `!` marker in the progress tree. |
| `logwarn` | Writes to stderr. Displayed with `⚠` marker in the progress tree. |
| `fail` | Aborts the def with a stderr message and non-zero exit. |

An inline script in `log` / `logerr` / `logwarn` uses the bare-call form (`` log `…`(args) ``); there is no `run` prefix.

## `if` — conditional guard

```jaiph
if status == "ok" {
  log "healthy"
} else {
  logerr "unhealthy: ${status}"
}

if message =~ /ERROR/ {
  logerr "matched error pattern"
}

if status == "ok" {
  log "healthy"
} else if status == "warn" {
  logwarn "degraded"
} else {
  logerr "unhealthy: ${status}"
}
```

| Aspect | Rule |
|---|---|
| Subject | Bare identifier or `IDENT.IDENT` (typed-prompt field access). |
| Operators | `==`, `!=` with double-quoted strings; `=~`, `!~` with `/regex/`. Mixing kinds is `E_PARSE`. |
| `else` / `else if` | Optional. `} else {` and each `} else if <cond> {` must be on a single line (the closing `}` of the previous arm and the keyword share the line). An `else if` chain of any depth is sugar that desugars to nested `if`/`else`; each `else if` uses the same condition grammar as `if`. An empty `else if` body, an `else if` without a condition, or an `else if` split onto its own line is `E_PARSE`. |
| Value production | `if` is a statement. For value branching use `match`. |
| Async handles | Resolved before the comparison. |
| Allowed in | Defs. |

## `match` — pattern match

```jaiph
match cmd {
  "" | "check" => "verify"
  "ok" => "all good"
  /err/ => "something went wrong"
  _ => "unknown"
}
```

| Aspect | Rule |
|---|---|
| Subject | Bare identifier or `IDENT.IDENT`. `$var` / `${var}` is `E_PARSE`. |
| Patterns | String literal (exact equality), `/regex/`, or `_` (wildcard — exactly one required). |
| Alternation | `"a" \| "b" \| /^c/ => body` — pipe-separated string literals and/or regexes share one arm, which matches if **any** alternand matches (OR). String and regex alternands may be mixed. Arm order still decides ties (first matching arm wins). `_` cannot participate (`_ \| "x"` / `"x" \| _` are `E_PARSE`); a trailing `\|` before `=>` is `E_PARSE`. |
| Arm delimiter | Two forms, with different delimiters. In the multiline block form (`match x { … }` spread over its own lines) arms are one per line, or `;` to place several on one line, and commas are `E_PARSE`. In the compact one-line form (`const x = match s { "a" => "b", _ => "c" }`) arms are comma-separated, and `;` or a newline is `E_PARSE`. |
| Arm bodies | String literal, triple-quoted block, bare in-scope identifier, `$var` / `${var}`, `fail "…"`, a call `ref(…)`. |
| Disallowed in arms | `return` (use `return match … { … }` outside), inline scripts, unknown bare identifiers (`E_VALIDATE: unknown identifier "…" in match arm body; declare it with "const", use a capture, or add a parameter`). |
| Expression form | Usable with `const x = match …` or `return match …`. |

When a `const x = match …` step contains arms with calls, the progress tree surfaces the called targets as child steps of the `const` row.

## `for` — iterate lines of a string

```jaiph
const paths = """
docs/a.md
docs/b.md
"""

for path in paths {
  log "${path}"
}
```

| Aspect | Rule |
|---|---|
| Source variable | Must already hold a string (`const`, capture, parameter). Unknown name is `E_VALIDATE`. |
| Line splitting | Splits on `\n` (normalises `\r\n`). A trailing newline does not yield an empty final line. Interior empty lines are yielded. |
| Iterator name | Block-scoped to the loop body. After the loop it is out of scope, so naming it is `E_VALIDATE`. An iterator name that collides with an existing binding is `E_VALIDATE` (`for loop iterator "<x>" conflicts with an existing binding`). |
| Allowed in | Defs. |

## String interpolation

**Global three-form rule:** Every Jaiph string position — `config`, `log`, `logerr`, `logwarn`, `fail`, `prompt`, `const`, `return`, `send`, and any other orchestration string — accepts three equivalent forms for a single variable reference:

| Author writes | Stored / AST form | Resolves at runtime |
|---|---|---|
| `model` (bare identifier) | `${model}` | yes |
| `"${model}"` (quoted) | `${model}` (string content) | yes |
| `${model}` (bare ref) | `${model}` | yes |
| `"prefix-${model}"` (quoted with prefix) | literal with embedded ref | yes |
| `${model.field}` (bare dotted ref) | `${model.field}` | yes |

No string-RHS site accepts two of these but rejects the third.

| Form | Status | Where |
|---|---|---|
| `${ident}` | Primary | All orchestration strings. |
| `${var.field}` | Typed-prompt field access | All orchestration strings. |
| `${ref(args)}` | Inline capture — executes and inlines stdout / return value. | All orchestration strings. |
| `$ident` (no braces) | `E_PARSE` in `log` / `logerr` / `logwarn` / `fail` / `prompt` / `return` / `send` / `config`. In a `const` RHS a bare `$` is stored verbatim, not treated as a reference. | — |
| `$1`, `$2`, … | Positional args | `script` bodies only (interpretation depends on the interpreter). |
| `${var:-fallback}` (and `:+`, `:=`, `:?`) | `E_PARSE` in every orchestration string (`const`, `log`, `logerr`, `logwarn`, `fail`, `prompt`, `return`, `send`, `config`). Passes through unchanged in backtick and fenced scripts. | — |
| `${var%%…}`, `${var//…}`, `${#var}` | `E_PARSE` in `const` RHS only. In other orchestration strings and in backtick / fenced scripts they pass through unchanged. | — |
| `$(…)` | `E_PARSE` in orchestration strings. | — |

If an inline capture fails, the enclosing step fails. Nested inline captures (`${foo(${bar()})}`) are `E_PARSE` — extract the inner call to a `const`.

Values interpolated into an inline shell step (a free-form body line that runs via `sh -c`) are shell-quoted first, so a value that contains shell metacharacters is passed to the shell as data and cannot inject a command. Every other string position interpolates the raw value.

## Subprocess environment

Managed script steps (a call to a named script, `import script`, inline scripts) and def inline-shell lines run in a **sterile** environment: a subprocess receives only process mechanics, the `JAIPH_*` script-runtime contract keys, and the host keys named in its own declaration's `use` clause (and only when the operator granted each with `--env`). A def in the call tree neither grants nor denies keys — only each script's own declaration counts — and an inline-shell line has no declaration, so it can carry no `use`. This contract is spawn-env only: a `cursor` or `claude` prompt that can run tools is the same user as `jaiph` and is not confined to that child `env`. The full base set, the reserved names that stay with the runner, and the `E_ENV_*` codes are in [Environment variables — Script subprocess environment](env-vars.md#script-env); see also [Pass a host key to a script](script-env.md) and [Why Jaiph](why-jaiph.md).

Module `const` values are **not** automatically exported into script environments. Pass them as positional arguments (`$1`, `$2`, …) or read Jaiph-provided variables.

## Step output contract

| Step | Status | Capture value | Logs |
|---|---|---|---|
| Call (def) | def exit code | explicit `return` value | def artifacts |
| Call (script, named) | script exit code | trimmed stdout | script `.out` / `.err` |
| `` `…`() `` (inline) | script exit code | trimmed stdout | script `.out` / `.err` |
| `prompt` | prompt exit code | final assistant answer | transcript artifacts |
| `log` / `logerr` / `logwarn` | always 0 | empty | event stream + stdout/stderr |
| `fail` | non-zero (abort) | empty | stderr |
| `async` call | aggregated | `Handle<T>` resolving on read | async step artifacts |
| `const` | same as RHS step | empty (binds local) | n/a |

## Recursion limit

The runtime enforces a hard recursion depth limit of `256` (`MAX_RECURSION_DEPTH` in `src/runtime/kernel/runtime-arg-parser.ts`). Exceeding the limit produces a runtime error. The depth counts the active chain of managed calls, which is the nested calls to defs plus the current script leaf when one is running. A script runs as a subprocess and cannot call back into the runtime, so it adds at most one level and never recurses on its own. There is no environment variable override.

## Related

- [Grammar](grammar.md) — formal EBNF, lexical rules, validation catalog.
- [Configuration](configuration.md) — config keys consumed at runtime.
- [Inbox & Dispatch](inbox.md) — `send` queueing and route execution semantics.
- [Run work concurrently](async.md) — operator recipe for `async`.
- [Spec — Async Handles](spec-async-handles.md) — handle resolution and join semantics.
- [Pass a host key to a script](script-env.md) — `use` + `--env` recipe.
- [Environment variables](env-vars.md) — variables visible to defs and scripts.
