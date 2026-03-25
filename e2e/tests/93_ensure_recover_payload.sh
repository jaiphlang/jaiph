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

e2e::section "ensure <rule> <param> recover retries and exposes nested failed payload in \$1"

rm -rf "${TEST_DIR}/.jaiph/tmp"
mkdir -p "${TEST_DIR}/.jaiph/tmp"

e2e::file "ensure_recover_payload.jh" <<'EOF'
config {
  agent.backend = "cursor"
}

script save_string_to_file() {
  printf '%s' "$1" > "$2"
}

script emit_root_step() {
  printf '%s\n' "PAYLOAD_ROOT_SCRIPT"
}

script emit_nested_step() {
  printf '%s\n' "PAYLOAD_NESTED_SCRIPT"
}

script emit_deep_step_then_fail_until_recovered() {
  if [ "$1" != "ctx-token" ]; then
    printf 'expected ctx-token, got %s\n' "$1" >&2
    exit 2
  fi
  printf '%s\n' "PAYLOAD_DEEP_SCRIPT"
  if [ -f .jaiph/tmp/recovered ]; then
    exit 0
  fi
  exit 1
}

script mark_recovered() {
  touch .jaiph/tmp/recovered
}

rule deep_rule {
  run emit_deep_step_then_fail_until_recovered "$1"
}

rule nested_rule {
  run emit_nested_step
  ensure deep_rule "$1"
}

rule top_rule {
  run emit_root_step
  ensure nested_rule "$1"
}

workflow default {
  ensure top_rule "ctx-token" recover {
    run save_string_to_file "$1" witness_failed_payload.txt
    prompt "Apply the smallest safe fix."
    run mark_recovered
  }
}
EOF

out="$(e2e::run "ensure_recover_payload.jh" 2>&1)"

e2e::assert_contains "${out}" "✗ rule top_rule" "first ensure attempt fails"
e2e::assert_contains "${out}" "✓ rule top_rule" "second ensure attempt succeeds"
e2e::assert_contains "${out}" "✓ PASS workflow default" "workflow completes after recover"

e2e::assert_file_exists "${TEST_DIR}/witness_failed_payload.txt" "recover wrote failure payload witness"
witness="$(<"${TEST_DIR}/witness_failed_payload.txt")"
e2e::assert_contains "${witness}" "PAYLOAD_ROOT_SCRIPT" "recover \$1 includes root rule script output"
e2e::assert_contains "${witness}" "PAYLOAD_NESTED_SCRIPT" "recover \$1 includes nested rule script output"
e2e::assert_contains "${witness}" "PAYLOAD_DEEP_SCRIPT" "recover \$1 includes deepest failing script output"

e2e::pass "ensure recover receives nested failed-rule payload and retries successfully"
