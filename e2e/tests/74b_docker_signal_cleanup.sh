#!/usr/bin/env bash

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

# ---------------------------------------------------------------------------
# SIGINT during a Docker run must not leave .sandbox-* directories behind
# ---------------------------------------------------------------------------

e2e::section "docker signal cleanup — SIGINT leaves no sandbox dir"

e2e::file "long_sleep.jh" <<'EOF'
script sleep_impl = ```
sleep 30
```
rule do_sleep() {
  run sleep_impl()
}

workflow default() {
  ensure do_sleep()
}
EOF

runs_root="${TEST_DIR}/.jaiph/runs"
mkdir -p "${runs_root}"

# Start the workflow in the background, then send SIGINT after a short delay.
JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" \
  jaiph run "${TEST_DIR}/long_sleep.jh" >/dev/null 2>&1 &
bg_pid=$!

# Give the container time to start and create the sandbox dir.
sleep 3

# Send SIGINT to the jaiph process (mimics Ctrl-C).
kill -INT "${bg_pid}" 2>/dev/null || true

# Wait for jaiph to exit (with a timeout so the test doesn't hang).
timeout 15 bash -c "wait ${bg_pid} 2>/dev/null; true" || true

# Allow a brief moment for async cleanup.
sleep 1

# Assert no .sandbox-* directories remain under runs root.
shopt -s nullglob
sandbox_dirs=( "${runs_root}"/.sandbox-* )
shopt -u nullglob

if [[ ${#sandbox_dirs[@]} -gt 0 ]]; then
  e2e::fail "docker signal cleanup: .sandbox-* dirs remain after SIGINT: ${sandbox_dirs[*]}"
fi
e2e::pass "docker signal cleanup: no .sandbox-* dirs after SIGINT"
