# Jaiph Syntax for VS Code

Syntax highlighting, compiler diagnostics, formatting, and an execution-flow
graph preview for Jaiph (`.jh` and `*.test.jh` files).

- Website: [jaiph.org](https://jaiph.org)
- Lives in the monorepo at `plugins/vscode/` ([jaiphlang/jaiph](https://github.com/jaiphlang/jaiph))

## Features

- Highlights the current Jaiph surface for `.jh` / `*.test.jh`: `import` /
  `import script`, `config`, `channel` (`->` routes, `send … ->` sends),
  `script` (one-line `'…'` and fenced `'''…'''`, optional `use KEY …`), `def`, named
  `prompt name(params) [use KEY …] = …`, bare calls (`name(args)`,
  `async name(args)`), stdin connect (`stdin … -> name(args)`), `catch` /
  `recover`, anonymous `prompt … returns`, `match`, `if` / `else if`,
  `for … in`, `const`, `log` / `logerr` / `logwarn`, `fail`, `return`, and
  `test` blocks (`mock …`, `allow_failure`, `expect_contain` /
  `expect_not_contain` / `expect_equal`). Nested `script` / `def` /
  `prompt` / `const` inside a def highlight the same way.
- Compiler diagnostics on open/save via `jaiph compile --json`.
- Document formatting via `jaiph format`.
- Graph preview, like the Markdown preview: the **Open Graph Preview to the
  Side** button in the editor title bar (or `Cmd+K V` / `Ctrl+K V`;
  `Cmd+Shift+V` / `Ctrl+Shift+V` opens it in place) renders the file's
  execution flow from `jaiph graph`. The toolbar sets the entry **Def**, the
  **Depth** of def calls drawn (`--depth`, default 3), the **Imports** hops
  drawn (`--import-depth`, default 1), and **Libs** (`--libs`). The preview
  re-renders when any `.jh` file is saved, so it reflects saved files, not
  unsaved edits. A file with errors shows the compiler message instead. Mermaid
  is bundled with the extension, so the preview needs no network. See
  [Execution flow](https://jaiph.org/execution-flow) for how to read the chart.
- Embedded grammars for script/prompt bodies (shell, python, node/js,
  typescript, ruby, perl, lua, powershell, php, markdown).

## Configuration

- `jaiph.compilerPath` — path to the `jaiph` binary (absolute path or a command
  on `PATH`). Defaults to `jaiph`. If the binary cannot be found, the extension
  surfaces a clear error instead of failing silently.
- `jaiph.diagnostics.enabled` — toggle compile-on-save/open diagnostics.

The graph preview uses `jaiph.compilerPath` too, and needs a CLI that has the
`jaiph graph` command.

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
  `wait` / `local` / `rule` / `workflow` / `ensure` / `inbox` keywords) is reintroduced.
- **Diagnostics and graph** — run the real monorepo `jaiph compile --json` and
  `jaiph graph` against fixtures, so they break if either CLI contract changes. Build the CLI
  once at the repo root first: `npm run build` in the monorepo root.

## Package

```bash
npm install
npm run package   # produces a .vsix in this directory (gitignored)
```

## Publish

Releases publish automatically. Pushing a `vX.Y.Z` tag runs
[`.github/workflows/vscode-publish.yml`](https://github.com/jaiphlang/jaiph/blob/main/.github/workflows/vscode-publish.yml),
which tests and packages this extension and publishes it to the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=jaiph.jaiph-syntax-vscode)
and [Open VSX](https://open-vsx.org/extension/jaiph/jaiph-syntax-vscode).
The tag must equal the `version` in this `package.json`;
`.jaiph/prepare_release.jh` sets both. The workflow stores no tokens: both
registries trust it through GitHub OIDC (trusted publishing). See
[Contributing](https://jaiph.org/contributing#version-tags-releases-and-npm) for the
one-time registry setup.

To publish by hand instead (with personal access tokens):

```bash
npm run package
npx vsce publish --packagePath jaiph-syntax-vscode-<version>.vsix   # VSCE_PAT
npx ovsx publish --packagePath jaiph-syntax-vscode-<version>.vsix   # OVSX_PAT
```
