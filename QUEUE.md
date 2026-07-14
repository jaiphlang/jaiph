# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, remove that section entirely.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## MCP 1–4/8 — Land the spiked `jaiph mcp` MVP: verify what exists, close the test gaps, run the full suite #dev-ready

Design: `design/2026-07-14-mcp-server.md` — the whole doc; it records the contracts as verified during the spike.

**State: largely implemented, partially verified.** A working MVP was spiked on 2026-07-14 and left **uncommitted in the working tree on `nightly`**. If that diff is present when you pick this up, the job is verification and gap-closing; if it is absent (discarded or already landed differently), implement from scratch per the design doc. The acceptance list below is the contract either way and is deliberately state-independent.

### What exists and how far each piece is verified

- **Runtime root generalization** — `src/runtime/kernel/node-workflow-runtime.ts`: `runDefault(args)` generalized to `runRoot(workflowName, args)` (emits `WORKFLOW_START`/`WORKFLOW_END` with the symbol, binds args to params by position, persists `return_value.txt` on success; `runDefault` delegates; unknown non-default symbol → `jaiph run: unknown workflow '<name>' in the input file`, status 1). *Implemented; exercised only indirectly through the live MCP session; **no dedicated unit tests**.*
- **Runner symbol dispatch** — `src/runtime/kernel/node-workflow-runner.ts` calls `runtime.runRoot(workflowName, runArgs)` (previously non-`default` symbols short-circuited to status 1). *Implemented; no dedicated test.*
- **Launch-path bug fix** — `src/runtime/kernel/workflow-launch.ts` `buildRunModuleLaunch` now passes `workflowSymbol || "default"` into the runner argv; it previously destructured the symbol and **hardcoded `"default"`**, so every spawned run executed `default` regardless of the requested symbol. *Implemented; verified in the MCP direction (non-default symbols run correctly). **The `jaiph run` direction was NOT re-verified after this edit** (the manual regression check was interrupted) and there is **no unit test pinning the argv**. This edit touches every `jaiph run` — treat it as unverified until tested.*
- **Tool derivation** — `src/cli/mcp/tools.ts` (`deriveTools`, `toolNameFromFile`) + `src/cli/mcp/tools.test.ts`. *Implemented; **10 unit tests passing** (exports narrowing, route-target exclusion, lone-`default` rename, skip-with-warning, comment descriptions with shebang dropped, fallback, schemas, name sanitization).*
- **Protocol server** — `src/cli/mcp/server.ts` (`McpServer`, injected `{serverVersion, getTools, callTool, write, log}`) + `src/cli/mcp/server.test.ts`. *Implemented; **16 unit tests passing** (initialize version negotiation known/unknown, tools/list shape, call arg mapping, failure-as-`isError`, `-32602` variants, `-32603` + log, ping, notifications ignored, `-32700` id-null, `-32601`, blank lines, `list_changed` gating).*
- **Per-call execution** — `src/cli/mcp/call.ts` (`callWorkflow`: per-call runner spawn, `__JAIPH_EVENT__` stderr parsing, meta-file → `return_value.txt`, success/failure text composition). *Implemented; verified via a live stdio session (return values round-trip, failure text carries the run-dir pointer, concurrent calls interleave correctly); **no automated test**.*
- **Command + wiring** — `src/cli/commands/mcp.ts` (`runMcp`: arg parsing, diagnostics-to-stderr, generation temp dirs, concurrent in-flight tracking, shutdown on stdin close/SIGINT/SIGTERM), dispatch of `mcp` + `--mcp` alias in `src/cli/index.ts`, `printUsage` additions in `src/cli/shared/usage.ts`. *Implemented; happy path verified via the live session. **The hot-reload path (`fs.watchFile` → new generation → `notifications/tools/list_changed`) was written but never exercised — not even manually.** The diagnostics-exit path, help output, and alias dispatch have no tests.*

Overall verification done during the spike: `tsc --noEmit` clean; `npm run build` clean; `node --test dist/src/cli/mcp/*.test.js` → **26/26 pass**; live scripted stdio session (initialize → tools/list with comment-derived descriptions → tools/call returning workflow `return` values → missing-arg `-32602` → failure leg with `isError: true`). **The full `npm test` suite has NOT been run since these changes.**

Manual probe (useful while working):

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}' \
 | node dist/src/cli.js mcp <fixture.jh>
