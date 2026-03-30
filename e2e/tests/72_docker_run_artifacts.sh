#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_run_artifacts"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Gate on Docker availability — skip gracefully when Docker is not installed.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker run artifacts (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping Docker artifact tests"
  exit 0
fi

e2e::section "docker run artifacts — happy path"

# Given: a simple workflow that produces stdout artifacts
e2e::file "docker_artifacts.jh" <<'EOF'
script greet_impl {
  echo "hello from docker"
}
rule greet {
  run greet_impl()
}

workflow default {
  ensure greet()
}
EOF

# When: run with Docker enabled (override the e2e default of JAIPH_DOCKER_ENABLED=false)
if ! JAIPH_DOCKER_ENABLED=true jaiph run "${TEST_DIR}/docker_artifacts.jh" >/dev/null 2>&1; then
  JAIPH_DOCKER_ENABLED=true jaiph run "${TEST_DIR}/docker_artifacts.jh"
  e2e::fail "docker: jaiph run docker_artifacts.jh failed"
fi

# Then: artifacts should exist on the host under .jaiph/runs
run_dir="$(e2e::run_dir "docker_artifacts.jh")"
summary_file="${run_dir}run_summary.jsonl"

e2e::assert_file_exists "${summary_file}" "docker: run_summary.jsonl exists on host"

summary_content="$(<"${summary_file}")"
e2e::assert_contains "${summary_content}" "\"type\":\"STEP_END\"" "docker: summary records step events"

# At least one .out file should exist
shopt -s nullglob
out_files=( "${run_dir}"*.out )
shopt -u nullglob
[[ ${#out_files[@]} -ge 1 ]] || e2e::fail "docker: expected at least one .out file, got ${#out_files[@]}"
e2e::pass "docker: at least one .out file exists on host"

# Verify the greet step output
e2e::expect_run_file "docker_artifacts.jh" "000003-script__greet_impl.out" "hello from docker"

e2e::section "docker run artifacts — relative JAIPH_RUNS_DIR"

# Given: same workflow but with relative runs dir
e2e::file "docker_rel_runs.jh" <<'EOF'
script greet_impl {
  echo "hello relative"
}
rule greet {
  run greet_impl()
}

workflow default {
  ensure greet()
}
EOF

rm -rf "${TEST_DIR}/custom_runs"

# When: run with Docker and relative JAIPH_RUNS_DIR
(cd "${TEST_DIR}" && JAIPH_DOCKER_ENABLED=true JAIPH_RUNS_DIR="custom_runs" jaiph run "${TEST_DIR}/docker_rel_runs.jh" >/dev/null 2>&1)

# Then: artifacts should be under the relative dir on host
rel_run_dir="$(e2e::run_dir_at "${TEST_DIR}/custom_runs" "docker_rel_runs.jh")"
rel_summary="${rel_run_dir}run_summary.jsonl"
e2e::assert_file_exists "${rel_summary}" "docker: relative JAIPH_RUNS_DIR summary exists"
e2e::expect_run_file_at "${TEST_DIR}/custom_runs" "docker_rel_runs.jh" "000003-script__greet_impl.out" "hello relative"

e2e::section "docker run artifacts — absolute JAIPH_RUNS_DIR inside workspace"

# Given
e2e::file "docker_abs_runs.jh" <<'EOF'
script greet_impl {
  echo "hello absolute"
}
rule greet {
  run greet_impl()
}

workflow default {
  ensure greet()
}
EOF

abs_runs_dir="${TEST_DIR}/abs_runs"
rm -rf "${abs_runs_dir}"

# When: run with absolute JAIPH_RUNS_DIR inside workspace
JAIPH_DOCKER_ENABLED=true JAIPH_RUNS_DIR="${abs_runs_dir}" jaiph run "${TEST_DIR}/docker_abs_runs.jh" >/dev/null 2>&1

# Then: artifacts should be under the absolute path on host
abs_run_dir="$(e2e::run_dir_at "${abs_runs_dir}" "docker_abs_runs.jh")"
abs_summary="${abs_run_dir}run_summary.jsonl"
e2e::assert_file_exists "${abs_summary}" "docker: absolute JAIPH_RUNS_DIR inside workspace summary exists"
e2e::expect_run_file_at "${abs_runs_dir}" "docker_abs_runs.jh" "000003-script__greet_impl.out" "hello absolute"

e2e::section "docker run artifacts — absolute JAIPH_RUNS_DIR outside workspace fails"

# Given
e2e::file "docker_outside.jh" <<'EOF'
script greet_impl {
  echo "should not run"
}
rule greet {
  run greet_impl()
}

workflow default {
  ensure greet()
}
EOF

# When/Then: absolute path outside workspace should fail
outside_dir="/tmp/jaiph-outside-workspace-test-$$"
if JAIPH_DOCKER_ENABLED=true JAIPH_RUNS_DIR="${outside_dir}" jaiph run "${TEST_DIR}/docker_outside.jh" >/dev/null 2>&1; then
  rm -rf "${outside_dir}"
  e2e::fail "docker: absolute JAIPH_RUNS_DIR outside workspace should fail"
fi
rm -rf "${outside_dir}"
e2e::pass "docker: absolute JAIPH_RUNS_DIR outside workspace exits non-zero"
