# 0.2.0

- `.jh` extension recommended for new files; `.jph` supported but deprecated (CLI shows migration hint when running `.jph` files)
- `jaiph init` creates `.jaiph/bootstrap.jh` (and `.jaiph/config.toml`, `.jaiph/jaiph-skill.md`)
- Import resolution prefers `.jh` over `.jph` when both exist
- `JAIPH_INSTALL_COMMAND` environment variable for `jaiph use` (default: `curl -fsSL https://jaiph.org/install | bash`)

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
