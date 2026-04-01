#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "infile_metadata"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "in-file config drives run.logs_dir without config file"

# Given
rm -rf "${TEST_DIR}/.jaiph"
mkdir -p "${TEST_DIR}"

e2e::file "meta_workflow.jh" <<'EOF'
config {
  run.logs_dir = "meta_runs"
}
script ok_impl = "echo ok"
rule ok {
  run ok_impl()
}
workflow default {
  ensure ok()
}
EOF

# When
if ! jaiph run "${TEST_DIR}/meta_workflow.jh" 2>/dev/null; then
  e2e::fail "jaiph run with in-file config should succeed"
fi

# Then
e2e::expect_run_file_count_at "${TEST_DIR}/meta_runs" "meta_workflow.jh" 6
e2e::expect_run_file_at "${TEST_DIR}/meta_runs" "meta_workflow.jh" "000003-script__ok_impl.out" "ok"
e2e::pass "run directory created under in-file config run.logs_dir"

e2e::section "in-file config is used when set"

# Given
mkdir -p "${TEST_DIR}/.jaiph"

e2e::file "override.jh" <<'EOF'
config {
  run.logs_dir = "config_wins"
}
script ok_impl = "echo ok"
rule ok {
  run ok_impl()
}
workflow default {
  ensure ok()
}
EOF

# When
if ! jaiph run "${TEST_DIR}/override.jh" 2>/dev/null; then
  e2e::fail "jaiph run should succeed when in-file config sets run.logs_dir"
fi

# Then
e2e::expect_run_file_count_at "${TEST_DIR}/config_wins" "override.jh" 6
e2e::expect_run_file_at "${TEST_DIR}/config_wins" "override.jh" "000003-script__ok_impl.out" "ok"
e2e::pass "in-file config drives run.logs_dir"
