---
title: Language
permalink: /language
redirect_from:
  - /language.md
---

# Language

Workflow systems usually need two layers: a **host language** that sequences work, handles failures, and talks to tools, and **task code** (shell, Python, and so on) that does the mechanical steps. Jaiph’s `.jh` modules are that host layer: they wire prompts, scripts, validation **rules**, and **channels** into pipelines you can run from the CLI or CI.

Under the hood, the **TypeScript CLI** parses modules, runs **`validateReferences`** while emitting script files (`emitScriptsForModule` / `buildScripts`), then starts a **Node workflow runtime** that walks the same AST in process — there is no separate workflow shell. The runtime’s `buildRuntimeGraph` pass loads imports with the parser only; compile-time checks live in the transpile path, not in the graph loader. For repository layout, event contracts, and diagrams, see [Architecture](architecture.md).

This page is the practical reference for language primitives — syntax, steps, and runtime behavior at the author’s eye level. For lexical/syntax tables and edge-case grammar, see [Grammar](grammar.md). Test files (`*.test.jh`) are a dialect documented in [Testing](testing.md).

## Strings

Strings are the general-purpose value type. They can be interpolated, passed as arguments, assigned to `const` bindings, and sent to an agent via `prompt`.

**Single-line** — double-quoted:

```jaiph
const greeting = "Hello, ${name}."
prompt "Review the code for issues"
```

**Multiline** — triple-quoted (`"""…"""`):

```jaiph
const instructions = """
You are a code reviewer.
Analyze the following: ${input}
Be concise.
"""
prompt instructions
```

Triple-quoted strings preserve internal newlines and support `${…}` interpolation. Leading/trailing blank lines adjacent to the `"""` delimiters are trimmed.

Single-quoted strings are parse errors. Use `\"` for literal double quotes inside strings, `\\` for literal backslashes.

## Scripts

Scripts are executable definitions — shell (or polyglot) code that runs as an isolated subprocess. They are invoked with `run` and cannot be interpolated, assigned to variables, or used as prompt bodies. The compiler enforces this at every call site.

**Single-line** — backtick:

```jaiph
script greet = `echo "Hello, $1"`
```

Backtick scripts do not support `${…}` Jaiph interpolation — the compiler rejects it to prevent ambiguity with shell expansion. Use positional arguments (`$1`, `$2`, …).

**Multiline** — fenced block:

<pre><code>script setup_env = ```
export BASE_DIR=$(pwd)
mkdir -p "$BASE_DIR/output"
echo "Environment initialized"
```
</code></pre>

Fenced scripts support `${…}` — it passes through to the shell as standard shell parameter expansion.

**Polyglot** — use a fence lang tag to select the interpreter:

<pre><code>script analyze = ```python3
import sys
print(f"Analyzing {sys.argv[1]}")
```
</code></pre>

The tag maps to `#!/usr/bin/env <tag>`. Any tag is valid. Alternatively, use a manual `#!` shebang as the first line. Combining both is an error. If the body has **neither** a fence lang tag nor a leading `#!` line, emitted scripts default to `#!/usr/bin/env bash`.

Strings and scripts are structurally distinct and non-interchangeable — using one where the other is expected produces a compile-time error.

## Module Structure

A `.jh` file is a module. Modules contain top-level declarations in any order: imports, config, channels, constants, rules, scripts, and workflows. `jaiph format` hoists imports, config, and channels to the top but preserves the relative order of everything else.

### Imports and Exports

`import` loads another module; `export` marks a declaration as public. All three definition types support export: `export workflow`, `export rule`, and `export script`.

```jaiph
import "tools/security.jh" as security
import "bootstrap.jh" as bootstrap

export script build_docs = `mkdocs build`

export workflow default() {
  ensure security.scan_passes()
  run bootstrap.nodejs()
}
```

Imported symbols use dot notation: `alias.name`. The `.jh` extension is appended automatically if omitted. Import aliases must be unique within a module.

