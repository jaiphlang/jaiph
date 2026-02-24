# Getting Started

## Install CLI

```bash
curl -fsSL https://raw.githubusercontent.com/jaiphlang/jaiph/main/install | bash
```

The installer places `jaiph` in `~/.local/bin`.

## Verify PATH

Check:

```bash
if [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
  echo "PATH ok"
else
  echo "PATH missing ~/.local/bin"
fi
```

If missing, add for your shell:

```bash
# zsh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc

# bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

## Run a workflow

```bash
jaiph run path/to/main.jph "feature request or task"
```

Entrypoint resolution: `jaiph run path/to/file.jph` executes workflow `default`.

Files with no workflows are valid for `jaiph build`, but `jaiph run` requires `workflow default`.

Known parser limitation: inline brace-group short-circuit patterns like `cmd || { ... }` are not supported in `.jph` files yet. Use explicit conditionals like `if ! cmd; then ...; fi`.

## Build transpiled scripts

```bash
jaiph build ./flows --target ./out
```
