#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "ensure ... recover ... (single statement) runs once on failure"
rm -f "${TEST_DIR}/ready.txt"

# Given
e2e::file "retry_single.jh" <<'EOF'
script dep_impl = ```
test -f "ready.txt"
```
rule dep() {
  run dep_impl()
}

script install_deps_impl = ```
touch "ready.txt"
```
workflow install_deps() {
  run install_deps_impl()
}

workflow default() {
  ensure dep() recover (failure) run install_deps()
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
  ·   ▸ script dep_impl
  ·   ✗ script dep_impl (<time>)
  ✗ rule dep (<time>)
  ▸ workflow install_deps
  ·   ▸ script install_deps_impl
  ·   ✓ script install_deps_impl (<time>)
  ✓ workflow install_deps (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "ensure dep recover run install_deps: recover runs once on failure"
e2e::expect_out_files "retry_single.jh" 5

e2e::section "ensure ... recover { stmt; stmt; } (block) runs multiple recover statements once"
rm -f "${TEST_DIR}/ready2.txt" "${TEST_DIR}/recover_ran.txt"

# Given
e2e::file "retry_block.jh" <<'EOF'
script ready_impl = `test -f ready2.txt`
rule ready() {
  run ready_impl()
}

script recover_echo = ```
echo "recovering" > recover_ran.txt
```
script recover_touch = `touch ready2.txt`

workflow default() {
  ensure ready() recover (failure) {
    run recover_echo()
    run recover_touch()
  }
}
EOF

# When
out_block="$(e2e::run "retry_block.jh" 2>&1)"

# Then
e2e::assert_file_exists "${TEST_DIR}/ready2.txt" "recover block ran and created ready2.txt"
e2e::assert_file_exists "${TEST_DIR}/recover_ran.txt" "recover block first statement ran"
e2e::assert_equals "$(cat "${TEST_DIR}/recover_ran.txt")" "recovering" "recover block echoed into file"

e2e::expect_stdout "${out_block}" <<'EOF'

Jaiph: Running retry_block.jh

workflow default
  ▸ rule ready
  ·   ▸ script ready_impl
  ·   ✗ script ready_impl (<time>)
  ✗ rule ready (<time>)
  ▸ script recover_echo
  ✓ script recover_echo (<time>)
  ▸ script recover_touch
  ✓ script recover_touch (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "ensure ready recover { echo ...; touch ...; }: block runs once on failure"
e2e::expect_out_files "retry_block.jh" 5

e2e::section "ensure without recover exits 1 on failure"

# Given
e2e::file "ensure_fail.jh" <<'EOF'
script never_ok_impl = `test -f never_created.txt`
rule never_ok() {
  run never_ok_impl()
}

workflow default() {
  ensure never_ok()
}
EOF

# When
set +e
out_fail="$(e2e::run "ensure_fail.jh" 2>&1)"
exit_fail=$?
set -e

# Then
e2e::assert_equals "${exit_fail}" "1" "jaiph run exits 1 when ensure fails without recover"
e2e::assert_contains "${out_fail}" "Workflow execution failed." "stderr reports workflow failure"
e2e::pass "ensure without recover: exit 1 on failure"

e2e::section "ensure ... recover { multiline prompt with param } parses and runs"

E2E_MOCK_BIN="${ROOT_DIR}/e2e/bin"
chmod 755 "${E2E_MOCK_BIN}/cursor-agent"
export PATH="${E2E_MOCK_BIN}:${PATH}"
rm -f "${TEST_DIR}/ready3.txt"

# Given: multiline prompt inside recover block with a $ci_log_file parameter
e2e::file "recover_multiline_prompt.jh" <<'EOF'
const ci_log_file = "/tmp/ci.log"

script check_ready_impl = `test -f ready3.txt`
rule check_ready() {
  run check_ready_impl()
}

script mark_ready3 = `touch ready3.txt`

workflow default() {
  ensure check_ready() recover (failure) {
    prompt "The CI build failed. Please inspect the log file at ${ci_log_file} and suggest a fix."
    run mark_ready3()
  }
}
EOF

# When
out_ml="$(e2e::run "recover_multiline_prompt.jh" 2>&1)"

# Then
e2e::assert_file_exists "${TEST_DIR}/ready3.txt" "recover with multiline prompt ran and created ready3.txt"
# assert_contains: prompt output includes dynamic agent command and response content
e2e::assert_contains "${out_ml}" "prompt" "output mentions prompt step"
e2e::pass "ensure ... recover { multiline prompt with param }: parses and runs"
