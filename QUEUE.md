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

## CLI — `jaiph init` emits invalid `prompt` string (needs triple quotes) #dev-ready

**Goal**  
`jaiph init` must generate workflows that compile. It currently emits a multi-line `prompt` using a single `"..."` string literal with embedded newlines, which is not valid Jaiph syntax for that form. The bootstrap workflow should use a **triple-quoted** string (`""" ... """`) so the generated `.jh` file parses and compiles.

**Context**

- Observed emitted snippet (broken): `workflow default() { prompt "\n    You are bootstrapping...\n  " }` — double quotes cannot span multiple lines as emitted.
- Expected: `prompt """ ... """` (or equivalent language-supported multiline string) with the same semantic content (bootstrap guide path `.jaiph/SKILL.md`, ordered tasks 1–5, usage with `jaiph run`).

**Acceptance criteria**

- Running `jaiph init` (or the code path that materializes the default bootstrap workflow) produces compilable Jaiph source.
- Regression: test or snapshot that the init template uses triple-quoted `prompt` (or documented multiline form) and `jaiph check` / compile succeeds on the generated file.

---

## Init — `.jaiph/Dockerfile` + bootstrap prompt (Jaiph install + project sandbox) #dev-ready

**Goal**  
`jaiph init` should materialize a `.jaiph/Dockerfile` in the target repository that matches the **shape** of Jaiph’s own `.jaiph/Dockerfile` (Ubuntu base, curl/git/ca-certificates, Node LTS, agent CLIs as needed), but must install **Jaiph itself** via the default install path: `curl -fsSL https://jaiph.org/install | bash`, so Docker-mode workflows run with a proper Jaiph toolchain inside the sandbox.

Enrich the **bootstrap workflow prompt** so the agent is explicitly asked to **review and update** `.jaiph/Dockerfile` for the **current project** — that file defines the container sandbox (runtimes, package managers, build tools) and must be aligned with how this repo is built and tested.

Extend the bootstrap workflow so it **logs informational messages at the end** summarizing **what** was changed (files, key edits) and **why** (tie each change to repo structure, tests, or sandbox needs).

**Context**

- Reference Dockerfile in this repo: `.jaiph/Dockerfile` — use as a template baseline, not a blind copy; init output should swap in Jaiph install via `jaiph.org/install` and leave room for project-specific layers.
- Docker mode and image selection already point at `.jaiph/Dockerfile` in runtime docs and kernel.

**Acceptance criteria**

- Init creates or updates `.jaiph/Dockerfile` with Jaiph installed via `curl -fsSL https://jaiph.org/install | bash` (document any ordering constraints vs Node/agents).
- Bootstrap `prompt` instructs updating the Dockerfile for this repo’s sandbox needs.
- Bootstrap workflow ends with clear `log` (or equivalent) lines: what changed, why — suitable for a human scanning CI or local run output.

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