```

### Work

1. If the diff is absent, implement per the design doc (module layout above).
2. Add the missing tests: launch argv pin, `runRoot` unit tests, scripted stdio session, diagnostics/help/alias, hot reload, `jaiph run` regression.
3. Run the **full** `npm test` suite (and `npm run test:e2e` if touched paths warrant) and fix fallout — the launch-path edit is shared with `jaiph run`.

### Acceptance

Existing (keep passing — they fail if the contract regresses):

- The 10 tool-derivation tests and 16 protocol-server tests described above.

New (each must fail when its contract is violated):

- Unit test: `buildRunModuleLaunch(["meta", "built.sh", "mywf", "arg1"], env)` produces an argv containing `mywf` (pins the fixed hardcoded-`default` bug).
- Unit tests on the runtime: a non-`default` workflow runs as root via `runRoot` with params bound positionally and `return_value.txt` written on success; `runRoot("missing", [])` returns 1 and writes no `return_value.txt`; `runDefault` behaviour unchanged.
- Scripted stdio session against a fixture `.jh` (two workflows, one with a param and a `return`): initialize → tools/list shows both tools with comment-derived descriptions → tools/call returns the workflow's return value as text → missing-arg call → `-32602` → failing workflow → `isError: true` with a run-dir pointer. Every stdout line parses as JSON-RPC (no banner/progress leakage).
- Compile diagnostics go to stderr with exit 1 and nothing on stdout.
- `jaiph --help` output includes `jaiph mcp`; `jaiph --mcp <file>` dispatches to the same command.
- Hot reload: edit the fixture to add a workflow → `notifications/tools/list_changed` is emitted and a subsequent `tools/list` shows the new tool; break the fixture → the previous tool set still serves and diagnostics appear on stderr.
- `jaiph run` regression: a `default` workflow exits 0 and prints its return value (pins the shared launch path in the `run` direction).
- The full `npm test` suite passes.

## ENV — `--env` passthrough into the workflow env and across the Docker sandbox boundary (`jaiph run` + `jaiph mcp`) #dev-ready

The Docker sandbox forwards environment fail-closed: only the `ENV_ALLOW_PREFIXES` allowlist (`JAIPH_`, `ANTHROPIC_`, `CURSOR_`, `CLAUDE_`; see `src/runtime/docker.ts` — `isEnvAllowed`, consumed in the `buildDockerArgs` env loop) crosses into the container. There is no per-key escape hatch, so a workflow that needs e.g. `GITHUB_TOKEN` or `MY_API_URL` cannot receive it in a sandboxed run. Add an explicit, user-consented passthrough.

Contract:

- New repeatable flag on **`jaiph run`** and **`jaiph mcp`** (parsed in `parseArgs`, `src/cli/shared/usage.ts`):
  - `--env KEY=VALUE` — define `KEY` with that exact value (first `=` splits; value may contain `=`; empty value allowed).
  - `--env KEY` — forward the host's current value; if `KEY` is unset on the host, abort before spawning with a specific error (`E_ENV_MISSING`), never silently drop.
  - `KEY` must match `[A-Za-z_][A-Za-z0-9_]*`; anything else aborts with `E_ENV_INVALID`.
- **Semantics: `--env` defines the workflow process's env var in every execution mode.**
  - Host (non-Docker, including `jaiph run --raw`-style spawns and `jaiph mcp` tool calls): applied to the runner env after `resolveRuntimeEnv`/`applySandboxFlags`, overriding inherited values.
  - Docker: appended as explicit `-e KEY=VALUE` container args **bypassing `isEnvAllowed`** — the flag is the per-key consent. Thread the pairs through `DockerSpawnOptions` (new field, e.g. `extraEnv: Record<string, string>`) into `buildDockerArgs`; ensure a key appears once, with the `--env` value winning over an allowlist-forwarded host value.
- **Reserved keys are rejected** (`E_ENV_RESERVED`, both flag forms, all modes): sandbox-control keys (`JAIPH_UNSAFE`, `JAIPH_INPLACE`, `JAIPH_INPLACE_YES`, anything `JAIPH_DOCKER_*`) and runtime-managed keys that `resolveRuntimeEnv`/`remapDockerEnv` own (`JAIPH_WORKSPACE`, `JAIPH_RUNS_DIR`, `JAIPH_RUN_ID`, `JAIPH_SCRIPTS`, `JAIPH_MODULE_GRAPH_FILE`, `JAIPH_SOURCE_ABS`, `JAIPH_META_FILE`, `JAIPH_AGENT_TRUSTED_WORKSPACE`). Use the sandbox flags (`--inplace`/`--unsafe`) or real env vars for control keys instead.
- `jaiph mcp --env …` applies the pairs to **every** tool call's runner env for the server's lifetime (and, once Docker-backed MCP calls exist, they must flow through the same `extraEnv` container path — the field is the single choke point).
- No remapping of `--env` values: they are passed verbatim (path remapping stays confined to the runtime-managed keys, which are rejected above).
- Update `printUsage` (`src/cli/shared/usage.ts`) and per-command usage strings; document the flag and its sandbox-boundary meaning in `docs/cli.md`, `docs/env-vars.md`, and the env-exposure paragraph of `docs/sandboxing.md`.

Acceptance:

- `parseArgs` unit tests: repeatable `--env` collected in order, `KEY=VALUE` vs bare `KEY` forms, `=` inside value preserved, empty value, invalid name rejected, missing value for bare form deferred to spawn-time host lookup.
- Unit test on `buildDockerArgs`: a key that fails `isEnvAllowed` (e.g. `MY_TOKEN`) appears as `-e MY_TOKEN=…` when supplied via `extraEnv`, and does NOT appear without it (fails if the allowlist bypass or the fail-closed default regresses). A key both allowlist-forwarded and in `extraEnv` appears exactly once with the `extraEnv` value.
- Reserved-key rejection test per category (control key, runtime-managed key), both flag forms.
- `--env KEY` with `KEY` unset on the host aborts with `E_ENV_MISSING` before any process is spawned.
- Integration (host mode): `jaiph run --env GREETING=hi file.jh` where the workflow shells out `echo $GREETING` — output contains `hi`. Same via bare-forward form with the var exported on the host.
- Integration (MCP): `jaiph mcp --env GREETING=hi tools.jh` — a `tools/call` whose workflow returns the env var yields `hi` in the result text on every call.
- Docker integration leg (where CI allows Docker): a sandboxed `jaiph run --env MY_TOKEN=s3cret` workflow reads the var inside the container; without `--env` the same workflow sees it unset.

## MCP 5/8 — Docs: serving workflows over MCP #dev-ready

Design: `design/2026-07-14-mcp-server.md` → "Documentation" (and the rest of the doc for the contracts being documented). Documents the `jaiph mcp` subcommand as it exists in the tree.

Work:

- `docs/mcp.md` — Diátaxis how-to: serving a file; exposure rules (`export workflow` narrowing, route-target exclusion, `default`-only rename to file slug); writing tool descriptions as `#` comments above workflows; client config examples (`claude mcp add mytools -- jaiph mcp ./tools.jh`, Claude Desktop/Cursor JSON); safety posture (host execution like `jaiph run --raw`, Docker sandbox not launched yet, an exposed workflow is arbitrary shell reachable by the connected agent); hot reload; run artifacts under `.jaiph/runs/`; concurrency caveat (two calls mutating one workspace can race).
- `docs/cli.md` — `jaiph mcp` reference section in the subcommand summary table + its own section: every flag the command accepts in the tree at execution time (at minimum `--workspace`; include `--env` if present), exit behaviour, protocol subset table, stdout-is-protocol invariant, `--mcp` alias.
- README — feature bullet under Features and a docs-note link, following the existing style.
- Front-matter (`title`, `permalink`, `diataxis`) consistent with sibling docs pages.

