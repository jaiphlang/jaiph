---
title: Save artifacts
permalink: /how-to/artifacts
diataxis: how-to
redirect_from:
  - /artifacts
  - /artifacts.md
---

# Save artifacts

This guide shows how to publish files from a def into the run's `artifacts/` directory. Each run gets its own directory under the runs root (`.jaiph/runs/` by default), and `artifacts/` sits inside that run directory. Copying files into `artifacts/` is the supported way to export them from a run.

The runtime always creates the `artifacts/` directory and exposes its absolute path as `JAIPH_ARTIFACTS_DIR`. The `jaiphlang/artifacts` library is the standard way to copy files into that directory, and you can also write there directly from a `script` step.

## Prerequisites

- A workspace with `.jaiph/libs/jaiphlang/` installed (`jaiph install jaiphlang`) if you want to use the library. See [Use & publish a library](libraries.md).
- The file(s) you want to save exist by the time the `artifacts.save(...)` step runs.

## 1. Import the library

```jh
import "jaiphlang/artifacts" as artifacts
```

## 2. Save a single file

```jh
export def main() {
  # ... produce ./build/output.bin somehow ...
  const dest = run artifacts.save("./build/output.bin")
  log "saved to ${dest}"
}
```

`save` copies the source path into `${JAIPH_ARTIFACTS_DIR}/...` preserving the relative layout (the leading `./` is stripped). Absolute source paths are copied using `basename` only. The `run` step returns the absolute destination path.

## 3. Save several files at once

`save` accepts a newline-separated list of paths. Blank or whitespace-only lines are ignored:

```jh
export def main() {
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

export def main() {
  run save_report()
}
```

The runtime also sets `JAIPH_RUN_DIR`, `JAIPH_RUN_SUMMARY_FILE`, and `JAIPH_RUN_ID` for script steps, so you can read the run directory, the summary file, or the run id when you need them.

## Verification

After the run, list the artifacts directory:

```bash
ls <runs_root>/<YYYY-MM-DD>/<HH-MM-SS>-<source>/artifacts/
```

Replace `<runs_root>` with `.jaiph/runs` when `JAIPH_RUNS_DIR` is unset, or with your configured runs directory otherwise. The date and time segments are UTC, and `<source>` is the entry-file basename (or `JAIPH_SOURCE_FILE` when set). You should see the files your program saved.

`artifacts.save(...)` fails when the input list is empty after trimming, when any listed path is missing or not a regular file, or when `JAIPH_ARTIFACTS_DIR` is unset. Wrap the call in `recover` or `catch` if you want the def to tolerate that failure.

## Verify a run's integrity chain

Every line the runtime appends to `run_summary.jsonl` carries a `prev_hash` field. The field holds a **keyed** HMAC-SHA256 of the previous raw line (keyed genesis for the first line), computed under a per-run secret the audited program never sees. Rewriting a line, or dropping a line and re-linking the survivors, breaks the chain and cannot be re-forged without the key, so you can detect tampering with a run's audit trail. The key is persisted once the run finishes. It is **not** stored in the run directory, which the program can write to. It is stored in an operator-side store instead (`~/.jaiph/audit-keys` by default, or the directory in `JAIPH_AUDIT_KEY_DIR`), keyed by the run directory's identity. See [Architecture, keyed hash chain](architecture.md#hash-chain) for the full contract, including the key-isolation and read/export-boundary guarantees.

To check a run directory, run this self-contained Node script. It resolves the run's key from the operator store, where the `sha256` of the run directory's canonical path names its entry. It then recomputes the keyed chain the same way the runtime does and confirms the journal still ends with its `RUN_END` terminal marker. No jaiph build is required:

```bash
node -e '
  const fs = require("fs"), crypto = require("crypto"), path = require("path"), os = require("os");
  const dir = fs.realpathSync(process.argv[1]);
  const store = process.env.JAIPH_AUDIT_KEY_DIR || path.join(os.homedir(), ".jaiph", "audit-keys");
  const id = crypto.createHash("sha256").update(dir, "utf8").digest("hex");
  const key = fs.readFileSync(path.join(store, id, "key"), "utf8").trim();
  const hmac = (s) => crypto.createHmac("sha256", key).update(s, "utf8").digest("hex");
  const lines = fs.readFileSync(path.join(dir, "run_summary.jsonl"), "utf8").split("\n").filter(l => l.trim());
  let expected = hmac("0".repeat(64));
  for (let i = 0; i < lines.length; i++) {
    if (JSON.parse(lines[i]).prev_hash !== expected) {
      console.error(`line ${i + 1}: chain broken`); process.exit(1);
    }
    expected = hmac(lines[i]);
  }
  const lastType = lines.length ? JSON.parse(lines[lines.length - 1]).type : null;
  if (lastType !== "RUN_END") {
    console.error(`journal not terminal: last event is ${lastType} (truncated after run end?)`); process.exit(1);
  }
  console.log(`chain intact and terminal (${lines.length} lines)`);
' <runs_root>/<YYYY-MM-DD>/<HH-MM-SS>-<source>/
```

A clean, complete journal prints `chain intact and terminal (N lines)` and exits `0`. A rewritten file prints the first broken line number and exits `1`. A completed journal whose last lines were deleted after the run ended prints that it is not terminal and exits `1`. The chain commits to prefix integrity but not to length, so a shorter journal that still links correctly is caught only by the missing `RUN_END` marker (finding L-3). Inside the repo you can call the exported `verifyRunSummaryChain(filePath, key, opts?)` helper (`src/runtime/kernel/emit.ts`) directly, or `verifyRunJournal(runDir)`, which resolves the key from the store for you, requires the terminal marker, and returns `{ verified, ok, error }`. A run with no store entry (an unkeyed or legacy run) cannot be verified and is never blocked. A run that **was** keyed but whose key is missing fails closed (`verified: true, ok: false`).

## Related

- [Architecture, durable artifact layout](architecture.md#durable-artifact-layout). The full run directory tree, including where `artifacts/` sits, plus the hash chain and secret-redaction contracts for `run_summary.jsonl`.
- [Use & publish a library](libraries.md). Installing `jaiphlang/artifacts` and writing your own libraries.
- [CLI](cli.md). The `jaiph run` artifacts layout.
