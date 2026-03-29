#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "engineer_recover_contract"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "engineer-style recover writes CI log and preserves role arg"

e2e::file "engineer_recover_contract.jh" <<'EOF'
script save_string_to_file() {
  echo "$1" > "$2"
}

script mkdir_p_simple() {
  mkdir -p "$1"
}

script failing_ci_impl() {
  echo "ci failure: tests failed"
  echo "details: expected 0 but got 1" >&2
  exit 1
}

rule ci_passes {
  run failing_ci_impl
}

workflow implement {
  const task = "${arg1}"
  ensure ci_passes recover {
    const ci_failure_log = "${arg1}"
    const ci_log_file = ".jaiph/tmp/ensure_ci_passes.last.log"
    run mkdir_p_simple ".jaiph/tmp"
    run save_string_to_file "${ci_failure_log}" "${ci_log_file}"
    run save_string_to_file "${arg2}" ".jaiph/tmp/recover.role"
  }
}

workflow default {
  run implement "original-task" "surgical"
}
EOF

rm -rf "${TEST_DIR}/.jaiph/tmp"
JAIPH_ENSURE_MAX_RETRIES=1 e2e::run "engineer_recover_contract.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/.jaiph/tmp/ensure_ci_passes.last.log" "recover writes CI failure payload file"
e2e::assert_file_exists "${TEST_DIR}/.jaiph/tmp/recover.role" "recover keeps second positional arg"

ci_log="$(<"${TEST_DIR}/.jaiph/tmp/ensure_ci_passes.last.log")"
role="$(<"${TEST_DIR}/.jaiph/tmp/recover.role")"
e2e::assert_contains "${ci_log}" "ci failure: tests failed" "recover \$1 contains failed rule stdout"
e2e::assert_contains "${ci_log}" "expected 0 but got 1" "recover \$1 contains failed rule stderr"
if [[ "${role}" != "surgical" ]]; then
  e2e::fail "recover \$2 preserves role argument"
fi

e2e::pass "engineer-style ensure recover contract holds"
