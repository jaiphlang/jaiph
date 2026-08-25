# ADR 0002 — `def`, `main`, private-by-default

*Status: accepted*
*Date (UTC): 2026-08-25*

## Decision

Jaiph has one interpreted callable: `def`. The CLI entry is `export def main`. Names are private unless marked `export`. There is no `rule`, `ensure`, `workflow`, or `default`.

## Language

- `def name(params) { … }` is the interpreted body (prompts, sends, `run async`, other defs, scripts, `recover`). `script` / `prompt` / `channel` stay.
- One call verb: `run`, `${run …}`, `return run …`, match-arm `run`. `recover` is legal on every `run`.
- Same-file: all names. Across `import`: only names in the module's export list. Zero exports means nothing is public.
- `main` is optional. A library module has no `main`. `jaiph compile` succeeds without it. `jaiph run` requires `export def main` in the input file.
- If a symbol named `main` exists, it must be `export def main` (not a script, not unexported).
- `jaiph mcp` / `jaiph serve` expose exported defs only. Skip `main` unless it is the sole export; then expose it under the file basename.
- `mock def ref() { … }`. No `mock rule`.

## Why

`rule` was a second callable plus a second call verb. Its “purity” was a compiler costume: a rule could still `run` a mutating script. `ensure` existed only to target that kind.

`workflow` named a product. `def` names a procedure. `default` did not mean entrypoint. `main` does.

Zero-export-means-public inverted `export`: adding the first `export` silently hid everything else. Private by default is the boundary.

`main` is three surfaces, not one: CLI entry, import/test API, MCP tool list. Exporting `main` for `jaiph run` and tests must not auto-publish it as an MCP tool next to other exports.

## Consequences

- Hard break. No aliases. Removed keywords parse as errors that name the replacement.
- Internal AST is `Def` / `mod.defs`. Source keyword is `def`.
- Journal: `RUN_START` / `RUN_END` with field `def`. Nested defs emit `STEP_START` kind `def`.
- Hooks: `run_start` / `run_end`; payload `run_id`.
- HTTP: `/v1/defs`, `{ defs: [...] }`, run object field `def`.
- Telemetry: `jaiph.def`; root span `run <name>`.
- MCP: `McpToolSpec.def`.
- `Expr.ensure_call`, `RuleDef`, and rule-scope validation are gone.
