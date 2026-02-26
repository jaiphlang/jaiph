# Jaiph CLI Reference

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Agent Skill](https://raw.githubusercontent.com/jaiphlang/jaiph/main/docs/jaiph-skill.md)

---

Jaiph provides four core CLI commands plus a file shorthand.

## `jaiph <file.jh>` (shorthand)

If the first argument ends in `.jh` or `.jph` and the file exists, Jaiph treats it as `jaiph run <file>`:

```bash
jaiph ./flows/review.jh "review this diff"
# equivalent to: jaiph run ./flows/review.jh "review this diff"
```

## `jaiph build`

Compile `.jh` and `.jph` files into shell scripts.

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
jaiph run [--target <dir>] <file.jh|file.jph> [args...]
```

Examples:

```bash
jaiph run ./.jaiph/bootstrap.jh
jaiph run ./flows/review.jh "review this diff"
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

If a `.jh` or `.jph` file is executable and has `#!/usr/bin/env jaiph`, you can run it directly:

```bash
./.jaiph/bootstrap.jh "task details"
./flows/review.jh "review this diff"
```

## `jaiph init`

Initialize Jaiph files in a workspace directory.

```bash
jaiph init [workspace-path]
```

Creates:

- `.jaiph/bootstrap.jh`
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
jaiph use 0.2.0
```

## File extensions

- **`.jh`** is the recommended extension for new Jaiph files. Use it for entrypoints, imports, and `jaiph build` / `jaiph run`.
- **`.jph`** remains supported for backward compatibility. Existing projects using `.jph` continue to work unchanged. The CLI may show a deprecation notice when you run a `.jph` file; migrate when convenient with `mv *.jph *.jh` and update import paths if they explicitly mention the extension.

Imports resolve for both extensions: `import "foo" as x` finds `foo.jh` or `foo.jph` (`.jh` is preferred when both exist).

## Environment variables

Runtime/config override variables:

- `JAIPH_STDLIB`
- `JAIPH_AGENT_MODEL`
- `JAIPH_AGENT_COMMAND`
- `JAIPH_RUNS_DIR`
- `JAIPH_DEBUG`
- `JAIPH_SKILL_PATH` — path to skill file used by `jaiph init` when syncing `.jaiph/jaiph-skill.md`

Install/use variables:

- `JAIPH_REPO_URL`
- `JAIPH_REPO_REF`
- `JAIPH_BIN_DIR`
- `JAIPH_LIB_DIR`
- `JAIPH_INSTALL_COMMAND` — command run by `jaiph use` to reinstall (default: `curl -fsSL https://jaiph.org/install | bash`)
