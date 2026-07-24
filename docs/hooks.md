---
title: Add a hook
permalink: /how-to/hooks
diataxis: how-to
redirect_from:
  - /hooks
  - /hooks.md
---

# Add a hook

This recipe wires a shell command to a workflow lifecycle event so the CLI runs it when the event fires. Hooks are observation/notification side effects (HTTP webhooks, log appenders, CI integration) — they are not part of the workflow language.

Hooks run **on the host CLI** even when the workflow runs inside Docker. The CLI dispatches them at lifecycle points — step events from parsed `__JAIPH_EVENT__` lines on the runner's stderr, plus `workflow_start` before the runner spawns and `workflow_end` after it exits — with a JSON payload on stdin per invocation.

**One contract, three invocation modes.** The same four events (`workflow_start`, `step_start`, `step_end`, `workflow_end`) with the same payload shapes fire for:

- **direct runs** — interactive `jaiph run` / `jaiph <file.jh>`;
- **HTTP runs** — every `jaiph serve` workflow run, dispatched by the server process;
- **MCP tool calls** — every `jaiph mcp` tool call, dispatched by the server process (hook stderr goes to the server's stderr; stdout stays clean for the protocol).

The explicit mode differences: `jaiph run --raw` dispatches **no** hooks (transparent embedding / the Docker inner run — the host side of a Docker run still dispatches), and `jaiph test` executes workflows in-process without hooks. Servers load `hooks.json` at startup and re-read it on each source reload.

## Prerequisites

- An entry `.jh` file you can run with `jaiph run` / `jaiph <file.jh>`, or serve with `jaiph serve` / `jaiph mcp` (hooks do **not** fire for `jaiph test`, `jaiph compile`, `jaiph format`, `jaiph init`, `jaiph install`, `jaiph use`, or `jaiph run --raw`).
- `sh`, plus whatever tool the hook command needs (`jq`, `curl`, etc.).

## 1. Create the hooks file

Hooks come from one of two locations. Project hooks override global hooks **per event** (lists are not merged): if the project file defines commands for an event, only those run; omit an event to keep the global commands for that event.

| Scope | Path |
|---|---|
| Global | `~/.jaiph/hooks.json` |
| Project | `<workspace>/.jaiph/hooks.json` |

Both files are optional. Invalid JSON logs `jaiph hooks: …` on stderr and is skipped. Create the one you want:

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

The schema is a JSON object mapping event names to **arrays** of shell commands. The supported events are `workflow_start`, `workflow_end`, `step_start`, `step_end`:

```json
{
  "workflow_start": ["echo 'run started'"],
  "step_end":       ["jq -c . >> /tmp/jaiph-steps.jsonl"],
  "workflow_end":   ["curl -s -X POST https://example.com/jaiph/end -d @-"]
}
```

Each command runs as `sh -c '<command>'` with the JSON payload written to **stdin**. Stdin can only be read once per process; if you need the payload twice, buffer it:

```bash
p=$(cat); echo "$p" | jq -r .status; echo "$p" | jq -r .run_path
```

Hook stdout is discarded; hook stderr is copied to the CLI's stderr. Hook failures never change the workflow exit code — the CLI logs `jaiph hooks: …` lines and continues.

## 3. Run the workflow

```bash
jaiph run ./flow.jh
```

Each registered hook fires when the CLI dispatches its event. Step hooks follow a matching `__JAIPH_EVENT__` line on the runner's stderr; `workflow_start` and `workflow_end` are emitted by the CLI itself. For every hook the CLI writes the JSON payload to stdin and does not wait — commands can overlap in wall-clock time. Lifecycle order is still `workflow_start` → `step_*` → `workflow_end`; within one event, commands spawn in config order but may finish in any order.

## Verification

Tail your hook's output target after a run:

```bash
tail -n 5 "$HOME/.jaiph/step-events.jsonl"
```

A successful step_end record looks like:

```json
{"event":"step_end","step_kind":"workflow","step_name":"default","status":0,"elapsed_ms":1500}
```

The jq filter above drops several fields. A full `step_end` payload also includes `workflow_id`, `step_id`, `timestamp`, `run_path`, and `workspace`, and may include `out_file` / `err_file` when log captures exist.

The other events carry different fields:

- `workflow_start` — `event`, `workflow_id` (the run id in every invocation mode — direct, HTTP, and MCP), `timestamp`, `run_path`, `workspace`.
- `workflow_end` — `event`, `workflow_id`, `status` (the resolved run exit status), `elapsed_ms` (total run time), `timestamp`, `run_path`, `workspace`, and, when the runner reported them, `run_dir` (the run directory under `.jaiph/runs`) and `summary_file` (path to `run_summary.jsonl`). These two point a webhook at the run artifacts.

Every command also inherits the CLI's environment, which is why `$HOME` resolves in the examples above.

## Disable a global hook for one project

There is no explicit "disable" flag. An empty array does not override global hooks. Override the event in the project file with a no-op instead:

```json
{ "workflow_end": ["true"] }
```

## Related

- [Architecture — Channels and hooks in context](architecture.md#channels-and-hooks-in-context) — where hooks sit relative to runtime semantics.
- [Architecture — Runtime vs CLI responsibilities](architecture.md#runtime-vs-cli-responsibilities) — why hooks run on the host even for Docker runs.
- [Run a workflow in a Docker sandbox](/how-to/sandbox-run) — Docker runs still hit host hooks.
