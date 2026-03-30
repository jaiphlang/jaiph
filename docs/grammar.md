---
title: Grammar
permalink: /grammar
redirect_from:
  - /grammar.md
---

# Jaiph Grammar

Jaiph source files (`.jh`) combine a small **orchestration** language with Bash inside **`script`** blocks. The compiler parses top-level declarations and structured steps in workflows and rules, and validates references and bash fragments (where they still appear). **`jaiph run`** / **`jaiph test`** start from the **TypeScript CLI**: the CLI parses sources, builds a runtime graph, and the **Node workflow runtime** (`NodeWorkflowRuntime`) interprets the AST directly — no Bash transpilation on the runtime path. **Prompt** execution, **managed step subprocesses**, **inbox** dispatch, and **`__JAIPH_EVENT__` / `run_summary.jsonl`** event emission are handled by the **JS kernel** (`runtime/kernel/`). This page is the language reference: what you can write, what it means at runtime, and how it maps to execution.

**Scope:**

- **In scope:** Lexical rules, syntax (EBNF), parse-time and runtime semantics, and validation behavior for normal modules.
- **Out of scope:** Test files (`*.test.jh`) have their own grammar and are described in [Testing](testing.md). The CLI and configuration file format are covered in [CLI](cli.md) and [Configuration](configuration.md).

**Source of truth:** When this document and the compiler disagree, treat the implementation as authoritative.

**Design model:** Jaiph uses a strict **orchestration vs execution** boundary — workflows and rules express Jaiph steps; **bash lives in `script` bodies** (and in shared libraries under e.g. `.jaiph/lib/` loaded via `source "$JAIPH_LIB/…"`). Detailed rationale and legality matrix: `.jaiph/language_redesign_spec.md`.

## High-level concepts

