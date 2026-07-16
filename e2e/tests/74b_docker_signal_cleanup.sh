#!/usr/bin/env bash

# ---------------------------------------------------------------------------
# Ctrl+C on a Docker-backed `jaiph run` must STOP THE CONTAINER, not just the
# host CLI. Regression guard for the orphaned-container bug: interrupting the
# host `jaiph` process left the `docker run --rm` container running (visible in
# `docker ps` minutes later), still executing workflow/agent work.
#
# Contract asserted here (SIGINT on the host `jaiph` PID):
#   1. The container is gone from `docker ps` within a bounded window (15s).
#   2. Host cleanup still runs: no `.sandbox-*` clones remain under the runs root.
#   3. Holds for copy/inplace-style fixtures and for a nested long-lived shell
#      (closer to agent behavior: a `sleep` spawned inside an `ensure` rule).
#
# Manual repro:
#   JAIPH_DOCKER_ENABLED=true jaiph run flow.jh   # flow sleeps 60s
#   # in another terminal:
#   Ctrl+C the jaiph process
#   docker ps                                     # must NOT list the container
# ---------------------------------------------------------------------------

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_signal_cleanup"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Gate on Docker availability — skip gracefully when Docker is not installed.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker signal cleanup (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping Docker signal cleanup tests"
  exit 0
fi

# Build a local test image with jaiph installed from current source.
if ! e2e::ensure_docker_test_image; then
  e2e::section "docker signal cleanup (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

runs_root="${TEST_DIR}/.jaiph/runs"
mkdir -p "${runs_root}"

# List container ids for this test's image (the ancestor filter matches by image).
container_ids() {
  docker ps -q --filter "ancestor=${E2E_DOCKER_TEST_IMAGE}" 2>/dev/null || true
}

# Run one signal-cleanup scenario against $1 (a .jh fixture basename under TEST_DIR).
# Asserts: container appears, SIGINT stops it within 15s, and no .sandbox-* remains.
run_signal_scenario() {
  local flow="$1"

  # Start the workflow in the background, then send SIGINT after a short delay.
  JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" \
    jaiph run "${TEST_DIR}/${flow}" >/dev/null 2>&1 &
  local bg_pid=$!

  # Wait (up to ~10s) for the container to start.
  local started="" i
  for ((i = 0; i < 20; i++)); do
    if [[ -n "$(container_ids)" ]]; then
      started="yes"
      break
    fi
    sleep 0.5
  done
  if [[ -z "${started}" ]]; then
    kill -INT "${bg_pid}" 2>/dev/null || true
    wait "${bg_pid}" 2>/dev/null || true
    e2e::fail "docker signal cleanup [${flow}]: container never appeared in docker ps"
  fi

  # Send SIGINT to the jaiph process (mimics Ctrl-C).
  kill -INT "${bg_pid}" 2>/dev/null || true

  # The container must disappear from `docker ps` within 15s.
  local gone="" waited=0
  while (( waited < 15 )); do
    if [[ -z "$(container_ids)" ]]; then
      gone="yes"
      break
    fi
    sleep 1
    (( ++waited ))
  done

  # Wait for jaiph to exit (bounded so the test can't hang).
  timeout 15 bash -c "wait ${bg_pid} 2>/dev/null; true" || true
  # Allow a brief moment for async host cleanup.
  sleep 1

  if [[ -z "${gone}" ]]; then
    # Best-effort teardown so a failure here doesn't leave a live container.
    for cid in $(container_ids); do docker rm -f "${cid}" >/dev/null 2>&1 || true; done
    e2e::fail "docker signal cleanup [${flow}]: container still running 15s after SIGINT (orphaned)"
  fi
  e2e::pass "docker signal cleanup [${flow}]: container gone from docker ps within 15s of SIGINT"

  # Host cleanup still runs: no .sandbox-* directories remain under runs root.
  shopt -s nullglob
  local sandbox_dirs=( "${runs_root}"/.sandbox-* )
  shopt -u nullglob
  if [[ ${#sandbox_dirs[@]} -gt 0 ]]; then
    e2e::fail "docker signal cleanup [${flow}]: .sandbox-* dirs remain after SIGINT: ${sandbox_dirs[*]}"
  fi
  e2e::pass "docker signal cleanup [${flow}]: no .sandbox-* dirs after SIGINT"
}

# ---------------------------------------------------------------------------
# Scenario 1: rule → script sleep (the original coverage, now also asserting
# the container stops — not just that the sandbox dir is cleaned up).
# ---------------------------------------------------------------------------

e2e::section "docker signal cleanup — SIGINT stops the container (rule → script sleep)"

e2e::file "long_sleep.jh" <<'EOF'
script sleep_impl = ```
sleep 60
```
rule do_sleep() {
  run sleep_impl()
}

workflow default() {
  ensure do_sleep()
}
EOF

run_signal_scenario "long_sleep.jh"

# ---------------------------------------------------------------------------
# Scenario 2 (regression variant): a nested long-lived shell spawned inside an
# `ensure` rule — closer to agent behavior (an agent CLI / long `npm test`
# outliving the forwarded signal). The container-stop contract must not depend
# on the fixture shape.
# ---------------------------------------------------------------------------

e2e::section "docker signal cleanup — SIGINT stops the container (nested shell in ensure)"

e2e::file "nested_hang.jh" <<'EOF'
script hang_impl = ```
sh -c 'sleep 60'
```
rule hang() {
  run hang_impl()
}

workflow default() {
  ensure hang()
}
EOF

run_signal_scenario "nested_hang.jh"
