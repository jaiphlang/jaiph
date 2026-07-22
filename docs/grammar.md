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

**Scope.** Normal modules (`.jh`) and test modules (`*.test.jh`). For `jaiph run` / `jaiph test`, the compile path is `loadModuleGraph` → `buildScriptsFromGraph(graph, outDir)` (per-module `validateModule` + script emit via `emitScriptsForModuleFromGraph`). `jaiph compile` walks the same import closure through `collectDiagnostics(graph)` and emits no scripts. `parsejaiph(source, filePath)` is I/O-pure. `buildRuntimeGraph` consumes an already-loaded graph and never re-runs validation or re-reads `.jh` sources.

## Lexical rules

| Element | Rule |
|---|---|
| Identifier | `[A-Za-z_][A-Za-z0-9_]*`. |
| Reference | `IDENT` (local) or `IDENT.IDENT` (module-qualified). |
| Comment | Full-line `#` comment. Trailing `#` on a step line is not a comment. |
| Blank line | Preserved between steps inside workflow and rule bodies (as `blank_line` trivia). `jaiph format` collapses multiple consecutive body blanks to one and trims trailing blanks before `}`. Top-level blank lines are not preserved — the formatter emits one blank line between emitted sections. |
| Shebang | A `#!` first line of the file is ignored by the parser. |
| Single-line string | Double-quoted `"…"`. Single-quoted strings are `E_PARSE`. Write `\"` to include a quote without ending the string. In orchestration strings the backslash is otherwise passed through verbatim — `\n`, `\t`, and `\\` are **not** decoded to newline/tab/backslash (use a `"""…"""` block or a `script` for literal newlines). Config-block string values are the exception: they decode `\"`, `\\`, `\n`, and `\t`. |
| Multiline string | Triple-quoted `"""…"""`. The opening `"""` must end the line; the closing `"""` must be on its own line. |
| Script body (single-line) | Backtick `` `…` ``. Jaiph `${identifier}` / `${identifier.field}` interpolation is `E_PARSE`; bash parameter expansion (for example `${var:-default}`) passes through. |
| Script body (fenced) | Triple-backtick `` ``` ``…`` ``` ``. Optional lang tag `` ```<tag> ``. `${…}` passes through to the shell. |
| Required parentheses | All `run` / `ensure` call sites require parentheses, including zero-argument calls. Bare `run setup` is `E_PARSE`. |

## File structure

```ebnf
file = { top_level } ;

top_level = config_block
          | import_stmt
          | import_script_stmt
          | channel_decl
          | env_decl
          | rule_decl
          | script_decl
          | workflow_decl ;
