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

Hooks run **on the host CLI** even when the workflow runs inside Docker. They observe the `__JAIPH_EVENT__` stream and receive a JSON payload on stdin per invocation.

## Prerequisites

- An entry `.jh` file you can run with `jaiph run` (hooks do **not** fire for `jaiph test`, `jaiph compile`, `jaiph format`, `jaiph init`, `jaiph install`, `jaiph use`, or `jaiph run --raw`).
- `sh`, plus whatever tool the hook command needs (`jq`, `curl`, etc.).

## 1. Create the hooks file

Hooks come from one of two locations. Project hooks override global hooks per event:

| Scope | Path |
|---|---|
| Global | `~/.jaiph/hooks.json` |
| Project | `<workspace>/.jaiph/hooks.json` |

Both files are optional. Create the one you want:

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
p=$(cat); echo "$p" | jq -r .status; echo "$p" | jq -r .run_dir
```

Hook stdout is discarded; hook stderr is copied to the CLI's stderr. Hook failures never change the workflow exit code — the CLI logs `jaiph hooks: …` lines and continues.

## 3. Run the workflow

```bash
jaiph run ./flow.jh
```

Each registered hook fires when its event lands on the runner's stderr. For each fired hook the CLI writes the JSON payload to the command's stdin and forgets it (no wait). Commands overlap in wall-clock time; the only causal guarantee is the spawn order: `workflow_start` → `step_*` → `workflow_end`.

## Verification

Tail your hook's output target after a run:

```bash
tail -n 5 "$HOME/.jaiph/step-events.jsonl"
```

A successful step_end record looks like:

```json
{"event":"step_end","step_kind":"workflow","step_name":"default","status":0,"elapsed_ms":1500}
```

The full payload shape per event is documented in `HookPayload` / `HookEventName` in `src/types.ts`.

## Disable a global hook for one project

There is no explicit "disable" flag. Override the event in the project file with a no-op:

```json
{ "workflow_end": ["true"] }
```

## Related

- [Architecture — Channels and hooks in context](architecture.md#channels-and-hooks-in-context) — where hooks sit relative to runtime semantics.
- [Architecture — Runtime vs CLI responsibilities](architecture.md#runtime-vs-cli-responsibilities) — why hooks run on the host even for Docker runs.
- [Run a workflow in a Docker sandbox](/how-to/sandbox-run) — Docker runs still hit host hooks.
