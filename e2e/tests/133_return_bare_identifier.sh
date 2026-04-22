#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "return_bare_identifier"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "return bare identifier propagates const value"

# Given
e2e::file "return_bare.jh" <<'EOF'
workflow helper() {
  const msg = "bare-id-ok"
  return msg
}

workflow default() {
  const r = run helper()
  log "got: ${r}"
}
EOF

# When
return_bare_out="$(e2e::run "return_bare.jh")"

# Then
e2e::expect_stdout "${return_bare_out}" <<'EOF'

Jaiph: Running return_bare.jh

workflow default
  ▸ workflow helper
  ✓ workflow helper (<time>)
  ℹ got: bare-id-ok
✓ PASS workflow default (<time>)
EOF

e2e::section "return bare identifier from parameter"

# Given
e2e::file "return_param.jh" <<'EOF'
workflow echo_back(val) {
  return val
}

workflow default() {
  const r = run echo_back("param-ok")
  log "got: ${r}"
}
EOF

# When
return_param_out="$(e2e::run "return_param.jh")"

# Then
e2e::expect_stdout "${return_param_out}" <<'EOF'

Jaiph: Running return_param.jh

workflow default
  ▸ workflow echo_back (val="param-ok")
  ✓ workflow echo_back (<time>)
  ℹ got: param-ok
✓ PASS workflow default (<time>)
EOF

e2e::section "return interpolated string still works"

# Given
e2e::file "return_interp.jh" <<'EOF'
workflow helper() {
  const msg = "interp-ok"
  return "${msg}"
}

workflow default() {
  const r = run helper()
  log "got: ${r}"
}
EOF

# When
return_interp_out="$(e2e::run "return_interp.jh")"

# Then
e2e::expect_stdout "${return_interp_out}" <<'EOF'

Jaiph: Running return_interp.jh

workflow default
  ▸ workflow helper
  ✓ workflow helper (<time>)
  ℹ got: interp-ok
✓ PASS workflow default (<time>)
EOF

e2e::section "return unknown bare identifier fails with unknown-identifier error"

# Given
e2e::file "return_unknown.jh" <<'EOF'
workflow default() {
  const msg = "hello"
  return missing_name
}
EOF

# When/Then
if return_unknown_err="$(e2e::run "return_unknown.jh" 2>&1)"; then
  e2e::fail "expected compile-time failure for unknown bare identifier"
fi
e2e::assert_contains "${return_unknown_err}" "unknown identifier" "return unknown bare identifier produces unknown-identifier error"
e2e::pass "return unknown bare identifier rejected with correct error"
