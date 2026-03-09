#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "ensure ... recover ... (single statement) transpiles to bounded retry loop and retries until success"
rm -f "${TEST_DIR}/ready.txt"

cat > "${TEST_DIR}/retry_single.jh" <<'EOF'
rule dep {
  test -f ready.txt
}

workflow install_deps {
  touch ready.txt
}

workflow default {
  ensure dep recover run install_deps
}
EOF

jaiph build "${TEST_DIR}/retry_single.jh"
out="$(jaiph run "${TEST_DIR}/retry_single.jh" 2>&1)"
e2e::assert_file_exists "${TEST_DIR}/ready.txt" "recover ran and created ready.txt"

# Tree: rule dep (fail), workflow install_deps (recover), rule dep (pass)
e2e::assert_contains "${out}" "rule dep" "output mentions ensure rule"
e2e::assert_contains "${out}" "workflow install_deps" "output mentions recover workflow"
e2e::assert_contains "${out}" "PASS" "workflow passes"

e2e::pass "ensure dep recover run install_deps: retry until success"

e2e::section "ensure ... recover { stmt; stmt; } (block) runs multiple recover statements"
rm -f "${TEST_DIR}/ready2.txt" "${TEST_DIR}/recover_ran.txt"

cat > "${TEST_DIR}/retry_block.jh" <<'EOF'
rule ready {
  test -f ready2.txt
}

workflow default {
  ensure ready recover {
    echo "recovering" > recover_ran.txt
    touch ready2.txt
  }
}
EOF

jaiph build "${TEST_DIR}/retry_block.jh"
out_block="$(jaiph run "${TEST_DIR}/retry_block.jh" 2>&1)"
e2e::assert_file_exists "${TEST_DIR}/ready2.txt" "recover block ran and created ready2.txt"
e2e::assert_file_exists "${TEST_DIR}/recover_ran.txt" "recover block first statement ran"
e2e::assert_contains "$(cat "${TEST_DIR}/recover_ran.txt")" "recovering" "recover block echoed into file"
e2e::assert_contains "${out_block}" "PASS" "workflow passes"

e2e::pass "ensure ready recover { echo ...; touch ...; }: block runs until condition passes"

e2e::section "ensure ... recover exits 1 when max retries exceeded"
cat > "${TEST_DIR}/retry_fail.jh" <<'EOF'
rule never_ok {
  test -f never_created.txt
}

workflow install_deps {
  touch ready.txt
}

workflow default {
  ensure never_ok recover run install_deps
}
EOF

# install_deps creates ready.txt, not never_created.txt, so condition never passes
jaiph build "${TEST_DIR}/retry_fail.jh"
set +e
out_fail="$(JAIPH_ENSURE_MAX_RETRIES=2 jaiph run "${TEST_DIR}/retry_fail.jh" 2>&1)"
exit_fail=$?
set -e
e2e::assert_equals "${exit_fail}" "1" "jaiph run exits 1 when ensure condition never passes within max retries"
e2e::assert_contains "${out_fail}" "ensure condition did not pass after" "stderr mentions retry limit"
e2e::pass "ensure ... recover: exit 1 after JAIPH_ENSURE_MAX_RETRIES"
