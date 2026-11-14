---
title: Your first agent run
permalink: /tutorials/first-agent-run
diataxis: tutorial
mermaid: true
---

# Your first agent run

This tutorial builds on [Your first run](first-run.md). You already have the `jaiph` CLI on your `PATH`, you have run a file that used only script steps, and you have looked at the artifacts under `.jaiph/runs/`. Here you will add a `prompt` step that calls an agent backend. `jaiph run` executes on the host, so a `cursor` or `claude` prompt that can run tools runs as the same operating system user as `jaiph`. Jaiph hands each agent a reduced set of environment variables, but that is not a process sandbox. If you want a sandbox, wrap `jaiph` in your own container or CI runner. See [Deploy jaiph](deploy.md).

## What you will build

You will build a file with two steps. The first step checks that the name you pass looks like a name. The second step is a `prompt` that asks an agent to greet that name.

## Credentials

A `prompt` step calls an agent backend. Before it spawns the runner, the CLI runs a [credential pre-flight](agent-auth.md). The `cursor` backend warns and proceeds when `CURSOR_API_KEY` is missing, because a stored CLI login might still work. The `claude` backend is not checked — a stored Claude CLI login is enough. The `codex` backend has no login fallback, so a missing `OPENAI_API_KEY` is a hard error (`E_AGENT_CREDENTIALS`).

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

For the full table of what each backend needs, see [Authenticate agent backends](agent-auth.md).

## 1. Configure the backend (optional)

If you set `CURSOR_API_KEY` above, you can skip this step, because `cursor` is the default backend. Otherwise, add a module-level `config { … }` block at the top of your file so the run uses the backend you want.

The full file you build in this tutorial is:

```jh
config {
  agent.backend = "claude"
  agent.model = "sonnet"
}

def valid_name(name_arg) {
  return match name_arg {
    /[A-Z][a-z]+/ => name_arg
    _ => fail "You provided an invalid name :("
  }
}

export def main(name_arg) {
  const name = valid_name(name_arg)

  const response = prompt """
    Say hello to ${name} and add one fun fact about a person with the same name.
    Respond with a single line. Do not inspect files or run tools.
  """

  return response
}
```

The file uses some syntax that [Your first run](first-run.md) did not:

- `config { agent.backend = "claude" }` selects the agent backend at module scope. Leave the block out to use the `cursor` default, or set `JAIPH_AGENT_BACKEND` in the environment to override either form. The environment value wins when both are set. See [Configure backend & model](configure-backend.md).
- `def valid_name(name_arg) { … }` checks the shape of its input with `match`. `valid_name(name_arg)` runs that def, and if any arm matches `fail`, it stops the run and prints the failure message. The `match` arms are tried from top to bottom, and the first one that matches wins. The regex `/[A-Z][a-z]+/` matches any name with an uppercase letter followed by lowercase letters, so `Adam` passes while an empty name, `adam`, and `ADAM` all fall through to `_`. The `_` arm is the only reject arm, so every invalid name gets the same failure message.
- `prompt """ … """` is a managed agent call. The triple-quoted body is dedented when the file is parsed and then sent to the selected backend's CLI. The agent's stdout becomes the value of the step. The `${name}` reference is substituted before the prompt is sent.

Save the file as `greet.jh`.

The chart below shows the two steps. The name check comes first, and a name that fails the check ends the run before the agent is called. `jaiph graph ./greet.jh` prints the chart, and [Execution flow](execution-flow.md) explains how to read it.

