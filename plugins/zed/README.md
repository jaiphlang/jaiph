# Jaiph for Zed

Tree-sitter syntax highlighting for Jaiph (`.jh` and `*.test.jh`) in
[Zed](https://zed.dev), plus a task that previews a file's execution-flow
graph.

- Website: [jaiph.org](https://jaiph.org)
- Lives in the monorepo at `plugins/zed/` ([jaiphlang/jaiph](https://github.com/jaiphlang/jaiph))

## Features

Highlights the current Jaiph surface: `import` / `import script`, `config`,
`channel` (`->` routes, `send … ->` sends), `script` (one-line `'…'` and fenced,
optional `use KEY …`), `def`, named `prompt name(params) [use KEY …] = …`,
bare calls (`name(args)`, `async name(args)`), stdin connect
(`stdin … -> name(args)`), `catch` / `recover`, anonymous `prompt … returns`, `match`
(`=>`, `_` wildcard), `if` / `else if`, `for … in`, `const`, `log` / `logerr` /
`logwarn`, `fail`, `return`, and `test` blocks (`mock`, `allow_failure`,
`expect_contain` / `expect_not_contain` / `expect_equal`), plus comments,
double- and triple-quoted strings, regex patterns, numbers, and booleans.

Fenced and inline script bodies (`bash'''`, `python3'''`, …) inject the
language named by the interpreter tag via `languages/jaiph/injections.scm`; a
bare fence defaults to shell, matching the Jaiph runtime. The tag is also
highlighted on tagged one-line bodies (`python3'print(1)'`).

Zed language extensions require a **Tree-sitter** grammar (they cannot reuse a
TextMate grammar like the VS Code extension), so this extension is backed by
the grammar at [`../../grammars/tree-sitter-jaiph`](../../grammars/tree-sitter-jaiph).

## Graph preview

Zed extensions cannot add a preview pane, but Zed's built-in Markdown preview
renders Mermaid. So the graph preview is a task: it writes the output of
`jaiph graph` for the current file into a Markdown file and opens it. Add this
to your project's `.zed/tasks.json` (or the global `tasks.json`):

````json
[
  {
    "label": "jaiph: graph preview",
    "command": "f=\"$ZED_WORKTREE_ROOT/.jaiph/graph/$ZED_STEM.md\"; g=$(jaiph graph -d \"$JAIPH_GRAPH_DEPTH\" -i \"$JAIPH_GRAPH_IMPORTS\" \"$ZED_FILE\") || exit 1; mkdir -p \"$(dirname \"$f\")\" && printf '```mermaid\\n%s\\n```\\n' \"$g\" > \"$f\" && zed \"$f\"",
    "env": { "JAIPH_GRAPH_DEPTH": "3", "JAIPH_GRAPH_IMPORTS": "1" },
    "reveal": "no_focus",
    "hide": "on_success"
  },
  {
    "label": "jaiph: graph preview (everything)",
    "command": "f=\"$ZED_WORKTREE_ROOT/.jaiph/graph/$ZED_STEM.md\"; g=$(jaiph graph -d all -i all -l \"$ZED_FILE\") || exit 1; mkdir -p \"$(dirname \"$f\")\" && printf '```mermaid\\n%s\\n```\\n' \"$g\" > \"$f\" && zed \"$f\"",
    "reveal": "no_focus",
    "hide": "on_success"
  }
]
````

Then, with a `.jh` file open:

1. Run **task: spawn** and pick **jaiph: graph preview**. The task opens
   `.jaiph/graph/<file>.md`.
2. Run **markdown: open preview to the side** on that file. The preview
   updates each time you rerun the task.

Set the depth in the task's `env`: `JAIPH_GRAPH_DEPTH` is `--depth` (def-call
levels, default 3) and `JAIPH_GRAPH_IMPORTS` is `--import-depth` (import hops,
default 1). Each takes a number or `all`. Copy the task with other values to
keep several presets. To graph a def other than `main`, add `--def <name>` to
the command. If the file has errors, the task fails and its terminal shows the
compiler message.

The task needs `jaiph` and the `zed` command-line tool on `PATH` (install the
CLI with **cli: install**). Add `.jaiph/graph/` to `.gitignore`.

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
