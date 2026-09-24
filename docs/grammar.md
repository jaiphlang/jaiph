---
title: Grammar
permalink: /reference/grammar
diataxis: reference
redirect_from:
  - /grammar
  - /grammar.md
---

# Grammar

This page is the authoritative syntactic reference for Jaiph: lexical rules, statement shapes, EBNF, and the validator's error catalog. For step semantics see [Language](language.md). For the system around the grammar see [Architecture](architecture.md).

**Scope.** This page covers normal modules (`.jh`) and test modules (`*.test.jh`). A module is a plain text file. At the top level it holds imports, config blocks, channels, top-level `const` values, defs, and scripts, and a test module may also hold `test` blocks. The sections below describe the syntax of each construct, the rules the validator enforces, and the error codes it reports. For how these files are parsed, validated, and run, see [Architecture](architecture.md).

## Lexical rules

| Element | Rule |
|---|---|
| Identifier | `[A-Za-z_][A-Za-z0-9_]*`. |
| Reserved keyword | The words `async`, `catch`, `channel`, `config`, `const`, `def`, `else`, `export`, `fail`, `false`, `for`, `if`, `import`, `in`, `log`, `logerr`, `logwarn`, `match`, `not`, `prompt`, `return`, `returns`, `script`, `send`, `stdin`, `true`, and `use`. A reserved word cannot be a `def` parameter name or a top-level name in the unified namespace (`E_PARSE`). `not` is reserved but has no syntax yet. `run` is **not** reserved — it is an ordinary identifier, so `run()` calls a symbol named `run`. |
| Reference | `IDENT` (local) or `IDENT.IDENT` (module-qualified). |
| Comment | Full-line `#` comment. Trailing `#` on a step line is not a comment. |
| Blank line | Preserved between steps inside def bodies (as `blank_line` trivia). `jaiph format` collapses multiple consecutive body blanks to one and trims trailing blanks before `}`. Top-level blank lines are not preserved — the formatter emits one blank line between emitted sections. |
| Shebang | A `#!` first line of the file is ignored by the parser. |
| Single-line string | Double-quoted `"…"`. Single-quoted strings are `E_PARSE`. Write `\"` to include a quote without ending the string. In orchestration strings the backslash is otherwise passed through verbatim — `\n`, `\t`, and `\\` are **not** decoded to newline/tab/backslash (use a `"""…"""` block or a `script` for literal newlines). Config-block string values are the exception: they decode `\"`, `\\`, `\n`, and `\t`. Match string patterns are a second exception: they decode `\"`, `\n`, and `\\` (but not `\t`). |
| Multiline string | Triple-quoted `"""…"""`. The opening `"""` must end the line; the closing `"""` must be on its own line. |
| Script body (single-line) | Single quotes `'…'`. No escapes: the first `'` closes. A body that needs `'` must use a fenced block. Jaiph `${identifier}` / `${identifier.field}` interpolation is `E_PARSE`; bash parameter expansion (for example `${var:-default}`) passes through. One-line backticks are `E_PARSE`. |
| Script body (fenced) | Triple single quotes `'''`…`'''`. Optional lang tag `'''<tag>`. `${…}` passes through to the shell. Triple backticks are `E_PARSE`. The closer is any trimmed line that starts with `'''` (no tagged closer). |
| Required parentheses | All call sites require parentheses, including zero-argument calls (`setup()`). A name with no `()` is not a call: on a statement line it is `E_PARSE`, and in a value position it is a string reference. |

## File structure

```ebnf
file = { top_level } ;

top_level = config_block
          | import_stmt
          | import_script_stmt
          | channel_decl
          | env_decl
          | script_decl
          | def_decl ;
```

`env_decl` is written `const` in source; the parser stores it under `envDecls` / module constants. Test modules may also contain `test` blocks — see [Write & run tests](testing.md).

### Top-level ordering

| Construct | Formatter behaviour |
|---|---|
| `import`, `config`, `channel` | Hoisted to the top, in that order, preserving relative source order within each group. Comments immediately before a hoisted construct move with it. |
| `const`, `script`, `def`, `test` | Keep their original relative source order. Comments before non-hoisted definitions stay in place. |

