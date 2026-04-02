#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "dot_notation"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. dot notation runtime test ─────────────────────────────────────────────

e2e::section "Dot notation for typed prompt fields"

cp "${ROOT_DIR}/e2e/dot_notation.jh" "${TEST_DIR}/dot_notation.jh"
cp "${ROOT_DIR}/e2e/dot_notation.test.jh" "${TEST_DIR}/dot_notation.test.jh"

out="$(jaiph test "${TEST_DIR}/dot_notation.test.jh" 2>&1)" || {
  printf "%s\n" "${out}" >&2
  e2e::fail "dot_notation.test.jh should pass"
}

if [[ "${out}" != *"passed"* ]] && [[ "${out}" != *"PASS"* ]]; then
  printf "%s\n" "${out}" >&2
  e2e::fail "dot_notation.test.jh should report pass"
fi

e2e::pass "dot_notation.test.jh passes with dot notation"

# ── 2. compile-time rejection: invalid field name ────────────────────────────

e2e::section "Compile-time rejection: invalid field in dot notation"

cat > "${TEST_DIR}/bad_field.jh" <<'EOF'
workflow default() {
  const result = prompt "Analyse" returns "{ type: string }"
  log "bad ${result.bogus}"
}
EOF

out="$(jaiph run "${TEST_DIR}/bad_field.jh" 2>&1)" && {
  e2e::fail "bad_field.jh should fail to compile"
}

# nondeterministic error formatting — substring check acceptable
e2e::assert_contains "${out}" 'field "bogus" is not defined' "invalid field rejected at compile time"

# ── 3. compile-time rejection: not a typed prompt capture ────────────────────

e2e::section "Compile-time rejection: dot notation on non-prompt variable"

cat > "${TEST_DIR}/not_prompt.jh" <<'EOF'
workflow default() {
  log "bad ${x.field}"
}
EOF

out="$(jaiph run "${TEST_DIR}/not_prompt.jh" 2>&1)" && {
  e2e::fail "not_prompt.jh should fail to compile"
}

# nondeterministic error formatting — substring check acceptable
e2e::assert_contains "${out}" 'not a typed prompt capture' "non-prompt dot notation rejected at compile time"