```

`env_decl` is written `const` in source; the parser stores it under `envDecls` / module constants. Test modules may also contain `test` blocks — see [Write & run tests](/how-to/testing).

### Top-level ordering

| Construct | Formatter behaviour |
|---|---|
| `import`, `config`, `channel` | Hoisted to the top, in that order, preserving relative source order within each group. Comments immediately before a hoisted construct move with it. |
| `const`, `rule`, `script`, `workflow`, `test` | Keep their original relative source order. Comments before non-hoisted definitions stay in place. |

### Top-level `const`

```ebnf
env_decl  = "const" IDENT "=" env_value ;
env_value = double_quoted_string | triple_quoted_block | bare_value ;
```

Values: double-quoted string (single-line; multi-line double-quoted is `E_PARSE`), triple-quoted multiline, or a bare token (e.g. `const N = 42` stores the string `"42"`). Top-level `local` is `E_PARSE` — use `const`. Top-level `const` shares the unified per-module namespace with channels, rules, workflows, and scripts.

## Imports and exports

```ebnf
import_stmt        = "import" string "as" IDENT ;
import_script_stmt = "import" "script" string "as" IDENT ;
```

| Aspect | Rule |
|---|---|
| Module import path | Quoted string. `.jh` extension auto-appended when omitted. Relative resolution against the importing file's directory. |
| Library fallback | When relative resolution finds no file and the path contains `/`, the path is split as `<lib-name>/<sub-path>` and resolved to `<workspace>/.jaiph/libs/<lib-name>/<sub-path>.jh`. |
| Script import path | Quoted string. Relative-only (no library fallback). The path refers to a raw script file (no `.jh` appended). |
| Missing target | `E_IMPORT_NOT_FOUND` at compile time. |
| Alias collision | Aliases share the unified namespace with channels, rules, workflows, scripts, and top-level `const`. Duplicates are `E_VALIDATE`. |
| `export` | Marks a top-level `rule` / `workflow` / `script` as public. If at least one `export` exists, only exported names are reachable through the alias (`E_VALIDATE: "<name>" is not exported from module "<alias>"`). Modules with zero `export` declarations have implicit-public semantics. |

## Channels

```ebnf
channel_decl = "channel" IDENT [ "->" REF { "," REF } ] ;
```

One channel per line. A `->` route declaration inside a workflow body is `E_PARSE`. Routes are stored on `ChannelDef`. Route targets must be workflows declaring exactly **three** named parameters (message, channel, sender). Multiple routes drain sequentially.

## Config blocks

```ebnf
config_block = "config" "{" { config_line } "}" ;
config_line  = config_key "=" config_value ;
config_value = string | identifier | interp_ref | "true" | "false" | integer ;
interp_ref   = "${" IDENT [ "." IDENT ] "}" ;
```

All three string forms are equivalent: a bare `identifier`, a bare `${name}` interpolation ref, and a double-quoted string `"${name}"` all store and resolve identically. Shell expansion forms (`${var:-default}`, `${#var}`, etc.) are `E_PARSE`. See [Configuration](configuration.md#value-syntax).

Allowed keys: `agent.model`, `agent.command`, `agent.backend`, `agent.trusted_workspace`, `agent.cursor_flags`, `agent.claude_flags`, `run.logs_dir`, `run.debug`, `run.recover_limit`, `runtime.docker_image`, `runtime.docker_network`, `runtime.docker_timeout_seconds`, `module.name`, `module.version`, `module.description`. See [Configuration](configuration.md). Workflow-level `config` permits only `agent.*` and `run.*` (`runtime.*` / `module.*` are `E_PARSE`).

The opening line is `config` followed by `{` with optional whitespace between them. Duplicate blocks are `E_PARSE` (`duplicate config block …`). Unknown keys are `E_PARSE` listing the allowed keys. Wrong value types are `E_PARSE`.

## Types

Jaiph has two structurally distinct primitive types:

| Type | Operations |
|---|---|
| `string` | Interpolate (`${…}`), pass as argument, assign to `const`, send to `prompt`. |
| `script` | Invoke with `run`. Not interpolatable, not assignable to `const` by name, not a valid `prompt` body. |

Crossings (`run` on a string, `prompt` on a script, `const x = scriptName`, `${scriptName}`) are `E_VALIDATE` with the specific message.

## Definitions

```ebnf
rule_decl     = [ "export" ] "rule" IDENT "(" [ param_list ] ")" "{" { rule_body_step } "}" ;
script_decl   = "script" IDENT "=" script_rhs ;
workflow_decl = [ "export" ] "workflow" IDENT "(" [ param_list ] ")" "{" [ workflow_config ] { workflow_step } "}" ;
param_list    = IDENT { "," IDENT } ;
```

| Aspect | Rule |
|---|---|
| Definition parens | Required even when parameterless (e.g. `rule check()`, `workflow default()`). Omitting them is `E_PARSE` with a fix hint. |
| Parameter names | Identifier syntax, no duplicates, no reserved keywords. |
| Workflow body | May begin with an optional nested `config { … }` (must precede the first step). |

Script RHS:

```ebnf
script_rhs           = backtick_script_body | fenced_script_block ;
backtick_script_body = "`" script_text "`" ;
fenced_script_block  = "```" [ LANG_TAG ] newline { script_line newline } "```" ;
LANG_TAG             = IDENT ;
```

The lang tag maps directly to `#!/usr/bin/env <tag>`. Combining a lang tag with a leading `#!` shebang in the body is an error. With neither, the emitter writes `#!/usr/bin/env bash`.

| Fence tag | Resulting shebang |
|---|---|
| `` ```bash `` | `#!/usr/bin/env bash` |
| `` ```node `` | `#!/usr/bin/env node` |
| `` ```python3 `` | `#!/usr/bin/env python3` |
| `` ```ruby `` | `#!/usr/bin/env ruby` |
| `` ```perl `` | `#!/usr/bin/env perl` |
| `` ```pwsh `` | `#!/usr/bin/env pwsh` |
| `` ```deno `` | `#!/usr/bin/env deno` |
| `` ```lua `` | `#!/usr/bin/env lua` |

Any identifier tag is accepted; there is no hardcoded allowlist.

## Call sites

```ebnf
call_ref      = REF "(" [ call_args ] ")" ;
call_args     = call_arg { "," call_arg } ;
call_arg      = double_quoted_string
              | triple_quoted_block               (* multiline literal; must start on its own line *)
              | IDENT                            (* bare identifier: in-scope variable *)
              | IDENT "." IDENT                  (* typed-prompt field access *)
              | "run" ( call_ref | inline_script )   (* explicit nested managed call *)
              | "ensure" call_ref ;
inline_script = backtick_script_body "(" [ call_args ] ")"
              | fenced_script_block "(" [ call_args ] ")" ;
```

`call_ref` may span multiple source lines when the opening `(` is not closed on the same line.
Each `call_arg` must still be a complete single-line token or a `triple_quoted_block` that
opens `"""` as the first non-whitespace character on its own line. A `triple_quoted_block` arg is
normalised to an inline double-quoted string by the formatter (intentional — `Arg` nodes do not
carry Trivia).

**Hard error contract:** any line that begins with `run`/`ensure`/`return run`/`return ensure`
followed by a valid identifier and `(` is treated as a managed call start. If the matching `)` is
never found (e.g. the file ends or the block closes first), the compiler emits `E_PARSE` and the
line is **never** silently treated as a workflow shell step (`sh_line_*`).
Intentionally free-form shell lines that are not prefixed with a managed-call keyword continue to
fall through to the shell executor unchanged.

| Position | Rule |
|---|---|
| Triple-quoted block argument | `"""…"""` must open as the first non-whitespace token on its own line (same rule as every other triple-quoted position). The body is dedented to the common leading margin. The formatter normalises triple-quoted call args to an inline double-quoted string (intentional — `Arg` nodes do not carry Trivia for round-trip preservation). |
| Bare identifier argument | Must reference an in-scope binding (`const`, capture, parameter). `name` and `"${name}"` (quoted string) are both accepted when the variable is in scope. Unknown names are `E_VALIDATE`. Jaiph keywords are rejected. |
| Bare dotted argument | `IDENT.IDENT` is typed-prompt field access (same as in `return` / `if` / `match`). The base must be a typed prompt capture and the field must appear in its `returns` schema (`E_VALIDATE` otherwise). |
| Unquoted interpolation | Unquoted `${ident}` / `${base.field}` in call-argument position is `E_VALIDATE` — interpolation belongs inside strings. Use the bare form (`name`, `result.role`) or a quoted string (`"${name}"`). |
| Nested managed calls | The `run` / `ensure` keyword is required. `run foo(bar())` / `run foo(rule_bar())` / `run foo(\`echo aaa\`())` are `E_VALIDATE`. Valid: `run foo(run bar())`, `run foo(ensure rule_bar())`, `run foo(run \`echo aaa\`())`. Capture-then-pass is always valid. |
| Arity | Workflows and rules: argument count must match the declared parameter list (`E_VALIDATE`), including `()` callees (zero arguments required). Scripts accept any argument count (no parameter list to check). |
| Shell redirection / pipes | Trailing `>`, `>>`, `|`, or `&` after a `run` / `ensure` call is `E_PARSE`. The same operators inside unquoted portions of call arguments are `E_VALIDATE`. Use a `script` for shell I/O. |

## Workflow body statements

```ebnf
workflow_step = ensure_stmt | run_stmt | run_catch_stmt | run_recover_stmt | run_async_stmt
              | prompt_stmt | const_decl_step | return_stmt
              | fail_stmt | log_stmt | logerr_stmt | logwarn_stmt | send_stmt
              | match_stmt | if_stmt | for_lines_stmt | comment_line ;
```

Any line that does not match a managed form becomes a **shell** step in workflows. Rules forbid raw shell — the validator's `RULE_SCOPE` rejects unrecognised shell lines with `inline shell steps are forbidden in rules; use explicit script blocks`.

### `run`

```ebnf
run_stmt         = "run" ( call_ref | inline_script ) ;
run_catch_stmt   = "run" ( call_ref | inline_script ) "catch" catch_bindings catch_body ;
run_recover_stmt = "run" ( call_ref | inline_script ) "recover" recover_bindings recover_body ;
run_async_stmt   = "run" "async" call_ref [ recover_suffix | catch_suffix ] ;
```

| Position | Allowed targets |
|---|---|
| `run` in workflow | Workflow or script. |
| `run` in rule | Script only. Workflows are `E_VALIDATE`. |
| `run async` | Workflows only. Inline scripts not supported. |
| Inline script in `run` | Both workflows and rules. |

Capture: a workflow callee yields the explicit `return` value; a script callee yields trimmed stdout.

### `ensure`

```ebnf
ensure_stmt = "ensure" call_ref [ "catch" catch_bindings catch_body ] ;
```

Targets a rule. Succeeds when the rule's exit code is `0`. `recover` is not supported on `ensure`.

### `catch` / `recover`

```ebnf
catch_bindings   = "(" IDENT ")" ;
catch_body       = workflow_step | "{" { workflow_step } "}" ;
recover_bindings = "(" IDENT ")" ;
recover_body     = workflow_step | "{" { workflow_step } "}" ;
```

| Rule | Behaviour |
|---|---|
| Exactly one binding | Required. Bare `catch` / `recover` is `E_PARSE`. |
| Argument placement | All call arguments appear inside `()` before `catch` / `recover`. |
| Body content | Parsed by the same `parseBlockStatement` that handles top-level statements; rule scope still rejects shell. |
| Mutual exclusion | `catch` and `recover` are mutually exclusive on the same `run` step. |
| Inline-script attachment | `catch` / `recover` only attach to a standalone `run` step. Inline scripts in `log` / `logerr` / `logwarn` / `return` / `const` RHS do not accept them. |

### `prompt`

```ebnf
prompt_stmt    = "prompt" prompt_body [ returns_schema ] ;
prompt_body    = double_quoted_string | IDENT | "${" IDENT [ "." IDENT ] "}" | triple_quoted_block ;
returns_schema = "returns" double_quoted_string ;
```

| Aspect | Rule |
|---|---|
| Body forms | Single-line string, in-scope identifier (bare `name` or `${name}` / `${name.field}`), or triple-quoted block. Triple-backtick fences in prompt context are `E_PARSE`. |
| Multiline form | Opening `"""` must end the line; closing `"""` must be on its own line. |
| `returns` placement | After a single-line or identifier body on the same line, or on the line after the closing `"""`, or on the same line as the closing `"""` (nothing else may follow). |
| `returns` schema | Flat `{ field: type, … }` with types `string`, `number`, `boolean`. Invalid schemas are `E_SCHEMA`. |
| Capture requirement | `prompt … returns` without `const` capture is `E_PARSE`. |
| Allowed in | Workflows only. Rules reject `prompt` and `const … = prompt`. |

### `const`

```ebnf
const_decl_step = "const" IDENT "=" const_rhs ;
const_rhs       = double_quoted_string | triple_quoted_block | bash_value_expr
                | "run" ( call_ref | inline_script ) | "run" "async" call_ref
                | "ensure" call_ref
                | "prompt" prompt_body [ returns_schema ]
                | "match" IDENT "{" { match_arm } "}" ;
```

| Position | Rule |
|---|---|
| Bare RHS | `const x = ref(args)` is `E_PARSE`. Use `const x = run ref(args)`, `const x = ensure ref(args)`, or `const x = prompt …`. |
| Assignment without `const` | `name = run …` / `name = prompt …` are `E_PARSE`. |
| Forbidden expansions on RHS | `$(…)`, `${var:-fallback}`, `${var%%…}`, `${var//…}`, `${#var}` are `E_PARSE`. |

### `return`

```ebnf
return_stmt  = "return" return_value ;
return_value = double_quoted_string | triple_quoted_block | "$" IDENT | "${" IDENT "}"
             | IDENT
             | "run" ( call_ref | inline_script )
             | "ensure" call_ref
             | "match" IDENT "{" { match_arm } "}" ;
```

`return run helper` (no `()`) becomes a shell `return` step — required to write `return run helper()` / `return ensure check()` for the managed form. Bare identifiers desugar to `return "${ident}"`. Inline-script form requires the `run` keyword (`return run \`echo $1\`("arg")`). Numeric exit codes (`return 0`, `return $?`) are rejected in workflow/rule bodies; use them only in opaque `script` definition bodies.

### `send`

```ebnf
send_stmt = IDENT "<-" send_rhs ;
send_rhs  = double_quoted_string | triple_quoted_block | "$" IDENT | "${" … "}"
          | "run" call_ref
          | shell_fragment ;
```

| Rule | Behaviour |
|---|---|
| RHS required | Bare `channel <-` is `E_PARSE`. |
| Shell fragment RHS | A raw shell expression (for example `findings <- echo "$payload"`) parses as a managed shell payload; allowed only on `send` (`E_VALIDATE` elsewhere). |
| Bare ref RHS | A bare `ref`-shaped word that names a workflow / rule / script is `E_VALIDATE`. Use `run ref()` or a string. |
| `run` without `()` | Does not parse as a managed send RHS. |
| Allowed in | Workflows only. Rules forbid `send`. |

### `log` / `logerr` / `logwarn`

```ebnf
log_stmt     = "log" ( double_quoted_string | triple_quoted_block | IDENT | "${" IDENT [ "." IDENT ] "}" | "run" inline_script ) ;
logerr_stmt  = "logerr" ( double_quoted_string | triple_quoted_block | IDENT | "${" IDENT [ "." IDENT ] "}" | "run" inline_script ) ;
logwarn_stmt = "logwarn" ( double_quoted_string | triple_quoted_block | IDENT | "${" IDENT [ "." IDENT ] "}" | "run" inline_script ) ;
```

Bare identifier form expands to `"${ident}"`. `log run \`…\`(args)`, `logerr run \`…\`(args)`, and `logwarn run \`…\`(args)` execute the inline script and log its stdout — the `run` keyword is required (bare inline scripts in `log` / `logerr` / `logwarn` are `E_PARSE`).

### `fail`

```ebnf
fail_stmt = "fail" ( double_quoted_string | triple_quoted_block | "${" IDENT [ "." IDENT ] "}" ) ;
```

Aborts the workflow or rule with a stderr message and non-zero exit.

### `if`

```ebnf
if_stmt        = "if" subject_ref if_op if_operand "{" { workflow_step } "}"
                 { else_if_clause } [ else_clause ] ;
else_if_clause = "}" "else" "if" subject_ref if_op if_operand "{" { workflow_step } ;
else_clause    = "else" "{" { workflow_step } "}" ;
subject_ref    = IDENT | IDENT "." IDENT ;
if_op          = "==" | "!=" | "=~" | "!~" ;
if_operand     = double_quoted_string | "/" regex_source "/" ;
```

`else if` is sugar: `if A { … } else if B { … } else { … }` desugars at parse time to `if A { … } else { if B { … } else { … } }`, so the AST and runtime paths are the nested `if`/`else` tree. Chains nest to any depth.

| Rule | Behaviour |
|---|---|
| Subject | Bare identifier or `IDENT.IDENT` (typed-prompt field access). Async handles resolve before the test. |
| Operator/operand pairing | `==` / `!=` require a double-quoted string. `=~` / `!~` require a `/regex/`. Mixing is `E_PARSE`. |
| `else` / `else if` placement | `} else {` and each `} else if <cond> {` must be on a single line — the closing `}` and the keyword share the line. An `else if` split onto its own line, an `else if` without a condition, or an empty `else if` body is `E_PARSE`. |
| Value production | `if` is a statement and does not produce a value. Use `match` for value branching. |
| Allowed in | Workflows and rules. |

### `match`

```ebnf
match_stmt      = "match" subject_ref "{" { match_arm } "}" ;
match_arm       = match_pattern "=>" arm_body NEWLINE ;
match_pattern   = match_alternand { "|" match_alternand } | "_" ;
match_alternand = double_quoted_string | "/" regex_source "/" ;
arm_body      = double_quoted_string | triple_quoted_block
              | IDENT
              | "$" IDENT | "${" IDENT "}"
              | "fail" double_quoted_string
              | "run" call_ref
              | "ensure" call_ref ;
```

| Rule | Behaviour |
|---|---|
| Subject | Bare identifier or `IDENT.IDENT`. Subject starting with `$` / `${}` is `E_PARSE`. |
| Default arm | Exactly one `_` wildcard arm is required. |
| Alternation | `"a" \| "b" \| /^c/ => body` — pipe-separated string literals and/or regexes on one arm. The arm matches if **any** alternand matches (OR); arm order still decides ties. String and regex alternands may be mixed. `_` cannot participate (`_ \| "x"` / `"x" \| _` are `E_PARSE`); a trailing `\|` before `=>` is `E_PARSE`. |
| Arm delimiter | Newlines. Commas between or after arms are `E_PARSE` (`commas are not allowed in match arms; use one arm per line`). |
| Disallowed in arms | `return` (use `return match … { … }` at the outer level), inline scripts (use a named script with `run`), bare unknown identifiers (`E_VALIDATE: unknown identifier "…" in match arm body`). |
| Expression form | Usable as `const x = match …` or `return match …`. |

### `for`

```ebnf
for_lines_stmt = "for" IDENT "in" IDENT "{" { workflow_step } "}" ;
```

| Rule | Behaviour |
|---|---|
| Source variable | Must already hold a string (`const`, capture, parameter). Unknown names are `E_VALIDATE`. |
| Line splitting | Splits on `\n` (normalises `\r\n` → `\n`). If the string ends with a final newline, the trailing empty segment is dropped. Interior empty lines are still yielded. |
| Iterator name | Subject to the same immutable-binding rules as `const` in the surrounding scope. |
| Allowed in | Workflows and rules. |

## Inline scripts

```ebnf
inline_script = backtick_script_body "(" [ call_args ] ")"
              | fenced_script_block "(" [ call_args ] ")" ;
```

| Aspect | Rule |
|---|---|
| Allowed positions | `run_stmt` / `run_catch_stmt` / `run_recover_stmt` / `log_stmt` / `logerr_stmt` / `logwarn_stmt` / `return_stmt`, and `const` RHS. |
| `run async` | Not supported with inline scripts. |
| Backtick interpolation | Jaiph `${identifier}` / `${identifier.field}` forms are `E_PARSE`. Bash parameter expansion passes through. Use `$1`, `$2`, … for positional arguments. |
| Fenced interpolation | All `${…}` passes through to the shell (standard parameter expansion). |
| `catch` / `recover` suffix | Allowed only on standalone `run` steps with inline-script body. Forbidden in `log` / `logerr` / `logwarn` / `return` / `const` RHS positions. |
| Emitted name | `scripts/__inline_<hash>` where `<hash>` is the first 12 hex digits of `sha256(shebang + "\n" + body)` (or `sha256(body)` if no shebang). Deterministic across runs. |

## String interpolation

`${IDENT}` is the only interpolation form accepted in Jaiph orchestration strings. Every identifier must reference a `const`, capture, or named parameter.

| Form | Status | Where |
|---|---|---|
| `${varName}` | Primary | All orchestration strings. |
| `${var.field}` | Typed-prompt field access | All orchestration strings. The base must be a `const x = prompt … returns "{ field: type, … }"` capture and the field must appear in the schema. |
| `${run ref(args)}` | Inline capture — executes the call, inlines stdout / return value. | All orchestration strings. |
| `${ensure ref(args)}` | Inline capture — executes the rule, inlines result. | All orchestration strings. |
| `$varName` (no braces) | `E_PARSE` in orchestration strings. | — |
| `$1`, `$2` | Positional args | `script` bodies only. |
| `${var:-fallback}` (and `:+` / `:=` / `:?`) | `E_PARSE` in orchestration strings; passes through in script bodies (backtick and fenced). | — |
| `${var%%…}` / `${var//…}` / `${#var}` | Rejected (`E_PARSE`) only on a bare `const` RHS (see [`const`](#const)); inside orchestration string literals they are **not** flagged and pass through verbatim. Passes through in script bodies. | — |
| `$(…)` | `E_PARSE` in orchestration strings. | — |

If an inline capture fails, the enclosing step fails. Nested inline captures (`${run foo(${run bar()})}`) are rejected — extract the inner call to a `const`.

## Step output contract

Every step produces three distinct outputs — status, capture value, and logs.

| Step | Status | Capture value | Logs |
|---|---|---|---|
| `ensure rule` | rule exit code | explicit `return` value | rule artifacts |
| `run workflow` | workflow exit code | explicit `return` value | workflow artifacts |
| `run script` (named) | script exit code | trimmed stdout | script `.out` / `.err` |
| `` run `…`() `` (inline) | script exit code | trimmed stdout | script `.out` / `.err` |
| `prompt` | prompt exit code | final assistant answer | transcript artifacts |
| `log` | always 0 | empty | live event stream + stdout |
| `logerr` / `logwarn` | always 0 | empty | live event stream + stderr |
| `fail` | non-zero (abort) | empty | message to stderr |
| `run async` | aggregated | `Handle<T>` — resolves to return value on read | async step artifacts |
| `const` | same as RHS step | empty (binds local) | n/a |

## Validation catalog

Validator entry points (`src/transpile/validate.ts` for the outer layer; `src/transpile/validate-step.ts` for the per-step visitor). The `jaiph compile` command surfaces all of these via `collectDiagnostics`.

| Code | Triggers |
|---|---|
| `E_PARSE` | Duplicate config; duplicate top-level names in the unified namespace; invalid keys/values; `$(…)` in orchestration strings; Jaiph `${identifier}` interpolation in single-line backtick script bodies; `prompt … returns` without `const` capture; `name = prompt …` / non-`const` capture; bare `ref(args)` on `const` RHS (use `run` / `ensure` / `prompt`); top-level `local`; invalid send RHS; trailing shell redirection after `run` / `ensure`; arguments after `catch` / `recover`; bare `catch` / `recover` without binding; nested inline captures; removed `wait` keyword; invalid parameter names; missing `{` on definition line. |
| `E_SCHEMA` | Invalid `returns` schema — empty, non-flat, unsupported type. |
| `E_VALIDATE` | Unknown rule / workflow / script; duplicate import alias; inline shell in rules; `ensure` on non-rule; `run` to workflow inside rule; `run async` in rule; forbidden Jaiph usage inside `$(…)`; dot notation on non-prompt variable or invalid field name; bare identifier argument referencing an unknown variable; unquoted `${…}` in call-argument position; `${ident}` referencing an unknown variable in orchestration strings; arity mismatch; shell redirection (`>`, `>>`, `|`, `&`) inside unquoted call-argument text; bare nested managed calls; bare nested inline-script calls; type crossings (`prompt` on a script, `run` on a string, `const x = scriptName`, `${scriptName}`). |
| `E_IMPORT_NOT_FOUND` | Import target does not exist (module or script). |

### Validation rules

1. At most one `config` block per file and per workflow. Workflow `config` must precede steps. Workflow `config` allows only `agent.*` / `run.*`.
2. Config values are type-checked. `agent.backend` must be `cursor`, `claude`, or `codex`.
3. Import aliases must be unique. Import targets must exist.
4. Unified per-module namespace: channels, rules, workflows, scripts, script-import aliases, and top-level `const` share one namespace. Duplicate top-level names fail at parse time (`E_PARSE`); duplicate import aliases fail in validation (`E_VALIDATE`).
5. `ensure` targets a rule. `run` in a workflow targets a workflow or script; `run` in a rule targets a script only. Same rules apply to `return run` and `return ensure`.
6. Channel references in `send` must resolve to declared channels. Route targets must be workflows with exactly three parameters. Inline routes in workflow bodies are `E_PARSE`.
7. `catch` / `recover` argument ordering — all call args appear before `catch` / `recover`.
8. Shell redirection (`>`, `>>`, `|`, `&`) on `run` / `ensure` is rejected — trailing operators are `E_PARSE`; operators in unquoted call-argument text are `E_VALIDATE`.
9. Type crossings produce specific `E_VALIDATE` messages (see [Types](#types)).
10. Nested managed calls require explicit `run` / `ensure` keywords. Bare nested forms are `E_VALIDATE`.
11. `for iter in source` — `source` must name an in-scope variable.

## Build artifacts

`jaiph run` and `jaiph test` do not transpile workflows to shell. `buildScripts` emits only per-`script` executable files under `scripts/`:

| Source form | Emitted artifact |
|---|---|
| `script name = \`…\`` (single-line) | `scripts/<name>` with `#!/usr/bin/env bash` (or the fence-tag / manual shebang). |
| `script name = \`\`\`<tag>…\`\`\`` (fenced) | `scripts/<name>` with `#!/usr/bin/env <tag>` or the manual `#!` line. |
| `` run `body`(args) `` / `` run ```lang body```(args) `` | `scripts/__inline_<12-hex>` with the deterministic name from `inlineScriptName`. |
| `import script "path" as name` | Copied verbatim to `scripts/<name>` with its original shebang preserved; the runtime resolves it through `JAIPH_SCRIPTS` like any other script. |

Workflows, rules, prompts, channels, and control flow are interpreted by `NodeWorkflowRuntime` from the AST. There is no workflow-level shell emission. Script subprocesses inherit the runner's `process.env` plus Jaiph metadata.

## Related

- [Language](language.md) — step semantics and runtime behaviour.
- [CLI — `jaiph format`](cli.md#jaiph-format) — formatter rules and idempotence.
- [Configuration](configuration.md) — config-key semantics referenced by the grammar.
