#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "loop_run_artifacts"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "loop with captured run produces distinct artifact files"

E2E_MOCK_BIN="${ROOT_DIR}/e2e/bin"
chmod 755 "${E2E_MOCK_BIN}/cursor-agent"
export PATH="${E2E_MOCK_BIN}:${PATH}"

# Given: a workflow that repeatedly calls run with capture on a sub-workflow containing a prompt
e2e::file "loop_prompts.jh" <<'EOF'
#!/usr/bin/env jaiph

workflow review {
  prompt "$1"
}

workflow default {
  first = run review "alpha"
  second = run review "beta"
  third = run review "gamma"
}
EOF

rm -rf "${TEST_DIR}/loop_runs"

# When
JAIPH_RUNS_DIR="${TEST_DIR}/loop_runs" e2e::run "loop_prompts.jh" >/dev/null

# Then: Node orchestrator emits workflow-level artifacts for default + 3 review calls.
e2e::expect_run_file_count_at "${TEST_DIR}/loop_runs" "loop_prompts.jh" 8
run_dir="$(e2e::run_dir_at "${TEST_DIR}/loop_runs" "loop_prompts.jh")"
for seq in 000002 000003 000004; do
  review_out_file="${run_dir}${seq}-workflow__review.out"
  e2e::assert_file_exists "${review_out_file}" "${seq} review workflow .out exists"
  review_out="$(<"${review_out_file}")"
  e2e::assert_contains "${review_out}" "Command:" "${seq} review .out contains prompt command transcript"
  e2e::assert_contains "${review_out}" "Prompt:" "${seq} review .out contains prompt section"
  e2e::assert_contains "${review_out}" "Final answer:" "${seq} review .out contains prompt final section"
done
