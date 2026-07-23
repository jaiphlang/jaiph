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

## The two sandbox modes {#the-three-sandbox-modes}

When Docker is enabled, the CLI picks one of two sandbox primitives at launch. The mode controls **how the workspace is presented to the container**; the env allowlist, mount allowlist, and container posture are the same for both. Every mode runs with `--cap-drop ALL` and **zero** cap-adds, `--security-opt no-new-privileges`, no `--device`, no AppArmor exception, and on Linux `--user host_uid:host_gid`.

- **Snapshot mode (default)** — before launching, the CLI takes a **writable point-in-time snapshot** of the workspace (a host-side clone, block-level copy-on-write where the filesystem supports it) and bind-mounts that snapshot read-write at `/jaiph/workspace`. The live host workspace is **never mounted into the container at all**: host changes during the run are invisible to the container, and the container's workspace writes are discarded when the snapshot is deleted at exit. The snapshot lives at `<run dir>/sandbox` (under `.jaiph/runs/` by default) and is masked from the container's own `/jaiph/run` view by a tmpfs so the run cannot read its snapshot source back.
- **Inplace mode** — the host workspace itself is bind-mounted read-write. The run's edits land **live** on the host. The *idea* is "trusted workspace, untrusted machine": the rest of the sandbox (caps, env allowlist, mount set) still applies, but the workspace-isolation half is removed on purpose so an agent-driven dev loop can iterate against the real checkout.

