# Grammar

This grammar describes the current parser behavior.

## Lexical notes

- `IDENT := [A-Za-z_][A-Za-z0-9_]*`
- `REF := IDENT | IDENT "." IDENT`
- comments: lines starting with `#`
- whitespace-only lines are ignored

## EBNF

```ebnf
file            = { top_level } ;

top_level       = import_stmt | rule_decl | workflow_decl ;

import_stmt     = "import" string "as" IDENT ;

rule_decl       = [ "export" ] "rule" IDENT "{" { rule_line } "}" ;
rule_line       = command_line ;

workflow_decl   = [ "export" ] "workflow" IDENT "{" { workflow_step } "}" ;

workflow_step   = ensure_stmt
                | run_stmt
                | prompt_stmt
                | if_ensure_run_stmt
                | shell_stmt ;

ensure_stmt     = "ensure" REF ;
run_stmt        = "run" REF ;
prompt_stmt     = "prompt" quoted_or_multiline_string ;

if_ensure_run_stmt
                = "if" "!" "ensure" REF ";" "then"
                  run_stmt
                  "fi" ;

shell_stmt      = command_line ;
```

## Validation rules

1. Imported alias names must be unique per file.
2. `ensure foo` requires local rule `foo`.
3. `ensure alias.foo` requires imported rule `foo` in module `alias`.
4. `run bar` requires local workflow `bar`.
5. `run alias.bar` requires imported workflow `bar` in module `alias`.
6. Import targets must exist on disk.

## Transpilation rules

1. Every generated file sources `jaiph_stdlib.sh`.
2. Each rule compiles to `<rule_fn>__impl` plus `<rule_fn>` wrapper that calls `jaiph__execute_readonly`.
3. `ensure` compiles to a call to `<rule_fn>` (the wrapper).
4. `prompt` compiles to `jaiph__prompt ...`.
5. `if ! ensure X; then run Y; fi` keeps that control flow in Bash with transpiled symbols.
