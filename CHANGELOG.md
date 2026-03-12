# 0.3.0

- **Typed `prompt` schema validation with `returns`** — You can declare the shape of the agent's JSON response with `result = prompt "..." returns '{ type: string, risk: string, summary: string }'`. The schema is **flat only** (no nested objects, arrays, or union types in v1). Allowed field types: `string`, `number`, `boolean`. The compiler appends instructions to the prompt; the runtime parses the last non-empty line as JSON and validates it. Valid response sets the capture variable to the raw JSON and exports `name_field` for each field (e.g. `$result_type`, `$result_risk`). Distinct failure modes: JSON parse error (exit 1), missing required field (exit 2), type mismatch (exit 3). Unsupported schema type or invalid schema syntax fails at compile time with `E_SCHEMA`; prompt with `returns` but without a capture variable fails with `E_PARSE`. Line continuation with `\` after the prompt string is supported for multiline `returns` clauses. Test with `jaiph test` by mocking the prompt with valid JSON that satisfies the schema.
- **Inline brace-group short-circuit (`cmd || { ... }`)** — The parser now accepts short-circuit brace-group patterns in rule, workflow, and function bodies. Single-line `cmd || { echo "failed"; exit 1; }` and multi-line `cmd || { ... }` compile and transpile correctly. Existing `if ! cmd; then ...; fi` patterns continue to work.
- **Prompt line in tree: prompt preview and capped args** — The progress tree line for a `prompt` step now shows a truncated preview of the prompt text (first 24 characters, then `...` if longer) and the argument list `(arg1, arg2, ...)` is capped at 24 characters total (truncated with `...` if longer). Example: `▸ prompt "Say hello to $1 and..." (greeting)` instead of only `▸ prompt (greeting)`. Non-prompt steps are unchanged. Makes it easier to tell which prompt is running when multiple prompts exist and keeps tree lines bounded.
- **Assignment capture for any step** — You can capture stdout from any step with `name = <step>`: e.g. `response = ensure tests_pass`, `out = run helper`, `line = echo hello`. Only stdout is captured; stderr is not included unless the command redirects it (e.g. `2>&1`). If the command fails, the step fails unless you explicitly short-circuit (e.g. `... || true`). Existing `result = prompt "..."` behavior is unchanged. Bash-consistent semantics: see [Grammar](docs/grammar.md).
- **Project-local and global hooks** — Support for `~/.jaiph/hooks.json` (global) and `<project>/.jaiph/hooks.json` (project-local). Hook commands run at workflow/step lifecycle events (`workflow_start`, `workflow_end`, `step_start`, `step_end`). Project-local entries override global per event. Payload is JSON on stdin; hook failures are logged but do not block the run. See [Hooks](docs/hooks.md).
- **Claude CLI as prompt backend** — File-level `agent.backend` (`cursor` | `claude`) with env override (`JAIPH_AGENT_BACKEND`). Prompt execution is routed through a backend abstraction; clear error when `claude` is selected but not on PATH. Output capture (`result = prompt "..."`) and `jaiph test` prompt mocks work with both backends; when a prompt is not mocked, the selected backend runs (including Claude CLI). No prompt-level backend override; default backend remains `cursor` and backward compatible.
- **TTY run progress: single bottom line only** — In TTY mode, the progress tree is printed the same as in non-TTY: each task line with icon and final time when the step completes (e.g. `✓ 0s`, `▸ prompt "First 24 chars..." (arg1)` then on completion `✓ 2s`). No per-step live counters or in-place updates on tree lines. A single extra line at the bottom shows `  RUNNING workflow <name> (X.Xs)` (RUNNING yellow, "workflow" bold, workflow name default, time dim) and is the only line updated in place (e.g. every second). When the run finishes, that line is removed. Non-TTY unchanged (no RUNNING line, no timer).
- **ensure … recover (retry loop)** — `ensure <rule_ref>(args) recover <body>` runs the rule and, on failure, runs the recover body in a **bounded** retry loop until the rule passes or max retries is reached (then exit 1). Recover body: single statement (e.g. `ensure dep recover run install_deps`) or block `ensure ref recover { stmt; stmt; }`. Max retries default to 10; override with `JAIPH_ENSURE_MAX_RETRIES`. Bare `ensure ref` (no recover) unchanged.
- **Run tree: step parameters inline** — When `jaiph run` prints the step tree, `workflow`, `prompt`, and `function` steps invoked with arguments show those argument **values** inline in gray after the step name (e.g. `▸ function fib (3)`, `▸ workflow docs_page (docs/cli.md, strict)`). Format: comma-separated values in parentheses; no parameter names or internal refs (e.g. `::impl`) are shown. Values are truncated to 32 characters with `...` when longer. Parameter order is stable for diff-friendly output. Steps without parameters are unchanged.

