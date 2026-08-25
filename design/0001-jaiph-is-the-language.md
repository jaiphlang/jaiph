# ADR 0001 — Jaiph is the language, not a sandbox product

*Status: accepted*
*Date (UTC): 2026-08-25*

## Decision

Jaiph is a small workflow language and orchestrator: `def`, `script`, `prompt`, compile, run, test, format, durable artifacts.

Jaiph is not a sandbox product. It does not own a container runtime, a kernel policy engine, or a toolchain image.

`jaiph run`, `jaiph mcp`, and `jaiph serve` execute on the host. There is no sandbox mode, no unsafe flag, and no sandbox environment variables. Isolation of the process from the rest of the machine is an **outer** concern (Docker, nono, k8s, CI, Codespaces). The operator wraps `jaiph`, or the environment already is the sandbox.

## Why

`docs/sandboxing.md` already said the sandbox is a deployment choice, not a programming model. The code ignored that: default-on Docker, a digest-pinned image, snapshot/inplace modes, interrupt teardown, and a test corpus that dwarfs several language features.

That work has no language semantics. It made the repo hard to maintain and split the product vision: every `run` / `mcp` / `serve` change also had to be a sandbox change.

The k8s/standalone path already set `JAIPH_UNSAFE=true` because the outer container is the real sandbox. `jaiph test` never used Docker. Native Windows never got a sandbox. The language already ran without one.

A leftover “unsafe” flag or `JAIPH_DOCKER_*` family would keep the sandbox product alive as a ghost. Cut it.

## What stays in Jaiph (invariants)

These are orchestration, not kernel:

- `prompt` subprocess env is fail-closed. Injected secrets (`--env`, `trusted_envs`) reach trusted `run` steps only.
- Run journal redaction.
- Compiler: `W_PROMPT_IN_SHELL`, a `.jh` file cannot disable host secret policy by itself.

## What is out

Removed, not deprecated:

- Docker driver, runtime image, digest pin, snapshot/inplace, confirmation prompts
- `--unsafe`, `--inplace`, `--yes` as sandbox consent, `JAIPH_UNSAFE`, `JAIPH_INPLACE*`, `JAIPH_DOCKER_*`, in-file `runtime.docker_*`
- Agent credential proxy, hostname allowlists, nono/Landlock/Seatbelt adapters
- Any feature whose primary purpose is process isolation

## Product filter

A change lands only if it makes `.jh` files easier to compile, run, test, or understand.

`jaiph mcp` and `jaiph serve` are adapters around `run`. Bugfixes only unless a later ADR says otherwise. Registry, install, and deploy stay as they are; they are not the vision.

## Consequences

- `why-jaiph.md` commitment “Sandbox by default” is deleted.
- Host execution is the language runtime. Document how to wrap with an outer sandbox if the operator wants one.
- Revisit a first-party driver only if operators will not wrap *and* bare-host `prompt` is an actual incident pattern. Speculation is not enough.
