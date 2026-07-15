---
title: Your first agent + sandboxed run
permalink: /tutorials/first-agent-run
diataxis: tutorial
---

# Your first agent + sandboxed run

This tutorial builds on [Your first workflow](/tutorials/first-workflow). You already have the `jaiph` CLI on `PATH`, you have run a script-only workflow, and you have inspected the artifacts under `.jaiph/runs/`. Here you will add a `prompt` step that calls an agent backend, then run the same workflow inside the Docker sandbox so the agent's actions stay isolated from your host.

## What you will build

A two-step workflow: one `ensure` step that validates a name with a `rule`, and one `prompt` step that asks an agent to greet that name. The workflow runs in Docker by default.

## Prerequisites — credentials

`prompt` steps call an agent backend. Before spawning the runner or Docker container, the CLI runs a [credential pre-flight](/how-to/agent-auth). Under Docker, missing credentials are a hard error (`E_AGENT_CREDENTIALS`) — host-side stored CLI logins (`~/.claude`, macOS Keychain, `cursor-agent login`) do **not** cross the container boundary. On host-only runs, `claude` and `cursor` may warn instead of aborting when a stored CLI login might still work.

Pick one backend and set its env var on the host:

```bash
# Cursor (the default backend if nothing else is configured)
export CURSOR_API_KEY="..."

# Claude
export ANTHROPIC_API_KEY="sk-ant-..."
# or, after running `claude setup-token`:
export CLAUDE_CODE_OAUTH_TOKEN="..."

# Codex (OpenAI)
export OPENAI_API_KEY="sk-..."
```

For the full per-backend matrix (which CLI logins fall back, which env vars Docker forwards), see [Authenticate agent backends](/how-to/agent-auth).

## Prerequisites — Docker

Install Docker and confirm:

```bash
docker info
```

Docker is on by default for `jaiph run`. There is no `--docker` flag — sandboxing is driven by `JAIPH_DOCKER_ENABLED` / `JAIPH_UNSAFE`. The CLI picks a workspace-presentation mode automatically:

- **Overlay mode** when `/dev/fuse` exists (typically Linux).
- **Copy mode** when `/dev/fuse` is missing (typically macOS Docker Desktop).

Both modes leave your host workspace unmodified at run end. See [Run in a Docker sandbox](/how-to/sandbox-run) for inplace mode (live host edits, opt-in) and for the CLI-line / env-var matrix.

## 1. Configure the backend (optional)

If you set `CURSOR_API_KEY` above, skip this step — `cursor` is the default backend. Otherwise, add a module-level `config { … }` block to the top of your file so the entry workflow picks your backend.

The full file you build in this tutorial is:

```jh
config {
  agent.backend = "claude"
  agent.model = "sonnet-4"
}

rule valid_name(name_arg) {
  return match name_arg {
    /[A-Z][a-z]+/ => name_arg
    "" => fail "You didn't provide your name :("
    _ => fail "You provided an invalid name :("
  }
}

workflow default(name_arg) {
  const name = ensure valid_name(name_arg)

  const response = prompt """
    Say hello to ${name} and add one fun fact about a person with the same name.
    Respond with a single line. Do not inspect files or run tools.
  """

  return response
}
```

Three pieces of new syntax compared with [Your first workflow](/tutorials/first-workflow):

- `config { agent.backend = "claude" }` selects the agent backend at module scope. Drop the block entirely to use the `cursor` default, or set `JAIPH_AGENT_BACKEND` in the environment to override either form (env wins; see [Configure backend & model](/how-to/configure-backend)).
- `rule valid_name(name_arg) { … }` is a read-only validator. Rules cannot use `prompt` or raw shell — they enforce structure on inputs before the workflow continues. `ensure valid_name(name_arg)` runs the rule and aborts the workflow with the failure message if any arm matches `fail`.
- `prompt """ … """` is a managed agent call. The triple-quoted body is dedented at parse time and sent to the selected backend's CLI; the agent's stdout is captured as the step value. The `${name}` substitution happens before the prompt is sent.

