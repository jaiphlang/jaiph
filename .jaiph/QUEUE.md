# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## Change display of log messages <!-- dev-ready -->

Currently it is:

```
  ▸ rule task_is_dev_ready (1="## Rework channel semantics: cha...")
  ✓ 0s
  ▸ workflow implement_poc (1="## Rework channel semantics: cha...", 2="pragmatic")
  ·   ▸ prompt "$role <task>" (role="<role> You are a pragmatic engin...", task="## Rework channel semantics: cha...")
  ·   ✓ 1310s
  ·   log saving impl_pragmatic.patch
  ·   log saving impl_notes_pragmatic.md
```

Instead I'd like to have utf info: ℹ (still gray, as `log`):

```
  ▸ rule task_is_dev_ready (1="## Rework channel semantics: cha...")
  ✓ 0s
  ▸ workflow implement_poc (1="## Rework channel semantics: cha...", 2="pragmatic")
  ·   ▸ prompt "$role <task>" (role="<role> You are a pragmatic engin...", task="## Rework channel semantics: cha...")
  ·   ✓ 1310s
  ·   ℹ saving impl_pragmatic.patch
  ·   ℹ saving impl_notes_pragmatic.md
```

---

## Bug: When Jaiph is executed in docker, nothing is saved in local .jaiph/runs directory

**Needs work — questions/concerns before development:**

1. **Root cause identified but not documented in the task.** `buildDockerArgs()` in `docker.ts:282-287` forwards all `JAIPH_*` env vars into the container, including `JAIPH_WORKSPACE` (set to the host path at `run.ts:185`). Inside the container the workspace is mounted at `/jaiph/workspace`, but `jaiph::workspace_root()` in `steps.sh:19` returns the stale host path. Runs are therefore created under a non-existent host path on the container's ephemeral filesystem and are lost on `--rm`. Similarly, `JAIPH_RUNS_DIR` if set as an absolute host path will resolve to the wrong location. The fix should override `JAIPH_WORKSPACE=/jaiph/workspace` inside the container (and remap `JAIPH_RUNS_DIR` if it's an absolute host path). **Please confirm this root cause and include it in the task description so the developer knows exactly what to fix.**

2. **Acceptance criteria are ambiguous and present two unrelated options.** "Write a Bash test that enforces jaiph in Docker" — what does "enforces" mean? A test that runs a workflow in Docker mode and asserts run artifacts exist on the host? And "Create a CI that uses Docker for all tests" is a completely different (and much larger) scope than fixing the env-var bug. **Pick one AC and make it specific.** Suggested AC: An E2E test that runs a workflow with `JAIPH_DOCKER_ENABLED=true`, then asserts that `.jaiph/runs/` on the host contains the expected artifact files (`.out`, `run_summary.jsonl`).

3. **CI scope concern.** "Create a CI that uses Docker for all tests with no changing the output" would require Docker-in-Docker on GitHub Actions runners and would change the entire CI strategy. This is a separate initiative from the bug fix and should be a separate queue item if desired. **Recommend splitting: this task fixes the env-var bug + adds one Docker E2E test; a separate task addresses Docker-based CI.**

4. **E2E test feasibility.** The existing E2E suite runs on `ubuntu-latest` and `macos-latest` GitHub Actions runners. Docker is available on `ubuntu-latest` but not on macOS runners. A Docker E2E test would need to be gated on Docker availability or only run in the `ubuntu-latest` matrix. **Clarify whether the Docker E2E test should be CI-only (Linux) or also run locally on macOS.**

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

## Explore removing Node.js runtime dependency from Jaiph stdlib

**Goal.** Investigate whether the Jaiph bash runtime's dependency on Node.js (currently `jaiph::stream_json_to_text` in `prompt.sh:19` shells out to `node -e` for JSON stream parsing) can be replaced with a pure-bash or lightweight alternative (e.g. `jq`). This would simplify the Docker image and reduce the runtime footprint.

**Scope.** Research only — identify all `node` usages in the runtime bash code, evaluate alternatives, and document findings with a recommendation. If removal is feasible, write up an implementation plan. If Node.js is the most practical choice, document why and close the ticket.
