#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "infile_metadata"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "in-file config drives run.logs_dir without config file"
# Given: workflow with only in-file config
rm -rf "${TEST_DIR}/.jaiph"
mkdir -p "${TEST_DIR}"
cat > "${TEST_DIR}/meta_workflow.jh" <<'EOF'
config {
  run.logs_dir = "meta_runs"
}
rule ok {
  echo ok
}
workflow default {
  ensure ok
}
EOF

# When
if ! jaiph run "${TEST_DIR}/meta_workflow.jh" 2>/dev/null; then
  e2e::fail "jaiph run with in-file config should succeed"
fi

# Then: run directory was created under config-defined path
shopt -s nullglob
run_dirs=("${TEST_DIR}/meta_runs"/*)
shopt -u nullglob
if [[ ${#run_dirs[@]} -lt 1 ]]; then
  e2e::fail "expected at least one run directory under meta_runs (in-file config)"
fi
e2e::pass "run directory created under in-file config run.logs_dir"

# Assert .out file content for meta_workflow.jh
shopt -s nullglob
meta_run_dirs=( "${TEST_DIR}/meta_runs/"*/*meta_workflow.jh/ )
shopt -u nullglob
[[ ${#meta_run_dirs[@]} -eq 1 ]] || e2e::fail "expected one run dir for meta_workflow.jh"
meta_out_files=( "${meta_run_dirs[0]}"*.out )
[[ ${#meta_out_files[@]} -eq 1 ]] || e2e::fail "expected one .out file for meta_workflow.jh, got ${#meta_out_files[@]}"
e2e::assert_equals "$(<"${meta_out_files[0]}")" "ok" "meta_workflow.jh rule ok .out content"

e2e::section "in-file config is used when set"
# Given: workflow with config
mkdir -p "${TEST_DIR}/.jaiph"
cat > "${TEST_DIR}/override.jh" <<'EOF'
config {
  run.logs_dir = "config_wins"
}
rule ok {
  echo ok
}
workflow default {
  ensure ok
}
EOF

# When
jaiph run "${TEST_DIR}/override.jh" 2>/dev/null || true

# Then: run dir is under config_wins
shopt -s nullglob
meta_dirs=("${TEST_DIR}/config_wins"/*)
shopt -u nullglob
if [[ ${#meta_dirs[@]} -lt 1 ]]; then
  e2e::fail "expected run directory under config_wins (in-file config)"
fi
e2e::pass "in-file config drives run.logs_dir"

# Assert .out file content for override.jh
shopt -s nullglob
override_run_dirs=( "${TEST_DIR}/config_wins/"*/*override.jh/ )
shopt -u nullglob
[[ ${#override_run_dirs[@]} -eq 1 ]] || e2e::fail "expected one run dir for override.jh"
override_out_files=( "${override_run_dirs[0]}"*.out )
[[ ${#override_out_files[@]} -eq 1 ]] || e2e::fail "expected one .out file for override.jh, got ${#override_out_files[@]}"
e2e::assert_equals "$(<"${override_out_files[0]}")" "ok" "override.jh rule ok .out content"