### Top-level `const`

```ebnf
env_decl  = "const" IDENT "=" env_value ;
env_value = double_quoted_string | triple_quoted_block | bare_value ;
```

Values: double-quoted string (single-line; multi-line double-quoted is `E_PARSE`), triple-quoted multiline, or a bare token (e.g. `const N = 42` stores the string `"42"`). Top-level `local` is `E_PARSE` — use `const`. Top-level `const` shares the unified per-module namespace with channels, defs, scripts, and script-import aliases.

## Imports and exports

```ebnf
import_stmt        = "import" string "as" IDENT ;
import_script_stmt = "import" "script" string "as" IDENT [ use_clause ] ;
use_clause         = "use" ENV_KEY { ENV_KEY } ;
ENV_KEY            = IDENT ;
```

| Aspect | Rule |
|---|---|
| Module import path | Quoted string. `.jh` extension auto-appended when omitted. Relative resolution against the importing file's directory. |
| Library fallback | When relative resolution finds no file and the path contains `/`, the path is split as `<lib-name>/<sub-path>` and resolved to `<workspace>/.jaiph/libs/<lib-name>/<sub-path>.jh`. |
| Script import path | Quoted string. Relative-only (no library fallback). The path refers to a raw script file (no `.jh` appended). |
| `use` clause | Optional, after the alias. Requests host env keys for this script's spawns, same clause as on a named `script` declaration — identifiers only (no quotes, no `${…}`; invalid names are `E_ENV_INVALID`, reserved keys `E_ENV_RESERVED`, same set as `--env`). A key reaches the subprocess only when granted with `--env KEY[=VALUE]`. `use` is reserved: it cannot be a script name or alias. See [Environment variables](env-vars.md#script-env). |
| Missing target | `E_IMPORT_NOT_FOUND` at compile time. |
| Alias collision | A duplicate module-import alias is `E_VALIDATE`. Script-import aliases (`import script … as name`) join the parse-time unified namespace shared with channels, defs, scripts, and top-level `const`, so a name clash there is `E_PARSE`. See [rule 4](#validation-rules). |
| `export` | Marks a top-level `def` / `script` as public. Same-file code can call any name; across `import`, only names in `mod.exports` are reachable (`E_VALIDATE: "<name>" is not exported from module "<alias>"`). Zero exports means nothing is public. |

## Channels

```ebnf
channel_decl = "channel" IDENT [ "->" REF { "," REF } ] ;
```

One channel per line. A `->` route declaration inside a def body is `E_PARSE`. Routes are stored on `ChannelDef`. Route targets must be defs declaring **1 to 3** named parameters (message, channel, sender). Multiple routes drain sequentially.

## Config blocks

```ebnf
config_block = "config" "{" { config_line } "}" ;
config_line  = config_key "=" config_value ;
config_value = string | identifier | interp_ref | "true" | "false" | integer ;
interp_ref   = "${" IDENT [ "." IDENT ] "}" ;
```

Allowed keys: `agent.model`, `agent.command`, `agent.backend`, `agent.trusted_workspace`, `agent.cursor_flags`, `agent.claude_flags`, `run.logs_dir`, `run.debug`, `run.recover_limit`, `module.name`, `module.version`, and `module.description`. Def-level `config` permits `agent.*` and `run.*` (`runtime.*` / `module.*` are `E_PARSE`). For value forms and per-key meaning see [Configuration](configuration.md#value-syntax); duplicate blocks, unknown keys, and wrong value types are `E_PARSE` (see the [Validation catalog](#validation-catalog)).

## Types

Jaiph has two structurally distinct primitive types:

| Type | Operations |
|---|---|
| `string` | Interpolate (`${…}`), pass as argument, assign to `const`, send to `prompt`. |
| `script` | Invoke with a bare call `name(args)`. Not interpolatable, not assignable to `const` by name, not a valid `prompt` body. |

Crossings (calling a string, `prompt` on a script, `const x = scriptName`, `${scriptName}`) are `E_VALIDATE`; see [Language — Value types](language.md#value-types).

## Definitions

```ebnf
def_decl      = [ "export" ] "def" IDENT "(" [ param_list ] ")" "{" [ def_config ] { def_step } "}" ;
script_decl   = [ "export" ] "script" IDENT [ use_clause ] "=" script_rhs ;
prompt_decl   = [ "export" ] "prompt" IDENT "(" [ param_list ] ")" [ use_clause ] "=" prompt_rhs [ returns_schema ] ;
prompt_rhs    = double_quoted_string | triple_quoted_block ;
param_list    = IDENT { "," IDENT } ;
```

Definition parentheses are required even when parameterless (omitting them is `E_PARSE`); `def` parameter names must be unique, non-reserved identifiers (`E_PARSE`); and a def body may open with a `config { … }` block that precedes the first step. See the [Validation catalog](#validation-catalog) and [Language — Module surface](language.md#module-surface).

Script RHS:

```ebnf
script_rhs           = oneline_script_body | fenced_script_block ;
oneline_script_body  = "'" script_text "'" ;
fenced_script_block  = "'''" [ LANG_TAG ] newline { script_line newline } "'''" ;
LANG_TAG             = IDENT ;
```

The optional `use` clause (`script aaa use GITHUB_TOKEN NPM_TOKEN = …`) sits between the name and `=`: one clause, space-separated env key identifiers. It requests host keys for this script's subprocess; each key must also be granted with `--env KEY[=VALUE]` at run time or `jaiph run` / `serve` / `mcp` refuse to start (`E_ENV_MISSING`). Script env is otherwise sterile — see [Environment variables](env-vars.md#script-env). Invalid key names are `E_ENV_INVALID`; reserved keys are `E_ENV_RESERVED` (same set as `--env`). The identical `use` clause is available on a **named prompt definition** (see below); it is not syntax on defs, plain call sites, `prompt` call sites, or anonymous `prompt` steps.

### Named prompts

A `prompt_decl` binds a reusable, parameterised prompt in the same unified namespace as `script` / `def` / `const` / channels. The `prompt_rhs` uses the same bodies as a `prompt` step — a double-quoted single line or a `"""…"""` block (no script fence). The optional `use` clause (`prompt analyze(log) use GITHUB_TOKEN = …`) sits between the parameter list and `=`, with the same grammar as `use` on a script. For invocation, `returns`, `use` injection, and scope, see [Language — Named prompts](language.md#named-prompts).

The lang tag maps directly to `#!/usr/bin/env <tag>` (e.g. `'''python3` → `#!/usr/bin/env python3`); any identifier tag is accepted with no hardcoded allowlist. Combining a lang tag with a leading `#!` shebang in the body is an error. With neither, the emitter writes `#!/usr/bin/env bash`.

## Call sites

```ebnf
call_ref      = REF "(" [ call_args ] ")" ;
call_args     = call_arg { "," call_arg } ;
call_arg      = double_quoted_string
              | triple_quoted_block               (* multiline literal; must start on its own line *)
              | IDENT                            (* bare identifier: in-scope variable *)
              | IDENT "." IDENT                  (* typed-prompt field access *)
              | call_ref | inline_script ;       (* nested call in argument position: foo(bar()) *)
inline_script = oneline_script_body "(" [ call_args ] ")"
              | fenced_script_block "(" [ call_args ] ")" ;
```

`call_ref` may span multiple source lines when the opening `(` is not closed on the same line.
Each `call_arg` must still be a complete single-line token or a `triple_quoted_block` that
opens `"""` as the first non-whitespace character on its own line. A `triple_quoted_block` arg is
normalised to an inline double-quoted string by the formatter (intentional — `Arg` nodes do not
carry Trivia).

**Hard error contract:** a def-body line whose leading token is a call — an identifier or dotted
ref (or an inline-script body) immediately followed by `(` — is a call start. If the matching `)` is
never found (e.g. the file ends or the block closes first), the compiler emits `E_PARSE` and the
line is **never** silently treated as a def shell step (`sh_line_*`). A leading `run`
(`run name(args)`, `return run name()`) is the removed keyword form and is `E_PARSE`
(`'run' is not a keyword`). A line that is not a statement is `E_PARSE`
(`not a statement; put the command in a script`).

For per-argument rules — bare identifiers, dotted field access, unquoted interpolation, nested calls, arity, and shell redirection — see [Language — Calls](language.md#run-execute-a-def-or-script) and the [Validation catalog](#validation-catalog).

## Def body statements
{: #def-body-statements}

```ebnf
def_step = call_stmt | async_stmt | stdin_connect
              | prompt_stmt | const_decl_step | nested_decl_step | return_stmt
              | fail_stmt | log_stmt | logerr_stmt | logwarn_stmt | send_stmt
              | match_stmt | if_stmt | for_lines_stmt | comment_line ;

nested_decl_step = script_decl | def_decl | prompt_decl ;
```

A line that does not match a statement is `E_PARSE` (`not a statement; put the command in a script`).

### Nested declarations
{: #nested-declarations}

A `nested_decl_step` reuses the module-level `script_decl` / `def_decl` / `prompt_decl` surface inside a def body (nested `const` stays a `const_decl_step`), with one restriction: **no `export`** (`E_PARSE`). For scope, shadowing, in-branch declarations, and the per-form runtime behaviour, see [Language — Nested declarations](language.md#nested-declarations).

### Calls

```ebnf
call_stmt      = ( call_ref | inline_script ) [ recovery ] ;
async_stmt     = "async" call_ref [ recovery ] ;
stdin_connect  = "stdin" stdin_producer "->" stdin_stage { "->" stdin_stage } [ recovery ] ;
stdin_producer = stdin_value | call_ref | inline_script ;
stdin_stage    = call_ref | inline_script ;
stdin_value    = double_quoted_string | IDENT | IDENT "." IDENT | interp_ref ;
recovery       = "catch" catch_bindings catch_body
               | "recover" recover_bindings recover_body ;
```

`async` takes no `stdin` and no inline-script target (both `E_PARSE`). A **pipeline** (a call producer, or two or more `->` stages) takes only `catch`, never `recover`. For target rules and capture, `async` resolution, and the `stdin` connect / pipeline form, see [Language — Calls](language.md#run-execute-a-def-or-script), [`async`](language.md#run-async-concurrent-execution-with-handles), and [Arguments and `stdin`](language.md#arguments-and-stdin).

### `catch` / `recover`

```ebnf
catch_bindings   = "(" IDENT ")" ;
catch_body       = def_step | "{" { def_step } "}" ;
recover_bindings = "(" IDENT ")" ;
recover_body     = def_step | "{" { def_step } "}" ;
```

For the recovery-body binding, the retry loop, mutual exclusion, and where `catch` / `recover` may attach, see [Language — `catch` and `recover`](language.md#catch-and-recover).

### `prompt`

```ebnf
prompt_stmt    = "prompt" ( prompt_body | prompt_call ) [ returns_schema ] ;
prompt_body    = double_quoted_string | IDENT | "${" IDENT [ "." IDENT ] "}" | triple_quoted_block ;
prompt_call    = REF "(" [ call_args ] ")" ;
returns_schema = "returns" double_quoted_string ;
```

For body forms, `returns` schemas, the capture requirement, and named-prompt invocation, see [Language — `prompt`](language.md#prompt-agent-interaction) and [Named prompts](language.md#named-prompts).

### `const`

```ebnf
const_decl_step = "const" IDENT "=" const_rhs ;
const_rhs       = double_quoted_string | triple_quoted_block | bash_value_expr
                | call_ref | inline_script | "async" call_ref
                | "stdin" stdin_producer "->" stdin_stage { "->" stdin_stage }
                | "prompt" ( prompt_body | prompt_call ) [ returns_schema ]
                | "match" IDENT "{" { match_arm } "}" ;
```

For the RHS forms and the immutable-binding rules, see [Language — `const`](language.md#const-bind-a-value).

### `return`

```ebnf
return_stmt  = "return" return_value ;
return_value = double_quoted_string | triple_quoted_block | "$" IDENT | "${" IDENT "}" | IDENT
             | call_ref | inline_script
             | "prompt" ( prompt_body | prompt_call ) [ returns_schema ]
             | "match" IDENT "{" { match_arm } "}" ;
```

For the return forms and their desugaring, see [Language — `return`](language.md#return-managed-return-value).

### `send`

```ebnf
send_stmt = "send" send_rhs "->" (IDENT | IDENT "." IDENT) ;
send_rhs  = double_quoted_string | triple_quoted_block | "$" IDENT | "${" … "}"
          | call_ref | shell_fragment ;
```

For payload forms and dispatch, see [Language — `send`](language.md#send-channel-message).

### `log` / `logerr` / `logwarn`

```ebnf
log_stmt     = "log" ( double_quoted_string | triple_quoted_block | IDENT | "${" IDENT [ "." IDENT ] "}" | inline_script ) ;
logerr_stmt  = "logerr" ( double_quoted_string | triple_quoted_block | IDENT | "${" IDENT [ "." IDENT ] "}" | inline_script ) ;
logwarn_stmt = "logwarn" ( double_quoted_string | triple_quoted_block | IDENT | "${" IDENT [ "." IDENT ] "}" | inline_script ) ;
```

For the bare-identifier and inline-script forms, see [Language — `log` / `logerr` / `logwarn` / `fail`](language.md#log-logerr-logwarn-fail).

### `fail`

```ebnf
fail_stmt = "fail" ( double_quoted_string | triple_quoted_block | "${" IDENT [ "." IDENT ] "}" ) ;
```

For `fail`'s abort behaviour, see [Language — `log` / `logerr` / `logwarn` / `fail`](language.md#log-logerr-logwarn-fail).

### `if`

```ebnf
if_stmt        = "if" subject_ref if_op if_operand "{" { def_step } "}"
                 { else_if_clause } [ else_clause ] ;
else_if_clause = "}" "else" "if" subject_ref if_op if_operand "{" { def_step } ;
else_clause    = "else" "{" { def_step } "}" ;
subject_ref    = IDENT | IDENT "." IDENT ;
if_op          = "==" | "!=" | "=~" | "!~" ;
if_operand     = double_quoted_string | "/" regex_source "/" ;
```

For operator/operand pairing, `else` / `else if` desugaring, and value semantics, see [Language — `if`](language.md#if-conditional-guard).

### `match`

```ebnf
match_stmt      = "match" subject_ref "{" match_arms "}" ;
match_arms      = match_arm { NEWLINE match_arm } | match_arm { "," match_arm } ;
match_arm       = match_pattern "=>" arm_body ;
match_pattern   = match_alternand { "|" match_alternand } | "_" ;
match_alternand = double_quoted_string | "/" regex_source "/" ;
arm_body      = double_quoted_string | triple_quoted_block
              | IDENT
              | "$" IDENT | "${" IDENT "}"
              | "fail" double_quoted_string
              | call_ref ;
```

For subject rules, alternation, arm delimiters, arm bodies, and the expression form, see [Language — `match`](language.md#match-pattern-match).

### `for`

```ebnf
for_lines_stmt = "for" IDENT "in" IDENT "{" { def_step } "}" ;
```

For source-variable rules, line splitting, and iterator scope, see [Language — `for`](language.md#for-iterate-lines-of-a-string).

## Inline scripts

```ebnf
inline_script = oneline_script_body "(" [ call_args ] ")"
              | fenced_script_block "(" [ call_args ] ")" ;
```

For allowed positions, interpolation, `catch` / `recover` attachment, and the emitted name, see [Language — Inline scripts](language.md#inline-scripts).

## String interpolation

For the accepted interpolation forms and where each is valid, see [Language — String interpolation](language.md#string-interpolation).

## Step output contract

For the per-step status, capture value, and logs, see [Language — Step output contract](language.md#step-output-contract).

## Validation catalog

Validator entry points (`src/transpile/validate.ts` for the outer layer; `src/transpile/validate-step.ts` for the per-step visitor). The `jaiph compile` command surfaces all of these via `collectDiagnostics`.

| Code | Triggers |
|---|---|
| `E_PARSE` | Duplicate config; duplicate top-level names in the unified namespace; invalid keys/values; `$(…)` in orchestration strings; Jaiph `${identifier}` interpolation in one-line script bodies; `prompt … returns` without `const` capture; `name = prompt …` / non-`const` capture; leading `run` (removed keyword — `run name()`, `return run name()`, `const x = run name()`); assignment without `const`; top-level `local`; invalid send RHS; trailing shell redirection after a call; arguments after `catch` / `recover`; bare `catch` / `recover` without binding; nested inline captures; removed `wait` keyword; invalid parameter names; missing `{` on definition line. |
| `E_SCHEMA` | Invalid `returns` schema — empty, non-flat, unsupported type. |
| `E_VALIDATE` | Unknown def / script; duplicate import alias; forbidden Jaiph usage inside `$(…)`; dot notation on non-prompt variable or invalid field name; bare identifier argument referencing an unknown variable; unquoted `${…}` in call-argument position; `${ident}` referencing an unknown variable in orchestration strings; arity mismatch; shell redirection (`>`, `>>`, `|`, `&`) inside unquoted call-argument text; `stdin` connect targeting a non-script; type crossings (`prompt` on a script, calling a string, `const x = scriptName`, `${scriptName}`). |
| `E_IMPORT_NOT_FOUND` | Import target does not exist (module or script). |

### Validation rules

1. At most one `config` block per file and per def. Def `config` must precede steps. Def `config` allows only `agent.*` / `run.*`.
2. Config values are type-checked. `agent.backend` must be `cursor`, `claude`, or `codex`.
3. Import aliases must be unique. Import targets must exist.
4. Unified per-module namespace: channels, defs, scripts, script-import aliases, and top-level `const` share one namespace. Duplicate top-level names fail at parse time (`E_PARSE`); duplicate import aliases fail in validation (`E_VALIDATE`).
5. A call targets a def or a script. The same rules apply to `return ref()` and `${ref()}`. `recover` is legal on every call.
6. Channel references in `send` must resolve to declared channels. Route targets must be defs with 1 to 3 parameters (message, channel, sender). Inline routes in def bodies are `E_PARSE`.
7. `catch` / `recover` argument ordering — all call args appear before `catch` / `recover`.
8. Shell redirection (`>`, `>>`, `|`, `&`) on a call is rejected — trailing operators are `E_PARSE`; operators in unquoted call-argument text are `E_VALIDATE`.
9. Type crossings produce specific `E_VALIDATE` messages (see [Types](#types)).
10. Nested calls appear bare in argument position (`foo(bar())`); there is no `run` keyword.
11. `for iter in source` — `source` must name an in-scope variable.

## Build artifacts

`jaiph run` and `jaiph test` do not transpile defs to shell. `buildScripts` emits only per-`script` executable files under `scripts/`:

| Source form | Emitted artifact |
|---|---|
| `script name = '…'` (single-line) | `scripts/<name>` with `#!/usr/bin/env bash` (or the fence-tag / manual shebang). |
| `script name = '''<tag>…'''` (fenced) | `scripts/<name>` with `#!/usr/bin/env <tag>` or the manual `#!` line. |
| `` 'body'(args) `` / `'''lang body'''(args)` | `scripts/__inline_<12-hex>` with the deterministic name from `inlineScriptName`. |
| `script name = …` **nested inside a def** | `scripts/__nested_<12-hex>` with the deterministic name from `nestedScriptName` (hash of name, lang tag, `use` keys, and body). Same interpreter/shebang path as a top-level script; the OS exec bit is not required. |
| `import script "path" as name` | Copied verbatim to `scripts/<name>` with its original shebang preserved; the runtime resolves it through `JAIPH_SCRIPTS` like any other script. |

Defs, prompts, channels, and control flow are interpreted by `NodeWorkflowRuntime` from the AST. There is no def-level shell emission. Script subprocesses inherit the runner's `process.env` plus Jaiph metadata.

## Related

- [Language](language.md) — step semantics and runtime behaviour.
- [CLI — `jaiph format`](cli.md#jaiph-format) — formatter rules and idempotence.
- [Configuration](configuration.md) — config-key semantics referenced by the grammar.
