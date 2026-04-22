---
title: Grammar
permalink: /grammar
redirect_from:
  - /grammar.md
---

# Jaiph Grammar

Jaiph source files (`.jh`) combine a small orchestration language with shell execution. **Workflows** and **rules** express Jaiph steps — sequencing, failure handling (`catch`), value branching (`match`), prompts, channels. **Scripts** contain Bash (or another interpreter via shebang) and run as isolated subprocesses. The runtime interprets the AST directly; only script bodies are emitted as executable files. This page is the language reference. For system boundaries and event contracts, see [Architecture](architecture).

**Scope:** Lexical rules, syntax, and runtime semantics for normal modules (`.jh`). Test files (`*.test.jh`) are described in [Testing](testing.md). CLI and configuration are covered in [CLI](cli.md) and [Configuration](configuration.md).

**Source of truth:** When this document and the compiler disagree, treat the implementation as authoritative.

## Types

Jaiph has two primitive value types — **string** and **script** — that are structurally distinct and non-interchangeable.

**String** is the general-purpose value type. Strings can be interpolated (`${name}`), passed as arguments, assigned to `const` bindings, and sent to an agent via `prompt`. All `const` declarations, `env` declarations, captures, and named parameters produce string values.

```jaiph
const greeting = "Say hello to ${name}."
prompt greeting       # valid — strings are promptable
prompt "Say hello."   # valid — inline string literal
# run greeting()     — E_VALIDATE: strings are not executable
```

**Script** is an executable unit. Scripts are invoked with `run` and execute as isolated subprocesses. They cannot be interpolated, assigned to variables, or used as prompt bodies — they are definitions, not values.

```jaiph
script save = `printf '%s' "$1" > "$2"`
run save(content, path)   # valid — scripts are executable
# prompt save             — E_VALIDATE: scripts are not promptable
# const x = save          — E_VALIDATE: scripts are not values
# log "${save}"           — E_VALIDATE: scripts cannot be interpolated
```

The compiler enforces these boundaries at every call site. Using a script where a string is expected (or vice versa) produces an `E_VALIDATE` error with a clear, actionable message.

## Language Concepts

Jaiph enforces a strict boundary between orchestration and execution. Workflows and rules contain only Jaiph steps. Bash lives in `script` bodies.

- **Workflows** — Named sequences of Jaiph steps: `ensure`, `run`, `prompt`, `const`, `fail`, `return`, `log`/`logerr`, inbox `send` (`channel <- …`), `match`, `if`, `run async`, `ensure … catch`, `run … catch`, and `run … recover`. Any line that is not a recognized step is a parse error — extract bash to a `script` and call it with `run`.

- **Rules** — Named blocks of structured Jaiph steps: `ensure` (other rules), `run` (scripts only — not workflows), `const`, `match`, `if`, `fail`, `log`/`logerr`, `return "…"`, `ensure … catch`, `run … catch`. Rules cannot use `prompt`, inbox send/route, or `run async`.

