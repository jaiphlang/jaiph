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

## Docker — strict image contract + publish official `jaiph-runtime` images to GHCR

**Goal**
Remove all Docker runtime bootstrapping/fallback magic. In Docker mode, **every selected image must already contain a working `jaiph` CLI**. Jaiph must **not** build a thin derived image at runtime, must **not** mount host `dist/` into the container, and must **not** auto-install itself into arbitrary base images. The product contract becomes explicit: if Docker is on, the image is responsible for containing Jaiph.

At the same time, publish an official Jaiph runtime image to **GHCR** and make it the default Docker image:

* tagged releases → `ghcr.io/jaiphlang/jaiph-runtime:<version>`
* nightly builds → `ghcr.io/jaiphlang/jaiph-runtime:nightly`
* default runtime image in Jaiph config/runtime should point at that official image

This is a deliberate contract change. Convenience fallback to `node:20-bookworm` + runtime bootstrap is **not** desired.

**Required product decision**

1. **Strict requirement** — all Docker images used by Jaiph must already have `jaiph`.
2. **Official default image** — Jaiph publishes and uses `ghcr.io/jaiphlang/jaiph-runtime`.
3. **No hidden runtime mutation** — no auto-derived image build, no host `dist/` mount hack, no `npm install -g` during Docker run startup.
4. **Fast fail** — if the chosen image lacks `jaiph`, Jaiph must fail clearly with an explicit Docker/runtime error.

**Why this task exists**

The current codebase has tension between two incompatible models:

* generic Docker contract: run `jaiph run --raw` inside the container
* convenience contract: allow stock images that do not contain `jaiph`

Both cannot be true without runtime bootstrapping. This task intentionally chooses the first model and removes the second.

**Context**

* Docker runtime implementation: `src/runtime/docker.ts`
* Docker run path / spawn site: `src/cli/commands/run.ts`
* Docker docs: `docs/sandboxing.md`, `docs/configuration.md`, `docs/cli.md`
* Current Docker E2E coverage: `e2e/tests/72_docker_run_artifacts.sh`, `e2e/tests/73_docker_dockerfile_detection.sh`, `e2e/tests/74_docker_lifecycle.sh`
* Managed project Dockerfile template: `.jaiph/Dockerfile`, plus `jaiph init` scaffolding in `src/cli/commands/init.ts`
* CI/release workflows: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/nightly-engineer.yml`

**Implementation requirements**

1. **Runtime**
   * Remove Docker fallback logic that auto-builds a derived image or auto-installs Jaiph into arbitrary base images.
   * Keep the container entry generic: `jaiph run --raw ...`
   * Add an explicit preflight/validation step for Docker images:
     * either the selected image is the official `ghcr.io/jaiphlang/jaiph-runtime:*`,
     * or a custom image that already contains `jaiph`.
   * If `jaiph` is missing in the chosen image, fail with a clear error message that tells the user to:
     * use the official GHCR image, or
     * install Jaiph in their custom image.

2. **Default image**
   * Change the default Docker image away from `node:20-bookworm`.
   * Default must become the official GHCR runtime image.
   * Decide whether the default tag should be version-pinned at release time and `nightly` on main/nightly builds; document the exact rule.

3. **Publishing**
   * Add CI/release automation to build and publish `ghcr.io/jaiphlang/jaiph-runtime`.
   * Publish at least:
     * per-tag release images
     * `nightly`
   * Ensure the published image contains:
     * `jaiph`
     * Node.js
     * `fuse-overlayfs` / Docker runtime prerequisites
     * non-root runtime user if that remains part of the sandbox contract
   * Decide whether Cursor / Claude CLIs belong in the official runtime image by default; document the decision explicitly.

4. **Docs**
   * Rewrite Docker docs to state the strict image contract clearly.
   * Document the official GHCR image as the default and recommended path.
   * Document how custom images must install `jaiph`.
   * Remove any wording that implies Jaiph will make arbitrary base images work automatically.

5. **Tests**
   * Update E2E/tests so they assert the strict contract, not the bootstrap fallback.
   * In particular, tests that currently expect `node:20-bookworm` to work without Jaiph must be rewritten.
   * Add/keep a regression test that proves Docker fails clearly when the selected image lacks `jaiph`.

**Acceptance criteria**

* Default Docker image is `ghcr.io/jaiphlang/jaiph-runtime:*`, not `node:20-bookworm`.
* Jaiph never auto-builds a derived runtime image at Docker run time.
* Jaiph never mounts host build output into the container to provide `jaiph`.
* A custom image without `jaiph` fails fast with a clear actionable error.
* Official GHCR runtime images are published for release tags and `nightly`.
* Docs describe the strict contract and official image flow without ambiguity.
* Unit + E2E coverage prevents regression back to runtime bootstrap behavior.

***

## Support optional config properties in Jaiph DSL: version, name, description.

## Runtime — credential proxy for Docker mode

**Goal**
Containers should never hold real API keys. Implement a host-side HTTP proxy (the "Phantom Token" pattern) that intercepts outbound API requests from containers, strips a placeholder credential, and injects the real key before forwarding upstream. The agent inside the container literally cannot leak the real key — it never has it.

**Design**

1. **Host-side proxy** — a lightweight `http.createServer` bound to `127.0.0.1:<port>` (macOS/WSL2) or the `docker0` bridge IP (Linux). Receives requests from the container, swaps `x-api-key: placeholder` with the real key from host env, forwards to the upstream API, pipes the response back (including streaming SSE).
2. **Container env injection** — instead of passing `ANTHROPIC_API_KEY=$real_key` into `docker run`, pass `ANTHROPIC_API_KEY=placeholder` + `ANTHROPIC_BASE_URL=http://host.docker.internal:<port>`.
3. **Multi-backend routing** — Jaiph supports Claude and Cursor backends. Each backend's CLI must respect a base URL override env var. `claude` CLI supports `ANTHROPIC_BASE_URL`; `cursor-agent` may not — needs investigation.
4. **Lifecycle** — proxy starts before the first Docker container launch, shuts down after the last container exits or on Jaiph process exit.

