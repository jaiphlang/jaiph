# mcp-server — design doc

*`jaiph mcp <file.jh>` serves the file's workflows as MCP tools over stdio. Any MCP client (Claude Code, Claude Desktop, Cursor) can call tested, deterministic Jaiph workflows as tools — a `.jh` file becomes an MCP server with zero boilerplate.*

**Status:** design — ready for implementation (an MVP was spiked and verified end-to-end; this doc records the verified contracts)
**Date (UTC):** 2026-07-14

## Problem

Jaiph orchestrates agents (`prompt` → Claude/Cursor/Codex). The reverse direction is missing: an agent that wants to run a Jaiph workflow has to shell out to `jaiph run` and scrape output. MCP is the standard way to hand tools to agents; a workflow encodes a multi-step, tested, repair-capable procedure (`ensure`, `catch`, `recover`, artifacts) — exactly what an agent should call as one tool instead of improvising shell commands.

Goals, in order:

1. **Workflows as tools** — every suitable workflow in the entry file becomes an MCP tool with a name, description, and typed input schema.
2. **Zero-friction serving** — `claude mcp add mytools -- jaiph mcp ./tools.jh`. No SDK project, no build step.
3. **Reuse the runtime** — compile-time validation, per-run artifacts under `.jaiph/runs/`, the `__JAIPH_EVENT__` stream, and (follow-up) Docker sandboxing all apply unchanged.
4. **Zero dependencies** — the project has no runtime deps; the MCP stdio surface needed here (5 methods) is hand-rolled, not `@modelcontextprotocol/sdk`.

## CLI surface

```
jaiph mcp [--workspace <dir>] <file.jh>
```

- `--mcp` is accepted as an alias for the subcommand in `src/cli/index.ts` (`jaiph --mcp tools.jh`), dispatched after `compile`.
- `--workspace <dir>` behaves exactly as in `jaiph run` (import resolution root; validated to be an existing directory). Default: `detectWorkspaceRoot(dirname(file))`.
- `-h`/`--help` prints usage and exits 0. Reuse `hasHelpFlag` / `parseArgs` from `src/cli/shared/usage.ts`.
- Startup: load module graph (`loadModuleGraph`), run `collectDiagnostics`; any diagnostic → print `file:line:col CODE message` lines to **stderr**, exit 1 (same formatting as `jaiph compile`).
- The server runs until stdin closes or SIGINT/SIGTERM; exit 0 on clean shutdown, after letting in-flight calls settle.

**stdout hygiene is a hard invariant:** from the moment the server starts, stdout carries only newline-delimited JSON-RPC. Every banner, warning, reload notice, and diagnostic goes to stderr.

## Transport & protocol subset

Newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport). One JSON object per line, UTF-8. Handled methods:

| Method | Behaviour |
|---|---|
| `initialize` | Reply `{protocolVersion, capabilities: {tools: {listChanged: true}}, serverInfo: {name: "jaiph", title: "Jaiph workflows", version: VERSION}}`. Version negotiation: echo the client's `protocolVersion` if it is one of `["2024-11-05", "2025-03-26", "2025-06-18"]`, else reply with the newest of that list. |
| `ping` | `{}` result. |
| `tools/list` | `{tools: [{name, description, inputSchema}]}` from the current tool set (re-derived reference on every request so hot reload needs no cache invalidation). |
| `tools/call` | Run the workflow (see Execution). Result: `{content: [{type: "text", text}], isError: bool}`. |
| any notification | Ignored (`notifications/initialized`, `notifications/cancelled`, …). No response. |
| unknown request | JSON-RPC error `-32601`. |

Error mapping: invalid JSON → `-32700` with `id: null`; non-object message → `-32600`; unknown tool, missing/non-string required argument, or unexpected argument key → `-32602` (protocol error, the call never starts); a **workflow failure is not a protocol error** — it returns a result with `isError: true`; an infrastructure crash while running the call → `-32603`.

Requests are handled **concurrently** (a long `tools/call` must not stall `ping` or further calls); JSON-RPC ids make interleaved responses legal. Each outbound message is a single atomic `process.stdout.write` of `JSON.stringify(msg) + "\n"`.

The protocol layer lives in `src/cli/mcp/server.ts` as a class taking injected `{serverVersion, getTools, callTool, write, log}` so unit tests drive it line-in/message-out with no processes.

## Tool derivation (`src/cli/mcp/tools.ts`)

Pure function `deriveTools(mod: jaiphModule, inputAbs: string) → {tools, warnings}` over the **entry module only** (imports are not exposed):

