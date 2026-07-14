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