# 0.2.0

- `config { ... }` block for runtime behavior: `agent.backend` (`"cursor"` | `"claude"`), `agent.trusted_workspace`, and existing env-backed options
- Claude CLI as alternative agent backend when `agent.backend = "claude"` (with clear error if `claude` not in PATH)
- Trusted workspace and metadata scoping; config docs
- Run progress driven by runtime event graph (not only CLI); normalized e2e output
- First-class mocking in tests: mock workflows, rules, and functions (not only prompts)
- `if_not_ensure_then` / `if_not_ensure_then_run` / `if_not_ensure_then_shell` / `if_not_shell_then` workflow steps for conditional flows
- CI checks for compilation and testing; e2e tests aligned with current output
- Nested workflows and step functions in run tree; `run` disallowed inside `rule` blocks (use `ensure` or move to workflow)
- Prompt capture fixes (assignments as final answer); improved test failure output
- Documentation and docs site updates (getting started, testing, styling, mobile)
- `jaiph test` runs `*.test.jh` / `*.test.jph` with inline prompt mocks (`mock prompt "..."` or `mock prompt { if $1 contains "..." ; then respond "..." ; fi }`). No external `.test.toml` files.
- Runtime config is env vars and in-file metadata only; `.jaiph/config.toml` and global config files are no longer read.
- `jaiph init` no longer creates `.jaiph/config.toml`.
- `.jh` extension recommended for new files; `.jph` supported but deprecated (CLI shows migration hint when running `.jph` files)
- `jaiph init` creates `.jaiph/bootstrap.jh` and `.jaiph/jaiph-skill.md`
- Import resolution prefers `.jh` over `.jph` when both exist
- `JAIPH_INSTALL_COMMAND` environment variable for `jaiph use` (default: `curl -fsSL https://jaiph.org/install | bash`)
- `run` is not allowed inside a `rule` block; use `ensure` to call another rule or move the call to a workflow

# 0.1.0

- `jaiph build [--target <dir>] <path>` compiles `.jph` files to bash scripts
- `jaiph run [--target <dir>] <file.jph> [args...]` compiles and executes workflows
- `jaiph init [workspace-path]` initializes workspace with bootstrap, config, and skill files
- `jaiph use <version|nightly>` switches installed Jaiph version
- `jaiph <file.jph>` shorthand for `jaiph run`
- `import "path.jph" as alias` with compile-time import validation
- `rule name { ... }` declarations executed in a read-only subshell
- `workflow name { ... }` declarations for mutable orchestration steps
- `function name() { ... }` declarations with namespaced wrappers and call-site shims
- `ensure ref [args...]` executes a rule with optional argument forwarding
- `run ref` executes a workflow from another workflow
- `prompt "..."` sends multiline text to the configured agent command
- `if ! ensure rule; then run workflow; fi` conditional form
- `export` keyword for rules and workflows
- Shell interoperability within rules and workflows
- Transpilation to pure bash with global stdlib (`jaiph_stdlib.sh`)
- TOML configuration in global and local scopes with environment variable overrides
- Run logging to `.jaiph/runs/` with per-step stdout/stderr capture
- Run tree visualization on `jaiph run`
- Read-only sandbox for rules via Linux mount namespaces (with macOS fallback)
- Debug mode via `JAIPH_DEBUG=true` (enables shell xtrace)
- Workspace root auto-detection via `.jaiph/` or `.git/` markers
- `curl -fsSL https://jaiph.org/install | bash` installer
