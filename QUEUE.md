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

## Docker — strict image contract + publish official `jaiph-runtime` images to GHCR #dev-ready

**Goal**
Remove all Docker runtime bootstrapping/fallback magic. In Docker mode, **every selected image must already contain a working `jaiph` CLI**. Jaiph must **not** build a thin derived image at runtime and must **not** auto-install itself into arbitrary base images. (Today the host uses `npm pack` + `docker build` to install the local package into a derived image; there is no bind-mount of host `dist/`, but that derived-image install path is equally forbidden.) The product contract becomes explicit: if Docker is on, the image is responsible for containing Jaiph.

Publish an official Jaiph runtime image to **GHCR** and make it the default Docker image:

* tagged releases → `ghcr.io/jaiphlang/jaiph-runtime:<version>`
* nightly builds → `ghcr.io/jaiphlang/jaiph-runtime:nightly`
* default `runtime.docker_image` / env default should point at that official image

Convenience fallback to `node:20-bookworm` + runtime bootstrap is **not** desired.

**Required product decision**

1. **Strict requirement** — all Docker images used by Jaiph must already have `jaiph`.
2. **Official default image** — Jaiph publishes and uses `ghcr.io/jaiphlang/jaiph-runtime`.
3. **No hidden runtime mutation** — no auto-derived image build, no `npm install -g` of Jaiph during Docker run startup.
4. **Fast fail** — if the chosen image lacks `jaiph`, Jaiph must fail clearly with an explicit Docker/runtime error.

**Why this task exists**

The codebase currently mixes a generic contract (`jaiph run --raw` inside the container) with a convenience path (stock images without `jaiph`). Both cannot be true without bootstrapping. This task chooses the strict model and removes the second.

**Critical implementation detail (from current `src/runtime/docker.ts`)**

When `imageExplicit === false`, `resolveImage` currently ends in `ensureLocalRuntimeImage`, which **always** targets a derived `jaiph-runtime-auto:*` tag built via `npm pack`, even if the base image already contains `jaiph`. After switching the default to the official GHCR image (or any image that already has `jaiph`), the runtime must **use that image as-is** when `command -v jaiph` succeeds — no auto-derivation. If `jaiph` is missing, fail fast (no fallback build).

**Resolved defaults (no longer open)**

* **Default tag rule**: Release npm builds embed `ghcr.io/jaiphlang/jaiph-runtime:<semver>` matching the package/`jaiph` version. Main/nightly CI artifacts and docs for contributors use the `:nightly` tag; state the rule explicitly in docs.
* **Cursor / Claude CLIs in the official image**: **Exclude by default** from the minimal `jaiph-runtime` image to keep size and supply chain small; document how to extend a custom image (the managed `.jaiph/Dockerfile` template may remain a fuller example).

**Queue coordination**

Ship published GHCR images before or together with the later queued task “Runtime — default Docker when not CI or unsafe”, which will expect a pullable default image for local users.

**Context**

