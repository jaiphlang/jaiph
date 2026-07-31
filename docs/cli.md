---
title: CLI
permalink: /reference/cli
diataxis: reference
redirect_from:
  - /cli
  - /cli.md
---

# CLI

This page is the authoritative inventory of the `jaiph` CLI: every subcommand, every flag, every exit-relevant behaviour. It does not explain how to choose between commands — see [Why Jaiph](why-jaiph.md) for context and the how-to pages for recipes.

The published `jaiph` bin is `node dist/src/cli.js` (npm) or the standalone `dist/jaiph` (Bun-compiled). Both dispatch through `src/cli/index.ts`.

## Invocation forms

| Form | Effect |
|---|---|
| `jaiph` | Print the overview and exit `0`. |
| `jaiph --help` / `-h` | Print the overview and exit `0`. |
| `jaiph --version` / `-v` | Print the CLI version and exit `0`. |
| `jaiph <subcommand> [-h \| --help]` | Print the subcommand's usage (flags + one example) and exit `0`. Recognised anywhere in the arg list before `--`. (`compile` scans help inline with no `--` cutoff, so it is recognised at any position — see [`jaiph compile`](#jaiph-compile).) |
| `jaiph <path>` | File shorthand. Paths ending in `*.test.jh` route to `jaiph test`; other `*.jh` paths route to `jaiph run`. Non-existent paths fall through to normal command parsing. |
| `jaiph --mcp <file.jh>` | Alias for `jaiph mcp <file.jh>`, dispatched alongside the subcommand. |
| `jaiph <unknown>` | Print `Unknown command: <name>`, repeat the overview, exit `1`. |

