---
title: Hooks
permalink: /hooks
redirect_from:
  - /hooks.md
---

# Jaiph Hooks

Workflows often need **side effects** — notifications, structured logging, CI integration — but that logic does not belong in `.jh` sources. **Hooks** solve this: they are optional shell commands the CLI runs at fixed points in the run lifecycle, configured in a single `hooks.json` file rather than scattered across workflows.

Under the hood, `jaiph run` follows a predictable path: prepare scripts, spawn the workflow runner (locally or in Docker), stream **`__JAIPH_EVENT__`** JSON lines from the runner’s stderr, then print PASS/FAIL. Hooks tap into that path. The CLI parses the same stderr events that drive the progress tree and builds a JSON payload for each hook command. Hooks live entirely in the **CLI** (they are not executed by `NodeWorkflowRuntime`); channels and inbox dispatch are runtime concerns. See [Architecture — Runtime vs CLI responsibilities](architecture.md#runtime-vs-cli-responsibilities) and [Architecture — Channels and hooks in context](architecture.md#channels-and-hooks-in-context).

Hooks run only for normal **`jaiph run`** (including the `jaiph <file.jh>` shorthand). They are **not** triggered by `jaiph test`, `jaiph init`, `jaiph compile`, or other commands. **`jaiph run --raw`** also skips hooks (along with the banner, progress tree, and failure footer); that path exists so another process can consume stderr unchanged — for example the host CLI when Docker runs `jaiph run --raw` inside the container. See the **`--raw`** bullet under [CLI — `jaiph run`](cli.md#jaiph-run).

For local runs, hooks use the same machine as the workflow. For **Docker-backed** runs, hook commands still execute on the **host** CLI process (not inside the container); see [Sandboxing — Runtime behavior](sandboxing.md#runtime-behavior).

## Config locations

| Scope | Path |
|-------|------|
| Global | `~/.jaiph/hooks.json` |
| Project-local | `<workspace>/.jaiph/hooks.json` |

Both files are optional. `<workspace>` is resolved using the same rules as `JAIPH_WORKSPACE` for `jaiph run`: walk up from the entry `.jh` file’s directory, with guards for temp directories and nested sandboxes. Full rules: [CLI — Environment variables](cli.md#environment-variables).

Configuration uses **per-event override** precedence: if the project file lists at least one non-empty command for an event, those commands run and the global ones for that event are ignored. Lists are not merged. If neither file defines an event, nothing runs for it.

## Schema

Each file must be a single JSON **object** at the root (not an array) mapping **event names** to **arrays of shell commands**:

- Keys must be supported event names (see [Supported events](#supported-events)). Unknown keys are ignored.
- Values must be arrays. A non-array value for a known key is treated as absent for that event.
- Array elements must be non-empty strings (one shell command each). Empty strings and non-string elements are skipped. An array of only empty strings is normalized away, so that event falls back to the other config file per [Precedence](#precedence).
- Commands for an event are all spawned without waiting for the previous hook to finish; spawn order follows the array order (see [Behavior](#behavior)).

```json
{
  "workflow_start": ["echo 'run started'"],
  "workflow_end": ["curl -s -X POST https://example.com/jaiph/end -d @-"],
  "step_start": [],
  "step_end": ["jq -c . >> \"$HOME/.jaiph/step-events.jsonl\""]
}
```

An empty array (or omitting the key) means “no commands from this file for this event,” so resolution falls back to global hooks when the project file does not override that event (see [Precedence](#precedence)).

## Supported events

| Event | When it fires |
|-------|---------------|
| `workflow_start` | After **`buildScripts`** completes (parse, **`validateReferences`**, script extraction to `scripts/`) and **before** the runner subprocess is spawned. Does not fire if compilation fails. |
| `workflow_end` | After the runner subprocess exits (any status), **before** the CLI prints PASS/FAIL. |
| `step_start` | When the CLI observes a step-start event on the runner's stderr stream. |
| `step_end` | When the CLI observes a step-end event on that stream. |

Step kinds correspond to the runtime step types: `workflow`, `rule`, `script`, and `prompt`. Step hooks are driven by the same `__JAIPH_EVENT__` stderr stream as the progress tree; see [CLI — Run progress and tree output](cli.md#run-progress-and-tree-output).

## Precedence

Resolution happens **per event**, independently:

- Project file has `workflow_end` with at least one non-empty command — only those commands run; global `workflow_end` is ignored.
- Project file omits `workflow_end` or uses an empty array — global `workflow_end` commands run (if any).
- Overriding `step_end` in the project file has no effect on how `workflow_start` is resolved.

There is no explicit “disable” mechanism. Omitting an event or using `[]` means “fall back to global.” To suppress a global hook for one project, override that event with a no-op: `"workflow_end": ["true"]`.

## Payload

Each command receives a single JSON object on **stdin** (UTF-8). Parse it with `jq`, `python3 -c`, or any tool you prefer. Stdin can only be read once — if your command needs the payload more than once, capture it in a variable first (see [Examples](#examples)).

### Fields

| Field | Present in | Description |
|-------|------------|-------------|
| `event` | all | Event name: `workflow_start`, `workflow_end`, `step_start`, or `step_end`. |
| `workflow_id` | all | Runtime run id (`run_id` from step events on the stderr stream). Empty on `workflow_start`. For `workflow_end`, the CLI reuses the first non-empty `run_id` it saw on a step event (empty if the runner never emitted one). `step_start` / `step_end` pass through the `run_id` from each event (usually the same value once the run is underway). |
| `timestamp` | all | ISO 8601 timestamp (from the CLI or runtime event). |
| `run_path` | all | Absolute path to the `.jh` file being run. |
| `workspace` | all | Workspace root directory (same rules as [Config locations](#config-locations)). |
| `step_id` | `step_*` | Step id used for progress and log paths. Usually the runtime’s `id`; if empty, the CLI synthesizes a stable `legacy:…` id so starts and ends match. |
| `step_kind` | `step_*` | `workflow`, `rule`, `script`, or `prompt`. |
| `step_name` | `step_*` | Step name (e.g. `default`, `scan_passes`). |
| `status` | `*_end` | Exit status: 0 = success, non-zero = failure. For `workflow_end`, non-zero if the subprocess exited non-zero **or** the CLI detected a fatal error on stderr (see [CLI](cli.md)). |
| `elapsed_ms` | `*_end` | Milliseconds elapsed: total wall time (`workflow_end`) or step duration (`step_end`). |
| `run_dir` | `workflow_end` | Absolute path to the run’s log directory (from runner metadata). Omitted if metadata is missing. |
| `summary_file` | `workflow_end` | Absolute path to `run_summary.jsonl` (from runner metadata). See [CLI — Run summary](cli.md#run-summary-jsonl). Omitted if unavailable. |
| `out_file` | `step_end` | Step stdout log path, if the file was non-empty. Omitted otherwise. |
| `err_file` | `step_end` | Step stderr log path, if the file was non-empty. Omitted otherwise. |

### Payload by event

- **`workflow_start`** — `event`, `workflow_id` (empty), `timestamp`, `run_path`, `workspace`.
- **`step_start`** — `workflow_id`, `timestamp`, `run_path`, `workspace`, plus `step_id`, `step_kind`, `step_name`.
- **`step_end`** — same base fields as `step_start`, plus `status`, `elapsed_ms`, and optionally `out_file` / `err_file`.
- **`workflow_end`** — `event`, `workflow_id`, `status`, `elapsed_ms`, `timestamp`, `run_path`, `workspace`, and optionally `run_dir` / `summary_file`.

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
  "out_file": "/repo/.jaiph/runs/.../step.out",
  "err_file": "/repo/.jaiph/runs/.../step.err"
}
```

## Behavior

- **Shell:** Each command runs as `sh -c '<command>'` (POSIX `sh` on the **`PATH`** of the `jaiph run` process).
- **Concurrency:** All commands for a single event are started in sequence without awaiting completion, so they overlap in wall time. Lifecycle order is still respected: `workflow_start`, then step hooks as events arrive, then `workflow_end` before PASS/FAIL.
- **Best-effort:** Hook failures never change the CLI exit code. Non-zero exits or spawn errors produce a `jaiph hooks: ...` line on stderr; the workflow result is unchanged.
- **I/O:** Hook stdout is discarded. Hook stderr is forwarded to the CLI’s stderr. The JSON payload is written once to each hook’s stdin (`utf8`); if the process exits before reading stdin, delivery is best-effort and may log an error.
- **Environment:** Hooks receive a shallow copy of the parent process environment (same keys and values as `jaiph run` at spawn time).
- **Working directory:** Hooks run with the **current working directory** of the `jaiph run` process (often the directory you launched the CLI from), **not** necessarily the workspace root. To write paths under the project, read the `workspace` field from stdin (see [Examples](#examples)).
- **Invalid config:** Missing files are silently skipped. If a file exists but fails `JSON.parse` or is not a JSON object, the CLI prints a warning on stderr and ignores that file. Bad per-event values (non-array, empty strings) are skipped without rejecting the rest of the file.

Payload shapes for tooling are also declared in TypeScript as **`HookPayload`** / **`HookEventName`** in `src/types.ts`.

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

Note that stdin can only be read once per process. The `workflow_end` command stores the payload in `p` so it can pipe it to multiple `jq` invocations. The `step_end` command reads stdin once via a single `jq` call.

The `step_end` example writes to a fixed path under `$HOME` so it does not depend on where `jaiph run` was invoked. The `workflow_end` example writes relative to the project using the `workspace` field from the payload.

**Project overrides global:** If global defines `workflow_end: ["global-notify.sh"]` and the project defines `workflow_end: ["project-notify.sh"]`, only `project-notify.sh` runs.