* Docker runtime: `src/runtime/docker.ts`
* Docker run path: `src/cli/commands/run.ts`
* Docs: `docs/sandboxing.md`, `docs/configuration.md`, `docs/cli.md`
* E2E: `e2e/tests/72_docker_run_artifacts.sh`, `e2e/tests/73_docker_dockerfile_detection.sh`, `e2e/tests/74_docker_lifecycle.sh`
* Managed Dockerfile: `.jaiph/Dockerfile`, `src/cli/commands/init.ts`
* CI: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/nightly-engineer.yml`

**Implementation requirements**

1. **Runtime** — Remove `ensureLocalRuntimeImage` / `buildRuntimeImageFromLocalPackage` / auto-derivation paths. Keep container entry `jaiph run --raw ...`. Preflight: after pull, verify `jaiph` exists in the selected image; if not, error with guidance to use `ghcr.io/jaiphlang/jaiph-runtime` or install Jaiph in a custom image. Preflight is by capability check, not by image name whitelist.
2. **Default image** — Default becomes the official GHCR runtime image (not `node:20-bookworm`).
3. **Publishing** — CI/release builds and pushes `ghcr.io/jaiphlang/jaiph-runtime` for release tags and `nightly`. Image includes Node.js, `jaiph`, `fuse-overlayfs` (and other sandbox prereqs per `.jaiph/Dockerfile`), and non-root user if that remains the contract.
4. **Docs** — Rewrite Docker sections for the strict contract; remove language about auto-derived images and stock bases “just working.”
5. **Tests** — Update E2E for strict contract; add/keep regression that an image without `jaiph` fails with a clear error.

**Scope note**

Expect changes across more than three files (runtime, CI workflows, init scaffolding, docs, E2E, unit tests). Prefer plain functions and small helpers; `docker.ts` is already large—avoid speculative abstractions.

**Acceptance criteria**

* Default Docker image is `ghcr.io/jaiphlang/jaiph-runtime:*`, not `node:20-bookworm`.
* Jaiph never auto-builds a derived runtime image at Docker run time.
* Jaiph never injects Jaiph into the container except by using an image that already contains it (no `npm pack` bootstrap).
* A custom image without `jaiph` fails fast with a clear actionable error.
* Official GHCR runtime images are published for release tags and `nightly`.
* Docs describe the strict contract and official image flow without ambiguity.
* Unit + E2E coverage prevents regression to bootstrap behavior.

## Support optional config properties in Jaiph DSL: version, name, description. #dev-ready

**Goal**

Add optional module-scoped manifest fields in the module-level `config { }` block so a `.jh` file can declare human-readable **name**, **version**, and **description** without changing agent/run/runtime execution.

**Keys (dot-separated, string values)**

- `module.name`
- `module.version`
- `module.description`

All optional; omitted keys leave the corresponding field unset.

**Semantics**

- Values use the same double-quoted string rules as other config strings (existing escapes). No semver validation in v1 unless a later task adds it.
- **Module-level only:** `module.*` keys must not appear in workflow-level `config { }` blocks. After parsing, reject workflow-level config that sets any `module.*` key, using the same pattern as the existing `runtime.*` workflow guard in `src/parse/workflows.ts`.
- Stored on `WorkflowMetadata` as descriptive metadata only. They do **not** map into `JaiphConfig`, environment resolution, or the Node workflow runtime unless a future task wires them (e.g. MCP tool metadata).

**Implementation touchpoints**

- `src/parse/metadata.ts` — `ALLOWED_KEYS`, `KEY_TYPES`, `assignConfigKey`.
- `src/types.ts` — optional `module?: { name?: string; version?: string; description?: string }` on `WorkflowMetadata`.
- `src/format/emit.ts` — formatter round-trip for the new keys.
- `src/parse/workflows.ts` — workflow-level rejection for `module.*` (mirror `metadata.runtime`).
- Tests: `src/parse/parse-metadata.test.ts`; update parse-error golden/txtar cases if the unknown-key allowed-list appears in expectations.
- Docs: `docs/configuration.md`, `docs/grammar.md` (`config_key`).

**Non-goals**

- Environment variables, CLI output, or runtime behavior changes beyond parsing/formatting/validation.

**Queue coordination**

- No conflict with the queued `jaiph serve` MCP task; future work may read `module.description` for tool listings.

**Acceptance criteria**

- Module-level `config` accepts `module.name`, `module.version`, and `module.description`; values round-trip through `jaiph format`.
- Workflow-level `config` containing any `module.*` assignment fails with an explicit error (consistent with `runtime.*` workflow rules).
- Unit tests cover happy path and workflow rejection; docs and grammar list the keys.

**Scope note**

- Expect more than three files (parser, types, formatter, workflows guard, tests, docs); keep the existing plain `assignConfigKey` style — no new abstraction layers.

## Runtime — harden Docker execution environment #dev-ready

**Goal**
Docker mode is the isolation boundary for workflow runs. Harden it: least-privilege mounts, explicit and documented env forwarding (what crosses the container boundary), network defaults, and failure modes when Docker is misconfigured or unavailable — so "Docker on" is a deliberate security posture, not accidental leakage. (Image provenance and the official default image belong to the queued **Docker — strict image contract + GHCR** task; this task only documents or tightens runtime-visible pull/verify behavior as needed, without redefining publishing or the default image.)

**Context**

* Docker runtime: `src/runtime/docker.ts` (`parseMounts` / `validateMounts`, `resolveDockerConfig`, `buildDockerArgs`, `checkDockerAvailable`, `spawnDockerProcess`); CLI integration: `src/cli/commands/run.ts`.
* Current forwarding: `buildDockerArgs` remaps `JAIPH_WORKSPACE` and `JAIPH_RUNS_DIR`, passes through `JAIPH_*` except `JAIPH_DOCKER_*`, and passes keys prefixed `CURSOR_`, `ANTHROPIC_`, or `CLAUDE_` (see `AGENT_ENV_PREFIXES` in `docker.ts`). Mounts come from resolved `runtime.workspace` plus fixed rw run-dir, ro overlay script, and `--device /dev/fuse`.
* E2E: `e2e/tests/72_docker_run_artifacts.sh`, `e2e/tests/73_docker_dockerfile_detection.sh`.
* Config: `runtime.docker_enabled`, `runtime.docker_image`, `runtime.docker_network`, `runtime.docker_timeout`, `runtime.workspace` via `src/config.ts` and metadata parsing.

**Queue coordination**

* Land after or together with **Docker — strict image contract + publish official `jaiph-runtime` images to GHCR** so bootstrap removal and default image changes are settled before deep hardening refactors the same code paths.
* Land after or together with **Runtime — credential proxy for Docker mode** so any env allowlist/denylist and `docs/sandboxing.md` text stay consistent with placeholder `ANTHROPIC_*` and host-reachable API base URLs (no real secrets in `-e`).
* The later task **Runtime — default Docker when not CI or unsafe** changes `runtime.docker_enabled` defaults; avoid conflicting precedence — document how hardened Docker behavior interacts with that default once both exist.

**Acceptance criteria**

* Threat-model notes (short section in `docs/sandboxing.md` or equivalent): what Docker is / is not protecting against (including that hooks run on the host).
* Concrete hardening changes in `docker.ts` / run path (e.g. mount validation, env allowlist or documented denylist aligned with the credential-proxy contract, safer defaults) with unit tests.
* No silent widen of host access without opt-in.
* Document network mode behavior (`runtime.docker_network` / `--network`) and failure modes for missing Docker or failed pulls (`E_DOCKER_*`), extending existing patterns where appropriate.

**Scope note**

* `docker.ts` is already large (~650+ lines); prefer small helpers or one focused sibling module over speculative abstractions. Expect at least `docker.ts`, `docker.test.ts`, and `docs/sandboxing.md`; split follow-ups if the change set outgrows one cycle.

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

* Target **~3 files**: one small new module for the proxy plus focused edits in `docker.ts` and `run.ts`. Plain functions, no new abstraction layers.

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
