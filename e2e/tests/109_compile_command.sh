#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "compile_command"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "jaiph compile succeeds on valid module"

e2e::file "ok.jh" <<'EOF'
workflow default() {
  log "hello"
}
EOF

jaiph compile "${TEST_DIR}/ok.jh"
e2e::pass "compile exits 0"

e2e::section "jaiph compile fails on validation error"

e2e::file "bad.jh" <<'EOF'
workflow default() {
  run missing_workflow()
}
EOF

compile_exit=0
jaiph compile "${TEST_DIR}/bad.jh" 2>/dev/null || compile_exit=$?
e2e::assert_equals "${compile_exit}" "1" "compile exits 1 on unknown workflow"

e2e::section "jaiph compile --json prints empty array on success"

out="$(jaiph compile --json "${TEST_DIR}/ok.jh")"
e2e::assert_equals "${out}" "[]" "json success is []"

e2e::section "jaiph compile --json prints diagnostic array on failure"

out2="$(jaiph compile --json "${TEST_DIR}/bad.jh" 2>/dev/null || true)"
if ! echo "${out2}" | grep -q '"code"'; then
  echo "expected JSON with code field, got: ${out2}" >&2
  exit 1
fi
if ! echo "${out2}" | grep -q "E_VALIDATE"; then
  echo "expected E_VALIDATE in json, got: ${out2}" >&2
  exit 1
fi
e2e::pass "json failure includes E_VALIDATE"