The reserved internal marker `__workflow-runner` is excluded from `--help`/usage and from the file-shorthand path; it is used by `process.execPath` self-spawn (see [Architecture — Distribution: Node vs Bun standalone](architecture.md#distribution-node-vs-bun-standalone)).

## Subcommand summary

| Subcommand | Purpose |
|---|---|
| `run` | Compile, launch, and observe one workflow run (with optional Docker sandboxing). |
| `test` | Execute `*.test.jh` blocks in-process with mocks. |
| `compile` | Multi-error validation pass — no `scripts/` emission, no runtime spawn. |
| `format` | Rewrite `.jh` / `.test.jh` files into canonical style. |
| `init` | Initialize `.jaiph/` directory layout in a workspace. |
| `install` | Install project-scoped libraries from the registry or git URLs. |
| `use` | Reinstall `jaiph` globally with a selected version or channel. |
| `mcp` | Serve a file's workflows as MCP tools over stdio (newline-delimited JSON-RPC). |
| `serve` | Serve a file's workflows as an HTTP API, with an OpenAPI document and an embedded Swagger UI. |

## `jaiph run`
{: #jaiph-run}

Compile and execute a workflow's `default` entrypoint.

```text
jaiph run [--target <dir>] [--raw] [--workspace <dir>] [--inplace] [--unsafe] [--yes|-y] [--env KEY[=VALUE]]... <file.jh> [--] [args...]
```

Sandbox selection is environment-driven; there is no `--docker` flag. The boolean sandbox flags (`--inplace`, `--unsafe`, `--yes`) are CLI front-ends that mutate the launched runtime env for one run only, and are shared verbatim with `jaiph serve` and `jaiph mcp` (one execution-policy contract; precedence: CLI flags > `JAIPH_*` env vars > workflow config metadata > defaults) — see [Configuration — Precedence](configuration.md#precedence) and [Environment variables — Precedence](env-vars.md#precedence). Flags belonging to another command (`--host`, `--port`) and unknown flags are usage errors, never positionals.

### Flags

| Flag | Argument | Effect |
|---|---|---|
| `--target` | `<dir>` | Keep emitted script files and run metadata under `<dir>` instead of a temp directory. |
| `--raw` | — | Skip the banner, live progress tree, hooks, and PASS/FAIL footer. The runner child inherits stdio; `__JAIPH_EVENT__` JSON lines go to stderr unchanged. Host `--raw` never launches Docker even when `JAIPH_DOCKER_ENABLED=true`. |
| `--workspace` | `<dir>` | Override the workspace root used for library resolution and the Docker workspace mount. A missing value, missing path, or non-directory aborts with a specific message. There is no `JAIPH_WORKSPACE` env equivalent input — that name is reserved for the in-container remap output. |
| `--inplace` | — | Front-end for `JAIPH_INPLACE=1`. On a TTY, prints a destructive-edit warning that **leads with the access scope** (edits land in this workspace directory only — `<path>` — while the rest of your machine stays inside the Docker sandbox) plus the git-tree recovery posture, then requires `Continue? [y/N]` (default **no**). Non-TTY requires `--yes` / `JAIPH_INPLACE_YES` or aborts with `E_DOCKER_INPLACE_NO_CONFIRM`. |
| `--unsafe` | — | Front-end for `JAIPH_UNSAFE=true`. Cannot be combined with `--inplace` (`E_FLAG_CONFLICT`). When this turns Docker off while it would otherwise be on, a **stronger** confirmation than `--inplace` fires: the warning states host-only / **no sandbox**, that filesystem access is your **entire machine** (not just the workspace), and that scripts and agent backends can read secrets from your environment and reach paths outside the project. On a TTY it requires `Continue? [y/N]` (default **no**); non-TTY requires `--yes` / `JAIPH_INPLACE_YES` or aborts with `E_UNSAFE_NO_CONFIRM`. No prompt fires when Docker is off for another reason (explicit `JAIPH_DOCKER_ENABLED=false`, or the Windows host-only override, which prints its own notice). `--raw` skips this prompt (embedding / Docker inner run). |
| `-y`, `--yes` | — | Front-end for `JAIPH_INPLACE_YES=1`. Skips **both** the `--inplace` and `--unsafe` confirmation prompts — required to use either mode non-interactively. |
| `--env` | `KEY=VALUE` or `KEY` | Repeatable per-key environment passthrough into the workflow process. `--env KEY=VALUE` defines `KEY` with that exact value (first `=` splits; the value may contain `=`; empty is allowed). `--env KEY` forwards the host's current value, aborting with `E_ENV_MISSING` before spawning if `KEY` is unset on the host. `KEY` must match `[A-Za-z_][A-Za-z0-9_]*` (else `E_ENV_INVALID`). Reserved sandbox-control keys (`JAIPH_UNSAFE`, `JAIPH_INPLACE`, `JAIPH_INPLACE_YES`, any `JAIPH_DOCKER_*`) and runtime-managed keys (`JAIPH_WORKSPACE`, `JAIPH_RUNS_DIR`, `JAIPH_RUN_ID`, `JAIPH_SCRIPTS`, `JAIPH_MODULE_GRAPH_FILE`, `JAIPH_SOURCE_ABS`, `JAIPH_META_FILE`, `JAIPH_AGENT_TRUSTED_WORKSPACE`, `JAIPH_RUN_WORKFLOW`) are rejected with `E_ENV_RESERVED` — use the sandbox flags or real env vars for those. **In a Docker sandbox `--env` is the per-key consent that crosses the fail-closed env allowlist verbatim** (added as explicit `-e KEY=VALUE` container args, winning over any allowlist-forwarded value); see [Sandboxing — Environment exposure](sandboxing.md#env-exposure). Values are never path-remapped. |
| `--` | — | End of Jaiph flags; remaining tokens are forwarded to `workflow default`. |

### Pre-flight

After module-graph load and Docker-mode resolution, before the runner / container is spawned, the host CLI runs a credential pre-flight (`src/cli/run/preflight-credentials.ts`). Missing credentials produce either `E_AGENT_CREDENTIALS` (hard error) or a warning depending on backend and Docker mode — see [Authenticate agent backends](agent-auth.md) and [Configuration — Credential pre-flight](configuration.md#credential-pre-flight). `jaiph run --raw` does not run the pre-flight.

### Progress markers

| Marker | Meaning |
|---|---|
| `▸` | Step started. |
| `✓` | Step completed successfully (with elapsed time). |
| `✗` | Step failed (with elapsed time). |
| `ℹ` | `log` message (dim/gray, no marker timing). |
| `!` | `logerr` message (red; rendered on stdout with the progress tree). |
| `⚠` | `logwarn` message and automatic leaf-step idle warnings (yellow; rendered on stdout with the progress tree). |
| `·` | Continuation marker (heartbeat lines in non-TTY mode). |
| ` ₁`, ` ₂`, … | Subscript prefix for `run async` branch numbering. |

PASS line: `✓ PASS workflow default (0.2s)`. TTY runs append a transient `▸ RUNNING workflow <name> (X.Xs)` line that is replaced by the PASS/FAIL line on exit. `--raw` and non-TTY modes skip both. Disable color globally with `NO_COLOR=1`.

Non-TTY heartbeat cadence is controlled by `JAIPH_NON_TTY_HEARTBEAT_FIRST_SEC` (default `60`) and `JAIPH_NON_TTY_HEARTBEAT_INTERVAL_MS` (default `30000`, floor `250`). Leaf script and prompt steps emit a yellow `⚠` idle warning when they produce no stdout/stderr for `JAIPH_STEP_IDLE_WARN_SEC` (default `180`; `0` disables).

### Step display

Step lines include the kind (`workflow`, `prompt`, `script`, `rule`) and name. Parameterised invocations append `key="value"` pairs in parentheses (positional params use `1=…` / `2=…`); whitespace is collapsed; values are truncated to 32 characters. Prompt step lines additionally show the backend name (or custom command basename), the effective model, and the first 24 characters of the prompt body in quotes (full line capped at 96 characters): `▸ prompt claude sonnet "Classify this task…"` on start and `✓ prompt claude sonnet (5s)` on completion. The model is the value passed to the backend (`agent.model` / `JAIPH_AGENT_MODEL` / a `--model` flag); it is a bare token between the backend and the quoted preview. When a built-in backend (cursor, claude, codex) auto-selects its own model, the token shows the literal `default` (`▸ prompt cursor default "…"`); it is omitted only for custom agent commands, which have no model concept (`▸ prompt my-agent "…"`).

### Return values

When `workflow default` returns a value (success only), the runtime writes `return_value.txt` under the run directory. Interactive `jaiph run` prints that value on stdout after the PASS line, separated by a blank line. `jaiph run --raw` never prints it to stdout; the file alone is the contract.

### Run artifacts

Each run directory is `<JAIPH_RUNS_DIR>/<YYYY-MM-DD>/<HH-MM-SS>-<source>/`, UTC. `<source>` is `JAIPH_SOURCE_FILE` if set, otherwise the entry-file basename. Layout pinned in [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout).

Step `.out` files are written incrementally; consumers may `tail -f` them. `.out` / `.err` pairs are allocated at `STEP_START` with monotonic per-run sequence numbers (`%06d-<safe_name>.out|.err`).

### Failure footer

Interactive `jaiph run` only (`--raw` omits this block). On non-zero exit, the CLI emits a stderr footer with `Logs:`, `Summary:`, `out:` / `err:` paths, and an `Output of failed step:` excerpt. The fields are resolved from the last `STEP_END` object with non-zero `status` in `run_summary.jsonl`; `out_content` / `err_content` are preferred over `out_file` / `err_file`. In Docker mode, container-internal `/jaiph/run/*` paths are remapped to host paths.

### Hook events

Hooks load from `~/.jaiph/hooks.json` (global) and `<project>/.jaiph/hooks.json` (project-local; project overrides global per event). Hooks run on the **host** CLI process even in Docker mode. See [Add a hook](hooks.md).

## `jaiph test`

Execute `*.test.jh` blocks using the same `NodeWorkflowRuntime` as `jaiph run`, in-process, with mock support.

```text
jaiph test                            # discover all *.test.jh under the workspace root
jaiph test <dir>                      # discover all *.test.jh recursively under <dir>
jaiph test <file.test.jh>             # run a single test file
```

| Invocation | Workspace root detection |
|---|---|
| `jaiph test` | Walk up from `process.cwd()` until `.jaiph` or `.git`; falls back to `process.cwd()`. |
| `jaiph test <dir>` | Walk up from the resolved `<dir>`. |
| `jaiph test <file>` | Walk up from the test file's directory. |

Zero matches with no arguments (or with a directory containing no `*.test.jh` files) writes `jaiph test: no *.test.jh files found (nothing to do)` to stderr and exits `0`. An explicit file path that does not exist or is not `*.test.jh` exits `1`. Plain workflow files (`*.jh` without `.test`) are not supported as test entries. Extra positional tokens after the path are accepted but ignored.

Assertions: `expect_contain`, `expect_equal`, `expect_not_contain` — see [Write & run tests](testing.md).

## `jaiph compile`
{: #jaiph-compile}

Parse modules and run `collectDiagnostics(graph)` — the same per-module validator as `jaiph run`, but collecting every recoverable error instead of stopping at the first — **without** writing `scripts/`, **without** calling `buildRuntimeGraph()`, and **without** spawning the workflow runner.

```text
jaiph compile [--json] [--workspace <dir>] <file.jh | directory> ...
```

At least one path is required. Unlike the other subcommands (which stop scanning for help at `--`), `compile` parses `-h` / `--help` inline in its argument loop, so a help flag is recognised at any position — before or after a path.

| Argument shape | Behaviour |
|---|---|
| File path (`*.jh` or `*.test.jh`) | Expanded to the transitive import closure. Each module in the union is parsed and validated once. |
| Directory path | Tree scanned for `*.jh` files; `*.test.jh` is **skipped** (use an explicit file path to validate a test module). Each non-test `*.jh` is treated as an entrypoint and its closure merged into the validation set. |

| Flag | Effect |
|---|---|
| `--json` | On success, print `[]` to stdout. On failure, print one JSON array of `{ file, line, col, code, message }` diagnostics to stdout and exit `1`. |
| `--workspace <dir>` | Override library resolution root for all reached modules. Without it, the workspace is auto-detected per path. |

Within each entry's import closure, diagnostics are sorted by `(file, line, col)`; when multiple entry points are supplied, those batches are appended in discovery order (not re-sorted globally). Without `--json`, the same set is written to stderr as `path:line:col CODE message` lines. Any non-empty diagnostic set exits `1`. Parser/loader failures abort the affected entry's closure with a single diagnostic for that entry; siblings continue.

## `jaiph format`

Reformat `.jh` / `.test.jh` files into canonical style.

```text
jaiph format [--check] [--indent <n>] <path.jh ...>
```

Paths must end with `.jh`. Formatting is idempotent. Comments and shebangs are preserved. Triple-quoted bodies and prompt blocks emit verbatim (author margin preserved via trivia). Fenced script bodies are stored dedented in the AST; the formatter re-indents inner lines by one level relative to the surrounding scope.

| Flag | Argument | Default | Effect |
|---|---|---|---|
| `--indent` | `<n>` | `2` | Spaces per indent level. |
| `--check` | — | — | Verify without writing. Exit `0` when files match canonical form, `1` when any file would change. |

Top-level ordering: the formatter hoists `import`, `config`, and `channel` declarations to the top (in that order, preserving relative source order within each group). Other top-level definitions (`const`, `rule`, `script`, `workflow`, `test`) keep their relative source order. Comments before a hoisted construct move with it; comments before non-hoisted definitions stay in place.

Top-level `const` quoting: the source delimiter is preserved per binding. Quoted values stay quoted; bare tokens stay bare; `"""…"""` values emit verbatim. The formatter does not toggle between styles based on value content.

Blank-line preservation: a single blank line between steps inside a workflow or rule body is preserved. Multiple consecutive blank lines collapse to one. Trailing blank lines before `}` are removed.

## `jaiph init`

```text
jaiph init [workspace-path]
```

Creates the following under the target workspace:

| File | Content |
|---|---|
| `.jaiph/.gitignore` | Two-line file listing `runs` and `tmp`. If the file exists and does not match, the command exits non-zero. |
| `.jaiph/bootstrap.jh` | Canonical bootstrap workflow; made executable. The body is a triple-quoted multiline `prompt` that asks the agent to scaffold workflows. |
| `.jaiph/SKILL.md` | Copy of the skill markdown shipped with this `jaiph` build (see [`JAIPH_SKILL_PATH`](env-vars.md)). |

SKILL.md resolution order: `JAIPH_SKILL_PATH` (if set and the path exists) → install-relative paths (`jaiph-skill.md` next to the package tree, then `docs/jaiph-skill.md` next to the package) → `docs/jaiph-skill.md` under the current working directory → the embedded copy baked into the binary. There is no "skip and warn" path; the file is always written.

## `jaiph install`

Install project-scoped libraries into `.jaiph/libs/<name>/` under the workspace root. The workspace root is detected from `process.cwd()` (`detectWorkspaceRoot` — walks up until `.jaiph` or `.git`, with temp-directory guards).

```text
jaiph install [--force] [<name[@version]> | <repo-url[@version]> ...]
jaiph install [--force]                  # restore from lockfile
```

| Flag | Effect |
|---|---|
| `--force` | Delete and re-clone existing libraries. Accepted anywhere in the argument list. |

### Argument classification

| Argument shape | Resolution |
|---|---|
| Bare registry name matching `^[A-Za-z0-9_-]+(@[A-Za-z0-9._+/-]+)?$` (no `/`, no `:`) | Looked up in the registry index. Examples: `jaiphlang`, `mylib@v1.2`. |
| Anything else | Parsed as a git URL with optional trailing `@<version>`. Examples: `https://github.com/you/queue-lib.git`, `git@github.com:org/repo.git@main`. |

### Scheme allowlist

Remote registry and library URLs must use an allowed scheme. A value with an explicit URL scheme is accepted only for `https://`, `ssh://`, or `file://`; scheme-less paths and scp-style `git@host:path` remotes (which are SSH) are treated as local/SSH and accepted. `http://`, `git://`, and any other scheme are rejected before any fetch or clone with `... "<url>" uses disallowed scheme "<scheme>://" — only https:// and ssh:// are permitted for remote sources`.

### Post-clone hygiene

Each successful clone runs these checks before the lib counts as installed:

- **`.jh` module check** — at least one `*.jh` file must exist under the clone (recursive, `.git` skipped). Failure removes the directory and aborts with `lib "<name>" contains no .jh modules — not a jaiph library?`. No lock entry written.
- **Commit capture** — `git rev-parse HEAD` is recorded as the 40-char `commit` on the lock entry.
- **Pinned-commit check** — when the registry entry (or lock entry) carries a `commit`, the cloned HEAD must equal it, or the directory is removed and the install fails with the locked vs cloned SHAs and the remedy. This makes the *first* install from the registry authenticated, not just restore.
- **Detached signature check** — when the registry entry carries a `signature` (a detached minisign signature over the ASCII commit SHA), it is verified against the entry's `publicKey` (or the embedded `jaiph.pub` when absent). An invalid or unverifiable signature removes the directory and fails the install closed with `lib "<name>" signature verification failed for commit <sha>`.
- **`.git` strip** — `<libDir>/.git` is removed recursively.

### Restore-from-lockfile mode

`jaiph install` with no positional args reads `.jaiph/libs.lock` and clones each entry. The registry is never contacted. If a lock entry carries a `commit`, the cloned HEAD must match it; on mismatch the directory is removed and the run fails with the locked vs cloned SHAs and the remedy. Lock entries without `commit` (older lockfiles) restore without the check.

### Parallel clones

Missing libraries are cloned with bounded concurrency (default **4 in flight**). The warm-skip pass runs before any clone. Independent clone failures still propagate; failed libraries are not added to the lockfile.

### Registry

| Aspect | Value |
|---|---|
| Source | `JAIPH_REGISTRY` (default `https://jaiph.org/registry`). Remote sources must satisfy the [scheme allowlist](#scheme-allowlist). |
| Loading | Loaded once per invocation when at least one positional argument is a bare name. URL-form installs and restore-from-lock never read the registry. |
| Disk paths | Values without a `://` scheme, or starting with `file://`, are read from disk (trusted-local, no signature check). Everything else is fetched via global `fetch`. |
| Signature verification | A remotely fetched index is verified against a detached `<source>.minisig` (minisign, `jaiph.pub` embedded as the trust anchor) before use. A missing, unsigned, or tampered index is rejected — the fetch fails closed. `jaiph.org` therefore serves `registry.minisig` alongside `registry`; see [Contributing](contributing.md#library-registry-signing). |
| Index format | `{ "libs": { "<name>": { "url": "<git-url>", "description": "<string>", "commit"?: "<40-hex>", "signature"?: "<minisig>", "publicKey"?: "<minisign pubkey>" } } }`. Each key must match `^[A-Za-z0-9_-]+$`. `commit` (when present) pins the install; `signature`/`publicKey` add a per-library detached-signature check. Other per-entry keys are accepted and ignored. |
| Lookup errors | `lib "<name>" not found in registry <source>`, `failed to read registry <source>: <cause>`, `failed to fetch registry <source>: HTTP <status>`, `failed to fetch registry signature <source>.minisig: <cause>`, `failed to verify registry <source>: signature check failed against <source>.minisig`, `failed to parse registry <source>: <cause>`, `... uses disallowed scheme "<scheme>://" ...`. |

### Lockfile

`.jaiph/libs.lock` shape:

```json
{
  "libs": [
    {
      "name": "jaiphlang",
      "url": "https://github.com/jaiphlang/jaiphlang.git",
      "commit": "1a2b3c4d5e6f7890abcdef1234567890abcdef12"
    },
    {
      "name": "queue-lib",
      "url": "https://github.com/you/queue-lib.git",
      "version": "v1.0",
      "commit": "fedcba9876543210fedcba9876543210fedcba98"
    }
  ]
}
```

The lock entry stores the resolved clone URL so restore works without the registry. `commit` is written automatically after each successful clone.

## `jaiph use`

Reinstall `jaiph` globally with the selected channel or version.

```text
jaiph use <version|nightly>
```

| Argument | Effect |
|---|---|
| `nightly` | Reinstalls from the rolling `nightly` prerelease. |
| `<version>` (e.g. `0.12.0`) | Reinstalls the release binary for tag `v<version>`. |

Implementation: re-invokes `JAIPH_INSTALL_COMMAND` (default `curl -fsSL https://jaiph.org/install | bash`) with `JAIPH_REPO_REF` set to `nightly` or `v<version>`. The installer downloads the matching per-platform binary plus `SHA256SUMS`, verifies the checksum, and replaces `~/.local/bin/jaiph` (or `JAIPH_BIN_DIR`).

## `jaiph mcp`
{: #jaiph-mcp}

Serve a file's workflows as [MCP](https://modelcontextprotocol.io/) tools over stdio. See [Serve workflows as MCP tools](mcp.md) for the recipe and client-registration steps.

```text
jaiph mcp [--workspace <dir>] [--inplace] [--unsafe] [--yes|-y] [--env KEY[=VALUE]]... <file.jh>
```

`jaiph --mcp <file.jh>` is an equivalent alias, dispatched after `compile` in `src/cli/index.ts`.

| Flag | Argument | Effect |
|---|---|---|
| `--workspace` | `<dir>` | Workspace root for import resolution (default: auto-detected from the file's directory). A missing value or non-directory path aborts with a specific message. |
| `--env` | `KEY=VALUE` or `KEY` | Same per-key passthrough as `jaiph run --env` (same forms, validation, and reserved-key rejection), resolved once at startup and applied to **every** tool call for the server's lifetime. A bare `--env KEY` unset on the host aborts server startup with `E_ENV_MISSING`. In Docker mode the pairs cross the container boundary as explicit `-e` args bypassing the allowlist, exactly as for `jaiph run --env`. |
| `--inplace` | — | Front-end for `JAIPH_INPLACE=1`: every tool call's Docker sandbox bind-mounts the host workspace read-write. Mutually exclusive with `--unsafe` (`E_FLAG_CONFLICT` at startup, before anything is spawned). No interactive prompt — launching the server with the flag (or env var) is the consent; the effective posture is printed once at startup and applied to every call. |
| `--unsafe` | — | Front-end for `JAIPH_UNSAFE=true`: every tool call runs on the host with no sandbox. Same startup-consent model as `--inplace`. |
| `-y`, `--yes` | — | Front-end for `JAIPH_INPLACE_YES=1` (recorded on every call's env; servers themselves never prompt). |
| `-h`, `--help` | — | Print the subcommand usage and exit `0`. |

Flags that belong to another command (for example `--raw` or `--port`) are usage errors naming the owning command — never silently ignored. Precedence across layers is the shared execution-policy order: CLI flags > `JAIPH_*` env vars > workflow config metadata > defaults (see [Environment variables — Precedence](env-vars.md#precedence)).

### Startup and exit behaviour

- Loads the module graph and runs `collectDiagnostics` (the same compile-time pass as `jaiph compile`). Any diagnostic prints `file:line:col CODE message` lines to **stderr** and exits `1`.
- A missing path, a non-`.jh` path, or a path that is not a file exits `1` with a message on stderr.
- On success the server runs until stdin closes or it receives `SIGINT` / `SIGTERM`. Shutdown is **drain-then-cancel**: stdin closing (or the first signal) stops accepting input and waits for in-flight calls to finish before cleaning up and exiting `0` — a draining call keeps its scripts until it settles. A **second** signal cancels the in-flight calls instead of waiting: each run's child process tree is terminated (`SIGINT`, then `SIGKILL` after a grace period) and, in Docker mode, its container is force-removed (`docker rm -f`), so no child process or container outlives the server; the killed calls settle with error results and the server still exits `0`.

### stdout invariant

From the moment the server starts, **stdout carries only newline-delimited JSON-RPC**. Every banner, warning, workflow-exclusion notice, reload message, Docker notice, and credential-pre-flight warning goes to **stderr**. Each outbound protocol message is a single atomic write of `JSON.stringify(msg) + "\n"`.

### Protocol subset

Newline-delimited JSON-RPC 2.0. Requests are handled concurrently (a long `tools/call` never stalls `ping` or further calls).

| Method | Behaviour |
|---|---|
| `initialize` | Replies with `protocolVersion`, `capabilities: {tools: {listChanged: true}}`, and `serverInfo: {name: "jaiph", title: "Jaiph workflows", version}`. Echoes the client's `protocolVersion` if it is one of `2024-11-05`, `2025-03-26`, `2025-06-18`; otherwise replies with the newest of that set. |
| `ping` | Empty result. |
| `tools/list` | `{tools: [{name, description, inputSchema}]}` from the current tool set (re-read per request, so hot reload needs no cache invalidation). |
| `tools/call` | Runs the workflow (Docker sandbox or host, per the env — see Execution below). Result: `{content: [{type: "text", text}], isError}`. When `params._meta.progressToken` is present, the run's `STEP_START` / `STEP_END` events stream as `notifications/progress` until the response is sent (see below). |
| `notifications/cancelled` | Cancels the matching in-flight `tools/call` (`params.requestId`): terminates the run's child process tree (SIGINT, then SIGKILL after a grace period) and, in Docker mode, force-removes the call's container (`docker rm -f`) so it cannot orphan; sends **no response** for that id, and keeps the server serving. A cancellation for an unknown or already-finished id is a no-op. |
| other notifications | Ignored (`notifications/initialized`, …); no response. |
| unknown request | JSON-RPC error `-32601`. |

The server emits `notifications/tools/list_changed` after a successful hot reload (only once `initialize` has happened).

When a `tools/call` carries a `progressToken`, the server also emits `notifications/progress` (`{progressToken, progress, message}`) for that call — one per step event, with a monotonically increasing `progress` counter and a `message` of `"<kind> <name>"` (no `total`, since a workflow's step count is not known up front). Notifications stop the instant the call's response is sent; a call without a `progressToken` emits none. See [Serve workflows as MCP tools — Stream progress and cancel a long call](mcp.md#7-stream-progress-and-cancel-a-long-call).

### Error mapping

| Condition | Code |
|---|---|
| Invalid JSON | `-32700` (with `id: null`) |
| Non-object message | `-32600` |
| Unknown method | `-32601` |
| Unknown tool, missing/non-string required argument, or unexpected argument key | `-32602` (the call never starts) |
| Infrastructure crash while running a call | `-32603` (also logged to stderr) |
| **Workflow failure** | *not* a protocol error — a normal result with `isError: true` and a `run dir:` pointer |

### Exposure and naming

The tool surface is derived from the **entry file only** (imports are never exposed):

| Rule | Behaviour |
|---|---|
| `export workflow …` present | Exactly the exported workflows are exposed. |
| No exports | Every top-level workflow except channel route targets (skipped with a warning). |
| `default` | Exposed only when it is the sole candidate, named after the sanitized file basename (`.jh` stripped, non-`[A-Za-z0-9_-]` → `_`, truncated to 128); otherwise skipped. |

Tool descriptions come from the `#` comment lines directly above each workflow (shebang lines dropped, `#` prefix stripped); the fallback is `Run the "<name>" workflow from <basename>.` Every parameter is a required string in the input schema.

### Execution and hot reload

- Tool calls honor the same env-driven sandbox selection as `jaiph run` (`resolveDockerConfig`): Docker on macOS/Linux by default, host-only under `JAIPH_UNSAFE=true` or on Windows. The image is prepared once at startup (`checkDockerAvailable` + `prepareImage`), not per call. Run artifacts land under `.jaiph/runs/` exactly as for `jaiph run`.
- **The workspace is isolated by default** for `jaiph mcp` — the same as `jaiph run`. Each tool call's container works on a writable point-in-time snapshot of the workspace, so edits are discarded on exit and the host tree is untouched. Pass `--inplace` (or set `JAIPH_INPLACE=1`) to bind the real workspace read-write so tool effects land live (opt-in), or `--unsafe` (`JAIPH_UNSAFE=true`) to run on the host with no sandbox. The posture is resolved and printed once at startup and applied to every call.
- Source files in the module graph are watched (polling, ~750 ms). A valid edit re-derives tools and emits `notifications/tools/list_changed`; an edit that fails to compile keeps the previous tool set serving and logs diagnostics to stderr.
- Calls bind to the generation (emitted scripts + serialized graph) live when they start; a superseded generation's scripts dir survives until its last in-flight call settles, so a call spanning a reload still runs its remaining steps — the same lease model `jaiph serve` uses for HTTP runs.

## `jaiph serve`
{: #jaiph-serve}

Serve a file's workflows as an HTTP API with a generated OpenAPI 3.1 document and an embedded Swagger UI. Same exposure rules and execution layer as `jaiph mcp`, over HTTP instead of stdio. See [Serve workflows over HTTP](serve.md) for the recipe.

```text
jaiph serve [--host <addr>] [--port <n>] [--workspace <dir>] [--inplace] [--unsafe] [--yes|-y] [--env KEY[=VALUE]]... <file.jh>
```

| Flag | Argument | Effect |
|---|---|---|
| `--host` | `<addr>` | Listen address (default `127.0.0.1`). Binding a non-loopback host with no authentication (neither `JAIPH_SERVE_TOKEN` nor OIDC configured) aborts startup. |
| `--port` | `<n>` | Listen port (default `5247`). `0` picks a free port. |
| `--workspace` | `<dir>` | Workspace root for import resolution (default: auto-detected). |
| `--env` | `KEY=VALUE` or `KEY` | Same per-key passthrough as `jaiph run --env`, resolved once at startup and applied to every run for the server's lifetime. |
| `--inplace` | — | Front-end for `JAIPH_INPLACE=1`: every run's Docker sandbox bind-mounts the host workspace read-write. Mutually exclusive with `--unsafe` (`E_FLAG_CONFLICT` at startup, before anything is spawned). No interactive prompt — launching the server with the flag (or env var) is the consent; the effective posture is printed once at startup and applied to every run. |
| `--unsafe` | — | Front-end for `JAIPH_UNSAFE=true`: every run executes on the host with no sandbox. Same startup-consent model as `--inplace`. |
| `-y`, `--yes` | — | Front-end for `JAIPH_INPLACE_YES=1` (recorded on every run's env; servers themselves never prompt). |
| `-h`, `--help` | — | Print the subcommand usage and exit `0`. |

Flags that belong to another command (for example `--raw` or `--target`) are usage errors naming the owning command — never silently ignored. Precedence across layers is the shared execution-policy order: CLI flags > `JAIPH_*` env vars > workflow config metadata > defaults (see [Environment variables — Precedence](env-vars.md#precedence)).

Startup mirrors `jaiph mcp`: graph load + `collectDiagnostics` (diagnostics to stderr, exit `1`), one-time Docker image preparation, credential pre-flight as warnings, and a sandbox-posture notice. All logs go to stderr; one startup line prints the listen URL and the `/docs` URL.

### Endpoints

The **Cap.** column names the capability an authenticated principal must hold to reach each endpoint. In static-token and open (loopback) mode the single principal holds every capability; in OIDC mode capabilities come from the token's OAuth scopes (`jaiph:invoke` / `jaiph:inspect` / `jaiph:cancel`) — see [Auth and limits](#auth-and-limits). `POST /mcp` (MCP Streamable HTTP) shares the same boundary: `tools/call` needs `invoke`, `tools/list` needs `inspect`.

| Method & path | Cap. | Behaviour |
|---|---|---|
| `GET /` | none | `302` → `/docs`. |
| `GET /healthz` | none | `200 {status, version, tools, in_flight}`. Always open and credential-free. |
| `GET /openapi.json` | none | OpenAPI 3.1 document, regenerated per request (hot reload needs no cache invalidation). `404` when `JAIPH_SERVE_EXPOSE_DOCS=false`. |
| `GET /docs` | none | Swagger UI shell (loads `swagger-ui-dist` from a pinned, SRI-verified CDN). `404` when `JAIPH_SERVE_EXPOSE_DOCS=false`. |
| `GET /v1/workflows` | `inspect` | `{workflows: [{name, description, params}]}`. |
| `POST /v1/workflows/{name}/runs` | `invoke` | Start a run. Default `202` + `Location: /v1/runs/{id}`; `?wait=true` blocks for the terminal `200`. Send an `Idempotency-Key` header (scoped to the authenticated principal + workflow) to make retries safe: an identical repeat returns the original run (`200`, no second spawn); a reused key with different arguments is `409 E_IDEMPOTENCY_CONFLICT` and spawns nothing. |
| `GET /v1/runs` | `inspect` | Runs started by this process **plus runs reconstructed from disk on restart**, newest first, scoped to the caller's own runs (all runs for a static/open principal). Paginated: `?limit` (default `100`, clamped to `1000`), `?offset` (default `0`). Response is `{runs, total, limit, offset}` and never unbounded. |
| `GET /v1/runs/{id}` | `inspect` | The run object. `404` unknown (a run the principal does not own is indistinguishable from nonexistent). |
| `GET /v1/runs/{id}/events` | `inspect` | The run's `run_summary.jsonl`. Default `application/x-ndjson` snapshot, streamed from disk (never buffered whole); `Accept: text/event-stream` replays then follows it live, closing with `event: end` when terminal. The snapshot mode first verifies the journal's keyed integrity chain and returns `409 E_TAMPERED` when the chain does not verify (see [Architecture — Keyed hash chain](architecture.md#hash-chain)). Served verbatim (already credential-redacted); raw capture files are never exposed. `404` unknown. |
| `GET /v1/runs/{id}/artifacts` | `inspect` | `{artifacts: [{path, size, mtime}]}` for files published under the run's `artifacts/` (empty when none). `404` unknown. |
| `GET /v1/runs/{id}/artifacts/{path}` | `inspect` | Download one published file (`application/octet-stream`), streamed with backpressure — never buffered whole, so an arbitrarily large file costs no server memory and a client disconnect closes the file. Traversal-proof — `..`, absolute paths, and escaping symlinks are `404`. `413 E_ARTIFACT_TOO_LARGE` when the file exceeds `JAIPH_SERVE_MAX_ARTIFACT_BYTES`. |
| `POST /v1/runs/{id}/cancel` | `cancel` | `202`; the run reaches `cancelled`. `409` if already terminal. |

The run object is `{run_id, workflow, status, started_at, ended_at, exit_status, signal, result_text, run_dir, principal, correlation_id}` where `status` is `running` \| `succeeded` \| `failed` \| `cancelled` \| `interrupted`. `principal` is the audit subject that created the run (`anonymous`/`operator` in open/static mode, the token `sub` in OIDC mode — never a token) and `correlation_id` is the request id attached at create time; both are `null` when unset. `interrupted` is the terminal state a run is reconciled to after a process death caught it mid-flight — its outcome is unknown, so it is neither `succeeded` nor `failed`, but it is never reported as permanently `running`. **A workflow failure is not an HTTP error** — the run object reports `status: "failed"` with the same failure narrative `jaiph mcp` returns, over HTTP `200`/`202`. Errors use `{error: {code, message}}` with `400 E_BAD_ARGS`, `401 E_UNAUTHORIZED` (missing/invalid static token), `401 E_TOKEN_EXPIRED` / `401 E_TOKEN_INVALID` (OIDC token expired, or bad audience/issuer/key/signature), `403 E_FORBIDDEN` (principal lacks the required capability), `404 E_NOT_FOUND`, `409 E_RUN_TERMINAL`, `409 E_IDEMPOTENCY_CONFLICT` (idempotency key reused with different arguments), `409 E_TAMPERED` (the run's journal failed its keyed integrity chain), `413 E_BODY_TOO_LARGE` (1 MiB request-body cap), `413 E_ARTIFACT_TOO_LARGE` (artifact download over `JAIPH_SERVE_MAX_ARTIFACT_BYTES`), `415` (non-`application/json` body), `429 E_TOO_MANY_RUNS`, and `503 E_AUTH_UNAVAILABLE` (OIDC identity provider / JWKS unreachable).

Each run's public record is persisted beside its journal as `run.json` when it finishes, and reconstructed into the registry on startup — so `GET /v1/runs`, `/v1/runs/{id}`, `/events`, and `/artifacts` keep working for pre-restart terminal runs, and idempotency keys survive a restart. `jaiph serve` is a **single-replica** service: the run registry, concurrency cap, and idempotency index are per-process and not shared across replicas — run two behind one load balancer and each has its own view. See [Serve — deployment topology](serve.md#deployment-topology).

### Auth and limits

- **Authentication** has two production modes (credentials come from the environment, never argv) plus an open loopback default. **Static single-operator token:** `JAIPH_SERVE_TOKEN` is a shared secret required on every `/v1/*` and `/mcp` request (`Authorization: Bearer <token>`, constant-time compared). It is a fail-closed gate for **one operator** — no per-user identity, revocation, or per-action authorization; the operator holds every capability and sees every run — not multi-tenant authentication. **OIDC/JWT (multi-tenant):** set `JAIPH_SERVE_OIDC_ISSUER` + `JAIPH_SERVE_OIDC_AUDIENCE` (takes precedence over the static token; setting only one is a startup error) to verify bearer JWTs against the issuer's JWKS (discovered from `<issuer>/.well-known/openid-configuration`, or set `JAIPH_SERVE_OIDC_JWKS_URI`) with a maintained JWT library — signature, `exp`/`nbf`, `aud`, `iss`, `kid`. Each token is authorized by OAuth scopes: `jaiph:invoke` (run), `jaiph:inspect` (read workflows/runs/events/artifacts, MCP `tools/list`), `jaiph:cancel` (cancel a run); a missing capability is `403 E_FORBIDDEN`, and a principal (the token `sub`) may inspect or cancel **only the runs it created**. The authenticated subject and the request's correlation id (`X-Correlation-Id` / `X-Request-Id`, else a generated UUID) attach to run metadata, the invoke/cancel audit log lines, OTLP resource attributes, and Sentry tags — never a token or a claim value.
- Binding a non-loopback `--host` with **no** authentication is a startup error. On loopback, auth is optional (every caller is the `anonymous` principal with all capabilities).
- `JAIPH_SERVE_EXPOSE_DOCS` (default `true`) controls whether `/docs` and `/openapi.json` are served; set `false` (or `0`) to return `404` for both and hide the API surface. `/healthz` is always open and credential-free (liveness/readiness only — no tokens or sensitive detail).
- `JAIPH_SERVE_MAX_CONCURRENT` (default `4`) caps simultaneous runs; requests beyond it get `429`.
- `JAIPH_SERVE_MAX_ARTIFACT_BYTES` (default `0` = no cap) refuses artifact downloads larger than the limit with `413`. Downloads stream with backpressure regardless, so the default keeps server memory bounded no matter the file size; set a finite cap only to reject oversized downloads outright.
- Memory bounds keep a long-lived server from growing without limit: `JAIPH_SERVE_MAX_OUTPUT_BYTES` (default 1 MiB) caps collected stdout, stderr, log output, and the resident `result_text` per run (overflow dropped with a truncation marker); `JAIPH_SERVE_RETAIN_RUNS` (default `500`) and `JAIPH_SERVE_RETAIN_AGE_SEC` (default `86400`, `0` disables) bound how many completed runs stay in the in-memory registry, evicting the oldest terminal records first. **Active runs are never evicted**, and eviction drops only the in-memory record — durable `.jaiph/runs` journals and artifacts persist on disk and are the operator's to prune. See [Serve workflows over HTTP](serve.md#9-bound-memory-over-a-long-lived-server).
- Execution and hot reload are identical to `jaiph mcp`; a superseded generation's scripts dir survives until its in-flight HTTP runs finish.

## Environment variables

See [Environment variables](env-vars.md) for the complete inventory. The variables most relevant to CLI behaviour:

- `JAIPH_DOCKER_ENABLED`, `JAIPH_UNSAFE`, `JAIPH_INPLACE`, `JAIPH_INPLACE_YES` — sandbox enablement and mode.
- `JAIPH_DOCKER_IMAGE`, `JAIPH_DOCKER_NETWORK`, `JAIPH_DOCKER_TIMEOUT` — Docker mode parameters.
- `JAIPH_NON_TTY_HEARTBEAT_FIRST_SEC`, `JAIPH_NON_TTY_HEARTBEAT_INTERVAL_MS` — non-TTY progress cadence.
- `JAIPH_RUNS_DIR`, `JAIPH_WORKSPACE`, `JAIPH_SOURCE_FILE` — run-layout inputs.
- `JAIPH_INSTALL_COMMAND`, `JAIPH_REGISTRY`, `JAIPH_SKILL_PATH` — install / init inputs.
- `NO_COLOR` — disable ANSI colour output.

## Live and durable contracts

- **Live contract** (runtime → CLI): `__JAIPH_EVENT__` JSON lines on **stderr** only. Hooks and the interactive progress tree consume this stream. Stdout carries plain script output forwarded as-is.
- **Durable contract**: `.jaiph/runs/...` + `run_summary.jsonl` + `.out` / `.err` step artifacts + optional `return_value.txt`. See [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout).

`run_summary.jsonl` event types: `WORKFLOW_START`, `WORKFLOW_END`, `STEP_START`, `STEP_END`, `LOG`, `LOGERR`, `LOGWARN`, `INBOX_ENQUEUE`, `INBOX_DISPATCH_START`, `INBOX_DISPATCH_COMPLETE`, `PROMPT_START`, `PROMPT_END`. Every object carries `type`, `ts` (UTC), `run_id`, and `event_version` (currently `1`). Step events also carry `id`, `parent_id`, `seq`, `depth`. See [Architecture — Contracts](architecture.md#contracts).

## File extension

`.jh` is the file extension for Jaiph source. Import resolution appends `.jh` when the path omits the extension. `*.test.jh` is the test-module convention recognised by `jaiph test` and file shorthand.

## Related

- [Configuration](configuration.md) — config keys, precedence, scoping.
- [Grammar](grammar.md) — syntax and validation catalog.
- [Language](language.md) — step semantics and step-output contract.
- [Environment variables](env-vars.md) — every variable Jaiph reads.
- [Serve workflows as MCP tools](mcp.md) — exposing a file's workflows to MCP clients via `jaiph mcp`.
