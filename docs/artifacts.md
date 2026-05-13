---
title: Runtime artifacts
permalink: /artifacts
redirect_from:
  - /artifacts.md
---

# Runtime artifacts

Workflow and test runners need two kinds of output: **what humans see right now** (progress, status) and **what is left behind** after the process exits (replay, diffs, CI reports). Jaiph keeps those separate: the **live** channel is `__JAIPH_EVENT__` JSON lines on the child process’s **stderr**; the **durable** side is a tree of files under the project workspace so you can inspect, diff, and archive a run after it finishes.

When you run a workflow, or `jaiph test` executes workflows inside test blocks, **`NodeWorkflowRuntime`** materializes that durable tree. By default it lives at `<workspace>/.jaiph/runs/`; you can point it elsewhere with `run.logs_dir` / `JAIPH_RUNS_DIR` (see [Configuration — Run keys](configuration.md#run-keys)). The layout below matches what `NodeWorkflowRuntime` creates at startup (see [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout) for where this fits in the overall pipeline). In Docker mode, paths inside recorded events may use container prefixes (`/jaiph/run/…`); the CLI maps them to host paths when reporting failures — see [Sandboxing — Path remapping](sandboxing.md#path-remapping).

## Run directory layout

The runtime uses a UTC-dated hierarchy. Each run gets its own folder: UTC date, then UTC time plus a basename derived from `JAIPH_SOURCE_FILE` when set, otherwise the entry module’s file basename.

```
.jaiph/runs/
  <YYYY-MM-DD>/                       # UTC date (see NodeWorkflowRuntime)
    <HH-MM-SS>-<source-basename>/       # UTC time + basename (see above)
      000001-module__step.out          # stdout capture per step (6-digit seq prefix)
      000001-module__step.err          # stderr capture (may be empty)
      artifacts/                       # user-published files (`jaiphlang/artifacts`); `JAIPH_ARTIFACTS_DIR`
      inbox/                           # audit copies of routed channel payloads (optional)
      heartbeat                        # liveness: epoch ms, refreshed about every 10s
      return_value.txt                 # present if `default` workflow exited 0 and returned a value
      run_summary.jsonl                # durable event timeline (JSON Lines)
```

Sequence numbers in those filenames are **monotonic and unique** per run. `RuntimeEventEmitter` owns a single in-memory counter (`allocStepSeq`) that advances whenever a step needs paired capture files — managed steps (`script`, nested `workflow` / `rule`, single-line `shell`, and similar) and `prompt` steps that write transcripts all draw from the same sequence. There is **no** `.seq` file in the run directory. For the live vs durable split, see [Architecture — Contracts](architecture.md#contracts): `__JAIPH_EVENT__` on stderr is the streaming path; `run_summary.jsonl` is the durable timeline.

## What each artifact is for

- **`*.out` / `*.err`** — Paired capture files for steps that record subprocess or prompt I/O. The runtime creates both paths at **`STEP_START`**. For **managed** steps (extracted scripts, nested workflows/rules, single-line `shell`, and similar), stdout/stderr are **streamed** into the files during execution, then **rewritten** with the final aggregated strings at step end — so a long-running step’s `.out` can be tailed while it runs (see [CLI — Run artifacts and live output](cli.md#run-artifacts-and-live-output)). **Prompt** steps stream the model transcript into `.out`; `.err` is only overwritten when stderr from the backend is non-empty (otherwise the placeholder file stays zero-length). **Errors and CLI progress** still use the live `__JAIPH_EVENT__` stream on stderr; these files are the on-disk record.

- **`run_summary.jsonl`** — Append-only JSON Lines timeline: workflow boundaries, step start/end, `LOG` / `LOGERR`, prompt lifecycle, inbox events, and the same step payload fields as the live stream. It is **truncated to empty at runtime startup**, then each event appends a line via `appendRunSummaryLine` as execution proceeds. **Note:** the in-process test runner can set `suppressLiveEvents`, which **stops** `__JAIPH_EVENT__` lines from going to stderr while **`run_summary.jsonl` keeps updating** (see [Architecture — Core components](architecture.md#core-components), `RuntimeEventEmitter`).

- **`inbox/`** — When channels are used, **routed** `send` steps may persist a copy of the payload here (`NNN-<channel>.txt`) for audit. Files are created **only if** the send resolves to a context that has dispatch routes for that channel (no file for unrouted sends — see `NodeWorkflowRuntime` send handling and [Inbox & Dispatch](inbox.md)). Delivery stays in-memory; this directory is not a mailbox API.

- **`heartbeat`** — Best-effort file containing a wall-clock millisecond timestamp, rewritten on a timer (~10s). Liveness for external watchdogs; not required for normal CLI use.

- **`return_value.txt`** — Written after a successful **`default`** workflow when `executeWorkflow` reports a defined `returnValue` (including `""`, which produces a zero-length file — distinct from “no file / no return”). **`runNamedWorkflow`** (used by `test_run_workflow` and similar) does not write this file by that path.

- **`artifacts/`** — Created before steps run. The runtime sets **`JAIPH_ARTIFACTS_DIR`**, **`JAIPH_RUN_DIR`**, **`JAIPH_RUN_SUMMARY_FILE`**, and **`JAIPH_RUN_ID`** (a new UUID when `JAIPH_RUN_ID` was not already set in the environment). User workflows usually publish into this directory through **`jaiphlang/artifacts`** (`artifacts.save`). In Docker mode it sits under the **host-writable** run mount (`/jaiph/run/...` inside the container), not the read-only workspace overlay. See [Libraries — `jaiphlang/artifacts`](libraries.md#jaiphlangartifacts--publishing-files-out-of-the-sandbox) and [Sandboxing](sandboxing.md).

## Keeping runs out of git

Run `jaiph init` to add `.jaiph/.gitignore` entries for `runs` and `tmp` under `.jaiph/`. You can mirror those paths in a root `.gitignore` if you prefer.
