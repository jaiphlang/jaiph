# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, **orchestration** removes that section (`queue.remove_completed_task` in `.jaiph/engineer.jh`). Agents and humans implementing a task must **not** edit `QUEUE.md` to delete or rewrite the current task — leave queue updates to the workflow.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Operator logging for mcp / serve (no winston) #dev-ready

Context: `jaiph run` prints a TTY banner (`Jaiph: Running <file> (<sandbox>)`) and colorizes workflow `log` / `logwarn` / `logerr` with depth indent and parallel subscripts (`buildAsyncIndent`). `jaiph mcp` and `jaiph serve` already have an ad-hoc `log: (line: string) => void` that writes to **stderr** (startup posture via `logStartupPosture`, serve invoke/cancel lines, crashes). They do **not** emit a per-call "Running … rundir=…" line, do not mirror workflow log events to the operator channel, and do not share level/color formatting. Protocol channels must stay clean: MCP **stdout** is JSON-RPC only; HTTP response bodies are API payloads.

Problem: An operator watching `jaiph mcp` / `jaiph serve` cannot see which workflow started, under which sandbox posture, or where artifacts live, without digging into `.jaiph/runs`. Adding winston/pino would pull a logging framework into a package that deliberately has one runtime dependency (`jose`) and already solved "write a line to stderr."

Remediation — design (implement exactly this; do **not** add winston/pino/bunyan):

1. **Two channels, never mixed into protocol**
   - **Operator log** → stderr only (existing sink). Lifecycle + per-call banners + optional workflow-log mirror.
   - **Workflow log events** (`LOG` / `LOGWARN` / `LOGERR`) stay in `run_summary.jsonl` and in `callWorkflow`'s collected result text (unchanged contract). Mirroring them to the operator log is opt-in.
   - Never write operator diagnostics to MCP stdout or into HTTP JSON/SSE payloads.

2. **Tiny shared logger in `src/cli/shared/`** (e.g. `server-log.ts`), not a new dependency
   - API shape roughly: `createServerLog({ label: "jaiph mcp" | "jaiph serve", write, colorEnabled })` with `info` / `warn` / `error` (and `debug` gated by `JAIPH_SERVER_LOG=debug` or equivalent).
   - Default format: one line, grep-friendly `key=value` tails — e.g. `jaiph serve: Running engineer (Docker sandbox, unsafe) run_id=… rundir=…`.
   - Colors only when the sink is a TTY and `NO_COLOR` is unset; reuse `colorize` (move to `src/cli/shared/` if needed so `run` / mcp / serve do not create a peer-slice import). Levels: info→blue (or plain), warn→yellow, error→red. No colors in non-TTY / CI.
   - Replace bare `(line) => process.stderr.write(...)` wiring in `commands/mcp.ts` and `commands/serve.ts` with this helper; keep the injectable `log` seam for tests.

3. **Per-call operator lines (required)**
   - On every `callWorkflow` start (mcp tool call and serve run): one info line naming workflow (or entry basename), effective sandbox label (same vocabulary as `formatJaiphRunningBannerLines` / `logStartupPosture`: snapshot / in-place / unsafe / no sandbox), `run_id=…`, and `rundir=…` when known.
   - Under Docker, rundir may appear only after discovery — emit start without rundir (or `rundir=pending`), then one follow-up info line when `runDir` is resolved; do not spam.
   - On call end: one line with terminal status (`ok` / `failed` / `cancelled`), `exit=…`, `elapsed_ms=…`, and `rundir=…` when known.
   - Serve may keep principal/correlation on these lines (already partially logged at invoke/cancel); mcp omits principal or uses `-`. Collapse duplicate invoke lines so start is not logged twice.

4. **Optional workflow-log mirror (verbosity)**
   - Default: do **not** mirror every workflow `log` to stderr (avoids drowning MCP hosts and duplicating tool-result text).
   - When `JAIPH_SERVER_LOG_WORKFLOW=1` (name may be adjusted but must be documented in `docs/env-vars.md`): mirror LOG/LOGWARN/LOGERR to the operator log with level colors, `run_id=`, and the same depth / `async_indices` subscript indent as TTY (`buildAsyncIndent` — move or share from a place both `run` and `exec` may use without peer-slice violations).
   - Credential redaction: mirrored lines must use the same redaction boundary as durable journal / call results (never print raw secrets on stderr).

5. **Docs**
   - Document the operator-log contract and env knobs in `docs/cli.md` (mcp/serve sections) and `docs/env-vars.md`.
   - Explicitly state: not winston; stderr-only; protocol channels untouched.

### Acceptance criteria
- No new npm dependency for logging (package.json `dependencies` still only what was there aside from unrelated changes); a test or review note fails the task if winston/pino/etc. is added for this feature.
- With a captured stderr `log` sink, starting a mcp or serve workflow call emits a line matching `/Running .*\(.*\).*run_id=/` (sandbox label present) and a terminal end line with status + elapsed; a unit/integration test fails if either line is missing.
- When rundir is known by end of call, the end line (or a dedicated follow-up) includes `rundir=`; test covers host mode at minimum.
- MCP stdout under a tool call contains only JSON-RPC (no `Running` / ANSI banner leakage); test asserts operator lines appear on the log sink, not on the write/stdout channel.
- Default (workflow mirror off): workflow `log "hi"` does not appear on the operator sink; with the documented env opt-in, it does appear, colorized by level when `colorEnabled`, and includes async subscript indent when `async_indices` is non-empty; tests cover both.
- Mirrored / operator lines never contain a fixture credential value that journal redaction would strip (reuse or extend an existing redaction test pattern).
- `npm run build` and `npm test` pass; `npm run arch:check` still exits 0 (shared logger lives under `src/cli/shared`, no new peer-slice edges).
