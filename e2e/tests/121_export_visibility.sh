#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "export_visibility"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "referencing non-exported workflow from module with exports"
# ---------------------------------------------------------------------------

# Given — a library with one exported and one non-exported workflow
e2e::file "vis_lib.jh" <<'EOF'
export workflow public_wf() {
  log "public"
}

workflow private_wf() {
  log "private"
}
EOF

e2e::file "vis_main.jh" <<'EOF'
import "vis_lib.jh" as lib

workflow default() {
  run lib.private_wf()
}
EOF

# When / Then — compile fails because private_wf is not exported
vis_err="$(mktemp)"
if jaiph run "${TEST_DIR}/vis_main.jh" 2>"${vis_err}"; then
  cat "${vis_err}" >&2
  rm -f "${vis_err}"
  e2e::fail "jaiph run should fail when referencing non-exported symbol"
fi
vis_out="$(cat "${vis_err}")"
rm -f "${vis_err}"

# Then — error mentions export visibility
# assert_contains: error includes absolute path which varies per machine
e2e::assert_contains "${vis_out}" "is not exported" "non-exported workflow reference produces export error"

e2e::pass "referencing non-exported workflow from module with exports"

# ---------------------------------------------------------------------------
e2e::section "referencing non-exported workflow from module with exports (workflow)"
# ---------------------------------------------------------------------------

# Given
e2e::file "rule_lib.jh" <<'EOF'
script check_impl = `true`

export workflow public_rule() {
  run check_impl()
}

workflow private_rule() {
  run check_impl()
}
EOF

e2e::file "rule_main.jh" <<'EOF'
import "rule_lib.jh" as lib

workflow default() {
  run lib.private_rule()
}
EOF

# When / Then
rule_err="$(mktemp)"
if jaiph run "${TEST_DIR}/rule_main.jh" 2>"${rule_err}"; then
  cat "${rule_err}" >&2
  rm -f "${rule_err}"
  e2e::fail "jaiph run should fail when referencing non-exported workflow"
fi
rule_out="$(cat "${rule_err}")"
rm -f "${rule_err}"

# Then
# assert_contains: error includes absolute path which varies per machine
e2e::assert_contains "${rule_out}" "is not exported" "non-exported workflow reference produces export error"

e2e::pass "referencing non-exported workflow from module with exports (workflow)"

# ---------------------------------------------------------------------------
e2e::section "referencing non-exported script from module with exports"
# ---------------------------------------------------------------------------

# Given
e2e::file "script_lib.jh" <<'EOF'
script public_script = `echo "public"`
script private_script = `echo "private"`

export workflow dummy() {
  run public_script()
}
EOF

e2e::file "script_main.jh" <<'EOF'
import "script_lib.jh" as lib

workflow default() {
  run lib.private_script()
}
EOF

# When / Then
script_err="$(mktemp)"
if jaiph run "${TEST_DIR}/script_main.jh" 2>"${script_err}"; then
  cat "${script_err}" >&2
  rm -f "${script_err}"
  e2e::fail "jaiph run should fail when referencing non-exported script"
fi
script_out="$(cat "${script_err}")"
rm -f "${script_err}"

# Then
# assert_contains: error includes absolute path which varies per machine
e2e::assert_contains "${script_out}" "is not exported" "non-exported script reference produces export error"

e2e::pass "referencing non-exported script from module with exports"

# ---------------------------------------------------------------------------
e2e::section "exported workflow is accessible across imports"
# ---------------------------------------------------------------------------

# Given — reuse vis_lib.jh from above
e2e::file "vis_ok.jh" <<'EOF'
import "vis_lib.jh" as lib

workflow default() {
  run lib.public_wf()
}
EOF

# When
ok_out="$(e2e::run "vis_ok.jh")"

# Then — CLI tree output
e2e::expect_stdout "${ok_out}" <<'EOF'

Jaiph: Running vis_ok.jh

workflow default
  ▸ workflow public_wf
  ·   ℹ public
  ✓ workflow public_wf (<time>)

✓ PASS workflow default (<time>)
EOF

e2e::pass "exported workflow is accessible across imports"
