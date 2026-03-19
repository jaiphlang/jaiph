# Jaiph Improvement Queue

Tasks are processed top-to-bottom. Each task starts with a `##` header.
When a task is completed, remove that whole section (from its `##` header until next `##` header).
The first `##` task in the file is always the current task.

---

## E2E tests: make it human readable <!-- dev-ready -->

This is a sample e2e test e2e/tests/10_basic_workflows.sh reworked to more readable way:

```
#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "basic_workflows"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Basic workflow execution"

# Given
e2e::file "hello.jh" <<'EOF'
workflow default {
  echo "hello-jh"
}
EOF

# When
hello_out="$(e2e::run "hello.jh")"

# Then
e2e::expect_stdout "${hello_out}" <<'EOF'
Jaiph: Running hello.jh

workflow default
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "hello.jh" 1
e2e::expect_out "hello.jh" "default" "hello-jh"

# Given
e2e::file "lib.jph" <<'EOF'
rule ready {
  echo "from-jph"
}
EOF

e2e::file "app.jh" <<'EOF'
import "lib.jph" as lib
workflow default {
  ensure lib.ready
  echo "mixed-ok"
}
EOF

# When
mixed_out="$(e2e::run "app.jh")"

# Then
e2e::expect_stdout "${mixed_out}" <<'EOF'
Jaiph: Running app.jh

workflow default
  ▸ rule ready
  ✓ <time>
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "app.jh" 2
e2e::expect_rule_out "app.jh" "lib.ready" "from-jph"
e2e::expect_out "app.jh" "default" "mixed-ok"

e2e::section "Git-aware rule arguments"

# Given
e2e::file "current_branch.jph" <<'EOF'
#!/usr/bin/env jaiph
rule current_branch {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Not inside a git repository." >&2
    exit 1
  fi

  if [ "$(git branch --show-current)" != "$1" ]; then
    echo "Current branch is not '$1'." >&2
    exit 1
  fi
}

workflow default {
  ensure current_branch "$1"
}
EOF

(
  cd "${TEST_DIR}"

  # Given
  e2e::git_init
  current_branch="$(e2e::git_current_branch)"

  # When
  e2e::run "current_branch.jph" "${current_branch}" >/dev/null

  # Then
  e2e::pass "current_branch.jph passes for current branch"
  e2e::expect_out_files "current_branch.jph" 0

  wrong_branch="${current_branch}-wrong"

  # When / Then
  e2e::expect_fail "current_branch.jph" "${wrong_branch}"
  e2e::pass "current_branch.jph fails for wrong branch"
)
```

You need to rework all e2e tests to follow similar pattern.

Functions that might be added to e2e/lib/common.sh:

```
e2e::file() {
  local name="$1"
  local path="${JAIPH_E2E_TEST_DIR}/${name}"
  mkdir -p "$(dirname "${path}")"
  cat > "${path}"
}

e2e::run() {
  local file="$1"
  shift || true

  jaiph build "${JAIPH_E2E_TEST_DIR}/${file}" >/dev/null
  jaiph run "${JAIPH_E2E_TEST_DIR}/${file}" "$@"
}

e2e::run_dir() {
  local file="$1"

  shopt -s nullglob
  local dirs=( "${JAIPH_E2E_TEST_DIR}/.jaiph/runs/"*/*"${file}"/ )
  shopt -u nullglob

  [[ ${#dirs[@]} -eq 1 ]] || e2e::fail "expected one run dir for ${file}, got ${#dirs[@]}"
  printf "%s" "${dirs[0]}"
}

e2e::expect_out_files() {
  local file="$1"
  local expected="$2"

  local dir
  dir="$(e2e::run_dir "${file}")"

  shopt -s nullglob
  local files=( "${dir}"*.out )
  shopt -u nullglob

  [[ ${#files[@]} -eq "${expected}" ]] \
    || e2e::fail "expected ${expected} .out files for ${file}, got ${#files[@]}"

  e2e::pass "${file} has ${expected} .out files"
}

e2e::expect_out() {
  local file="$1"
  local workflow="$2"
  local expected="$3"

  local dir
  dir="$(e2e::run_dir "${file}")"

  local out_file="${dir}${file%.*}__${workflow}.out"

  [[ -f "${out_file}" ]] || e2e::fail "missing ${workflow} .out for ${file}"

  local content
  content="$(<"${out_file}")"

  e2e::assert_equals "${content}" "${expected}" "${file} ${workflow} .out"
}

e2e::expect_rule_out() {
  local file="$1"
  local rule="$2"
  local expected="$3"

  local dir
  dir="$(e2e::run_dir "${file}")"

  local normalized="${rule//./__}"
  local out_file="${dir}${normalized}.out"

  [[ -f "${out_file}" ]] || e2e::fail "missing ${rule} .out for ${file}"

  local content
  content="$(<"${out_file}")"

  e2e::assert_equals "${content}" "${expected}" "${file} ${rule} .out"
}

e2e::expect_stdout() {
  local actual="$1"
  local expected

  expected="$(cat)"
  expected="${expected%$'\n'}"

  e2e::assert_output_equals "${actual}" "${expected}" "stdout matches"
}

e2e::expect_fail() {
  local file="$1"
  shift || true

  if e2e::run "${file}" "$@" >/dev/null 2>&1; then
    e2e::fail "${file} should fail"
  fi
}

e2e::git_init() {
  git init -b main >/dev/null 2>&1 || git init >/dev/null 2>&1
}

e2e::git_current_branch() {
  local branch
  branch="$(git branch --show-current || true)"
  [[ -n "${branch}" ]] || branch="main"
  printf "%s" "${branch}"
}
```

Also I want to compare all files content in Jaiph runs directory.

That might be something like:

```
e2e::expect_no_file "*ensure_ci_passes_ensure_ci_passes.err"

e2e::expect_file "*ensure_ci_passes_ensure_ci_passes.err" <<'EOF'
# the exact content
EOF
```

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
