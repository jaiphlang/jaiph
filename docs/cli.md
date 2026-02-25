# Jaiph CLI Reference

Jaiph provides four core CLI commands.

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
