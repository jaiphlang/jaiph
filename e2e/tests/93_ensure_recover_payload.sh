#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover_payload"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

E2E_MOCK_BIN="${ROOT_DIR}/e2e/bin"
chmod 755 "${E2E_MOCK_BIN}/cursor-agent"
export PATH="${E2E_MOCK_BIN}:${PATH}"

e2e::section "run catch runs body once on failure (no retry)"

rm -rf "${TEST_DIR}/.jaiph/tmp"
mkdir -p "${TEST_DIR}/.jaiph/tmp"

e2e::file "ensure_recover_payload.jh" <<'EOF'
config {
  agent.backend = "cursor"
}

script save_string_to_file = `printf '%s' "$1" > "$2"`

script emit_root_step = `printf '%s\n' "PAYLOAD_ROOT_SCRIPT"`

script emit_nested_step = `printf '%s\n' "PAYLOAD_NESTED_SCRIPT"`

script emit_deep_step_then_fail_until_recovered = ```
printf '%s\n' "PAYLOAD_DEEP_SCRIPT"
if [ -f .jaiph/tmp/recovered ]; then
  exit 0
fi
exit 1
```

script mark_recovered = `touch .jaiph/tmp/recovered`

workflow deep_rule() {
  run emit_deep_step_then_fail_until_recovered()
}

workflow nested_rule() {
  run emit_nested_step()
  run deep_rule()
}

workflow top_rule() {
  run emit_root_step()
  run nested_rule()
}

workflow default() {
  run top_rule() catch (failure) {
    run save_string_to_file("recovered-on-retry", witness_failed_payload.txt)
    run mark_recovered()
  }
}
EOF

out="$(e2e::run "ensure_recover_payload.jh" 2>&1)"

e2e::expect_stdout "${out}" <<'EXPECTED'

Jaiph: Running ensure_recover_payload.jh

workflow default
  ▸ workflow top_rule
  ·   ▸ script emit_root_step
  ·   ✓ script emit_root_step (<time>)
  ·   ▸ workflow nested_rule
  ·   ·   ▸ script emit_nested_step
  ·   ·   ✓ script emit_nested_step (<time>)
  ·   ·   ▸ workflow deep_rule
  ·   ·   ·   ▸ script emit_deep_step_then_fail_until_recovered
  ·   ·   ·   ✗ script emit_deep_step_then_fail_until_recovered (<time>)
  ·   ·   ✗ workflow deep_rule (<time>)
  ·   ✗ workflow nested_rule (<time>)
  ✗ workflow top_rule (<time>)
  ▸ script save_string_to_file (1="recovered-on-retry", 2="witness_failed_payload.txt")
  ✓ script save_string_to_file (<time>)
  ▸ script mark_recovered
  ✓ script mark_recovered (<time>)

✓ PASS workflow default (<time>)
EXPECTED

e2e::assert_file_exists "${TEST_DIR}/witness_failed_payload.txt" "recover wrote failure payload witness"
witness="$(<"${TEST_DIR}/witness_failed_payload.txt")"
e2e::assert_equals "${witness}" "recovered-on-retry" "recover action writes witness marker"

e2e::pass "run catch runs body once on failure (no retry)"
