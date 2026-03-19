# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## E2E tests: make it human readable (part 2) <!-- dev-ready -->

Part of this task might be already done (see the last commit). 
I believe there are some remainders with `nullglob` 
and `expected_prompt_out=$(printf '%s\n%s\n\n%s\n%s\n\n%s\n%s' \` patterns. 
They should be aligned to match the style of already implemented tests.

The agent implementing that left some comments (tradeoffs):
- Tests that use custom run dirs (`70_run_artifacts.sh` with `JAIPH_RUNS_DIR`, `85_infile_metadata.sh` with config-defined `run.logs_dir`) keep manual assertions for the custom dir — `e2e::run_dir` only searches `.jaiph/runs/`
- Tests that run `jaiph test` (native test framework) can't use `e2e::run` and keep raw `jaiph test` calls
- Tests with dynamic content in .out files (prompt .out files containing `${TEST_DIR}`) use manual assertions or non-heredoc `e2e::expect_file` where the pattern might match multiple files

But we want to make it better as well. We want this part also be clearer for
human -- more intent, less noise. And we want to compare all files from jaiph 
runs directory, not only for prompts, and for all e2e tests that run workflows
(better safe than sorry). To compare files we could have a helper on bash arrays,
something similar to:

```
e2e::expect_jaiph_run_files (
    "file 1 content"
    "file 2 content"
    ...
)
```

This way we can do meaningful (exact / total) comparison with no guessing of file names. We can change Jaiph naming of run files to ensure they are monotonous, or even make them predictable:

```
.jaiph/runs/2026-03-19/21-02-50-agent-inbox.jh
  inbox
    .queue
    .seq
    000001-findings.txt
  steps
    000001-agent_inbox__reviewer.out
```

And compare individual file:

```
e2e::expect_jaiph_out_file "steps/000001-agent_inbox__reviewer.out" '
the whole
content
'
```

(or EOF syntax)

So, we can consider if this syntax is more natural for human reading:

Instead of:

```
e2e::expect_stdout "${prompt_vars_out}" <<'EOF'

Jaiph: Running prompt_with_vars.jh

workflow default
  ▸ prompt "$role does $task" (role="engineer", task="Fix bugs")
  ✓ <time>
✓ PASS workflow default (<time>)
EOF
```

Do:

```e2e::expect_stdout "${prompt_vars_out}" '

Jaiph: Running prompt_with_vars.jh

workflow default
  ▸ prompt "$role does $task" (role="engineer", task="Fix bugs")
  ✓ <time>
✓ PASS workflow default (<time>)'
```

On one hand it feels more natural, on the other hand there are escaping issues.
But I think it might be worth considering to switch for such helpers (everywhere,
and keep it consistent, support only one version).


---

## Fix: Line breaks in prompt parameters should be removed and unify parameters display everywhere

Bug sample (last line):
```
➜  jaiph git:(nightly) CI=true .jaiph/engineer.jh pragmatic

Jaiph: Running engineer.jh

