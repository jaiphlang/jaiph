# Jaiph hooks

[jaiph.org](https://jaiph.org) · [Getting started](getting-started.md) · [CLI](cli.md) · [Configuration](configuration.md) · [Grammar](grammar.md) · [Testing](testing.md) · [Agent Skill](https://jaiph.org/jaiph-skill.md)

---

Hooks let you run custom commands at Jaiph lifecycle events (e.g. to forward status to external tools). Config is loaded from **global** and **project-local** `hooks.json` files; project-local entries override global for each event.

## Config locations

- **Global:** `~/.jaiph/hooks.json`
- **Project-local:** `<project>/.jaiph/hooks.json` (workspace root is the directory containing `.jaiph` or `.git` for the file you run)

Both files are optional. If neither exists, `jaiph run` behaves as before (no hooks).

## Schema

Each file is a JSON object. Keys are event names; values are arrays of shell commands (strings). Commands are run in order. Unknown keys are ignored.

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

- If project `.jaiph/hooks.json` has `workflow_end`, only those commands run for `workflow_end` (global `workflow_end` is ignored).
- If project has no `workflow_end`, global `workflow_end` commands run.
- Other events are independent: e.g. project `step_end` does not affect global `workflow_start`.

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
| `run_dir` | workflow_end, step_end | Run logs directory (when available). |
| `summary_file` | workflow_end | Path to `run_summary.jsonl` (when available). |
| `out_file` | step_end | Step stdout log path. |
| `err_file` | step_end | Step stderr log path. |

Example payload (step_end):

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
  "run_dir": "/repo/.jaiph/runs/2025-03-11T12-00-00-abc",
  "out_file": "/repo/.jaiph/runs/.../step.out",
  "err_file": "/repo/.jaiph/runs/.../step.err"
}
```

## Behavior

- **Best-effort:** Hook failures do not crash or block the main run. If a command exits non-zero or throws, Jaiph logs a warning to stderr and continues.
- **No wait:** Commands are started but Jaiph does not wait for them to finish before continuing the workflow or the next hook.
- **Invalid config:** If a file exists but is not valid JSON or does not match the schema, Jaiph prints a warning and skips that file; the run continues without those hooks.

## Examples

**Global `~/.jaiph/hooks.json` — notify on every workflow end:**

```json
{
  "workflow_end": ["curl -s -X POST https://example.com/jaiph/end -d @-"]
}
```

**Project `.jaiph/hooks.json` — log step names and forward end to `jai`:**

```json
{
  "step_end": ["jq -r '.step_kind + \"/\" + .step_name' >> .jaiph/step-log.txt"],
  "workflow_end": ["jai status --run-dir \"$(jq -r .run_dir)\" --status \"$(jq -r .status)\""]
}
```

**Project overrides global:** If global has `workflow_end: ["global-notify.sh"]` and project has `workflow_end: ["project-notify.sh"]`, only `project-notify.sh` runs.
