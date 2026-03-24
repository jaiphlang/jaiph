---
title: Grammar
permalink: /grammar
redirect_from:
  - /grammar.md
---

# Jaiph Grammar

This document describes the grammar and semantics of Jaiph source files (`.jh` / `.jph`). It is intended for anyone who needs to write or reason about Jaiph code.

**Scope:**

- **In scope:** Lexical rules, syntax (EBNF), parse-time and runtime semantics, validation, and transpilation behavior for normal modules.
- **Out of scope:** Test files (`*.test.jh`) have their own grammar and are described in [Testing](testing.md). The CLI and configuration file format are covered in [CLI](cli.md) and [Configuration](configuration.md).

**Source of truth:** The behavior described here is derived from the implementation in `src/parser.ts`, `src/parse/*.ts`, `src/transpiler.ts`, and `src/transpile/*.ts`. When in doubt, the source code is authoritative.

## High-level concepts

- **Rules** — Named blocks of shell commands used as idempotent checks or actions. Only `ensure` and raw shell are allowed inside a rule; use `ensure` to call another rule.
- **Workflows** — Named sequences of steps: `ensure` (call a rule), `run` (call a workflow or function), `prompt` (agent), `log`/`logerr` (emit messages), `send` (write to an inbox channel), or shell. Workflows may also declare `route` rules for inbox dispatch. Workflows orchestrate when each step runs.
- **Functions** — Named shell function blocks (shell-like body). From a **workflow**, call them only with **`run`** so execution uses the managed step path (artifacts under `.jaiph/runs`, explicit `return` value capture). Functions cannot be used with `ensure`, are not valid route targets, and cannot be exported.
- **ensure** — Runs a rule; succeeds if its exit code is 0. Optional `recover` runs on failure and retries until the rule passes or max retries are reached.
- **run** — Invokes a **workflow** or **top-level function** (local or `alias.name`). Must not be used for rules or arbitrary shell commands.
- **prompt** — Sends a double-quoted string to the configured agent. Optional `returns` schema asks the agent for one line of JSON and validates it.
- **config** — Optional block setting agent and run options (model, backend, logs dir, etc.). Allowed at the top level of a file (module-wide) and inside individual workflow bodies for per-workflow overrides (`agent.*` and `run.*` keys only; `runtime.*` is top-level only).
- **local** — `local name = value` declares a module-scoped variable. The name shares the unified namespace with rules, workflows, and functions. Variables are module-scoped only and cannot be exported or referenced across modules.
- **import / export** — `import "path" as alias` loads another module; `export rule` / `export workflow` marks a declaration as part of the module’s public interface. Any rule or workflow in an imported module can be referenced (export is not enforced at reference time).

---

## Lexical Notes

- **Identifiers:** `IDENT := [A-Za-z_][A-Za-z0-9_]*`
- **References:** `REF := IDENT | IDENT "." IDENT` (e.g. `foo` or `mymod.foo`)
- **Comments:** Full-line comments starting with `#`. Empty or whitespace-only lines are ignored.
- **Shebang:** If the first line of the file starts with `#!`, it is ignored by the parser.
- **Import path:** The path in `import "<path>" as IDENT` must be a quoted string (single or double quotes). If the path omits the file extension, the compiler tries `<path>.jh` first, then `<path>.jph`.
- **File extensions:** Build, run, and import resolution support `.jh` (recommended) and `.jph` (supported, deprecated for new use).

## EBNF (Practical Form)

Informal symbols used below:

- `string` — Quoted string (single or double quotes).
- `args_tail` — Rest of the line after a REF; passed through to the shell as-is (e.g. `"$1"` or `arg1 arg2`).
- `quoted_or_multiline_string` — A double-quoted string; may span multiple lines. Supports `\$`, `\"`, and `\\` escapes; a trailing `\` on a line acts as line continuation. Variable expansion (`$VAR`) is allowed in prompt context; backticks and `$(...)` are not.

```ebnf
file            = { top_level } ;

top_level       = config_block | import_stmt | channel_decl | env_decl | rule_decl | function_decl | workflow_decl ;

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

env_decl        = "local" IDENT "=" env_value ;
env_value       = quoted_or_multiline_string | single_quoted_string | bare_value ;
  (* Module-scoped variable declaration. Transpiles to a prefixed bash variable (module__name). *)
  (* Inside rules, functions, and workflows, a local shim is emitted so $name resolves to the prefixed variable. *)
  (* Variable names share the unified namespace with rules, workflows, and functions. *)

rule_decl       = [ "export" ] "rule" IDENT "{" { rule_line } "}" ;
rule_line       = comment_line | command_line ;

