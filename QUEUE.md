# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. When a task is completed, remove that section entirely.
4. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
5. This queue assumes **hard rewrite semantics**:
   - breaking changes are allowed,
   - backward compatibility is **not** a design goal unless a task explicitly says otherwise.

---

## Language — `match` arm bodies: string values only, no `return`/inline script; multiline string literals; validation #dev-ready

**Goal**  
Tighten `match` so each arm body is unambiguously a **string-producing expression**: the match result is always a string (subject is already string-shaped). Keep **`return match x { … }`** as-is (outer `return` applies to the whole `match` expression — see prior design note). **Inside** arms, forbid the `return` keyword so a branch cannot read like workflow control flow — only the expression after `=>` defines the value.

**Allowed arm bodies (conceptual)**  
- String literals: `"…"` and **multiline** `"""…"""` (new — today only single-line `"…"` is parsed; extend `parseArmBody` in `src/parse/match.ts` and keep `parseMatchArms` in sync so bodies can span lines when triple-quoted).  
- Interpolation and bare identifiers that denote string values (`${var}`, `$var` if already supported by interpolation).  
- **`fail "…"`** — aborts; no string result (special case, still one arm body).  
- **Managed calls that run code and yield a captured string**: `run script(…)`, `run workflow(…)`, `ensure rule(…)` — execution is allowed; the **value** left in the match is still the stringlike outcome of that step (same semantics as after the runtime fix for executed arms).

