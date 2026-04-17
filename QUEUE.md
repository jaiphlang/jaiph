# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. When a task is completed, remove that section entirely.
4. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
5. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.

***

## Runtime — default Docker when not CI or unsafe #dev-ready

**Goal**
When the user has not opted into "unsafe" local execution, workflows should run in Docker by default. **Default `runtime.docker_enabled` to on** only when **neither** `CI=true` **nor** `JAIPH_UNSAFE=true` is set in the environment. If either is set, default Docker to **off** unless explicitly overridden via `runtime.docker_enabled` / `JAIPH_DOCKER_ENABLED`.

Introduce **`JAIPH_UNSAFE=true`** as the explicit "run on host / skip Docker default" escape hatch for local development when Docker is unwanted; document it next to `CI`.

**Context**

* Config resolution: `src/config.ts` — `resolveDockerConfig()` or equivalent; where `runtime.docker_enabled` default is determined.
* Env precedence: explicit `JAIPH_DOCKER_ENABLED` / in-file `runtime.docker_enabled` overrides defaults; then CI / unsafe default rule.
* E2E Docker tests: `e2e/tests/72_docker_run_artifacts.sh`, `e2e/tests/73_docker_dockerfile_detection.sh` — may need env setup adjustments.

**Acceptance criteria**

* `resolveDockerConfig()` (and any CLI preflight messaging) implements the precedence: explicit `JAIPH_DOCKER_ENABLED` / in-file `runtime.docker_enabled` overrides defaults; then apply CI / unsafe default rule.
* Unit tests for env combinations: plain local → Docker default on; `CI=true` → default off; `JAIPH_UNSAFE=true` → default off; both unset with explicit `JAIPH_DOCKER_ENABLED=false` → off.
* `CHANGELOG` + sandboxing / configuration docs updated.

***

## Docker sandbox: Figure out a way to pass code changes from engineer.jh in docker mode to local env (git patch saved to .jaiph/runs?)

## Runtime — credential proxy for Docker mode

**Goal**
Containers should never hold real API keys. Implement a host-side HTTP proxy (the Phantom Token pattern) that intercepts outbound API requests from containers, strips a placeholder credential, and injects the real key from the host process environment before forwarding upstream. The workload in the container never receives the real secret.

**Design**

1. **Host-side proxy** — A lightweight Node HTTP server bound to an address **reachable from the container network** (typically **`0.0.0.0:<ephemeral-port>`** on the host; binding only `127.0.0.1` is often wrong for container-to-host access). For each request: replace placeholder auth with the real `ANTHROPIC_API_KEY` from the host, forward to the real Anthropic API base URL from host configuration, stream the response back (including SSE).
2. **Container env injection** — In `src/runtime/docker.ts` (`buildDockerArgs` / env passed into `-e`): pass `ANTHROPIC_API_KEY=<placeholder>` and `ANTHROPIC_BASE_URL=http://host.docker.internal:<port>` (or `http://<host-gateway>:<port>`). Never pass the real key in `-e`.
3. **Linux networking** — When using the hostname `host.docker.internal`, add **`--add-host=host.docker.internal:host-gateway`** to the `docker run` argument list where supported so the name resolves inside the container.
4. **Backends (v1 scope)** — **Claude / Anthropic only.** The Anthropic SDK and `claude` CLI honor `ANTHROPIC_BASE_URL`. **Cursor (`cursor-agent`)** does not have a documented equivalent to `ANTHROPIC_BASE_URL` in public Cursor CLI docs; **leave Cursor and codex (`OPENAI_*`) out of this task** and open a follow-up if the product needs the same guarantee there.
5. **Routing** — **Single listen port** and a single Anthropic-compatible upstream in v1. Multi-upstream path routing is deferred.
6. **Non-goals (v1)** — Rate limits and audit logging.
7. **Lifecycle** — Start the proxy before the first `spawnDockerProcess` for that Jaiph process; stop it when tearing down the Docker run (and on Jaiph exit), with reference counting if multiple Docker runs can occur in one process.

**Context**

* Pattern reference: [NanoClaw credential proxy](https://jonno.nz/posts/nanoclaw-architecture-masterclass-in-doing-less/).
* **Implementation touchpoints** — `src/runtime/docker.ts` (primary: `-e` forwarding, optional extra Docker flags), `src/cli/commands/run.ts` (spawn/cleanup lifecycle). Agent CLI args/env preparation: `src/runtime/kernel/prompt.ts` (likely unchanged).
* Image template: `.jaiph/Dockerfile`.

**Queue coordination**

* This edits the same `docker.ts` / Docker spawn path as the queued **Docker — strict image contract + GHCR** task—land together or immediately after to reduce merge churn.
* Later **Runtime — harden Docker execution environment** may tighten env policy; document proxy-related variables when that work lands.

**Acceptance criteria**

* Host-side proxy starts automatically when Docker mode is active (Anthropic/Claude path).
* Containers receive only a placeholder `ANTHROPIC_API_KEY` — no real Anthropic API key in container environment.
* `claude` CLI calls from inside Docker succeed via the proxy.
* Proxy handles streaming responses (SSE) correctly.
* Real keys do not appear in Jaiph-supplied container `-e` values (so they do not appear in `docker inspect` for those vars or in container `printenv` for them as anything but the placeholder).
* macOS and Linux: documented/working host reachability (`host.docker.internal` + `host-gateway` on Linux as needed, or an equivalent bridge address).

**Scope note**

* Target **\~3 files**: one small new module for the proxy plus focused edits in `docker.ts` and `run.ts`. Plain functions, no new abstraction layers.

## `jaiph serve` — expose workflows as an MCP server #dev-ready

**Goal**
Add a `jaiph serve <file.jh>` command that starts a stdio MCP server. Each top-level workflow in the file becomes a callable MCP tool. This lets any MCP client (Cursor, Claude Desktop, custom agents) invoke Jaiph workflows directly.

**Context**

* MCP (Model Context Protocol) uses JSON-RPC 2.0 over stdio. A server must handle `initialize`, `tools/list`, and `tools/call`.
* Jaiph already has a runtime (`src/runtime/kernel/node-workflow-runtime.ts`) that can execute workflows and capture output.
* The `@modelcontextprotocol/sdk` npm package provides a Node.js server implementation, but the protocol is simple enough to implement directly (\~200 lines for stdio JSON-RPC + the three methods).

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
2. **Tool listing**: read the parsed module's `workflows` array. Each workflow becomes a tool entry with `name` \= workflow name, `description` \= `"workflow <name> from <filename>"`, `inputSchema` \= single `input` string.
3. **Tool execution**: on `tools/call`, run the named workflow using the existing runtime. Capture all output (logs, prompt results). Return as `content: [{ type: "text", text: output }]`.
4. **Error handling**: if the workflow fails, return `isError: true` with the error message.
5. **Config inheritance**: the `.jh` file's `config { ... }` block applies normally (backend, model, etc.).
6. **E2E test**: a test that starts `jaiph serve` with a simple workflow, sends JSON-RPC messages via stdin, and verifies the tool list and a tool call response.
7. **Docs**: add a section to `docs/index.html` and `docs/jaiph-skill.md` about MCP server mode.

**Acceptance criteria**

* `jaiph serve examples/greeting.jh` starts a stdio MCP server.
* `tools/list` returns one tool per workflow.
* `tools/call` executes the workflow and returns its output.
* Errors produce `isError: true` responses (no server crash).
* E2E test passes.

***
