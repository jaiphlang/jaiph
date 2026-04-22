#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "artifacts_lib"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "artifacts lib: save"
# ---------------------------------------------------------------------------

mkdir -p "${TEST_DIR}/.jaiph/libs/jaiphlang"
cp "${ROOT_DIR}/.jaiph/libs/jaiphlang/artifacts.jh" "${TEST_DIR}/.jaiph/libs/jaiphlang/artifacts.jh"

printf 'build-output-content' > "${TEST_DIR}/build_output.txt"

e2e::file "artifacts_e2e.jh" <<'EOF'
import "jaiphlang/artifacts" as artifacts

workflow default() {
  const save_path = run artifacts.save("./build_output.txt", "saved-output.txt")
  log save_path
}
EOF

artifacts_out="$(e2e::run "artifacts_e2e.jh")"

e2e::assert_contains "${artifacts_out}" "workflow default" "output contains workflow default"
e2e::assert_contains "${artifacts_out}" "workflow save" "output contains workflow save"
e2e::assert_contains "${artifacts_out}" "PASS" "output contains PASS"

run_dir="$(e2e::run_dir "artifacts_e2e.jh")"
artifacts_dir="${run_dir}artifacts"

e2e::assert_file_exists "${artifacts_dir}/saved-output.txt" "saved artifact exists"
saved_content="$(<"${artifacts_dir}/saved-output.txt")"
e2e::assert_equals "${saved_content}" "build-output-content" "saved artifact content matches source"

e2e::pass "artifacts save"
