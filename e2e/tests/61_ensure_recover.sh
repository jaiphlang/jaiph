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

expected_single=$(printf '%s\n' \
  '' \
  'Jaiph: Running retry_single.jh' \
  '' \
  'workflow default' \
  '  ▸ rule dep' \
  '  ✗ <time>' \
  '  ▸ workflow install_deps' \
  '  ✓ <time>' \
  '  ▸ rule dep' \
  '  ✓ <time>' \
  '  ▸ rule dep' \
  '  ✓ <time>' \
  '✓ PASS workflow default (<time>)')
expected_single="${expected_single%$'\n'}"
e2e::assert_output_equals "${out}" "${expected_single}" "ensure/recover single-statement tree output"

e2e::pass "ensure dep recover run install_deps: retry until success"

# Assert no .out files for retry_single.jh (touch and test produce no stdout)
shopt -s nullglob
retry_single_run_dir=( "${TEST_DIR}/.jaiph/runs/"*/*retry_single.jh/ )
[[ ${#retry_single_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for retry_single.jh"
retry_single_out_files=( "${retry_single_run_dir[0]}"*.out )
shopt -u nullglob
[[ ${#retry_single_out_files[@]} -eq 0 ]] || e2e::fail "expected no .out files for retry_single.jh, got ${#retry_single_out_files[@]}"

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
expected_block=$(printf '%s\n' \
  '' \
  'Jaiph: Running retry_block.jh' \
  '' \
  'workflow default' \
  '  ▸ rule ready' \
  '  ✗ <time>' \
  '  ▸ rule ready' \
  '  ✓ <time>' \
  '  ▸ rule ready' \
  '  ✓ <time>' \
  '✓ PASS workflow default (<time>)')
expected_block="${expected_block%$'\n'}"
e2e::assert_output_equals "${out_block}" "${expected_block}" "ensure/recover block tree output"

e2e::pass "ensure ready recover { echo ...; touch ...; }: block runs until condition passes"

# Assert no .out files for retry_block.jh (echo redirected to file, touch/test produce no stdout)
shopt -s nullglob
retry_block_run_dir=( "${TEST_DIR}/.jaiph/runs/"*/*retry_block.jh/ )
[[ ${#retry_block_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for retry_block.jh"
retry_block_out_files=( "${retry_block_run_dir[0]}"*.out )
shopt -u nullglob
[[ ${#retry_block_out_files[@]} -eq 0 ]] || e2e::fail "expected no .out files for retry_block.jh, got ${#retry_block_out_files[@]}"

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
