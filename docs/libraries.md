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
