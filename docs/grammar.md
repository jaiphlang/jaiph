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

### High-level concepts

- **Rules** — Named blocks of shell commands used as idempotent checks or actions. Only `ensure` and raw shell are allowed inside a rule; use `ensure` to call another rule.
- **Workflows** — Named sequences of steps: `ensure` (call a rule), `run` (call a workflow), `prompt` (agent), or shell. Workflows orchestrate when each step runs.
- **ensure** — Runs a rule; succeeds if its exit code is 0. Optional `recover` runs on failure and retries until the rule passes or max retries are reached.
- **run** — Invokes a workflow (local or via import alias). Must reference a workflow, not a shell command.
- **prompt** — Sends a double-quoted string to the configured agent. Optional `returns` schema asks the agent for one line of JSON and validates it.
- **config** — Optional block at the top of a file setting agent and run options (model, backend, logs dir, etc.).
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
- `quoted_or_multiline_string` — A double-quoted string; may span multiple lines. Supports `\$`, `\"`, `\\`, and `\n` escapes. Variable expansion (`$VAR`) is allowed; backticks and `$(...)` are not.

```ebnf
file            = { top_level } ;

top_level       = config_block | import_stmt | rule_decl | function_decl | workflow_decl ;

config_block    = "config" "{" { config_line } "}" ;
  (* Inside the block, blank lines and full-line # comments are allowed. *)
config_line     = ( "agent.default_model" | "agent.command" | "agent.backend" | "agent.trusted_workspace" | "agent.cursor_flags" | "agent.claude_flags" | "run.logs_dir" | "run.debug" ) "=" ( string | "true" | "false" ) ;

import_stmt     = "import" string "as" IDENT ;

rule_decl       = [ "export" ] "rule" IDENT "{" { rule_line } "}" ;
rule_line       = comment_line | command_line ;

function_decl   = "function" IDENT [ "()" ] "{" { function_line } "}" ;
function_line   = comment_line | command_line ;

workflow_decl   = [ "export" ] "workflow" IDENT "{" { workflow_step } "}" ;

workflow_step   = ensure_stmt
                | run_stmt
                | prompt_stmt
                | prompt_capture_stmt
                | ensure_capture_stmt
                | run_capture_stmt
                | shell_capture_stmt
                | if_not_ensure_then_run_stmt
                | if_not_ensure_then_shell_stmt
                | if_not_ensure_then_stmt
                | if_not_shell_then_stmt
                | shell_stmt
                | comment_line ;

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

if_not_ensure_then_run_stmt
                = "if" "!" "ensure" REF ";" "then"
                  { run_stmt }
                  "fi" ;

if_not_ensure_then_shell_stmt
                = "if" "!" "ensure" REF ";" "then"
                  { shell_stmt }
                  "fi" ;

if_not_ensure_then_stmt
                = "if" "!" "ensure" REF ";" "then"
                  { run_stmt | prompt_stmt | prompt_capture_stmt | shell_stmt
                  | run_capture_stmt | shell_capture_stmt }
                  "fi" ;
  (* mixed then-branch: run, prompt, shell, and their capture forms; ensure/ensure_capture are not allowed in the then-branch. *)

if_not_shell_then_stmt
                = "if" "!" shell_condition ";" "then"
                  { run_stmt | shell_stmt }
                  "fi" ;

shell_condition  = ? any shell expression, e.g. "test -f .file" ? ;

shell_stmt      = command_line ;
```

## Parse and Runtime Semantics

1. **Config block:** The opening line must be exactly `config {` (optional trailing whitespace). At most one config block per file. Inside the block, lines are either `key = value`, `}`, blank, or full-line `#` comments. Allowed keys: `agent.default_model`, `agent.command`, `agent.backend`, `agent.trusted_workspace`, `agent.cursor_flags`, `agent.claude_flags`, `run.logs_dir`, `run.debug`. Value is a quoted string or `true`/`false`. For `agent.backend` the value must be `"cursor"` or `"claude"`.
2. **ensure:** An optional argument tail after the REF is passed through to the shell (e.g. `ensure check_branch "$1"`). With `recover`, the step becomes a retry loop: run the condition; on failure run the recover body; repeat until the condition passes or max retries are reached. Recover is either a single statement (`ensure dep recover run install_deps`) or a block of statements separated by `;` or newline (`ensure dep recover { run a; run b }`).
3. **Rules:** May use forwarded positional parameters as shell args (`$1`, `$2`, `"$@"`) without special declaration. Only `ensure` and shell commands are allowed inside a rule; `run` is not allowed (use `ensure` to call another rule or move the call to a workflow). **Inline brace groups:** A single logical command can span multiple lines when it contains unbalanced `{` … `}`; the parser tracks brace depth so that short-circuit patterns like `cmd || { echo "failed"; exit 1; }` (single-line) and `cmd || { … }` (multi-line) are accepted as one command in rule, workflow, and function bodies.
4. **run:** Inside a workflow, `run` must target a workflow reference (`foo` or `alias.foo`), not an arbitrary shell command. Optional args after the REF are forwarded to the workflow (e.g. `run deploy "$env"`).
5. **Functions:** Top-level `function` blocks define writable shell functions. They are transpiled to namespaced implementations; the original name remains callable via a shim that forwards to the namespaced wrapper.
6. **Conditional steps:** `if ! ensure REF; then ... fi` is parsed as: (a) `if_not_ensure_then_run` when the then-branch contains only `run` steps, (b) `if_not_ensure_then_shell` when only shell commands, (c) `if_not_ensure_then` when mixed (run, prompt, or shell, including capture forms; ensure and ensure_capture are not allowed in the then-branch). `if ! <shell_condition>; then ... fi` is `if_not_shell_then` and may contain `run` and shell steps. The then-branch must contain at least one step.
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
9. **Export:** Rule and workflow declarations may be prefixed with `export` to mark them as part of the module’s public interface. The implementation does not restrict references to exported symbols: any rule or workflow in an imported module can be referenced.

