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
- **Workflows** — Named sequences of steps: `ensure` (call a rule), `run` (call a workflow), `prompt` (agent), `log`/`logerr` (emit messages), `send` (write to an inbox channel), or shell. Workflows may also declare `route` rules for inbox dispatch. Workflows orchestrate when each step runs.
- **Functions** — Named shell function blocks. Callable directly by name in shell context; cannot be used with `ensure` or `run`. Functions cannot be exported.
- **ensure** — Runs a rule; succeeds if its exit code is 0. Optional `recover` runs on failure and retries until the rule passes or max retries are reached.
- **run** — Invokes a workflow (local or via import alias). Must reference a workflow, not a shell command.
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
- **Import path:** The path in `import "<path>" as IDENT` must be a quoted string (single or double quotes).
- **File extensions:** Build, run, and import resolution support `.jh` (recommended) and `.jph` (supported, deprecated for new use).

## EBNF (Practical Form)

Informal symbols used below:

- `string` — Quoted string (single or double quotes).
- `args_tail` — Rest of the line after a REF; passed through to the shell as-is (e.g. `"$1"` or `arg1 arg2`).
- `quoted_or_multiline_string` — A double-quoted string; may span multiple lines. Supports `\$`, `\"`, and `\\` escapes; a trailing `\` on a line acts as line continuation. Variable expansion (`$VAR`) is allowed in prompt context; backticks and `$(...)` are not.

```ebnf
file            = { top_level } ;

top_level       = config_block | import_stmt | env_decl | rule_decl | function_decl | workflow_decl ;

