#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "prompt_schema_types"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Typed prompt: string enums and arrays of records"

cp "${ROOT_DIR}/e2e/prompt_schema_types.jh" "${TEST_DIR}/prompt_schema_types.jh"
cp "${ROOT_DIR}/e2e/prompt_schema_types.test.jh" "${TEST_DIR}/prompt_schema_types.test.jh"

out="$(jaiph test "${TEST_DIR}/prompt_schema_types.test.jh" 2>&1)" || {
  printf "%s\n" "${out}" >&2
  e2e::fail "prompt_schema_types.test.jh should pass"
}

if [[ "${out}" != *"passed"* ]] && [[ "${out}" != *"PASS"* ]]; then
  printf "%s\n" "${out}" >&2
  e2e::fail "prompt_schema_types.test.jh should report pass"
fi

e2e::pass "prompt_schema_types.test.jh passes (enum if/match, array JSON interpolation)"

# ── Compile-time rejection: malformed enum/array schemas are E_PARSE ──────────

e2e::section "Compile-time rejection: malformed enum/array returns schema"

cat > "${TEST_DIR}/bad_enum.jh" <<'EOF'
export def main() {
  const r = prompt "x" returns "{ status: \"approve\" | }"
  return "${r.status}"
}
EOF

out="$(jaiph run "${TEST_DIR}/bad_enum.jh" 2>&1)" && {
  e2e::fail "bad_enum.jh should fail to compile"
}
# nondeterministic error formatting — substring check acceptable
e2e::assert_contains "${out}" "E_PARSE" "malformed enum rejected at compile time"
e2e::assert_contains "${out}" "empty option" "malformed enum names what to change"

cat > "${TEST_DIR}/bad_array.jh" <<'EOF'
export def main() {
  const r = prompt "x" returns "{ xs: [[{ a: string }]] }"
  return "${r.xs}"
}
EOF

out="$(jaiph run "${TEST_DIR}/bad_array.jh" 2>&1)" && {
  e2e::fail "bad_array.jh should fail to compile"
}
# nondeterministic error formatting — substring check acceptable
e2e::assert_contains "${out}" "E_PARSE" "nested array rejected at compile time"
e2e::assert_contains "${out}" "nested arrays" "nested array names what to change"
