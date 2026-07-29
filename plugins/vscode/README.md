# Jaiph Syntax for VS Code

Syntax highlighting, compiler diagnostics, and formatting for Jaiph (`.jh` files).

- Website: [jaiph.org](https://jaiph.org)
- Lives in the monorepo at `plugins/vscode/` ([jaiphlang/jaiph](https://github.com/jaiphlang/jaiph))

## Features

- Highlights Jaiph keywords and structure for `.jh` / `*.test.jh`
- Compiler diagnostics on open/save via the `jaiph` CLI
- Document formatting via `jaiph format`
- Embedded grammars for script/prompt blocks (shell, python, javascript, markdown, …)

## Local development

1. Open **this folder** (`plugins/vscode`) in VS Code / Cursor (not the monorepo root).
2. `npm install && npm run compile`
3. Press `F5` to launch an Extension Development Host.
4. Open a `.jh` file in the new window.

## Package

```bash
npm install
npm run package
```

Produces a `.vsix` in this directory (gitignored).
