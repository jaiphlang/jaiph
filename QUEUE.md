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

## Make Docker Desktop e2e reliable and drop the engineer skip #dev-ready

Context: Docker-daemon e2e is **required product coverage** on GitHub Actions. Scripts include `72_docker_*`, `74b`–`74g`, `75`/`76`, `141_mcp_docker_*`, `148_standalone_image`, **`150_k8s_deploy` (kind)**, `151_serve_transports_docker`, `153_docker_*`, and every other script that needs the Docker daemon. Helpers in `e2e/lib/common.sh` (named `jaiph-run-*` waits, `e2e::docker_cleanup`, `e2e::run_logged`) already landed for several scripts. An overnight agent then **prematurely** removed `JAIPH_E2E_SKIP_DOCKER` from `.jaiph/ensure_ci_passes.jh` after a **subset** loop (`72`/`74*`/`148` ×3) — overnight `test:ci` immediately hung for hours on **`kind load docker-image`** in `150_k8s_deploy` and melted the Docker Desktop VM (~20GB+ qemu RSS). The skip has been restored.

Problem: Subset evidence ≠ full suite. Kind image import and other heavy daemon scripts are still unsafe under Desktop load. Agents must not declare done or delete this QUEUE section themselves.

**Agent instructions (mandatory):**
- Goal: full Docker e2e **works** on Desktop. The skip is temporary quarantine, not the deliverable.
- Do **not** remove `export JAIPH_E2E_SKIP_DOCKER=1` from `.jaiph/ensure_ci_passes.jh` until acceptance below is met. A unit test requires that export while this task is open — update the test only in the same commit that drops the skip.
- Do **not** treat a green loop of only `72`/`74*`/`75`/`148` as evidence. **Required evidence is full `npm run test:e2e`** (or equivalent that includes **`150_k8s_deploy`**) **3 consecutive times** green on a quiet Docker Desktop.
- Do **not** lengthen production probe timeouts in `docker.ts` without a unit test proving a product bug. Do **not** edit `QUEUE.md` to remove this task (orchestration owns removal).
- While iterating, leave the skip in place so overnight recover does not thrash.

Remediation: Finish hardening every daemon/kind e2e path (timeouts, cleanup, heartbeats, bounded waits) so full `test:e2e` is deterministic on Desktop; then drop the overnight skip.

### Acceptance criteria
- Existing guards remain: no silent `jaiph run … >/dev/null 2>&1` on success-asserted docker runs in `72`; `74b` waits via `e2e::wait_for_jaiph_run_container`; `e2e::jaiph_run_container_ids` uses `docker ps -a`.
- **`150_k8s_deploy.sh`** completes reliably on Docker Desktop (bounded waits; no multi-hour hang on `kind load` / image import); document any remaining intentional skip.
- **Evidence:** at least **3** consecutive green **full** `npm run test:e2e` runs with Docker available (must exercise kind/`150_k8s_deploy` or an explicit documented equivalent). Commands + pass counts in the commit message. Subset loops of `72`/`74`/`148` alone are **rejected**.
- Only then: remove `export JAIPH_E2E_SKIP_DOCKER=1` from `.jaiph/ensure_ci_passes.jh`, flip the `docker.test.ts` guard that currently requires the export, update `docs/contributing.md`.
- `npm run build` and `npm test` pass.

## Clear peer CLI slice baseline edges #dev-ready

Context: After reshaping CLI slice rules (or under the current `no-cross-cli-slice-imports` rule), peer-slice imports remain among `run`, `serve`, `mcp`, `exec`, `telemetry` and may still sit on `.dependency-cruiser-known-violations.json`. Known production peer edges include `serve/handler|server|openapi|types` → `mcp/*` and `exec/call` → `run/*` / `telemetry/*`.

Problem: Baselined peer-slice imports permanently couple features and force agents to load multiple CLI folders for one change.

Remediation: Eliminate peer-slice private imports by moving shared contracts into `src/cli/shared` (or lower layers) and retargeting call sites. Prefer extracting small shared modules over widening public barrels. Remove the corresponding baseline entries. Do not weaken severity. If the composition-root exception for `commands/` is not yet in the depcruise config, implement that exception as part of this task so command→slice edges are not mistaken for peer edges.

### Acceptance criteria
- `npm run arch:check --` equivalent with `--no-ignore-known` reports zero `no-cross-cli-slice-imports` violations (or only edges explicitly allowed by the commands-composition-root rule).
- `.dependency-cruiser-known-violations.json` has zero `no-cross-cli-slice-imports` entries.
- A regression test fails if a new peer-slice private import is introduced (e.g. synthetic `serve` → `mcp` fixture).
- `npm run build` and `npm test` pass.

## Expose runtime test seams on the public entry; clear deep-runtime baseline #dev-ready

Context: `no-deep-imports-into-runtime` bans imports of `src/runtime/**` other than `src/runtime/index.ts` from outside the package. Twelve leftover violations in `.dependency-cruiser-known-violations.json` are all **test** files piercing internals (`_dockerExec`, `docker-inplace`, `emit`, `RuntimeEventEmitter`, `node-workflow-runner`, `graph`). Production call sites already use the public entry.

Problem: Agents debugging via tests still load private runtime paths; the baseline hides ongoing deep imports.

Remediation: Re-export the minimal test seams needed by cross-package tests from `src/runtime/index.ts` (or a dedicated `src/runtime/testing.ts` that is itself allowlisted as a second public entry in `.dependency-cruiser.cjs` — prefer one documented entry). Retarget every baselined test import to that surface. Remove all `no-deep-imports-into-runtime` entries from the baseline. Do not put production-only internals on the public surface without need; keep the seam set small and named.

