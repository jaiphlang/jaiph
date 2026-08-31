# Jaiph for Zed

Tree-sitter syntax highlighting for Jaiph (`.jh` and `*.test.jh`) in
[Zed](https://zed.dev).

- Website: [jaiph.org](https://jaiph.org)
- Lives in the monorepo at `plugins/zed/` ([jaiphlang/jaiph](https://github.com/jaiphlang/jaiph))

## Features

Highlights the current Jaiph surface: `import` / `import script`, `config`,
`channel` (`->` routes, `send … ->` sends), `script` (backtick and fenced,
optional `use KEY …`), `def`, named `prompt name(params) [use KEY …] = …`,
`run` / `run async`, `catch` / `recover`, anonymous `prompt … returns`, `match`
(`=>`, `_` wildcard), `if` / `else if`, `for … in`, `const`, `log` / `logerr` /
`logwarn`, `fail`, `return`, and `test` blocks (`mock`, `allow_failure`,
`expect_contain` / `expect_not_contain` / `expect_equal`), plus comments,
double- and triple-quoted strings, regex patterns, numbers, and booleans.

Fenced and inline script bodies (```` ```bash ````, ```` ```python3 ````, …)
inject the embedded language via `languages/jaiph/injections.scm`; a bare fence
defaults to shell, matching the Jaiph runtime.

Zed language extensions require a **Tree-sitter** grammar (they cannot reuse a
TextMate grammar like the VS Code extension), so this extension is backed by
the grammar at [`../../grammars/tree-sitter-jaiph`](../../grammars/tree-sitter-jaiph).

## The grammar and how it is version-pinned

`extension.toml` pins the grammar by **repository + revision** and the in-repo
subdirectory:

```toml
[grammars.jaiph]
repository = "https://github.com/jaiphlang/jaiph"
rev = "<commit sha>"
path = "grammars/tree-sitter-jaiph"
```

Bump `rev` to the commit that carries the matching
`grammars/tree-sitter-jaiph/src/` whenever the grammar changes. The generated
parser (`src/`) is committed, so Zed builds the grammar without running
`tree-sitter generate`.

For local **grammar** development, point `repository` at a local checkout with a
`file://` URL:

```toml
[grammars.jaiph]
repository = "file:///absolute/path/to/jaiph"
rev = "<local commit sha>"
path = "grammars/tree-sitter-jaiph"
```

## Local install (Install Dev Extension)

1. In Zed, open the command palette and run **zed: install dev extension**
   (Extensions view → **Install Dev Extension**).
2. Select **this folder** (`plugins/zed`) — not the monorepo root.
3. Open a `.jh` or `*.test.jh` file; highlighting applies immediately.

Zed compiles the pinned grammar on install. For fully offline grammar hacking,
use the `file://` grammar form above.

## Publishing to the Zed extension registry

Zed extensions are published from the
[`zed-industries/extensions`](https://github.com/zed-industries/extensions)
registry, which references each extension by path. When publishing, this
monorepo is added as a submodule and the registry entry points at:

```toml
path = "plugins/zed"
```

so the extension loads directly from this directory.

## Test

```bash
npm install
npm test        # regenerates the grammar and query-checks the shipped .scm files
```

The suite drives the real Tree-sitter CLI against
`../../grammars/tree-sitter-jaiph` and the queries in `languages/jaiph/`,
asserting that keywords, comments, strings, and embedded-language injections
are captured — and that removed surface (e.g. `wait` / `local` / `rule` /
`workflow` / `ensure` / `inbox`) is not. It
fails if the grammar or a query regresses. A C toolchain is required (the CLI
compiles the parser on the fly); CI and macOS/Linux dev machines have one.
