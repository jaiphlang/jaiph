# tree-sitter-jaiph

Tree-sitter grammar for the [Jaiph](https://jaiph.org) orchestration language
(`.jh` / `*.test.jh`). It powers the Zed extension in
[`../../plugins/zed`](../../plugins/zed) and can back any Tree-sitter host
(Neovim, Helix, …).

This is a **token-oriented grammar** built for editor highlighting and language
injection, not a full semantic parser — the authoritative Jaiph parser is the
TypeScript compiler under [`../../src`](../../src). `source_file` is a flat
stream of tokens (keywords, strings, comments, operators, identifiers, fenced
script blocks). Keeping it loose means it never fails to tokenize a valid Jaiph
file, and avoids maintaining a second grammar that could drift from the compiler.

## Layout

- `grammar.js` — the grammar definition (the source of truth).
- `src/` — generated parser (`parser.c`, `grammar.json`, `node-types.json`).
  **Committed** so Tree-sitter hosts (including Zed) can build the grammar
  without running `tree-sitter generate`.

## Regenerating

After editing `grammar.js`:

```bash
npm install          # installs tree-sitter-cli
npm run generate     # regenerates src/ from grammar.js
```

Commit the regenerated `src/` alongside the `grammar.js` change.

## Highlight queries

The highlight / injection queries live with the editor that consumes them —
see [`../../plugins/zed/languages/jaiph/`](../../plugins/zed/languages/jaiph).
The Zed plugin's test suite exercises those queries against this grammar.