Save the file as `greet.jh`.

## 2. Run it in the Docker sandbox

```bash
jaiph run ./greet.jh "Adam"
```

The CLI does a few things before any workflow step runs:

1. **Loads the module graph** (parses the entry file — one file in this tutorial).
2. **Resolves Docker mode**: picks overlay (`fusefs` banner) when `/dev/fuse` is present, copy (`tmp workspace`) otherwise.
3. **Runs the credential pre-flight** for the selected backend. Under Docker, missing env vars abort with `E_AGENT_CREDENTIALS` — no container is launched.
4. **Pulls the runtime image** (`ghcr.io/jaiphlang/jaiph-runtime:<version>`) if it is not already local. Status lines stream on stderr before the banner.
5. **Validates the module, emits scripts, prints the banner**, then **spawns the container** — workspace mounted read-only (overlay) or as a disposable clone (copy), and `.jaiph/runs/` read-write for artifacts.

You should see (timings, model output, and exact step name will differ):

```text
Jaiph: Running greet.jh (Docker sandbox, fusefs)

workflow default (name_arg="Adam")
  ▸ rule valid_name (name_arg="Adam")
  ✓ rule valid_name (0s)
  ▸ prompt claude sonnet-4 "Say hello to ${name} and..." (name="Adam")
  ✓ prompt claude sonnet-4 (5s)

✓ PASS workflow default (5.1s)

Hello, Adam — Adam Smith, the 18th-century Scottish economist, is often called the father of modern economics.
```

Three things to notice:

- The `(Docker sandbox, fusefs)` / `(Docker sandbox, tmp workspace)` banner confirms isolation is on.
- The `prompt` step line names the backend (`claude` here), the effective model (`sonnet-4` — omitted when the backend auto-selects), and a truncated preview of the prompt body. The full body is in `run_summary.jsonl`.
- The line printed after `PASS` is `workflow default`'s return value (`return response`).

## 3. Make the rule reject a bad name

Re-run with an empty string so `valid_name` matches the `""` arm:

```bash
jaiph run ./greet.jh ""
```

The output ends with the failure footer:

```text
  ▸ rule valid_name
  ✗ rule valid_name (0s)

✗ FAIL workflow default (0.3s)
  Logs: …/.jaiph/runs/…
  Summary: …/run_summary.jsonl
    out: …/000002-rule__valid_name.out
    err: …/000002-rule__valid_name.err

  Output of failed step:
    You didn't provide your name :(
```

The `prompt` step is never reached — `ensure` aborted the workflow when the rule failed. The captured `.err` file is the source for the `Output of failed step:` excerpt. Under Docker, container-internal `/jaiph/run/*` paths are remapped to host paths before the footer is printed, so the paths you see point at your host workspace.

## 4. Inspect the prompt record

Each `prompt` step writes a `PROMPT_START` and `PROMPT_END` line to `run_summary.jsonl`. Filter the latest run:

```bash
jq -c 'select(.type=="PROMPT_START")' .jaiph/runs/*/*/run_summary.jsonl | tail -1
```

The record includes the resolved `backend`, the `model` (when one was set), and a `model_reason` of `explicit`, `flags`, or `backend-default` — the same information [Configure backend & model](/how-to/configure-backend) uses to verify config precedence.

## Where to go next

You now have a working agent workflow under Docker. Useful next directions:

- [Reference — Language](/reference/language) — every step type, including `run async`, `match`, `for_lines`, `send`, and `if`.
- [Spec: Async Handles](/spec-async-handles) — fan out two `prompt` steps in parallel and rendezvous at the end of the workflow.
- [Inbox & Dispatch](/inbox) — route work between workflows without tight coupling.
- [Sandboxing](/sandboxing) — the threat model: what the Docker sandbox protects against and what it does not.
- [Write & run tests](/how-to/testing) — author a `*.test.jh` file with mock prompts so the workflow stays deterministic in CI.
