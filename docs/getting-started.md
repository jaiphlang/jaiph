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

## Build transpiled scripts

```bash
jaiph build ./flows --target ./out
```
