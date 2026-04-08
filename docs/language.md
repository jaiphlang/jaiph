---
title: Language
permalink: /language
redirect_from:
  - /language.md
---

# Language

Jaiph is a small orchestration language for AI agent workflows. You write `.jh` files that wire together prompts, shell scripts, validation rules, and message channels into executable pipelines. This page is the practical reference for every language primitive — what it does, how to use it, and where the edges are. For the formal EBNF grammar, see [Grammar](grammar). For system internals, see [Architecture](architecture).

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

The tag maps to `#!/usr/bin/env <tag>`. Any tag is valid. Alternatively, use a manual `#!` shebang as the first line. Combining both is an error.

Strings and scripts are structurally distinct and non-interchangeable — using one where the other is expected produces a compile-time error.

## Module Structure

A `.jh` file is a module. Modules contain top-level declarations in any order: imports, config, channels, constants, rules, scripts, and workflows. `jaiph format` normalizes them to a canonical order.

### Imports and Exports

`import` loads another module; `export` marks a declaration as public.

```jaiph
import "tools/security.jh" as security
import "bootstrap.jh" as bootstrap

export workflow default() {
  ensure security.scan_passes()
  run bootstrap.nodejs()
}
```

Imported symbols use dot notation: `alias.name`. The `.jh` extension is appended automatically if omitted. Import aliases must be unique within a module.

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

Routes (`->`) declare which workflows receive messages sent to the channel. See [Inbox & Dispatch](inbox) for dispatch semantics.

### Config

Optional block setting agent and run options. Allowed at module level and inside individual workflow bodies.

```jaiph
config {
  agent.default_model = "claude-sonnet-4-6"
  agent.backend = "claude"
  run.debug = true
}
```

See [Configuration](configuration) for all available keys and precedence rules.

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

Workflows support all step types: `run`, `ensure`, `prompt`, `const`, `log`, `logerr`, `fail`, `return`, `send`, `match`, `run async`, and `recover`.

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

Rules are more restricted than workflows: they cannot use `prompt`, `send`, or `run async`. Inside a rule, `run` targets scripts only (not workflows). Rules execute in a read-only filesystem — they are meant for validation and checks, not side effects.

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

Parameter names must be valid identifiers, unique, and not reserved keywords. Inside the body, parameters are accessed as `${paramName}`.

### Call Sites

Arguments are comma-separated inside parentheses:

```jaiph
run setup()
run deploy("prod", version)
```

**Bare identifier arguments** pass a variable's value without quoting. `run deploy(env)` is equivalent to `run deploy("${env}")`:

```jaiph
const task = run get_next_task()
run process(task)                    # bare identifier — passes value of task
run process(task, "extra context")   # mixed bare + quoted
run process("${task}")              # equivalent to bare form
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

### `run async` — Concurrent Execution

Starts a workflow or script concurrently. All pending async steps are implicitly joined before the enclosing workflow returns.

```jaiph
workflow default() {
  run async lib.task_a()
  run async lib.task_b()
  # both joined automatically before workflow returns
}
```

Constraints: workflow-only (rejected in rules), capture not supported.

### `ensure` — Execute a Rule

Runs a rule and succeeds if its exit code is 0.

```jaiph
ensure check_deps()
ensure lib.validate(input)
const result = ensure validator(path)
```

### `recover` — Failure Recovery

Both `ensure` and `run` support a `recover` clause. On failure, the recovery body runs once. `recover` requires an explicit binding that receives merged stdout+stderr from the failed step.

```jaiph
# Single-statement recovery
ensure install_deps() recover (failure) run fix_deps()

# Block recovery
run deploy(env) recover (err) {
  log "Deploy failed, rolling back"
  run rollback(env)
}

# Retry via recursion
workflow deploy(env) {
  ensure ci_passes() recover (failure) {
    prompt "CI failed — fix the code."
    run deploy(env)
  }
}
```

Bare `recover` without a binding is a parse error. All call arguments must appear inside parentheses before `recover`.

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

Introduces a variable in a workflow or rule body.

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

Both accept single-line strings, triple-quoted blocks, or bare identifiers.

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
return """
  Report for ${name}:
  Status: ${status}
"""
```

**Direct managed call** — executes a target and uses its result as the return value:

```jaiph
return run helper()
return ensure check(input)
return match status {
  "ok" => "pass"
  _ => "fail"
}
```


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

Patterns can be string literals (exact equality), regex (`/pattern/`), or `_` (default). Exactly one default arm is required.

**Expression form** — works with `const` and `return`:

```jaiph
const label = match status {
  "ok" => "success"
  _ => "failure"
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

Inline scripts have the same subprocess isolation as named scripts. They are emitted as `scripts/__inline_<hash>` with deterministic names. `run async` with inline scripts is not supported.

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

## Script Isolation

Scripts run in a clean process environment. Only these variables are inherited:

- **System:** `PATH`, `HOME`, `TERM`, `USER`
- **Jaiph:** `JAIPH_LIB`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`
- **Positional arguments:** `$1`, `$2`, …

Module-scoped `const` variables are not visible. Use shared libraries (`source "$JAIPH_LIB/…"`) or pass data as arguments.

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
| `run async` | aggregated | not supported | artifacts |
| `const` | same as RHS | binds locally | — |

## Lexical Notes

- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`
- **References:** `IDENT` (local) or `IDENT.IDENT` (module-qualified)
- **Comments:** Full-line `#` comments
- **Blank lines:** Preserved as visual grouping between steps; consecutive blanks collapsed by `jaiph format`
- **Shebang:** A `#!` first line of the file is ignored by the parser
- **String quoting:** `"..."` for single-line, `"""..."""` for multiline. Single-quoted strings are parse errors. Use `\"` for literal double quotes, `\\` for literal backslashes
- **Unified namespace:** Channels, rules, workflows, scripts, and top-level `const` share one namespace per module
- **Recursion limit:** Hard depth limit of 256 at runtime