Acceptance:

- `docs/mcp.md` exists with the sections above; `docs/cli.md` documents every flag and the alias; README links resolve.
- Every documented behaviour matches an assertion in the `jaiph mcp` test suite (no documented flag or rule without a covering test — cross-check exposure rules, naming, stdout invariant).
- Docs build/link checks used by the repo (if any run in CI) pass.

## MCP 6/8 — e2e: `jaiph mcp` scripted session + `jaiph run` regression #dev-ready

Design: `design/2026-07-14-mcp-server.md` → "Testing". The unit/acceptance tests for `jaiph mcp` run the command in-repo; this task adds black-box e2e coverage through the real binary entrypoint alongside the existing `e2e/` suite (`npm run test:e2e`).

Work:

- An e2e script that starts `jaiph mcp <fixture.jh>` as a child process, performs `initialize` / `tools/list` / `tools/call` (param round-trip through a workflow `return`) / a failing call, and closes stdin.
- A regression leg asserting `jaiph run <fixture-with-default>` still passes and prints the return value — the launch path (`workflow-launch.ts`) is shared between `run` and `mcp`, and it previously hardcoded the `default` symbol; this leg pins both directions.

Acceptance:

- e2e asserts: every stdout line is valid JSON-RPC (no banner/progress leakage), the tool result text equals the workflow return value, a failing workflow yields `isError: true` and exit-0 server shutdown on stdin close.
- e2e asserts `jaiph run` on a `default` workflow exits 0 and prints the return value (fails if the shared launch path regresses).
- Wired into `npm run test:e2e` so CI executes it.

