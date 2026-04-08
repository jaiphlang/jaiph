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

workflow review(name) {
  prompt "${name}"
}

workflow default() {
  const first = run review("alpha")
  const second = run review("beta")
  const third = run review("gamma")
}
EOF

rm -rf "${TEST_DIR}/loop_runs"

# When
JAIPH_RUNS_DIR="${TEST_DIR}/loop_runs" e2e::run "loop_prompts.jh" >/dev/null

# Then: artifacts include workflow-level .out + prompt step .out for each review call.
e2e::expect_run_file_count_at "${TEST_DIR}/loop_runs" "loop_prompts.jh" 14
run_dir="$(e2e::run_dir_at "${TEST_DIR}/loop_runs" "loop_prompts.jh")"
shopt -s nullglob
review_out_files=( "${run_dir}"*-workflow__review.out )
shopt -u nullglob
[[ ${#review_out_files[@]} -eq 3 ]] || e2e::fail "expected 3 review workflow .out files, got ${#review_out_files[@]}"
e2e::pass "loop_prompts.jh has 3 review workflow .out files"

for review_out_file in "${review_out_files[@]}"; do
  review_label="$(basename "${review_out_file}")"
  e2e::assert_file_exists "${review_out_file}" "${review_label} exists"
  review_out="$(<"${review_out_file}")"
  # assert_contains: prompt transcript includes dynamic agent command output and timestamps
  e2e::assert_contains "${review_out}" "Command:" "${review_label} contains prompt command transcript"
  # assert_contains: prompt transcript includes dynamic agent command output and timestamps
  e2e::assert_contains "${review_out}" "Prompt:" "${review_label} contains prompt section"
  # assert_contains: prompt transcript includes dynamic agent command output and timestamps
  e2e::assert_contains "${review_out}" "Final answer:" "${review_label} contains prompt final section"
done
