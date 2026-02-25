# Jaiph Grammar (Current Parser)

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Agent Skill](jaiph-skill.md)

---

This document reflects parser and transpiler behavior in the current codebase (`src/parser.ts`, `src/transpiler.ts`).

## Lexical Notes

- `IDENT := [A-Za-z_][A-Za-z0-9_]*`
- `REF := IDENT | IDENT "." IDENT`
- Comments are full-line comments starting with `#`.
- Empty or whitespace-only lines are ignored.
- Input files supported by build/run/import resolution: `.jph`.

## EBNF (Practical Form)

```ebnf
file            = { top_level } ;

top_level       = import_stmt | rule_decl | function_decl | workflow_decl ;

import_stmt     = "import" string "as" IDENT ;

rule_decl       = [ "export" ] "rule" IDENT "{" { rule_line } "}" ;
rule_line       = comment_line | command_line ;

function_decl   = "function" IDENT [ "()" ] "{" { function_line } "}" ;
function_line   = comment_line | command_line ;

workflow_decl   = [ "export" ] "workflow" IDENT "{" { workflow_step } "}" ;

workflow_step   = ensure_stmt
                | run_stmt
                | prompt_stmt
                | if_not_ensure_then_run_stmt
                | shell_stmt
                | comment_line ;

ensure_stmt     = "ensure" REF [ args_tail ] ;
run_stmt        = "run" REF ;
prompt_stmt     = "prompt" quoted_or_multiline_string ;

if_not_ensure_then_run_stmt
                = "if" "!" "ensure" REF ";" "then"
                  run_stmt
                  "fi" ;

shell_stmt      = command_line ;
```

## Important Parse/Runtime Semantics

1. `ensure` accepts argument tail and forwards it as-is (example: `ensure check_branch "$1"`).
2. Rules can consume forwarded positional parameters as shell args (`$1`, `$2`, `"$@"`) without special declaration syntax.
3. Top-level `function` blocks define writable shell functions and are namespaced in transpiled output.
4. Original function names remain callable via generated shims that invoke the namespaced wrapper.
5. `run` inside a workflow must target a workflow reference (`foo` or `alias.foo`), not an arbitrary shell command.
6. Inside a `rule`, `run some shell` is treated as command shorthand and transpiles as the shell command.
7. `prompt` supports multiline quoted text and compiles to `jaiph__prompt ...` with bash-style variable expansion.
8. `prompt` rejects command substitution (`$(...)` and backticks) with `E_PARSE`; only variable expansion is allowed.
9. Workflow and rule declarations support optional `export` keyword.

## Validation Rules

1. Import aliases must be unique within a file.
2. Import targets must exist on disk.
3. Local `ensure foo` requires local rule `foo`.
4. Imported `ensure alias.foo` requires imported rule `foo` in module `alias`.
5. Local `run bar` requires local workflow `bar`.
6. Imported `run alias.bar` requires imported workflow `bar` in module `alias`.

## Transpilation Rules (Current)

1. Build emits module scripts that source the installed global stdlib (`$JAIPH_STDLIB`, default `~/.local/bin/jaiph_stdlib.sh`).
2. Each rule transpiles into:
   - `<module>__rule_<name>__impl`
   - `<module>__rule_<name>` wrapper using `jaiph__run_step ... jaiph__execute_readonly`.
3. Each workflow transpiles into:
   - `<module>__workflow_<name>__impl`
   - `<module>__workflow_<name>` wrapper using `jaiph__run_step`.
4. Each top-level function transpiles into:
   - `<module>__function_<name>__impl`
   - `<module>__function_<name>` wrapper using `jaiph__run_step`
   - `<name>` shim forwarding to the namespaced wrapper.
5. `if ! ensure X; then run Y; fi` remains explicit Bash control flow using transpiled symbols.
