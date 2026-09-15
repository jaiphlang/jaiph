#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "engineer_recover_contract"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "engineer-style catch binds the CI capture path and preserves role arg"

# `failure` binds the failed step's stdout CAPTURE PATH (an absolute *.out under
# JAIPH_RUN_DIR); stderr is the sibling *.err. The recover body cp's the bytes
# from disk (never receives the log as argv), mirroring the real engineer
# workflow that reads the CI log by path.
e2e::file "engineer_recover_contract.jh" <<'EOF'
script save_string_to_file = `echo "$1" > "$2"`

script mkdir_p_simple = `mkdir -p "$1"`

script copy_captures = ```
cp "$1" "$2"
cp "${1%.out}.err" "$3"
```

script failing_ci_impl = ```
echo "ci failure: tests failed"
echo "details: expected 0 but got 1" >&2
exit 1
```

def ci_passes() {
  run failing_ci_impl()
}

def implement(task, role) {
  const the_task = "${task}"
  run ci_passes() catch (failure) {
    run mkdir_p_simple(".jaiph/tmp")
    run copy_captures(failure, ".jaiph/tmp/ensure_ci_passes.last.log", ".jaiph/tmp/ensure_ci_passes.last.err")
    run save_string_to_file(role, ".jaiph/tmp/recover.role")
  }
}

export def main() {
  run implement("original-task", "surgical")
}
EOF

rm -rf "${TEST_DIR}/.jaiph/tmp"
JAIPH_ENSURE_MAX_RETRIES=1 e2e::run "engineer_recover_contract.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/.jaiph/tmp/ensure_ci_passes.last.log" "recover copies CI stdout capture"
e2e::assert_file_exists "${TEST_DIR}/.jaiph/tmp/ensure_ci_passes.last.err" "recover copies CI stderr capture"
e2e::assert_file_exists "${TEST_DIR}/.jaiph/tmp/recover.role" "recover keeps second positional arg"

ci_log="$(<"${TEST_DIR}/.jaiph/tmp/ensure_ci_passes.last.log")"
ci_err="$(<"${TEST_DIR}/.jaiph/tmp/ensure_ci_passes.last.err")"
role="$(<"${TEST_DIR}/.jaiph/tmp/recover.role")"
e2e::assert_equals "${ci_log}" "ci failure: tests failed" "stdout capture holds the failed rule stdout"
e2e::assert_equals "${ci_err}" "details: expected 0 but got 1" "sibling .err holds the failed rule stderr"
if [[ "${role}" != "surgical" ]]; then
  e2e::fail "recover \$2 preserves role argument"
fi

e2e::pass "engineer-style run catch contract holds"
