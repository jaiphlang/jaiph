---
title: Runtime artifacts
permalink: /artifacts
redirect_from:
  - /artifacts.md
---

# Runtime artifacts

Workflow and test runners need two kinds of output: **what humans see right now** (progress, status) and **what is left behind** after the process exits (replay, diffs, CI reports). Jaiph keeps those separate: the **live** channel is `__JAIPH_EVENT__` JSON lines on the child process’s **stderr**; the **durable** side is a tree of files under the project workspace so you can inspect, diff, and archive a run after it finishes.

When you run a workflow, or `jaiph test` executes workflows inside test blocks, the **Node** workflow runtime materializes that durable tree. By default it lives at `<workspace>/.jaiph/runs/`; you can point it elsewhere with `run.logs_dir` / `JAIPH_RUNS_DIR` (see [Configuration — Run keys](configuration.md#run-keys)). The layout below is what `NodeWorkflowRuntime` writes.

## Run directory layout

The runtime uses a UTC-dated hierarchy. Each run gets its own folder: UTC date, then UTC time plus a basename derived from `JAIPH_SOURCE_FILE` when set, otherwise the entry module’s file basename.

```
.jaiph/runs/
  <YYYY-MM-DD>/                       # UTC date (see NodeWorkflowRuntime)
    <HH-MM-SS>-<source-basename>/       # UTC time + basename (see above)
      000001-module__step.out          # stdout capture per step (6-digit seq prefix)
      000001-module__step.err          # stderr capture (when non-empty)
      artifacts/                       # user-published files (`jaiphlang/artifacts`); `JAIPH_ARTIFACTS_DIR`
      inbox/                           # inbox message files (when channels are used)
      heartbeat                        # liveness: epoch ms, refreshed about every 10s
      return_value.txt                 # present if `default` workflow exited 0 and returned a value
      run_summary.jsonl                # durable event timeline (JSON Lines)
```

Sequence numbers in those filenames are **monotonic and unique** per run: a single in-memory counter in `NodeWorkflowRuntime` increments for each step capture. The separate `seq-alloc` helper is a **file-backed** allocator for tooling; ordinary runs do not use a `.seq` file in the run directory. For the full system picture, see [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout) and [Architecture — Contracts](architecture.md#contracts) (`__JAIPH_EVENT__` on stderr is the live path).

## What each artifact is for

- **`*.out` / `*.err`** — Per-step capture files for managed work (script subprocesses, nested workflows, rules, and prompt steps). **Stdout** is written to a `.out` file as the step runs; a **`.err` file appears when stderr is non-empty** (see [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout)). The live CLI stream is still separate: see [Architecture — Contracts](architecture.md#contracts).
- **`run_summary.jsonl`** — JSON Lines timeline mirroring what also goes to `__JAIPH_EVENT__` (where enabled): workflow boundaries, step start/end, log lines, inbox-related events. The file is created at runtime startup and lines are appended as the run progresses.
- **`inbox/`** — When you use channels, copies of message payloads can appear here for inspection (see [Inbox & Dispatch](inbox.md)).
- **`heartbeat`** — Best-effort file containing a wall-clock millisecond timestamp, rewritten on a timer (~10s). Liveness for external watchdogs; not required for normal CLI use.
- **`return_value.txt`** — Written after a successful `default` workflow when the workflow returns a value (including empty string, which yields a zero-length file so it is distinct from “no return”). Other entry paths (e.g. `test_run_workflow`) are not required to create this file.
- **`artifacts/`** — The runtime creates this directory in the run folder before execution and sets `JAIPH_ARTIFACTS_DIR` to it (along with `JAIPH_RUN_DIR`, `JAIPH_RUN_ID`, and `JAIPH_RUN_SUMMARY_FILE`). User code typically writes here via the `jaiphlang/artifacts` library (`artifacts.save`). In Docker mode this directory is under the **host-writable** run mount (`/jaiph/run/...` in the container), not the read-only workspace overlay. See [Libraries — `jaiphlang/artifacts`](libraries.md#jaiphlangartifacts--publishing-files-out-of-the-sandbox) and [Sandboxing](sandboxing.md).

## Keeping runs out of git

Run `jaiph init` to add `.jaiph/.gitignore` entries for `runs` and `tmp` under `.jaiph/`. You can mirror those paths in a root `.gitignore` if you prefer.