function_decl   = "function" IDENT [ "()" ] "{" { function_line } "}" ;
function_line   = comment_line | command_line ;

workflow_decl   = [ "export" ] "workflow" IDENT "{" [ workflow_config ] { workflow_step } "}" ;

workflow_config = config_block ;
  (* Optional per-workflow config override. Must appear before any steps (comments allowed before it). *)
  (* At most one per workflow. Only agent.* and run.* keys are allowed; runtime.* keys yield E_PARSE. *)
  (* See Configuration docs for precedence rules. *)

workflow_step   = ensure_stmt
                | run_stmt
                | prompt_stmt
                | prompt_capture_stmt
                | ensure_capture_stmt
                | run_capture_stmt
                | shell_capture_stmt
                | return_stmt
                | log_stmt
                | logerr_stmt
                | send_stmt
                | route_decl
                | if_stmt
                | shell_stmt
                | comment_line ;

return_stmt     = "return" return_value ;
return_value    = double_quoted_string | single_quoted_string | "$" IDENT ;
  (* Sets an explicit return value for assignment capture. *)
  (* return with a bare integer (e.g. return 0) is a bash exit code, not a Jaiph return. *)

send_stmt       = IDENT "<-" [ shell_command ] ;
  (* Writes content to inbox channel. Standalone "channel <-" forwards $1. *)
  (* The channel identifier is always on the left side of the "<-" operator. *)
  (* Detected before shell fallback; only matches when braceDepth == 0 and "<-" is outside quotes. *)
  (* "name = channel <- cmd" is E_PARSE: capture and send cannot be combined. *)

route_decl      = REF "->" REF { "," REF } ;
  (* Static routing declaration; stored in WorkflowDef.routes, not steps. *)

log_stmt        = "log" double_quoted_string ;
logerr_stmt     = "logerr" double_quoted_string ;

ensure_capture_stmt = IDENT "=" "ensure" REF [ args_tail ]
                    | IDENT "=" "ensure" REF [ args_tail ] "recover" single_stmt
                    | IDENT "=" "ensure" REF [ args_tail ] "recover" "{" { stmt ";" } "}" ;
run_capture_stmt   = IDENT "=" "run" REF [ args_tail ] ;
shell_capture_stmt = IDENT "=" shell_stmt ;

ensure_stmt     = "ensure" REF [ args_tail ]
                | "ensure" REF [ args_tail ] "recover" single_stmt
                | "ensure" REF [ args_tail ] "recover" "{" { stmt ";" } "}" ;
single_stmt    = run_stmt | ensure_stmt | shell_stmt | prompt_stmt | prompt_capture_stmt
                | run_capture_stmt | ensure_capture_stmt | shell_capture_stmt ;
