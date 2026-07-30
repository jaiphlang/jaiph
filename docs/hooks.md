---
title: Add a hook
permalink: /how-to/hooks
diataxis: how-to
redirect_from:
  - /hooks
  - /hooks.md
---

# Add a hook

A hook is a shell command that the CLI runs when a workflow reaches a lifecycle event. Hooks let you observe a run or notify another system from outside the workflow, for example send an HTTP webhook, append a line to a log file, or trigger a CI job. Hooks are not part of the workflow language.

Hooks run on the host CLI, even when the workflow itself runs inside Docker. The CLI dispatches them at four lifecycle events. It reads the step events from `__JAIPH_EVENT__` lines on the runner's stderr, and it emits `workflow_start` before the runner spawns and `workflow_end` after the runner exits. Each hook command receives a JSON payload on its stdin.

The same four events (`workflow_start`, `step_start`, `step_end`, `workflow_end`), with the same payload shapes, fire in the three ways you can run a workflow:

- Direct runs. Interactive `jaiph run` or `jaiph <file.jh>`.
- HTTP runs. Every workflow run under `jaiph serve`, dispatched by the server process.
- MCP tool calls. Every `jaiph mcp` tool call, dispatched by the server process. The hook's stderr goes to the server's stderr, and stdout stays clean for the protocol.

Some run modes dispatch no hooks. `jaiph run --raw` dispatches no hooks, because it is meant for transparent embedding and for the inner run of a Docker sandbox. The host side of a Docker run still dispatches hooks. `jaiph test` runs workflows in-process and dispatches no hooks. When you run `jaiph serve` or `jaiph mcp`, the server loads `hooks.json` at startup and reads it again on each source reload.

## Prerequisites

- An entry `.jh` file you can run with `jaiph run` / `jaiph <file.jh>`, or serve with `jaiph serve` / `jaiph mcp` (hooks do **not** fire for `jaiph test`, `jaiph compile`, `jaiph format`, `jaiph init`, `jaiph install`, `jaiph use`, or `jaiph run --raw`).
- `sh`, plus whatever tool the hook command needs (`jq`, `curl`, etc.).

## 1. Create the hooks file

Hooks come from one of two files. Project hooks override global hooks for each event, and the lists are not merged. If the project file defines commands for an event, only those commands run for that event. Omit an event from the project file to keep the global commands for that event.

| Scope | Path |
|---|---|
| Global | `~/.jaiph/hooks.json` |
| Project | `<workspace>/.jaiph/hooks.json` |

Both files are optional. If a file contains invalid JSON, the CLI writes a `jaiph hooks: …` line to stderr and skips that file. Create the one you want:

```bash
mkdir -p .jaiph
cat > .jaiph/hooks.json <<'EOF'
{
  "step_end": [
    "jq -c '{event,step_kind,step_name,status,elapsed_ms}' >> \"$HOME/.jaiph/step-events.jsonl\""
  ]
}
EOF
```

## 2. Map events to commands

Each hooks file is a JSON object. The keys are event names, and each value is an array of shell commands. The four supported events are `workflow_start`, `workflow_end`, `step_start`, and `step_end`. The following file maps three of them.

```json
{
  "workflow_start": ["echo 'run started'"],
  "step_end":       ["jq -c . >> /tmp/jaiph-steps.jsonl"],
  "workflow_end":   ["curl -s -X POST https://example.com/jaiph/end -d @-"]
}
```

Each command runs under `sh -c`, with the JSON payload written to its stdin. A process can read its stdin only once, so if you need the payload more than once, read it into a variable first.

```bash
p=$(cat); echo "$p" | jq -r .status; echo "$p" | jq -r .run_path
```

The CLI discards each hook's stdout and copies its stderr to the CLI's stderr. A hook failure never changes the workflow exit code. When a hook fails, the CLI writes a `jaiph hooks: …` line and continues.

## 3. Run the workflow

```bash
jaiph run ./flow.jh
```

Each registered hook fires when the CLI dispatches its event. Step hooks follow a matching `__JAIPH_EVENT__` line on the runner's stderr, and the CLI emits `workflow_start` and `workflow_end` itself. For every hook the CLI writes the JSON payload to stdin and does not wait for the command to finish, so hook commands can overlap in time. The lifecycle order is always `workflow_start`, then the `step_*` events, then `workflow_end`. Within a single event, the CLI starts the commands in the order they appear in the file, but they can finish in any order.

## Verification

Tail your hook's output target after a run:

```bash
tail -n 5 "$HOME/.jaiph/step-events.jsonl"
```

A successful `step_end` record looks like this:

```json
{"event":"step_end","step_kind":"workflow","step_name":"default","status":0,"elapsed_ms":1500}
```

The jq filter above keeps only a few fields. A full `step_end` payload also includes `workflow_id`, `step_id`, `timestamp`, `run_path`, and `workspace`. It adds `out_file` and `err_file` when the step captured stdout or stderr log files.

The other events carry different fields:

- `step_start` carries `event`, `workflow_id`, `step_id`, `step_kind`, `step_name`, `timestamp`, `run_path`, and `workspace`. It does not carry `status` or `elapsed_ms`, because the step has not finished yet.
- `workflow_start` carries `event`, `workflow_id` (the run id, present in every invocation mode), `timestamp`, `run_path`, and `workspace`.
- `workflow_end` carries `event`, `workflow_id`, `status` (the resolved run exit status), `elapsed_ms` (the total run time), `timestamp`, `run_path`, and `workspace`. A direct `jaiph run` also adds `run_dir` (the run directory under `.jaiph/runs`) and `summary_file` (the path to `run_summary.jsonl`) when the runner reports them. HTTP and MCP runs add `run_dir` in the same way but do not add `summary_file`. Use `run_dir` and `summary_file` to point a webhook at the run's artifacts.

Every hook command inherits the CLI's environment, which is why `$HOME` resolves in the examples above.

## Disable a global hook for one project

There is no flag that disables a hook. An empty array does not override the global hooks, so you cannot turn an event off by setting it to `[]`. Instead, override the event in the project file with a command that does nothing:

```json
{ "workflow_end": ["true"] }
```

## Reload behavior on a running server

`jaiph serve` and `jaiph mcp` re-read `hooks.json` when they reload the workflow source, not the moment you save the file. A server reloads when a watched module source file changes, and it reads the hooks again as part of that reload. So an edit to `hooks.json` alone takes effect on the next source change, not on its own.

## Related

- [Architecture — Channels and hooks in context](architecture.md#channels-and-hooks-in-context) — where hooks sit relative to runtime semantics.
- [Architecture — Runtime vs CLI responsibilities](architecture.md#runtime-vs-cli-responsibilities) — why hooks run on the host even for Docker runs.
- [Run a workflow in a Docker sandbox](sandbox-run.md) — Docker runs still hit host hooks.
