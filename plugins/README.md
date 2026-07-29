# Editor plugins

Jaiph editor integrations live in this monorepo so language changes and highlighting/diagnostics stay in one PR.

| Path | Product |
|------|---------|
| [`vscode/`](vscode/) | VS Code / Cursor extension (TextMate + CLI diagnostics/format) |
| [`zed/`](zed/) | Zed extension (Tree-sitter highlights/injections) |

The Zed extension is backed by the Tree-sitter grammar at [`../grammars/tree-sitter-jaiph/`](../grammars/tree-sitter-jaiph/) (not under `plugins/` — it is a standalone grammar package that any Tree-sitter host can consume, and `plugins/zed/extension.toml` pins it by repository + revision).

CI install for other repositories lives at [`../actions/setup-jaiph/`](../actions/setup-jaiph/) (not under `plugins/` — GitHub Actions resolve as `jaiphlang/jaiph/actions/setup-jaiph@<ref>`).

These packages are **not** part of the root `npm` package. Build and publish each directory on its own.
