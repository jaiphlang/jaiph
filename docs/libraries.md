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

## Standard library: workspace

The `jaiphlang/workspace` module provides primitives for branch outputs and patch management in candidate-style orchestration.

```jaiph
import "jaiphlang/workspace" as workspace
```

### `workspace.export_patch(name)`

Packages the branch's git changes into a patch file under the run artifact directory and returns the absolute path. The coordinator can read this path after the branch handle resolves.

**`.jaiph/` exclusion:** `export_patch` excludes the `.jaiph/` directory from the produced diff. Both the branch and the coordinator write run artifacts under `.jaiph/`; including those in the patch would clobber coordinator state on apply. Files written under `.jaiph/` inside a branch workspace will **not** appear in the exported patch.

### `workspace.export(local_path, name)`

Copies a file from `local_path` inside the branch workspace to the run artifact directory under the given `name`. Returns the absolute path readable by the coordinator.

### `workspace.apply_patch(path)`

Applies a patch file to the current workspace via `git apply`. This is a standard-library workflow, not a language primitive. The `path` argument is typically the return value from a prior `workspace.export_patch` call, resolved through a branch handle.

### Candidate pattern example

```jaiph
import "jaiphlang/workspace" as workspace

workflow implement_candidate(task, role, patch_name) {
  run implement(task, role)
  return run workspace.export_patch(patch_name)
}

workflow default() {
  const task = run queue.get_first_task()

  b1 = run async isolated implement_candidate(task, "surgical",   "candidate_surgical.patch")
  b2 = run async isolated implement_candidate(task, "optimizer",  "candidate_optimizer.patch")
  b3 = run async isolated implement_candidate(task, "stabilizer", "candidate_stabilizer.patch")

  const final = run isolated join_implementations(b1, b2, b3)
  run workspace.apply_patch(final)
}
```
