#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "run_stdout_redirect"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "run workflow > file with background jobs"
# ---------------------------------------------------------------------------

e2e::file "greeter.jh" <<'EOF'
workflow greet {
  echo "hello $1"
}

workflow default {
  run greet "alice" > alice.txt &
  run greet "bob" > bob.txt &
  wait
}
EOF

e2e::run "greeter.jh" >/dev/null

e2e::assert_file_exists "${TEST_DIR}/alice.txt" "alice.txt created by redirect"
e2e::assert_file_exists "${TEST_DIR}/bob.txt"   "bob.txt created by redirect"
e2e::assert_contains "$(cat "${TEST_DIR}/alice.txt")" "hello alice" "alice.txt has workflow stdout"
e2e::assert_contains "$(cat "${TEST_DIR}/bob.txt")"   "hello bob"   "bob.txt has workflow stdout"

# Step artifacts should still be generated
dir="$(e2e::run_dir "greeter.jh")"
shopt -s nullglob
out_files=( "${dir}"*.out )
shopt -u nullglob
if [[ ${#out_files[@]} -lt 1 ]]; then
  e2e::fail "expected at least 1 .out artifact file, got ${#out_files[@]}"
fi
e2e::pass "step artifacts still generated alongside redirect"

# ---------------------------------------------------------------------------
e2e::section "run workflow | pipeline"
# ---------------------------------------------------------------------------

e2e::file "upper.jh" <<'EOF'
workflow produce {
  echo "pipe-output-line"
}

workflow default {
  run produce | tr a-z A-Z > piped.txt
}
EOF

e2e::run "upper.jh" >/dev/null

e2e::assert_file_exists "${TEST_DIR}/piped.txt" "piped.txt created by pipeline"
e2e::assert_contains "$(cat "${TEST_DIR}/piped.txt")" "PIPE-OUTPUT-LINE" "pipeline transforms workflow stdout"