- **Scripts** — Top-level `script` definitions emitted as separate executable files under the workspace `scripts/` directory. Called from workflows or rules with `run`. Bodies are opaque to the compiler — the parser does not check Jaiph keywords inside them. Use `echo`/`printf` for data output and `return N`/`return $?` for exit status. Jaiph interpolation (`${...}`) is forbidden in script bodies — use `$1`, `$2` positional arguments instead. Polyglot support: a fence lang tag (`` ```<tag> ``) maps to `#!/usr/bin/env <tag>` — any tag is valid (no hardcoded allowlist). Alternatively, a manual `#!` shebang as the first line of the body selects the interpreter; if both a fence tag and a `#!` first line are present, it is an error. Without either, `#!/usr/bin/env bash` is used. For trivial one-off commands, **inline scripts** (`` run `body`(args) `` or `` run ```lang...body...```(args) ``) let you embed a script body directly in a step without a named definition — see [`run` — Inline Scripts](#inline-scripts).

- **Channels** — Named message queues declared at top level with `channel name`. Optionally declare inline routes with `channel name -> workflow` or `channel name -> wf1, wf2`. Workflows send messages with `<-`. See [Inbox & Dispatch](inbox.md).

- **Config** — Optional block setting agent and run options. Allowed at module level and inside individual workflow bodies. See [Configuration](configuration.md).

## Imports and Exports

`import "path" as alias` loads another module. `export rule` / `export workflow` / `export script` marks a declaration as public.

**Export visibility.** If a module contains at least one `export` declaration, only exported names are reachable through the import alias — referencing a non-exported symbol produces `E_VALIDATE`: `"<name>" is not exported from module "<alias>"`. Modules with zero `export` declarations retain legacy behavior: all top-level definitions are implicitly public.

```jaiph
import "tools/security.jh" as security
import "bootstrap.jh" as bootstrap

export script build_docs = `mkdocs build`

export workflow default() {
  ensure security.scan_passes()
  run bootstrap.nodejs()
}
```

Imported symbols use **dot notation**: `alias.name`. A reference is either a bare `IDENT` (local) or `IDENT.IDENT` (module-qualified). The compiler validates that the target exists and matches the calling keyword (`ensure` for rules, `run` for workflows/scripts).

### Script Imports

`import script "<path>" as <name>` imports an external script file and binds it to a local script symbol. The imported script behaves exactly like a locally declared `script` definition — callable with `run`, capturable with `const`, and subject to the same subprocess isolation rules.

```jaiph
import script "./queue.py" as queue

workflow default() {
  const result = run queue("get")
  log result
}
```

The target file is treated as complete script source (not as a Jaiph module). Shebangs in the imported file are preserved — the runtime uses them to select the interpreter, just like fence lang tags on inline scripts. The file must exist; missing targets fail at compile time with `E_IMPORT_NOT_FOUND`.

Script import aliases share the unified per-module namespace with channels, rules, workflows, scripts, and top-level `const` — duplicates are `E_PARSE`.

**Path resolution.** The path is always resolved relative to the importing `.jh` file's directory, not the process working directory. The path must be double-quoted (single quotes are rejected).

### Import Resolution

Module import paths (`import "path" as alias`) resolve in two stages:

1. **Relative to the importing file** (existing behavior). The `.jh` extension is appended if omitted.
2. **Library fallback.** If relative resolution finds no file and the path contains a `/`, it is split as `<lib-name>/<path-inside-lib>` and resolved to `<workspace-root>/.jaiph/libs/<lib-name>/<path-inside-lib>.jh`. Libraries are installed with `jaiph install` (see [CLI — `jaiph install`](cli.md#jaiph-install)).

```jaiph
import "queue-lib/queue" as queue       # resolves to .jaiph/libs/queue-lib/queue.jh
import "tools/security.jh" as security  # resolves relative (unchanged)
```

Script import paths (`import script "<path>" as name`) resolve relative to the importing file only — there is no library fallback. The path refers to a raw script file (e.g. `.py`, `.sh`), not a `.jh` module.

Missing imports fail at compile time with `E_IMPORT_NOT_FOUND`.

## Module-Level Declarations

### Top-Level `const`

`const name = value` declares a module-scoped variable. Values can be double-quoted strings (single-line only), triple-quoted strings (multiline), or bare tokens like numbers. A double-quoted string that spans multiple lines is rejected — use `"""..."""` instead.

```jaiph
const REPO = "my-project"
const MAX_RETRIES = 3
const GREETING = """
Hello,
world
"""
```

Variables are accessible as `${name}` inside that module's rules and workflows. They are **not** passed to script subprocesses — use arguments or shared libraries instead. Declaration order matters: `${name}` in a value only expands variables already bound above. Names share the unified namespace with channels, rules, workflows, and scripts.

Top-level `local` is rejected — use `const`.

### Channel Declarations

```jaiph
channel alerts
channel reports
channel findings -> analyst
channel events -> handler_a, handler_b
```

One channel per line. Channels are used with `send` (`<-`) inside workflows. Routes (`->`) are declared inline on the channel declaration — when a message arrives on the channel, the runtime calls each target workflow. See [Inbox & Dispatch](inbox.md).

## Definitions

Rules and workflows use braces on the declaration line and **must include parentheses** — even when parameterless (e.g. `rule check()`, `workflow default()`). The parser rejects definitions without `()` before `{` with a fix hint. Call sites, in contrast, allow omitting parentheses when passing zero arguments (`run setup` = `run setup()`). Scripts use `=` with a backtick body (single-line) or fenced block (multi-line). Rules and workflows may declare **named parameters** inside the parentheses.

```jaiph
rule check_status() { … }              # no params — () required
workflow default() { … }               # no params — () required
rule gate(path) { … }                 # one named param
workflow implement(task, role) { … }  # two named params
script setup = `echo ok`               # correct (single-line backtick)
script setup = ```                     # correct (fenced block)
echo ok
```
```

## Call Arguments and Named Parameters

### Named Parameters on Definitions

All workflow and rule definitions require parentheses. Named parameters go inside the parentheses; empty `()` is used when there are no parameters:

```jaiph
workflow implement(task, role) {
  log "Implementing ${task} as ${role}"
}

rule gate(path) {
  run check_exists(path)
}
```

Parameter names follow identifier rules (`[A-Za-z_][A-Za-z0-9_]*`), must not be reserved keywords, and must be unique within the parameter list. Empty parentheses `()` are required on **definitions** even when there are no parameters — omitting them is a parse error. At **call sites**, parentheses are optional for zero-arg calls.

At runtime, named parameters are the only way to access arguments: if `workflow implement(task, role)` is called with `run implement("build docs", "writer")`, then `${task}` = `"build docs"` and `${role}` = `"writer"`.

### Call-Site Arguments

Parentheses are **required** for all call sites — `run setup()`, `ensure gate()`, etc. Bare identifiers without parentheses (e.g. `run setup`) are `E_PARSE`. When arguments are present, they are comma-separated expressions inside the parentheses:

```jaiph
run setup()                            # zero args
run implement("my-task", "my-role")    # with args
ensure gate(path)                      # with args
```

**Bare identifier arguments:** In-scope variable names must be passed as bare identifiers without quoting. A bare identifier `name` is equivalent to `"${name}"` — the variable's value is passed as the argument:

```jaiph
const task = run get_next_task()
run docs.update_from_task(task)          # correct: bare identifier
run queue.remove(task, "completed")      # mixed bare + quoted literal
ensure check_branch(branch_name)         # works with ensure too
```

This rule applies to all call sites: `run`, `ensure`, `return run`/`return ensure`, `send … <- run`, and `const x = run …`. Quoted strings with additional text around the interpolation (e.g. `"prefix_${name}"`) are allowed since they cannot be expressed as bare identifiers.

Bare identifiers must reference a known variable (`const`, capture, or named parameter). Unknown names produce an `E_VALIDATE` error at compile time. Jaiph keywords (`run`, `ensure`, `const`, etc.) cannot be used as bare identifier arguments.

### Nested Managed Calls in Arguments

Call arguments can contain **explicit nested managed calls** using `run` or `ensure`. The nested call executes first and its result is passed as a single argument to the outer call. This is a deliberate language rule: managed execution must always be explicit — scripts and workflows execute only via `run`, rules only via `ensure`, even inside argument lists.

**Valid explicit forms:**

```jaiph
run mkdir_p_simple(run jaiph_tmp_dir())      # nested run
run do_work(ensure check_ok())               # nested ensure
run do_work(run `echo aaa`())                # nested inline script
```

**Invalid bare call-like forms** — rejected at compile time with actionable errors:

```jaiph
# run do_work(bar())           — E_VALIDATE: nested managed calls must be explicit
# run do_work(rule_bar())      — E_VALIDATE: nested managed calls must be explicit
# run do_work(`echo aaa`())    — E_VALIDATE: nested inline scripts must be explicit
```

The **capture-then-pass** form is always valid:

```jaiph
const x = run bar()
run foo(x)
```

### Arity Checking

When the callee declares named parameters, the compiler validates that the number of arguments at the call site matches the number of declared parameters. A mismatch produces an `E_VALIDATE` error:

```jaiph
workflow greet(name) { log "Hello ${name}" }

workflow default() {
  run greet("Alice")              # OK: 1 arg, 1 param
  # run greet("Alice", "Bob")    — E_VALIDATE: expects 1 argument(s) (name), but got 2
  # run greet()                  — E_VALIDATE: expects 1 argument(s) (name), but got 0
}
```

Arity checking applies to all `run` and `ensure` call sites (steps, captures, `return run`/`return ensure`, and `send` RHS), including the bare form (`run ref` = zero arguments). When the callee has no declared parameters (legacy style), no arity check is performed — any number of arguments is accepted.

Arguments are available as `${paramName}` in orchestration strings (rules and workflows) and `$1`, `$2`, … in script bodies.

## Workflow Steps

### `run` — Execute a Workflow or Script

In a **workflow**, `run` targets a workflow or script. In a **rule**, `run` targets a script only.

```jaiph
run setup_env                          # bare form — same as run setup_env()
run setup_env()                        # explicit parens — also valid
run lib.build_project(task)
result = run helper(arg)
const output = run transform
```

Shell redirection or pipelines after `run` (`>`, `|`, `&`) are rejected — use a script for shell I/O.

**Capture:** For a workflow callee, capture gets the explicit `return "…"` value. For a script callee, capture gets stdout.

#### Inline Scripts

Inline scripts embed a shell command directly in a workflow or rule step without declaring a named `script` definition. Use single backticks for one-liners or triple backticks for multiline bodies. Arguments go in parentheses after the closing backtick(s).

```jaiph
workflow default() {
  run `echo hello`()
  x = run `echo captured`()
  const y = run `date +%s`()
  log "got: ${x}, time: ${y}"
}
```

Optional arguments are passed as comma-separated expressions inside the parentheses after the closing backtick and are available as `$1`, `$2`, … inside the script:

```jaiph
run `echo $1-$2`("hello", "world")   # prints: hello-world
```

**Fenced block form:** For multiline inline scripts or polyglot one-liners, use triple-backtick fences. An optional lang tag selects the interpreter — same rules as named scripts (`` ```<tag> `` → `#!/usr/bin/env <tag>`). Arguments go in parentheses after the closing fence:

```text
run ```
echo "line one"
echo "line two"
```()
```

```text
run ```python3
import sys
print(f"args: {sys.argv[1:]}")
```()
```

Both body forms work with capture:

```jaiph
x = run `echo captured`()
const y = run ```
date +%s
```()
```

**Deterministic naming:** Inline script bodies are emitted as executable files under `scripts/` with names of the form `__inline_<hash>` (12-character SHA-256 prefix of body + shebang). The same body and shebang always produce the same artifact name across runs.

**Isolation:** Inline scripts run with the same subprocess isolation as named scripts — no parent scope variables are visible. Only positional arguments and essential Jaiph variables (`JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`) are inherited.

**Restrictions:**
- `run async` with inline scripts is not supported — inline scripts cannot be used with `run async`.
- **Backtick** (single-line) inline scripts: Jaiph interpolation (`${...}`) is forbidden — use `$1`, `$2` positional arguments instead.
- **Fenced block** (triple-backtick) inline scripts: `${...}` is passed through to the shell as standard shell parameter expansion.

### `run async` — Concurrent Execution with Handles

`run async ref(args)` starts a workflow or script concurrently and returns a **`Handle<T>`** immediately. `T` is the same return type the function would have under a synchronous `run`. The handle resolves to the eventual return value on first non-passthrough read.

```jaiph
workflow default() {
  run async lib.task_a()
  const h = run async lib.task_b()
  # Reading h forces resolution — blocks until task_b completes
  log "${h}"
  # task_a is implicitly joined before workflow returns
}
```

**Resolution semantics:** A handle resolves on first non-passthrough read. Reads that force resolution: string interpolation (`"${h}"`), passing as argument to `run`, comparison/conditional (`if h == "ok"`), match subject, channel send. Passthrough (initial capture, re-assignment) does not force resolution. Once resolved, the handle is replaced by the resolved string value; subsequent reads return the cached value.

**Implicit join:** When a workflow scope exits, all remaining unresolved handles created in that scope are implicitly joined. This is not an error.

**`recover` and `catch` composition:** Both `recover` (retry loop) and `catch` (single-shot) work with `run async`:

```jaiph
run async foo() recover(err) {
  log "repairing: ${err}"
  run fix_it()
}

run async bar() catch(e) {
  log "caught: ${e}"
}
```

`recover` uses the same retry-limit semantics as non-async `recover` (default 10, configurable via `run.recover_limit`).

In the progress tree, each async branch is prefixed with a subscript number (₁₂₃…) assigned in dispatch order. Nested `run async` inside a child workflow gets its own numbering scope at the child's indent level. See [CLI — Async branch numbering](cli.md#run-progress-and-tree-output) for display details.

See [Spec: Async Handles](spec-async-handles) for the full value model.

Constraints:
- Workflow-only — rejected in rules with `E_VALIDATE`.
- Inline scripts not supported with `run async`.
- For concurrent bash (pipelines, `&`), put the bash in a script and call with `run`.

### `ensure` — Execute a Rule

`ensure` runs a rule and succeeds if its exit code is 0.

```jaiph
ensure check_deps                      # bare form — same as ensure check_deps()
ensure check_deps()                    # explicit parens — also valid
result = ensure lib.validate(input)
```

### `ensure … catch` — Failure Recovery

When `ensure` includes a `catch` clause, a failure in the rule triggers the recovery body **once**. There is no retry loop — the rule runs, and if it fails, the recovery body executes a single time.

`catch` requires **explicit bindings** in parentheses — bare `catch` without bindings is `E_PARSE`:

```jaiph
# Single-statement recovery — one binding
ensure install_deps() catch (failure) run fix_deps()

# Block recovery — one binding
ensure ci_passes(repo) catch (failure) {
  log "CI failed, attempting fix"
  run auto_fix()
}

```

**Bindings:**
- The binding (e.g. `failure`) receives the merged stdout+stderr from the failed rule execution, including output from nested scripts and rules.
- Binding names must be valid identifiers. Exactly one binding is required.

Syntax rules:
- `catch` must be followed by `(<name>)` — bare `catch` or `catch {` without bindings is `E_PARSE`.
- All rule arguments must appear inside the call parentheses **before** `catch`.
- `catch` must be followed by at least one recovery step after the bindings.

### `run … catch` — Failure Recovery for Scripts and Workflows

`run` also supports a `catch` clause with the same semantics as `ensure … catch`. When the target script or workflow fails, the recovery body runs **once**.

```jaiph
# Single-statement recovery
run deploy() catch (err) run rollback()

# Block recovery
run deploy(env) catch (err) {
  log "Deploy failed, rolling back"
  run rollback(env)
}

```

**Bindings** follow the same rules as `ensure … catch`:
- The binding receives the merged stdout+stderr from the failed execution.
- Exactly one binding is required.

Syntax rules:
- `catch` must be followed by `(<name>)` — bare `catch` or `catch {` without bindings is `E_PARSE`.
- All call arguments must appear inside the parentheses **before** `catch`.
- `catch` must be followed by at least one recovery step after the bindings.

### `run … recover` — Repair-and-Retry Loop

`recover` adds loop semantics to a `run` step. Unlike `catch` (which runs the recovery body once and stops), `recover` retries the target after each repair attempt until it succeeds or the retry limit is exhausted.

```jaiph
# Single-statement recover
run deploy() recover(err) run fix_deploy()

# Block recover
run deploy(env) recover(err) {
  log "Deploy failed: ${err}"
  run auto_repair(env)
}
```

**Loop behavior:**

1. Execute the `run` target.
2. If it succeeds, continue (the `recover` body never runs).
3. If it fails, bind merged stdout+stderr to the binding (e.g. `err`), execute the repair body, then go to step 1.
4. If the retry limit is reached and the target still fails, the step fails with the last error.

**Retry limit:** Default is **10**. Override per-module with `run.recover_limit`:

```jaiph
config {
  run.recover_limit = 3
}
```

**Bindings** follow the same rules as `catch`:
- Exactly one binding is required. The binding receives merged stdout+stderr from the failed execution.

Syntax rules:
- `recover` must be followed by `(<name>)` — bare `recover` or `recover {` without bindings is `E_PARSE`.
- All call arguments must appear inside the parentheses **before** `recover`.
- `recover` must be followed by at least one recovery step after the bindings.
- `recover` and `catch` are mutually exclusive on the same `run` step.
- `recover` is not supported on `ensure` steps. `recover` works with `run async` — see [`run async`](#run-async--concurrent-execution-with-handles).

### `prompt` — Agent Interaction

Sends text to the configured agent backend. The prompt body can be supplied in three forms: a single-line string literal, a bare identifier referencing an existing binding, or a triple-quoted multiline block.

**1. Single-line string literal**

A double-quoted string on one line. `${...}` interpolation works inside the quotes.

```jaiph
prompt "Review the following code for security issues"
answer = prompt "Summarize the report"
```

If a `"` string has no closing quote on the same line, the parser rejects it — multiline prompt text must use a triple-quoted block (`prompt """..."""`).

**2. Identifier reference**

A bare identifier after `prompt` uses the string value of an existing binding (e.g. a `const`). The parser greedily takes the first token after `prompt` as the body — `returns` is only recognized as a keyword when it appears **after** a complete body form.

```jaiph
const text = "Analyze this code for security issues"
prompt text
result = prompt text returns "{ type: string, risk: string }"
```

**3. Triple-quoted block (multiline)**

For multiline prompt text, use triple-quote delimiters (`"""`). The opening `"""` must be on the same line as `prompt`. The body supports `${...}` interpolation. Triple backticks (`` ``` ``) are reserved for scripts and rejected in prompt context with a guidance message.

```jaiph
prompt """
You are a helpful assistant.
Analyze the following: ${input}
"""
```

All three forms work in capture and `const` capture positions:

```jaiph
answer = prompt "Summarize the report"
const x = prompt myVar
const y = prompt """
Analyze this input in detail.
"""
```

**Typed prompt (returns schema):** Ask the agent for structured JSON output. `returns "…"` may follow a single-line string or identifier body on the same line, or appear on the **line after** the closing `"""` of a triple-quoted block.

```jaiph
result = prompt "Analyze this code" returns "{ type: string, risk: string }"
result = prompt text returns "{ type: string, risk: string }"
```

For a **triple-quoted** prompt, either put `returns "…"` on the line **immediately after** the closing `"""`, or on the **same line** as the closing delimiter: `""" returns "{ … }"` (nothing else may follow the schema string on that line).

When `returns` is present, capture is required. The schema is flat only — allowed types are `string`, `number`, `boolean`. The runtime validates the response: it searches for valid JSON (last non-empty line, fenced code blocks, standalone `{…}`, embedded JSON). On success, the capture variable holds the raw JSON string and each field is accessible via **dot notation** — `${result.type}`, `${result.risk}`. On failure, the step fails with a parse, missing-field, or type error.

**String values in orchestration:** Bindings in workflows and rules are **strings** end-to-end (including capture, `return`, and `${…}` interpolation). For typed prompts, schema types only constrain the **parsed JSON** from the agent: after validation, each field is coerced with string conversion for storage. For example, `returns "{ n: number }"` with `{"n":42}` stores `42` as the **text** `"42"` in `${x.n}`, not a numeric type. The same applies to `boolean`. Bare `return x.field` in a workflow is sugar for `return "${x.field}"`.

**Dot notation validation:** The compiler validates `${var.field}` references at compile time. If `var` is not a typed prompt capture, the compiler reports an error. If `field` is not defined in the `returns` schema, the error lists available fields.

Prompts are not allowed in rules.

### `const` — Variable Binding

`const name = <rhs>` introduces a variable in the workflow or rule body.

```jaiph
const tag = "v1.0"
const message = """
  Hello ${name},
  Welcome to the project.
"""
const result = run helper(arg)
const check = ensure validator(input)
const answer = prompt "Summarize the report"
const reply = prompt myVar
const analysis = prompt """
Analyze this input in detail.
"""
```

RHS forms: value expressions (`${var}`, quoted strings, triple-quoted `"""..."""` multiline blocks), or explicit `run`/`ensure`/`prompt` capture. Prompt capture supports all three body forms: string literal, identifier, and triple-quoted block. A bare reference like `const x = ref(args)` is rejected — use `const x = run ref(args)`.

Restrictions on const RHS: `$(…)`, `${var:-fallback}`, `${var%%…}`, `${var//…}`, and `${#var}` are all rejected.

### `send` — Channel Messages

```jaiph
alerts <- "Build started"
reports <- ${output}
results <- run build_message(data)
results <- run get_summary()
alerts <- """
  Build report for ${project}:
  Status: ${status}
"""
```

RHS must be a double-quoted literal, a triple-quoted `"""..."""` multiline block, `${var}`, or `run ref(args)`. An explicit payload is always required — bare `channel <-` without a value is `E_PARSE`. Arbitrary shell on the RHS is `E_PARSE`.

### Channel Routing

Routes are declared at the top level on `channel` declarations, not inside workflow bodies:

```jaiph
channel alerts -> handle_alert
channel events -> handler_a, handler_b
```

When a message arrives on the channel, the runtime calls each target workflow, binding the three dispatch values (message, channel, sender) to whatever parameter names the target declares. Route targets must declare exactly 3 parameters. Multiple targets dispatch sequentially. Routes are stored on `ChannelDef`, not on workflow definitions or steps. See [Inbox & Dispatch](inbox.md).

A `->` route declaration inside a workflow body is a **parse error** with guidance to move it to the top-level `channel` declaration.

### `log` and `logerr`

```jaiph
log "Processing ${message}"
logerr "Warning: ${name} not found"
log status                              # bare identifier — same as log "${status}"
logerr err_msg                          # bare identifier form works with logerr too
log """
  Build started at ${timestamp}
  Target: ${env}
"""
```

`log` writes to stdout; `logerr` writes to stderr (shown with a red `!` marker in the progress tree). Both accept single-line `"..."` strings, triple-quoted `"""..."""` multiline blocks, bare identifiers, or **managed inline-script calls** (`log run \`…\`(args)`). `${identifier}` interpolation works in string forms. At runtime, backslash escapes in the final string are interpreted (`\n` → newline).

**Bare identifier form:** When `log` or `logerr` is followed by a single bare identifier (no quotes), it expands to `"${identifier}"` — the variable's value is logged. The identifier must reference a known binding (`const`, capture, or named parameter).

**Managed inline-script form:** `log run \`script\`(args)` and `logerr run \`script\`(args)` execute the inline script and log its stdout. The `run` keyword is required — bare inline scripts (`log \`…\`()`, `logerr \`…\`()`) are rejected at compile time with a clear error.

### `fail`

```jaiph
fail "Missing required configuration"
fail """
  Multiple issues found:
  - ${issue1}
  - ${issue2}
"""
```

Aborts the workflow or rule with a message on stderr and non-zero exit. Accepts a single-line `"..."` string or a triple-quoted `"""..."""` multiline block.

### `return`

```jaiph
return "success"
return "${result}"
return """
  Report for ${name}:
  Status: ${status}
"""
return run helper                      # bare form — same as return run helper()
return run helper()
return ensure check(input)
return run `cat report.txt`()          # inline script — runs and returns stdout
return run `echo $1`("arg")            # inline script with arguments
```

Sets the managed return value in rules and workflows. The value can be a single-line `"..."` string, a triple-quoted `"""..."""` multiline block, a variable reference, or a **direct managed call** using `return run ref(args)`, `return ensure ref(args)`, or `return run \`script\`(args)`. A direct managed call executes the target and uses its result as the return value — equivalent to capturing into a variable and returning it, but without the boilerplate:

```jaiph
# Before: capture then return
const result = run helper()
return "${result}"

# After: direct return
return run helper()
```

In workflows, `return run` targets a workflow or script; `return ensure` targets a rule. In rules, `return run` targets a script only; `return ensure` targets another rule. The same validation rules that apply to standalone `run`/`ensure` steps apply here — unknown refs, type mismatches, and shell redirection are all rejected at compile time.

**Inline-script form:** `return run \`script\`(args)` executes the inline script and uses its stdout as the return value. The `run` keyword is required — bare inline scripts (`return \`…\`()`) are rejected at compile time with a clear error.

A bare integer (`return 0`) or `return $?` is a bash exit code, not a Jaiph value return. `return "…"` is not allowed in script bodies — use `echo`/`printf`.

### `match`

```jaiph
match status {
  "ok" => "all good"
  /err/ => "something went wrong"
  _ => "unknown"
}
```

Pattern match on a string value. The subject is always a **bare identifier** (variable name without `$` or `${}`). Arms are tested top-to-bottom; the first match wins. Patterns can be:

- **String literal** (`"ok"`) — exact equality against the subject
- **Regex** (`/err/`) — tested against the subject
- **Wildcard** (`_`) — matches anything

Exactly one `_` wildcard arm is required.

Using `$var` or `${var}` as the match subject is a parse error — use the bare name: `match varName { ... }`.

**Arm bodies** — the expression after `=>` produces the match result. Allowed forms:

- String literal: `"value"` or multiline `"""…"""`
- Variable reference / interpolation: `$var`, `${var}`
- `fail "message"` — aborts the workflow/rule
- `run ref(args)` / `ensure ref(args)` — managed call whose result becomes the match value

**Disallowed** — rejected at validate time with `E_VALIDATE`:

- `return` inside an arm body (`"x" => return "y"`) — the match expression itself produces the value; use `return match x { … }` at the outer level instead
- Inline script forms (backtick `` `…`() ``) — use a named script with `run script_name(…)`

**Multiline arm bodies** use triple-quoted strings:

```jaiph
match mode {
  "verbose" => """
Detailed output enabled.
All logs will be shown.
  """
  _ => "standard"
}
```

**Expression form:** `match` works as an expression with `const` and `return`:

```jaiph
const label = match status {
  "ok" => "success"
  _ => "failure"
}

return match status {
  "ok" => "pass"
  _ => "fail"
}
```

The outer `return` applies to the whole match expression — it is not the same as `return` inside an arm body (which is forbidden).

### Variable Binding

All captures require `const`:

```jaiph
const result = run helper(arg)
const check = ensure validator(input)
const answer = prompt "Summarize the report"
const reply = prompt myVar
```

## Scripts

### Bash Scripts (single-line)

```jaiph
script setup_env = `export BASE_DIR=$(pwd) && mkdir -p "$BASE_DIR/output" && echo "Environment initialized"`
```

### Bash Scripts (fenced block)

```jaiph
script setup_env = ```
export BASE_DIR=$(pwd)
mkdir -p "$BASE_DIR/output"
echo "Environment initialized"
```
```

Script bodies are opaque bash — the compiler does not parse them as Jaiph steps. For bash scripts, the emitter applies only lightweight transforms: `return` normalization, `local`/`export`/`readonly` spacing, and import alias resolution.

**Interpolation rules differ by body form:**

- **Backtick** (single-line): Jaiph interpolation (`${...}`) is forbidden — the compiler rejects `${name}` with `E_PARSE` to prevent ambiguity between Jaiph variables and shell parameter expansion. Use `$1`, `$2` positional arguments to pass data from orchestration to scripts.
- **Fenced block** (triple-backtick): `${...}` is passed through to the shell verbatim. Shell parameter expansion (`${VAR}`, `${VAR:-default}`, `${#VAR}`, etc.) works as expected. The triple-backtick delimiter signals "this is opaque shell", so there is no ambiguity with Jaiph interpolation.

### Polyglot Scripts

#### Fence lang tags (recommended)

Use a fence lang tag (`` ```<tag> ``) to select an interpreter without writing a shebang line. The tag maps directly to a shebang: `` ```<tag> `` becomes `#!/usr/bin/env <tag>`. Any tag is valid — there is no hardcoded allowlist.

```jaiph
script analyze = ```python3
import sys
print(f"Analyzing {sys.argv[1]}")
```

script transform = ```node
const data = process.argv[2];
console.log(JSON.stringify({ result: data }));
```
```

Examples of tag-to-shebang mapping:

| Fence tag | Shebang |
|---|---|
| `` ```node `` | `#!/usr/bin/env node` |
| `` ```python3 `` | `#!/usr/bin/env python3` |
| `` ```ruby `` | `#!/usr/bin/env ruby` |
| `` ```perl `` | `#!/usr/bin/env perl` |
| `` ```pwsh `` | `#!/usr/bin/env pwsh` |
| `` ```deno `` | `#!/usr/bin/env deno` |
| `` ```bash `` | `#!/usr/bin/env bash` |
| `` ```lua `` | `#!/usr/bin/env lua` |

Combining a fence lang tag with a manual `#!` shebang in the body is an error — choose one or the other.

#### Manual shebang (escape hatch)

If no fence tag is present, the user may provide a manual `#!` shebang as the first line of the body:

```jaiph
script run_lua = ```
#!/usr/bin/env lua
print("hello from lua")
```
```

Non-bash scripts skip Jaiph keyword validation and emit the body verbatim.

### Script Isolation

Scripts run in a clean process environment (`env -i`). Only these variables are inherited:

- System: `PATH`, `HOME`, `TERM`, `USER`
- Jaiph: `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`
- Positional arguments (`$1`, `$2`, …)

Module-scoped `const` variables are **not** visible. Pass data as positional arguments, duplicate small bash inline, or use `import script` for shared helpers.

## String Interpolation {#string-interpolation}

Jaiph orchestration strings support `${identifier}` interpolation. Every identifier — whether in a bare argument (`run greet(name)`) or in braced form (`log "hello ${name}"`) — must reference a binding that is in scope: `const`, capture, or named parameter. Unknown names are rejected at compile time with an `E_VALIDATE` error in both forms; `${name}` is **not** a workaround for an undeclared bare identifier.

| Form | Status | Where |
|---|---|---|
| `${varName}` | Primary | All Jaiph strings |
| `${var.field}` | Dot notation — typed prompt field access | All Jaiph strings |
| `${paramName}` | Named parameter access | All Jaiph strings |
| `${run ref(args)}` | Inline capture — executes call, inlines output | All Jaiph strings |
| `${ensure ref(args)}` | Inline capture — executes rule, inlines result | All Jaiph strings |
| `$varName` | Rejected — use `${varName}` | — |
| `$1`, `$2` | Positional shell args — only in `script` bodies | `script` bodies only |
| `${var:-fallback}` | Rejected (`E_PARSE`) in orchestration strings and backtick scripts; passes through in fenced script blocks | — |
| `$(…)` | Rejected (`E_PARSE`) in orchestration strings | — |

**Dot notation** (`${var.field}`) accesses a single field from a typed prompt capture. The variable must be bound to a `prompt … returns` step, and the field must exist in the schema. Both constraints are checked at compile time. See [prompt — Typed prompt](#prompt--agent-interaction) for details.

**Inline captures** execute a managed call directly inside the string:

```jaiph
log "Got: ${run some_script()}"
log "Status: ${ensure check_ok()}"
prompt "Fix the issue: ${ensure get_diagnostics()}"
return "${run some_script()}"
```

If any inline capture fails, the enclosing step fails immediately. Nested inline captures (`${run foo(${run bar()})}`) are rejected — extract the inner call to a `const`.

## Step Output Contract

Every step produces three distinct outputs — status, value, and logs:

| Step kind | Status source | Value channel (for `x = …`) | Log channel |
| --- | --- | --- | --- |
| `ensure rule` | rule exit code | explicit `return` value | rule body logs to artifacts |
| `run workflow` | workflow exit code | explicit `return` value | workflow step logs to artifacts |
| `run script` (named) | script exit code | **stdout** of script body | script stdout/stderr to artifacts |
| `` run `…`() `` (inline) | script exit code | **stdout** of script body | script stdout/stderr to artifacts |
| `prompt` | prompt exit code | final assistant answer | transcript to artifacts |
| `log` / `logerr` | always 0 | empty | event + stdout/stderr |
| `fail` | non-zero (abort) | empty | message to stderr |
| `run async` | aggregated | `Handle<T>` — resolves to return value on read | async step logs to artifacts |
| `const` | same as RHS step | empty (binds local) | n/a |

Key rules:
- For `ensure`/`run` to a rule or workflow, assignment captures only the callee's explicit `return "…"` (or `return run …` / `return ensure …`).
- For `run` to a script, assignment captures **stdout**. Use `echo`/`printf` to pass data back.
- `return "value"` / `return "${var}"` / `return run ref()` / `return ensure ref()` are valid in rules and workflows only, not in scripts.

## Lexical Notes

- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`
- **References:** `IDENT` or `IDENT.IDENT` (module-qualified)
- **Comments:** Full-line `#` comments.
- **Blank lines:** Empty lines between steps inside workflow and rule bodies are preserved in the AST as visual grouping markers. A single blank line between steps survives `jaiph format` unchanged; consecutive blank lines are collapsed to one; trailing blank lines before `}` are removed. Outside block bodies (between top-level declarations), blank lines are normalized by the formatter.
- **Shebang:** A `#!` first line of the file is ignored by the parser.
- **Import path:** Quoted string in `import "path" as alias`. Missing `.jh` extension is appended automatically. Script imports use `import script "path" as name` — the path refers to a raw script file (no `.jh` extension appended).
- **String quoting:** Jaiph has a four-delimiter system. `"..."` is the single-line string form (double quotes only — single-quoted strings are parse errors). `"""..."""` is the multiline string form; the opening `"""` must end the line, and the closing `"""` must be on its own line. A double-quoted string that spans multiple lines is rejected with a guidance error pointing to triple quotes. Use `\"` for literal double quotes and `\\` for literal backslashes. `${...}` interpolation works in both forms. Script bodies use single backtick (`` `...` ``) for single-line or triple backtick (`` ```...``` ``) for multi-line — normal shell quoting is allowed inside script bodies. Triple backticks in prompt/string context are rejected.
- **Required call-site parentheses:** All call sites require parentheses — `run ref()`, not `run ref`. Bare identifiers without parentheses are `E_PARSE`.
- **Top-level ordering:** The parser accepts top-level definitions in any order. `jaiph format` hoists `import`, `config`, and `channel` declarations to the top (in that order), but preserves the source-file order of all other definitions (`const`, `rule`, `script`, `workflow`, `test`). Comments before a hoisted construct move with it; comments before non-hoisted definitions stay in place. See [CLI — `jaiph format`](cli.md#jaiph-format).

## EBNF (Practical Form)

Informal symbols: `string` = quoted string; `call_ref` = `REF "(" [args] ")"` — parentheses are always required (each argument may be a quoted string, `${var}`, or a **bare identifier** — see [Call Arguments](#call-arguments-and-positional-parameters)); `double_quoted_string` = single-line double-quoted string supporting `\$`, `\"`, `\\`, `` \` `` escapes and `${identifier}` / `${run …}` / `${ensure …}` interpolation; `triple_quoted_block` = multiline string delimited by `"""` on opening and closing lines, supporting the same interpolation; `prompt_body` = single-line double-quoted string | bare `IDENT` (reference to an existing binding) | triple-quoted block (`""" … """`).

```ebnf
file            = { top_level } ;

top_level       = config_block | import_stmt | import_script_stmt | channel_decl | env_decl | rule_decl | script_decl | workflow_decl ;

config_block    = "config" "{" { config_line } "}" ;
config_line     = config_key "=" config_value ;
config_key      = "agent.default_model" | "agent.command" | "agent.backend" | "agent.trusted_workspace"
                | "agent.cursor_flags" | "agent.claude_flags" | "run.logs_dir" | "run.debug"
                | "run.inbox_parallel" | "runtime.docker_image" | "runtime.docker_network"
                | "runtime.docker_timeout"
                | "module.name" | "module.version" | "module.description" ;
config_value    = string | "true" | "false" | integer | string_array ;
integer         = digit { digit } ;
string_array    = "[" { array_element } "]" ;
array_element   = string [ "," ] ;

import_stmt     = "import" string "as" IDENT ;
import_script_stmt = "import" "script" string "as" IDENT ;

channel_decl    = "channel" IDENT [ "->" REF { "," REF } ] ;

env_decl        = "const" IDENT "=" env_value ;
env_value       = double_quoted_string | triple_quoted_block | bare_value ;

rule_decl       = [ "export" ] "rule" IDENT [ "(" param_list ")" ] "{" { rule_body_step } "}" ;
rule_body_step  = comment_line | workflow_step ;
  (* validation rejects prompt, send, const…=prompt, run async,
     and run targets that are not scripts *)

script_decl     = "script" IDENT "=" script_rhs ;
script_rhs      = backtick_script_body | fenced_script_block ;
backtick_script_body = "`" script_text "`" ;  (* single-line; no newlines; no ${...} interpolation *)
fenced_script_block = "```" [ LANG_TAG ] newline { script_line newline } "```" ;  (* ${...} passed through to shell *)
LANG_TAG        = IDENT ;  (* any identifier — maps to #!/usr/bin/env <tag>; rejected when body starts with #! *)
shebang_line    = "#!" rest_of_line ;  (* rejected when LANG_TAG is present *)
script_line     = comment_line | command_line ;

workflow_decl   = [ "export" ] "workflow" IDENT [ "(" param_list ")" ] "{" [ workflow_config ] { workflow_step } "}" ;
param_list      = IDENT { "," IDENT } ;  (* identifiers; no duplicates; no reserved keywords *)
workflow_config = config_block ;
  (* optional per-workflow override; must appear before steps;
     only agent.* and run.* keys allowed; runtime.* and module.* yield E_PARSE *)

workflow_step   = ensure_stmt | run_stmt | run_catch_stmt | run_recover_stmt | run_async_stmt | prompt_stmt | prompt_capture_stmt
                | const_decl_step | return_stmt
                | fail_stmt | log_stmt | logerr_stmt | send_stmt
                | match_stmt | if_stmt | comment_line ;
  (* route declarations (-> workflow) belong at the top level in channel_decl,
     not inside workflow bodies; a -> inside a body is E_PARSE *)

const_decl_step = "const" IDENT "=" const_rhs ;
const_rhs       = double_quoted_string | triple_quoted_block | bash_value_expr
                | "run" ( call_ref | inline_script ) | "run" "async" call_ref
                | "ensure" call_ref
                | "prompt" prompt_body [ returns_schema ]
                | "match" IDENT "{" { match_arm } "}" ;

fail_stmt       = "fail" ( double_quoted_string | triple_quoted_block ) ;
run_async_stmt  = "run" "async" call_ref [ "recover" recover_bindings recover_body ] [ "catch" catch_bindings catch_body ] ;
run_async_capture = "const" IDENT "=" "run" "async" call_ref ;
return_stmt     = "return" return_value ;
return_value    = double_quoted_string | triple_quoted_block | "$" IDENT | "${" IDENT "}"
                | "run" ( call_ref | inline_script ) | "ensure" call_ref
                | "match" IDENT "{" { match_arm } "}" ;

match_stmt      = "match" IDENT "{" { match_arm } "}" ;
match_expr      = "match" IDENT "{" { match_arm } "}" ;

if_stmt         = "if" IDENT if_op if_operand "{" { workflow_step } "}" ;
if_op           = "==" | "!=" | "=~" | "!~" ;
if_operand      = double_quoted_string | "/" regex_source "/" ;
match_arm       = match_pattern "=>" arm_body ;
match_pattern   = double_quoted_string | "/" regex_source "/" | "_" ;
arm_body        = double_quoted_string | triple_quoted_block
                | "$" IDENT | "${" IDENT "}"
                | "fail" double_quoted_string
                | "run" call_ref | "ensure" call_ref ;

send_stmt       = IDENT "<-" send_rhs ;
send_rhs        = double_quoted_string | triple_quoted_block | "${" IDENT "}" | "run" call_ref | REF ;

log_stmt        = "log" ( double_quoted_string | triple_quoted_block | IDENT | "run" inline_script ) ;
logerr_stmt     = "logerr" ( double_quoted_string | triple_quoted_block | IDENT | "run" inline_script ) ;

ensure_stmt     = "ensure" call_ref [ "catch" catch_bindings catch_body ] ;
run_catch_stmt  = "run" call_ref "catch" catch_bindings catch_body ;
run_recover_stmt = "run" call_ref "recover" recover_bindings recover_body ;
run_stmt        = "run" ( call_ref | inline_script ) ;
call_ref        = REF "(" [ call_args ] ")" ;  (* parentheses always required *)
call_arg        = double_quoted_string | IDENT | "${" IDENT "}"
                | "run" ( call_ref | inline_script )       (* explicit nested managed call *)
                | "ensure" call_ref ;                      (* explicit nested ensure *)
call_args       = call_arg { "," call_arg } ;
inline_script   = backtick_script_body "(" [ call_args ] ")" | fenced_script_block "(" [ call_args ] ")" ;
prompt_body     = double_quoted_string | IDENT | triple_quoted_block ;
triple_quoted_block = "\"\"\"" newline { body_line newline } "\"\"\"" ;
prompt_stmt     = "prompt" prompt_body [ returns_schema ] ;
returns_schema  = "returns" double_quoted_string ;

catch_bindings  = "(" IDENT ")" ;  (* failure payload *)
catch_body      = single_workflow_stmt | "{" { workflow_step } "}" ;
recover_bindings = "(" IDENT ")" ;  (* failure payload — same as catch *)
recover_body    = single_workflow_stmt | "{" { workflow_step } "}" ;
single_workflow_stmt = ensure_stmt | run_stmt | run_catch_stmt | run_recover_stmt | prompt_stmt | prompt_capture_stmt
                | const_decl_step
                | return_stmt | fail_stmt | log_stmt | logerr_stmt
                | send_stmt ;
```

## Validation Rules

After parsing, the compiler validates references and config (`src/transpile/validate.ts`). Error codes:

- **E_PARSE:** Invalid syntax — duplicate config, invalid keys/values, `$(…)` or `${var:-fallback}` in orchestration strings, `${...}` interpolation in script bodies, `prompt … returns` without capture, bare `ref(args)` in const RHS (use `run`/`ensure`/`prompt`), `local` at top level, unrecognized workflow/rule line, invalid send RHS, arguments after `catch`, bare `catch` with no recovery step, nested inline captures, shell redirection after `run`/`ensure`, invalid parameter names (non-identifier, duplicate, or reserved keyword), or missing `{` on definition line.
- **E_SCHEMA:** Invalid `returns` schema — empty, non-flat, unsupported type (only `string`, `number`, `boolean`).
- **E_VALIDATE:** Reference errors — unknown rule/workflow, duplicate alias, `ensure` on non-rule, `run` on rule, `run` to workflow inside rule, `run async` in rule, forbidden Jaiph usage inside `$(…)`, dot notation on non-prompt variable or invalid field name, bare identifier argument referencing an unknown variable, `${identifier}` in strings referencing an unknown variable, standalone `"${identifier}"` in call arguments (use bare identifier instead), arity mismatch (call-site argument count differs from callee's declared parameter count), **bare nested managed calls** — `run foo(bar())` or `run foo(rule_bar())` without explicit `run`/`ensure` keyword, **bare nested inline script calls** — `run foo(\`echo aaa\`())` without explicit `run`, **type crossing** — `prompt` with a script name (`scripts are not promptable`), `run` with a string const (`strings are not executable`), `const x = scriptName` (`scripts are not values`), `${scriptName}` interpolation (`scripts cannot be interpolated`).
- **E_IMPORT_NOT_FOUND:** Import target file does not exist.

Validation rules:

1. At most one `config` block per file and per workflow. Workflow config must appear before steps. Only `agent.*` and `run.*` keys in workflow config.
2. Config values must match expected types. `agent.backend` must be `"cursor"`, `"claude"`, or `"codex"`.
3. Import aliases must be unique (`E_VALIDATE`). Import targets must exist (`E_IMPORT_NOT_FOUND`). Script import targets (external files) must also exist.
4. **Unified namespace:** channels, rules, workflows, scripts, script import aliases, and top-level `const` share one namespace per module.
5. `ensure` must target a rule. `run` in a workflow targets a workflow or script. `run` in a rule targets a script only. These rules also apply to `return run` and `return ensure` forms.
6. Channel references in `send` must resolve to declared channels. Route targets on channel declarations must be workflows with exactly 3 parameters. Route declarations inside workflow bodies are rejected at parse time.
7. `ensure … catch`, `run … catch`, and `run … recover` argument ordering: all arguments inside parentheses before `catch`/`recover`.
8. Shell redirection (`>`, `|`, `&`) after `run`/`ensure` is rejected — use a script.
9. **Type crossing:** `string` and `script` are non-interchangeable primitive types (see [Types](#types)). `prompt` rejects script names; `run` rejects string consts; assigning a script to a `const` or interpolating a script name with `${…}` is rejected. Each crossing produces an actionable `E_VALIDATE` message.
10. **Explicit nested managed calls:** Bare call-like forms in argument position (`run foo(bar())`, `run foo(rule_bar())`) are rejected — add the missing `run` or `ensure` keyword. Bare inline script calls in arguments (`run foo(\`echo aaa\`())`) are also rejected — add `run`. Valid forms: `run foo(run bar())`, `run foo(ensure rule_bar())`, `run foo(run \`echo aaa\`())`.

## Build Artifacts {#build-artifacts}

`jaiph run` and `jaiph test` do **not** transpile workflows to shell. The CLI calls `buildScripts()`, which emits only per-`script` executable files under `scripts/`. Workflows, rules, prompts, channels, and control flow are interpreted by `NodeWorkflowRuntime` from the AST.

Each `script name = …` becomes `scripts/<name>` with `chmod +x`: shebang (from fence lang tag, manual `#!`, or default `#!/usr/bin/env bash`) plus the body. Inline scripts (`` run `body`(args) `` or `` run ```lang...body...```(args) ``) are emitted as `scripts/__inline_<hash>` with deterministic hash-based names. At runtime, script steps run these files with a minimal environment.

## Runtime Execution

At runtime, the Node workflow runtime interprets the AST directly:

- **Config:** Precedence chain: environment → workflow-level → module-level → defaults.
- **Script isolation:** Managed subprocesses with only essential variables. Module-scoped variables not visible.
- **Prompt + schema:** JSON extraction and schema validation via the JS kernel. Exit codes: 0=ok, 1=parse error, 2=missing field, 3=type mismatch.
- **ensure/run … catch:** On failure, the recovery body runs **once**. There is no retry loop. Requires explicit bindings: `catch (failure) { … }`. The binding gets the merged stdout+stderr from the failed execution.
- **run … recover:** Repair-and-retry loop. On failure, the binding gets merged stdout+stderr, the repair body runs, and the target is retried. Loop stops on success or when `run.recover_limit` (default 10) is exhausted. Requires explicit bindings: `recover(err) { … }`.
- **Recursion safety:** There is a hard recursion depth limit of 256. Exceeding it produces a runtime error.
- **Assignment capture:** Rules and workflows use explicit `return "…"`. Scripts use stdout.
- **`run async`:** Returns a `Handle<T>` value. Handle-based concurrency with implicit resolution on first non-passthrough read and implicit join of unresolved handles at workflow exit. `recover` and `catch` composition supported. Failures aggregated at join.
- **Channels:** Messages enqueued via `send`, dispatched to route targets at workflow end. Each target must declare exactly 3 parameters; the runtime binds message, channel, and sender to the declared names.
