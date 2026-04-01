---
title: Grammar
permalink: /grammar
redirect_from:
  - /grammar.md
---

# Jaiph Grammar

Jaiph source files (`.jh`) combine a small orchestration language with shell execution. **Workflows** and **rules** express Jaiph steps — sequencing, conditionals, prompts, channels. **Scripts** contain Bash (or another interpreter via shebang) and run as isolated subprocesses. The runtime interprets the AST directly; only script bodies are emitted as executable files. This page is the language reference. For system boundaries and event contracts, see [Architecture](architecture).

**Scope:** Lexical rules, syntax, and runtime semantics for normal modules (`.jh`). Test files (`*.test.jh`) are described in [Testing](testing.md). CLI and configuration are covered in [CLI](cli.md) and [Configuration](configuration.md).

**Source of truth:** When this document and the compiler disagree, treat the implementation as authoritative.

## Language Concepts

Jaiph enforces a strict boundary between orchestration and execution. Workflows and rules contain only Jaiph steps. Bash lives in `script` bodies.

- **Workflows** — Named sequences of Jaiph steps: `ensure`, `run`, `prompt`, `const`, `fail`, `return`, `log`/`logerr`, inbox `send` (`channel <- …`) and `route` (`channel -> workflow`), brace `if`, `match`, and `run async`. Any line that is not a recognized step is a parse error — extract bash to a `script` and call it with `run`.

- **Rules** — Named blocks of structured Jaiph steps: `ensure` (other rules), `run` (scripts only — not workflows), `const`, brace `if`, `match`, `fail`, `log`/`logerr`, `return "…"`. Rules cannot use `prompt`, inbox send/route, `wait`, `run async`, or `ensure … recover`.