**Disallowed**  
- Arm body starting with or being only **`return`** (e.g. `"x" => return "y"`) — **E_VALIDATE** with a clear message; arms are not mini-`return` sites.  
- **Inline script forms in arms** (backtick `` `…`() `` or fenced ``` blocks as call targets) — disallow so arms cannot embed ad-hoc script text; **named `run my_script(…)` stays allowed**.

**Implementation pointers**  
- Parser: triple-quoted arm bodies; possibly reuse or mirror triple-quote handling used elsewhere (`log`/`prompt`/const RHS). Formatter: `src/format/emit.ts` match / `match_expr` emission must preserve multiline arms.  
- Validation: extend `validateMatchExpr` or walk `arm.body` strings in `src/transpile/validate.ts` (and any shared helper for “inline script in expression”).  
- Tests: parser + validator + formatter round-trip; E2E or unit case with `"""` arm and with rejected `return` / rejected inline script.  
- Docs: `docs/grammar.md` (`arm_body`), `docs/language.md` / `docs/index.html` — document allowed forms and multiline strings.

**Relationship**  
Arm bodies that use `run` / `ensure` / `fail` only make sense once those bodies are **executed** (see the queue task **Bug — `match` arm bodies: runtime must execute …**). This task can land after that runtime work, or validation/parser can land first if it only rejects syntax that was already invalid or misleading.

**Acceptance criteria**  
- `return` as the leading token of a match arm body is rejected at validate time with `E_VALIDATE`.  
- Inline script-in-arm forms are rejected with `E_VALIDATE`.  
- `"""` multiline string arm bodies parse, format round-trip, and produce the expected string value at runtime.  
- `return match x { … }` at workflow/rule level remains valid; docs distinguish outer `return` vs forbidden inner `return`.

---

## Bug — `match` arm bodies: runtime must execute `fail` / `run` / `ensure`, not stringify; progress tree should show nested scripts #dev-ready

**Goal**  
`const name = match subject { … }` must behave like real workflow steps in each arm: `fail "…"` must abort with failure, `run script(…)` / `run workflow(…)` / `ensure rule(…)` must execute and capture return values. CLI output must not masquerade arm source text as `log` lines (`ℹ fail "…"` / `ℹ run safe_name(…)`). The TTY/static step tree should surface nested script (and workflow) calls inside `match` the same way `e2e/tests/113_match_expression.sh` expects `▸ script …` / `✓ script …` under the workflow.

**Repro**  
File: `e2e/match.jh` (shebang `jaiph`; defines `script safe_name` and `workflow default(name_param)` with `const name = match name_param { "" => fail "usage: …"; _ => run safe_name(name_param) }` then `log name`).

```bash
e2e/match.jh                          # observed: ℹ fail "usage: …" then ✓ PASS — wrong (should fail workflow)
e2e/match.jh dsdsa                    # observed: ℹ run safe_name(name_param), no script row — wrong (should run script, show script in tree)
```

**Observed vs expected**  
- Today the Node runtime treats each match arm body only as a string: `evaluateMatch` in `src/runtime/kernel/node-workflow-runtime.ts` interpolates `arm.body` and returns `stripOuterQuotes(…)` as the match value — it never dispatches `fail` or `run`. The following `log ${name}` then prints that verbatim string, which the CLI renders as a **LOG** event (`ℹ …`), hence “wrong log content.”  
- `src/cli/run/progress.ts` `collectWorkflowChildren` only labels `const` steps as `const <name>` and does not walk `value.kind === "match_expr"` arms, so the projected tree never shows `script safe_name` (unlike top-level `run get_status()` in 113).

**Pointers**  
- Fix execution: parse or branch on arm body shape in `evaluateMatch` (or evaluate arms via the same machinery as standalone steps) so `fail` / `run` / `ensure` / expression literals are handled correctly; add regression tests (unit and/or E2E using `e2e/match.jh` or inline fixture).  
- Optional UX follow-up: extend `collectWorkflowChildren` for `const` + `match_expr` to list nested `run`/`ensure` targets for tree parity with `113_match_expression.sh`.

**Acceptance criteria**  
- `e2e/match.jh` with no args exits non-zero and does not print a fake `log` line for the usage message.  
- `e2e/match.jh some/name` runs `safe_name`, logs the transformed name, exit 0; progress output includes script `safe_name` (or equivalent) in the step tree, consistent with other match E2E tests.  
- Existing `e2e/tests/113_match_expression.sh` and match-related unit tests keep passing.

---

## Tooling — `jaiph format` preserves top-level definition order #dev-ready

**Goal**  
`jaiph format` should only normalize the leading block to: all `import` lines (in source order), then the module `config { ... }` block if present, then all `channel` lines (in source order). Everything else (`rule`, `script`, `workflow`, top-level `const`, and `test` blocks in `*.test.jh`) must keep the same relative order as in the source file. Top-level `#` comments must not be dropped (including when separated from the next declaration by blank lines). Comments immediately before an `import`, `config`, or `channel` move with that construct after hoist.

**Context**  
Formatter: `src/format/emit.ts`, parser: `src/parser.ts`. Regression: formatting `lib/queue.jh` moved `workflow` after `script` and could strip header comments.

**Acceptance criteria**  
- Round-trip tests in `src/format/emit.test.ts` cover mixed rule/workflow/script order and comment preservation.
- `jaiph format` on a file with interleaved definitions does not reorder non-hoisted top-level items.

---

## Compiler — enforce `export` for imported qualified references #dev-ready

**Goal**  
Cross-module references (`import "…" as lib` then `lib.some_name` in `run` / `ensure` / channel routes / etc.) must respect the imported module’s API surface: if the imported file uses the `export` keyword on any rule, script, or workflow, then **only** names listed in that module’s `exports` array may be referenced through the import alias. A reference to a symbol that exists in the module but is not exported must fail validation (`E_VALIDATE`) with a clear message.

**Today**  
Parsing records `export` in `jaiphModule.exports` (`src/parser.ts`), and the formatter emits it (`src/format/emit.ts`). Reference resolution only checks that the short name exists on the imported AST (`importedHasAllowedKind` in `src/transpile/validate-ref-resolution.ts`); it does **not** consult `exports`.

**Design notes**

- **Modules with no `export` lines** (`exports` is `[]`): keep current behavior — treat every top-level rule / script / workflow as importable — so existing projects keep working without churn.
- **Modules with at least one `export`**: switch to **explicit surface** — a qualified ref `alias.name` is valid only if `name` is in `importedModule.exports` (and still exists and has the right kind for the call site). Symbols that are only used internally in that file stay private to importers.
- Apply the same rule everywhere split refs are validated (run targets, ensure targets, mocks in tests, channel `->` routes if they use `alias.workflow`, etc. — audit `validateReferences` / `validateRef` call graph).

**Acceptance criteria**

- Unit tests: importer references non-exported symbol in a module that has some `export` → `E_VALIDATE`; same symbol works when exported; module with zero exports still allows references (legacy).
- Docs or changelog note describing explicit-export modules vs legacy “all public” modules.

---

## Runtime — credential proxy for Docker mode

**Goal**  
Containers should never hold real API keys. Implement a host-side HTTP proxy (the "Phantom Token" pattern) that intercepts outbound API requests from containers, strips a placeholder credential, and injects the real key before forwarding upstream. The agent inside the container literally cannot leak the real key — it never has it.

**Design**

1. **Host-side proxy** — a lightweight `http.createServer` bound to `127.0.0.1:<port>` (macOS/WSL2) or the `docker0` bridge IP (Linux). Receives requests from the container, swaps `x-api-key: placeholder` with the real key from host env, forwards to the upstream API, pipes the response back (including streaming SSE).
2. **Container env injection** — instead of passing `ANTHROPIC_API_KEY=$real_key` into `docker run`, pass `ANTHROPIC_API_KEY=placeholder` + `ANTHROPIC_BASE_URL=http://host.docker.internal:<port>`.
3. **Multi-backend routing** — Jaiph supports Claude and Cursor backends. Each backend's CLI must respect a base URL override env var. `claude` CLI supports `ANTHROPIC_BASE_URL`; `cursor-agent` may not — needs investigation.
4. **Lifecycle** — proxy starts before the first Docker container launch, shuts down after the last container exits or on Jaiph process exit.

**Context**

- Pattern reference: [NanoClaw's credential proxy](https://jonno.nz/posts/nanoclaw-architecture-masterclass-in-doing-less/) — same approach, independently arrived at.
- Current Docker execution path: `src/runtime/kernel/` — Docker run/exec logic, env var forwarding.
- Dockerfile: `.jaiph/Dockerfile` — container image setup.
- Backend CLI invocation: `src/runtime/kernel/node-workflow-runtime.ts` — where `claude` / `cursor-agent` commands are constructed with env vars.

**Open questions**

- Does `cursor-agent` support a base URL override? If not, the proxy pattern may require a wrapper script or LD_PRELOAD-based interception inside the container.
- Single port with path-based routing vs one port per backend?
- Should the proxy also enforce rate limits or audit-log API calls?

**Acceptance criteria**

- Host-side proxy starts automatically when Docker mode is active.
- Containers receive only placeholder credentials — no real API keys in container env.
- `claude` CLI calls from inside Docker succeed via the proxy.
- Proxy handles streaming responses (SSE) correctly.
- Real keys never appear in container logs, env dumps, or process listings.
- Platform-specific host address resolution works (macOS, Linux).

---

## Runtime — harden Docker execution environment

**Goal**  
Docker mode is the isolation boundary for workflow runs. Harden it: least-privilege mounts, explicit and documented env forwarding (what crosses the container boundary), network defaults, image supply chain, and failure modes when Docker is misconfigured or unavailable — so "Docker on" is a deliberate security posture, not accidental leakage.

**Context**

- Docker runtime: `src/runtime/kernel/` — look for `docker.ts` or Docker-related logic in the run path.
- E2E Docker tests: `e2e/tests/72_docker_run_artifacts.sh`, `e2e/tests/73_docker_dockerfile_detection.sh`.
- Config: `runtime.docker_enabled`, `runtime.docker_timeout`, `runtime.workspace` keys in `src/config.ts` and metadata parsing.

**Acceptance criteria**

- Threat-model notes (short section in `docs/sandboxing.md` or equivalent): what Docker is / isn't protecting against.
- Concrete hardening changes in `docker.ts` / run path (e.g. mount validation, env allowlist or documented denylist, safer defaults) with unit tests.
- No silent widen of host access without opt-in.

---

## Runtime — default Docker when not CI or unsafe #dev-ready

**Goal**  
When the user has not opted into "unsafe" local execution, workflows should run in Docker by default. **Default `runtime.docker_enabled` to on** only when **neither** `CI=true` **nor** `JAIPH_UNSAFE=true` is set in the environment. If either is set, default Docker to **off** unless explicitly overridden via `runtime.docker_enabled` / `JAIPH_DOCKER_ENABLED`.

Introduce **`JAIPH_UNSAFE=true`** as the explicit "run on host / skip Docker default" escape hatch for local development when Docker is unwanted; document it next to `CI`.

**Context**

- Config resolution: `src/config.ts` — `resolveDockerConfig()` or equivalent; where `runtime.docker_enabled` default is determined.
- Env precedence: explicit `JAIPH_DOCKER_ENABLED` / in-file `runtime.docker_enabled` overrides defaults; then CI / unsafe default rule.
- E2E Docker tests: `e2e/tests/72_docker_run_artifacts.sh`, `e2e/tests/73_docker_dockerfile_detection.sh` — may need env setup adjustments.

**Acceptance criteria**

- `resolveDockerConfig()` (and any CLI preflight messaging) implements the precedence: explicit `JAIPH_DOCKER_ENABLED` / in-file `runtime.docker_enabled` overrides defaults; then apply CI / unsafe default rule.
- Unit tests for env combinations: plain local → Docker default on; `CI=true` → default off; `JAIPH_UNSAFE=true` → default off; both unset with explicit `JAIPH_DOCKER_ENABLED=false` → off.
- `CHANGELOG` + sandboxing / configuration docs updated.

---

## `jaiph serve` — expose workflows as an MCP server #dev-ready

**Goal**  
Add a `jaiph serve <file.jh>` command that starts a stdio MCP server. Each top-level workflow in the file becomes a callable MCP tool. This lets any MCP client (Cursor, Claude Desktop, custom agents) invoke Jaiph workflows directly.

**Context**

- MCP (Model Context Protocol) uses JSON-RPC 2.0 over stdio. A server must handle `initialize`, `tools/list`, and `tools/call`.
- Jaiph already has a runtime (`src/runtime/kernel/node-workflow-runtime.ts`) that can execute workflows and capture output.
- The `@modelcontextprotocol/sdk` npm package provides a Node.js server implementation, but the protocol is simple enough to implement directly (~200 lines for stdio JSON-RPC + the three methods).

**Phase 1 — single text input (this task)**

Each workflow becomes a tool with a single `input` string parameter:

```json
{
  "name": "analyze_gaps",
  "description": "workflow analyze_gaps from qa.jh",
  "inputSchema": {
    "type": "object",
    "properties": {
      "input": { "type": "string", "description": "Text input passed to the workflow" }
    }
  }
}
```

The `input` value is injected into the workflow environment as `JAIPH_MCP_INPUT` (accessible via `${input}` interpolation or `$JAIPH_MCP_INPUT` in scripts). The tool response is the workflow's captured output (log messages + prompt results).

**Phase 2 — typed parameters (future task)**

Extend the language with workflow parameters: `workflow analyze(file: string, depth: number) { ... }`. These map directly to the tool's `inputSchema`. Not in scope for this task.

**Scope**

1. **CLI command** (`src/cli/commands/serve.ts`): add `jaiph serve <file.jh>` that parses the file, starts a stdio JSON-RPC server, and handles `initialize`, `tools/list`, `tools/call`.
2. **Tool listing**: read the parsed module's `workflows` array. Each workflow becomes a tool entry with `name` = workflow name, `description` = `"workflow <name> from <filename>"`, `inputSchema` = single `input` string.
3. **Tool execution**: on `tools/call`, run the named workflow using the existing runtime. Capture all output (logs, prompt results). Return as `content: [{ type: "text", text: output }]`.
4. **Error handling**: if the workflow fails, return `isError: true` with the error message.
5. **Config inheritance**: the `.jh` file's `config { ... }` block applies normally (backend, model, etc.).
6. **E2E test**: a test that starts `jaiph serve` with a simple workflow, sends JSON-RPC messages via stdin, and verifies the tool list and a tool call response.
7. **Docs**: add a section to `docs/index.html` and `docs/jaiph-skill.md` about MCP server mode.

**Acceptance criteria**

- `jaiph serve examples/greeting.jh` starts a stdio MCP server.
- `tools/list` returns one tool per workflow.
- `tools/call` executes the workflow and returns its output.
- Errors produce `isError: true` responses (no server crash).
- E2E test passes.

---