## Validation Rules

After parsing, the compiler validates references and config. Violations produce the following error codes:

- **E_PARSE:** Invalid syntax, duplicate config block, invalid config key/value, invalid prompt content (e.g. command substitution in prompt), or `prompt "..." returns '...'` without a capture variable.
- **E_SCHEMA:** Invalid or unsupported `returns` schema: empty schema, non-flat shape (e.g. arrays or union types), invalid entry (not `fieldName: type`), or unsupported type (only `string`, `number`, `boolean` allowed).
- **E_VALIDATE:** Reference or alias error (unknown rule/workflow, duplicate alias, etc.).
- **E_IMPORT_NOT_FOUND:** The file resolved from an `import` path does not exist.

Rules:

1. At most one `config` block per file; duplicate config yields `E_PARSE`.
2. Config keys must be one of the allowed keys; values must be a quoted string or `true`/`false`. For `agent.backend`, the value must be `"cursor"` or `"claude"`. Invalid key or value type yields `E_PARSE`.
3. Import aliases must be unique within a file (`E_VALIDATE`).
4. Import targets must exist on disk (`E_IMPORT_NOT_FOUND`).
5. Local `ensure foo` requires a local rule `foo`. Imported `ensure alias.foo` requires a rule `foo` in the module bound to `alias` (export is not required).
6. Local `run bar` requires a local workflow `bar`. Imported `run alias.bar` requires a workflow `bar` in the module bound to `alias` (export is not required).

## Transpilation

1. Build emits Bash scripts that source the installed stdlib (`$JAIPH_STDLIB`, default `~/.local/bin/jaiph_stdlib.sh`). The script checks for API compatibility before use.
2. When the module has a `config` block, the generated script exports `JAIPH_AGENT_MODEL`, `JAIPH_AGENT_COMMAND`, `JAIPH_AGENT_BACKEND`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_AGENT_CURSOR_FLAGS`, `JAIPH_AGENT_CLAUDE_FLAGS`, `JAIPH_RUNS_DIR`, and (if `run.debug` is set to `true`) `JAIPH_DEBUG`, using the in-file values as defaults; environment variables override these.
3. **Rules:** Each rule is emitted as `<module>::rule::<name>::impl` (the implementation) and `<module>::rule::<name>` (a wrapper that calls `jaiph::run_step ... jaiph::execute_readonly` with the impl). When config is present, the wrapper is invoked inside a metadata scope that sets the config env vars for the duration of the step.
4. **Workflows:** Each workflow is emitted as `<module>::workflow::<name>::impl` and `<module>::workflow::<name>`, with the wrapper using `jaiph::run_step` and the same metadata-scoping behavior as rules.
5. **Functions:** Each top-level function is emitted as `<module>::function::<name>::impl`, `<module>::function::<name>` (wrapper using `jaiph::run_step_passthrough`), and a shim `<name>` that forwards to the namespaced wrapper so the original name remains callable.
6. **Conditional steps:** Transpiled to explicit Bash `if ! ...; then ... fi`. **Prompt with returns:** When `returns '{ ... }'` is used, the step is emitted as `jaiph::prompt_capture_with_schema`; the stdlib extracts JSON from the agent output (trying multiple strategies: last line, fenced code block, standalone object line, embedded JSON within a line), validates it against the schema, and on success sets the capture variable and exports `name_field` for each field. Exit codes: 0 = success; 1 = JSON parse error; 2 = missing required field; 3 = type mismatch. **ensure … recover:** Transpiled to a bounded retry loop: `for _jaiph_retry in $(seq 1 "${JAIPH_ENSURE_MAX_RETRIES:-10}"); do if <rule>(args); then break; fi; <body>; done`, then if the condition still fails, the script exits with status 1. The recover body may be a single statement or a `{ stmt; ... }` block. Max retries default to 10 and can be overridden via `JAIPH_ENSURE_MAX_RETRIES`. **Assignment capture:** Steps with a capture variable (e.g. `response = ensure foo`, `out = run bar`) are emitted as `VAR=$(...)`; only stdout is captured, and the command’s exit status is preserved (failure exits unless the user adds e.g. `|| true`).
