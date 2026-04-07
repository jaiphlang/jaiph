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

## CLI — async branch numbers in progress tree <!-- dev-ready -->

**Goal**  
When a workflow uses `run async`, the progress tree should show a **subscript number** prefix on every output line belonging to that async branch. This makes interleaved async output scannable — you can tell which branch produced which line without tracing indentation.

**Numbering**  
Subscript numbers use Unicode U+2080-U+2089: ₀ ₁ ₂ ₃ ₄ ₅ ₆ ₇ ₈ ₉. Numbering is **global order of `run async` dispatch** within the parent workflow (first async call = ₁, second = ₂, etc.). Two-digit support: `₁₀`, `₁₁`, etc. The number is always rendered with a leading space (` ₁`, ` ₂`, ` ₁₂`) to maintain alignment with non-async lines.

The number appears at the **same indentation level as the async call site** — if a nested workflow fires its own `run async`, those get their own numbering at the nested indent level.

**Color**  
Subscript numbers are rendered in **dim/grey** (ANSI `\u001b[2m`) — same style as the `·` continuation markers. When `NO_COLOR` is set or output is non-TTY, the subscript number is emitted without ANSI codes.

**Before → After**

Before:
```text
workflow default
  ▸ workflow cursor_say_hello
  ▸ workflow claude_say_hello
  ·   ▸ prompt cursor "Say: Greetings! I am [mo..."
  ·   ▸ prompt claude "Say: Greetings! I am [mo..."
  ·   ✓ prompt claude (4s)
  ·   ℹ Greetings! I am Claude Opus 4.6.
  ✓ workflow claude_say_hello (4s)
  ·   ✓ prompt cursor (5s)
  ·   ℹ Greetings! I am Composer.
  ✓ workflow cursor_say_hello (5s)

✓ PASS workflow default (5.6s)
```

After:
```text
workflow default
 ₁▸ workflow cursor_say_hello
 ₂▸ workflow claude_say_hello
 ₁·   ▸ prompt cursor "Say: Greetings! I am [mo..."
 ₂·   ▸ prompt claude "Say: Greetings! I am [mo..."
 ₂·   ✓ prompt claude (4s)
 ₂·   ℹ Greetings! I am Claude Opus 4.6.
 ₂✓ workflow claude_say_hello (4s)
 ₁·   ✓ prompt cursor (5s)
 ₁·   ℹ Greetings! I am Composer.
 ₁✓ workflow cursor_say_hello (5s)

✓ PASS workflow default (5.6s)
```

Non-async steps (the root workflow line, `✓ PASS`) have **no** subscript number — only lines within an async branch get one.

**Nested async example**

```text
workflow default
 ₁▸ workflow parallel_suite
 ₂▸ workflow lint_check
 ₁·  ₁▸ workflow test_unit
 ₁·  ₂▸ workflow test_integration
 ₁·  ₁✓ workflow test_unit (2s)
 ₁·  ₂✓ workflow test_integration (5s)
 ₁✓ workflow parallel_suite (5s)
 ₂✓ workflow lint_check (1s)

✓ PASS workflow default (5s)
```

**Context**

- Progress tree builder: `src/cli/run/progress.ts` — `buildRunTreeRows()` / `collectWorkflowChildren()`. The `asyncPrefix` is already tracked (`step.async ? "async " : ""`); extend with a numeric index.
- Display renderer: `src/cli/run/display.ts` — `formatStartLine()`, `formatCompletedLine()`, `formatHeartbeatLine()`. These take `indent` and render `·` prefixes. The subscript number needs to be prepended at the indent level of the async call site.
- Runtime event pipeline: `src/runtime/kernel/node-workflow-runtime.ts` — `executeSteps()` dispatches async branches via `asyncFrameStack.run()`. The async branch index needs to propagate through `STEP_START`/`STEP_END`/`LOG` events so the display layer can map lines to branches.
- Stderr handler: `src/cli/run/stderr-handler.ts` — parses `run_summary.jsonl` events and renders lines; needs to read the async branch index from events.
- E2E tests: `e2e/tests/104_run_async.sh` — existing async tests; add cases verifying subscript numbers for flat and nested async.
- Docs: `docs/index.html` — update the async workflow output sample to show subscript numbers.

**Acceptance criteria**

- `run async` branches display subscript numbers (` ₁` ` ₂` ` ₃`…) at the async call site's indentation level in both TTY and non-TTY output.
- Two-digit numbers work (`₁₀`, `₁₁`, etc.).
- Numbers are dim/grey in TTY mode; plain text in non-TTY / `NO_COLOR`.
- Nested `run async` inside a child workflow gets its own numbering scope at the child's indent level.
- Non-async lines have no subscript number prefix.
- E2E test with nested async workflows verifies correct numbering and indentation.
- `docs/index.html` async sample updated.

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

## Runtime — default Docker when not CI or unsafe <!-- dev-ready -->

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

## `jaiph serve` — expose workflows as an MCP server <!-- dev-ready -->

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