## MCP 7/8 — Docker sandbox parity for `jaiph mcp` (inplace by default) #dev-ready

Design: `design/2026-07-14-mcp-server.md` → "Safety posture". Today `jaiph mcp` runs tool calls on the host like `jaiph run --raw` and prints a stderr notice when the env would have enabled Docker. This task makes MCP tool calls honor the same env-driven sandbox selection as `jaiph run` (`resolveDockerConfig`, `selectSandboxMode`, `spawnDockerProcess`, image prepare/availability checks), with two deliberate MCP-specific rules:

- **Inplace is the default sandbox mode** for `jaiph mcp` when Docker is enabled and no mode is explicitly selected via env: the calling agent operates on the real workspace and expects tool effects to land live. Explicit env selection (overlay/copy) is honored and restores workspace isolation.
- **The inplace confirmation prompt is implied by starting the server.** stdin is the protocol channel, so no interactive prompt is possible; starting `jaiph mcp` on a workspace is the consent act. No `--yes` flag is required. Document this in `docs/mcp.md`, including how to opt back into isolation.

Work items include: carrying the workflow symbol into the containerized inner run (the Docker path currently assumes the `default` symbol — same class of bug as the fixed host launch path), per-call container lifecycle (spawn/cleanup/timeout via the existing `cleanupDocker`/`withDockerExitGuard` helpers), run-dir discovery from the sandbox runs root for result/`return_value.txt` reading (`discoverDockerRunDir`, `remapContainerPath`), and startup `checkDockerAvailable`/`prepareImage` once rather than per call.

Acceptance:

- With Docker enabled in env, a `tools/call` runs in a container in inplace mode by default (test may assert mode selection + spawn wiring at the unit level, plus an e2e/integration leg where the CI environment allows Docker).
- A non-`default` tool symbol executes correctly inside the container (fails if the inner run hardcodes `default`).
- Explicit overlay/copy env selection is honored for MCP calls; the workspace is untouched after such a call.
- Host fallback (`JAIPH_UNSAFE=true` or win32) still works and is covered.
- Result composition (return value, failure text, run-dir pointer) works with container runs, using host-side remapped paths.
- If the CLI supports `--env` passthrough (see `docs/cli.md`; explicit per-key exceptions to the container env allowlist carried via `DockerSpawnOptions.extraEnv`), `jaiph mcp --env` pairs reach the per-call container: a test asserts a non-allowlisted key supplied via `--env` is readable by the workflow inside the container.

## MCP 8/8 — MCP progress notifications and cancellation #dev-ready

Design: `design/2026-07-14-mcp-server.md` → "Out of scope (queued separately)". Long workflows should stream progress to the client and be cancellable. Builds on the `jaiph mcp` command as it exists in the tree (per-call runner spawn; child stderr already parsed via `parseStepEvent`/`parseLogEvent`).

Work:

- When a `tools/call` request carries `params._meta.progressToken`, translate the run's `STEP_START`/`STEP_END` events into `notifications/progress` (`{progressToken, progress: <monotonic count>, message: "<kind> <name>"}`); stop notifying after the call's response is sent (spec requirement).
- Handle `notifications/cancelled` for an in-flight request id: terminate that call's child process tree (reuse `terminateRunProcessGroup` semantics from `src/cli/run/lifecycle.ts` — SIGINT, force-kill timer), do not send a response for the cancelled id, keep the server serving.
- No behaviour change for calls without a progressToken.

Acceptance:

- Scripted session: a `tools/call` with a progressToken over a multi-step fixture workflow yields ≥1 `notifications/progress` with that token before the response, monotonically increasing `progress`, and none after the response (test fails on post-response notifications).
- Scripted session: `notifications/cancelled` for an in-flight call kills the child (observable: the run terminates, no response for that id arrives, a subsequent `ping` still answers).
- Calls without a progressToken emit no progress notifications.
