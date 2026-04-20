---
title: Libraries
permalink: /libraries
redirect_from:
  - /libraries.md
---

# Libraries

Jaiph supports **project-scoped libraries** — reusable `.jh` modules installed from git repositories into `.jaiph/libs/` under your workspace root. The CLI clones shallow copies, records them in a lockfile, and the compiler resolves imports after relative paths.

## Installing libraries

```bash
# Install a library
jaiph install https://github.com/you/queue-lib.git

# Install at a specific tag or branch
jaiph install https://github.com/you/queue-lib.git@v1.0

# Restore all libraries from lockfile (e.g. after git clone)
jaiph install
```

Installed libraries are tracked in `.jaiph/libs.lock` for reproducibility. Add `.jaiph/libs/` to your `.gitignore` and commit `.jaiph/libs.lock`.

## Importing from libraries

Use the `<lib-name>/<module-path>` convention in import statements:

```jaiph
import "queue-lib/queue" as queue

workflow default() {
  run queue.list("my-project")
}
```

The import resolver tries relative paths first (same as local modules), then falls back to `.jaiph/libs/`. See [CLI — `jaiph install`](cli.md#jaiph-install) for flags, lockfile format, and edge cases.

## Built-in libraries (`jaiphlang/`)

The `jaiphlang/` namespace ships with Jaiph and provides standard workflow utilities. These libraries live under `.jaiph/libs/jaiphlang/` and follow the same `import` + `export workflow` pattern as user-installed libraries.

### `jaiphlang/queue` — task queue management

Reads and modifies a `QUEUE.md` file in the workspace root. See the source at `.jaiph/libs/jaiphlang/queue.jh` for the full API.

### `jaiphlang/artifacts` — publishing files out of the sandbox

Copies files from inside the workflow sandbox (or host workspace) to `.jaiph/runs/<run_id>/artifacts/`, a host-readable location that survives sandbox teardown.

The runtime exposes `JAIPH_ARTIFACTS_DIR` pointing at the writable artifacts directory. The library reads this env var — it works identically inside the Docker sandbox and on the host.

```jaiph
import "jaiphlang/artifacts" as artifacts

workflow default() {
  # Copy a file into the artifacts directory under a chosen name.
  # Returns the absolute path of the saved artifact.
  const path = run artifacts.save("./build/output.bin", "build-output.bin")

  # Produce a git diff (excluding .jaiph/) and save it as a patch.
  # Returns the absolute path of the saved patch file.
  const patch = run artifacts.save_patch("snapshot.patch")

  # Apply a previously-saved patch to the current workspace.
  run artifacts.apply_patch(patch)
}
```

**Exported workflows:**

| Workflow | Description |
|---|---|
| `save(local_path, name)` | Copies the file at `local_path` into `${JAIPH_ARTIFACTS_DIR}/${name}`. Returns the host-resolved absolute path. |
| `save_patch(name)` | Runs `git diff` (working tree vs HEAD, excluding `.jaiph/`) and writes it to `${JAIPH_ARTIFACTS_DIR}/${name}`. Returns the absolute path. |
| `apply_patch(path)` | Applies a patch file to the current workspace via `git apply`. Fails with a clear error when the patch does not apply. |

**Notes:**
- `save_patch` excludes `.jaiph/` from the produced patch. The runtime writes its own state under `.jaiph/`; including it in a patch would clobber state on apply.
- When the workspace is clean, `save_patch` produces an empty file.
