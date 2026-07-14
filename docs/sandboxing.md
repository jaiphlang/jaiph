---
title: Sandboxing
permalink: /sandboxing
diataxis: explanation
redirect_from:
  - /sandboxing.md
---

# Sandboxing — the model

A Jaiph workflow runs scripts, calls agents, and touches the filesystem on whatever machine `jaiph run` is invoked on. That power is the point — and also the risk: a careless or untrusted script can read files, exfiltrate secrets, and run arbitrary programs unless something constrains it.

Jaiph addresses this at two layers, each doing a different job:

- **Rules** — compile-time structural validation of what a `rule` body is allowed to contain.
- **Docker isolation** — a runtime sandbox for `jaiph run` that runs the same workflow inside a container with a tight resource posture.

This page explains the *model*: what each layer protects, what it deliberately does not protect, and why the design picks the trade-offs it does. The how-to of enabling or disabling Docker, the full configuration-key list, and the failure-mode codes live in their own how-to and reference pages — this page stays on the conceptual surface.

For the runtime implementation, see [Architecture — Docker runtime helper](architecture.md#core-components).

## Two layers, two jobs

Rules and Docker isolation are doing fundamentally different work, and it is worth keeping them separate:

| Layer | When it fires | What it constrains | What it does not constrain |
|---|---|---|---|
| **Rules** | Compile time | The set of step types allowed inside a `rule` body — no inline shell, no `prompt`, no `const … = prompt`, no `send`, no `run async` | Anything a `script` does at runtime (rules can still call scripts via `run`) |
| **Docker** | `jaiph run` launch time | Filesystem reach, process isolation, capability surface, env-var exposure for *every* step in the workflow | Network egress (default-on), agent credentials (forwarded by design), hooks (run on host) |

Rules are about **structure**: by the time the compiler is done, a rule cannot contain a step type that mutates state in a surprising way. There is no OS sandbox around a rule body — when a rule calls a script, that script runs as a normal managed subprocess with the same access the workflow has. Treat rules as non-mutating checks by convention; do mutation in workflows.

Docker is about **blast radius**: it cannot stop a script from misbehaving, but it can keep that misbehavior inside a disposable container.

## The three sandbox modes

When Docker is enabled, the CLI picks one of three sandbox primitives at launch. The mode controls **how the workspace is presented to the container**; the env allowlist, mount allowlist, and `--security-opt no-new-privileges` posture is the same across all three. Every mode starts from `--cap-drop ALL`; overlay mode adds back a small cap set for `fuse-overlayfs` (see [What Docker protects against](#what-docker-protects-against)).

- **Overlay mode** — the host workspace is bind-mounted read-only; `fuse-overlayfs` inside the container layers a writable scratch space on top, merged at `/jaiph/workspace`. Reads come from the real workspace, writes land in the overlay and are discarded when the container exits. The *idea* is copy-on-write isolation: the host checkout is the source of truth, the run can pretend to mutate it, and at exit there is no trace.
- **Copy mode** — before launching, the CLI clones the workspace into a disposable sandbox directory and bind-mounts that clone read-write. Writes are real, but they are local to the clone, which is removed on exit. The *idea* is the same isolation contract as overlay, expressed without `fuse-overlayfs` (which is not available everywhere, notably on macOS Docker Desktop and on Linux hosts that block fuse mounts).
- **Inplace mode** — the host workspace itself is bind-mounted read-write. The run's edits land **live** on the host. The *idea* is "trusted workspace, untrusted machine": the rest of the sandbox (caps, env allowlist, mount set) still applies, but the workspace-isolation half is removed on purpose so an agent-driven dev loop can iterate against the real checkout.

Overlay and copy are interchangeable from the user's point of view — both produce the property that **the host workspace is unmodified after a Docker run**. Inplace explicitly opts out of that property in exchange for a tighter dev loop, and the CLI gates it behind a destructive-edit confirmation prompt before launch.

In every mode, run artifacts are written to a separate read-write mount at `/jaiph/run` (outside the workspace sandbox) so the artifact tree under `.jaiph/runs/` persists on the host regardless of what happened inside the container.

## What Docker protects against

The Docker sandbox is designed to contain damage from untrusted or semi-trusted workflow scripts. Its protections are:

- **Filesystem reach** — scripts inside the container cannot read or write arbitrary host paths outside the workspace mount and the run-artifacts mount. The rest of the host is invisible to the container. Overlay and copy modes additionally make the workspace itself non-persistent.
- **Process isolation** — container processes cannot see or signal host processes. Every sandboxed container runs with `--cap-drop ALL` and `--security-opt no-new-privileges`. Overlay mode adds back a small set of capabilities required to mount `fuse-overlayfs` and then drop privileges; copy and inplace modes do not add any back.
- **Mount safety** — the host root filesystem, the Docker daemon socket, and OS-internal paths (`/proc`, `/sys`, `/dev`) cannot be mounted into the container. Attempting to do so produces a validation error before launch.
- **Environment exposure** — host environment variables do not cross the boundary by default. Only an explicit prefix allowlist (`JAIPH_*`, `ANTHROPIC_*`, `CLAUDE_*`, `CURSOR_*`, with `JAIPH_DOCKER_*` and the inplace-control flags excluded) is forwarded. Every other variable is dropped, including unrelated cloud credentials, SSH agents, and registry tokens. The per-key escape hatch is **`--env`** (`jaiph run` / `jaiph mcp`): `--env KEY=VALUE` or `--env KEY` (forward the host value) crosses that variable into the workflow verbatim as an explicit `-e KEY=VALUE` container arg **bypassing the allowlist** — the flag *is* the consent — and wins over any allowlist-forwarded value for the same key. Sandbox-control and runtime-managed keys are rejected (`E_ENV_RESERVED`); values are never path-remapped. See [CLI — `jaiph run` flags](cli.md#jaiph-run).
{: #env-exposure}
- **Shell injection safety** — every `docker` invocation passes an explicit argv array (`execFileSync` or `spawn`), never `/bin/sh`. Image names and other parameters are passed as literal arguments, so values containing shell metacharacters are never expanded.

## What Docker does **not** protect against

Equally important is the list of things Docker is deliberately *not* claiming to defend:

- **Network egress is on by default.** The sandbox only passes `--network none` when configuration sets the Docker network mode to `none` (`JAIPH_DOCKER_NETWORK` or module `runtime.docker_network`; see [Configuration — Runtime (Docker) keys](configuration.md#runtime-docker-keys)). When the mode is the default (`default`), no `--network` flag is passed and the container uses Docker's bridge with outbound access. A script can reach external services and exfiltrate data over the network.
- **Agent credentials cross the boundary.** `ANTHROPIC_*`, `CLAUDE_*`, and `CURSOR_*` variables are forwarded so agent-backed workflows can function. Combined with default network egress, treat them as **fully disclosed** to anything that runs inside the container.
- **Hooks run on the host.** Hook commands from `.jaiph/hooks.json` (merged with `~/.jaiph/hooks.json`) execute on the host CLI process, not inside the container, and have full host access. Hook config is trusted.
- **Image supply chain is the user's responsibility.** Jaiph verifies that the selected image contains a working `jaiph` binary, but does not verify image signatures or provenance. Use trusted registries and pin digests for anything that matters.
- **Container escapes are not guaranteed-impossible.** Docker is not equivalent to a VM or hardware isolation. It raises the bar against script-level mischief, but a kernel exploit can in principle break out.
- **Inplace mode opts out of workspace isolation.** With `JAIPH_INPLACE` set, the run can mutate your real workspace. The machine outside the workspace stays sandboxed as in any mode, but a crashed or malicious run can leave your checkout half-edited.

This list exists because a sandbox that overclaims is worse than one that is honest about its scope. Jaiph treats the Docker boundary as a **blast-radius reducer for workflow scripts**, not as a credential vault or a network firewall.

## Why opt-out, not opt-in

The default-on choice — Docker on unless the host sets `JAIPH_UNSAFE=true` or sets `JAIPH_DOCKER_ENABLED` to any value other than exact `true` — is deliberate. Workflows orchestrate agent and script code that is often pulled from a repository, edited by a model, or contributed by a third party. Making the safer posture the path of least resistance means a careless workflow gets contained by default and only escapes the container when a human types out the override.

A second, equally deliberate choice: **enablement lives entirely in environment variables, not in in-file `config`**. Module-level `runtime.docker_*` keys can tune image, network, and timeout, but nothing in a `.jh` file can turn Docker off — `runtime.docker_enabled` is rejected at parse time. That keeps the "host is in charge of sandbox enablement" property: pulling a workflow file from a less-trusted source cannot ship an off-switch with it.

The escape hatch — `JAIPH_UNSAFE=true` or `jaiph run --unsafe` — exists because some environments genuinely cannot run Docker (a sandboxed CI without nested virtualization, a developer iterating on the runtime itself). The choice to take that hatch should be visible and ergonomic, which is why it is a single explicit host-side switch rather than an in-file `config` knob.

## Windows runs host-only

On Windows (`win32`) the Docker sandbox is out of scope: the sandbox modes rely on POSIX socket paths and Linux/macOS-specific workspace presentation, so Jaiph does not attempt them there. `jaiph run` on Windows resolves to **host-only mode automatically** — the same posture as an explicit `JAIPH_UNSAFE=true` — and prints a one-line notice that the run is host-only. The CLI never probes for `docker` and never fails just because a Docker daemon is absent, and `JAIPH_DOCKER_ENABLED=true` cannot force the sandbox back on. Windows workflows therefore run with no OS sandbox; keep the [not-protected-against](#what-docker-does-not-protect-against) list in mind, or run under WSL, where the Linux path (and the full sandbox) applies.

## Why `jaiph test` does not use Docker

The test runner runs in-process on the host. This is intentional: tests are a development feedback loop, they typically mock prompts and replace external calls, and Docker spawn overhead would harm the iteration cycle. Tests already get isolation from the things they care about (prompts, network) through the runtime's mock infrastructure. The Docker boundary is for `jaiph run`, where the workflow is executing real scripts against real resources.

## How sandboxing fits the rest of Jaiph

The Docker sandbox does not change workflow semantics. The runtime inside the container is the same **`NodeWorkflowRuntime`** AST interpreter that runs locally — the container runs **`jaiph run --raw`**, which spawns the internal **`__workflow-runner`** child the same way as host **`--raw`** execution (see [Architecture — Docker runtime helper](architecture.md#core-components)), same **`__JAIPH_EVENT__`** stream on stderr, same **`run_summary.jsonl`** written under **`.jaiph/runs/`**. The only differences are *where* processes execute and *what host resources they can reach*.

That property is the point of the design: a workflow is the same workflow whether it runs sandboxed or not. The sandbox is a deployment decision, not a programming model.

## Related

- [Architecture — Docker runtime helper](architecture.md#core-components) — the spawn, mount, and event-stream wiring.
- [Architecture — Channels and hooks in context](architecture.md#channels-and-hooks-in-context) — why hooks run on the host even for containerized runs.
- [Why Jaiph](why-jaiph.md) — the design context that puts the sandbox into the broader picture.
