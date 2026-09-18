#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "engineer_recover_contract"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "engineer-style catch streams the CI stdout+stderr handle and preserves role arg"

# `failure` binds the failed step's stdout THEN stderr, merged into one OUTPUT
# HANDLE (see Value types in docs/language.md). The recover body streams it into
# a script with `stdin failure -> save()` — the CI log flows on stdin, never
# argv, so a huge log cannot hit ARG_MAX — mirroring the real engineer workflow
# that reads the CI log. A sibling role argument still binds normally.
e2e::file "engineer_recover_contract.jh" <<'EOF'
script save_string_to_file = `echo "$1" > "$2"`

script mkdir_p_simple = `mkdir -p "$1"`

script save_log = `cat > "$1"`

script failing_ci_impl = ```
echo "ci failure: tests failed"
echo "details: expected 0 but got 1" >&2
exit 1
```

def ci_passes() {
  failing_ci_impl()
}

def implement(task, role) {
  const the_task = "${task}"
  ci_passes() catch (failure) {
    mkdir_p_simple(".jaiph/tmp")
    stdin failure -> save_log(".jaiph/tmp/ensure_ci_passes.last.log")
    save_string_to_file(role, ".jaiph/tmp/recover.role")
  }
}

export def main() {
  implement("original-task", "surgical")
}
EOF

rm -rf "${TEST_DIR}/.jaiph/tmp"
JAIPH_ENSURE_MAX_RETRIES=1 e2e::run "engineer_recover_contract.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/.jaiph/tmp/ensure_ci_passes.last.log" "recover streams the CI stdout+stderr handle"
e2e::assert_file_exists "${TEST_DIR}/.jaiph/tmp/recover.role" "recover keeps second positional arg"

ci_log="$(<"${TEST_DIR}/.jaiph/tmp/ensure_ci_passes.last.log")"
role="$(<"${TEST_DIR}/.jaiph/tmp/recover.role")"
e2e::assert_equals "${ci_log}" "$(printf 'ci failure: tests failed\ndetails: expected 0 but got 1\n')" "streamed handle holds the failed rule stdout then stderr"
if [[ "${role}" != "surgical" ]]; then
  e2e::fail "recover \$2 preserves role argument"
fi

e2e::pass "engineer-style run catch contract holds"