**Context**

* Pattern reference: [NanoClaw's credential proxy](https://jonno.nz/posts/nanoclaw-architecture-masterclass-in-doing-less/) — same approach, independently arrived at.
* Current Docker execution path: `src/runtime/kernel/` — Docker run/exec logic, env var forwarding.
* Dockerfile: `.jaiph/Dockerfile` — container image setup.
* Backend CLI invocation: `src/runtime/kernel/node-workflow-runtime.ts` — where `claude` / `cursor-agent` commands are constructed with env vars.

**Open questions**

* Does `cursor-agent` support a base URL override? If not, the proxy pattern may require a wrapper script or LD\_PRELOAD-based interception inside the container.
* Single port with path-based routing vs one port per backend?
* Should the proxy also enforce rate limits or audit-log API calls?

**Acceptance criteria**

* Host-side proxy starts automatically when Docker mode is active.
* Containers receive only placeholder credentials — no real API keys in container env.
* `claude` CLI calls from inside Docker succeed via the proxy.
* Proxy handles streaming responses (SSE) correctly.
* Real keys never appear in container logs, env dumps, or process listings.
* Platform-specific host address resolution works (macOS, Linux).

***

## Runtime — harden Docker execution environment

**Goal**
Docker mode is the isolation boundary for workflow runs. Harden it: least-privilege mounts, explicit and documented env forwarding (what crosses the container boundary), network defaults, image supply chain, and failure modes when Docker is misconfigured or unavailable — so "Docker on" is a deliberate security posture, not accidental leakage.

**Context**

* Docker runtime: `src/runtime/kernel/` — look for `docker.ts` or Docker-related logic in the run path.
* E2E Docker tests: `e2e/tests/72_docker_run_artifacts.sh`, `e2e/tests/73_docker_dockerfile_detection.sh`.
* Config: `runtime.docker_enabled`, `runtime.docker_timeout`, `runtime.workspace` keys in `src/config.ts` and metadata parsing.

**Acceptance criteria**

* Threat-model notes (short section in `docs/sandboxing.md` or equivalent): what Docker is / isn't protecting against.
* Concrete hardening changes in `docker.ts` / run path (e.g. mount validation, env allowlist or documented denylist, safer defaults) with unit tests.
* No silent widen of host access without opt-in.

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