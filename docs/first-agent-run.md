---
title: Your first agent + sandboxed run
permalink: /tutorials/first-agent-run
diataxis: tutorial
---

# Your first agent + sandboxed run

This tutorial builds on [Your first workflow](first-workflow.md). You already have the `jaiph` CLI on your `PATH`, you have run a workflow that used only script steps, and you have looked at the artifacts under `.jaiph/runs/`. Here you will add a `prompt` step that calls an agent backend, and then run the same workflow inside the Docker sandbox so the agent's actions stay isolated from your host.

## What you will build

You will build a workflow with two steps. The first step is an `ensure` step that checks a name with a `rule`. The second step is a `prompt` step that asks an agent to greet that name. The workflow runs in Docker by default.

## Credentials

A `prompt` step calls an agent backend. Before it spawns the runner or the Docker container, the CLI runs a [credential pre-flight](agent-auth.md). Under Docker, missing credentials are a hard error called `E_AGENT_CREDENTIALS`, because stored CLI logins on the host (`~/.claude`, the macOS Keychain, `cursor-agent login`) do not cross into the container. On host-only runs, the `claude` and `cursor` backends warn instead of stopping the run, because a stored CLI login might still work.

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

For the full table of what each backend needs, including which stored logins work and which env vars Docker forwards, see [Authenticate agent backends](agent-auth.md).

## Docker

Install Docker and confirm it is running:

```bash
docker info
```

Docker is on by default for `jaiph run`. There is no `--docker` flag. Sandboxing is controlled by the `JAIPH_DOCKER_ENABLED` and `JAIPH_UNSAFE` environment variables. In the default snapshot mode the CLI copies your workspace at the moment the run starts and mounts that copy with read and write access. The live checkout on your host is never mounted.

Snapshot mode leaves your host workspace unchanged when the run ends. For inplace mode, where the run's edits land on your host directly, and for the full list of flags and environment variables, see [Run in a Docker sandbox](sandbox-run.md).

## 1. Configure the backend (optional)

If you set `CURSOR_API_KEY` above, you can skip this step, because `cursor` is the default backend. Otherwise, add a module-level `config { … }` block at the top of your file so the workflow uses the backend you want.

The full file you build in this tutorial is:

```jh
config {
  agent.backend = "claude"
  agent.model = "sonnet"
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

The file uses some syntax that [Your first workflow](first-workflow.md) did not:

- `config { agent.backend = "claude" }` selects the agent backend at module scope. Leave the block out to use the `cursor` default, or set `JAIPH_AGENT_BACKEND` in the environment to override either form. The environment value wins when both are set. See [Configure backend & model](configure-backend.md).
- `rule valid_name(name_arg) { … }` is a read-only check. A rule cannot use `prompt` or raw shell, so it can only check the shape of its inputs before the workflow continues. `ensure valid_name(name_arg)` runs the rule, and if any arm matches `fail`, it stops the workflow and prints the failure message. The `match` arms are tried from top to bottom, and the first one that matches wins. The regex `/[A-Z][a-z]+/` matches any name with an uppercase letter followed by lowercase letters, so `Adam` passes while `adam` and `ADAM` fall through to `_`. The `""` arm catches an empty name, and `_` catches everything else.
- `prompt """ … """` is a managed agent call. The triple-quoted body is dedented when the file is parsed and then sent to the selected backend's CLI. The agent's stdout becomes the value of the step. The `${name}` reference is substituted before the prompt is sent.

Save the file as `greet.jh`.

## 2. Run it in the Docker sandbox

```bash
jaiph run ./greet.jh "Adam"
```

The CLI does a few things before any workflow step runs:

1. **Loads the module graph.** It parses the entry file, which is the only file in this tutorial.
2. **Resolves the Docker mode.** The default is snapshot mode, and the banner then shows `snapshot`. Setting `JAIPH_INPLACE=1` selects inplace mode instead.
3. **Runs the credential pre-flight** for the selected backend. Under Docker, a missing env var stops the run with `E_AGENT_CREDENTIALS`, and no container is launched.
4. **Pulls the runtime image** `ghcr.io/jaiphlang/jaiph-runtime:<version>` if it is not already on your machine. Short status lines appear on stderr before the banner.
5. **Prints the banner, then validates the module and emits its scripts.** After that it **spawns the container**. The workspace snapshot is mounted with read and write access at `/jaiph/workspace`, and `.jaiph/runs/` is mounted with read and write access for artifacts.

You should see the following, though timings, model output, and the exact step name will differ:

```text
Jaiph: Running greet.jh (Docker sandbox, snapshot)

workflow default (name_arg="Adam")
  ▸ rule valid_name (name_arg="Adam")
  ✓ rule valid_name (0s)
  ▸ prompt claude sonnet "Say hello to ${name} and..." (name="Adam")
  ✓ prompt claude sonnet (5s)

✓ PASS workflow default (5.1s)

Hello, Adam! Adam Smith, the 18th-century Scottish economist, is often called the father of modern economics.
```

The banner and the step lines each tell you something:

- The `(Docker sandbox, snapshot)` banner confirms the sandbox is on.
- The `prompt` step line names the backend, which is `claude` here. It then shows the model, which is `sonnet`. When you do not set a model, the backend picks one and this line shows `default` instead. After the model, the line shows a short preview of the prompt body, cut to the first 24 characters. The preview keeps the `${name}` text you wrote rather than the substituted value, and the full body is saved in `run_summary.jsonl`.
- The line printed after `PASS` is the return value of `workflow default`, which is the `return response` step.

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

The `prompt` step never runs, because `ensure` stopped the workflow when the rule failed. The `.err` file holds the text shown under `Output of failed step:`. Under Docker, the paths inside the container under `/jaiph/run/*` are remapped to host paths before the footer prints, so the paths you see point at your host workspace.

## 4. Inspect the prompt record

Each `prompt` step writes a `PROMPT_START` and a `PROMPT_END` line to `run_summary.jsonl`. Filter the latest run:

```bash
jq -c 'select(.type=="PROMPT_START")' .jaiph/runs/*/*/run_summary.jsonl | tail -1
```

The record includes the resolved `backend`, the `model` (or `null` when the backend picks its own), and a `model_reason`. For this run the reason is `explicit`, because you set `agent.model`. The other reasons are `flags` and `backend-default`. [Configure backend & model](configure-backend.md) reads the same fields to check config precedence.

## Where to go next

You now have a working agent workflow under Docker. Here are some directions to go next:

- [Language reference](language.md) covers every step type, including `run async`, `match`, `for_lines`, `send`, and `if`.
- [Async handles](spec-async-handles.md) shows how to fan out two `prompt` steps in parallel and join them at the end of the workflow.
- [Inbox and dispatch](inbox.md) explains how to route work between workflows without tight coupling.
- [Sandboxing](sandboxing.md) describes the threat model, including what the Docker sandbox protects against and what it does not.
- [Write and run tests](testing.md) shows how to author a `*.test.jh` file with mock prompts so the workflow stays deterministic in CI.
