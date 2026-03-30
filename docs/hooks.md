---
title: Hooks
permalink: /hooks
redirect_from:
  - /hooks.md
---

# Jaiph Hooks

When you run a workflow, you often want **side effects**—notifications, structured logging, CI integration—without putting that logic in `.jh` sources. **Hooks** are optional shell commands the **CLI** runs at fixed points in the run lifecycle so you can wire those integrations in one place (`hooks.json`) instead of editing workflows.

Concretely: `jaiph run` follows a predictable path—prepare scripts, start the workflow runner (locally or in Docker), stream **`__JAIPH_EVENT__`** JSON lines from the runner’s **stderr**, then print PASS/FAIL. Hooks plug into that path: the CLI uses the **same parsed stderr events** that drive the progress tree and builds JSON payloads for your commands (see [Architecture — Runtime vs CLI responsibilities](../ARCHITECTURE.md#runtime-vs-cli-responsibilities)). This is **not** part of the Node workflow runtime; channel send/receive and inbox dispatch are separate mechanisms ([Inbox & Dispatch](inbox.md)).

Hooks run only for **`jaiph run`** (including the `jaiph <file.jh>` shorthand). They are **not** used by `jaiph test`, `jaiph report`, `jaiph init`, or other commands.

Configuration comes from **global** and **project-local** `hooks.json` files. For each event name, if the project file lists at least one non-empty command, those commands are used and global commands for that event are ignored (lists are not merged). If neither file exists, or both omit an event, nothing runs for that event.

**Local and Docker:** Hooks apply to normal `jaiph run` and to Docker-backed `jaiph run` — the same CLI path runs `workflow_start` after script preparation and **before** the runner subprocess or container starts; step hooks follow events from the runner’s stderr.

## Config locations

- **Global:** `~/.jaiph/hooks.json`
- **Project-local:** `<workspace>/.jaiph/hooks.json`

The **workspace** root is how Jaiph resolves `<workspace>` for project hooks (and matches the `workspace` field in hook payloads). It uses the same rules as **`JAIPH_WORKSPACE`** for `jaiph run`: walk up from the entry `.jh` file’s directory, with guards for temp directories and nested sandboxes. Full rules: [CLI — Environment variables](cli.md#environment-variables) (`JAIPH_WORKSPACE` bullet).

Both hook files are optional.

## Schema

Each file is a single JSON **object**. Keys must be supported **event names** (see below). Each value must be a JSON **array**; a non-array value for a known key is ignored for that key only. Array elements must be **non-empty strings** (each string is one shell command); other element types and empty strings are skipped. **Unknown top-level keys** are ignored. Commands for an event are **spawned** in array order; each process is started without waiting for the others in that list (see [Behavior](#behavior)).

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

| Event | When it runs |
|-------|----------------|
| `workflow_start` | After the entry `.jh` file parses and **`buildScripts`** completes successfully (compile-time validation and script extraction), and **before** the CLI spawns the workflow runner (local process or Docker). If parse, validation, or script preparation fails, this event does not run. |
| `workflow_end` | After the workflow subprocess has exited (any status). Runs **before** the CLI prints its final PASS/FAIL line. |
| `step_start` | When the CLI observes a step start on the runtime stderr event stream. |
| `step_end` | When the CLI observes a step end on that stream. |

Step kinds match the runtime (`workflow`, `rule`, `script`, `prompt`). Step hooks use the same stderr **`__JAIPH_EVENT__`** stream as the progress tree; see [CLI — Run progress and tree output](cli.md#run-progress-and-tree-output).

## Precedence

For each event, **project-local** commands override **global** commands:

- If project `.jaiph/hooks.json` defines `workflow_end` with at least one non-empty command, only those commands run for `workflow_end` (global `workflow_end` is ignored).
- If the project file has no `workflow_end` key, or only an empty array, global `workflow_end` commands run (if any).
- Other events are independent: e.g. project `step_end` does not change how `workflow_start` is resolved.

There is no way to explicitly disable a global hook from a project file alone. Omitting an event or using `[]` means “fall back to global.” To suppress a global hook for one project, override that event with a no-op (e.g. `"workflow_end": ["true"]`).

## Payload

Each command receives one JSON object on **stdin** (UTF-8). Use `jq`, `python3 -c`, or any parser you like.

### Fields

| Field | Present | Description |
|-------|---------|-------------|
| `event` | Always | `workflow_start`, `workflow_end`, `step_start`, or `step_end`. |
| `workflow_id` | Always | Runtime run id from step events (`run_id` on **`__JAIPH_EVENT__`**). **Empty string** on `workflow_start`. For `workflow_end`, the CLI keeps the first non-empty `run_id` seen during the run (still empty if the runtime never sent one). For step events, whatever the runtime sent on that step (may be empty early in the run). |
| `step_id` | `step_*` | Step id the CLI uses for progress and log paths (usually the runtime’s `id`; if that is empty, the CLI may synthesize a stable `legacy:…` id so starts and ends still match). |
| `step_kind` | `step_*` | `workflow`, `rule`, `script`, or `prompt`. |
| `step_name` | `step_*` | Step name (e.g. `default`, `scan_passes`). |
| `status` | `workflow_end`, `step_end` | Exit status: **0** success, **non-zero** failure. For `workflow_end`, this is the CLI’s resolved outcome: non-zero if the subprocess exited non-zero **or** the CLI detected fatal runtime output on stderr (see `jaiph run` behavior in [CLI](cli.md)). |
| `timestamp` | Always | ISO 8601 time (from the CLI or runtime event). |
| `elapsed_ms` | `workflow_end`, `step_end` | Elapsed milliseconds: total wall time for the run (`workflow_end`), or step duration (`step_end`). Omitted on `workflow_start` and `step_start`. |
| `run_path` | Always | Absolute path to the `.jh` file being run. |
| `workspace` | Always | Workspace root directory (same rules as [Config locations](#config-locations)). |
| `run_dir` | `workflow_end` | Absolute path to the run’s log directory, when the CLI reads it from the run metadata file written by the runner. Omitted if metadata is missing or incomplete. |
| `summary_file` | `workflow_end` | Absolute path to `run_summary.jsonl` when the CLI reads it from metadata. Append-only JSONL of workflow/step/log/inbox events; see [CLI — Run summary](cli.md#run-summary-jsonl). Omitted if not available. |
| `out_file` | `step_end` | Step stdout log path, when the runtime kept a non-empty file. Omitted if output was empty (file removed). |
| `err_file` | `step_end` | Step stderr log path, when the runtime kept a non-empty file. Omitted if stderr was empty (file removed). |

### Payload by event

- **`workflow_start`:** `event`, `workflow_id` (empty), `timestamp`, `run_path`, `workspace` only.
- **`step_start`:** `event`, `workflow_id`, `step_id`, `step_kind`, `step_name`, `timestamp`, `run_path`, `workspace` only (no `status`, `elapsed_ms`, or log paths).
- **`step_end`:** all step fields plus `status`, `elapsed_ms`, optional `out_file` / `err_file`; no `run_dir` or `summary_file`.
- **`workflow_end`:** `event`, `workflow_id`, `status`, `elapsed_ms`, `timestamp`, `run_path`, `workspace`, optional `run_dir` and `summary_file`.

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

- **Shell:** Each command is run as `sh -c '<command>'` (POSIX `sh` on your system).
- **Concurrent spawns:** For a **single** event, the CLI starts each configured command without waiting for the previous one to finish, so multiple commands for that event run concurrently. Order of **different** events follows the run (e.g. many `step_*` before `workflow_end`).
- **Best-effort:** Hook failures do not change the CLI exit code. Non-zero exit or spawn errors produce a `jaiph hooks: ...` line on stderr; the run continues.
- **Stdout:** Discarded. **Stderr** from the hook is copied to the CLI’s stderr.
- **Environment:** The hook inherits the same environment as the `jaiph run` process (`process.env`).
- **Working directory:** The hook inherits the **current working directory of the process that invoked `jaiph run`**, not necessarily `workspace`. To write under the repo, read `workspace` from stdin (e.g. `p=$(cat); log="$(echo "$p" | jq -r .workspace)/.jaiph/hook.log"`).
- **Invalid files:** If a file is missing, hooks are skipped for that path. If a file exists but **JSON.parse fails** or the top-level value is **not a JSON object**, the CLI prints a message on stderr and ignores that entire file. Otherwise, unsupported keys and bad per-event values are skipped without rejecting the file.

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

Stdin can only be read once per process. The `workflow_end` command stores the payload in `p`, then pipes it to each `jq` that needs the JSON. The `step_end` example uses a single `jq` that reads stdin once.

`step_end` uses a fixed path under `$HOME` in this example so it does not depend on where you ran `jaiph run`. The `workflow_end` line writes next to the project using the `workspace` field from the payload.

**Project overrides global:** If global has `workflow_end: ["global-notify.sh"]` and project has `workflow_end: ["project-notify.sh"]`, only `project-notify.sh` runs.