- **Scripts** — Top-level `script` blocks emitted as separate executable files under the workspace `scripts/` directory. Called from workflows or rules with `run`. Bodies are opaque to the compiler — the parser does not check Jaiph keywords inside them. Use `echo`/`printf` for data output and `return N`/`return $?` for exit status. Polyglot support: a `#!` shebang as the first line selects the interpreter; otherwise `#!/usr/bin/env bash` is used. For trivial one-off commands, **inline scripts** (`run script("body")`) let you embed a script body directly in a step without a named definition — see [`run` — Inline Scripts](#inline-scripts).

- **Channels** — Named message queues declared with `channel name`. Workflows send messages with `<-` and register route handlers with `->`. See [Inbox & Dispatch](inbox.md).

- **Config** — Optional block setting agent and run options. Allowed at module level and inside individual workflow bodies. See [Configuration](configuration.md).

## Imports and Exports

`import "path" as alias` loads another module. `export rule` / `export workflow` marks a declaration as public. In practice, any rule or workflow in an imported module can be referenced — export is not enforced at reference time.

```jaiph
import "tools/security.jh" as security
import "bootstrap.jh" as bootstrap

export workflow default {
  ensure security.scan_passes()
  run bootstrap.nodejs()
}
```

Imported symbols use **dot notation**: `alias.name`. A reference is either a bare `IDENT` (local) or `IDENT.IDENT` (module-qualified). The compiler validates that the target exists and matches the calling keyword (`ensure` for rules, `run` for workflows/scripts).

## Module-Level Declarations

### Top-Level `const`

`const name = value` declares a module-scoped variable. Values can be double-quoted strings (including multiline), single-quoted strings, or bare tokens like numbers.

```jaiph
const REPO = "my-project"
const MAX_RETRIES = 3
const GREETING = "Hello,
world"
```

Variables are accessible as `${name}` inside that module's rules and workflows. They are **not** passed to script subprocesses — use arguments or shared libraries instead. Declaration order matters: `${name}` in a value only expands variables already bound above. Names share the unified namespace with channels, rules, workflows, and scripts.

Top-level `local` is rejected — use `const`.

### Channel Declarations

```jaiph
channel alerts
channel reports
```

One channel per line. Channels are used with `send` (`<-`) and `route` (`->`) inside workflows.

## Definitions

All three definition forms — `rule`, `workflow`, `script` — require braces on the declaration line. Definitions must **not** use parentheses (parentheses are reserved for call sites).

```jaiph
rule check_status { … }        # correct
workflow default { … }          # correct
script setup { … }              # correct
# workflow default() { … }      — E_PARSE: definitions must not use parentheses
```

## Call Arguments and Positional Parameters

Call sites pass arguments in parentheses with comma-separated expressions:

```jaiph
run show_args("my-task", "my-role")
ensure check_branch("${arg1}")
```

There is no declaration-time parameter list, no default values, and no compile-time arity checking. The runtime exposes arguments as `${arg1}`, `${arg2}`, … in orchestration strings (rules and workflows) and `$1`, `$2`, … in script bodies.

## Workflow Steps

### `run` — Execute a Workflow or Script

In a **workflow**, `run` targets a workflow or script. In a **rule**, `run` targets a script only.

```jaiph
run setup_env()
run lib.build_project("${arg1}")
result = run helper("${arg}")
const output = run transform()
```

Shell redirection or pipelines after `run` (`>`, `|`, `&`) are rejected — use a script for shell I/O.

**Capture:** For a workflow callee, capture gets the explicit `return "…"` value. For a script callee, capture gets stdout.

#### Inline Scripts

`run script("body")` embeds a shell command directly in a workflow or rule step without declaring a named `script` block. This is useful for trivial one-off commands where a full `script` definition would be verbose.

```jaiph
workflow default {
  run script("echo hello")
  x = run script("echo captured")
  const y = run script("date +%s")
  log "got: ${x}, time: ${y}"
}
```

The body must be a double-quoted string. Optional arguments are passed as comma-separated strings after the body and are available as `$1`, `$2`, … inside the script:

```jaiph
run script("echo $1-$2", "hello", "world")   # prints: hello-world
```

**Polyglot support:** If the body starts with `#!`, the first line (up to the first `\n`) becomes the shebang and the rest becomes the body:

```jaiph
run script("#!/usr/bin/env python3\nprint('hello from python')")
```

**Deterministic naming:** Inline script bodies are emitted as executable files under `scripts/` with names of the form `__inline_<hash>` (12-character SHA-256 prefix of body + shebang). The same body and shebang always produce the same artifact name across runs.

**Isolation:** Inline scripts run with the same subprocess isolation as named scripts — no parent scope variables are visible. Only positional arguments and essential Jaiph variables (`JAIPH_LIB`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`) are inherited.

**Restrictions:**
- `run async script(…)` is not supported — inline scripts cannot be used with `run async`.
- The body must be a double-quoted string (single quotes are not accepted).

### `run async` — Concurrent Execution

`run async ref(args)` starts a workflow or script concurrently. All pending async steps are implicitly joined before the enclosing workflow returns. If any fail, the workflow fails with an aggregated error.

```jaiph
workflow default {
  run async lib.task_a()
  run async lib.task_b()
  # both joined automatically before workflow returns
}
```

Constraints:
- Workflow-only — rejected in rules with `E_VALIDATE`.
- Capture is not supported: `name = run async …` is `E_PARSE`.
- For concurrent bash (pipelines, `&`), put the bash in a script and call with `run`.

### `ensure` — Execute a Rule

`ensure` runs a rule and succeeds if its exit code is 0.

```jaiph
ensure check_deps()
result = ensure lib.validate("${input}")
```

### `ensure … recover` — Retry with Recovery

When `ensure` includes a `recover` block, failure triggers a retry loop: run the rule, on failure run the recovery body, repeat until the rule passes or the maximum attempt rounds are reached (default 3, overridable with `JAIPH_ENSURE_MAX_RETRIES`).

```jaiph
# Single-statement recovery
ensure install_deps() recover run fix_deps()

# Block recovery
ensure ci_passes("${repo}") recover {
  log "CI failed, attempting fix"
  run auto_fix()
}
```

The recovery body receives `${arg1}` as the merged stdout+stderr from the failed rule execution. Each retry gets fresh output from the current attempt.

Syntax rules:
- All rule arguments must appear inside the call parentheses **before** `recover`.
- `recover` must be followed by at least one recovery step (bare `recover` at end of line is `E_PARSE`).
- `ensure … recover` is workflow-only — not allowed in rule bodies.

### `prompt` — Agent Interaction

Sends a double-quoted string to the configured agent backend.

```jaiph
prompt "Review the following code for security issues"
answer = prompt "Summarize the report"
```

**Typed prompt (returns schema):** Ask the agent for structured JSON output:

```jaiph
result = prompt "Analyze this code" \
  returns '{ type: string, risk: string }'
```

When `returns` is present, capture is required. The schema is flat only — allowed types are `string`, `number`, `boolean`. The runtime validates the response: it searches for valid JSON (last non-empty line, fenced code blocks, standalone `{…}`, embedded JSON). On success, the capture variable holds the raw JSON string and each field is accessible via **dot notation** — `${result.type}`, `${result.risk}`. The underscore form (`${result_type}`) also works but dot notation is preferred for clarity. On failure, the step fails with a parse, missing-field, or type error.

**Dot notation validation:** The compiler validates `${var.field}` references at compile time. If `var` is not a typed prompt capture, the compiler reports an error. If `field` is not defined in the `returns` schema, the error lists available fields. At runtime, `${result.type}` resolves to the same storage slot as `${result_type}` — both forms are interchangeable.

Prompts are not allowed in rules.

### `const` — Variable Binding

`const name = <rhs>` introduces a variable in the workflow or rule body.

```jaiph
const tag = "v1.0"
const result = run helper("${arg}")
const check = ensure validator("${input}")
const answer = prompt "Summarize the report"
```

RHS forms: value expressions (`${var}`, quoted strings), or explicit `run`/`ensure`/`prompt` capture. A bare reference like `const x = ref(args)` is rejected — use `const x = run ref(args)`.

Restrictions on const RHS: `$(…)`, `${var:-fallback}`, `${var%%…}`, `${var//…}`, and `${#var}` are all rejected.

### `if` / `else if` / `else` — Conditionals

Only brace form with `ensure` or `run` conditions:

```jaiph
if ensure lib.check_input() {
  run process()
} else if not run file_exists("${path}") {
  fail "missing file"
} else {
  log "skipping"
}
```

`not` negates the condition. Branches contain normal workflow steps. Shell-style `if … then … fi` is not supported.

### `send` — Channel Messages

```jaiph
alerts <- "Build started"
reports <- ${output}
results <- run build_message("${data}")
inbox <-                                    # forward: sends ${arg1}
```

RHS must be empty (forward), a double-quoted literal, `${var}`, or `run ref(args)`. Arbitrary shell on the RHS is `E_PARSE`. Combining capture and send (`name = channel <- …`) is `E_PARSE`.

### `route` — Channel Routing

```jaiph
alerts -> handle_alert
events -> handler_a, handler_b
```

Registers a static routing rule. When a message arrives on the channel, the runtime calls each target workflow with `${arg1}=message`, `${arg2}=channel`, `${arg3}=sender`. Multiple targets dispatch sequentially. Routes are stored in `WorkflowDef.routes`, not in steps. See [Inbox & Dispatch](inbox.md).

### `log` and `logerr`

```jaiph
log "Processing ${arg1}"
logerr "Warning: ${name} not found"
```

`log` writes to stdout; `logerr` writes to stderr (shown with a red `!` marker in the progress tree). Both support `${identifier}` interpolation and inline captures. At runtime, backslash escapes in the final string are interpreted (`\n` → newline).

### `fail`

```jaiph
fail "Missing required configuration"
```

Aborts the workflow or rule with a message on stderr and non-zero exit.

### `return`

```jaiph
return "success"
return "${result}"
return run helper()
return ensure check("${input}")
```

Sets the managed return value in rules and workflows. The value can be a quoted string, a variable reference, or a **direct managed call** using `return run ref(args)` or `return ensure ref(args)`. A direct managed call executes the target and uses its result as the return value — equivalent to capturing into a variable and returning it, but without the boilerplate:

```jaiph
# Before: capture then return
const result = run helper()
return "${result}"

# After: direct return
return run helper()
```

In workflows, `return run` targets a workflow or script; `return ensure` targets a rule. In rules, `return run` targets a script only; `return ensure` targets another rule. The same validation rules that apply to standalone `run`/`ensure` steps apply here — unknown refs, type mismatches, and shell redirection are all rejected at compile time.

A bare integer (`return 0`) or `return $?` is a bash exit code, not a Jaiph value return. `return "…"` is not allowed in script bodies — use `echo`/`printf`.

### `match`

```jaiph
match ${status} {
  "ok" => "all good"
  /err/ => "something went wrong"
  _ => "unknown"
}
```

Pattern match on a string value. Arms are tested top-to-bottom; the first match wins. Patterns can be:

- **String literal** (`"ok"`) — exact equality against the subject
- **Regex** (`/err/`) — tested against the subject
- **Wildcard** (`_`) — matches anything

Exactly one `_` wildcard arm is required.

**Expression form:** `match` works as an expression with `const` and `return`:

```jaiph
const label = ${status} match {
  "ok" => "success"
  _ => "failure"
}

return ${status} match {
  "ok" => "pass"
  _ => "fail"
}
```

### `wait`

```jaiph
wait
```

Legacy no-op kept for backwards compatibility. Use `run async` for managed parallel work.

### Assignment Capture

`name = <step>` captures a value without `const`:

```jaiph
result = run helper("${arg}")
check = ensure validator("${input}")
answer = prompt "Summarize the report"
```

Prefer `const name = …` for new code.

## Scripts

### Bash Scripts

```jaiph
script setup_env {
  export BASE_DIR=$(pwd)
  mkdir -p "$BASE_DIR/output"
  echo "Environment initialized"
}
```

Script bodies are opaque bash — the compiler does not parse them as Jaiph steps. For bash scripts, the emitter applies only lightweight transforms: `return` normalization, `local`/`export`/`readonly` spacing, and import alias resolution.

### Polyglot Scripts

#### Interpreter tags (recommended)

Use `script:<tag>` to select a common interpreter without writing a shebang line:

```jaiph
script:python3 analyze {
  import sys
  print(f"Analyzing {sys.argv[1]}")
}

script:node transform {
  const data = process.argv[2];
  console.log(JSON.stringify({ result: data }));
}
```

Supported tags and their shebangs:

| Tag | Shebang |
|---|---|
| `node` | `#!/usr/bin/env node` |
| `python3` | `#!/usr/bin/env python3` |
| `ruby` | `#!/usr/bin/env ruby` |
| `perl` | `#!/usr/bin/env perl` |
| `pwsh` | `#!/usr/bin/env pwsh` |
| `deno` | `#!/usr/bin/env deno run` |
| `bash` | `#!/usr/bin/env bash` |

Unknown tags are rejected at parse time with an actionable error listing valid tags. Combining a tag with a manual shebang in the body is also rejected — choose one or the other.

#### Manual shebang (escape hatch)

Add a shebang as the first line to use any interpreter not covered by a built-in tag:

```jaiph
script run_lua {
  #!/usr/bin/env lua
  print("hello from lua")
}
```

Non-bash scripts skip Jaiph keyword validation and emit the body verbatim.

### Script Isolation

Scripts run in a clean process environment (`env -i`). Only these variables are inherited:

- System: `PATH`, `HOME`, `TERM`, `USER`
- Jaiph: `JAIPH_LIB`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`
- Positional arguments (`$1`, `$2`, …)

Module-scoped `const` variables are **not** visible. Use shared libraries (`source "$JAIPH_LIB/…"`) or pass data as arguments.

## String Interpolation {#string-interpolation}

Jaiph orchestration strings support `${identifier}` interpolation:

| Form | Status | Where |
|---|---|---|
| `${varName}` | Primary | All Jaiph strings |
| `${var.field}` | Dot notation — typed prompt field access | All Jaiph strings |
| `${arg1}`, `${arg2}`, … | Positional arguments | All Jaiph strings |
| `${run ref(args)}` | Inline capture — executes call, inlines output | All Jaiph strings |
| `${ensure ref(args)}` | Inline capture — executes rule, inlines result | All Jaiph strings |
| `$varName` | Rejected — use `${varName}` | — |
| `$1`, `$2` | Not supported — use `${arg1}`, `${arg2}` | `script` bodies only |
| `${var:-fallback}` | Rejected (`E_PARSE`) | — |
| `$(…)` | Rejected (`E_PARSE`) | — |
| `` ` `` (unescaped backtick) | Rejected (`E_PARSE`) — escape with `` \` `` | — |

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
| `run script("…")` (inline) | script exit code | **stdout** of script body | script stdout/stderr to artifacts |
| `prompt` | prompt exit code | final assistant answer | transcript to artifacts |
| `log` / `logerr` | always 0 | empty | event + stdout/stderr |
| `fail` | non-zero (abort) | empty | message to stderr |
| `run async` | aggregated | not supported (capture rejected) | async step logs to artifacts |
| `wait` | no-op | empty | n/a |
| `const` | same as RHS step | empty (binds local) | n/a |

Key rules:
- For `ensure`/`run` to a rule or workflow, assignment captures only the callee's explicit `return "…"` (or `return run …` / `return ensure …`).
- For `run` to a script, assignment captures **stdout**. Use `echo`/`printf` to pass data back.
- `return "value"` / `return "${var}"` / `return run ref()` / `return ensure ref()` are valid in rules and workflows only, not in scripts.

## Lexical Notes

- **Identifiers:** `[A-Za-z_][A-Za-z0-9_]*`
- **References:** `IDENT` or `IDENT.IDENT` (module-qualified)
- **Comments:** Full-line `#` comments. Empty lines are ignored.
- **Shebang:** A `#!` first line of the file is ignored by the parser.
- **Import path:** Quoted string in `import "path" as alias`. Missing `.jh` extension is appended automatically.

## EBNF (Practical Form)

Informal symbols: `string` = quoted string; `call_ref` = `REF "(" [args] ")"` with comma-separated arguments; `quoted_or_multiline_string` = double-quoted string supporting `\$`, `\"`, `\\`, `` \` `` escapes, line continuation with trailing `\`, and `${identifier}` / `${run …}` / `${ensure …}` interpolation.

```ebnf
file            = { top_level } ;

top_level       = config_block | import_stmt | channel_decl | env_decl | rule_decl | script_decl | workflow_decl ;

config_block    = "config" "{" { config_line } "}" ;
config_line     = config_key "=" config_value ;
config_key      = "agent.default_model" | "agent.command" | "agent.backend" | "agent.trusted_workspace"
                | "agent.cursor_flags" | "agent.claude_flags" | "run.logs_dir" | "run.debug"
                | "run.inbox_parallel" | "runtime.docker_enabled" | "runtime.docker_image" | "runtime.docker_network"
                | "runtime.docker_timeout" | "runtime.workspace" ;
config_value    = string | "true" | "false" | integer | string_array ;
integer         = digit { digit } ;
string_array    = "[" { array_element } "]" ;
array_element   = string [ "," ] ;

import_stmt     = "import" string "as" IDENT ;

channel_decl    = "channel" IDENT ;

env_decl        = "const" IDENT "=" env_value ;
env_value       = quoted_or_multiline_string | single_quoted_string | bare_value ;

rule_decl       = [ "export" ] "rule" IDENT "{" { rule_body_step } "}" ;
rule_body_step  = comment_line | workflow_step ;
  (* validation rejects prompt, send, wait, ensure…recover, const…=prompt, run async,
     and run targets that are not scripts *)

script_decl     = ( "script" | "script:" INTERPRETER_TAG ) IDENT "{" [ shebang_line ] { script_line } "}" ;
INTERPRETER_TAG = "node" | "python3" | "ruby" | "perl" | "pwsh" | "deno" | "bash" ;
shebang_line    = "#!" rest_of_line ;  (* rejected when INTERPRETER_TAG is present *)
script_line     = comment_line | command_line ;

workflow_decl   = [ "export" ] "workflow" IDENT "{" [ workflow_config ] { workflow_step } "}" ;
workflow_config = config_block ;
  (* optional per-workflow override; must appear before steps;
     only agent.* and run.* keys allowed; runtime.* yields E_PARSE *)

workflow_step   = ensure_stmt | run_stmt | run_async_stmt | prompt_stmt | prompt_capture_stmt
                | const_decl_step | ensure_capture_stmt | run_capture_stmt | return_stmt
                | fail_stmt | wait_stmt | log_stmt | logerr_stmt | send_stmt | route_decl
                | if_brace_stmt | match_stmt | comment_line ;

const_decl_step = "const" IDENT "=" const_rhs ;
const_rhs       = quoted_or_multiline_string | single_quoted_string | bash_value_expr
                | "run" ( call_ref | inline_script ) | "ensure" call_ref
                | "prompt" quoted_or_multiline_string [ returns_schema ]
                | match_expr ;

fail_stmt       = "fail" double_quoted_string ;
wait_stmt       = "wait" ;
run_async_stmt  = "run" "async" call_ref ;
return_stmt     = "return" return_value ;
return_value    = double_quoted_string | single_quoted_string | "$" IDENT | "${" IDENT "}"
                | "run" call_ref | "ensure" call_ref | match_expr ;

match_stmt      = "match" match_subject "{" { match_arm } "}" ;
match_expr      = match_subject "match" "{" { match_arm } "}" ;
match_subject   = "$" IDENT | "${" IDENT "}" | double_quoted_string ;
match_arm       = match_pattern "=>" arm_body ;
match_pattern   = double_quoted_string | single_quoted_string | "/" regex_source "/" | "_" ;
arm_body        = double_quoted_string | single_quoted_string | "$" IDENT | "${" IDENT "}" ;

send_stmt       = IDENT "<-" [ send_rhs ] ;
send_rhs        = double_quoted_string | "${" IDENT "}" | "run" call_ref | REF ;

route_decl      = REF "->" REF { "," REF } ;

log_stmt        = "log" double_quoted_string ;
logerr_stmt     = "logerr" double_quoted_string ;

ensure_stmt     = "ensure" call_ref [ "recover" recover_body ] ;
ensure_capture_stmt = IDENT "=" "ensure" call_ref [ "recover" recover_body ] ;
run_capture_stmt   = IDENT "=" "run" ( call_ref | inline_script ) ;
run_stmt        = "run" ( call_ref | inline_script ) ;
inline_script   = "script" "(" string { "," string } ")" ;
prompt_stmt     = "prompt" quoted_or_multiline_string [ returns_schema ] ;
prompt_capture_stmt = IDENT "=" "prompt" quoted_or_multiline_string [ returns_schema ] ;
returns_schema  = "returns" ( single_quoted_string | double_quoted_string ) ;

recover_body    = single_workflow_stmt | "{" { workflow_step } "}" ;
single_workflow_stmt = ensure_stmt | run_stmt | prompt_stmt | prompt_capture_stmt
                | const_decl_step | run_capture_stmt | ensure_capture_stmt
                | return_stmt | fail_stmt | wait_stmt | log_stmt | logerr_stmt
                | send_stmt | if_brace_stmt ;

if_brace_stmt   = "if" [ "not" ] brace_if_head "{" { workflow_step } "}"
                  { "else" "if" [ "not" ] brace_if_head "{" { workflow_step } "}" }
                  [ "else" "{" { workflow_step } "}" ] ;
brace_if_head   = "ensure" call_ref | "run" call_ref ;
```

## Validation Rules

After parsing, the compiler validates references and config (`src/transpile/validate.ts`). Error codes:

- **E_PARSE:** Invalid syntax — duplicate config, invalid keys/values, unescaped backticks, `$(…)` or `${var:-fallback}` in orchestration strings, `prompt … returns` without capture, bare `ref(args)` in const RHS (use `run`/`ensure`/`prompt`), `local` at top level, unrecognized workflow/rule line, invalid send RHS, arguments after `recover`, bare `recover` with no recovery step, nested inline captures, shell redirection after `run`/`ensure`, parentheses on definitions, or missing `{` on definition line.
- **E_SCHEMA:** Invalid `returns` schema — empty, non-flat, unsupported type (only `string`, `number`, `boolean`).
- **E_VALIDATE:** Reference errors — unknown rule/workflow, duplicate alias, `ensure` on non-rule, `run` on rule, `run` to workflow inside rule, `run async` in rule, forbidden Jaiph usage inside `$(…)`, dot notation on non-prompt variable or invalid field name.
- **E_IMPORT_NOT_FOUND:** Import target file does not exist.

Validation rules:

1. At most one `config` block per file and per workflow. Workflow config must appear before steps. Only `agent.*` and `run.*` keys in workflow config.
2. Config values must match expected types. `agent.backend` must be `"cursor"` or `"claude"`.
3. Import aliases must be unique (`E_VALIDATE`). Import targets must exist (`E_IMPORT_NOT_FOUND`).
4. **Unified namespace:** channels, rules, workflows, scripts, and top-level `const` share one namespace per module.
5. `ensure` must target a rule. `run` in a workflow targets a workflow or script. `run` in a rule targets a script only. These rules also apply to `return run` and `return ensure` forms.
6. Channel references in `send`/`route` must resolve to declared channels. Route targets must be workflows.
7. `ensure … recover` argument ordering: all arguments inside parentheses before `recover`.
8. Shell redirection (`>`, `|`, `&`) after `run`/`ensure` is rejected — use a script.

## Build Artifacts {#build-artifacts}

`jaiph run` and `jaiph test` do **not** transpile workflows to shell. The CLI calls `buildScripts()`, which emits only per-`script` executable files under `scripts/`. Workflows, rules, prompts, channels, and control flow are interpreted by `NodeWorkflowRuntime` from the AST.

Each `script name { … }` becomes `scripts/<name>` with `chmod +x`: shebang (custom or default `#!/usr/bin/env bash`) plus the body. Inline scripts (`run script("body")`) are emitted as `scripts/__inline_<hash>` with deterministic hash-based names. At runtime, script steps run these files with a minimal environment.

## Runtime Execution

At runtime, the Node workflow runtime interprets the AST directly:

- **Config:** Precedence chain: environment → workflow-level → module-level → defaults.
- **Script isolation:** Managed subprocesses with only essential variables. Module-scoped variables not visible.
- **Prompt + schema:** JSON extraction and schema validation via the JS kernel. Exit codes: 0=ok, 1=parse error, 2=missing field, 3=type mismatch.
- **ensure … recover:** Bounded retry loop (default 3 rounds, `JAIPH_ENSURE_MAX_RETRIES`). Recovery body's `${arg1}` gets fresh merged stdout+stderr per attempt.
- **Assignment capture:** Rules and workflows use explicit `return "…"`. Scripts use stdout.
- **`run async`:** Promise-based concurrency. Implicit join via `Promise.allSettled` before workflow returns. Failures aggregated.
- **Channels:** Messages enqueued via `send`, dispatched to route targets at workflow end. Each target receives `${arg1}=message`, `${arg2}=channel`, `${arg3}=sender`.
