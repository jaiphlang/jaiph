# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Bug: When Jaiph is executed in docker, nothing is saved in local .jaiph/runs directory<!-- dev-ready -->

**Status:** clarified after code investigation.

**Root cause (confirmed).**

- `run.ts` sets `JAIPH_WORKSPACE` to the host workspace path.
- `buildDockerArgs()` forwards all `JAIPH_*` values unchanged into the container.
- In Docker mode, the workspace is mounted at `/jaiph/workspace`, but `steps.sh` prefers `JAIPH_WORKSPACE` when computing run paths.
- Result: run artifacts are written to a host-only absolute path inside the container filesystem and are lost on `docker run --rm`.
- Same class of bug exists for absolute `JAIPH_RUNS_DIR` values (they are treated as-is in `steps.sh`).

**Goal.** Make Docker runs persist artifacts on the host exactly like non-Docker runs.

**Scope.**

- In Docker mode, force `JAIPH_WORKSPACE=/jaiph/workspace` inside the container (do not forward the host absolute path).
- In Docker mode, if `JAIPH_RUNS_DIR` is absolute and points inside host workspace, remap it to the equivalent container path under `/jaiph/workspace`.
- In Docker mode, if `JAIPH_RUNS_DIR` is absolute and outside host workspace, fail fast with a clear configuration error (unsupported in container path mapping).
- Keep non-Docker behavior unchanged.

**Acceptance criteria.**

- With `JAIPH_DOCKER_ENABLED=true` and default logs dir, a run writes artifacts to host `<workspace>/.jaiph/runs/...` (`run_summary.jsonl` + at least one `*.out`).
- With `JAIPH_DOCKER_ENABLED=true` and relative `JAIPH_RUNS_DIR` (for example `runs_out`), artifacts are written under host `<workspace>/runs_out/...`.
- With `JAIPH_DOCKER_ENABLED=true` and absolute `JAIPH_RUNS_DIR` under host workspace, artifacts are written to that host absolute path (via remap).
- With `JAIPH_DOCKER_ENABLED=true` and absolute `JAIPH_RUNS_DIR` outside host workspace, command exits non-zero and prints a clear error about unsupported absolute path mapping.
- Add one Docker E2E test covering the happy path artifact persistence. Gate it on Docker availability so local macOS runs can skip when Docker is unavailable.

**Out of scope (separate task).** Migrating all CI jobs to Docker-based execution.

---

## Provide and use by default a Dockerfile with installed Claude and Cursor agent<!-- dev-ready -->

**Goal.** Add a `.jaiph/Dockerfile` that ships a ready-to-use runtime image with both agent backends pre-installed, and modify `docker.ts` so the runtime auto-builds from that Dockerfile when present.

**Dockerfile (`.jaiph/Dockerfile`):**

- Base image: `ubuntu:latest`
- Install Node.js latest LTS (required by `jaiph::stream_json_to_text` in `prompt.sh` which shells out to `node -e`)
- Install Claude Code CLI (latest): `npm install -g @anthropic-ai/claude-code`
- Install `cursor-agent` (latest) — determine the correct installation method (npm package or binary download)
- Standard utilities: bash, curl, git, ca-certificates

**Runtime changes (`src/runtime/docker.ts`):**

- Image resolution logic change: when no explicit `docker_image` is configured (`JAIPH_DOCKER_IMAGE` env or in-file `dockerImage`), check if `.jaiph/Dockerfile` exists in the workspace root. If it does, `docker build` from it and tag as `jaiph-runtime:latest`, then use that image. If `.jaiph/Dockerfile` does not exist, fall back to current default (`ubuntu:24.04`).
- Env var forwarding: extend `buildDockerArgs()` (currently lines 282-287, forwards only `JAIPH_*`) to also forward agent-related env vars from the local environment: `ANTHROPIC_API_KEY`, `CURSOR_*` patterns. These are required for `claude` and `cursor-agent` authentication inside the container.
- Document the Dockerfile detection and image-build behavior (update relevant docs).

**Acceptance criteria.**

- Running `jaiph run` with `docker_enabled=true` and no explicit `docker_image`, with a `.jaiph/Dockerfile` present, builds and uses the custom image.
- `claude --version` and `cursor-agent --version` succeed inside the built container.
- `ANTHROPIC_API_KEY` and `CURSOR_*` env vars are forwarded into the container.
- Without `.jaiph/Dockerfile`, the runtime falls back to `ubuntu:24.04`.
- E2E tests cover the Dockerfile detection, image build, and env var forwarding paths.

---

## Explore removing Node.js runtime dependency from Jaiph stdlib <!-- dev-ready -->

**Goal.** Investigate whether the Jaiph bash runtime's dependency on Node.js (currently `jaiph::stream_json_to_text` in `prompt.sh:19` shells out to `node -e` for JSON stream parsing) can be replaced with a pure-bash or lightweight alternative (e.g. `jq`). This would simplify the Docker image and reduce the runtime footprint.

**Scope.** Research only — identify all `node` usages in the runtime bash code, evaluate alternatives, and document findings with a recommendation. If removal is feasible, write up an implementation plan. If Node.js is the most practical choice, document why and close the ticket.

---

## Make step outputs persist live to artifact files (tee for all step kinds)<!-- dev-ready -->

**Goal.** Ensure every step writes to its `.jaiph/runs/.../*.out`/`*.err` files incrementally while it executes (not only at step end), so logs are always tail-able in real time.

**Scope.**

- Update runtime step execution (`src/runtime/steps.sh`) so non-prompt steps also stream output live to artifact files (prompt already uses `tee`).
- Preserve existing semantics for step status, `run_summary.jsonl`, and event emission (`STEP_START`/`STEP_END`).
- Avoid double-printing in normal run output and keep test-mode behavior stable.
- Keep file writes bounded and efficient (no per-byte shell loops; use process-level redirection/`tee` patterns).

**Acceptance criteria.**

- During execution of a long-running non-prompt step, the corresponding `.out` and/or `.err` file grows before step completion.
- Existing tests for prompt output and run artifacts continue to pass.
- Add/extend tests (unit/e2e) proving live file growth behavior for at least one non-prompt step.
- No regression in final PASS/FAIL reporting and step timing output.

---

## TTY live pane: show last 10 lines of active run output under RUNNING <!-- dev-ready -->

**Goal.** In interactive TTY mode, display an ephemeral live pane under the `RUNNING workflow ...` status line that shows the latest ~10 lines from active step output; remove this pane when workflow finishes.

**Scope.**

- TTY-only rendering in CLI run path (`src/cli/commands/run.ts`), without changing non-TTY output format.
- Show an empty spacer line plus 10 tail lines, refreshed live and cursor-safe.
- Source lines from active run output in a way that avoids heavy polling and avoids re-reading entire files repeatedly.
- Keep existing tree/progress flow intact: step start/end lines, logs, and final PASS/FAIL summary remain readable and stable.
- Add guardrails for performance (bounded buffer, throttled redraw cadence, ANSI/control-char handling).

**Acceptance criteria.**

- While workflow is running in a PTY/TTY, the live pane appears below `RUNNING` and updates with recent output.
- Pane is cleared/removed before final PASS/FAIL line is shown.
- Non-TTY runs are unchanged.
- PTY/e2e tests are added or updated to verify pane lifecycle (appears during run, absent at completion) and no regressions in existing progress-tree behavior.
