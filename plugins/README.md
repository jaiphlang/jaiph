# Editor plugins

Jaiph editor integrations live in this monorepo so language changes and highlighting/diagnostics stay in one PR.

| Path | Product |
|------|---------|
| [`vscode/`](vscode/) | VS Code / Cursor extension (TextMate + CLI diagnostics/format) |
| [`zed/`](zed/) | Zed extension (Tree-sitter; scaffold pending queue task) |

CI install for other repositories lives at [`../actions/setup-jaiph/`](../actions/setup-jaiph/) (not under `plugins/` — GitHub Actions resolve as `jaiphlang/jaiph/actions/setup-jaiph@<ref>`).

These packages are **not** part of the root `npm` package. Build and publish each directory on its own.