#### Script Imports

`import script` loads an external script file and binds it to a local script symbol. The imported file is treated as raw script source (not as a Jaiph module) — shebangs are preserved and used to select the interpreter. The bound name works exactly like a locally declared `script`: callable with `run`, capturable with `const`, and subject to the same isolation rules.

```jaiph
import script "./queue.py" as queue

workflow default() {
  const result = run queue("get")
  log result
}
```

The path is resolved relative to the importing `.jh` file's directory (not the process CWD). The path must be double-quoted. Missing targets fail at compile time with `E_IMPORT_NOT_FOUND`.

This is useful when a script body is large enough that embedding it inline couples DSL structure and script implementation too tightly, or when you want normal editor/tooling support (syntax highlighting, linting) on the script file.

#### Export Visibility

If a module contains at least one `export` declaration, it has an **explicit API surface**: only exported names can be referenced through the import alias. Referencing a symbol that exists in the module but is not exported produces a compile-time error:

```
E_VALIDATE: "private_rule" is not exported from module "lib"
```

Modules with **zero** `export` declarations retain legacy behavior — every top-level rule, script, and workflow is implicitly public. This means existing projects that don't use `export` continue to work without changes.

The check applies uniformly to all qualified-reference positions: `run`, `ensure`, channel route targets, `send` RHS, and test mocks.

### Library Imports

Import paths resolve relative to the importing file first. If no file is found and the path contains a `/`, the resolver falls back to project-scoped libraries under `.jaiph/libs/`:

```jaiph
import "queue-lib/queue" as queue   # resolves to .jaiph/libs/queue-lib/queue.jh
```

