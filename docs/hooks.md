---
title: Hooks
permalink: /hooks
redirect_from:
  - /hooks.md
---

# Jaiph Hooks

When `jaiph run` executes a workflow, it passes through a sequence of lifecycle events: the workflow starts, individual steps begin and end, and eventually the workflow finishes. Hooks let you attach shell commands to any of these events.

Typical uses: notifying external systems when a workflow finishes, logging step names or timing, or syncing run results to another service.

Configuration is loaded from **global** and **project-local** `hooks.json` files. For each event, project-local commands override global ones (no merging). If no config exists, `jaiph run` runs as usual with no hooks.

## Config locations

- **Global:** `~/.jaiph/hooks.json`
- **Project-local:** `<workspace>/.jaiph/hooks.json`

The workspace is the first directory that contains `.jaiph` or `.git` when walking up from the workflow file’s directory. If none is found, the workflow file’s directory is used. Project-local config is resolved from this workspace root.

Both files are optional.

## Schema

Each file is a JSON object. Keys are event names; values are arrays of shell command strings. Only non-empty strings in each array are used; other values (e.g. numbers, empty strings) are ignored. Unknown keys are ignored. Commands for an event run in order.

```json
{
  "workflow_start": ["echo 'run started'"],
  "workflow_end": ["/path/to/jai", "notify.sh"],
  "step_start": [],
  "step_end": ["jq -r .step_name"]
}
```

## Supported events

| Event | When it runs |
|-------|----------------|
| `workflow_start` | Before the workflow process is spawned. |
| `workflow_end`   | After the workflow process exits (success or failure). |
| `step_start`    | When a step (workflow, rule, function, prompt) starts. |
| `step_end`      | When a step finishes. |

## Precedence

For each event, **project-local** commands override **global** commands:

- If project `.jaiph/hooks.json` defines `workflow_end` with at least one non-empty command, only those commands run for `workflow_end` (global `workflow_end` is ignored).
- If project has no `workflow_end` or has `workflow_end: []`, global `workflow_end` commands run.
- Other events are independent: e.g. project `step_end` does not affect global `workflow_start`.

There is no way to explicitly disable a global hook from a project config. Setting an event to `[]` or omitting it causes the global commands to run. If you need to suppress a global hook for one project, replace it with a no-op command (e.g. `"workflow_end": ["true"]`).

## Payload

Each command is invoked with the event payload as **JSON on stdin**. You can use `jq` or any JSON parser to read it.

**Payload fields:**

| Field | Present | Description |
|-------|---------|-------------|
| `event` | Always | One of `workflow_start`, `workflow_end`, `step_start`, `step_end`. |
| `workflow_id` | Always | Run id from runtime; empty at `workflow_start` until first step. |
| `step_id` | step_* | Step identifier. |
| `step_kind` | step_* | `workflow`, `rule`, `function`, `prompt`. |
| `step_name` | step_* | Step name (e.g. `default`, `scan_passes`). |
| `status` | workflow_end, step_end | Exit status (0 = success). |
| `timestamp` | Always | ISO 8601 time. |
| `elapsed_ms` | workflow_end, step_end | Elapsed milliseconds. |
| `run_path` | Always | Absolute path to the workflow file. |
| `workspace` | Always | Workspace root directory. |
| `run_dir` | workflow_end | Run logs directory (when available). |
| `summary_file` | workflow_end | Path to `run_summary.jsonl` (when available). |
| `out_file` | step_end | Step stdout log path. |
| `err_file` | step_end | Step stderr log path. |

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

- **Shell:** Each command is run with `sh -c <command>`.
- **Fire-and-forget:** Jaiph spawns the hook process and continues immediately. It does not wait for the hook to exit before proceeding with the workflow.
- **Best-effort:** Hook failures do not crash or block the run. If a command exits non-zero or throws, Jaiph logs a warning to stderr and continues.
- **Stdout ignored:** Hook command stdout is discarded. Hook stderr is forwarded to the parent process stderr, so diagnostic output from hooks appears alongside Jaiph's own warnings.
- **Environment:** The hook process inherits the full environment of the `jaiph run` process.
- **Working directory:** The hook process inherits the current working directory of the process that invoked `jaiph run`. To write under the project, use the `workspace` field from the payload (e.g. `"$(jq -r .workspace)/.jaiph/log.txt"`).
- **Invalid config:** If a file exists but is not valid JSON or does not match the schema, Jaiph prints a warning and skips that file; the run continues without those hooks.

## Examples

**Global `~/.jaiph/hooks.json` — notify on every workflow end:**

```json
{
  "workflow_end": ["curl -s -X POST https://example.com/jaiph/end -d @-"]
}
```

**Project `.jaiph/hooks.json` — log step names and forward workflow end to `jai`:**

```json
{
  "step_end": ["jq -r '.step_kind + \"/\" + .step_name' >> .jaiph/step-log.txt"],
  "workflow_end": ["p=$(cat); jai status --run-dir \"$(echo \"$p\" | jq -r .run_dir)\" --status \"$(echo \"$p\" | jq -r .status)\""]
}
```

The payload is delivered on stdin. Since stdin can only be consumed once per command, the `workflow_end` example captures it to a variable first and then pipes it to each `jq` call separately. The simpler `step_end` command reads stdin in a single `jq` invocation, which works directly.

The `step_end` command appends to `.jaiph/step-log.txt` relative to the current working directory (where you ran `jaiph run`). To write under the project workspace instead, use the `workspace` field from the payload.

**Project overrides global:** If global has `workflow_end: ["global-notify.sh"]` and project has `workflow_end: ["project-notify.sh"]`, only `project-notify.sh` runs.
