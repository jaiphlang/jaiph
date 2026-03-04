#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "infile_metadata"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "in-file metadata drives run.logs_dir without config file"
# Given: workflow with only in-file metadata
rm -rf "${TEST_DIR}/.jaiph"
mkdir -p "${TEST_DIR}"
cat > "${TEST_DIR}/meta_workflow.jh" <<'EOF'
metadata {
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
  e2e::fail "jaiph run with in-file metadata should succeed"
fi

# Then: run directory was created under metadata-defined path
shopt -s nullglob
run_dirs=("${TEST_DIR}/meta_runs"/*)
shopt -u nullglob
if [[ ${#run_dirs[@]} -lt 1 ]]; then
  e2e::fail "expected at least one run directory under meta_runs (in-file metadata)"
fi
e2e::pass "run directory created under in-file metadata run.logs_dir"

e2e::section "in-file metadata is used when set"
# Given: workflow with metadata
mkdir -p "${TEST_DIR}/.jaiph"
cat > "${TEST_DIR}/override.jh" <<'EOF'
metadata {
  run.logs_dir = "metadata_wins"
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

# Then: run dir is under metadata_wins
shopt -s nullglob
meta_dirs=("${TEST_DIR}/metadata_wins"/*)
shopt -u nullglob
if [[ ${#meta_dirs[@]} -lt 1 ]]; then
  e2e::fail "expected run directory under metadata_wins (in-file metadata)"
fi
e2e::pass "in-file metadata drives run.logs_dir"
