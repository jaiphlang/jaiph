---
title: Hooks
permalink: /hooks
redirect_from:
  - /hooks.md
---

# Jaiph Hooks

When you run a workflow with [`jaiph run`](cli.md#hooks), the CLI observes a fixed lifecycle: the run is prepared, the workflow process starts, each step starts and ends as the runtime reports them, then the run finishes. **Hooks** let you register shell commands that run when those lifecycle points occur.

Typical uses: notifying another system when a run finishes, logging step names or timing, or appending structured data (status, run directory, summary path) somewhere you control.

Configuration comes from **global** and **project-local** `hooks.json` files. For each event name, if the project file lists at least one non-empty command, those commands are used and global commands for that event are ignored (there is no merging of lists). If neither file exists, or both omit an event, nothing runs for that event.

Hooks are implemented only for **`jaiph run`**. They are not used by `jaiph test`, `jaiph report`, or other commands.

## Config locations

- **Global:** `~/.jaiph/hooks.json`
- **Project-local:** `<workspace>/.jaiph/hooks.json`

The workspace root is the first directory that contains `.jaiph` or `.git` when walking **up** from the workflow file’s directory. If neither marker appears on the path to the filesystem root, the workspace is the workflow file’s directory. Project-local `hooks.json` is always read from that workspace root.

Both files are optional.

## Schema

Each file is a single JSON **object**. Keys must be supported **event names** (see below). Each value must be a JSON **array**; anything else for a known key is ignored for that key only. Array elements must be **non-empty strings** (each string is one shell command); other element types and empty strings are skipped. **Unknown top-level keys** are ignored. Commands for an event are **spawned** in array order; the next command starts without waiting for the previous one to finish (see [Behavior](#behavior)).

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
| `workflow_start` | After parse/validation succeeded and **before** the CLI spawns the workflow subprocess (local or Docker). If parse or validation fails, this event does not run. |
| `workflow_end` | After the workflow subprocess has exited (any status). Runs before the CLI prints its final PASS/FAIL line. |
| `step_start` | When the runtime reports that a step (workflow, rule, script, or prompt) has started. |
| `step_end` | When the runtime reports that a step has finished. |

Step hooks mirror the same stderr `__JAIPH_EVENT__` stream the CLI uses for the progress tree; see [CLI — Run progress and tree output](cli.md#run-progress-and-tree-output).

## Precedence

For each event, **project-local** commands override **global** commands:

- If project `.jaiph/hooks.json` defines `workflow_end` with at least one non-empty command, only those commands run for `workflow_end` (global `workflow_end` is ignored).
- If the project file has no `workflow_end` key, or only an empty array, global `workflow_end` commands run (if any).
- Other events are independent: e.g. project `step_end` does not change how `workflow_start` is resolved.

There is no way to explicitly disable a global hook from a project file alone. Omitting an event or using `[]` means “fall back to global.” To suppress a global hook for one project, override that event with a no-op (e.g. `"workflow_end": ["true"]`).

## Payload

Each command receives one JSON object on **stdin** (UTF-8). Use `jq`, `python3 -c`, or any parser you like.

**Payload fields:**

| Field | Present | Description |
|-------|---------|-------------|
| `event` | Always | `workflow_start`, `workflow_end`, `step_start`, or `step_end`. |
| `workflow_id` | Always | Runtime run id from stderr events. **Empty string** on `workflow_start`; for step events, whatever the runtime sent (may be empty until the runtime assigns an id). |
| `step_id` | `step_*` | Step identifier (`id` from the runtime event). |
| `step_kind` | `step_*` | `workflow`, `rule`, `script`, or `prompt`. |
| `step_name` | `step_*` | Step name (e.g. `default`, `scan_passes`). |
| `status` | `workflow_end`, `step_end` | Exit status: **0** success, **non-zero** failure. For `workflow_end`, this is the CLI’s resolved outcome: non-zero if the subprocess exited non-zero **or** the CLI detected fatal runtime output on stderr (see `jaiph run` behavior in [CLI](cli.md)). |
| `timestamp` | Always | ISO 8601 time (from the CLI or runtime event). |
| `elapsed_ms` | `workflow_end`, `step_end` | Elapsed milliseconds: total wall time for the run (`workflow_end`), or step duration (`step_end`). |
| `run_path` | Always | Absolute path to the `.jh` file being run. |
| `workspace` | Always | Workspace root directory (same rules as [Config locations](#config-locations)). |
| `run_dir` | `workflow_end` | Absolute path to the run’s log directory, when the runtime wrote it into the run metadata file. |
| `summary_file` | `workflow_end` | Absolute path to `run_summary.jsonl` when the runtime recorded it. Append-only JSONL of workflow/step/log/inbox events; see [CLI — Run summary](cli.md#run-summary-jsonl). |
| `out_file` | `step_end` | Step stdout log path, when the runtime kept a non-empty file. Omitted if output was empty (file removed). |
| `err_file` | `step_end` | Step stderr log path, when the runtime kept a non-empty file. Omitted if stderr was empty (file removed). |

Example payload (`step_end`):

```json
{
  "event": "step_end",
  "workflow_id": "abc-123",
  "step_id": "run:1:1",
  "step_kind": "workflow",
  "step_name": "default",
  "status": 0,
  "timestamp": "2025-03-11T12:00:00.000Z",
  "elapsed_ms": 1500,
  "run_path": "/repo/flows/ci.jh",
  "workspace": "/repo",
  "out_file": "/repo/.jaiph/runs/.../step.out",
  "err_file": "/repo/.jaiph/runs/.../step.err"
}
```

## Behavior

- **Shell:** Each command is run as `sh -c '<command>'` (POSIX `sh` on your system).
- **Fire-and-forget:** The CLI calls `spawn` and does not wait for the hook process to exit before continuing the run (including other hook commands for the same event).
- **Best-effort:** Hook failures do not change the CLI exit code. Non-zero exit or spawn errors produce a `jaiph hooks: ...` line on stderr; the run continues.
- **Stdout:** Discarded. **Stderr** from the hook is copied to the CLI’s stderr.
- **Environment:** The hook inherits the same environment as the `jaiph run` process (`process.env`).
- **Working directory:** The hook inherits the **current working directory of the shell that invoked `jaiph run`**, not necessarily `workspace`. To write under the repo, read `workspace` from stdin (e.g. `p=$(cat); log="$(echo "$p" | jq -r .workspace)/.jaiph/hook.log"`).
- **Invalid files:** If a file is missing, hooks are skipped for that path. If a file exists but **JSON.parse fails** or the top-level value is **not a JSON object**, the CLI prints a warning and ignores that entire file. Otherwise, unsupported keys and bad per-event values are skipped without rejecting the file.

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
