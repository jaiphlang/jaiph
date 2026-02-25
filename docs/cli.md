# Jaiph CLI Reference

[jaiph.org](https://jaiph.org) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Agent Skill](jaiph-skill.md) · [Install](install)

---

Jaiph provides four core CLI commands plus a file shorthand.

## `jaiph <file.jph>` (shorthand)

If the first argument ends in `.jph` and the file exists, Jaiph treats it as `jaiph run <file.jph>`:

```bash
jaiph ./flows/review.jph "review this diff"
# equivalent to: jaiph run ./flows/review.jph "review this diff"
```

## `jaiph build`

Compile `.jph` files into shell scripts.

```bash
jaiph build [--target <dir>] <path>
```

Examples:

```bash
jaiph build ./
jaiph build --target ./build ./flows
```

## `jaiph run`

Compile and run a Jaiph workflow file.  
`jaiph run` requires a `workflow default` entrypoint.

```bash
jaiph run [--target <dir>] <file.jph> [args...]
```

Examples:

```bash
jaiph run ./.jaiph/bootstrap.jph
jaiph run ./flows/review.jph "review this diff"
```

Argument passing matches standard bash script behavior:

- first argument -> `$1`
- second argument -> `$2`
- all arguments -> `"$@"`

Rules also receive forwarded arguments through `ensure`, for example:

```jaiph
rule current_branch {
  test "$(git branch --show-current)" = "$1"
}

workflow default {
  ensure current_branch "main"
}
```

`prompt` text follows bash-style variable expansion (for example `$1`, `${HOME}`, `${FILES[@]}`).
For safety, command substitution is not allowed in prompt text: `$(...)` and backticks are rejected with `E_PARSE`.

If a `.jph` file is executable and has `#!/usr/bin/env jaiph`, you can run it directly:

```bash
./.jaiph/bootstrap.jph "task details"
./flows/review.jph "review this diff"
```

## `jaiph init`

Initialize Jaiph files in a workspace directory.

```bash
jaiph init [workspace-path]
```

Creates:

- `.jaiph/bootstrap.jph`
- `.jaiph/config.toml`
- `.jaiph/jaiph-skill.md` (synced from local Jaiph installation)

## `jaiph use`

Reinstall Jaiph globally with the selected channel/version.

```bash
jaiph use <version|nightly>
```

Behavior:

- `nightly` -> installs from `main` branch
- `<version>` -> installs tag `v<version>`

Examples:

```bash
jaiph use nightly
jaiph use 0.2.3
```

## Environment variables

Runtime/config override variables:

- `JAIPH_STDLIB`
- `JAIPH_AGENT_MODEL`
- `JAIPH_AGENT_COMMAND`
- `JAIPH_RUNS_DIR`
- `JAIPH_DEBUG`

Install/use variables:

- `JAIPH_REPO_URL`
- `JAIPH_REPO_REF`
- `JAIPH_BIN_DIR`
- `JAIPH_LIB_DIR`
