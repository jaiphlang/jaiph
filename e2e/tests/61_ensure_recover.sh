#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "ensure ... recover ... (single statement) transpiles to bounded retry loop and retries until success"
rm -f "${TEST_DIR}/ready.txt"

# Given
e2e::file "retry_single.jh" <<'EOF'
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

# When
out="$(e2e::run "retry_single.jh" 2>&1)"

# Then
e2e::assert_file_exists "${TEST_DIR}/ready.txt" "recover ran and created ready.txt"

e2e::expect_stdout "${out}" <<'EOF'

Jaiph: Running retry_single.jh

workflow default
  ▸ rule dep
  ✗ <time>
  ▸ workflow install_deps
  ✓ <time>
  ▸ rule dep
  ✓ <time>
  ▸ rule dep
  ✓ <time>
✓ PASS workflow default (<time>)
EOF

e2e::pass "ensure dep recover run install_deps: retry until success"
e2e::expect_out_files "retry_single.jh" 0

e2e::section "ensure ... recover { stmt; stmt; } (block) runs multiple recover statements"
rm -f "${TEST_DIR}/ready2.txt" "${TEST_DIR}/recover_ran.txt"

# Given
e2e::file "retry_block.jh" <<'EOF'
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

# When
out_block="$(e2e::run "retry_block.jh" 2>&1)"

# Then
e2e::assert_file_exists "${TEST_DIR}/ready2.txt" "recover block ran and created ready2.txt"
e2e::assert_file_exists "${TEST_DIR}/recover_ran.txt" "recover block first statement ran"
e2e::assert_contains "$(cat "${TEST_DIR}/recover_ran.txt")" "recovering" "recover block echoed into file"

e2e::expect_stdout "${out_block}" <<'EOF'

Jaiph: Running retry_block.jh

workflow default
  ▸ rule ready
  ✗ <time>
  ▸ rule ready
  ✓ <time>
  ▸ rule ready
  ✓ <time>
✓ PASS workflow default (<time>)
EOF

e2e::pass "ensure ready recover { echo ...; touch ...; }: block runs until condition passes"
e2e::expect_out_files "retry_block.jh" 0

e2e::section "ensure ... recover exits 1 when max retries exceeded"

# Given
e2e::file "retry_fail.jh" <<'EOF'
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

# When (install_deps creates ready.txt, not never_created.txt, so condition never passes)
set +e
out_fail="$(JAIPH_ENSURE_MAX_RETRIES=2 e2e::run "retry_fail.jh" 2>&1)"
exit_fail=$?
set -e

# Then
e2e::assert_equals "${exit_fail}" "1" "jaiph run exits 1 when ensure condition never passes within max retries"
e2e::assert_contains "${out_fail}" "ensure condition did not pass after" "stderr mentions retry limit"
e2e::pass "ensure ... recover: exit 1 after JAIPH_ENSURE_MAX_RETRIES"
