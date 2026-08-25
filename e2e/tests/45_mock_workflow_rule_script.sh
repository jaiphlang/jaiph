#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "mock_workflow_rule_script"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Mock workflow, rule, and script in *.test.jh"

# Given
e2e::file "app.jh" <<'EOF'
#!/usr/bin/env jaiph
script policy_check_impl = `echo real-policy`
def policy_check() {
  run policy_check_impl()
}
script changed_files = `echo real_files`
script build_impl = ```
echo "real build"
```
def build() {
  run build_impl()
}
export def main() {
  run policy_check()
  run build()
}
EOF

e2e::file "app.test.jh" <<'EOF'
#!/usr/bin/env jaiph
import "app.jh" as app

test "isolated orchestration" {
  mock def app.build() {
    log "build ok"
    return "build ok"
  }

  mock def app.policy_check() {
    log "policy ok"
    return "policy ok"
  }

  mock script app.changed_files() {
    echo "a.ts"
    echo "b.ts"
  }

  const out = run app.main()
  expect_contain out "policy ok"
  expect_contain out "build ok"
}
EOF

# When
test_out="$(jaiph test "${TEST_DIR}/app.test.jh")"

# Then
if [[ "${test_out}" != *"passed"* ]] && [[ "${test_out}" != *"PASS"* ]]; then
  printf "%s\n" "${test_out}" >&2
  e2e::fail "app.test.jh should pass"
fi
if [[ "${test_out}" != *"isolated orchestration"* ]]; then
  printf "%s\n" "${test_out}" >&2
  e2e::fail "expected test case name in output"
fi
e2e::pass "mock def, rule, and script tests pass"