workflow default (pragmatic)
  ▸ function get_first_task
  ·   ▸ function get_all_task_headers
  ·   ✓ 0s
  ·   ▸ function get_task_by_header ("## E2E: add full .out file conte...")
  ·   ✓ 0s
  ✓ 0s
  ▸ rule task_is_dev_ready ("## E2E: add full .out file conte...")
  ✓ 0s
  ▸ workflow implement_poc ("## E2E: add full .out file conte...", pragmatic)
  ·   ▸ rule is_clean
  ·   ·   ▸ rule in_git_repo
  ·   ·   ✓ 0s
  ·   ·   ▸ rule branch_clean
  ·   ·   ✓ 0s
  ·   ✓ 0s
  ·   ▸ prompt "$role <task>" (role="<role>
  You are a pragmatic eng...", task="## E2E: add full .out file conte...")
```

Best solution is to have common utilities for normalization of parameter print.

Addionally double check prompts where some parameters are named and some are `$1` etc.

The best way is to show names everywhere like: workflow test (1="...")

---

## Bug: When Jaiph is executed in docker, nothing is saved in local .jaiph/runs directory

Acceptance criteria: Write a Bash test that enforces jaiph in Docker

OR: Create a CI that uses Docker for all tests with no changing the output.
This way we can guarantee output parity.

## Fix prompt/agent step output: no output in tree unless logged with `log`<!-- dev-ready -->

**Correct behavior.**

- **Tree:** Show no output for a prompt step. If the user writes `response = prompt "aaa"`, the tree shows only the step line and ✓ — no Command/Prompt/Reasoning/Final answer block.
- **When user uses `log`:** Output appears in the tree only when they explicitly call `log`, e.g. `response = prompt "aaa"; log "$response"`. The `log` step emits a LOG event and the CLI already displays that; no change needed for log.
- **.out files:** The step’s `.out` file in `.jaiph/runs/` continues to contain the full agent output (Command, Prompt, Reasoning, Final answer) for debugging. No change to runtime embedding — only stop displaying prompt step’s `out_content` in the tree.

**Implementation.**

1. **`run.ts`** — Remove the block that displays `out_content` for prompt steps (lines ~372–384). Do not print embedded step output for prompt steps; the tree shows nothing under them. Full transcript remains in the event and on disk; we just don’t render it in the CLI.
2. **E2E** — In `e2e/tests/20_rule_and_prompt.sh`, update expected output for prompt_flow and multiline_prompt: expect only the tree line and ✓, no "Command:", "Prompt:", "Final answer:" block.

**Acceptance criteria.**

- `response = prompt "aaa"` → tree shows prompt step line and ✓ only; no output block.
- `response = prompt "aaa"; log "$response"` → tree shows prompt line, ✓, then the log line with the response (existing LOG handling).
- Step `.out` files under `.jaiph/runs/` still contain full agent transcript (Reasoning, etc.).
- E2E tests in 20_rule_and_prompt pass with updated expectations.

---

## Inbox: Pass event channel as first parameter to the workflow, reuse existing parameter print for workflow (don't do anything custom)<!-- dev-ready -->

**Motivation.** Currently, dispatched workflows receive only the message content as `$1` and the channel name is passed via `JAIPH_DISPATCH_CHANNEL` env var. The channel is invisible to the standard parameter display system (`formatParamsForDisplay`), so it never appears in the tree output alongside workflow parameters. By passing channel as a named parameter (`channel=<name>`) the existing parameter rendering pipeline will display it automatically — no custom display logic needed.

**Implementation plan.**

1. **`inbox.sh:120`** — Change the dispatch invocation from:
   ```bash
   JAIPH_DISPATCH_CHANNEL="$channel" "$target" "$content"
   ```
   to:
   ```bash
   JAIPH_STEP_PARAM_KEYS='channel' JAIPH_DISPATCH_CHANNEL="$channel" "$target" "channel=$channel" "$content"
   ```
   This passes channel as the first named parameter. `JAIPH_DISPATCH_CHANNEL` is kept because `events.sh:167-168` uses it to tag JSONL events with `"dispatched":true` and `"channel":"…"` metadata — that tagging must remain intact.

2. **No transpiler changes needed for handler bodies.** Handler workflows are compiled functions whose parameter access is generated by `emit-workflow.ts`. The message content shifts from `$1` to `$2`, but the transpiler already controls how arguments are referenced in generated bash. If handlers currently hard-code `$1` access, update the transpiler's handler codegen to use `$2` instead. This is internal to the compiled output — not a user-facing breaking change.

3. **CLI display.** The `formatParamsForDisplay` path in `run.ts:136-141` already renders params for workflows. With `JAIPH_STEP_PARAM_KEYS='channel'` set, `jaiph::step_params_json()` in `events.sh:46-76` will emit `[["channel","<name>"]]` in the event, and the CLI will display it via the standard path. No custom dispatch display code needed.

4. **Update E2E tests.** `e2e/tests/91_inbox_dispatch.sh` uses exact stdout assertions — update expected output to include the channel parameter in the tree rendering.

**Acceptance criteria.**

- Dispatched workflow steps show channel in tree output via standard parameter display (e.g. `workflow analyst (findings)`).
- JSONL events still contain `"dispatched":true,"channel":"…"` metadata (no regression).
- `jaiph::step_params_json` emits `channel` as a named param key for dispatched steps.
- E2E test `91_inbox_dispatch` passes with updated expected output.
- No custom display code for dispatch channel in the CLI.

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
