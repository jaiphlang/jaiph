---
title: Runtime artifacts
permalink: /artifacts
redirect_from:
  - /artifacts.md
---

# Runtime artifacts

When you run a workflow or tests that execute workflows, Jaiph writes **durable** output under your project’s `.jaiph/runs/` tree. The CLI still shows **live** progress from a separate event stream (`__JAIPH_EVENT__` lines on the workflow process’s stderr); what follows is what lands on disk for logs, reports, and audit.

## Run directory layout

The runtime uses a UTC-dated hierarchy. Each run gets its own folder: date, then time plus the source file basename.

```
.jaiph/runs/
  <YYYY-MM-DD>/                       # UTC date (see NodeWorkflowRuntime)
    <HH-MM-SS>-<source-basename>/       # UTC time + JAIPH_SOURCE_FILE or entry basename
      000001-module__step.out          # stdout capture per step (seq-prefixed)
      000001-module__step.err          # stderr capture (when non-empty)
      inbox/                           # inbox message files (when channels are used)
      .seq                             # step-sequence counter (kernel/seq-alloc.ts)
      run_summary.jsonl                # durable event timeline
```

Sequence prefixes are **monotonic and unique** per run (allocated in the kernel), so artifact names sort in execution order. For how this fits into the CLI and kernel, see [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout).

## What each artifact is for

- **`*.out` / `*.err`** — Captured stdout and stderr for each managed step (scripts, prompts where applicable, etc.). Empty stderr files may be omitted.
- **`run_summary.jsonl`** — Append-only JSONL timeline: workflow boundaries, step start/end, structured log lines, inbox-related events. Useful for tooling and post-run analysis.
- **`inbox/`** — When you use channels, message payloads can be reflected as files under the run for inspection (see [Inbox & Dispatch](inbox.md)).
- **`.seq`** — Internal counter backing the numeric prefixes; you normally do not edit it.

## Keeping runs out of git

Run `jaiph init` to add `.jaiph/.gitignore` entries for `runs` and `tmp` under `.jaiph/`. You can mirror those paths in a root `.gitignore` if you prefer.

## Related

- **Live events** — The CLI consumes `__JAIPH_EVENT__` JSON on stderr; that channel is separate from the files above. See [Architecture — Contracts](architecture.md#contracts).
- **Implementation** — Parser, emitter, and kernel responsibilities: [Architecture](architecture.md).