1. **Exports narrow.** If the module has `export workflow` declarations (`mod.exports` filtered to workflow names), exactly those are exposed. `export` already exists in the grammar and is the module's public-API marker.
2. **Otherwise all top-level workflows**, minus channel route targets (any name appearing in `mod.channels[].routes[].value` — those are inbox handlers, not tools). Emit a warning per exclusion.
3. **`default` special-case:** exposed only when it is the *only* candidate, under a tool name derived from the file basename — `.jh` stripped, chars outside `[A-Za-z0-9_-]` replaced with `_` (MCP tool-name charset), truncated to 128. With other candidates present, `default` is skipped with a warning (it stays the `jaiph run` entrypoint). On a (rare) slug collision with a named workflow, skip `default` with a warning.
4. **Description** = the workflow's leading `#` comment lines (`WorkflowDef.comments` — the parser already attaches them, stored raw *including* `#`), with `#!` shebang lines dropped and the `#` prefix stripped, joined with `\n`. Fallback: `Run the "<name>" workflow from <basename>.` Descriptions decide whether an agent picks the tool — the docs must tell authors to write them.
5. **Input schema:** all Jaiph params are strings, so `{type: "object", properties: {<param>: {type: "string"}}, required: [<all params>], additionalProperties: false}` (`required` omitted when there are no params). Each tool spec carries `params` in declared order for positional mapping at call time.

Warnings surface once on stderr at (re)load, never on stdout.

## Execution model (`src/cli/mcp/call.ts`)

Per-generation shared state, built at startup and on each hot reload into `mkdtemp(jaiph-mcp-)/gen-<n>/`:

- `buildScriptsFromGraph(graph, outDir)` → `scriptsDir` (read-only at call time, safe to share across concurrent calls),
- `writeModuleGraph(outDir/.jaiph-module-graph.json)` → runner consumes it via `JAIPH_MODULE_GRAPH_FILE` (no re-parse per call),
- `metadataToConfig(resolveModuleMetadata(mod, process.env))` → `effectiveConfig`.

Per `tools/call`:

