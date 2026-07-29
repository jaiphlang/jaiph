# Jaiph Syntax for VS Code

Syntax highlighting, compiler diagnostics, and formatting for Jaiph (`.jh` and
`*.test.jh` files).

- Website: [jaiph.org](https://jaiph.org)
- Lives in the monorepo at `plugins/vscode/` ([jaiphlang/jaiph](https://github.com/jaiphlang/jaiph))

## Features

- Highlights the current Jaiph surface for `.jh` / `*.test.jh`: `import`,
  `config`, `channel` (`->` routes, `<-` sends), `script` (backtick and fenced),
  `rule`, `workflow`, `run` / `run async`, `ensure`, `catch` / `recover`,
  `prompt … returns`, `match`, `if` / `else if`, `for … in`, `const`,
  `log` / `logerr` / `logwarn`, `fail`, `return`, and `test` blocks
  (`mock …`, `allow_failure`, `expect_contain` / `expect_not_contain` /
  `expect_equal`).
- Compiler diagnostics on open/save via `jaiph compile --json`.
- Document formatting via `jaiph format`.
- Embedded grammars for script/prompt bodies (shell, python, node/js,
  typescript, ruby, perl, lua, powershell, php, markdown).

## Configuration

- `jaiph.compilerPath` — path to the `jaiph` binary (absolute path or a command
  on `PATH`). Defaults to `jaiph`. If the binary cannot be found, the extension
  surfaces a clear error instead of failing silently.
- `jaiph.diagnostics.enabled` — toggle compile-on-save/open diagnostics.

## Local development

1. Open **this folder** (`plugins/vscode`) in VS Code / Cursor — not the
   monorepo root.
2. `npm install`
3. `npm run compile`
4. Press `F5` (uses `.vscode/launch.json`, which points the Extension
   Development Host at this folder) and open a `.jh` file in the new window.

## Test

```bash
npm install
npm test        # typecheck + esbuild compile + grammar & CLI-contract tests
```

The test suite (`test/`) has two lanes:

- **Grammar** — tokenizes fixtures with `vscode-textmate` and asserts scopes,
  including a regression fixture that fails if stale surface (e.g. the removed
  `wait` keyword) is reintroduced.
- **Diagnostics** — runs the real monorepo `jaiph compile --json` against
  fixtures, so it breaks if the CLI diagnostics contract changes. Build the CLI
  once at the repo root first: `npm run build` in the monorepo root.

## Package

```bash
npm install
npm run package   # produces a .vsix in this directory (gitignored)
```

## Publish

```bash
npx @vscode/vsce publish   # requires a marketplace publisher token
```