- **Rules** — Named blocks of **structured Jaiph steps only**: `ensure` (other **rules**), `run` (**scripts** only — not workflows), `const`, brace `if`, `fail`, `log`/`logerr`, `return "…"`. No raw shell lines, `prompt`, inbox send/route, `wait`, or `ensure … recover`.
- **Workflows** — Named sequences of **Jaiph-only** steps: `ensure`, `run`, `prompt`, `const`, `fail`, `return`, `log`/`logerr`, `send`, `route`, brace **`if`**, and **`run async`**. Any line that is not a recognized step is a **parse error** (extract bash to a **`script`** and call it with **`run`**).
- **Scripts** — Top-level **`script`** blocks, emitted as **separate executable files** under the workspace **`scripts/`** directory (see [Build artifacts](#build-artifacts)). From a **workflow** or **rule**, call them only with **`run`**. Bodies may not use Jaiph keywords `fail`, `const`, `log`, `logerr`, or Jaiph-style `return "…"` / `return "${var}"` — use bash `return N` / `return $?` and **stdout** (`echo`, `printf`) for data passed back to `run` callers. Scripts cannot be used with `ensure`, are not valid route targets, and cannot be exported. **Polyglot support:** if the first non-empty line of a script body is a shebang (`#!`), it becomes the script's interpreter line (e.g. `#!/usr/bin/env node`); otherwise `#!/usr/bin/env bash` is used. Non-bash scripts skip Jaiph keyword validation.
- **ensure** — Runs a rule; succeeds if its exit code is 0. Optional `recover` runs on failure and retries until the rule passes or max retries are reached (**workflows only** — not inside rule bodies).
- **run** — In a **workflow**, invokes a **workflow** or **script**. In a **rule**, invokes a **script** only (not a workflow). Must not target a rule or arbitrary shell.
- **prompt** — Sends a double-quoted string to the configured agent. Optional `returns` schema asks the agent for one line of JSON and validates it.
- **config** — Optional block setting agent and run options (model, backend, logs dir, etc.). Allowed at the top level of a file (module-wide) and inside individual workflow bodies for per-workflow overrides (`agent.*` and `run.*` keys only; `runtime.*` is top-level only).
- **local / const (module scope)** — `local name = value` or `const name = value` declares a module-scoped variable (same value forms). The name shares the unified namespace with channels, rules, workflows, and scripts. Prefer **`const`** for new orchestration modules; **`local`** remains accepted. Inside **`script`** bodies, use bash **`local`** for temporary variables. Variables are module-scoped only and cannot be exported or referenced across modules.
- **import / export** — `import "path" as alias` loads another module; `export rule` / `export workflow` marks a declaration as part of the module’s public interface. Any rule or workflow in an imported module can be referenced (export is not enforced at reference time).

## String interpolation {#string-interpolation}

Jaiph strings follow **JS template literal semantics**. Only **`${identifier}`** interpolation is supported in orchestration strings (`log`, `logerr`, `fail`, `prompt`, `return`, send literals, `run`/`ensure` args). The interpolation forms are:

| Form | Status | Where |
|---|---|---|
| `${varName}` | **Primary** — JS template literal style | All Jaiph strings |
| `${arg1}`, `${arg2}`, … | **Canonical for positional arguments** | All Jaiph strings |
| `$varName` | **Rejected** in orchestration strings — use `${varName}` | Use `${identifier}` form |
| `$1`, `$2`, … | **Not supported** in orchestration strings — use `${arg1}`, `${arg2}` | `script` bodies only (bash shell idiom) |
| `${var:-fallback}` | **Rejected** (`E_PARSE`) | Shell syntax; use conditional logic or pass values via call arguments (`${arg1}`, …) |
| `` ` `` (unescaped backtick) | **Rejected** (`E_PARSE`) | Must escape with `` \` `` |
| `$(...)` | **Rejected** in orchestration strings (`E_PARSE`) | Use a `script` and `run` |
| `${run ref(args)}` | **Inline capture** — executes managed call, inlines output | All Jaiph strings (see below) |
| `${ensure ref(args)}` | **Inline capture** — executes rule, inlines return value | All Jaiph strings (see below) |

**Inline capture interpolation (`${run ...}` / `${ensure ...}`):**

Orchestration strings (`log`, `logerr`, `fail`, `prompt`, `return`, send literals, `const` RHS expressions) support **inline managed captures**. Instead of extracting a one-time value into a temporary variable, you can execute a managed call directly inside the string:

```jaiph
# Without inline capture (still valid):
const result = run some_script()
log "Got: ${result}"

# With inline capture:
log "Got: ${run some_script()}"
log "Status: ${ensure check_ok()}"

# With arguments:
log "Greeting: ${run greet('world')}"

# Mixed with regular interpolation:
const name = "world"
log "${run greet()} ${name}"

# In return statements:
return "${run some_script()}"
```

**Semantics:** At runtime, each `${run ref(args)}` or `${ensure ref(args)}` is executed as a managed call (same as a standalone `run` or `ensure` step). The call's output (stdout for scripts, explicit `return` for rules/workflows) replaces the interpolation expression. Regular `${var}` interpolation is applied after all inline captures resolve. If any inline capture fails (non-zero exit), the enclosing step fails immediately — the error propagates to the parent workflow.

**Validation:** Inline capture references are validated with the **same rules** as standalone `run` / `ensure` steps: in workflows, `run` targets workflows or scripts and `ensure` targets rules; in rules, `run` targets scripts only and `ensure` targets rules. Shell redirection around the reference is rejected. **Nested inline captures** (e.g. `${run foo(${run bar()})}`) are rejected at compile time with `E_PARSE` — extract the inner call to a `const` variable instead.

**Examples:**

```jaiph
# Preferred: ${arg1} in Jaiph strings
log "Processing ${arg1}"
fail "Missing required value: ${arg1}"
prompt "Implement feature ${arg1}"
channel <- "Result: ${arg1}"

# Named variable
log "Processing ${name}"

# Inline capture in log
log "Build output: ${run build_project()}"

# Inline ensure in prompt
prompt "Fix the issue: ${ensure get_diagnostics()}"

# Escaped backtick (allowed)
log "Use \`command\` syntax"

# Script bodies: $1 is fine (shell idiom)
script greet {
  echo "Hello $1"
}
```

## Call arguments and positional parameters (`arg1`, `arg2`, …)

**Definitions** use only a name and braces — no parameter lists. The parser rejects parentheses on `rule`, `workflow`, and `script` declarations (`definitions must not use parentheses`; use `workflow default { … }`, not `workflow default() { … }`).

**Call sites** pass arguments in parentheses with **comma-separated** expressions. After parsing, commas become **whitespace-separated** tokens for the runtime; each token is one positional argument. The runtime exposes them as **`${arg1}`**, **`${arg2}`**, … in orchestration strings (rules and workflows) and as **`$1`**, **`$2`**, … in bash **script** bodies (polyglot scripts use that language’s `argv`).

```jaiph
workflow show_args {
  log "task=${arg1} role=${arg2}"
}

script greet {
  echo "Hello $1"
}

workflow default {
  run show_args("my-task", "my-role")
  run greet("world")
}
```

**Semantics:**

- There is **no** declaration-time parameter list, **no** default argument values in the grammar, and **no** compile-time arity checking against a callee signature — pass the arguments you need and read `${arg1}` / `$1` accordingly.
- A call like `run wf(foo="bar", x="y")` is **not** keyword-style binding; it passes **two** string arguments (each entire expression is one positional slot after interpolation), not names matched to parameters.

Positional access (`$1`, `$2`, `"$@"`) is what bash scripts use; in orchestration strings use **`${arg1}`**, **`${arg2}`** (or other module/workflow locals), not `$1`.

## Polyglot scripts and custom shebangs

Scripts default to `#!/usr/bin/env bash`. To write a script in another language, add a custom shebang as the **first non-empty line** of the body:

```jaiph
script analyze {
  #!/usr/bin/env python3
  import sys
  print(f"Analyzing {sys.argv[1]}")
}

script transform {
  #!/usr/bin/env node
  const data = process.argv[2];
  console.log(JSON.stringify({ result: data }));
}
```

**Behavior:**

- The shebang line is stored separately (`ScriptDef.shebang`) and excluded from the body.
- Non-bash scripts skip Jaiph keyword validation — the body is opaque to the compiler.
- Bash scripts (no shebang or `#!/usr/bin/env bash`) are validated for disallowed Jaiph keywords and cross-script calls.
- All scripts are emitted as separate executable files under the workspace `scripts/` directory with `chmod +x`.
- Script isolation applies regardless of shebang: only positional arguments and essential variables (`PATH`, `HOME`, `TERM`, `USER`, `JAIPH_LIB`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`) are inherited.

## Capture and value binding

Jaiph provides several forms for capturing values from steps into variables.

**Inline capture with `const`:**

```jaiph
const result = run helper("${arg}")
const check = ensure validator("${input}")
const answer = prompt "Summarize the report"
```

**Assignment capture:**

```jaiph
result = run helper("${arg}")
check = ensure validator("${input}")
answer = prompt "Summarize the report"
```

**Inline `run` in send expressions:**

```jaiph
channel <- run build_message("${data}")   # script stdout sent to channel
```

For capture semantics (what value each form produces), see [Step Output Contract](#step-output-contract).

**`const` RHS restrictions:** The right-hand side of `const` accepts simple value expressions (`${var}`), or an explicit `run` / `ensure` / `prompt` capture. A bare reference with arguments (e.g. `const x = helper("${arg}")`) is rejected — use `const x = run helper("${arg}")`.

## Module-qualified references (dot notation)

Imported symbols are referenced with **`alias.name`** dot notation:

```jaiph
import "tools/security.jh" as security
import "bootstrap.jh" as bootstrap

workflow default {
  ensure security.scan_passes()       # rule from imported module
  run bootstrap.nodejs()              # workflow from imported module
  run security.run_audit("${target}")  # script from imported module
}
```

A reference is either a bare `IDENT` (local symbol) or `IDENT.IDENT` (module-qualified). The compiler resolves both forms and validates that the target exists and is the correct kind for the calling keyword (`ensure` for rules, `run` for workflows and scripts).

---

## Lexical Notes

- **Identifiers:** `IDENT := [A-Za-z_][A-Za-z0-9_]*`
- **References:** `REF := IDENT | IDENT "." IDENT` (e.g. `foo` or `mymod.foo`)
- **Comments:** Full-line comments starting with `#`. Empty or whitespace-only lines are ignored.
- **Shebang:** If the first line of the file starts with `#!`, it is ignored by the parser.
- **Import path:** The path in `import "<path>" as IDENT` must be a quoted string (single or double quotes). If the path omits the file extension, the compiler appends `.jh`.
- **File extension:** All CLI commands and import resolution use `.jh`.

## EBNF (Practical Form)

Informal symbols used below:

- `string` — Quoted string (single or double quotes).
- `call_ref` — `REF "(" [ args ] ")"` — parenthesized call with comma-separated arguments.
- `quoted_or_multiline_string` — A double-quoted string; may span multiple lines. Supports `\$`, `\"`, `\\`, and `` \` `` escapes; a trailing `\` on a line acts as line continuation. Variable expansion uses **JS template literal semantics** with only `${identifier}` forms (`${var}`, `${arg1}`). **Inline capture interpolation** is also supported: `${run ref(args)}` and `${ensure ref(args)}` execute a managed call and inline the result at runtime. Backticks must be escaped (`` \` ``); `$(...)` and `${var:-fallback}` are rejected (`E_PARSE`). Nested inline captures are rejected (`E_PARSE`). See [String interpolation](#string-interpolation).

```ebnf
file            = { top_level } ;

top_level       = config_block | import_stmt | channel_decl | env_decl | rule_decl | script_decl | workflow_decl ;

config_block    = "config" "{" { config_line } "}" ;
  (* Inside the block, blank lines and full-line # comments are allowed. *)
config_line     = config_key "=" config_value ;
config_key      = "agent.default_model" | "agent.command" | "agent.backend" | "agent.trusted_workspace"
                | "agent.cursor_flags" | "agent.claude_flags" | "run.logs_dir" | "run.debug"
                | "run.inbox_parallel" | "runtime.docker_enabled" | "runtime.docker_image" | "runtime.docker_network"
                | "runtime.docker_timeout" | "runtime.workspace" ;
config_value    = string | "true" | "false" | integer | string_array ;
integer         = digit { digit } ;           (* bare non-negative integer, e.g. 300 *)
string_array    = "[" { array_element } "]" ;  (* opening "[" on same line as "="; elements on own lines *)
array_element   = string [ "," ] ;             (* trailing comma and inline # comments allowed *)

import_stmt     = "import" string "as" IDENT ;

channel_decl    = "channel" IDENT ;
  (* Top-level declaration only; one channel per line. *)

env_decl        = ( "local" | "const" ) IDENT "=" env_value ;
env_value       = quoted_or_multiline_string | single_quoted_string | bare_value ;
  (* Module-scoped variable declaration. Transpiles to a prefixed bash variable (module__name). *)
  (* Inside rules, scripts, and workflows, a local shim is emitted so $name resolves to the prefixed variable. *)
  (* Variable names share the unified namespace with channels, rules, workflows, and scripts. *)

rule_decl       = [ "export" ] "rule" IDENT "{" { rule_body_step } "}" ;
rule_body_step  = comment_line | workflow_step ;
  (* Parsed like workflow steps; validation rejects prompt, send, wait, ensure…recover, *)
  (* const…=prompt, run targets that are not scripts, and any disallowed kinds. *)

script_decl     = "script" IDENT "{" [ shebang_line ] { script_line } "}" ;
shebang_line    = "#!" rest_of_line ;
  (* If the first non-empty line of the body starts with "#!", it is treated as a shebang *)
  (* and stored separately (ScriptDef.shebang). It is excluded from the body commands. *)
  (* Default shebang (when none specified): #!/usr/bin/env bash *)
script_line     = comment_line | command_line ;

workflow_decl   = [ "export" ] "workflow" IDENT "{" [ workflow_config ] { workflow_step } "}" ;

workflow_config = config_block ;
  (* Optional per-workflow config override. Must appear before any steps (comments allowed before it). *)
  (* At most one per workflow. Only agent.* and run.* keys are allowed; runtime.* keys yield E_PARSE. *)
  (* See Configuration docs for precedence rules. *)

workflow_step   = ensure_stmt
                | run_stmt
                | run_async_stmt
                | prompt_stmt
                | prompt_capture_stmt
                | const_decl_step
                | ensure_capture_stmt
                | run_capture_stmt
                | return_stmt
                | fail_stmt
                | wait_stmt
                | log_stmt
                | logerr_stmt
                | send_stmt
                | route_decl
                | if_brace_stmt
                | comment_line ;
  (* Every non-comment line must match one of the above; otherwise E_PARSE (move bash into script + run). *)

const_decl_step = "const" IDENT "=" const_rhs ;
const_rhs       = quoted_or_multiline_string | single_quoted_string | bash_value_expr
                | "run" call_ref
                | "ensure" call_ref
                | "prompt" quoted_or_multiline_string [ returns_schema ] ;
  (* bash_value_expr: module variables and simple expansions, e.g. ${var}. *)
  (* Rejected: command substitution "$(...)", ${var:-default}, ${var%%...}, ${var//...}, ${#var}, etc. *)
  (* Rejected: call_ref without leading run|ensure|prompt — call-like capture must be *)
  (*   "const name = run ref(args)" (or ensure for rules), not "const name = ref(args)". *)
  (*   E_PARSE with guidance, e.g. Script calls in const assignments must use run. *)
  (* In rules, const ... = prompt is E_VALIDATE. const ... = ensure cannot use recover. *)

fail_stmt       = "fail" double_quoted_string ;
  (* Aborts the workflow (or fails the rule) with a message on stderr and non-zero exit. *)

wait_stmt       = "wait" ;
  (* Legacy no-op; kept for backwards compatibility. Use run_async_stmt instead. *)

run_async_stmt  = "run" "async" call_ref ;
  (* Starts the target concurrently. All pending async steps are implicitly joined *)
  (* before the workflow returns. Failures are aggregated. Workflows only — rejected *)
  (* in rules with E_VALIDATE. Capture (name = run async ...) is E_PARSE. *)

return_stmt     = "return" return_value ;
return_value    = double_quoted_string | single_quoted_string | "$" IDENT | "${" IDENT "}" ;
  (* Jaiph value-return: quoted strings, or a single $identifier / ${identifier} expansion. *)
  (* return with a bare integer (e.g. return 0) or return $? is bash exit code, not Jaiph value return. *)

send_stmt       = IDENT "<-" [ send_rhs ] ;
  (* RHS: empty (forward ${arg1}), double-quoted literal, ${var}, or "run ref(args)" — not raw shell. *)
  (* Channel identifier is always on the left of "<-". "name = channel <- …" is E_PARSE. *)

send_rhs        = (* empty *) | double_quoted_string | "${" IDENT "}"
                | "run" call_ref ;

route_decl      = REF "->" REF { "," REF } ;
  (* Static routing declaration; stored in WorkflowDef.routes, not steps. *)

log_stmt        = "log" double_quoted_string ;
logerr_stmt     = "logerr" double_quoted_string ;

ensure_capture_stmt = IDENT "=" "ensure" call_ref
                    | IDENT "=" "ensure" call_ref "recover" recover_body ;
run_capture_stmt   = IDENT "=" "run" call_ref ;
  (* Prefer "const name = …" for new orchestration code. *)

ensure_stmt     = "ensure" call_ref
                | "ensure" call_ref "recover" recover_body ;
recover_body    = single_workflow_stmt | "{" { workflow_step } "}" ;
single_workflow_stmt = ensure_stmt | run_stmt | prompt_stmt | prompt_capture_stmt
                | const_decl_step | run_capture_stmt | ensure_capture_stmt
                | return_stmt | fail_stmt | wait_stmt | log_stmt | logerr_stmt
                | send_stmt | if_brace_stmt ;
run_stmt        = "run" call_ref ;
prompt_stmt     = "prompt" quoted_or_multiline_string [ returns_schema ] ;
prompt_capture_stmt = IDENT "=" "prompt" quoted_or_multiline_string [ returns_schema ] ;
returns_schema  = "returns" ( single_quoted_string | double_quoted_string ) ;
  (* Schema string contains a flat object shape: { fieldName: type, ... } with type in string | number | boolean. *)
  (* Line continuation: after the closing " of the prompt, optional trailing \ continues to next line for returns_schema. *)

if_brace_stmt   = "if" [ "not" ] brace_if_head "{" { workflow_step } "}"
                  { "else" "if" [ "not" ] brace_if_head "{" { workflow_step } "}" }
                  [ "else" "{" { workflow_step } "}" ] ;
brace_if_head   = "ensure" call_ref | "run" call_ref ;
  (* No shell-condition variant: use a script that performs the test + if [not] run that_fn { … }. *)
  (* "not" negates the ensure/run condition. *)

```

## Step Output Contract

Jaiph treats **status**, **value**, and **logs** as separate channels so composition stays predictable:

- **Status** — Exit code (success vs failure) drives control flow: brace **`if`** on **`ensure` / `run`** in workflows and rules (not shell `if …; then … fi` for those steps), failure propagation in the Node runtime, and pass/fail under **`jaiph test`**.
- **Value** — For `x = ensure …` / `x = run …` / `x = prompt …`, the captured data is **not** arbitrary stdout mixed into the variable. **Rules and workflows** set the value channel only with `return "…"` or `return "${var}"`. **`run` to a script** uses **stdout** of the script body as the captured value (scripts do not use Jaiph `return "…"` — use `echo` / `printf`).
- **Logs** — Command output inside **scripts** (and tool noise from managed steps) is recorded under `.jaiph/runs` as step artifacts so **return values** and **telemetry** stay separate.

Every step produces three distinct outputs:

| Step kind | Status source | Value channel (for `x = ...`) | Log channel |
| --- | --- | --- | --- |
| `ensure rule` | rule exit code | explicit rule `return` value only | rule body logs to step artifacts |
| `run workflow` | workflow exit code | explicit workflow `return` value only | workflow step logs to artifacts |
| `run script` | script exit code | **stdout** of the script body (trimmed per runtime) | script command stdout/stderr to artifacts |
| `prompt` | prompt command exit code | final assistant answer only | prompt transcript/reasoning/tool logs to artifacts |
| `log` / `logerr` | always `0` unless runtime error | empty | `LOG` / `LOGERR` event + stdout/stderr (terminal text uses `echo -e`) |
| `fail` | non-zero (workflow/rule abort) | empty | message to stderr |
| `run async` | aggregated: non-zero if any async step failed | not supported (capture rejected at parse time) | async step logs to artifacts |
| `wait` | no-op (legacy) | empty | n/a |
| `const` | same as the RHS step (`run` / `ensure` / `prompt`) or `0` for pure value expr | empty (binds a workflow local) | n/a |

**Key rules:**
- For **`ensure`** / **`run` to a rule or workflow**, assignment captures only the callee’s explicit **`return "…"`**; ordinary stdout from inside that callee goes to artifacts.
- For **`run` to a script**, assignment captures **stdout**; use **`echo` / `printf`** (not Jaiph `return "…"`) to pass a string. Bash **`return N`** / **`return $?`** in the script body set exit status only.
- **`return "value"`** / **`return "${var}"`** are valid in **rules and workflows** (and set the managed return-value file). They are **not** allowed in **script** bodies.
- Prompt capture (`name = prompt "..."`) returns the final assistant answer; the full transcript is written to step artifacts.
- `log`/`logerr` produce no capture value; their messages are emitted as events and written to stdout/stderr respectively. **Human-facing output** (terminal and CLI tree text) uses **`echo -e`**: backslash sequences in the expanded string are interpreted there. **`LOG` / `LOGERR`** JSON (event fd and `run_summary.jsonl`) stores the **same shell string** as before, JSON-encoded by the JS emit kernel — tooling sees one string field per event, without a second round of escape expansion.

### Managed calls vs command substitution

Jaiph separates **managed** invocations (step records under `.jaiph/runs`, deterministic artifacts) from **ad hoc bash**. Workflows and rules do not embed raw shell — bash runs inside **`script`** bodies invoked via **`run`**. For **rules/workflows**, the value channel is explicit **`return "…"`**; for **scripts**, capture is **stdout**.

**Why keyword-first (`ensure` / `run` only):** Requiring keywords makes each callee kind explicit. The compiler still applies Jaiph-symbol guards inside **`script`** bodies and in restricted bash contexts (e.g. `const` RHS, send RHS, command substitution) so symbols are not confused with external commands.

**Managed forms (only these invoke Jaiph symbols from a workflow):**

| Callee kind | Invoke | Capture value |
| --- | --- | --- |
| Rule | `ensure rule(args)` or `x = ensure rule(args)` | explicit `return` only |
| Workflow | `run wf(args)` or `x = run wf(args)` | explicit `return` only |
| Script | `run fn(args)` or `x = run fn(args)` | **stdout** of `fn` |

**Forbidden (compile-time `E_VALIDATE` where applicable):**

- Wrapping Jaiph calls in command substitution, e.g. `x="$(my_fn ...)"`, `x="$(my_wf ...)"`, `x="$(my_rule ...)"` — use `x = run ...` / `x = ensure ...` instead.
- Calling a script as a bare workflow step or via `x = fn(…)` — use `run fn(…)` / `x = run fn(…)`.
- Using `ensure` on a workflow or script, or `run` on a rule — swap to the correct keyword (diagnostic names the expected form).
- Shell redirection or pipeline syntax around `run` or `ensure` steps: `run foo() > file`, `run foo() | cmd`, `run foo() &` — these are shell-level constructs incompatible with the Node AST-interpreter runtime. Use a **`script`** block for shell operations (`&`, `|`, `>`, `>>`) and call it with `run`.

**Correction path:** Use **`run callee`** from a workflow or rule. For a **string value** back: from a **workflow/rule** callee use **`return "…"`**; from a **script** callee use **stdout** (`echo`).

**`$(...)` and bash inside scripts:** Command substitution must not invoke Jaiph rules, workflows, or scripts, contain `<-`, or use `run` / `ensure` as shell command words. The first command word of each simple shell segment is checked. Put Jaiph calls in the **workflow**/**rule** body as `ensure` / `run` steps, not inside `$(...)`.

**Script bodies** are bash only (unless a custom shebang is provided): they must not contain `run`, `ensure`, `config`, nested top-level declarations, inbox route lines (`channel -> ...`), or Jaiph keywords **`fail`**, **`const`**, **`log`**, **`logerr`**, or Jaiph-style **`return "…"`** / **`return "${var}"`**. Scripts also **cannot invoke other Jaiph scripts** by name — the validator rejects cross-script calls with an error guiding you to use a shared library or compose in a workflow (self-calls for recursion are allowed). For **custom shebang** scripts (e.g. `#!/usr/bin/env node`), Jaiph keyword validation is skipped — the body is treated as opaque content for the target interpreter. **Isolation:** Scripts run in a **clean environment** (`env -i`): only essential system variables (`PATH`, `HOME`, `TERM`, `USER`) and Jaiph variables (`JAIPH_LIB`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`) are passed through. Module-scoped variables (`local` / `const` at the top level) are **not** inherited — scripts receive only their positional arguments. Optional shared libraries (`.sh` under `.jaiph/lib/`) load with `source "$JAIPH_LIB/…"`. Generated scripts default `JAIPH_LIB` to `${JAIPH_WORKSPACE:-.}/.jaiph/lib`; the runtime sets `JAIPH_LIB` when executing **script** steps.

## Parse and Runtime Semantics

1. **Config block:** The opening line must be exactly `config {` (optional trailing whitespace). At most one config block per file at the top level. Inside the block, lines are either `key = value`, `}`, blank, or full-line `#` comments. Allowed keys: `agent.default_model`, `agent.command`, `agent.backend`, `agent.trusted_workspace`, `agent.cursor_flags`, `agent.claude_flags`, `run.logs_dir`, `run.debug`, `run.inbox_parallel`, `runtime.docker_enabled`, `runtime.docker_image`, `runtime.docker_network`, `runtime.docker_timeout`, `runtime.workspace`. Values may be a quoted string, `true`/`false`, a bare integer (`/^[0-9]+$/`), or a bracket-delimited array of quoted strings (`[...]`). Each key has an expected type; mismatches yield `E_PARSE`. For `agent.backend` the value must be `"cursor"` or `"claude"`. Arrays: opening `[` must be on the same line as `=`; each element is a quoted string on its own line; trailing commas and inline `#` comments between elements are allowed; empty array `= []` is valid. **Workflow-level config:** An optional `config { ... }` block may also appear inside a workflow body, before any steps (comments may precede it). At most one per workflow. Only `agent.*` and `run.*` keys are allowed (`runtime.*` keys yield `E_PARSE`). Workflow-level config overrides module-level config for all steps inside that workflow, locks its overrides to prevent inner module-scope wrappers from reverting them, and restores the previous environment when the workflow finishes. See [Configuration](configuration.md#workflow-level-config) for full precedence rules.
2. **ensure:** Arguments are passed inside parentheses (e.g. `ensure check_branch("${arg1}")`). With `recover`, the step becomes a retry loop: run the condition; on failure run the recover body; repeat until the condition passes or the maximum number of **attempt rounds** is reached (default **3**, overridable with **`JAIPH_ENSURE_MAX_RETRIES`**). **Syntax constraints:** all rule arguments must appear inside the call parentheses **before** `recover` — placing arguments after `recover` (e.g. `ensure ci_passes() recover "${repo_dir}" { … }`) yields `E_PARSE` with a hint showing the valid ordering (`ensure ref(args) recover { … }`). A bare `recover` without a recovery block (e.g. `ensure ci_passes("${repo_dir}") recover` at end of line) also yields `E_PARSE`. Recover is either a single statement (`ensure dep() recover run install_deps()`) or a block of statements separated by `;` or newline (`ensure dep() recover { run a(); run b() }`). The recover body receives **`${arg1}`** as the full merged stdout+stderr produced by the failed rule execution. This includes output from nested scripts (both stdout and stderr), rule-level `log`/`logerr` messages, and raw shell echo/printf output within the rule. The payload is captured per attempt — each retry iteration receives fresh output from the current attempt, not stale output from a previous one. Step artifacts under `.jaiph/runs/` remain the full record. If the rule produces no output, **`${arg1}`** is empty — persist or assert before prompting if your recover text promises a log file on disk.
3. **Rules:** May use forwarded positional parameters (`${arg1}`, `${arg2}`) in arguments to `ensure` / `run` and inside string literals. Rule bodies use the same keyword-aware step parser as workflows; validation forbids `prompt`, `send`, `wait`, `run async`, `ensure … recover`, and `const … = prompt`. **`run`** inside a rule must target a **script** only (not a workflow — use a workflow-level `run` from a caller). **`ensure … recover`** is workflow-only. **Inline brace groups** for short-circuit logic live in **`script`** bodies (e.g. `cmd || { echo >&2 "failed"; return 1; }`), not as raw workflow lines.
4. **run:** In a **workflow**, `run` targets a **workflow** or **script**. In a **rule**, `run` targets a **script** only. Rules use **`ensure`** for other rules. Arguments are passed inside parentheses and forwarded to the callee. **Shell redirection / pipelines** after a `run` call (`>`, `>>`, `|`, `&`) are **rejected at parse time** — use a **`script`** for shell I/O and call it with **`run`**. **Assignment capture:** For **`run` to a workflow**, the captured value is the callee's explicit **`return "…"`** (managed return value). For **`run` to a script**, capture is **stdout** from the script body. **Async variant:** `run async ref(args)` starts the step concurrently with implicit join (see item 11 and 18).
5. **Definition syntax:** All three definition forms — `rule`, `script`, and `workflow` — require braces (`{ … }`) on the declaration line (e.g. `rule name { … }`, `script name { … }`, `workflow name { … }`). Definitions must **not** use parentheses — parentheses are reserved for call sites. Omitting `{` is rejected at parse time with `E_PARSE` and a fix hint. The EBNF productions (`rule_decl`, `script_decl`, `workflow_decl`) encode this requirement.
6. **Scripts:** Top-level `script` blocks are plain bash with compiler ref-resolution. **From a workflow or rule**, call with **`run fn(args)`** only. Do not use Jaiph **`return "…"`** / **`return "${var}"`** inside scripts — use **`echo`** / **`printf`** for string data and **`return N`** / **`return $?`** for status. Parsed bodies reject **`fail`**, **`const`**, **`log`**, and **`logerr`** at the Jaiph level (use bash `exit`, `local`, `echo`, `echo >&2`). **Custom shebang (polyglot scripts):** If the first non-empty line of the script body starts with `#!` (e.g. `#!/usr/bin/env node`, `#!/usr/bin/env python3`), it is stored as the script's shebang and excluded from the body commands. Scripts with a non-bash shebang skip Jaiph keyword validation (the body is opaque to the compiler). When no shebang is provided, `#!/usr/bin/env bash` is used as the default. **Isolation:** Scripts run in a **clean process environment** — only positional arguments, essential system variables (`PATH`, `HOME`, `TERM`, `USER`), and Jaiph variables (`JAIPH_LIB`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`) are inherited. Module-scoped `local` / `const` variables are **not** passed to scripts (use shared libraries via `source "$JAIPH_LIB/…"` for common utilities). See [Build artifacts](#build-artifacts) for how scripts are emitted as separate executable files in build output.
7. **Conditional steps:** Only **brace form** is valid in workflows: `if [not] ensure ref() { ... } [ else if [not] ensure|run ref() { ... } ] [ else { ... } ]` and `if [not] run ref() { ... }` with the same chaining. Only **`ensure`** and **`run`** conditions — express command tests with **`run`** to a **script** (e.g. `if not run file_exists("${arg1}") { fail "missing file" }`). **Branches** contain normal **workflow** steps (same rules as the outer body — no raw shell).
8. **prompt:** Two forms are supported:
   - `prompt "<text>"` — Sends the text to the configured agent backend. The Node workflow runtime delegates to the JS kernel (`src/runtime/kernel/prompt.ts`) for invocation and stream handling (CLI progress uses the internal step label `jaiph::prompt`).
   - `name = prompt "<text>"` — Same, but the agent’s final reply is captured into `name`.
   - The prompt string may span multiple lines and uses **JS template literal semantics**: only `${identifier}` forms are supported (`${varName}`, `${arg1}`). Bare `$varName` is not valid in orchestration strings. Unescaped backticks, `$(...)`, and `${var:-fallback}` are rejected with `E_PARSE`. See [String interpolation](#string-interpolation).
   - **Typed prompt (returns schema):** Optional `returns '{ field: type, ... }'` (single- or double-quoted) after the prompt string. When present, the prompt **must** capture to a variable (e.g. `result = prompt "..." returns '{ type: string, risk: string }'`). The schema is **flat only** (no nested objects); allowed types are `string`, `number`, `boolean` (no arrays or union types in v1). The compiler appends instructions to the prompt so the agent is asked to respond with exactly one line of valid JSON matching the schema. At runtime, the response is searched for valid JSON using multiple strategies (in order): the last non-empty line, fenced code blocks, a standalone `{…}` line, and embedded JSON within a line (text before `{` is stripped). The first candidate that parses as valid JSON is used; if none parse successfully, the step fails with a parse error; if a required field is missing or a value has the wrong type, the step fails with a distinct schema/missing-field or type error. On success, the capture variable is set to the raw JSON string, and for each schema field a variable `name_field` is exported (e.g. `${result_type}`, `${result_risk}`). Line continuation with trailing `\` after the closing quote of the prompt is supported so the `returns` clause can continue on the next line(s).
9. **`const` declarations:** `const name = <rhs>` introduces an immutable binding in the workflow (or rule) body. RHS forms: same **value** expressions allowed for module `const` (no `$(...)` or disallowed `${...}` ops), or explicit **`run` / `ensure` / `prompt`** capture (workflow only for `prompt`). **Call-like** text — a **reference** that resolves to a rule, workflow, or script, followed by **arguments** — is **not** a valid bare RHS: write **`const name = run ref(args)`** (or **`const name = ensure ref(args)`** for rule capture), not **`const name = ref(args)`**. A bare **`ref(args)`** does not lower to a managed step; the compiler rejects it with **`E_PARSE`** and a line showing the **`run`** form. At runtime, `const` binds the name and assigns from the value or managed capture, same as `name = run|ensure|prompt` for capture forms.
10. **`fail`:** `fail "reason"` ends the step with a diagnostic on stderr and exit status 1 (workflow stops; in `ensure … recover`, a failing rule that executes `fail` behaves like a failed rule).
11. **`run async`:** `run async ref(args)` starts a managed workflow or script concurrently. All pending async steps are implicitly joined (via `Promise.allSettled`) before the enclosing workflow returns. If any async step fails, the workflow fails with an aggregated error listing each failure. `run async` is allowed in **workflows only** — using it in a rule yields `E_VALIDATE`. Capture forms (`name = run async ...` / `const name = run async ...`) are rejected at parse time with `E_PARSE` and a hint to use separate steps. **`wait`:** A bare `wait` line is still parsed but is effectively a no-op — use `run async` for managed parallel work.
12. **Assignment capture:** `name = <step>` captures into `name` (see [Step Output Contract](#step-output-contract)):
   - `name = ensure ref(args)` — Captures the rule's explicit **`return "…"`**. With `recover`, the value is from the rule when it finally passes.
   - `name = run ref(args)` — For a **workflow** callee, captures explicit **`return "…"`**. For a **script** callee, captures **stdout**. (`run` cannot target a rule — use **`ensure`** for rules.)
   - `name = prompt "..."` — Captures the agent's final answer; transcript goes to step artifacts.
   - **`return "value"`** / **`return "${var}"`** set the managed return value in **rules and workflows** only (not in **scripts**).
   - **Exit semantics:** Failed managed steps fail the enclosing workflow unless you use recovery (`ensure … recover`) or bash control flow inside a **script** (bash scripts use `set -euo pipefail` in the emitted wrapper).
13. **log:** `log "message"` displays a message in the progress tree at the current indentation depth. The argument must be a double-quoted string (same quoting rules as `prompt`). Variable interpolation uses `${identifier}` forms (`${var}`, `${arg1}`) at runtime. **Inline capture interpolation** (`${run ref(args)}`, `${ensure ref(args)}`) is also supported — inline captures execute before regular variable interpolation and the result is inlined (see [String interpolation](#string-interpolation)). `log` is not a step — it has no pending/running/done states, no timing, and no spinner. At runtime, the Node kernel emits a `LOG` event and prints to stdout with **`echo -e`**-style escapes (backslash escapes in the final string are interpreted for terminal output, e.g. `\n` → newline). The event **`message`** field is still the string **before** that expansion, JSON-encoded in the payload. Parse error if `log` is used without a quoted string.
14. **logerr:** `logerr "message"` is identical to `log` except the message is written to stderr instead of stdout. At runtime, the Node kernel emits a `LOGERR` event and prints to stderr with **`echo -e`**-style escapes. In the progress tree, `logerr` lines are shown with a red `!` marker (instead of the dim info marker used by `log`). Parse error if `logerr` is used without a quoted string.
15. **Send operator (`<-`):** The RHS must be **empty** (forward `${arg1}`), a **double-quoted literal**, **`${var}`**, or **`run ref(args)`** — not an arbitrary shell command (`E_PARSE` with a hint to use `const` + variable or `run`). The channel identifier is always on the left of `<-`. Combining capture and send (`name = channel <- …`) is `E_PARSE`. See [Inbox & Dispatch](inbox.md).
16. **Route declaration:** `channel -> workflow` registers a static routing rule: when a message arrives on `channel`, the runtime calls `workflow` with positional args `${arg1}=message`, `${arg2}=channel`, `${arg3}=sender` (see [Trigger contract](inbox.md#trigger-contract)). Multiple targets are supported: `channel -> wf1, wf2` dispatches sequentially in declaration order; each target receives the same message. Route declarations are stored in `WorkflowDef.routes`, not in `steps`; they are not executable statements. The Node runtime registers routes at the start of the workflow and drains the queue at the end. See [Inbox & Dispatch](inbox.md).
17. **Export:** Rule and workflow declarations may be prefixed with `export` to mark them as part of the module’s public interface. The implementation does not restrict references to exported symbols: any rule or workflow in an imported module can be referenced.
18. **Parallel execution (`run async`):** `run async ref(args)` starts a managed workflow or script concurrently within a workflow. The runtime adds the returned Promise to a pending list without awaiting it. At the end of the workflow body, an implicit join (`Promise.allSettled`) awaits all pending async steps. If any fail, their errors are aggregated into a single failure message; output from all completed async steps is accumulated into the workflow output.

    **Constraints:**
    - `run async` is workflow-only; using it in a rule yields `E_VALIDATE`.
    - Capture is not supported: `const x = run async ...` or `x = run async ...` yields `E_PARSE`.
    - For **concurrent bash** (pipelines, `sleep &`, etc.), put the bash in a **`script`** and call it with **`run`**.
    - Do not call Jaiph internals from background subprocesses unless you understand `run.inbox_parallel` locking.
    - Concurrent stdout may interleave in artifacts at the line level.
    - **Sibling depth:** Multiple `run async` steps under the same parent render as **siblings at the same tree depth** — the runtime isolates each async branch's frame stack so interleaving does not inflate the reported `depth` of later branches. Inner steps within each branch appear one level deeper under their respective `async workflow` header.
19. **Top-level `local` / `const` (env declarations):** `local name = value` or `const name = value` declares a module-scoped variable (same value rules). The variable is scoped to the module (e.g. `const role` in module `entry` is accessible as `${role}` inside that module's rules and workflows). **Scripts do not receive module variables** — they run in full isolation and cannot see module-level variables (use shared libraries or pass data as positional arguments). Variable names participate in the unified namespace — they cannot collide with channel, rule, workflow, or script names. A top-level initializer may reference another module-scoped variable by name; a cyclic chain of references is rejected at compile time with `E_PARSE`. Variables are module-scoped only and are not exportable; cross-module access is not supported.

## Validation Rules

After parsing, the compiler validates references and config. (In this repository, reference checks live in `src/transpile/validate.ts` with shared resolution in `validate-ref-resolution.ts`; contributors can read **Reference validation** in [Contributing](contributing.md) for where validation lives in `src/transpile/`.) Violations produce the following error codes:

- **E_PARSE:** Invalid syntax, duplicate config block, invalid config key/value, invalid string content (unescaped backticks, `${var:-fallback}` shell expansion, or `$(...)` command substitution in Jaiph strings), `prompt "..." returns '...'` without a capture variable, invalid `const` RHS (e.g. command substitution, disallowed `${...}` forms, or **call-like** `ref [args…]` without **`run`** / **`ensure`** / **`prompt`** — use **`const x = run ref [args…]`**), a circular reference among top-level `local` / `const` initializers, a workflow/rule line that is not a recognized Jaiph step, an invalid send RHS, invalid `ensure … recover` syntax (arguments after `recover`, or **`recover` with no recovery step** — e.g. end of line after bare `recover`), an **invalid inline capture reference** (e.g. `${run 123bad()}` where the ref is not a valid identifier), **nested inline captures** (e.g. `${run foo(${run bar()})}` — extract inner calls to `const` variables), shell redirection/pipeline syntax (`>`, `>>`, `|`, `&`) after a `run`/`ensure` call expression, or an **ill-formed definition** — `rule`, `script`, and `workflow` declarations must not use parentheses and require `{` on the declaration line (e.g. `rule name { … }`); using parentheses on definitions or omitting `{` yields `E_PARSE` with a fix hint. Call sites require parentheses (e.g. `run ref()`, `ensure ref("arg")`).
- **E_SCHEMA:** Invalid or unsupported `returns` schema: empty schema, non-flat shape (e.g. arrays or union types), invalid entry (not `fieldName: type`), or unsupported type (only `string`, `number`, `boolean` allowed).
- **E_VALIDATE:** Reference or alias error (unknown rule/workflow, duplicate alias, etc.), forbidden Jaiph usage inside `$(...)` or as a bare shell call where a managed step is required. **`script { … }` bodies are not validated as Jaiph steps** — they are opaque shell (or shebang interpreter) source.
- **E_IMPORT_NOT_FOUND:** The file resolved from an `import` path does not exist.

Rules:

1. At most one `config` block per file at the top level; duplicate config yields `E_PARSE`. At most one `config` block per workflow; duplicate yields `E_PARSE`. Workflow-level config must appear before any steps; placing it after a step yields `E_PARSE`. Only `agent.*` and `run.*` keys are allowed in workflow-level config; `runtime.*` keys yield `E_PARSE`.
2. Config keys must be one of the allowed keys; values must be a quoted string, `true`/`false`, a bare integer, or a bracket-delimited array of quoted strings. Each key has an expected type (string, boolean, number, or string[]); a type mismatch yields `E_PARSE`. For `agent.backend`, the value must be `"cursor"` or `"claude"`. Invalid key yields `E_PARSE`.
3. Import aliases must be unique within a file (`E_VALIDATE`).
4. Import targets must exist on disk (`E_IMPORT_NOT_FOUND`).
5. **Unified namespace:** Channels, rules, workflows, scripts, and top-level `local` / `const` variables share a single namespace per module. Declaring two items with the same name (e.g. a channel `foo` and a rule `foo`, or a module variable `foo` and a workflow `foo`) yields `E_PARSE`.
6. **Calling conventions (compile-time enforcement):**
   - `ensure` must target a rule. Using `ensure` on a workflow or script yields `E_VALIDATE` with a hint to use `run`.
   - `run` in a **workflow** must target a workflow or script. Using `run` on a rule yields `E_VALIDATE`.
   - `run` in a **rule** must target a **script** (not a workflow or rule).
   - **`$(...)`** in **workflow and rule** orchestration strings follows the usual Jaiph rules. **`script { … }` bodies** are **opaque bash** (or the shebang interpreter): the compiler does not apply Jaiph keyword or cross-reference checks line-by-line. Call Jaiph-managed steps from **workflows/rules**; compose shell in scripts as needed (e.g. `"$JAIPH_SCRIPTS/other"` if you invoke another emitted script explicitly).
   - These checks apply to both local and imported references.
7. **Send and route validation:** Channel references must resolve to declared channels (`E_VALIDATE` when missing). Route targets must be **workflows**. `name = channel <- …` yields `E_PARSE`. A bare ref on the send RHS that names a workflow/script is rejected with a hint to use **`run`**. Max dispatch depth 100 (`E_DISPATCH_DEPTH`).
8. **`ensure … recover` ordering:** Arguments after `recover` yield `E_PARSE` (rule arguments must appear inside the call parentheses before `recover`). **`recover` must be followed by at least one recovery step:** either a **brace block** (`recover { … }`) or a **single recovery statement** on the same line (e.g. `ensure dep() recover run install_deps()`). A line that ends with bare `recover` and nothing after yields `E_PARSE`. Invalid: `ensure rule() recover "arg" { … }` (argument between `recover` and `{`), `ensure rule("arg") recover` (nothing after `recover`).
9. Local `ensure foo` requires a local rule `foo`. Imported `ensure alias.foo` requires a rule `foo` in the module bound to `alias` (export is not required).
10. Local `run bar` in a **workflow** requires a local workflow or script `bar`. In a **rule**, `run` must resolve to a **script** in the referenced module. Imported `run alias.bar` follows the same kind rules per context.

## Build artifacts {#build-artifacts}

`jaiph run` and `jaiph test` do **not** transpile workflows to shell. The CLI calls **`buildScripts()`**, which walks workspace `*.jh` files, runs **`emitScriptsForModule`** (parse → **`validateReferences`** → **`buildScriptFiles`**) for each module, and writes **only** per-`script` executable files under the workspace `scripts/` directory. **`buildRuntimeGraph()`** (used when the workflow runner loads the import closure) parses modules and follows imports **without** re-running **`validateReferences`** — cross-module references are resolved from that graph at runtime; compile-time validation stays on the **`emitScriptsForModule`** path.

1. **Scripts:** Each top-level `script name { … }` becomes a separate file (e.g. `scripts/<name>`) with `chmod +x`. Content is the shebang (custom or default `#!/usr/bin/env bash`) plus the body. Bodies may be ref-resolved for bash; non-bash shebangs keep the body verbatim. At runtime, managed script steps run these files with a minimal environment (`JAIPH_LIB`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`, plus a small allowlisted set of system vars).
2. **Config at runtime:** When the module has a `config` block, the **Node workflow runtime** applies the usual precedence (environment → workflow-level → module-level → defaults) for `agent.*`, `run.*`, and related keys — not a generated shell preamble.
3. **Orchestration:** Workflows, rules, prompts, channels, `ensure` / `run`, and control flow are interpreted by **`NodeWorkflowRuntime`** from the AST. There is no workflow-level `.sh` or module bash string from the compiler.
4. **Typed prompts:** Compile-time checks (e.g. `returns` schema shape, capture name when `returns` is present) run in **`validateReferences`**. JSON extraction and schema validation at execution time use the JS kernel (`src/runtime/kernel/schema.ts`).
5. **Assignment capture:** Rules and workflows use explicit **`return "…"`**; scripts use **stdout**.

## Runtime execution (Node workflow runtime)

At runtime (`jaiph run` / `jaiph test`), the Node workflow runtime interprets the AST directly:

- **Config:** When the module has a `config` block, the runtime resolves config values using the precedence chain: environment → workflow-level config → module-level config → defaults.
- **Script isolation:** Script steps are executed as managed subprocesses with only essential system variables and Jaiph-specific ones (`JAIPH_LIB`, `JAIPH_SCRIPTS`, `JAIPH_WORKSPACE`) passed through. Module-scoped variables are not visible inside scripts.
- **Prompt + schema:** The JS kernel (`runtime/kernel/schema.ts`) handles JSON extraction and schema validation for typed prompts; exit codes remain the same (0=ok, 1=parse error, 2=missing field, 3=type mismatch).
- **ensure … recover:** Bounded retry loop (default **3** rounds unless **`JAIPH_ENSURE_MAX_RETRIES`** is set). The runtime accumulates merged stdout+stderr from the failed rule execution. The capture is truncated at the start of each retry attempt so the recover body's **`${arg1}`** always reflects the current attempt's output.
- **Assignment capture:** **Rules and workflows** use explicit **`return "…"`**. **Scripts** use **stdout**.
- **`run async`:** Starts the target concurrently (Promise-based). The runtime tracks pending async Promises and joins them with `Promise.allSettled` before the workflow returns. If any async step fails, the workflow fails with an aggregated error message. Output from completed async steps is accumulated. `run async` is rejected in rules (`E_VALIDATE`) and cannot be used with capture (`E_PARSE`).
