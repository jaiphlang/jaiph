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

## Docs — write `language.md` covering all core language primitives <!-- dev-ready -->

**Goal**  
Create `docs/language.md` — a single, self-contained reference for Jaiph's language fundamentals. Structured for humans: each primitive gets **concept → brief description → example → details/edge cases**. This replaces `grammar.md` as the go-to language doc (grammar.md stays as the formal EBNF reference).

**Structure per section**

```
## <Concept>
One-paragraph high-level description.

    <minimal working example>

**Details:** edge cases, constraints, gotchas.
```

**Primitives to cover (in this order)**

1. **Strings** — double-quoted literals, escape sequences, `${…}` interpolation, `"""…"""` heredocs, rejected shell-isms (`$(…)`, `${var:-…}`)
2. **Variables (`const`)** — module-level `const`, step-level `const`, bare identifier args as implicit `"${name}"`, scope rules
3. **Scripts** — named scripts (backtick, fenced, shebang), inline scripts (`` run `cmd` ``), interpreter tags (`` ```python ``), `${…}` passthrough in fenced vs blocked in backtick
4. **Workflows** — definition, parameters, calling via `run`, `run async`, return values (`return "…"`, `return run …`, `return ensure …`, `return match …`), workflow-scoped `config`
5. **Rules** — definition, parameters, calling via `ensure`, success = exit 0, restricted step set (no `prompt`, no `run async`, no `recover`, scripts only via `run`)
6. **Prompts** — `prompt "…"`, `prompt """…"""`, backends (`cursor`, `claude`), `agent.default_model` / `agent.backend` config, capturing results (`const x = prompt …` / `x = prompt …`)
7. **Structured prompt output (`returns`)** — `prompt "…" returns "schema"`, JSON schema strings, field access via `${result.field}`, validation rules
8. **Pattern matching (`match`)** — `match var { … }`, patterns (`"literal"`, `/regex/`, `_`), arm bodies, expression form (`const x = match …`, `return match …`), exactly-one-wildcard rule
9. **Error handling (`recover`)** — `ensure … recover (failure) { … }`, `recover (failure, attempt) { … }`, single-run semantics (post-redesign), recursion for retries, `run … recover` (post-redesign)
10. **`fail` and `return`** — aborting vs returning, `fail "message"`, bare `return`, value returns, interaction with recover
11. **Logging (`log`, `logerr`)** — string/heredoc/bare-identifier forms, stdout vs stderr
12. **Channels and inbox (`channel`, `send`)** — `channel name`, `channel name -> wf1, wf2`, `send channel <- "…"`, send RHS forms (literal, variable, `run`, forward), dispatch semantics
13. **Imports** — `import "path" as alias`, `.jh` auto-append, qualified references (`alias.name`), `export` on workflows/rules
14. **Config** — module-level `config { … }`, workflow-level `config { … }`, allowed keys, value types, `runtime.*` (module-only) vs `agent.*`/`run.*`
15. **Conditionals (`if`)** — *(if still present post-redesign, otherwise: note removal and migration to `recover` + `match`)*
16. **Testing** — `test "…" { … }`, `mock prompt`, `mock workflow/rule/script`, `expect_contain`/`expect_not_contain`/`expect_equal`, `allow_failure`, `.test.jh` convention
17. **File structure** — shebang `#!`, comments `#`, blank lines, top-level statement order, `jaiph format` canonicalization
18. **Reserved words** — full keyword list, where they matter (param names, bare args)

**Context**

- Formal grammar (EBNF): `docs/grammar.md`
- AST types: `src/types.ts`
- Parser modules: `src/parse/*.ts`
- Existing topical docs: `docs/configuration.md`, `docs/testing.md`, `docs/inbox.md`
- Examples: `examples/*.jh`

**Acceptance criteria**

- `docs/language.md` exists and covers all 18 sections above.
- Every section has at least one runnable example.
- Edge cases and constraints are documented (not just the happy path).
- Cross-references to `grammar.md` for formal EBNF, `testing.md` for test harness details, `configuration.md` for full config key list.
- No redundant duplication of full EBNF — link to `grammar.md` instead.

---

## Bug — Docker mode swallows failed-step output

**Problem**  
When a workflow fails in Docker mode, the "Output of failed step" line is missing from the terminal summary. Non-Docker runs print it; Docker runs silently drop it.

**Repro**

```bash
# Shows "Output of failed step: You didn't provide your name :(" 
examples/say_hello.jh

# Missing that line entirely
JAIPH_DOCKER_ENABLED=true examples/say_hello.jh
```

**Root cause (likely)**  
The failure summary renderer reads the step's `.out` file from disk after the run completes. In Docker mode the output files live inside the container (or at a remapped path); by the time the host-side summary code tries to read them, the path doesn't resolve.

**Acceptance criteria**

- `JAIPH_DOCKER_ENABLED=true examples/say_hello.jh` prints the same "Output of failed step" line as the non-Docker run.
- No regression in non-Docker output.

---

## Libs — add lib resolution + `queue` as first Jaiph lib <!-- dev-ready -->

**Goal**  
Establish the Jaiph library pattern: a `.jh` file with exports, installable in a known path, importable by name. Build `queue.jh` as the first lib — a markdown-section-based task queue manager backed by a central directory (designed for Obsidian vaults). This validates the lib system and is immediately useful for Jaiph's own development.

**Part 1: Lib resolution in the import resolver**

Currently `import "path" as alias` resolves relative to the importing file only. Add a fallback: if relative resolution fails, check `JAIPH_LIB_PATH` (default `~/.jaiph/lib/`). This is the only language-level change needed.

```jaiph
import "queue" as queue    # resolves to ~/.jaiph/lib/queue.jh
```

Resolution order:
1. Relative to importing file (existing behavior)
2. `JAIPH_LIB_PATH` directories (new, colon-separated, default `~/.jaiph/lib`)

**Part 2: `queue.jh` lib**

A lib that reads/writes markdown files in `QUEUE_DIR` (env var, e.g. `~/vault/queues`). One file per project. Sections (`## heading`) are tasks. Hashtags in headings (`#dev-ready`, `#bug`) are filterable tags.

Exports:
- `script get(project, tag?)` — return first `##` section, optionally filtered by `#tag`
- `script list(project?, tag?)` — list section headings with tags; `--all` across projects
- `script add(project, content)` — prepend a task section
- `script complete(project)` — remove the first `##` section
- `workflow next_task(project, tag)` — wrapper: get + return
- `rule has_tasks(project)` — check if project has any sections

**Part 3: Hashtag migration**

Migrate `QUEUE.md` headings from `<!-- dev-ready -->` HTML comments to `#dev-ready` hashtags. This makes tags visible in Obsidian's native tag search/filter/graph.

**Context**

- Import resolver: `src/transpile/` — where import paths are resolved (look for `import` resolution in `validate.ts` or a dedicated resolver module).
- `export` keyword: `src/parser.ts` — currently supported on `workflow` and `rule`; verify it works on `script`.
- Existing cross-file import tests: `e2e/tests/116_cross_file_import.sh`, `e2e/tests/118_import_not_found.sh`.
- Examples of imports: `examples/` — any `.jh` files using `import`.

**Acceptance criteria**

- `import "queue" as queue` resolves from `~/.jaiph/lib/queue.jh` when no relative match exists.
- `JAIPH_LIB_PATH` env var overrides the default lib directory.
- `export script` works (parser + validator).
- `queue.jh` lib installed in `~/.jaiph/lib/` provides `get`, `list`, `add`, `complete`, `next_task`, `has_tasks`.
- E2E test: a workflow imports `queue`, adds a task, lists it, completes it.
- Existing relative-path imports are unaffected.
- `QUEUE.md` hashtag migration: `<!-- dev-ready -->` → `#dev-ready` across all headings.

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
