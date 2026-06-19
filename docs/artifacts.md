---
title: Save artifacts
permalink: /how-to/artifacts
diataxis: how-to
redirect_from:
  - /artifacts
  - /artifacts.md
---

# Save artifacts

This recipe publishes files from inside a workflow into the run's `artifacts/` directory so they persist on the host after a container exits.

The runtime always creates an `artifacts/` directory under the run log directory and exposes its absolute path as `JAIPH_ARTIFACTS_DIR`. The `jaiphlang/artifacts` library is the canonical way to copy files into that directory; you can also write there directly from a `script` step.

## Prerequisites

- A workspace with `.jaiph/libs/jaiphlang/` installed (`jaiph install jaiphlang`) if you want to use the library — see [Use & publish a library](/how-to/libraries).
- The file(s) you want to save exist by the time the `artifacts.save(...)` step runs.

## 1. Import the library

```jh
import "jaiphlang/artifacts" as artifacts
```

## 2. Save a single file

```jh
workflow default() {
  # ... produce ./build/output.bin somehow ...
  const dest = run artifacts.save("./build/output.bin")
  log "saved to ${dest}"
}
```

`save` copies the source path into `${JAIPH_ARTIFACTS_DIR}/...` preserving the relative layout (the leading `./` is stripped). Absolute source paths are copied using `basename` only. The workflow value is the absolute destination path.

## 3. Save several files at once

`save` accepts a **newline-separated** list of paths. Blank lines are ignored:

```jh
workflow default() {
  const paths = """
  a.txt
  b/nested.txt
  """
  const dests = run artifacts.save(paths)
  log "${dests}"
}
```

The returned value is the newline-separated list of absolute destination paths, in the same order.

## 4. (Alternative) Write directly from a script step

If you need full control of layout or names, write to `$JAIPH_ARTIFACTS_DIR` from a `script` step:

```jh
script save_report = ```
  mkdir -p "$JAIPH_ARTIFACTS_DIR/reports"
  cp ./report.html "$JAIPH_ARTIFACTS_DIR/reports/"
```

workflow default() {
  run save_report()
}
```

The runtime also sets `JAIPH_RUN_DIR`, `JAIPH_RUN_SUMMARY_FILE`, and `JAIPH_RUN_ID` if you need to write alongside the timeline.

## Verification

After the run, list the artifacts directory:

```bash
ls .jaiph/runs/<date>/<time>-<entry>/artifacts/
```

You should see the files your workflow saved. Under Docker sandboxing the path is the same — the artifacts mount (`/jaiph/run`) is bound to the host runs root, so files land on the host even though the run executed inside the container.

`artifacts.save(...)` exits with a failure when the input list is empty after trimming, when any source path is missing, or when `JAIPH_ARTIFACTS_DIR` is unset — wrap the call in `recover` / `catch` if you want the workflow to tolerate that.

## Related

- [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout) — the full run directory tree, including where `artifacts/` sits.
- [Use & publish a library](/how-to/libraries) — installing `jaiphlang/artifacts` and writing your own libraries.
- [Sandboxing](sandboxing.md) — why workspace edits are discarded but `artifacts/` persists.
