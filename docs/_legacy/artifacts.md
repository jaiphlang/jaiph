---
title: Runtime artifacts
permalink: /artifacts
redirect_from:
  - /artifacts.md
---

# Runtime artifacts

Long-running orchestration tools usually split **telemetry you watch while something runs** from **evidence you keep after it stops**. The first answers “what is happening now?”; the second answers “what happened, in enough detail to debug or audit later?” Jaiph does the same.

For Jaiph, **live** observation is the `__JAIPH_EVENT__` JSON line protocol on the workflow runner’s **stderr** (what the interactive CLI and [Hooks](hooks.md) consume). **Durable** observation is a directory tree on disk: step captures, an append-only summary timeline, optional inbox copies, and a writable `artifacts/` folder for anything workflows publish explicitly.

When you run a workflow, or `jaiph test` executes workflows inside test blocks, **`NodeWorkflowRuntime`** materializes that durable tree. **`jaiph run`** defaults to `<workspace>/.jaiph/runs/`; override with `run.logs_dir` or **`JAIPH_RUNS_DIR`** (see [Configuration — Run keys](configuration.md#run-keys)). The test runner uses its own ephemeral runs root under **`JAIPH_RUNS_DIR`** so normal workspace runs are not overwritten — see [Configuration — Testing with `jaiph test`](configuration.md#testing-with-jaiph-test). The layout below matches what the runtime creates in the constructor (see [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout)). In Docker mode, paths inside recorded events may use container prefixes (`/jaiph/run/…`); the CLI maps them to host paths when reporting failures — see [Sandboxing — Path remapping](sandboxing.md#path-remapping).

## Run directory layout

The runtime uses a UTC-dated hierarchy. Each run gets its own folder: UTC date, then UTC time plus a **basename** used only for naming (not a path): **`JAIPH_SOURCE_FILE`** when set in the environment (the CLI and `node-workflow-runner` set this to the entry file basename), otherwise `basename(graph.entryFile)` from the parsed graph.

```
.jaiph/runs/
  <YYYY-MM-DD>/                       # UTC date (see NodeWorkflowRuntime)
    <HH-MM-SS>-<source-basename>/       # UTC time + basename (see above)
      000001-module__step.out          # stdout capture per step (6-digit seq prefix)
      000001-module__step.err          # stderr capture (may be empty)
      artifacts/                       # user-published files (`jaiphlang/artifacts`); `JAIPH_ARTIFACTS_DIR`
      inbox/                           # audit copies of routed channel payloads (optional)
      heartbeat                        # liveness: epoch ms, refreshed about every 10s
      return_value.txt                 # `runDefault` only: status 0 and `returnValue` defined (may be "")
      run_summary.jsonl                # durable event timeline (JSON Lines)
```

Sequence numbers in those filenames are **monotonic and unique** per run. `RuntimeEventEmitter` owns a single in-memory counter (`allocStepSeq`) that advances whenever a step allocates paired capture files: **`executeManagedStep`** (nested **`workflow`** / **`rule`**, **`script`** references, inline scripts, and **`shell`** lines run via `sh -c`) plus **`prompt`** steps (which call `allocStepSeq` inside `emitPromptStepStart`). Ordinary **`log`**, **`logerr`**, **`fail`**, **`send`**, and most **`const`** bindings do **not** open new numbered `.out`/`.err` pairs — they still emit **`LOG`/`LOGERR`** or **`INBOX_ENQUEUE`** records (and related lines) into **`run_summary.jsonl`** where applicable. There is **no** `.seq` file in the run directory. For the live vs durable split, see [Architecture — Contracts](architecture.md#contracts): `__JAIPH_EVENT__` on stderr is the streaming path; `run_summary.jsonl` is the durable timeline.

## What each artifact is for

- **`*.out` / `*.err`** — Paired capture files for steps that record subprocess or prompt I/O. The runtime creates both paths at **`STEP_START`**. For **managed** steps (extracted scripts, nested workflows/rules, single-line `shell`, and similar), stdout/stderr are **streamed** into the files during execution, then **rewritten** with the final aggregated strings at step end — so a long-running step’s `.out` can be tailed while it runs (see [CLI — Run artifacts and live output](cli.md#run-artifacts-and-live-output)). **Prompt** steps stream the model transcript into `.out`; `.err` is only overwritten when stderr from the backend is non-empty (otherwise the placeholder file stays zero-length). **Errors and CLI progress** still use the live `__JAIPH_EVENT__` stream on stderr; these files are the on-disk record.

- **`run_summary.jsonl`** — Append-only JSON Lines timeline: workflow boundaries, step start/end, `LOG` / `LOGERR`, prompt lifecycle, inbox events, and the same step payload fields as the live stream. It is **truncated to empty at runtime startup**, then each event appends a line via `appendRunSummaryLine` as execution proceeds. The in-process test runner can set `suppressLiveEvents`, which **stops** `__JAIPH_EVENT__` lines from going to stderr while **`run_summary.jsonl` keeps updating** (see [Architecture — Core components](architecture.md#core-components), `RuntimeEventEmitter`).

- **`inbox/`** — When channels are used, a **`send`** may persist a copy of the payload here (`NNN-<channel>.txt`) for audit. The runtime walks ancestor workflow contexts and writes a file **only when it finds a matching route for that channel** on the stack (same condition as “routed” dispatch — see [Inbox & Dispatch](inbox.md)); unrouted sends enqueue without creating `inbox/` files. Delivery stays in-memory; this directory is not a mailbox API.

- **`heartbeat`** — Best-effort file containing a wall-clock millisecond timestamp, rewritten on a timer (~10s). Liveness for external watchdogs; not required for normal CLI use.

- **`return_value.txt`** — Written only from **`runDefault`** (the normal **`jaiph run`** entry path) when the top-level workflow finishes with **exit status 0** and the aggregated result has **`returnValue !== undefined`** (empty string is allowed and produces a zero-byte file; **`undefined`** means the file is omitted — typically “fell off the end” of the workflow without a **`return`**). **`runNamedWorkflow`** (`test_run_workflow`, nested named runs, etc.) returns the value to the caller but does **not** write this file.

- **`artifacts/`** — Created in the constructor together with the empty **`run_summary.jsonl`** (truncated file). The runtime sets **`JAIPH_ARTIFACTS_DIR`**, **`JAIPH_RUN_DIR`**, **`JAIPH_RUN_SUMMARY_FILE`**, and **`JAIPH_RUN_ID`**: if **`JAIPH_RUN_ID`** is already set in the incoming environment it is preserved; otherwise a new UUID is generated. User workflows usually publish into **`artifacts/`** through **`jaiphlang/artifacts`** (`artifacts.save`). In Docker mode it sits under the **host-writable** run mount (`/jaiph/run/...` inside the container), not the read-only workspace overlay. See [Libraries — `jaiphlang/artifacts`](libraries.md#jaiphlangartifacts--publishing-files-out-of-the-sandbox) and [Sandboxing](sandboxing.md).

## Keeping runs out of git

Run `jaiph init` to add `.jaiph/.gitignore` entries for `runs` and `tmp` under `.jaiph/`. You can mirror those paths in a root `.gitignore` if you prefer.