Snapshot mode produces the property that **the host workspace is unmodified after a Docker run**. Inplace explicitly opts out of that property in exchange for a tighter dev loop, and on `jaiph run` the CLI gates it behind a destructive-edit confirmation prompt before launch. `jaiph mcp` uses the same default (isolated workspace); set `JAIPH_INPLACE=1` to bind the live workspace read-write for MCP tool calls — see [Serve workflows as MCP tools — Safety posture](mcp.md#safety-posture).

## Confirmation prompts and access scope

Both destructive opt-outs are gated behind an interactive `Continue? [y/N]` prompt (default **no**) on `jaiph run`. The two prompts state their **access scope** in plain language up front, because that is what determines the blast radius:

| Mode | Sandbox | Filesystem reach | Network / env |
|---|---|---|---|
| **`--inplace`** | Docker **on** (container boundary, dropped caps, env allowlist) | **This workspace directory only** — bind-mounted `:rw` at `/jaiph/workspace`; scripts and agents cannot read or write host paths outside it | Egress on by default (`JAIPH_DOCKER_NETWORK=none` to disable); only allowlisted env vars cross unless `--env` |
| **`--unsafe`** | Docker **off** — the workflow runs as the host `jaiph` process | **Your entire host filesystem** (and host `$HOME`, SSH agent, Keychain, etc.) — no mount restriction | Full host environment visible to scripts and agent backends |

- **Inplace prompt** names in-place mode and states its access scope in two lines: it can edit files directly in the workspace directory (the path is printed), and it has no access to other directories — the rest of your machine stays inside the Docker sandbox. Non-TTY without consent aborts with `E_DOCKER_INPLACE_NO_CONFIRM`.
- **Unsafe prompt** is deliberately stronger — unsafe is strictly *more* exposure than inplace, not a lighter variant. It states in one line that the run is in unsafe mode with **no sandboxing** and **full access to your machine**. It fires only when the unsafe opt-in is what turns Docker off (Docker would otherwise be on); it does **not** fire when Docker is off for another reason — an explicit `JAIPH_DOCKER_ENABLED=false`, or the [Windows host-only override](#windows-runs-host-only), which prints its own one-line notice. Non-TTY without consent aborts with `E_UNSAFE_NO_CONFIRM`.
- **Auto-confirm.** `--yes` / `-y` (env form `JAIPH_INPLACE_YES=1`) skips **both** prompts — the single, consistent consent switch, required for non-interactive (non-TTY) use of either mode. `jaiph run --raw` skips both prompts unconditionally (it is the embedding / Docker-inner entrypoint; consent is expressed by the wrapping context).

In every mode, run artifacts are written to a separate read-write mount at `/jaiph/run` (outside the workspace sandbox) so the artifact tree under `.jaiph/runs/` persists on the host regardless of what happened inside the container.

## Interrupting a Docker run

Pressing **Ctrl+C** (or sending SIGTERM to the host `jaiph` process) stops the whole run — including the container. This matters because a `docker run --rm` container can outlive its host `docker` client: on some setups (notably Docker Desktop) killing the client leaves the container running, so a naive "kill the CLI" would leave an orphaned container executing workflow and agent work against the sandbox with no attached CLI.

Jaiph closes that gap. Every sandboxed container is launched with a deterministic name, and on interrupt the host CLI removes it by name — `docker kill` to stop it, then `docker rm -f` to drop the `--rm` container's record — before it deletes the host-side sandbox clone. (The two steps are split on purpose: a single `docker rm -f` on a still-running container can block on Docker Desktop lock contention while the host `docker run` client is tearing itself down.) The observable contract is:

- The container is **gone from `docker ps`** within a bounded window after the interrupt.
- The host-side snapshot at `<run dir>/sandbox` is removed as before (kept only when `JAIPH_DOCKER_KEEP_SANDBOX=1` is set — see [Environment variables](env-vars.md)), and never while the container is still live, since that snapshot is bind-mounted into it.
- The behaviour is identical across **snapshot and inplace** modes — the sandbox mode never changes the stop contract.

The same teardown applies when a run hits its Docker timeout (`E_TIMEOUT`) and to per-call cancellation of a `jaiph mcp` server (see [Serve workflows as MCP tools — Cancel an in-flight call](mcp.md#cancel-an-in-flight-call)). The runtime wiring lives in [Architecture — Docker runtime helper](architecture.md#core-components).

## What Docker protects against

The Docker sandbox is designed to contain damage from untrusted or semi-trusted workflow scripts. Its protections are:

- **Filesystem reach** — scripts inside the container cannot read or write arbitrary host paths outside the workspace mount and the run-artifacts mount. The rest of the host is invisible to the container. In the default snapshot mode the container works on a point-in-time clone, so the live host workspace is never even mounted and is unmodified after the run.
- **Process isolation** — container processes cannot see or signal host processes. Every sandboxed container runs with `--cap-drop ALL` (zero cap-adds) and `--security-opt no-new-privileges`, no `--device`, and no AppArmor exception — the same minimal posture in both snapshot and inplace modes. On Linux the container runs as the host UID/GID from the first instruction, never as root.
- **Mount safety** — the host root filesystem, the Docker daemon socket, and OS-internal paths (`/proc`, `/sys`, `/dev`) cannot be mounted into the container. Attempting to do so produces a validation error before launch.
- **Environment exposure** — host environment variables do not cross the boundary by default. Only an explicit allowlist is forwarded: `JAIPH_*` run-control keys (with `JAIPH_DOCKER_*` and the inplace-control flags excluded) plus the enumerated credential keys of the agent backends the entry file selects (`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` for `claude`, `CURSOR_API_KEY` for `cursor`, `OPENAI_API_KEY` for `codex`). Other variables in those prefix families (for example `ANTHROPIC_BASE_URL`, or any `ANTHROPIC_*`/`OPENAI_*` secret unrelated to the run's backend) stay on the host. Every other variable is dropped, including unrelated cloud credentials, SSH agents, and registry tokens. The per-key escape hatch is **`--env`** (`jaiph run` / `jaiph mcp`): `--env KEY=VALUE` or `--env KEY` (forward the host value) crosses that variable into the workflow verbatim as an explicit `-e KEY=VALUE` container arg **bypassing the allowlist** — the flag *is* the consent — and wins over any allowlist-forwarded value for the same key. Sandbox-control and runtime-managed keys are rejected (`E_ENV_RESERVED`); values are never path-remapped. See [CLI — `jaiph run` flags](cli.md#jaiph-run).

  An `--env` value crosses to the **workflow process** — not to the model. `prompt` backend subprocesses are spawned with a second, unconditional fail-closed scrub (`scrubPromptEnv` in `src/runtime/kernel/env-allowlist.ts`, applied in every sandbox mode *including host mode*): the agent receives the base environment (`PATH`, `HOME`, locale, proxies, `CLAUDE_CONFIG_DIR`, …), `JAIPH_*` control keys, and its own backend's credential keys only. `--env`-injected secrets such as `GITHUB_TOKEN` stay visible to trusted `run` script/workflow steps and never reach the agent.

  A `.jh` file can also declare the host keys its trusted steps need in-file with the [`trusted_envs`](configuration.md#trusted-envs) config key — the declarative alternative to `--env` for the common forward-a-host-key case. Declared keys resolve from a pristine host-env snapshot, cross the Docker boundary through the same explicit `-e` channel as `--env` pairs (the declaration is the per-key consent), and are subject to the same `prompt`-scrub: they reach trusted `run` steps only, never the agent. Only the entry file's `trusted_envs` is honored — a declaration in an imported module cannot pull host secrets into its own steps.
{: #env-exposure}
- **Shell injection safety** — every `docker` invocation passes an explicit argv array (`execFileSync` or `spawn`), never `/bin/sh`. Image names and other parameters are passed as literal arguments, so values containing shell metacharacters are never expanded.

## What Docker does **not** protect against

Equally important is the list of things Docker is deliberately *not* claiming to defend:

- **Network egress is on by default.** The sandbox only passes `--network none` when configuration sets the Docker network mode to `none` (`JAIPH_DOCKER_NETWORK` or module `runtime.docker_network`; see [Configuration — Runtime (Docker) keys](configuration.md#runtime-docker-keys)). When the mode is the default (`default`), no `--network` flag is passed and the container uses Docker's bridge with outbound access. A script can reach external services and exfiltrate data over the network.
- **Agent credentials cross the boundary.** The credential keys of the run's resolved backends (`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`, `OPENAI_API_KEY`) are forwarded so agent-backed workflows can function (including the `codex` HTTP backend). Combined with default network egress, treat them as **fully disclosed** to anything that runs inside the container. Backends the entry file does not select get nothing forwarded.
- **Hooks run on the host.** Hook commands from `.jaiph/hooks.json` (merged with `~/.jaiph/hooks.json`) execute on the host CLI process, not inside the container, and have full host access. Hook config is trusted.
- **Image supply chain is the user's responsibility.** Jaiph verifies that the selected image contains a working `jaiph` binary, but does not verify image signatures or provenance. Use trusted registries and pin digests for anything that matters.
- **Container escapes are not guaranteed-impossible.** Docker is not equivalent to a VM or hardware isolation. It raises the bar against script-level mischief, but a kernel exploit can in principle break out.
- **Inplace mode opts out of workspace isolation.** With `JAIPH_INPLACE` set, the run can mutate your real workspace. The machine outside the workspace stays sandboxed as in any mode, but a crashed or malicious run can leave your checkout half-edited.

This list exists because a sandbox that overclaims is worse than one that is honest about its scope. Jaiph treats the Docker boundary as a **blast-radius reducer for workflow scripts**, not as a credential vault or a network firewall.

## Prompt captures in shell steps {#prompt-in-shell}

A workflow can receive free-form text from an agent via a `prompt` step, then use that value in subsequent steps. The value is user-controlled by design — but how it reaches downstream steps affects the blast radius.

**The hazard.** Workflow shell steps (free-form lines in a workflow body) are executed via `sh -c` after Jaiph interpolates `${varName}` references. If `varName` holds a prompt capture — text written by an agent or provided interactively — that text is spliced directly into the shell command string. A value like `` `id` `` or `; rm -rf .` can then be interpreted by the shell as commands rather than data:

```jaiph
workflow default() {
  const msg = prompt "Enter a label:"
  git commit -m "${msg}"   # W_PROMPT_IN_SHELL: msg is agent-controlled
}
```

The compiler emits a `W_PROMPT_IN_SHELL` diagnostic for any shell step that interpolates a prompt capture. This diagnostic **fails the build**: `jaiph compile` exits non-zero and `jaiph run` refuses to start (the same recoverable-error channel every other `E_`/`W_` diagnostic uses — Jaiph has no separate non-fatal warning tier today). Inside the default Docker sandbox the blast radius is contained, but under `--unsafe` (host-only mode) or `--inplace`, the host is directly affected.

**The safe pattern.** Pass prompt captures as named arguments to a `script` step. Scripts receive arguments through `$1 $2 …` (argv), not shell-expanded strings, so there is no interpolation step between the capture value and the script's argument.

In your script body (`commit_with_label`), use positional parameters:

```bash
# commit_with_label — receives label as $1
git commit -m "$1"
```

In the workflow, call it with the prompt capture as a bare argument:

```jaiph
workflow default() {
  const msg = prompt "Enter a label:"
  run commit_with_label(msg)   # no W_PROMPT_IN_SHELL: argv path is safe
}
```

The compiler does **not** warn on `run script(promptCapture)` — that is the recommended form.

**When the diagnostic fires and when it does not.**

| Pattern | Diagnostic |
|---|---|
| `echo "${capture}"` in a workflow body (shell step) | `W_PROMPT_IN_SHELL` |
| `run myscript(capture)` | none — argv is safe |
| `log "${capture}"` / `logerr "${capture}"` | none — log interpolation is not a shell `sh -c` execution |
| Non-prompt variable interpolated in a shell step | none |

**Resolving the diagnostic.** There is no inline suppress comment and no non-fatal-warning mode: to compile and run, you must remove the prompt capture from the shell line. The intended fix is the argv path above — extract the shell line into a named (or inline) `script` that receives the value as `$1`, which is both the safe form and the one the compiler accepts. Rewriting the interpolation with your own shell quoting inside the same shell step does **not** clear the diagnostic; the check flags the data-flow (a prompt capture reaching a shell step), not the specific escaping.

Under `--unsafe` or `--inplace`, the host filesystem is fully exposed, so the hazard is real even for a benign-looking shell step. The compile-time diagnostic is the primary defence signal; runtime quoting is a secondary layer that the named-script argv path provides automatically.

## Why opt-out, not opt-in

The default-on choice — Docker on unless the host sets `JAIPH_UNSAFE=true` or sets `JAIPH_DOCKER_ENABLED` to any value other than exact `true` — is deliberate. Workflows orchestrate agent and script code that is often pulled from a repository, edited by a model, or contributed by a third party. Making the safer posture the path of least resistance means a careless workflow gets contained by default and only escapes the container when a human types out the override.

A second, equally deliberate choice: **enablement lives entirely in environment variables, not in in-file `config`**. Module-level `runtime.docker_*` keys can tune image, network, and timeout, but nothing in a `.jh` file can turn Docker off — `runtime.docker_enabled` is rejected at parse time. That keeps the "host is in charge of sandbox enablement" property: pulling a workflow file from a less-trusted source cannot ship an off-switch with it.

The escape hatch — `JAIPH_UNSAFE=true` or `jaiph run --unsafe` — exists because some environments genuinely cannot run Docker (a sandboxed CI without nested virtualization, a developer iterating on the runtime itself). The choice to take that hatch should be visible and ergonomic, which is why it is a single explicit host-side switch rather than an in-file `config` knob — and, on `jaiph run`, why it is gated behind the [unsafe confirmation prompt](#confirmation-prompts-and-access-scope) (or an explicit `--yes` / `JAIPH_INPLACE_YES` for non-interactive use) so opting out of the sandbox is a conscious act, not a silent default.

## Windows runs host-only

On Windows (`win32`) the Docker sandbox is out of scope: the sandbox modes rely on POSIX socket paths and Linux/macOS-specific workspace presentation, so Jaiph does not attempt them there. `jaiph run` on Windows resolves to **host-only mode automatically** — the same posture as an explicit `JAIPH_UNSAFE=true` — and prints a one-line notice that the run is host-only. The CLI never probes for `docker` and never fails just because a Docker daemon is absent, and `JAIPH_DOCKER_ENABLED=true` cannot force the sandbox back on. Windows workflows therefore run with no OS sandbox; keep the [not-protected-against](#what-docker-does-not-protect-against) list in mind, or run under WSL, where the Linux path (and the full sandbox) applies.

## Why `jaiph test` does not use Docker

The test runner runs in-process on the host. This is intentional: tests are a development feedback loop, they typically mock prompts and replace external calls, and Docker spawn overhead would harm the iteration cycle. Tests already get isolation from the things they care about (prompts, network) through the runtime's mock infrastructure. The Docker boundary is for `jaiph run`, where the workflow is executing real scripts against real resources.

## How sandboxing fits the rest of Jaiph

The Docker sandbox does not change workflow semantics. The runtime inside the container is the same **`NodeWorkflowRuntime`** AST interpreter that runs locally — the container runs **`jaiph run --raw`**, which spawns the internal **`__workflow-runner`** child the same way as host **`--raw`** execution (see [Architecture — Docker runtime helper](architecture.md#core-components)), same **`__JAIPH_EVENT__`** stream on stderr, same **`run_summary.jsonl`** written under **`.jaiph/runs/`**. The only differences are *where* processes execute and *what host resources they can reach*.

That property is the point of the design: a workflow is the same workflow whether it runs sandboxed or not. The sandbox is a deployment decision, not a programming model.

## Runtime image toolchain

The default sandbox image (`ghcr.io/jaiphlang/jaiph-runtime`, built from `runtime/Dockerfile`) ships a curated engineering toolchain so `script` steps and agent backends can run common build/test/lint commands without ad-hoc installs. It is **not** a full GitHub Actions VM clone — one stable version per language, no browser/Android SDK matrix, no nested Docker daemon. The published image is currently **~3.2 GB** on disk (linux/amd64); first `docker pull` downloads that footprint once, then layers are cached locally.

### Jaiph and agent backends

| Backend | Mechanism | In image? |
|---|---|---|
| `jaiph` | Workflow runner inside the container | yes |
| `claude` (`@anthropic-ai/claude-code`) | Anthropic CLI subprocess | yes — global npm install |
| `cursor-agent` | Cursor CLI subprocess | yes — user install under `/home/jaiph` |
| `codex` | OpenAI Chat Completions HTTP API (built into `jaiph`; no separate CLI) | yes — uses bundled `node` + `jaiph`; needs `OPENAI_API_KEY` on the host (forwarded when the entry file selects `codex`) |

Configure with `agent.backend = "cursor" | "claude" | "codex"`. Credential rules: [Authenticate agent backends](/how-to/agent-auth).

### Version control and shell

| Tool | Role |
|---|---|
| `git`, `git-lfs` | Clone, commit, LFS assets |
| `bash`, `curl`, `wget`, `openssh-client` | Shell automation and downloads |
| `jq`, `yq`, `ripgrep` | JSON/YAML/text search |
| `rsync`, `zip`, `unzip`, `xz-utils` | File sync and archives |
| `file`, `sqlite3` | File typing and local DB inspection |
| `shellcheck` | Bash script linting |
| `dnsutils`, `netcat-openbsd`, `iproute2` | Network diagnostics |

### JavaScript / TypeScript

| Tool | Role |
|---|---|
| `node`, `npm`, `corepack` | Node runtime and package management |
| `pnpm`, `yarn` | Alternate JS package managers |
| `bun` | Bun-first JS/TS repos |

### Python

| Tool | Role |
|---|---|
| `python3`, `pip`, `python-is-python3` | Python runtime |
| `uv` | Fast env/deps (modern alternative to raw `pip`) |
| `pipx` | Isolated Python CLI tools |

### Go, Java, Rust

| Tool | Role |
|---|---|
| `go` | Go toolchain (single stable release) |
| `java`, `javac`, `JAVA_HOME` | OpenJDK 21 LTS |
| `mvn`, `gradle` | JVM build systems |
| `rustc`, `cargo` | Rust stable minimal profile |

### Build, codegen, and task runners

| Tool | Role |
|---|---|
| `make`, `g++`, `pkg-config`, `libssl-dev` | Native C/C++ builds and cgo |
| `cmake` | Cross-language native builds |
| `protoc` (`protobuf-compiler`) | Protobuf / gRPC codegen |
| `just`, `task` | Modern task runners |

### Platform and cloud CLIs

| Tool | Role |
|---|---|
| `gh` | GitHub PR/CI/releases API |
| `kubectl` | Kubernetes cluster operations |
| `aws` | AWS CLI v2 |

The workspace snapshot is taken host-side (no in-image plumbing required), so the image ships no sandbox-specific packages.

Custom images are supported via `JAIPH_DOCKER_IMAGE` / `runtime.docker_image`; the selected image must already contain `jaiph` (`E_DOCKER_NO_JAIPH` otherwise). Project-specific extras (multiple language versions, DB servers, cloud CLIs beyond the defaults) belong in a workspace override image, not the published default.

## Related

- [Architecture — Docker runtime helper](architecture.md#core-components) — the spawn, mount, and event-stream wiring.
- [Architecture — Channels and hooks in context](architecture.md#channels-and-hooks-in-context) — why hooks run on the host even for containerized runs.
- [Why Jaiph](why-jaiph.md) — the design context that puts the sandbox into the broader picture.