The path is split as `<lib-name>/<path-inside-lib>`. Libraries are installed with `jaiph install` — see [CLI — jaiph install](cli.md#jaiph-install). Missing library imports fail at compile time with `E_IMPORT_NOT_FOUND`.

### Top-Level `const`

Module-scoped variables accessible as `${name}` inside that module's rules and workflows.

```jaiph
const REPO = "my-project"
const MAX_RETRIES = 3
const GREETING = """
Hello,
world
"""
```

Values can be double-quoted strings (single-line), triple-quoted strings (multiline `"""..."""`), or bare tokens. Declaration order matters — `${name}` only expands variables already bound above. Module constants are **not** passed to script subprocesses; use arguments or shared libraries instead.

### Channels

Named message queues for inter-workflow communication. Declared at the top level, one per line.

```jaiph
channel alerts
channel findings -> analyst
channel events -> handler_a, handler_b
```

Routes (`->`) declare which workflows receive messages sent to the channel. See [Inbox & Dispatch](inbox.md) for dispatch semantics.

### Config

Optional block setting agent and run options. Allowed at module level and inside individual workflow bodies.

```jaiph
config {
  agent.default_model = "claude-sonnet-4-6"
  agent.backend = "claude"
  run.debug = true
}
```

See [Configuration](configuration.md) for all available keys and precedence rules.

## Definitions

### Workflows

Named sequences of orchestration steps. Workflows can call other workflows, scripts, prompts, and channels. Parentheses are required on definitions, even when parameterless.

```jaiph
workflow default() {
  ensure check_deps()
  run setup_env()
  prompt "Review the code for issues"
}

workflow deploy(env, version) {
  log "Deploying ${version} to ${env}"
  run build(version)
  run push(env)
}
```

Workflows support all step types: `run`, `ensure`, `prompt`, `const`, `log`, `logerr`, `fail`, `return`, `send`, `match`, `if`, `run async`, `catch`, and `recover`.

### Rules

Named blocks of structured validation steps. Rules are called with `ensure` and are meant for checks and gates.

```jaiph
rule check_deps() {
  run verify_lockfile()
  run check_versions()
}

rule gate(path) {
  run check_exists(path)
  ensure validate_format(path)
}
```

Rules are more restricted than workflows: the compiler rejects `prompt`, `send`, and `run async` in rule bodies, and `run` may only target **scripts** (never workflows or other rules via `run` — use `ensure` for rules). Those restrictions are **static** (see `validateReferences` in `src/transpile/validate.ts`). At runtime, `run` inside a rule still launches a normal managed script subprocess with the same **environment model** as workflow scripts (see [Script isolation](#script-isolation)); scripts can perform side effects — the language simply keeps orchestration-heavy steps out of rules.

### Scripts

Executable shell (or polyglot) definitions. Bodies are opaque to the compiler — Jaiph does not parse them as orchestration steps. Scripts are called with `run` and execute as isolated subprocesses. See [Scripts](#scripts) above for syntax (backtick, fenced, polyglot).

## Parameters and Arguments

### Definitions

All workflow and rule definitions require parentheses. Named parameters go inside:

```jaiph
workflow implement(task, role) {
  log "Implementing ${task} as ${role}"
}
```

Parameter names must be valid identifiers, unique, and not reserved keywords. Inside the body, parameters are accessed as `${paramName}`. Parameters are immutable — they cannot be rebound by `const` or any other declaration in the same scope (see [`const` — Variable Binding](#const--variable-binding) for details).

### Call Sites

Arguments are comma-separated inside parentheses:

```jaiph
run setup()
run deploy("prod", version)
```

**Bare identifier arguments** pass a variable’s value without quoting; the compiler records the identifier so unknown names fail early. You can still pass the same value as a quoted orchestration string (for example `run greet("${name}")` when a literal is required), but **prefer the bare form** when the whole argument is exactly one binding — it reads clearly and matches formatter output.

```jaiph
const task = run get_next_task()
run process(task)                    # bare identifier — passes value of task
run process(task, "extra context")   # mixed bare + quoted literal
run greet("hello_${name}")           # quoted string with extra text — allowed
```

### Nested Managed Calls in Arguments

Call arguments can contain nested managed calls — but the `run` or `ensure` keyword must be explicit. This is a deliberate language rule: scripts and workflows execute only via `run`, and rules execute only via `ensure`, even when nested inside another call's arguments.

**Valid — explicit nested calls:**

```jaiph
run mkdir_p_simple(run jaiph_tmp_dir())
run do_work(ensure check_ok())
run do_work(run `echo aaa`())
```

The nested call executes first and its result is passed as a single argument to the outer call.

**Invalid — bare call-like forms:**

```jaiph
# run do_work(bar())          — E_VALIDATE: use "run bar()" or "ensure bar()"
# run do_work(rule_bar())     — E_VALIDATE: use "ensure rule_bar()"
# run do_work(`echo aaa`())   — E_VALIDATE: use "run `...`()"
# const x = bar()             — E_PARSE: use "const x = run bar()"
```

The explicit capture-then-pass form is also valid:

```jaiph
const x = run bar()
run foo(x)
```

### Arity Checking

When the callee declares named parameters, the compiler validates argument count:

```jaiph
workflow greet(name) { log "Hello ${name}" }

workflow default() {
  run greet("Alice")         # OK: 1 arg, 1 param
  # run greet("A", "B")     — compile error: expects 1 argument
  # run greet()             — compile error: expects 1 argument
}
```

## Workflow Steps

### `run` — Execute a Workflow or Script

Calls a workflow or script (in a workflow) or a script only (in a rule).

```jaiph
run setup_env()
run lib.build_project(task)
const output = run transform()
```

**Capture:** For a workflow, captures the explicit `return` value. For a script, captures stdout.

### `run async` — Concurrent Execution with Handles

`run async ref(args)` starts a workflow or script concurrently and returns a **`Handle<T>`** — a value that resolves to the called function's return value on first non-passthrough read. `T` is the same type the function would return under a synchronous `run`.

```jaiph
workflow default() {
  # Fire-and-forget style (handle created but not captured)
  run async lib.task_a()

  # Capture the handle for later use
  const h = run async lib.task_b()

  # Reading the handle forces resolution (blocks until task_b completes)
  log "${h}"
}
```

**Handle resolution:** The handle resolves on first non-passthrough read — string interpolation, passing as argument to `run`, comparison, conditional branching, or match subject. Passthrough operations (initial capture into `const`, re-assignment) do not force resolution.

**Implicit join:** When a workflow scope exits, the runtime implicitly joins all remaining unresolved handles created in that scope. This is not an error — it preserves backward compatibility with the pre-handle `run async` model.

**`recover` composition:** `recover` works with `run async` to provide retry-loop semantics on the async branch:

```jaiph
const b1 = run async foo() recover(err) {
  log "repairing: ${err}"
  run fix_it()
}
```

The async branch retries `foo()` using the same retry-limit semantics as non-async `recover` (default 10, configurable via `run.recover_limit`). The handle resolves to the eventual success value or the final failure. `catch` also works with `run async` for single-shot recovery (no retry loop).

See [Spec: Async Handles](spec-async-handles.md) for the full value model.

Constraints: workflow-only (rejected in rules), inline scripts not supported with `run async`.

### `ensure` — Execute a Rule

Runs a rule and succeeds if its exit code is 0.

```jaiph
ensure check_deps()
ensure lib.validate(input)
const result = ensure validator(path)
```

### `catch` — Failure Recovery

Both `ensure` and `run` support a `catch` clause. On failure, the recovery body runs once. `catch` requires an explicit binding that receives merged stdout+stderr from the failed step.

```jaiph
# Single-statement recovery
ensure install_deps() catch (failure) run fix_deps()

# Block recovery
run deploy(env) catch (err) {
  log "Deploy failed, rolling back"
  run rollback(env)
}

# Retry via recursion
workflow deploy(env) {
  ensure ci_passes() catch (failure) {
    prompt "CI failed — fix the code."
    run deploy(env)
  }
}
```

Bare `catch` without a binding is a parse error. All call arguments must appear inside parentheses before `catch`.

### `recover` — Repair-and-Retry Loop

`recover` is a first-class retry primitive for `run` steps. Unlike `catch` (which runs the recovery body once), `recover` implements a **loop**: try the target, and if it fails, bind the error, run the repair body, then retry. The loop stops when the target succeeds or when the retry limit is exhausted.

```jaiph
# Single-statement recovery loop
run deploy() recover(err) run fix_deploy()

# Block recovery loop
run deploy(env) recover(err) {
  log "Deploy failed: ${err}"
  run auto_repair(env)
}
```

**Semantics:**

1. Execute the `run` target.
2. If it succeeds, continue (the `recover` body never runs).
3. If it fails, bind merged stdout+stderr to the `recover` binding (e.g. `err`), execute the repair body, then go to step 1.
4. If the retry limit is reached and the target still fails, the step fails with the last error.

**Retry limit:** The default limit is **10** attempts. Override it per-module with the `run.recover_limit` config key:

```jaiph
config {
  run.recover_limit = 3
}

workflow default() {
  run flaky_step() recover(err) {
    log "Retrying after: ${err}"
    run repair()
  }
}
```

**Capture:** When the target eventually succeeds, `const name = run ref() recover(err) { … }` captures the result (same rules as plain `run` — `return` value for workflows, stdout for scripts).

**Constraints:**
- `recover` requires exactly one binding: `recover(name)`. Bare `recover` without bindings is a parse error.
- All call arguments must appear inside parentheses **before** `recover`.
- `recover` is available on `run` steps in workflows only (not `ensure`). `recover` also works with `run async` — see [`run async`](#run-async--concurrent-execution-with-handles).
- `recover` and `catch` are mutually exclusive on the same step — use one or the other.

### `prompt` — Agent Interaction

Sends text to the configured agent backend. Three body forms:

**String literal** (single-line):

```jaiph
prompt "Review the code for security issues"
const answer = prompt "Summarize the report"
```

**Identifier reference** (existing binding):

```jaiph
const text = "Analyze this code"
prompt text
```

**Triple-quoted block** (multiline):

```jaiph
prompt """
You are a helpful assistant.
Analyze the following: ${input}
"""
```

All three forms work with capture (`const name = prompt …`).

**Typed prompt** — ask the agent for structured JSON with `returns`:

```jaiph
const result = prompt "Analyze this code" returns "{ type: string, risk: string }"
log "Type: ${result.type}, Risk: ${result.risk}"
```

Schema supports flat fields with types `string`, `number`, `boolean`. Fields are accessible via dot notation (`${result.type}`). The compiler validates field references at compile time.

Prompts are not allowed in rules.

### `const` — Variable Binding

Introduces an **immutable** variable in a workflow or rule body.

```jaiph
const tag = "v1.0"
const message = """
  Hello ${name},
  Welcome to the project.
"""
const result = run helper(arg)
const check = ensure validator(input)
const answer = prompt "Summarize the report"
const label = match status {
  "ok" => "success"
  _ => "failure"
}
```

A bare reference like `const x = ref(args)` is rejected — use `const x = run ref(args)`.

**Immutability:** All bindings — parameters, `const` declarations, captures, and `script` names — are immutable within their scope. The compiler rejects:

- Rebinding a parameter name via `const` (e.g. `workflow run(x) { const x = … }`)
- Duplicate `const` declarations with the same name in the same scope
- A `script` name that collides with an existing immutable binding

The error names the conflicting binding and its origin:

```
E_VALIDATE: cannot rebind immutable name "x"; already bound as parameter at file.jh:1
```

### `log` and `logerr`

`log` writes to stdout; `logerr` writes to stderr (shown with a red `!` marker in the progress tree).

```jaiph
log "Processing ${message}"
logerr "Warning: ${name} not found"
log status                   # bare identifier — logs the variable's value
log """
  Build started at ${timestamp}
  Target: ${env}
"""
```

Both accept single-line strings, triple-quoted blocks, bare identifiers, or **managed inline-script calls**:

```jaiph
log run `echo hello`()
logerr run `echo $1`("details")
```

A managed inline-script call executes the script and logs its stdout. The `run` keyword is required — bare inline scripts (`log \`…\`()`) are rejected at compile time.

### `fail`

Aborts the workflow or rule with a message on stderr and non-zero exit.

```jaiph
fail "Missing required configuration"
fail """
  Multiple issues found:
  - ${issue1}
  - ${issue2}
"""
```

### `return`

Sets the managed return value in rules and workflows.

```jaiph
return "success"
return "${result}"
return response                        # bare identifier — returns the variable's value
return """
  Report for ${name}:
  Status: ${status}
"""
```

**Bare identifier** — `return response` is sugar for `return "${response}"`. The identifier must be in scope (`const`, capture, or parameter). Unknown identifiers produce a compile-time `E_VALIDATE` error naming the missing binding.

**Direct managed call** — executes a target and uses its result as the return value:

```jaiph
return run helper()
return ensure check(input)
return match status {
  "ok" => "pass"
  _ => "fail"
}
return run `cat report.txt`()
return run `echo $1`("arg")
```

Inline scripts are supported with `return run \`…\`(args)`. The `run` keyword is required — bare inline scripts (`return \`…\`()`) are rejected at compile time.


### `send` — Channel Messages

Sends a message to a declared channel using `<-`.

```jaiph
alerts <- "Build started"
reports <- ${output}
results <- run build_message(data)
alerts <- """
  Build report for ${project}:
  Status: ${status}
"""
```

Combining capture and send (`name = channel <- …`) is a parse error.

### `match` — Pattern Matching

Pattern match on a string variable. The subject is a bare identifier (no `$` or `${}`). Arms are tested top-to-bottom; first match wins.

```jaiph
match status {
  "ok" => "all good"
  /err/ => "something went wrong"
  _ => "unknown"
}
```

Patterns can be string literals (exact equality), regex (`/pattern/`), or `_` (default). Exactly one default arm is required. Arms are **newline-delimited** — commas between or after arms are rejected at parse time (`"commas are not allowed in match arms; use one arm per line"`).

**Arm bodies** — the value expression after `=>`. Allowed: string literals (`"…"` or `"""…"""`), bare in-scope identifiers (`const`, capture, or parameter), `$var`/`${var}` interpolation, `fail "…"`, `run ref(…)`, `ensure ref(…)`. A bare word that is not an in-scope variable is rejected at compile time with `E_VALIDATE` (`unknown identifier "…" in match arm body`) — this catches typos like `_ => true` or `_ => blorp` that would otherwise silently become string literals. The `return` keyword inside an arm body is forbidden — use `return match x { … }` at the outer level. Inline script forms (backtick) are also forbidden in arms; use named scripts.

**Runtime execution** — arm bodies are not merely string values. Each form executes at runtime:
- `fail "message"` aborts the workflow with a non-zero exit and the given message.
- `run ref(args)` executes the named script or workflow and captures its return value.
- `ensure ref(args)` executes the named rule and captures its return value.
- String literals and variable references evaluate to their string value as before.

When a `const` step uses a `match` expression containing `run` or `ensure` arms, the CLI progress tree surfaces the nested script/workflow/rule targets as child steps (e.g. `▸ script safe_name` / `✓ script safe_name`), consistent with top-level `run` steps.

**Multiline arm bodies** — triple-quoted:

```jaiph
match mode {
  "verbose" => """
Detailed output enabled.
All logs will be shown.
  """
  _ => "standard"
}
```

**Expression form** — works with `const` and `return`:

```jaiph
const label = match status {
  "ok" => "success"
  _ => "failure"
}
```

The outer `return` in `return match x { … }` applies to the whole match expression and remains valid.

### `if` — Conditional Guard

Simple conditional that executes a block when a string comparison holds. No `else` branch — use `match` for exhaustive value branching.

```jaiph
if param == "" {
  fail "param was not provided"
}

if mode =~ /^debug/ {
  log "Debug mode enabled"
}
```

The subject is a bare identifier (no `$` or `${}`). Operators:

| Operator | Meaning | Operand type |
|---|---|---|
| `==` | exact string equality | `"string"` |
| `!=` | string inequality | `"string"` |
| `=~` | regex match | `/pattern/` |
| `!~` | regex non-match | `/pattern/` |

The body is a brace block containing any valid workflow/rule steps. `if` is a statement — it does not produce a value, so it cannot be used with `const` or `return`.

```jaiph
workflow default(env) {
  if env != "production" {
    log "Skipping deploy for non-production env"
    return ""
  }
  run deploy()
}
```


## Inline Scripts

Embed a shell command directly in a step without a named `script` definition. Single backticks for one-liners, triple backticks for multiline.

```jaiph
run `echo hello`()
const x = run `echo captured`()
const y = run `date +%s`()
```

Arguments are passed in parentheses after the closing backtick(s) and available as `$1`, `$2`, …:

```jaiph
run `echo $1-$2`("hello", "world")   # prints: hello-world
```

**Fenced block form** for multiline or polyglot:

<pre><code>run ```python3
import sys
print(f"args: {sys.argv[1:]}")
```()
</code></pre>

Inline scripts use the same emission layout (`scripts/__inline_<hash>`) and the same **`NodeWorkflowRuntime` spawn contract** as named scripts (full scope env, cwd from `JAIPH_WORKSPACE` / module path — see [Script isolation](#script-isolation)). `run async` with inline scripts is not supported.

## String Interpolation

Jaiph orchestration strings support `${identifier}` interpolation. Every identifier must reference a binding in scope (`const`, capture, or named parameter). Unknown names are rejected at compile time.

| Form | Description | Where |
|---|---|---|
| `${varName}` | Variable reference | All orchestration strings |
| `${var.field}` | Typed prompt field access | All orchestration strings |
| `${run ref(args)}` | Inline capture — executes and inlines result | All orchestration strings |
| `${ensure ref(args)}` | Inline capture — executes rule and inlines result | All orchestration strings |
| `$1`, `$2` | Positional args (bash convention) | Script bodies — syntax depends on interpreter |

`$varName` (without braces) is rejected — always use `${varName}`. Shell expansions like `${var:-fallback}`, `$(…)`, and `${#var}` are rejected in orchestration strings.

**Inline captures** execute a call directly inside the string:

```jaiph
log "Got: ${run some_script()}"
log "Status: ${ensure check_ok()}"
```

If the inline capture fails, the enclosing step fails. Nested inline captures are rejected — extract the inner call to a `const`.

## Script isolation

**Emitted script files** do not embed module `const` values or other Jaiph “shims” — the transpiler writes the authored body plus a shebang (see `emitScriptsForModule` / `emit-script.ts`). Anything a script needs from the module must be passed as **positional arguments** (`$1`, `$2`, …), read from paths under `JAIPH_WORKSPACE`, or live in shared script sources (`import script`).

**Subprocess environment (`NodeWorkflowRuntime`):** When the AST interpreter runs `run` / inline scripts, it spawns the emitted executable with the **current workflow scope environment** — a copy of the runner’s `process.env` merged with Jaiph-populated keys (`JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`, `JAIPH_RUN_DIR`, `JAIPH_ARTIFACTS_DIR`, prompt-related `JAIPH_AGENT_*` variables when set, and values derived from `config { … }` via metadata). It is **not** reset to a tiny fixed allowlist; anything visible to the workflow runner is visible to child scripts unless your deployment strips the parent environment.

The kernel helper `run-step-exec.ts` still uses a **minimal** env (`PATH`, `HOME`, `TERM`, `USER`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`) for its own **internal** `spawnSync` script-capture paths — that is not the same code path as ordinary `NodeWorkflowRuntime` `spawn()` for user `script` steps.

**Interpolation rules by body form:**

- **Backtick** (single-line): `${...}` is forbidden — the compiler rejects it to prevent ambiguity with shell expansion. Use `$1`, `$2` positional arguments.
- **Fenced block** (triple-backtick): `${...}` passes through to the shell as standard shell parameter expansion.

## Step Output Contract

Every step produces three outputs: status, value, and logs.

| Step | Status | Capture value (`x = …`) | Logs |
|---|---|---|---|
| `ensure rule` | exit code | explicit `return` value | artifacts |
| `run workflow` | exit code | explicit `return` value | artifacts |
| `run script` | exit code | stdout | artifacts |
| `run` inline | exit code | stdout | artifacts |
| `prompt` | exit code | final assistant answer | artifacts |
| `log` / `logerr` | always 0 | — | event stream |
| `fail` | non-zero (abort) | — | stderr |
| `run async` | aggregated | `Handle<T>` — resolves to return value on read | artifacts |
| `const` | same as RHS | binds locally | — |

## Lexical Notes

- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`
- **References:** `IDENT` (local) or `IDENT.IDENT` (module-qualified)
- **Comments:** Full-line `#` comments
- **Blank lines:** Preserved as visual grouping between steps; consecutive blanks collapsed by `jaiph format`
- **Shebang:** A `#!` first line of the file is ignored by the parser
- **String quoting:** `"..."` for single-line, `"""..."""` for multiline. Single-quoted strings are parse errors. Use `\"` for literal double quotes, `\\` for literal backslashes
- **Unified namespace:** Channels, rules, workflows, scripts, script import aliases, and top-level `const` share one namespace per module
- **Recursion limit:** Hard depth limit of 256 at runtime
