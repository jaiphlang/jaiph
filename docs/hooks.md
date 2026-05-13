---
title: Hooks
permalink: /hooks
redirect_from:
  - /hooks.md
---

# Hooks

Many workflows trigger **integrations** you do not want to hard-code in `.jh` sources: notifications, structured logging, CI callbacks. **Hooks** are optional shell commands the CLI runs at fixed lifecycle points. Configuration lives in `hooks.json` (global or per-project), so side effects stay out of workflow modules and can be shared across runs.

Hooks are **CLI-only**: they are *not* part of `NodeWorkflowRuntime`. The same **`__JAIPH_EVENT__`** JSON lines on stderr that drive the progress tree are parsed in the CLI; hook commands receive a JSON snapshot of each event on stdin. Channels and inbox behavior remain runtime concerns. See [Architecture — Runtime vs CLI responsibilities](architecture.md#runtime-vs-cli-responsibilities) and [Architecture — Channels and hooks in context](architecture.md#channels-and-hooks-in-context). The live event contract is summarized under [Architecture — Contracts](architecture.md#contracts).

## When hooks run

Hooks run only for normal **`jaiph run`**, including the shorthand **`jaiph <file.jh>`** (same code path as `jaiph run`). The entry file must be a **non-test** `.jh` file (`src/cli/index.ts` routes `*.test.jh` to `jaiph test` instead).

Hooks do **not** run for `jaiph test`, `jaiph init`, `jaiph compile`, `jaiph format`, or other commands. **`jaiph run --raw`** skips hooks (and the banner, progress tree, and failure footer) so stderr stays a clean `__JAIPH_EVENT__` stream—used when the host CLI wraps Docker or another embedding. See [CLI — `jaiph run`](cli.md#jaiph-run).

For local runs, hooks use the same machine as the workflow. For **Docker-backed** runs, hook commands still execute on the **host** CLI process, not inside the container. See [Sandboxing — Runtime behavior](sandboxing.md#runtime-behavior).

## Config locations

| Scope | Path |
|-------|------|
| Global | `~/.jaiph/hooks.json` |
| Project-local | `<workspace>/.jaiph/hooks.json` |

Both files are optional. `<workspace>` is resolved the same way as `JAIPH_WORKSPACE` for `jaiph run`: walk up from the entry `.jh` file’s directory, with guards for temp directories and nested sandboxes. Full rules: [CLI — Environment variables](cli.md#environment-variables).

**Precedence (per event):** If the project file defines at least one non-empty command for an event, only those commands run and global commands for that event are ignored. Lists are not merged. If the project file omits an event or only has empty/invalid entries for it, global commands apply for that event. Unsupported keys in the JSON object are ignored (see [Schema](#schema)).

## Schema

Each file must be a single JSON **object** at the root (not an array) mapping **event names** to **arrays of shell commands**:

- Keys must be supported event names (see [Supported events](#supported-events)).
- Values must be arrays. A non-array value for a known key is skipped for that event.
- Elements must be non-empty strings (one shell command each). Empty strings and non-string elements are skipped. If every element is skipped, that event is not defined in the normalized config, so the other file’s commands can apply (see [Precedence](#precedence)).

```json
{
  "workflow_start": ["echo 'run started'"],
  "workflow_end": ["curl -s -X POST https://example.com/jaiph/end -d @-"],
  "step_start": [],
  "step_end": ["jq -c . >> \"$HOME/.jaiph/step-events.jsonl\""]
}
```

An empty array normalizes to “no commands from this file for this event,” so resolution falls back to the other config file when the project file does not override that event.

## Supported events

| Event | When it fires |
|-------|---------------|
| `workflow_start` | After **`buildScripts`** completes (parse, **`validateReferences`**, script extraction to `scripts/`) on the CLI host, and **before** the workflow runner subprocess is spawned. Does not fire if compilation fails earlier. Emitted via `emitter.emit` in `src/cli/commands/run.ts` after subscribers are registered. |
| `workflow_end` | After the runner exits (any status) and stderr has been drained, in **`reportResult`**—**before** the CLI prints PASS/FAIL. |
| `step_start` | When the CLI parses a `STEP_START` line on the runner’s stderr (same stream as the progress tree). Includes nested steps; the root `workflow default` step still emits `STEP_START` even though the TTY view skips drawing that start row (`registerTTYSubscriber` in `src/cli/run/stderr-handler.ts`). |
| `step_end` | When the CLI parses a matching `STEP_END` line on that stream. |

Step `kind` values come from the runtime event payload (`workflow`, `rule`, `script`, `prompt`). See [CLI — Run progress and tree output](cli.md#run-progress-and-tree-output).

## Precedence

Resolution is **per event**, independently:

- Project `workflow_end` with at least one usable command — only those run; global `workflow_end` is ignored.
- Project omits `workflow_end` or supplies `[]` / only skipped commands — global `workflow_end` runs (if any).
- Changing `step_end` in the project file does not affect how `workflow_start` is resolved.

There is no explicit “disable hooks” flag. To silence a global hook for one project, override that event with a no-op, e.g. `"workflow_end": ["true"]`.

## Payload

Each command receives one JSON object on **stdin** (UTF-8). Parse with `jq`, `python3 -c`, or your tool of choice. Stdin can only be read once per process; buffer it in a variable if you need the payload multiple times (see [Examples](#examples)).

### Fields

| Field | Present in | Description |
|-------|------------|-------------|
| `event` | all | `workflow_start`, `workflow_end`, `step_start`, or `step_end`. |
| `workflow_id` | all | Runtime `run_id` from each `STEP_*` line. Empty on `workflow_start`. For `workflow_end`, the CLI reuses the first non-empty `run_id` it buffered while parsing stderr (`workflowRunId` in `RunState`, `src/cli/run/stderr-handler.ts`); it stays empty if the runner never emitted one. `step_start` / `step_end` echo the `run_id` from that event. |
| `timestamp` | all | ISO 8601 string. For `step_*`, the event’s `ts` when non-empty; otherwise the CLI synthesizes one at hook time. `workflow_start` and `workflow_end` timestamps come from the CLI when those hooks fire. |
| `run_path` | all | Absolute path to the `.jh` entry file. |
| `workspace` | all | Workspace root directory (same rules as [Config locations](#config-locations)). |
| `step_id` | `step_*` | Step id for progress and captures; from the event’s `id`, or a synthesized `legacy:…` value when the runtime left `id` empty so starts and ends still pair (`resolveEventId` in `src/cli/run/stderr-handler.ts`). |
| `step_kind` | `step_*` | `workflow`, `rule`, `script`, or `prompt`. |
| `step_name` | `step_*` | Step name (e.g. `default`, `scan_passes`). |
| `status` | `*_end` | **Step:** exit status from the `STEP_END` event (0 success, non-zero failure; missing status is treated as `1` in the hook payload). **Workflow:** the CLI’s resolved outcome—**`0` success or `1` failure** (not the raw child exit code): non-zero subprocess exit or `hasFatalRuntimeStderr` yields `1` (`reportResult` in `src/cli/commands/run.ts`). |
| `elapsed_ms` | `*_end` | **`workflow_end`:** wall-clock ms from when the CLI recorded `startedAt` (inside the main `try` after the output dir exists—so **after** module metadata is read and the scratch/target directory is created, and **including** banner, **`buildScripts`**, the full runner lifetime, and stderr drain) until the hook runs. **`step_end`:** duration from the `STEP_END` event, or `0` if missing. |
| `run_dir` | `workflow_end` | Absolute run log directory from runner metadata (or Docker discovery). Omitted if unavailable. |
| `summary_file` | `workflow_end` | Absolute path to `run_summary.jsonl` when metadata provides it. See [CLI — Run summary](cli.md#run-summary-jsonl). |
| `out_file` | `step_end` | Stdout capture path from the `STEP_END` event. The hook omits this JSON key when the parsed event has an empty `out_file` string (`registerHooksSubscriber` in `src/cli/run/hooks.ts`). Current runtimes normally emit paths for every completed step; files may still be empty. |
| `err_file` | `step_end` | Stderr capture path; same omission rule as `out_file`. |

### Payload by event

- **`workflow_start`** — `event`, `workflow_id` (empty string), `timestamp`, `run_path`, `workspace`.
- **`step_start`** — `event`, `workflow_id`, `timestamp`, `run_path`, `workspace`, `step_id`, `step_kind`, `step_name`.
- **`step_end`** — same base as `step_start`, plus `status`, `elapsed_ms`, and optionally `out_file` / `err_file`.
- **`workflow_end`** — `event`, `workflow_id`, `status` (0 or 1), `elapsed_ms`, `timestamp`, `run_path`, `workspace`, and optionally `run_dir` / `summary_file`.

Example payload (`step_end`):

```json
{
  "event": "step_end",
  "workflow_id": "abc-123",
  "step_id": "run:1:1",
  "step_kind": "workflow",
  "step_name": "default",
  "status": 0,
  "timestamp": "2026-03-11T12:00:00.000Z",
  "elapsed_ms": 1500,
  "run_path": "/repo/flows/ci.jh",
  "workspace": "/repo",
  "out_file": "/repo/.jaiph/runs/2026-03-11/12-00-00-ci/000001-ci__step.out",
  "err_file": "/repo/.jaiph/runs/2026-03-11/12-00-00-ci/000001-ci__step.err"
}
```

## Behavior

- **Shell:** Each command runs as `sh -c '<command>'` (POSIX `sh` on the **`PATH`** of the `jaiph run` process).
- **Concurrency:** Every command for one event is spawned in a loop **without** waiting for the previous process to exit, so hook commands for the same event overlap in wall time. Ordering across lifecycle stages is still `workflow_start` → step hooks as lines arrive → `workflow_end` before PASS/FAIL.
- **Best-effort:** Hook failures never change the CLI exit code. Non-zero exits or spawn errors log `jaiph hooks: …` lines on stderr; the workflow result is unchanged.
- **I/O:** Hook stdout is discarded. Hook stderr is copied to the CLI’s stderr. The JSON payload is written with `stdin.end(payloadJson, "utf8")` per process; if a hook exits before reading stdin, delivery is best-effort and may log an error.
- **Environment:** Hooks receive a shallow copy of `process.env` at hook spawn time.
- **Working directory:** The child’s cwd is **not** reset by the hook runner—it inherits the **`jaiph run` process cwd** (often where you launched the CLI), not necessarily `workspace`. Use the `workspace` field from stdin for project-root paths.

**Invalid or missing config:** Missing files are skipped silently. A file that exists but fails `JSON.parse` or is not a JSON object produces a stderr warning and is ignored. Bad per-event values are skipped without rejecting the rest of the file (`parseHookConfig` in `src/cli/run/hooks.ts`).

Shape definitions in repo: **`HookPayload`** / **`HookEventName`** in `src/types.ts`.

## Examples

**Global `~/.jaiph/hooks.json` — POST the workflow-end payload to an HTTP endpoint:**

```json
{
  "workflow_end": ["curl -s -X POST https://example.com/jaiph/end -d @-"]
}
```

**Project `.jaiph/hooks.json` — append a one-line JSON record per finished step, and log each workflow end under the workspace:**

```json
{
  "step_end": ["jq -c '{event,step_kind,step_name,status,elapsed_ms}' >> \"$HOME/.jaiph/step-events.jsonl\""],
  "workflow_end": ["p=$(cat); echo \"$p\" | jq -c '{event,status,run_dir,summary_file}' >> \"$(echo \"$p\" | jq -r .workspace)/.jaiph/workflow-ends.jsonl\""]
}
```

Stdin is one-shot per process. The `workflow_end` command stores the payload in `p` so it can feed multiple `jq` invocations. The `step_end` line reads stdin once inside a single `jq` pipeline.

The `step_end` example uses `$HOME` so it does not depend on the shell cwd. The `workflow_end` line resolves the log path via the payload’s `workspace` field.

**Project overrides global:** If global defines `workflow_end: ["global-notify.sh"]` and the project defines `workflow_end: ["project-notify.sh"]`, only `project-notify.sh` runs.
