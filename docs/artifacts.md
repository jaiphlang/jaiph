---
title: Save artifacts
permalink: /how-to/artifacts
diataxis: how-to
redirect_from:
  - /artifacts
  - /artifacts.md
---

# Save artifacts

This recipe publishes files from a workflow into the run's `artifacts/` directory under the run logs root (`.jaiph/runs/` by default). That is the supported export path when Docker sandboxing is on — in the default overlay and copy modes, workspace edits are discarded at container exit, but anything copied into `artifacts/` remains on the host.

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

`save` accepts a **newline-separated** list of paths. Blank or whitespace-only lines are ignored:

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

The runtime also sets `JAIPH_RUN_DIR`, `JAIPH_RUN_SUMMARY_FILE`, and `JAIPH_RUN_ID` on script steps if you need those paths.

## Verification

After the run, list the artifacts directory:

```bash
ls <runs_root>/<YYYY-MM-DD>/<HH-MM-SS>-<source>/artifacts/
```

Replace `<runs_root>` with `.jaiph/runs` when `JAIPH_RUNS_DIR` is unset, or with your configured runs directory otherwise. Date and time segments are UTC; `<source>` is the entry-file basename (or `JAIPH_SOURCE_FILE` when set). You should see the files your workflow saved. Under Docker sandboxing the host path is the same — the run mount at `/jaiph/run` inside the container is bound to the host runs root, so artifacts land on the host even though the run executed inside the container.

`artifacts.save(...)` exits with a failure when the input list is empty after trimming, when any listed path is missing or not a regular file, or when `JAIPH_ARTIFACTS_DIR` is unset — wrap the call in `recover` / `catch` if you want the workflow to tolerate that.

## Verify a run's integrity chain

Every line the runtime appends to `run_summary.jsonl` carries a `prev_hash` field — the SHA-256 of the previous raw line (or 64 zeroes for the first line). Rewriting or truncating any line breaks the hash of every line after it, so a verifier can detect tampering with a run's audit trail. See [Architecture — Hash chain](architecture.md#durable-artifact-layout) for the format.

To check a run directory, run this self-contained Node script against its `run_summary.jsonl` (no jaiph build required — it recomputes the chain the same way the runtime does):

```bash
node -e '
  const fs = require("fs"), crypto = require("crypto");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(l => l.trim());
  let expected = "0".repeat(64);
  for (let i = 0; i < lines.length; i++) {
    if (JSON.parse(lines[i]).prev_hash !== expected) {
      console.error(`line ${i + 1}: chain broken`); process.exit(1);
    }
    expected = crypto.createHash("sha256").update(lines[i], "utf8").digest("hex");
  }
  console.log(`chain intact (${lines.length} lines)`);
' <runs_root>/<YYYY-MM-DD>/<HH-MM-SS>-<source>/run_summary.jsonl
```

A clean chain prints `chain intact (N lines)` and exits `0`; a rewritten or truncated file prints the first broken line number and exits `1`. Inside the repo you can call the exported `verifyRunSummaryChain(filePath)` helper (`src/runtime/kernel/emit.ts`) instead, which returns `{ ok, error }`.

## Related

- [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout) — the full run directory tree, including where `artifacts/` sits, plus the hash chain and secret-redaction contracts for `run_summary.jsonl`.
- [Use & publish a library](/how-to/libraries) — installing `jaiphlang/artifacts` and writing your own libraries.
- [Sandboxing — The three sandbox modes](sandboxing.md#the-three-sandbox-modes) — overlay and copy discard workspace edits; artifacts persist on the host in every mode.
