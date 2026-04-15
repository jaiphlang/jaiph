#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_lifecycle"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Gate on Docker availability — skip gracefully when Docker is not installed.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker lifecycle (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping Docker lifecycle tests"
  exit 0
fi

# ---------------------------------------------------------------------------
# Early container exit / failed startup path
# ---------------------------------------------------------------------------

e2e::section "docker lifecycle — early exit does not hang"

# A workflow whose script fails immediately (exit 1).
e2e::file "early_exit.jh" <<'EOF'
script fail_fast_impl = ```
echo "about to fail"
exit 1
```
rule fail_fast() {
  run fail_fast_impl()
}

workflow default() {
  ensure fail_fast()
}
EOF

# When: run with Docker enabled — the container should fail and jaiph should
# exit promptly (within 30 seconds), not hang in RUNNING.
if timeout 30 bash -c "JAIPH_DOCKER_ENABLED=true jaiph run '${TEST_DIR}/early_exit.jh' >/dev/null 2>&1"; then
  e2e::fail "docker: early_exit.jh should have failed but exited 0"
fi
exit_code=$?
# timeout returns 124 when the command times out; any other non-zero means
# jaiph exited on its own (the expected behaviour).
if [[ "$exit_code" -eq 124 ]]; then
  e2e::fail "docker: jaiph hung (timed out) on early container exit"
fi
e2e::pass "docker: early container exit does not hang"

# Artifacts should still be written
run_dir="$(e2e::run_dir "early_exit.jh")"
e2e::assert_file_exists "${run_dir}run_summary.jsonl" "docker: early exit run_summary.jsonl exists"
e2e::pass "docker: early exit artifacts written"

# ---------------------------------------------------------------------------
# Normal streaming path — events are emitted and captured
# ---------------------------------------------------------------------------

e2e::section "docker lifecycle — normal run streams events"

e2e::file "stream_check.jh" <<'EOF'
script greet_impl = ```
echo "streamed hello"
```
rule greet() {
  run greet_impl()
}

workflow default() {
  log "before greet"
  ensure greet()
  log "after greet"
}
EOF

# When: run with Docker enabled
if ! timeout 60 bash -c "JAIPH_DOCKER_ENABLED=true jaiph run '${TEST_DIR}/stream_check.jh' >/dev/null 2>&1"; then
  e2e::fail "docker: stream_check.jh failed"
fi

# Then: run_summary.jsonl should contain STEP_START, STEP_END, and LOG events
run_dir="$(e2e::run_dir "stream_check.jh")"
summary_content="$(<"${run_dir}run_summary.jsonl")"

# assert_contains: run_summary.jsonl contains timestamps, UUIDs, and paths that vary per invocation
e2e::assert_contains "${summary_content}" '"type":"STEP_START"' "docker: summary has STEP_START events"
# assert_contains: run_summary.jsonl contains timestamps, UUIDs, and paths that vary per invocation
e2e::assert_contains "${summary_content}" '"type":"STEP_END"' "docker: summary has STEP_END events"
# assert_contains: run_summary.jsonl contains timestamps, UUIDs, and paths that vary per invocation
e2e::assert_contains "${summary_content}" '"type":"LOG"' "docker: summary has LOG events"

e2e::expect_run_file "stream_check.jh" "000003-script__greet_impl.out" "streamed hello"
e2e::pass "docker: normal run streams events and produces artifacts"