config_block    = "config" "{" { config_line } "}" ;
  (* Inside the block, blank lines and full-line # comments are allowed. *)
config_line     = config_key "=" config_value ;
config_key      = "agent.default_model" | "agent.command" | "agent.backend" | "agent.trusted_workspace"
                | "agent.cursor_flags" | "agent.claude_flags" | "run.logs_dir" | "run.debug"
                | "runtime.docker_enabled" | "runtime.docker_image" | "runtime.docker_network"
                | "runtime.docker_timeout" | "runtime.workspace" ;
config_value    = string | "true" | "false" | integer | string_array ;
integer         = digit { digit } ;           (* bare non-negative integer, e.g. 300 *)
string_array    = "[" { array_element } "]" ;  (* opening "[" on same line as "="; elements on own lines *)
array_element   = string [ "," ] ;             (* trailing comma and inline # comments allowed *)

import_stmt     = "import" string "as" IDENT ;

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
                | log_stmt
                | logerr_stmt
                | send_stmt
                | route_decl
                | if_stmt
                | shell_stmt
                | comment_line ;

send_stmt       = IDENT "<-" [ shell_command ] ;
  (* Writes content to inbox channel. Standalone "channel <-" forwards $1. *)
  (* The channel identifier is always on the left side of the "<-" operator. *)
  (* Detected before shell fallback; only matches when braceDepth == 0 and "<-" is outside quotes. *)
  (* "name = channel <- cmd" is E_PARSE: capture and send cannot be combined. *)

route_decl      = IDENT "->" REF { "," REF } ;
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
  (* The then- and else-branches accept any workflow step (run, prompt, shell, *)
  (* capture forms, log, logerr, send, nested if, etc.). *)
  (* ensure/ensure_capture are not allowed inside either branch. *)

if_condition    = "ensure" REF [ args_tail ]
                | "run" REF [ args_tail ]
                | shell_condition ;

shell_condition  = ? any shell expression, e.g. "test -f .file" ? ;

shell_stmt      = command_line ;
```

## Parse and Runtime Semantics

1. **Config block:** The opening line must be exactly `config {` (optional trailing whitespace). At most one config block per file at the top level. Inside the block, lines are either `key = value`, `}`, blank, or full-line `#` comments. Allowed keys: `agent.default_model`, `agent.command`, `agent.backend`, `agent.trusted_workspace`, `agent.cursor_flags`, `agent.claude_flags`, `run.logs_dir`, `run.debug`, `runtime.docker_enabled`, `runtime.docker_image`, `runtime.docker_network`, `runtime.docker_timeout`, `runtime.workspace`. Values may be a quoted string, `true`/`false`, a bare integer (`/^[0-9]+$/`), or a bracket-delimited array of quoted strings (`[...]`). Each key has an expected type; mismatches yield `E_PARSE`. For `agent.backend` the value must be `"cursor"` or `"claude"`. Arrays: opening `[` must be on the same line as `=`; each element is a quoted string on its own line; trailing commas and inline `#` comments between elements are allowed; empty array `= []` is valid. **Workflow-level config:** An optional `config { ... }` block may also appear inside a workflow body, before any steps (comments may precede it). At most one per workflow. Only `agent.*` and `run.*` keys are allowed (`runtime.*` keys yield `E_PARSE`). Workflow-level config overrides module-level config for all steps inside that workflow, locks its overrides to prevent inner module-scope wrappers from reverting them, and restores the previous environment when the workflow finishes. See [Configuration](configuration.md#workflow-level-config) for full precedence rules.
2. **ensure:** An optional argument tail after the REF is passed through to the shell (e.g. `ensure check_branch "$1"`). With `recover`, the step becomes a retry loop: run the condition; on failure run the recover body; repeat until the condition passes or max retries are reached. Recover is either a single statement (`ensure dep recover run install_deps`) or a block of statements separated by `;` or newline (`ensure dep recover { run a; run b }`).
3. **Rules:** May use forwarded positional parameters as shell args (`$1`, `$2`, `"$@"`) without special declaration. Only `ensure` and shell commands are allowed inside a rule; `run` is not allowed (use `ensure` to call another rule or move the call to a workflow). **Inline brace groups:** A single logical command can span multiple lines when it contains unbalanced `{` … `}`; the parser tracks brace depth so that short-circuit patterns like `cmd || { echo "failed"; exit 1; }` (single-line) and `cmd || { … }` (multi-line) are accepted as one command in rule, workflow, and function bodies.
4. **run:** Inside a workflow, `run` must target a workflow reference (`foo` or `alias.foo`), not an arbitrary shell command. Optional args after the REF are forwarded to the workflow (e.g. `run deploy "$env"`).
5. **Functions:** Top-level `function` blocks define writable shell functions. They are transpiled to namespaced implementations; the original name remains callable via a shim that forwards to the namespaced wrapper.
6. **Conditional steps:** There is a single unified `if` step type. Both positive and negated conditions are supported, with an ensure-rule, a run-workflow, or a shell-expression condition:
   - `if ensure REF [args]; then ... [else ...] fi` — runs the then-branch when the rule **succeeds**; optional else-branch for failure.
   - `if ! ensure REF [args]; then ... [else ...] fi` — runs the then-branch when the rule **fails**; optional else-branch for success.
   - `if run REF [args]; then ... [else ...] fi` — runs the then-branch when the workflow **succeeds** (exit code 0); optional else-branch for failure. The REF may be local or imported (`alias.workflow`).
   - `if ! run REF [args]; then ... [else ...] fi` — runs the then-branch when the workflow **fails** (non-zero exit); optional else-branch for success.
   - `if ! <shell_condition>; then ... [else ...] fi` — shell-expression condition; runs the then-branch when the command **fails**.
   - Both branches accept any workflow step (`run`, `prompt`, `shell`, capture forms, `log`, `logerr`, `send`, nested `if`, etc.).
   - All forms accept optional arguments after the reference (e.g. `if ensure check "$env"; then`, `if run deploy "$env"; then`).
   - `ensure` and `ensure_capture` are **not** allowed inside the then- or else-branch of any if-ensure form; the parser emits `E_PARSE` if `ensure` appears in an unrecognised context.
   - The then-branch must contain at least one step.
7. **prompt:** Two forms are supported:
   - `prompt "<text>"` — Sends the text to the agent; compiles to `jaiph::prompt ...` with bash variable expansion.
   - `name = prompt "<text>"` — Same, but the agent’s stdout is captured into the variable `name` (compiles to `jaiph::prompt_capture`).
   - The prompt string may span multiple lines. Only variable expansion is allowed inside the string; backticks and `$(...)` are rejected with `E_PARSE`.
   - **Typed prompt (returns schema):** Optional `returns '{ field: type, ... }'` (single- or double-quoted) after the prompt string. When present, the prompt **must** capture to a variable (e.g. `result = prompt "..." returns '{ type: string, risk: string }'`). The schema is **flat only** (no nested objects); allowed types are `string`, `number`, `boolean` (no arrays or union types in v1). The compiler appends instructions to the prompt so the agent is asked to respond with exactly one line of valid JSON matching the schema. At runtime, the response is searched for valid JSON using multiple strategies (in order): the last non-empty line, fenced code blocks, a standalone `{…}` line, and embedded JSON within a line (text before `{` is stripped). The first candidate that parses as valid JSON is used; if none parse successfully, the step fails with a parse error; if a required field is missing or a value has the wrong type, the step fails with a distinct schema/missing-field or type error. On success, the capture variable is set to the raw JSON string, and for each schema field a variable `name_field` is exported (e.g. `$result_type`, `$result_risk`). Line continuation with trailing `\` after the closing quote of the prompt is supported so the `returns` clause can continue on the next line(s).
8. **Assignment capture for any step:** In addition to `name = prompt "..."`, you can capture stdout from any step with `name = <step>`:
   - `name = ensure ref [args...]` — Runs the rule and captures its stdout into `name`. With `recover`, the same retry semantics apply; the captured value is the stdout of the rule when it passes.
   - `name = run ref [args...]` — Runs the workflow and captures its stdout into `name`.
   - `name = <shell_command>` — Runs the shell command and captures its stdout into `name`.
   - **Bash-consistent semantics:** Assignment capture does **not** change exit behavior: if the command fails, the step fails and the workflow exits (with `set -e`). To capture output even on failure, the workflow author must explicitly short-circuit (e.g. append `|| true` to the command). Only **stdout** is captured; **stderr** is not included unless the command redirects it (e.g. `name = cmd 2>&1`).
9. **log:** `log "message"` displays a message in the progress tree at the current indentation depth. The argument must be a double-quoted string (same quoting rules as `prompt`). Shell variable interpolation (`$var`, `${var}`) works at runtime; at compile time (`jaiph tree` / `--dry-run`), variables are shown unexpanded. `log` is not a step — it has no pending/running/done states, no timing, and no spinner. It transpiles to `jaiph::log "message"`, which emits a `LOG` event on fd 3 and echoes to stdout. Parse error if `log` is used without a quoted string.
10. **logerr:** `logerr "message"` is identical to `log` except the message is written to stderr instead of stdout. It transpiles to `jaiph::logerr "message"`, which emits a `LOGERR` event on fd 3 and echoes to stderr. In the progress tree, `logerr` lines are displayed with a `!` symbol in red (instead of the dim `ℹ` used by `log`). Parse error if `logerr` is used without a quoted string.
11. **Send operator (`<-`):** `channel <- echo "data"` writes the command's stdout to the next inbox slot and signals the runtime to dispatch. The channel identifier is always on the left side of the `<-` operator. The `<-` operator is detected before the shell fallback; it only matches when `braceDepth == 0` and `<-` appears outside of quoted strings. Standalone `channel <-` (no command after the operator) forwards `$1`. Combining capture and send (`name = channel <- cmd`) is a parse error (`E_PARSE: capture and send cannot be combined; use separate steps`). The send step transpiles to `jaiph::send 'channel' "$(cmd)"` (or `jaiph::send 'channel' "$1"` for standalone). See [Inbox & Dispatch](inbox.md).
12. **Route declaration:** `channel -> workflow` registers a static routing rule: when a message arrives on `channel`, the runtime calls `workflow` with positional args `$1=message`, `$2=channel`, `$3=sender` (see [Trigger contract](inbox.md#trigger-contract)). Multiple targets are supported: `channel -> wf1, wf2` dispatches sequentially in declaration order; each target receives the same message. Route declarations are stored in `WorkflowDef.routes`, not in `steps`; they are not executable statements. The transpiler emits `jaiph::register_route` calls at the top of the orchestrator function, and `jaiph::drain_queue` at the end. See [Inbox & Dispatch](inbox.md).
13. **Export:** Rule and workflow declarations may be prefixed with `export` to mark them as part of the module’s public interface. The implementation does not restrict references to exported symbols: any rule or workflow in an imported module can be referenced.
14. **Top-level local (env declarations):** `local name = value` declares a module-scoped variable. The value may be a double-quoted string (may span multiple lines; stored raw without escape processing), a single-quoted string (single-line only), or a bare value (rest of line). The variable is transpiled to a prefixed bash variable using `__` as separator (e.g. `local role` in module `entry` becomes `entry__role="..."`). Inside each rule, function, and workflow body, a `local` shim is emitted so that `$role` resolves to the prefixed variable (`local role="$entry__role"`). Variable names participate in the unified namespace — they cannot collide with rule, workflow, or function names. Variables are module-scoped only and are not exportable; cross-module access is not supported.

## Validation Rules

After parsing, the compiler validates references and config. Violations produce the following error codes:

- **E_PARSE:** Invalid syntax, duplicate config block, invalid config key/value, invalid prompt content (e.g. command substitution in prompt), or `prompt "..." returns '...'` without a capture variable.
- **E_SCHEMA:** Invalid or unsupported `returns` schema: empty schema, non-flat shape (e.g. arrays or union types), invalid entry (not `fieldName: type`), or unsupported type (only `string`, `number`, `boolean` allowed).
- **E_VALIDATE:** Reference or alias error (unknown rule/workflow, duplicate alias, etc.).
- **E_IMPORT_NOT_FOUND:** The file resolved from an `import` path does not exist.

Rules:

1. At most one `config` block per file at the top level; duplicate config yields `E_PARSE`. At most one `config` block per workflow; duplicate yields `E_PARSE`. Workflow-level config must appear before any steps; placing it after a step yields `E_PARSE`. Only `agent.*` and `run.*` keys are allowed in workflow-level config; `runtime.*` keys yield `E_PARSE`.
2. Config keys must be one of the allowed keys; values must be a quoted string, `true`/`false`, a bare integer, or a bracket-delimited array of quoted strings. Each key has an expected type (string, boolean, number, or string[]); a type mismatch yields `E_PARSE`. For `agent.backend`, the value must be `"cursor"` or `"claude"`. Invalid key yields `E_PARSE`.
3. Import aliases must be unique within a file (`E_VALIDATE`).
4. Import targets must exist on disk (`E_IMPORT_NOT_FOUND`).
5. **Unified namespace:** Rules, workflows, functions, and top-level locals share a single name space per module. Declaring two items with the same name (e.g. a rule `foo` and a local `foo`) yields `E_PARSE`.
6. **Calling conventions (compile-time enforcement):**
   - `ensure` must target a rule. Using `ensure` on a workflow yields `E_VALIDATE` ("workflow X must be called with run"). Using `ensure` on a function yields `E_VALIDATE` ("function X cannot be called with ensure").
   - `run` must target a workflow. Using `run` on a rule yields `E_VALIDATE` ("rule X must be called with ensure"). Using `run` on a function yields `E_VALIDATE` ("function X cannot be called with run").
   - Functions are called directly by name in shell context; they cannot be used with `ensure` or `run`.
   - These checks apply to both local and imported references.
7. **Send and route validation:** Channel names must be valid identifiers. Workflow references in route declarations must exist (same resolution as `run`). `name = channel <- cmd` (capture combined with send) yields `E_PARSE`. Send to an unregistered channel at runtime is a silent drop (no error). Max dispatch depth of 100; exceeding it emits `E_DISPATCH_DEPTH`.
8. Local `ensure foo` requires a local rule `foo`. Imported `ensure alias.foo` requires a rule `foo` in the module bound to `alias` (export is not required).
9. Local `run bar` requires a local workflow `bar`. Imported `run alias.bar` requires a workflow `bar` in the module bound to `alias` (export is not required).

## Transpilation

1. Build emits Bash scripts that source the installed stdlib (`$JAIPH_STDLIB`, default `~/.local/bin/jaiph_stdlib.sh`). The script checks for API compatibility before use.
2. When the module has a `config` block, the generated script exports `JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, and (if `run.debug` is set to `true`) `JAIPH_DEBUG`, using the in-file values as defaults; environment variables override these. `runtime.*` keys populate the `RuntimeConfig` on `WorkflowMetadata` (see `src/types.ts`).
3. **Flat symbol namespace:** Rules, workflows, and functions share a single namespace per module. All are emitted as `<module>::<name>::impl` and `<module>::<name>`. The kind (rule, workflow, function) is communicated via an explicit argument to `jaiph::run_step`, not encoded in the symbol name. Duplicate names across types within a module produce `E_PARSE`.
4. **Rules:** Each rule is emitted as `<module>::<name>::impl` (the implementation) and `<module>::<name>` (a wrapper that calls `jaiph::run_step <symbol> rule jaiph::execute_readonly <symbol>::impl`). When config is present, the wrapper is invoked inside a metadata scope that sets the config env vars for the duration of the step.
5. **Workflows:** Each workflow is emitted as `<module>::<name>::impl` and `<module>::<name>`, with the wrapper using `jaiph::run_step <symbol> workflow <symbol>::impl "$@"` and the same metadata-scoping behavior as rules. When a workflow has its own `config` block, a dedicated `<module>::<name>::with_metadata_scope` function is emitted that saves, sets, and restores the config env vars — and locks its overrides (`_LOCKED=1`) so that inner module-scope wrappers (e.g. for rules or functions called from the workflow) do not revert the workflow's values. The workflow-level scope takes precedence over the module-level scope; if no workflow-level config exists, the module-level scope is used as before.
6. **Functions:** Each top-level function is emitted as `<module>::<name>::impl`, `<module>::<name>` (wrapper using `jaiph::run_step_passthrough <symbol> function <symbol>::impl "$@"`), and a shim `<name>` that forwards to the namespaced wrapper so the original name remains callable.
7. **Send steps and routes:** Send steps transpile to `jaiph::send 'channel' "$(cmd)"` (or `jaiph::send 'channel' "$1"` for standalone `channel <-`). Route declarations transpile to `jaiph::register_route 'channel' '<module>::<name>'` calls emitted at the top of the orchestrator function. `jaiph::drain_queue` is emitted at the end of the orchestrator's `::impl` function. The runtime functions live in `src/runtime/inbox.sh` (sourced via `jaiph_stdlib.sh`): `jaiph::inbox_init` creates the inbox directory and initializes the counter; `jaiph::send` writes messages; `jaiph::register_route` populates the route table; `jaiph::drain_queue` processes the dispatch queue.
8. **Conditional steps:** The unified `if` step transpiles to explicit Bash `if [!] ...; then ... [else ...] fi`. Ensure conditions call the transpiled rule function; run conditions call the transpiled workflow function (with metadata-scope prefix for imported workflows); shell conditions pass through as-is. **Prompt with returns:** When `returns '{ ... }'` is used, the step is emitted as `jaiph::prompt_capture_with_schema`; the stdlib extracts JSON from the agent output (trying multiple strategies: last line, fenced code block, standalone object line, embedded JSON within a line), validates it against the schema, and on success sets the capture variable and exports `name_field` for each field. Exit codes: 0 = success; 1 = JSON parse error; 2 = missing required field; 3 = type mismatch. **ensure … recover:** Transpiled to a bounded retry loop: `for _jaiph_retry in $(seq 1 "${JAIPH_ENSURE_MAX_RETRIES:-10}"); do if <rule>(args); then break; fi; <body>; done`, then if the condition still fails, the script exits with status 1. The recover body may be a single statement or a `{ stmt; ... }` block. Max retries default to 10 and can be overridden via `JAIPH_ENSURE_MAX_RETRIES`. **Assignment capture:** Steps with a capture variable (e.g. `response = ensure foo`, `out = run bar`) are emitted as `VAR=$(...)`; only stdout is captured, and the command’s exit status is preserved (failure exits unless the user adds e.g. `|| true`).
