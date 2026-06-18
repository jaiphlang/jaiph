# Jaiph Improvement Queue (Hard Rewrite Track)

Process rules:

1. Tasks are executed top-to-bottom.
2. The first `##` section is always the current task.
3. Task that is ready for implementation is marked with `#dev-ready` at the end of the header.
4. When a task is completed, remove that section entirely.
5. Every task must be standalone: no hidden assumptions, no "read prior task" dependency.
6. This queue assumes **hard rewrite semantics**:
   * breaking changes are allowed,
   * backward compatibility is **not** a design goal unless a task explicitly says otherwise.
7. **Acceptance criteria are non-negotiable.** A task is not done until every acceptance bullet is verified by a test that fails when the contract is violated. "It works on my machine" or "the existing tests pass" is not acceptance.

***

## Fail fast on missing agent credentials, keyed to the backend(s) the workflow uses #dev-ready

### Context

A `prompt` step reaches an LLM through one of three backends, resolved from `agent.backend` (config) / `JAIPH_AGENT_BACKEND`, default `cursor` — see `resolveConfig` in `src/runtime/kernel/prompt.ts:53-67`. Each backend needs a different credential:

| backend | accepted credential(s) | host login alternative |
|---------|------------------------|------------------------|
| `claude` | `ANTHROPIC_API_KEY` **or** `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) | interactive `claude` login (stored in `~/.claude` or macOS Keychain) |
| `cursor` | `CURSOR_API_KEY` | interactive `cursor-agent login` |
| `codex` | `OPENAI_API_KEY` (read as `codexApiKey`, `prompt.ts:63`) | none — pure HTTP API |

Today the only credential check is **codex**, and it happens **at runtime inside the prompt** (`runCodexBackend`, `prompt.ts:253-259`): the workflow spins up, runs steps, and only fails when it hits the first `prompt`. There is no check for `claude`/`cursor`, and no check names the `.jh` file / config location that selected the backend. In a Docker sandbox this is worse: interactive CLI login does **not** cross the container boundary (fresh `$HOME`, no Keychain), so only the env-var credentials work — yet nothing tells the user that up front.

This task adds a **pre-flight** credential check on the host, before the workflow runner / container launches, that fails fast (or warns) with a message naming the backend, the model (if set), and **the `.jh` file + config scope where that backend/model is configured**.

### Behavior

1. **Where:** a host-side pre-flight in `runWorkflow` (`src/cli/commands/run.ts`), after the module graph + effective config + `runtimeEnv` are resolved and after the Docker mode is known, but **before** spawning the runner or the container. Not in `--raw` (that's the inner/embedded path).
2. **Which backends to check — scan the entry file's config:** collect the distinct backend(s) declared in the **entry `.jh` file's** module-level `config` block and each of its **workflow-level** `config` blocks (the metadata already on `graph.modules.get(inputAbs).ast`), plus the effective default backend from `runtimeEnv`/`JAIPH_AGENT_BACKEND`. For each distinct backend, run its credential check. (Deeper per-import-module backend overrides resolved at runtime are a known limitation — `log`/note it, do not attempt full reachability analysis.)
3. **Credential rule per backend** (checked against the env that will actually reach the agent — `runtimeEnv` on host, or the **forwarded allowlisted** env when Docker is on, via `isEnvAllowed`):
   - `codex`: `OPENAI_API_KEY` required → **hard error** always (no login path).
   - `claude`: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` →
     - **Docker on (any mode incl. inplace):** hard error if neither is present (CLI login can't cross the boundary).
     - **Host run:** if neither is present, **warn** (a logged-in CLI may still work) — do not block.
   - `cursor`: `CURSOR_API_KEY` → same host/Docker split as `claude` (Docker → hard error; host → warn).
4. **Message content (required):** every error/warning names (a) the backend, (b) the model if explicitly set, (c) the **source `.jh` file** and the config scope that set it — module-level vs `workflow <name>` — and (d) the concrete remedy (which env var to set, e.g. "run `claude setup-token` and export `CLAUDE_CODE_OAUTH_TOKEN`, or set `ANTHROPIC_API_KEY`"; for Docker, note the var must be set on the host so it is forwarded). Reporting the exact line number is a should-have (needs source-location tracking through the metadata parser); file + scope is the must-have.
5. **Error code / exit:** hard failures use a stable code (e.g. `E_AGENT_CREDENTIALS`) and a non-zero exit with **no** runner/container launched. Replace the late codex-only check's role for the pre-flightable cases (keep the in-`runCodexBackend` guard as defense-in-depth, but the pre-flight should catch it first with the better message).

### Out of scope

- Mounting `~/.claude` / `CLAUDE_CONFIG_DIR` into the container (separate optional inplace-convenience idea).
- Validating that a credential is *correct* (no network probe) — only presence.
- Full import-graph reachability of which backend each reachable `prompt` actually uses (entry-file scan is the contract; note the limitation).

### Acceptance criteria (each verified by a test that fails when violated)

- A workflow whose entry file sets `agent.backend = "claude"` and run with Docker enabled and **neither** `ANTHROPIC_API_KEY` nor `CLAUDE_CODE_OAUTH_TOKEN` in the forwarded env fails before launch with `E_AGENT_CREDENTIALS`, non-zero exit, no container spawned.
- The same workflow on a **host** run (Docker off) with no claude credential **warns** but proceeds (does not exit non-zero) — proving the login-friendly host path.
- `agent.backend = "cursor"` with no `CURSOR_API_KEY` under Docker → hard error; on host → warning. `agent.backend = "codex"` with no `OPENAI_API_KEY` → hard error on both host and Docker.
- The error/warning message contains: the backend name, the model string when `agent.default_model` is set, and the **entry `.jh` file path** plus the config scope (`module config` or `workflow <name>`) that selected the backend. Assert each substring.
- When credentials are present, the pre-flight is silent and the run proceeds (no false positives) — including when only one of claude's two accepted vars is set.
- A workflow with **no `prompt` step / no agent backend configured beyond the default** and `cursor` default on host does not hard-fail solely due to a missing key (host warn-only contract holds).
- The pre-flight runs for all Docker modes including `inplace`, and checks the post-forwarding env (a credential present on the host but stripped by `isEnvAllowed` would still be treated as missing inside the container — assert with a non-allowlisted var name).
