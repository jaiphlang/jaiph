# 0.2.0

- `config { ... }` block for runtime behavior: `agent.backend` (`"cursor"` | `"claude"`), `agent.trusted_workspace`, and existing env-backed options
- Claude CLI as alternative agent backend when `agent.backend = "claude"` (with clear error if `claude` not in PATH)
- Trusted workspace and metadata scoping; config docs
- Run progress driven by runtime event graph (not only CLI); normalized e2e output
- First-class mocking in tests: mock workflows, rules, and functions (not only prompts)
- `if_not_ensure_then` / `if_not_ensure_then_run` / `if_not_ensure_then_shell` workflow steps for conditional flows
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