run_stmt        = "run" REF [ args_tail ] ;
prompt_stmt     = "prompt" quoted_or_multiline_string [ returns_schema ] ;
prompt_capture_stmt = IDENT "=" "prompt" quoted_or_multiline_string [ returns_schema ] ;
returns_schema  = "returns" ( single_quoted_string | double_quoted_string ) ;
  (* Schema string contains a flat object shape: { fieldName: type, ... } with type in string | number | boolean. *)
  (* Line continuation: after the closing " of the prompt, optional trailing \ continues to next line for returns_schema. *)

if_stmt         = "if" [ "!" ] if_condition ";" "then"
                  { workflow_step }
                  [ "else" { workflow_step } ]
                  "fi" ;
  (* Unified conditional step. The optional "!" negates the condition. *)
  (* Shell conditions require "!" — only the negated form is supported. *)
  (* Else-branches are supported for ensure and run conditions; not for shell conditions. *)
  (* ensure/ensure_capture are not allowed inside if-ensure branches (E_PARSE). *)

if_condition    = "ensure" REF [ args_tail ]
                | "run" REF [ args_tail ]
                | shell_condition ;

shell_condition  = ? any shell expression, e.g. "test -f .file" ? ;

shell_stmt      = command_line ;
```

## Step Output Contract

Jaiph treats **status**, **value**, and **logs** as separate channels so composition stays predictable:

- **Status** — Exit code (success vs failure) drives control flow (`set -e`, `if ensure`, `if run`, test runner pass/fail).
- **Value** — The data a caller receives from `x = ensure …` / `x = run …` / `x = prompt …` is **not** “whatever happened to be printed to stdout.” For Jaiph rules, workflows, and functions it is only what the callee sets with `return "…"` or `return "$var"`.
- **Logs** — Ordinary command output (`echo`, `printf`, tool logs) is recorded under `.jaiph/runs` as step artifacts. That keeps **return values** and **telemetry** from colliding.

Shell steps remain bash-faithful: `x = cmd` still captures **full stdout** of `cmd` (stderr unchanged unless the command redirects it).

Every step produces three distinct outputs:

| Step kind | Status source | Value channel (for `x = ...`) | Log channel |
| --- | --- | --- | --- |
| `shell` | shell exit code | full stdout of shell command | stdout/stderr to step artifacts |
| `ensure rule` | rule exit code | explicit rule `return` value only | all rule command stdout/stderr to step artifacts |
| `run workflow` | workflow exit code | explicit workflow `return` value only | all workflow step stdout/stderr to step artifacts |
| `run function` | function exit code | explicit function `return` value only | all function command stdout/stderr to step artifacts |
| `prompt` | prompt command exit code | final assistant answer only | prompt transcript/reasoning/tool logs to artifacts |
| `log` / `logerr` | always `0` unless runtime error | empty | message emitted as log event (+ stdout for `log`, stderr for `logerr`) |

**Key rules:**
- Shell steps (`name = echo hello`) capture full stdout — this is raw bash behavior.
- For Jaiph-level composition (`name = ensure rule`, `name = run wf`, `name = run fn`), assignment captures only the explicit `return` value set by the called rule, workflow, or function. Command stdout (`echo`, `printf`, etc.) goes to `.jaiph/runs` artifact files only.
- Use `return "value"` or `return "$variable"` inside rules, workflows, and functions to set the return value. `return` with a bare integer (e.g. `return 0`) remains a bash exit code.
- Prompt capture (`name = prompt "..."`) returns the final assistant answer; the full transcript (reasoning, tool calls) is written to step artifacts.
- `log`/`logerr` produce no value; their messages are emitted as events and written to stdout/stderr respectively.

### Managed calls vs command substitution

Jaiph separates **managed** invocations (step records under `.jaiph/runs`, deterministic artifacts, explicit `return` as the value channel) from **raw shell**, including bash command substitution. Managed calls avoid stdout/value ambiguity: logs go to artifacts; only `return` feeds assignment capture.

**Why keyword-first (`ensure` / `run` only):** If the compiler had to guess whether a bare shell token is “external program” or “Jaiph symbol,” it would need extra heuristics and would still hit ambiguous cases. Requiring keywords makes the invocation kind explicit in the source, so validation and transpilation can stay small and predictable: the same guard logic applies to `$(...)` bodies and to the first command word of each workflow shell line (after stripping leading env assignments and simple pipeline/operator splits).

**Managed forms (only these invoke Jaiph symbols from a workflow):**

| Callee kind | Invoke | Capture value |
| --- | --- | --- |
| Rule | `ensure rule [args...]` or `x = ensure rule [args...]` | explicit `return` only |
| Workflow | `run wf [args...]` or `x = run wf [args...]` | explicit `return` only |
| Function | `run fn [args...]` or `x = run fn [args...]` | explicit `return` only |

**Forbidden (compile-time `E_VALIDATE` where applicable):**

- Wrapping Jaiph calls in command substitution, e.g. `x="$(my_fn ...)"`, `x="$(my_wf ...)"`, `x="$(my_rule ...)"` — use `x = run ...` / `x = ensure ...` instead.
- Calling a function as a bare workflow step or via `x = fn …` — use `run fn …` / `x = run fn …`.
- Using `ensure` on a workflow or function, or `run` on a rule — swap to the correct keyword (diagnostic names the expected form).

**Correction path:** If the compiler reports a Jaiph symbol inside `$(...)` or a bare call where a managed step is required, rewrite to `ensure` / `run` on the same reference and, when you need a value back, add `return "..."` / `return "$var"` in the callee.

**Shell and `$(...)`:** Use command substitution only for ordinary shell. The compiler rejects `$(...)` bodies that reference Jaiph rules, workflows, or functions, contain a channel send (`<-`), or start with `run` / `ensure` as command words. The same restrictions apply to **every workflow shell line**: the first command word is always checked, including when the line also contains `$(...)` (e.g. `my_fn $(true)` is rejected the same as a bare `my_fn`). A Jaiph symbol must use the appropriate managed step (`ensure` / `run`), not a bare shell command name (e.g. `out = run my_fn "$1"` is valid; `out = my_fn "$1"` is not).

**Function bodies** stay shell-only for orchestration primitives: they must not contain `run`, `ensure`, `config`, nested top-level declarations, or inbox route lines (`channel -> ...`). Put workflow-style steps in a `workflow` block.

## Parse and Runtime Semantics

1. **Config block:** The opening line must be exactly `config {` (optional trailing whitespace). At most one config block per file at the top level. Inside the block, lines are either `key = value`, `}`, blank, or full-line `#` comments. Allowed keys: `agent.default_model`, `agent.command`, `agent.backend`, `agent.trusted_workspace`, `agent.cursor_flags`, `agent.claude_flags`, `run.logs_dir`, `run.debug`, `run.inbox_parallel`, `runtime.docker_enabled`, `runtime.docker_image`, `runtime.docker_network`, `runtime.docker_timeout`, `runtime.workspace`. Values may be a quoted string, `true`/`false`, a bare integer (`/^[0-9]+$/`), or a bracket-delimited array of quoted strings (`[...]`). Each key has an expected type; mismatches yield `E_PARSE`. For `agent.backend` the value must be `"cursor"` or `"claude"`. Arrays: opening `[` must be on the same line as `=`; each element is a quoted string on its own line; trailing commas and inline `#` comments between elements are allowed; empty array `= []` is valid. **Workflow-level config:** An optional `config { ... }` block may also appear inside a workflow body, before any steps (comments may precede it). At most one per workflow. Only `agent.*` and `run.*` keys are allowed (`runtime.*` keys yield `E_PARSE`). Workflow-level config overrides module-level config for all steps inside that workflow, locks its overrides to prevent inner module-scope wrappers from reverting them, and restores the previous environment when the workflow finishes. See [Configuration](configuration.md#workflow-level-config) for full precedence rules.
2. **ensure:** An optional argument tail after the REF is passed through to the shell (e.g. `ensure check_branch "$1"`). With `recover`, the step becomes a retry loop: run the condition; on failure run the recover body; repeat until the condition passes or max retries are reached. Recover is either a single statement (`ensure dep recover run install_deps`) or a block of statements separated by `;` or newline (`ensure dep recover { run a; run b }`). The recover body receives the failed rule's explicit `return` value as `$1` (not its stdout — stdout goes to step artifacts). If the rule has no `return` statement, `$1` is empty.
3. **Rules:** May use forwarded positional parameters as shell args (`$1`, `$2`, `"$@"`) without special declaration. Only `ensure` and shell commands are allowed inside a rule; `run` is not allowed (use `ensure` to call another rule or move the call to a workflow). **Inline brace groups:** A single logical command can span multiple lines when it contains unbalanced `{` … `}`; the parser tracks brace depth so that short-circuit patterns like `cmd || { echo "failed"; exit 1; }` (single-line) and `cmd || { … }` (multi-line) are accepted as one command in rule, workflow, and function bodies.
4. **run:** Inside a workflow, `run` must target a **workflow** or **function** reference (`foo` or `alias.foo`), not an arbitrary shell command. Optional args after the REF are forwarded to the callee (e.g. `run deploy "$env"`, `run compute_hash "$file"`). **`run` for a function** uses the same managed execution path as `run` for a workflow: step records under `.jaiph/runs`, explicit `return` for assignment capture, and the same stdout-forwarding rules when the caller redirects workflow stdout. **Stdout forwarding:** When the caller redirects stdout (e.g. `run greet "alice" > out.txt` or `run produce | tr a-z A-Z`), the callee's stdout is forwarded to the caller's stream *and* written to step artifacts. This also works with background jobs (`run greet "alice" > out.txt &`). When stdout is not redirected, output is captured into artifacts only (the default behavior). **Assignment capture** (`name = run ...`) reads the callee's explicit `return` value (via `JAIPH_RETURN_VALUE_FILE`), not raw stdout — same contract as `name = ensure ...`.
5. **Functions:** Top-level `function` blocks define writable shell functions. They are transpiled to namespaced implementations; a shim keeps the original name available for **non-workflow** shell contexts. **From a workflow**, invoke a function only with `run fn [args...]` — never as a bare shell line or inside `$(...)`. Functions (like rules and workflows) can use `return "value"` or `return "$var"` to set an explicit return value for managed callers. `return` with a bare integer (e.g. `return 0`) remains a bash exit code.
6. **Conditional steps:** There is a single unified `if` step type supporting ensure-rule, run-workflow-or-function, and shell-expression conditions:
   - `if ensure REF [args]; then ... [else ...] fi` — runs the then-branch when the rule **succeeds**; optional else-branch for failure.
   - `if ! ensure REF [args]; then ... [else ...] fi` — runs the then-branch when the rule **fails**; optional else-branch for success.
   - `if run REF [args]; then ... [else ...] fi` — runs the then-branch when the workflow or function **succeeds** (exit code 0); optional else-branch for failure. The REF may be local or imported (`alias.name`).
   - `if ! run REF [args]; then ... [else ...] fi` — runs the then-branch when the workflow or function **fails** (non-zero exit); optional else-branch for success.
   - `if ! <shell_condition>; then ... fi` — shell-expression condition (negated form only); runs the then-branch when the command **fails**. Else-branches are not supported for shell conditions. Positive shell conditions (`if <cmd>; then ... fi`) are not parsed as Jaiph `if` steps — they fall through as raw shell lines.
   - **Supported step types in branches:** Ensure-condition and run-condition branches support `run`, `prompt`, `prompt_capture`, and shell commands. Ensure-condition branches additionally support `run_capture` and `shell_capture`. Shell-condition branches support `run` and shell commands only. Other step types (`log`, `logerr`, `send`, nested `if`) in any branch are treated as raw shell commands (they will not behave as their Jaiph equivalents).
   - All forms accept optional arguments after the reference (e.g. `if ensure check "$env"; then`, `if run deploy "$env"; then`).
   - `ensure` and `ensure_capture` are **not** allowed inside the then- or else-branch of any if-ensure form; the parser emits `E_PARSE` if `ensure` appears in an unrecognised context.
   - The then-branch must contain at least one step.
7. **prompt:** Two forms are supported:
   - `prompt "<text>"` — Sends the text to the agent; compiles to `jaiph::prompt ...` with bash variable expansion.
   - `name = prompt "<text>"` — Same, but the agent’s stdout is captured into the variable `name` (compiles to `jaiph::prompt_capture`).
   - The prompt string may span multiple lines. Only variable expansion is allowed inside the string; backticks and `$(...)` are rejected with `E_PARSE`.
   - **Typed prompt (returns schema):** Optional `returns '{ field: type, ... }'` (single- or double-quoted) after the prompt string. When present, the prompt **must** capture to a variable (e.g. `result = prompt "..." returns '{ type: string, risk: string }'`). The schema is **flat only** (no nested objects); allowed types are `string`, `number`, `boolean` (no arrays or union types in v1). The compiler appends instructions to the prompt so the agent is asked to respond with exactly one line of valid JSON matching the schema. At runtime, the response is searched for valid JSON using multiple strategies (in order): the last non-empty line, fenced code blocks, a standalone `{…}` line, and embedded JSON within a line (text before `{` is stripped). The first candidate that parses as valid JSON is used; if none parse successfully, the step fails with a parse error; if a required field is missing or a value has the wrong type, the step fails with a distinct schema/missing-field or type error. On success, the capture variable is set to the raw JSON string, and for each schema field a variable `name_field` is exported (e.g. `$result_type`, `$result_risk`). Line continuation with trailing `\` after the closing quote of the prompt is supported so the `returns` clause can continue on the next line(s).
8. **Assignment capture for any step:** `name = <step>` captures a value into the variable `name`. What is captured depends on the step kind (see [Step Output Contract](#step-output-contract)):
   - `name = ensure ref [args...]` — Runs the rule and captures its explicit `return` value into `name`. Command stdout (`echo`, `printf`, etc.) inside the rule goes to step artifacts only. With `recover`, the captured value is the `return` value of the rule when it finally passes.
   - `name = run ref [args...]` — Runs the workflow **or function** and captures its explicit `return` value into `name`. Callee stdout from ordinary commands goes to step artifacts only (same contract as `ensure`).
   - `name = <shell_command>` — Runs the shell command and captures its **full stdout** into `name`. This is raw bash `$(...)` behavior; no Jaiph `return` channel applies. Do not use this form to call a Jaiph rule, workflow, or function — use `ensure` / `run` steps instead (the compiler rejects Jaiph symbols inside `$(...)` and bare function calls in workflow shell lines).
   - `name = prompt "..."` — Captures the agent's final answer into `name`; the full transcript goes to step artifacts.
   - To set a return value inside a rule, workflow, or function, use `return "value"` or `return "$variable"`. `return` with a bare integer (e.g. `return 0`) is a bash exit code, not a value return.
   - **Exit semantics:** Assignment capture does **not** change exit behavior: if the command fails, the step fails and the workflow exits (with `set -e`). To capture output even on failure, the workflow author must explicitly short-circuit (e.g. append `|| true` to the command).
9. **log:** `log "message"` displays a message in the progress tree at the current indentation depth. The argument must be a double-quoted string (same quoting rules as `prompt`). Shell variable interpolation (`$var`, `${var}`) works at runtime. `log` is not a step — it has no pending/running/done states, no timing, and no spinner. It transpiles to `jaiph::log "message"`, which emits a `LOG` event on fd 3 and echoes to stdout. Parse error if `log` is used without a quoted string.
10. **logerr:** `logerr "message"` is identical to `log` except the message is written to stderr instead of stdout. It transpiles to `jaiph::logerr "message"`, which emits a `LOGERR` event on fd 3 and echoes to stderr. In the progress tree, `logerr` lines are displayed with a `!` symbol in red (instead of the dim `ℹ` used by `log`). Parse error if `logerr` is used without a quoted string.
11. **Send operator (`<-`):** `channel <- echo "data"` writes the command's stdout to the next inbox slot and signals the runtime to dispatch. The channel identifier is always on the left side of the `<-` operator. The `<-` operator is detected before the shell fallback; it only matches when `braceDepth == 0` and `<-` appears outside of quoted strings. Standalone `channel <-` (no command after the operator) forwards `$1`. Combining capture and send (`name = channel <- cmd`) is a parse error (`E_PARSE: capture and send cannot be combined; use separate steps`). The send step transpiles to `jaiph::send 'channel' "$(cmd)" 'sender'` (or `jaiph::send 'channel' "$1" 'sender'` for standalone), where `sender` is the enclosing workflow name. See [Inbox & Dispatch](inbox.md).
12. **Route declaration:** `channel -> workflow` registers a static routing rule: when a message arrives on `channel`, the runtime calls `workflow` with positional args `$1=message`, `$2=channel`, `$3=sender` (see [Trigger contract](inbox.md#trigger-contract)). Multiple targets are supported: `channel -> wf1, wf2` dispatches sequentially in declaration order; each target receives the same message. Route declarations are stored in `WorkflowDef.routes`, not in `steps`; they are not executable statements. The transpiler emits `jaiph::register_route` calls at the top of the orchestrator function, and `jaiph::drain_queue` at the end. See [Inbox & Dispatch](inbox.md).
13. **Export:** Rule and workflow declarations may be prefixed with `export` to mark them as part of the module’s public interface. The implementation does not restrict references to exported symbols: any rule or workflow in an imported module can be referenced.
14. **Parallel processes in shell steps:** Shell steps support standard Bash job control — background a command with `&` and synchronise with `wait`. This is useful when a step needs to run multiple independent programs concurrently:

    ```jh
    workflow default {
      build_frontend --prod &
      build_backend --prod &
      wait
    }
    ```

    **How it works:** Shell steps are emitted as raw Bash inside the workflow's `::impl` function. The runtime executes `::impl` with stdout/stderr directed to `.out`/`.err` artifact files. When the caller has redirected stdout (e.g. `> file` or `| pipe`), the runtime uses `tee` to send output to both the artifact and the caller's stream. Background jobs inherit these file descriptors, so their output is captured in the same artifacts.

    **Exit status and `wait`:**
    - Bare `wait` (no arguments) waits for all background children and returns **0** regardless of individual child exit statuses — this is standard Bash behaviour. The step succeeds even if a background job failed.
    - `wait $pid` returns the exit status of the specific process. Combined with the `set -e` inside the impl function, a non-zero exit from a waited-for process fails the step.
    - For deterministic failure detection, capture PIDs and wait explicitly:

      ```jh
      workflow default {
        prog1 & pid1=$!
        prog2 & pid2=$!
        wait $pid1 || exit $?
        wait $pid2 || exit $?
      }
      ```

    **Constraints:**
    - Users **must** `wait` for all background jobs before the step ends. If a background process is still running when the `::impl` function returns, it may be orphaned and its output may be lost (the artifact temp file is finalised immediately after the impl exits).
    - Jaiph internal functions (`jaiph::send`, `jaiph::log`, `ensure`, `run`, etc.) should **not** be called from background subprocesses. These functions access shared run state (sequence counters, summary files) that is only lock-protected under `run.inbox_parallel = true`. Use standard external programs for backgrounded work.
    - Output from concurrent background processes may interleave at the line level in `.out`/`.err` artifacts. This is normal Bash behaviour; writes up to `PIPE_BUF` bytes (typically 4096) are atomic.
15. **Top-level local (env declarations):** `local name = value` declares a module-scoped variable. The value may be a double-quoted string (may span multiple lines; stored raw without escape processing), a single-quoted string (single-line only), or a bare value (rest of line). The variable is transpiled to a prefixed bash variable using `__` as separator (e.g. `local role` in module `entry` becomes `entry__role="..."`). Inside each rule, function, and workflow body, a `local` shim is emitted so that `$role` resolves to the prefixed variable (`local role="$entry__role"`). Variable names participate in the unified namespace — they cannot collide with rule, workflow, or function names. Variables are module-scoped only and are not exportable; cross-module access is not supported.

## Validation Rules

After parsing, the compiler validates references and config. Violations produce the following error codes:

- **E_PARSE:** Invalid syntax, duplicate config block, invalid config key/value, invalid prompt content (e.g. command substitution in prompt), or `prompt "..." returns '...'` without a capture variable.
- **E_SCHEMA:** Invalid or unsupported `returns` schema: empty schema, non-flat shape (e.g. arrays or union types), invalid entry (not `fieldName: type`), or unsupported type (only `string`, `number`, `boolean` allowed).
- **E_VALIDATE:** Reference or alias error (unknown rule/workflow, duplicate alias, etc.), forbidden Jaiph usage inside `$(...)` or as a bare shell call where a managed step is required, or invalid constructs inside function bodies.
- **E_IMPORT_NOT_FOUND:** The file resolved from an `import` path does not exist.

Rules:

1. At most one `config` block per file at the top level; duplicate config yields `E_PARSE`. At most one `config` block per workflow; duplicate yields `E_PARSE`. Workflow-level config must appear before any steps; placing it after a step yields `E_PARSE`. Only `agent.*` and `run.*` keys are allowed in workflow-level config; `runtime.*` keys yield `E_PARSE`.
2. Config keys must be one of the allowed keys; values must be a quoted string, `true`/`false`, a bare integer, or a bracket-delimited array of quoted strings. Each key has an expected type (string, boolean, number, or string[]); a type mismatch yields `E_PARSE`. For `agent.backend`, the value must be `"cursor"` or `"claude"`. Invalid key yields `E_PARSE`.
3. Import aliases must be unique within a file (`E_VALIDATE`).
4. Import targets must exist on disk (`E_IMPORT_NOT_FOUND`).
5. **Unified namespace:** Rules, workflows, functions, and top-level locals share a single name space per module. Declaring two items with the same name (e.g. a rule `foo` and a local `foo`) yields `E_PARSE`.
6. **Calling conventions (compile-time enforcement):**
   - `ensure` must target a rule. Using `ensure` on a workflow yields `E_VALIDATE` ("workflow X must be called with run"). Using `ensure` on a function yields `E_VALIDATE` ("function X cannot be called with ensure").
   - `run` must target a workflow **or** function. Using `run` on a rule yields `E_VALIDATE` (e.g. "rule X must be called with ensure, not run").
   - **Functions in workflows:** A workflow step may not call a function as a bare shell command (`fn` or `name = fn ...`); use `run fn ...`. **Substitution and shell lines:** `$(...)` must not invoke Jaiph rules, workflows, or functions, must not contain `<-`, and must not use `run`/`ensure` as leading shell commands. Every workflow shell line is checked the same way on its first command word, even when the line also contains `$(...)`. Function bodies are scanned for `$(...)` with the same Jaiph-symbol rules; they also cannot contain `run`, `ensure`, `config`, nested declarations, or `channel ->` routes.
   - These checks apply to both local and imported references.
7. **Send and route validation:** Channel references must be valid refs (`name` or `alias.name`) and must resolve to a declared channel in the current module or an imported module. Undefined channels fail with `E_VALIDATE: Channel "<name>" is not defined`. Workflow references in route declarations must exist and must target **workflows** (not functions). `name = channel <- cmd` (capture combined with send) yields `E_PARSE`. Max dispatch depth of 100; exceeding it emits `E_DISPATCH_DEPTH`.
8. Local `ensure foo` requires a local rule `foo`. Imported `ensure alias.foo` requires a rule `foo` in the module bound to `alias` (export is not required).
9. Local `run bar` requires a local workflow **or** function `bar`. Imported `run alias.bar` requires a workflow or function `bar` in the module bound to `alias` (export is not required).

## Transpilation

1. Build emits Bash scripts that source the installed stdlib (`$JAIPH_STDLIB`, default `~/.local/bin/jaiph_stdlib.sh`). The script checks for API compatibility before use. After the compatibility check, the script saves the original stdout as fd 7 (`exec 7>&1`) and exports `JAIPH_STDOUT_SAVED=1`. The runtime uses fd 7 to detect caller-side redirections: when a `run` step's fd 1 differs from fd 7 (and fd 8, the capture target), the step's output is tee'd to both the artifact file and the caller's stdout.
2. When the module has a `config` block, the generated script exports `JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, (if `run.debug` is set to `true`) `JAIPH_DEBUG`, and (if `run.inbox_parallel` is set to `true`) `JAIPH_INBOX_PARALLEL`, using the in-file values as defaults; environment variables override these. `runtime.*` keys populate the `RuntimeConfig` on `WorkflowMetadata` (see `src/types.ts`).
3. **Flat symbol namespace:** Rules, workflows, and functions share a single namespace per module. All are emitted as `<module>::<name>::impl` and `<module>::<name>`. The kind (rule, workflow, function) is communicated via an explicit argument to `jaiph::run_step`, not encoded in the symbol name. Duplicate names across types within a module produce `E_PARSE`.
4. **Rules:** Each rule is emitted as `<module>::<name>::impl` (the implementation) and `<module>::<name>` (a wrapper that calls `jaiph::run_step <symbol> rule jaiph::execute_readonly <symbol>::impl`). When config is present, the wrapper is invoked inside a metadata scope that sets the config env vars for the duration of the step.
5. **Workflows:** Each workflow is emitted as `<module>::<name>::impl` and `<module>::<name>`, with the wrapper using `jaiph::run_step <symbol> workflow <symbol>::impl "$@"` and the same metadata-scoping behavior as rules. When a workflow has its own `config` block, a dedicated `<module>::<name>::with_metadata_scope` function is emitted that saves, sets, and restores the config env vars — and locks its overrides (`_LOCKED=1`) so that inner module-scope wrappers (e.g. for rules or functions called from the workflow) do not revert the workflow's values. The workflow-level scope takes precedence over the module-level scope; if no workflow-level config exists, the module-level scope is used as before.
6. **Functions:** Each top-level function is emitted as `<module>::<name>::impl`, `<module>::<name>` (wrapper using `jaiph::run_step` / the same managed-step machinery as workflows, with step kind `function`), and a shim `<name>` that forwards to the namespaced wrapper for non-workflow shell callers. Workflow steps invoke functions via `run`, which records the call like any other managed step.
7. **Send steps and routes:** Send steps transpile to `jaiph::send 'channel' "$(cmd)" 'sender'` (or `jaiph::send 'channel' "$1" 'sender'` for standalone `channel <-`), where `sender` is the name of the enclosing workflow. Route declarations transpile to `jaiph::register_route 'channel' '<module>::<name>'` calls emitted at the top of the orchestrator function. `jaiph::drain_queue` is emitted at the end of the orchestrator's `::impl` function. The runtime functions live in `src/runtime/inbox.sh` (sourced via `jaiph_stdlib.sh`): `jaiph::inbox_init` creates the inbox directory and initializes the counter; `jaiph::send` writes messages; `jaiph::register_route` populates the route table; `jaiph::drain_queue` processes the dispatch queue.
8. **Conditional steps:** The unified `if` step transpiles to explicit Bash `if [!] ...; then ... [else ...] fi`. Ensure conditions call the transpiled rule function; run conditions call the transpiled workflow or function wrapper (with metadata-scope prefix for imported callees when applicable); shell conditions pass through as-is. **Prompt with returns:** When `returns '{ ... }'` is used, the step is emitted as `jaiph::prompt_capture_with_schema`; the stdlib extracts JSON from the agent output (trying multiple strategies: last line, fenced code block, standalone object line, embedded JSON within a line), validates it against the schema, and on success sets the capture variable and exports `name_field` for each field. Exit codes: 0 = success; 1 = JSON parse error; 2 = missing required field; 3 = type mismatch. **ensure … recover:** Transpiled to a bounded retry loop: `for _jaiph_retry in $(seq 1 "${JAIPH_ENSURE_MAX_RETRIES:-10}"); do if <rule>(args); then break; fi; <body>; done`, then if the condition still fails, the script exits with status 1. The recover body may be a single statement or a `{ stmt; ... }` block. Max retries default to 10 and can be overridden via `JAIPH_ENSURE_MAX_RETRIES`. In recover loops, the rule is called with `JAIPH_RETURN_VALUE_FILE` set; on failure the rule’s explicit `return` value is passed to the recover body as `$1`. **Assignment capture:** For shell steps, capture is emitted as `VAR=$(cmd)` (standard bash stdout capture). For rules, workflows, and function calls, capture uses a temporary file via `JAIPH_RETURN_VALUE_FILE`: the callee writes its explicit `return` value to this file via `jaiph::set_return_value`, and the caller reads it after the call completes. Only explicit `return` values are captured — command stdout goes to step artifacts. If no `return` was set, the variable is empty. The command’s exit status is preserved (failure exits unless the user adds e.g. `|| true`). **`return` statement:** `return "value"` and `return "$var"` inside rules, workflows, and functions transpile to `jaiph::set_return_value <value>; return 0`. `return` with a bare integer (e.g. `return 0`) or `return $?` is kept as a standard bash exit code.