Also clear the two layer-violation test edges if still present: `src/parse/parse-error-snapshot.test.ts` → `src/transpile/module-graph.ts` and `src/transpile/module-graph.test.ts` → `src/runtime/kernel/graph.ts` (retarget through public entries or move assertions so tests do not import upward).

### Acceptance criteria
- `.dependency-cruiser-known-violations.json` has zero `no-deep-imports-into-runtime` entries.
- Zero production or test files outside `src/runtime/` import `src/runtime/**` except the documented public entry path(s); enforced by depcruise (not only by baseline).
- The two upward test layer violations above are gone from the baseline and do not recur under `--no-ignore-known`.
- `npm run arch:check`, `npm run build`, and `npm test` pass.

## Collapse transpile to a single public entry #dev-ready

Context: `docs/agent-analyzability.md` and `.dependency-cruiser.cjs` currently allow two external doors into compile: `src/transpiler.ts` and `src/transpile/module-graph.ts` (runtime allowlist). Dual entries weaken the "one contract per package" mental model for agents.

Problem: Callers can bypass `src/transpiler.ts` and import `module-graph.ts` directly; deep-import rules special-case that path.

Remediation: Re-export the full module-graph API (`loadModuleGraph`, `readModuleGraph`, `writeModuleGraph`, `ModuleGraph` types, etc.) from `src/transpiler.ts` if not already complete. Retarget every outside import of `src/transpile/module-graph.ts` (including runtime) to `src/transpiler.ts`. Tighten `.dependency-cruiser.cjs`: remove the `module-graph.ts` `pathNot` exceptions from `no-deep-imports-into-transpile` and `layer3-runtime-only-transpile-public-graph` so runtime may import only `src/transpiler.ts` from the transpile package. Update the ADR table/allowlisted-exception prose to match. Do not star-export the whole transpile tree.

### Acceptance criteria
- No file outside `src/transpile/` imports `src/transpile/module-graph.ts` (grep or depcruise test).
- Runtime → transpile edges only target `src/transpiler.ts`; a test fails if runtime imports any other `src/transpile/**` path.
- `docs/agent-analyzability.md` states a single transpile public entry (`src/transpiler.ts`).
- `npm run arch:check`, `npm run build`, and `npm test` pass.

## Split hotspot files and drop ESLint grandfather overrides #dev-ready

Context: `docs/agent-analyzability.md` caps production files at ≤8 runtime imports and ≤400 lines (`eslint.config.mjs`, `npm run lint`). The hottest units are grandfathered with per-file overrides — including `src/runtime/kernel/node-workflow-runtime.ts`, `src/transpile/validate-step.ts`, `src/runtime/docker.ts`, `src/runtime/kernel/prompt.ts`, `src/cli/commands/run.ts`, `src/cli/serve/handler.ts`, `src/parse/workflow-brace.ts`, `src/format/emit.ts`, and others listed in `eslint.config.mjs`.

Problem: Caps do not apply where agents pay the most context cost. The ADR invariant stays aspirational for the hot path.

Remediation: Split the grandfathered files into sibling modules in the same directory (per factory `code_philosophy`: prefer siblings, not deeper trees). After each file meets both caps without an override, delete its override block from `eslint.config.mjs`. Do not raise global max. You may land this as multiple commits within the task, but the task is not done until every override under the "Grandfathered violators" section is removed or the commit message lists any remaining override with a fresh justification and a follow-up is explicitly out of scope — prefer removing all of them. Keep public entries curated (no `export *` of the whole package).

### Acceptance criteria
- `eslint.config.mjs` contains no per-file override that turns off `import/max-dependencies` or `max-lines` for the previously grandfathered paths (or a test enumerates the grandfather section and asserts it is empty / absent).
- `npm run lint` exits 0.
- Every former grandfathered production file is ≤400 non-blank/non-comment lines and ≤8 runtime imports under the global rules (spot-checked by lint).
- `npm run build` and `npm test` pass; behaviour preserved.

## Refresh agent-analyzability ADR to match landed enforcement #dev-ready

Context: `docs/agent-analyzability.md` still contains stale "queued in QUEUE.md" / "still planned" wording from the rollout (e.g. deep-import work described as queued; `arch:graph` called planned). Enforcement status has moved on: parse/transpile/format/runtime deep imports, CLI slice rules, docs summary/size guards, and factory `code_philosophy` are live. `QUEUE.md` may be empty or hold only newer follow-ups.

Problem: Agents reading the ADR get a wrong picture of what CI already enforces versus what remains open.

Remediation: Edit `docs/agent-analyzability.md` so Status / Enforcement / Landed sections accurately describe current CI scripts, rules, baseline policy, and remaining known gaps (cycles, CLI peer slices, ESLint hotspots, dual transpile entry — only those still true at edit time). Remove claims that work is "queued in QUEUE.md" unless a matching task header still exists. Keep the summary-first lead. Do not invent new rules in this task; documentation parity only. Optionally add `arch:graph` script if Graphviz is acceptable as optional/dev-only; otherwise document it as optional and skip wiring.

### Acceptance criteria
- A test (grep or docs-structure sibling) fails if `docs/agent-analyzability.md` still claims deep-import enforcement is merely "queued in QUEUE.md" while the corresponding depcruise rules already exist in `.dependency-cruiser.cjs`.
- The ADR Enforcement table matches the scripts in `package.json` (`arch:check`, `lint`) and does not promise unbuilt gates.
- `integration/docs-structure.test.ts` summary/size guards still pass for this page.
- No behaviour/code changes beyond docs (and optional `arch:graph` script).

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
