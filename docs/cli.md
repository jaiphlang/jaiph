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
| `jaiph <subcommand> [-h \| --help]` | Print the subcommand's usage (flags + one example) and exit `0`. Recognised anywhere in the arg list before `--` (except `compile`: help flags must precede path arguments). |
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

## `jaiph run`
{: #jaiph-run}

Compile and execute a workflow's `default` entrypoint.

```text
jaiph run [--target <dir>] [--raw] [--workspace <dir>] [--inplace] [--unsafe] [--yes|-y] [--env KEY[=VALUE]]... <file.jh> [--] [args...]
```

Sandbox selection is environment-driven; there is no `--docker` flag. The boolean sandbox flags (`--inplace`, `--unsafe`, `--yes`) are CLI front-ends that mutate the launched runtime env for one run only — see [Configuration — Precedence](configuration.md#precedence) and [Environment variables](env-vars.md).

### Flags

| Flag | Argument | Effect |
|---|---|---|
| `--target` | `<dir>` | Keep emitted script files and run metadata under `<dir>` instead of a temp directory. |
| `--raw` | — | Skip the banner, live progress tree, hooks, and PASS/FAIL footer. The runner child inherits stdio; `__JAIPH_EVENT__` JSON lines go to stderr unchanged. Host `--raw` never launches Docker even when `JAIPH_DOCKER_ENABLED=true`. |
| `--workspace` | `<dir>` | Override the workspace root used for library resolution and the Docker workspace mount. A missing value, missing path, or non-directory aborts with a specific message. There is no `JAIPH_WORKSPACE` env equivalent input — that name is reserved for the in-container remap output. |
| `--inplace` | — | Front-end for `JAIPH_INPLACE=1`. |
| `--unsafe` | — | Front-end for `JAIPH_UNSAFE=true`. Cannot be combined with `--inplace` (`E_FLAG_CONFLICT`). |
| `-y`, `--yes` | — | Front-end for `JAIPH_INPLACE_YES=1`. Required to use `--inplace` non-interactively. |
| `--env` | `KEY=VALUE` or `KEY` | Repeatable per-key environment passthrough into the workflow process. `--env KEY=VALUE` defines `KEY` with that exact value (first `=` splits; the value may contain `=`; empty is allowed). `--env KEY` forwards the host's current value, aborting with `E_ENV_MISSING` before spawning if `KEY` is unset on the host. `KEY` must match `[A-Za-z_][A-Za-z0-9_]*` (else `E_ENV_INVALID`). Reserved sandbox-control keys (`JAIPH_UNSAFE`, `JAIPH_INPLACE`, `JAIPH_INPLACE_YES`, any `JAIPH_DOCKER_*`) and runtime-managed keys (`JAIPH_WORKSPACE`, `JAIPH_RUNS_DIR`, `JAIPH_RUN_ID`, `JAIPH_SCRIPTS`, `JAIPH_MODULE_GRAPH_FILE`, `JAIPH_SOURCE_ABS`, `JAIPH_META_FILE`, `JAIPH_AGENT_TRUSTED_WORKSPACE`) are rejected with `E_ENV_RESERVED` — use the sandbox flags or real env vars for those. **In a Docker sandbox `--env` is the per-key consent that crosses the fail-closed env allowlist verbatim** (added as explicit `-e KEY=VALUE` container args, winning over any allowlist-forwarded value); see [Sandboxing — Environment exposure](sandboxing.md#env-exposure). Values are never path-remapped. |
| `--` | — | End of Jaiph flags; remaining tokens are forwarded to `workflow default`. |

### Pre-flight

After module-graph load and Docker-mode resolution, before the runner / container is spawned, the host CLI runs a credential pre-flight (`src/cli/run/preflight-credentials.ts`). Missing credentials produce either `E_AGENT_CREDENTIALS` (hard error) or a warning depending on backend and Docker mode — see [Authenticate agent backends](/how-to/agent-auth) and [Configuration — Credential pre-flight](configuration.md#credential-pre-flight). `jaiph run --raw` does not run the pre-flight.

### Progress markers

| Marker | Meaning |
|---|---|
| `▸` | Step started. |
| `✓` | Step completed successfully (with elapsed time). |
| `✗` | Step failed (with elapsed time). |
| `ℹ` | `log` message (dim/gray, no marker timing). |
| `!` | `logerr` message (red; rendered on stdout with the progress tree). |
| `·` | Continuation marker (heartbeat lines in non-TTY mode). |
| ` ₁`, ` ₂`, … | Subscript prefix for `run async` branch numbering. |

PASS line: `✓ PASS workflow default (0.2s)`. TTY runs append a transient `▸ RUNNING workflow <name> (X.Xs)` line that is replaced by the PASS/FAIL line on exit. `--raw` and non-TTY modes skip both. Disable color globally with `NO_COLOR=1`.

Non-TTY heartbeat cadence is controlled by `JAIPH_NON_TTY_HEARTBEAT_FIRST_SEC` (default `60`) and `JAIPH_NON_TTY_HEARTBEAT_INTERVAL_MS` (default `30000`, floor `250`).

### Step display

Step lines include the kind (`workflow`, `prompt`, `script`, `rule`) and name. Parameterised invocations append `key="value"` pairs in parentheses (positional params use `1=…` / `2=…`); whitespace is collapsed; values are truncated to 32 characters. Prompt step lines additionally show the backend name (or custom command basename) and the first 24 characters of the prompt body in quotes (full line capped at 96 characters).

### Return values

When `workflow default` returns a value (success only), the runtime writes `return_value.txt` under the run directory. Interactive `jaiph run` prints that value on stdout after the PASS line, separated by a blank line. `jaiph run --raw` never prints it to stdout; the file alone is the contract.

### Run artifacts

Each run directory is `<JAIPH_RUNS_DIR>/<YYYY-MM-DD>/<HH-MM-SS>-<source>/`, UTC. `<source>` is `JAIPH_SOURCE_FILE` if set, otherwise the entry-file basename. Layout pinned in [Architecture — Durable artifact layout](architecture.md#durable-artifact-layout).

Step `.out` files are written incrementally; consumers may `tail -f` them. `.out` / `.err` pairs are allocated at `STEP_START` with monotonic per-run sequence numbers (`%06d-<safe_name>.out|.err`).

### Failure footer

Interactive `jaiph run` only (`--raw` omits this block). On non-zero exit, the CLI emits a stderr footer with `Logs:`, `Summary:`, `out:` / `err:` paths, and an `Output of failed step:` excerpt. The fields are resolved from the last `STEP_END` object with non-zero `status` in `run_summary.jsonl`; `out_content` / `err_content` are preferred over `out_file` / `err_file`. In Docker mode, container-internal `/jaiph/run/*` paths are remapped to host paths.

### Hook events

Hooks load from `~/.jaiph/hooks.json` (global) and `<project>/.jaiph/hooks.json` (project-local; project overrides global per event). Hooks run on the **host** CLI process even in Docker mode. See [Add a hook](/how-to/hooks).

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

Assertions: `expect_contain`, `expect_equal`, `expect_not_contain` — see [Write & run tests](/how-to/testing).

## `jaiph compile`
{: #jaiph-compile}

Parse modules and run `collectDiagnostics(graph)` — the same per-module validator as `jaiph run`, but collecting every recoverable error instead of stopping at the first — **without** writing `scripts/`, **without** calling `buildRuntimeGraph()`, and **without** spawning the workflow runner.

```text
jaiph compile [--json] [--workspace <dir>] <file.jh | directory> ...
```

At least one path is required. `-h` / `--help` must appear before the first path (they are not scanned after a path token, unlike other subcommands).

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

Paths must end with `.jh`. Formatting is idempotent. Comments and shebangs are preserved. Triple-quoted bodies, prompt blocks, and fenced script blocks emit verbatim — inner lines are not re-indented relative to the surrounding scope.

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

### Post-clone hygiene

Each successful clone runs three checks before the lib counts as installed:

- **`.jh` module check** — at least one `*.jh` file must exist under the clone (recursive, `.git` skipped). Failure removes the directory and aborts with `lib "<name>" contains no .jh modules — not a jaiph library?`. No lock entry written.
- **Commit capture** — `git rev-parse HEAD` is recorded as the 40-char `commit` on the lock entry.
- **`.git` strip** — `<libDir>/.git` is removed recursively.

### Restore-from-lockfile mode

`jaiph install` with no positional args reads `.jaiph/libs.lock` and clones each entry. The registry is never contacted. If a lock entry carries a `commit`, the cloned HEAD must match it; on mismatch the directory is removed and the run fails with the locked vs cloned SHAs and the remedy. Lock entries without `commit` (older lockfiles) restore without the check.

### Parallel clones

Missing libraries are cloned with bounded concurrency (default **4 in flight**). The warm-skip pass runs before any clone. Independent clone failures still propagate; failed libraries are not added to the lockfile.

### Registry

| Aspect | Value |
|---|---|
| Source | `JAIPH_REGISTRY` (default `https://jaiph.org/registry`). |
| Loading | Loaded once per invocation when at least one positional argument is a bare name. URL-form installs and restore-from-lock never read the registry. |
| Disk paths | Values without a `://` scheme, or starting with `file://`, are read from disk. Everything else is fetched via global `fetch`. |
| Index format | `{ "libs": { "<name>": { "url": "<git-url>", "description": "<string>" } } }`. Each key must match `^[A-Za-z0-9_-]+$`. Unknown per-entry keys are accepted and ignored. |
| Lookup errors | `lib "<name>" not found in registry <source>`, `failed to read registry <source>: <cause>`, `failed to fetch registry <source>: HTTP <status>`, `failed to parse registry <source>: <cause>`, `failed to parse registry <source>: invalid name "<name>"`. |

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
| `<version>` (e.g. `0.10.0`) | Reinstalls the release binary for tag `v<version>`. |

Implementation: re-invokes `JAIPH_INSTALL_COMMAND` (default `curl -fsSL https://jaiph.org/install | bash`) with `JAIPH_REPO_REF` set to `nightly` or `v<version>`. The installer downloads the matching per-platform binary plus `SHA256SUMS`, verifies the checksum, and replaces `~/.local/bin/jaiph` (or `JAIPH_BIN_DIR`).

## `jaiph mcp`
{: #jaiph-mcp}

Serve a file's workflows as [MCP](https://modelcontextprotocol.io/) tools over stdio. See [Serve workflows as MCP tools](/how-to/mcp) for the recipe and client-registration steps.

```text
jaiph mcp [--workspace <dir>] [--env KEY[=VALUE]]... <file.jh>
```

`jaiph --mcp <file.jh>` is an equivalent alias, dispatched after `compile` in `src/cli/index.ts`.

| Flag | Argument | Effect |
|---|---|---|
| `--workspace` | `<dir>` | Workspace root for import resolution (default: auto-detected from the file's directory). A missing value or non-directory path aborts with a specific message. |
| `--env` | `KEY=VALUE` or `KEY` | Same per-key passthrough as `jaiph run --env` (same forms, validation, and reserved-key rejection), resolved once at startup and applied to **every** tool call for the server's lifetime. A bare `--env KEY` unset on the host aborts server startup with `E_ENV_MISSING`. In Docker mode the pairs cross the container boundary as explicit `-e` args bypassing the allowlist, exactly as for `jaiph run --env`. |
| `-h`, `--help` | — | Print the subcommand usage and exit `0`. |

### Startup and exit behaviour

- Loads the module graph and runs `collectDiagnostics` (the same compile-time pass as `jaiph compile`). Any diagnostic prints `file:line:col CODE message` lines to **stderr** and exits `1`.
- A missing path, a non-`.jh` path, or a path that is not a file exits `1` with a message on stderr.
- On success the server runs until stdin closes or it receives `SIGINT` / `SIGTERM`, then drains in-flight calls and exits `0`.

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
| `notifications/cancelled` | Cancels the matching in-flight `tools/call` (`params.requestId`): terminates the run's child process tree (SIGINT, then SIGKILL after a grace period), sends **no response** for that id, and keeps the server serving. A cancellation for an unknown or already-finished id is a no-op. |
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
- **Inplace is the default sandbox mode** for `jaiph mcp`: the container binds the real workspace read-write so tool effects land live, matching what the calling agent expects. Because stdin is the protocol channel there is no interactive in-place prompt — **starting the server is the consent act** (no `--yes` needed). Set `JAIPH_INPLACE=0` (or `JAIPH_DOCKER_NO_OVERLAY=1`) to restore workspace isolation (overlay/copy), or `JAIPH_UNSAFE=true` to run on the host with no sandbox.
- Source files in the module graph are watched (polling, ~750 ms). A valid edit re-derives tools and emits `notifications/tools/list_changed`; an edit that fails to compile keeps the previous tool set serving and logs diagnostics to stderr.

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

`run_summary.jsonl` event types: `WORKFLOW_START`, `WORKFLOW_END`, `STEP_START`, `STEP_END`, `LOG`, `LOGERR`, `INBOX_ENQUEUE`, `INBOX_DISPATCH_START`, `INBOX_DISPATCH_COMPLETE`, `PROMPT_START`, `PROMPT_END`. Every object carries `type`, `ts` (UTC), `run_id`, and `event_version` (currently `1`). Step events also carry `id`, `parent_id`, `seq`, `depth`. See [Architecture — Contracts](architecture.md#contracts).

## File extension

`.jh` is the file extension for Jaiph source. Import resolution appends `.jh` when the path omits the extension. `*.test.jh` is the test-module convention recognised by `jaiph test` and file shorthand.

## Related

- [Configuration](configuration.md) — config keys, precedence, scoping.
- [Grammar](grammar.md) — syntax and validation catalog.
- [Language](language.md) — step semantics and step-output contract.
- [Environment variables](env-vars.md) — every variable Jaiph reads.
- [Serve workflows as MCP tools](/how-to/mcp) — exposing a file's workflows to MCP clients via `jaiph mcp`.
