---
title: Sandboxing
permalink: /sandboxing
diataxis: explanation
redirect_from:
  - /sandboxing.md
---

# The sandboxing model

A Jaiph workflow runs scripts, calls agents, and reads and writes files on whatever machine you run `jaiph run` on. That access is the point of a workflow, and it is also the risk. A careless or untrusted script can read your files, send secrets off the machine, and run any program it wants unless something limits it.

Jaiph limits this risk at two layers, and each layer does a different job.

- **Rules**. A compile-time check of what a `rule` body is allowed to contain.
- **Docker isolation**. A runtime sandbox for `jaiph run` that runs the same workflow inside a container with limited access to the host.

This page explains the model behind sandboxing. It covers what each layer protects, what each layer does not protect, and why the design makes the trade-offs it does. The steps for turning Docker on or off, the full list of configuration keys, and the error codes live on their own how-to and reference pages, so this page stays with the concepts.

For the runtime implementation, see [the Docker runtime helper in Architecture](architecture.md#core-components).

## Two layers, two jobs

Rules and Docker isolation do different work, so it helps to keep them separate.

| Layer | When it fires | What it constrains | What it does not constrain |
|---|---|---|---|
| **Rules** | Compile time | The set of step types allowed inside a `rule` body (no inline shell, no `prompt`, no `const … = prompt`, no `send`, no `run async`) | Anything a `script` does at runtime (rules can still call scripts via `run`) |
| **Docker** | `jaiph run` launch time | Filesystem reach, process isolation, capabilities, and env-var exposure for every step in the workflow | Outbound network (on by default), agent credentials (forwarded by design), hooks (run on the host) |

Rules are about structure. By the time the compiler finishes, a rule cannot contain a step type that changes state in a surprising way. There is no operating system sandbox around a rule body. When a rule calls a script, that script runs as a normal managed subprocess with the same access the workflow has. Treat rules as checks that do not change state, and do the state changes in workflows.

Docker is about limiting damage. It cannot stop a script from misbehaving, but it can keep the misbehavior inside a throwaway container.

## The two sandbox modes {#the-two-sandbox-modes}

When Docker is on, the CLI picks one of two sandbox modes at launch. The mode controls how the workspace appears inside the container. The environment allowlist, the mount allowlist, and the container settings are the same in both modes. Every mode runs with `--cap-drop ALL` and zero cap-adds, `--security-opt no-new-privileges`, no `--device`, no AppArmor exception, and on Linux `--user host_uid:host_gid`.

- **Snapshot mode (default)**. Before launching, the CLI takes a writable, point-in-time snapshot of the workspace and bind-mounts that snapshot read-write at `/jaiph/workspace`. The snapshot is a host-side clone, made with block-level copy-on-write where the filesystem supports it. The snapshot content is defined by git. It holds tracked files, untracked files that are not ignored, and `.git/`, and it leaves out gitignored paths (see [What the snapshot contains](#snapshot-content)). The live host workspace is never mounted into the container. Changes on the host during the run are invisible to the container, and the container's writes to the workspace are discarded when the snapshot is deleted at exit. The snapshot lives at `<run dir>/sandbox` (under `.jaiph/runs/` by default). A tmpfs hides it from the container's own `/jaiph/run` view so the run cannot read its own snapshot source back.
- **Inplace mode**. The host workspace itself is bind-mounted read-write, so the run's edits land live on the host. The goal is a trusted workspace on an untrusted machine. The rest of the sandbox still applies (dropped capabilities, the environment allowlist, and the mount set), but the workspace isolation is removed on purpose so an agent can edit the real checkout in a fast loop.

Snapshot mode gives you one clear property. The host workspace is unchanged after a Docker run. Inplace mode gives up that property in exchange for a faster edit loop, so on `jaiph run` the CLI asks for confirmation before launch, because the run can change your files. `jaiph mcp` uses the same default of an isolated workspace. Set `JAIPH_INPLACE=1` to bind the live workspace read-write for MCP tool calls, and see [the MCP server's safety posture](mcp.md#safety-posture).

### What the snapshot contains {#snapshot-content}

The snapshot is defined by git, not a raw copy of the directory. For a git workspace, the snapshot contains exactly these two things:

- every file that `git ls-files --cached --others --exclude-standard` reports, which is tracked files plus untracked files that are not gitignored, and
- the whole `.git/` directory, so workflows can read history and commit inside the sandbox.

Nothing else is copied. Gitignored files never enter the sandbox. A `.env`, a `credentials.json`, an `.npmrc` with a token, a built `dist/`, and a `node_modules/` tree are all absent from `/jaiph/workspace`. They are not empty, they are absent. This matches how the [environment allowlist](#env-exposure) handles secrets. The approved way to get a secret into a run is to inject it into trusted steps on purpose, with [`--env`](cli.md#jaiph-run) or [`trusted_envs`](configuration.md#trusted-envs), and never because it happened to sit in a gitignored file. Leaving out ignored files is also the main reason cloning is fast, because ignored build directories are usually most of a workspace's files and they are never even scanned.

The content is the same no matter which copy method runs (APFS clonefile, block-level reflink, or a plain data copy) and no matter the platform. What the agent sees comes from git's answer, not from the host filesystem.

Details and edges:

- **git is the only source for ignore rules.** Jaiph uses git's file list and does not reimplement ignore behavior, such as nested `.gitignore` files, `!` negations, `.git/info/exclude`, or global excludes. Whatever git says is in the tree is exactly what the sandbox gets.
- **Non-git workspace** (no `.git` at the workspace root, or `git ls-files` fails). Jaiph falls back to copying everything except the run-artifacts directory. With no git to consult, a file that looks ignored, such as `.env`, is copied. If you rely on git to exclude files, run inside a git repository.
- **Submodules** are copied whole. A path registered in `.gitmodules` appears as a single gitlink entry in `git ls-files`, and Jaiph copies that directory as one subtree without looking inside it.
- **Tracked files that were deleted from the worktree** are skipped. `ls-files --cached` still lists them, but they are not on disk to copy, so nothing is copied for them.

The result is that the sandbox is a clean checkout plus untracked files. Because `node_modules/` and other gitignored build output are absent, a workflow that builds or tests must install its dependencies inside the container, with `npm install`, `pip install`, `cargo fetch`, or the like, the same way a fresh CI checkout would. There is no configuration option to add ignored paths back. If a workflow needs a dependency tree, it installs the tree as one of its steps.

## Confirmation prompts and access scope

Both of these opt-outs can change your files or your machine, so `jaiph run` shows an interactive `Continue? [y/N]` prompt that defaults to no. Each prompt states, in plain language, what the run can reach, because that is what decides how much damage it can do.

| Mode | Sandbox | Filesystem reach | Network / env |
|---|---|---|---|
| **`--inplace`** | Docker on (container boundary, dropped caps, env allowlist) | This workspace directory only, bind-mounted `:rw` at `/jaiph/workspace`. Scripts and agents cannot read or write host paths outside it | Outbound network on by default (set `JAIPH_DOCKER_NETWORK=none` to disable). Only allowlisted env vars cross unless you use `--env` |
| **`--unsafe`** | Docker off. The workflow runs as the host `jaiph` process | Your entire host filesystem (and host `$HOME`, SSH agent, Keychain, and so on), with no mount restriction | Full host environment visible to scripts and agent backends |

- **Inplace prompt.** It names in-place mode and states what the run can reach in two lines. The run can edit files directly in the workspace directory, and the prompt prints that path. The run has no access to other directories, because the rest of your machine stays inside the Docker sandbox. When stdin is not a TTY and no consent is given, the run aborts with `E_DOCKER_INPLACE_NO_CONFIRM`.
- **Unsafe prompt.** It is deliberately stronger, because unsafe mode gives a run more access than inplace mode, not less. It states in one line that the run is in unsafe mode with no sandbox and full access to your machine. It fires only when the unsafe opt-in is what turns Docker off, that is, when Docker would otherwise be on. It does not fire when Docker is off for another reason, such as an explicit `JAIPH_DOCKER_ENABLED=false` or the [Windows host-only override](#windows-runs-host-only), which prints its own one-line notice. When stdin is not a TTY and no consent is given, the run aborts with `E_UNSAFE_NO_CONFIRM`.
- **Auto-confirm.** `--yes` or `-y` (the env form is `JAIPH_INPLACE_YES=1`) skips both prompts. It is the single consent switch, and you need it for non-interactive use of either mode, where stdin is not a TTY. `jaiph run --raw` skips both prompts every time, because it is the entry point used when Jaiph is embedded or run inside Docker, and the wrapping context has already given consent.

In every mode, run artifacts go to a separate read-write mount at `/jaiph/run`, which is outside the workspace sandbox, so the artifact tree under `.jaiph/runs/` stays on the host no matter what happened inside the container.

## Interrupting a Docker run

Pressing Ctrl+C, or sending SIGTERM to the host `jaiph` process, stops the whole run, including the container. Stopping the container matters because a `docker run --rm` container can outlive its host `docker` client. On some setups, such as Docker Desktop, killing the client leaves the container running, so simply killing the CLI would leave an orphaned container. That orphaned container would keep running workflow and agent work against the sandbox with no CLI attached.

Jaiph closes that gap. Every sandboxed container is launched with a fixed name. On interrupt the host CLI removes the container by name before it deletes the host-side sandbox clone. It runs `docker kill` to stop the container, then `docker rm -f` to drop the record of the `--rm` container. The two steps are split on purpose, because a single `docker rm -f` on a still-running container can block on Docker Desktop lock contention while the host `docker run` client is shutting down. The behavior you can rely on is this:

- The container is gone from `docker ps` within a short, bounded window after the interrupt.
- The host-side snapshot at `<run dir>/sandbox` is removed, and it is kept only when `JAIPH_DOCKER_KEEP_SANDBOX=1` is set (see [Environment variables](env-vars.md)). The snapshot is never removed while the container is still live, because the snapshot is bind-mounted into the container.
- The behavior is the same in snapshot mode and inplace mode. The sandbox mode never changes how a run stops.

The same teardown runs when a run hits its Docker timeout (`E_TIMEOUT`), and when a `jaiph mcp` server cancels a single call (see [how to cancel an in-flight MCP call](mcp.md#cancel-an-in-flight-call)). The runtime wiring lives in [the Docker runtime helper in Architecture](architecture.md#core-components).

## What Docker protects against

The Docker sandbox is built to limit the damage from untrusted or semi-trusted workflow scripts. It protects the following things.

- **Filesystem reach.** Scripts inside the container cannot read or write host paths outside the workspace mount and the run-artifacts mount. The rest of the host is invisible to the container. In the default snapshot mode the container works on a point-in-time clone, so the live host workspace is never mounted and is unchanged after the run. The clone is [defined by git](#snapshot-content), so gitignored files, such as secrets in `.env` or tokens in `.npmrc`, never enter the container at all.
- **Process isolation.** Processes in the container cannot see or signal host processes. Every sandboxed container runs with `--cap-drop ALL` and zero cap-adds, `--security-opt no-new-privileges`, no `--device`, and no AppArmor exception. The settings are the same in snapshot mode and inplace mode. On Linux the container runs as the host UID and GID from the first instruction, never as root.
- **Mount safety.** The host root filesystem, the Docker daemon socket, and operating system paths (`/proc`, `/sys`, `/dev`) cannot be mounted into the container. Trying to mount one of them produces a validation error before launch.
- **Environment exposure.** Host environment variables do not cross the boundary by default. Only an explicit allowlist is forwarded. That allowlist is the `JAIPH_*` run-control keys, with `JAIPH_DOCKER_*` and the inplace-control flags left out, plus the credential keys of the agent backends the entry file selects (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for `claude`, `CURSOR_API_KEY` for `cursor`, and `OPENAI_API_KEY` for `codex`). Other variables in those families stay on the host, for example `ANTHROPIC_BASE_URL`, or any `ANTHROPIC_*` or `OPENAI_*` secret that the run's backend does not use. Every other variable is dropped, including unrelated cloud credentials, SSH agents, and registry tokens. The way to forward one key is `--env` on `jaiph run` or `jaiph mcp`. `--env KEY=VALUE`, or `--env KEY` to forward the host value, crosses that variable into the workflow unchanged as an explicit `-e KEY=VALUE` container argument, which bypasses the allowlist. The flag itself is the consent, and its value wins over any value the allowlist forwarded for the same key. Sandbox-control keys and runtime-managed keys are rejected with `E_ENV_RESERVED`, and values are never path-remapped. See [the `jaiph run` flags](cli.md#jaiph-run).

  An `--env` value crosses to the workflow process, not to the model. `prompt` backend subprocesses get a second scrub that always runs and fails closed (`scrubPromptEnv` in `src/runtime/kernel/env-allowlist.ts`), and it runs in every sandbox mode, including host mode. After the scrub the agent receives only the base environment (`PATH`, `HOME`, locale, proxies, `CLAUDE_CONFIG_DIR`, and the like), the `JAIPH_*` control keys, and its own backend's credential keys. Secrets you inject with `--env`, such as `GITHUB_TOKEN`, stay visible to trusted `run` script and workflow steps and never reach the agent.

  A `.jh` file can also declare the host keys its trusted steps need, using the [`trusted_envs`](configuration.md#trusted-envs) config key. It is the in-file alternative to `--env` for the common case of forwarding a host key. Declared keys resolve from a clean snapshot of the host environment and cross the Docker boundary through the same explicit `-e` channel as `--env` pairs, so the declaration is the consent for each key. Declared keys go through the same `prompt` scrub, so they reach trusted `run` steps only, never the agent. Only the entry file's `trusted_envs` is honored, so a declaration in an imported module cannot pull host secrets into its own steps.
{: #env-exposure}
- **Shell injection safety.** Every `docker` call passes an explicit argument array through `execFileSync` or `spawn`, never through `/bin/sh`. Image names and other parameters are passed as literal arguments, so a value that contains shell metacharacters is never expanded by a shell.

## What Docker does **not** protect against

The following list covers what Docker does not defend, on purpose.

- **Outbound network egress is on by default.** The sandbox passes `--network none` only when configuration sets the Docker network mode to `none`, through `JAIPH_DOCKER_NETWORK` or the module key `runtime.docker_network` (see [the runtime Docker keys](configuration.md#runtime-docker-keys)). When the mode is the default value `default`, no `--network` flag is passed and the container uses Docker's bridge with outbound access. A script can then reach outside services and send data off the machine over the network.
- **Agent credentials cross the boundary.** The credential keys of the run's backends (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`, `OPENAI_API_KEY`) are forwarded so agent-backed workflows can work, including the `codex` HTTP backend. Because outbound network is on by default, treat these credentials as fully readable by anything that runs inside the container. Backends the entry file does not select get nothing forwarded.
- **Hooks run on the host.** Hook commands from `.jaiph/hooks.json`, merged with `~/.jaiph/hooks.json`, run in the host CLI process, not inside the container, and they have full host access. Hook config is trusted.
- **You are responsible for the image supply chain.** Jaiph checks that the selected image contains a working `jaiph` binary, but it does not check image signatures or where the image came from. Use trusted registries, and pin image digests for anything you depend on.
- **A container escape is still possible.** Docker is not the same as a virtual machine or hardware isolation. It makes script-level attacks much harder, but a kernel exploit can break out in principle.
- **Inplace mode turns off workspace isolation.** With `JAIPH_INPLACE` set, the run can change your real workspace. The machine outside the workspace stays sandboxed as in any mode, but a run that crashes or misbehaves can leave your checkout half-edited.

Jaiph lists these limits because a sandbox that claims too much is worse than one that is honest about what it does. Jaiph treats the Docker boundary as a way to limit the damage a workflow script can do, not as a vault for credentials or a network firewall.

## Prompt captures in shell steps {#prompt-in-shell}

A workflow can receive free-form text from an agent through a `prompt` step and then use that value in later steps. The value is controlled by the agent or user by design, so a shell step has to treat it as data and never as a command to run.

Workflow shell steps, which are free-form lines in a workflow body, run through `sh -c` after Jaiph substitutes `${varName}` references. Before the runtime substitutes a value into a shell step, it shell-quotes the value, so a value like `` `id` `` or `; rm -rf .` reaches the shell as literal data and is never read as commands. The quoting covers every value a shell step can interpolate, including workflow parameters, `const` values, prompt and other captures, `for` loop iterators, channel payloads, and inline `${run …}` / `${ensure …}` capture results. A caller who reaches a shell step through `jaiph mcp` or `jaiph serve`, where request arguments bind to workflow parameters, cannot inject a command this way.

The compiler adds a second layer for prompt captures. It emits a `W_PROMPT_IN_SHELL` diagnostic when a prompt capture is interpolated into a shell step:

```jaiph
workflow default() {
  const msg = prompt "Enter a label:"
  git commit -m "${msg}"   # W_PROMPT_IN_SHELL: msg is agent-controlled
}
```

The diagnostic fails the build. `jaiph compile` exits non-zero and `jaiph run` refuses to start, through the same recoverable-error channel every other `E_` or `W_` diagnostic uses, because Jaiph has no separate non-fatal warning level today. It steers you toward the argv path below, which keeps an agent-controlled value out of the shell command string in the first place.

The safe pattern is to pass prompt captures as named arguments to a `script` step. Scripts receive arguments through `$1 $2 …` as argv, not as shell-expanded strings, so there is no substitution step between the capture value and the script's argument.

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

The compiler does not warn on `run script(promptCapture)`, which is the recommended form.

When the diagnostic fires and when it does not:

| Pattern | Diagnostic |
|---|---|
| `echo "${capture}"` in a workflow body (shell step) | `W_PROMPT_IN_SHELL` |
| `run myscript(capture)` | none (argv is safe) |
| `log "${capture}"` / `logerr "${capture}"` | none (log output is not a shell `sh -c` execution) |
| Non-prompt variable interpolated in a shell step | none |

To resolve the diagnostic, remove the prompt capture from the shell line. There is no inline suppress comment and no non-fatal-warning mode. The intended fix is the argv path above. Move the shell line into a named or inline `script` that receives the value as `$1`, which is both the safe form and the form the compiler accepts. Rewriting the substitution with your own shell quoting inside the same shell step does not clear the diagnostic, because the check flags the data flow of a prompt capture reaching a shell step, not the specific escaping.

Under `--unsafe` or `--inplace`, the host filesystem is fully exposed, so any command a shell step runs takes effect directly on the host. Runtime shell-quoting keeps an interpolated value from injecting extra commands, whatever its source, and the compile-time diagnostic steers prompt captures onto the argv path. The argv path is still the form to prefer, because passing a value as `$1` hands the script the exact bytes with no quoting applied. Shell-quoting a value that contains shell metacharacters changes how it prints. For example, a value of `$(id)` interpolated into `echo "${name}"` prints as the literal `$\(id\)`, because the runtime escaped it. A script that reads the value as `$1` receives `$(id)` unchanged.

## Why opt-out, not opt-in

Docker is on by default. It stays on unless the host sets `JAIPH_UNSAFE=true`, or sets `JAIPH_DOCKER_ENABLED` to any value other than exactly `true`. The default is deliberate. Workflows run agent and script code that is often pulled from a repository, edited by a model, or contributed by someone else. Making the safer setting the easy path means a careless workflow is contained by default, and it escapes the container only when a person types out the override.

A second choice is also deliberate. Turning the sandbox on or off lives entirely in environment variables, not in the in-file `config`. Module-level `runtime.docker_*` keys can set the image, the network, and the timeout, but nothing in a `.jh` file can turn Docker off, and `runtime.docker_enabled` is rejected at parse time. This keeps the host in charge of whether the sandbox runs, so a workflow file from a less-trusted source cannot ship an off-switch with it.

The escape hatch is `JAIPH_UNSAFE=true` or `jaiph run --unsafe`. It exists because some environments genuinely cannot run Docker, such as a sandboxed CI without nested virtualization, or a developer working on the runtime itself. Taking the hatch should be clear and easy, so it is a single host-side switch rather than an in-file `config` setting. On `jaiph run` it is also gated behind the [unsafe confirmation prompt](#confirmation-prompts-and-access-scope), or an explicit `--yes` or `JAIPH_INPLACE_YES` for non-interactive use, so turning off the sandbox is a deliberate act, not a silent default.

## Windows runs host-only

On Windows (`win32`) the Docker sandbox is out of scope. The sandbox modes rely on POSIX socket paths and on workspace handling specific to Linux and macOS, so Jaiph does not try them on Windows. `jaiph run` on Windows uses host-only mode automatically, which is the same as an explicit `JAIPH_UNSAFE=true`, and it prints a one-line notice that the run is host-only. The CLI never probes for `docker` and never fails just because no Docker daemon is present, and `JAIPH_DOCKER_ENABLED=true` cannot force the sandbox back on. Windows workflows therefore run with no operating system sandbox, so keep the [what Docker does not protect against](#what-docker-does-not-protect-against) list in mind, or run under WSL, where the Linux path and the full sandbox apply.

## Why `jaiph test` does not use Docker

The test runner runs in-process on the host, on purpose. Tests are a fast development loop, they usually mock prompts and replace outside calls, and the cost of spawning Docker would slow that loop down. Tests already get isolation from the things they care about, such as prompts and network, through the runtime's mock support. The Docker boundary is for `jaiph run`, where the workflow runs real scripts against real resources.

## How sandboxing fits the rest of Jaiph

The Docker sandbox does not change what a workflow means. The runtime inside the container is the same **`NodeWorkflowRuntime`** AST interpreter that runs locally. The container runs **`jaiph run --raw`**, which spawns the internal **`__workflow-runner`** child the same way host **`--raw`** execution does (see [the Docker runtime helper in Architecture](architecture.md#core-components)). It uses the same **`__JAIPH_EVENT__`** stream on stderr and writes the same **`run_summary.jsonl`** under **`.jaiph/runs/`**. The only differences are where the processes run and what host resources they can reach.

That sameness is the point of the design. A workflow is the same workflow whether it runs sandboxed or not. The sandbox is a deployment choice, not a programming model.

## Runtime image toolchain

The default sandbox image is `ghcr.io/jaiphlang/jaiph-runtime`, built from `runtime/Dockerfile`. It ships a curated set of engineering tools so `script` steps and agent backends can run common build, test, and lint commands without installing them each time. It is not a full clone of a GitHub Actions VM. It ships one stable version per language, no browser or Android SDK matrix, and no nested Docker daemon. The published image is currently about 3.2 GB on disk (linux/amd64). The first `docker pull` downloads that once, and after that the layers are cached locally.

### Jaiph and agent backends

| Backend | Mechanism | In image? |
|---|---|---|
| `jaiph` | Workflow runner inside the container | yes |
| `claude` (`@anthropic-ai/claude-code`) | Anthropic CLI subprocess | yes (global npm install) |
| `cursor-agent` | Cursor CLI subprocess | yes (user install under `/home/jaiph`) |
| `codex` | OpenAI Chat Completions HTTP API, built into `jaiph`, no separate CLI | yes, uses bundled `node` and `jaiph`, and needs `OPENAI_API_KEY` on the host (forwarded when the entry file selects `codex`) |

Set the backend with `agent.backend = "cursor" | "claude" | "codex"`. For credential rules, see [Authenticate agent backends](agent-auth.md).

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

The workspace snapshot is taken on the host, with no support needed inside the image, so the image ships no packages specific to the sandbox.

You can use a custom image through `JAIPH_DOCKER_IMAGE` or `runtime.docker_image`. The selected image must already contain `jaiph`, or the run fails with `E_DOCKER_NO_JAIPH`. Project-specific extras, such as several language versions, database servers, or cloud CLIs beyond the defaults, belong in a workspace override image, not in the published default.

## Related

- [The Docker runtime helper in Architecture](architecture.md#core-components) covers the spawn, mount, and event-stream wiring.
- [Channels and hooks in context, in Architecture](architecture.md#channels-and-hooks-in-context) explains why hooks run on the host even for containerized runs.
- [Deploy the runtime image standalone](deploy.md) covers running the runtime image directly, with `docker run` or Kubernetes, where the container is the sandbox and there is no jaiph-managed isolation.
- [Why Jaiph](why-jaiph.md) gives the design context around the sandbox.