1. Map the arguments object to positional args in declared param order.
2. `resolveRuntimeEnv(effectiveConfig, workspaceRoot, inputAbs)`; set `JAIPH_SOURCE_ABS`, fresh `JAIPH_RUN_ID` (randomUUID), `JAIPH_SCRIPTS`, `JAIPH_MODULE_GRAPH_FILE`; per-call meta file under the generation dir.
3. `spawnRunProcess([metaFile, dummyBuiltPath, workflowSymbol, ...args], {cwd: workspaceRoot, env})` — the same self-spawn path as `jaiph run` (piped stdio).
4. Parse child **stderr** line-wise: `parseLogEvent` → collected log output; `parseStepEvent` with `STEP_END`/nonzero status → first failing step (`kind name` + `err_content`/`out_content`); everything else → raw stderr. Child stdout is captured, never forwarded.
5. `waitForRunExit`; read the meta file (`run_dir=`, `summary_file=` lines).
6. **Success text**, in order of preference: `<run_dir>/return_value.txt` (the runtime persists the root workflow's `return` value), else collected `log` output, else `workflow <name> completed`.
7. **Failure text:** `workflow <name> failed (exit N)` / `terminated by signal S`, the failing step and its captured output, non-event stderr, collected logs, and `run dir: <path>` for investigation. Returned with `isError: true`.

Run artifacts land under `.jaiph/runs/` in the workspace exactly as for `jaiph run` — every tool call is a durable, inspectable run. Concurrent calls are isolated by per-call run ids/dirs; two calls mutating the same workspace can still race, which the docs state plainly.

### Runtime prerequisites (verified)

Two host-side generalizations are required so a non-`default` symbol can be a run root:

- `NodeWorkflowRuntime.runDefault(args)` generalizes to `runRoot(workflowName, args)` — same contract (emits `WORKFLOW_START`/`WORKFLOW_END` with the symbol name, binds args to params by position, persists `return_value.txt` on success); `runDefault` delegates. Unknown symbol keeps the existing message for `default` (`jaiph run requires workflow 'default' in the input file`) and gets `jaiph run: unknown workflow '<name>' in the input file` otherwise. `node-workflow-runner.ts` calls `runRoot(workflowName, runArgs)` instead of hard-failing non-default symbols (`status 1`).
- **Bug (spike-verified):** `buildRunModuleLaunch` in `src/runtime/kernel/workflow-launch.ts` destructures the workflow symbol from its positional args and then hardcodes `"default"` into the runner argv. It must pass `workflowSymbol || "default"` through. Without this fix every MCP call runs `default` regardless of the tool invoked; the symptom is `jaiph run requires workflow 'default' in the input file` on files without a `default`.

## Hot reload

`fs.watchFile` (polling, ~750ms — portable, no per-platform `fs.watch` quirks) on every file in `graph.modules.keys()`. On change:

- Reload the graph, re-validate, re-derive tools, rebuild scripts into a new generation dir; swap the state, re-watch the (possibly changed) module set, delete the previous generation dir.
- Send `notifications/tools/list_changed` (only after `initialize` has happened).
- On parse/validation failure: keep serving the previous generation; log the diagnostics to stderr. Guard against re-entrant reloads.

## Safety posture

MVP: **calls run on the host**, like `jaiph run --raw` (which by contract never launches Docker). Docker is on by default on macOS/Linux, so the server prints a one-line stderr notice at startup when the env would have enabled Docker. Credential pre-flight (`preflightAgentCredentials`, `dockerEnabled: false`) runs once at startup; in MCP mode errors are demoted to warnings (the server may outlive a credential fix; per-call failures still surface to the client).

An MCP-exposed workflow is arbitrary shell reachable by the connected agent — that is the point, and the docs say so explicitly.

**`--env` passthrough (queued separately, applies to `jaiph run` and `jaiph mcp`):** repeatable `--env KEY[=VALUE]` defines the workflow's env var in every execution mode and, in Docker mode, crosses the container boundary as an explicit `-e` arg bypassing the fail-closed `ENV_ALLOW_PREFIXES` allowlist — the flag is the per-key consent. Bare `KEY` forwards the host value (unset host var = hard error); sandbox-control keys (`JAIPH_UNSAFE`, `JAIPH_INPLACE*`, `JAIPH_DOCKER_*`) and runtime-managed keys (`JAIPH_WORKSPACE`, `JAIPH_RUNS_DIR`, …) are rejected. For `jaiph mcp` the pairs apply to every tool call for the server's lifetime; the Docker-parity task must route them through the same `DockerSpawnOptions.extraEnv` choke point. Full contract: QUEUE.md → "ENV" task.

**Follow-up — Docker parity:** MCP calls should honor the same env-driven sandbox selection as `jaiph run`, with one deliberate difference: **inplace is the default mode** for `jaiph mcp` (the calling agent operates on the real workspace and expects tool effects to land live), and the inplace confirmation is implied by starting the server (stdin is the protocol channel; no prompt is possible — starting `jaiph mcp` on a workspace *is* the consent act). Explicit env (`JAIPH_INPLACE=0` + overlay/copy selection) can restore isolation. The container invocation must carry the workflow symbol (today the Docker inner run assumes `default`).

## Testing

- `src/cli/mcp/tools.test.ts` — derivation rules via `parsejaiph` fixtures: exports-narrowing, route-target exclusion (param names must avoid reserved keywords like `channel`), lone-`default` rename to file slug, `default` skipped when others exist, shebang-filtered comment descriptions, fallback description, schema for n≥1 and 0 params, `toolNameFromFile` sanitization.
- `src/cli/mcp/server.test.ts` — protocol via injected fakes: initialize version negotiation (known + unknown), tools/list shape, tools/call arg mapping + text result, workflow failure as `isError` result (not protocol error), unknown tool / missing arg / unexpected arg → `-32602`, crashing `callTool` → `-32603` + stderr log, ping, notifications ignored, parse error → `-32700` id null, unknown method → `-32601`, blank lines ignored, `notifyToolsChanged` gated on initialize.
- e2e (follow-up task): drive `jaiph mcp` as a real child process with a scripted stdio session; assert stdout contains *only* JSON-RPC lines, tool calls return workflow return values, and `jaiph run` still works (regression on the shared launch path).

Verified in the spike: full handshake, list, calls (return values round-trip), concurrent handling (a validation error response overtakes slower in-flight calls), invalid-params rejection.

## Documentation

- `docs/mcp.md` — how-to (Diátaxis): serving a file, exposure & naming rules, writing tool descriptions as comments, client config (`claude mcp add mytools -- jaiph mcp ./tools.jh`), safety posture, hot reload, artifacts.
- `docs/cli.md` — `jaiph mcp` reference section (flags, exit behavior, stdout invariant, exposure table).
- `printUsage` in `src/cli/shared/usage.ts` — subcommand line + section + example.
- README — feature bullet + docs-note link.

## Out of scope (queued separately)

- Docker sandbox parity with inplace default (above).
- `notifications/progress` streamed from `STEP_START`/`STEP_END` events during a call, and `notifications/cancelled` killing the child run.
- MCP resources (e.g. exposing run artifacts) and structured output schemas.