<div class="graph-sample" data-graph-sample="first-agent-run" data-graph-block="1">
<div class="graph-render" role="img" aria-label="Execution flow of greet.jh"></div>
{% raw %}<script type="text/plain" data-graph-mermaid>
flowchart TD
  classDef term fill:#ffffff,stroke:#8a938d,color:#1d2420
  classDef fail fill:#fde2e2,stroke:#b42318,color:#7a1a12
  classDef input fill:#fff3d1,stroke:#b7871a,color:#4d3600
  classDef def fill:#dce7fb,stroke:#3563c9,color:#132f66,stroke-width:1.5px
  classDef prompt fill:#eee2fd,stroke:#7646d6,color:#381a72
  classDef decision fill:#f1f2f1,stroke:#5f6762,color:#1d2420

  subgraph g2 ["<b>def</b> valid_name"]
    n4(["start"]):::term
    n5[/"in: name_arg"/]:::input
    n6{"<b>match</b> name_arg"}:::decision
    n7(["<b>fail</b> #quot;You provided an invalid name :(#quot;"]):::fail
    n8(["end"]):::term
  end
  subgraph g1 ["<b>def</b> main"]
    n1(["start"]):::term
    n2[/"in: name_arg"/]:::input
    n3[["name = <b>def</b> valid_name(name_arg)"]]:::def
    n9["response = <b>prompt</b> #quot;Say hello to $#123;name#125; and add one fun...#quot;"]:::prompt
    n10(["end"]):::term
  end

  n1 --> n2
  n2 --> n3
  n3 --> n4
  n4 --> n5
  n5 --> n6
  n6 -->|"_"| n7
  n6 -->|"/[A-Z][a-z]+/ → name_arg"| n8
  n8 --> n9
  n9 -->|"return response"| n10

  style g1 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
  style g2 fill:#f6f7f6,stroke:#b9c0bb,color:#1d2420
</script>{% endraw %}
</div>

## 2. Run it

```bash
jaiph run ./greet.jh "Adam"
```

Before the first step runs, the CLI checks the file for errors and checks that the backend you selected has the credentials it needs.

You should see the following, though timings, model output, and the exact step name will differ:

```text
Jaiph: Running greet.jh

def main (name_arg="Adam")
  ▸ def valid_name (name_arg="Adam")
  ✓ def valid_name (0s)
  ▸ prompt claude sonnet "Say hello to ${name} and..." (name="Adam")
  ✓ prompt claude sonnet (5s)

✓ PASS def main (5.1s)

Hello, Adam! Adam Smith, the 18th-century Scottish economist, is often called the father of modern economics.
```

The banner and the step lines each tell you something:

- The `prompt` step line names the backend, which is `claude` here. It then shows the model, which is `sonnet`. When you do not set a model, the backend picks one and this line shows `default` instead. After the model, the line shows a short preview of the prompt body, cut to the first 24 characters. The preview keeps the `${name}` text you wrote rather than the substituted value, and the full body is saved in `run_summary.jsonl`.
- The line printed after `PASS` is the return value of `export def main`, which is the `return response` step.

## 3. Make `valid_name` reject a bad name

Re-run with an empty string so `valid_name` falls through to the `_` arm:

```bash
jaiph run ./greet.jh ""
```

The output ends with the failure footer:

```text
  ▸ def valid_name
  ✗ def valid_name (0s)

✗ FAIL def main (0.3s)
  Logs: …/.jaiph/runs/…
  Summary: …/run_summary.jsonl
    out: …/000002-def__valid_name.out
    err: …/000002-def__valid_name.err

  Output of failed step:
    You provided an invalid name :(
```

The `prompt` step never runs, because `valid_name` failed. The `.err` file holds the text shown under `Output of failed step:`.

## 4. Inspect the prompt record

Each `prompt` step writes a `PROMPT_START` and a `PROMPT_END` line to `run_summary.jsonl`. Filter the latest run:

```bash
jq -c 'select(.type=="PROMPT_START")' .jaiph/runs/*/*/run_summary.jsonl | tail -1
```

The record includes the resolved `backend`, the `model` (or `null` when the backend picks its own), and a `model_reason`. For this run the reason is `explicit`, because you set `agent.model`. The other values are `flags`, `backend-default`, and `none`. [Configure backend & model](configure-backend.md) describes each value and reads the same fields to check config precedence.

## Where to go next

You now have a working agent run. Here are some directions to go next:

- [Pass a host key to a script](script-env.md) is the recipe for `use` and `--env`.
- [Language reference](language.md) covers every step type, including `async`, `match`, `for`, `send`, and `if`.
- [Run work concurrently](async.md) is the recipe for `async`. [Async handles](spec-async-handles.md) is the value model.
- [Inbox and dispatch](inbox.md) explains how to route work between defs without tight coupling.
- [Deploy jaiph](deploy.md) shows a container, pod, or dedicated user if you want an outer boundary. The installer does not create that user.
- [Write and run tests](testing.md) shows how to author a `*.test.jh` file with mock prompts so the program stays deterministic in CI.
