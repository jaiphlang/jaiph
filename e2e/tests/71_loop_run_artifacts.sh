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

# Given: a workflow that loops and calls run with capture on a sub-workflow containing a prompt
e2e::file "loop_prompts.jh" <<'EOF'
#!/usr/bin/env jaiph

workflow review {
  prompt "$1"
}

workflow default {
  for item in alpha beta gamma; do
    result = run review "$item"
  done
}
EOF

rm -rf "${TEST_DIR}/loop_runs"

# When
JAIPH_RUNS_DIR="loop_runs" e2e::run "loop_prompts.jh" >/dev/null

# Then: three distinct prompt .out files (seq 2, 3, 4; seq 1 is the default workflow step)
e2e::expect_run_file_count_at "${TEST_DIR}/loop_runs" "loop_prompts.jh" 3
e2e::expect_run_file_at "${TEST_DIR}/loop_runs" "loop_prompts.jh" "000002-jaiph__prompt.out" "Command:
cursor-agent --print --output-format stream-json --stream-partial-output --workspace ${TEST_DIR} --trust ${TEST_DIR} alpha

Prompt:
alpha

Final answer:
e2e-backend-no-mock-output"
e2e::expect_run_file_at "${TEST_DIR}/loop_runs" "loop_prompts.jh" "000003-jaiph__prompt.out" "Command:
cursor-agent --print --output-format stream-json --stream-partial-output --workspace ${TEST_DIR} --trust ${TEST_DIR} beta

Prompt:
beta

Final answer:
e2e-backend-no-mock-output"
e2e::expect_run_file_at "${TEST_DIR}/loop_runs" "loop_prompts.jh" "000004-jaiph__prompt.out" "Command:
cursor-agent --print --output-format stream-json --stream-partial-output --workspace ${TEST_DIR} --trust ${TEST_DIR} gamma

Prompt:
gamma

Final answer:
e2e-backend-no-mock-output"
