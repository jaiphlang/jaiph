#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "file_shorthand_routing"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ==========================================================================
# Section 1: jaiph ./file.jh routes to run
# ==========================================================================

e2e::section "jaiph ./file.jh routes to run"

e2e::file "hello.jh" <<'EOF'
script hello_impl = `echo "hello-shorthand"`
workflow default() {
  const msg = run hello_impl()
  return "${msg}"
}
EOF

hello_out="$(e2e::run "hello.jh")"

e2e::expect_stdout "${hello_out}" <<'EOF'

Jaiph: Running hello.jh

workflow default
  ▸ script hello_impl
  ✓ script hello_impl (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out "hello.jh" "hello_impl" "hello-shorthand"

e2e::pass "file shorthand routes .jh to run"

# ==========================================================================
# Section 2: jaiph ./file.test.jh routes to test
# ==========================================================================

e2e::section "jaiph ./file.test.jh routes to test"

e2e::file "lib.jh" <<'EOF'
export workflow greet() {
  log "hello from lib"
}
EOF

e2e::file "lib.test.jh" <<'EOF'
import "lib.jh" as lib

test "greet logs message" {
  const out = run lib.greet()
  expect_contain out "hello from lib"
}
EOF

set +e
test_out="$(jaiph "${TEST_DIR}/lib.test.jh" 2>&1)"
test_exit=$?
set -e

e2e::assert_equals "${test_exit}" "0" "test shorthand exits 0 on passing test"
# assert_contains: output includes dynamic timing and path info
# assert_contains: output format may vary between versions
e2e::assert_contains "${test_out}" "passed" "test shorthand shows passing result"

e2e::pass "file shorthand routes .test.jh to test"

# ==========================================================================
# Section 3: jaiph test <dir> discovers .test.jh recursively
# ==========================================================================

e2e::section "jaiph test <dir> recursive discovery"

mkdir -p "${TEST_DIR}/subdir"

e2e::file "subdir/inner_lib.jh" <<'EOF'
export workflow inner() {
  log "inner workflow"
}
EOF

cat > "${TEST_DIR}/subdir/inner_lib.test.jh" <<'EOF'
import "inner_lib.jh" as lib

test "inner test" {
  const out = run lib.inner()
  expect_contain out "inner workflow"
}
EOF

set +e
dir_out="$(jaiph test "${TEST_DIR}/subdir" 2>&1)"
dir_exit=$?
set -e

e2e::assert_equals "${dir_exit}" "0" "directory test discovery exits 0"
# assert_contains: output includes dynamic timing
# assert_contains: output format may vary between versions
e2e::assert_contains "${dir_out}" "passed" "directory test discovery finds and runs tests"

e2e::pass "jaiph test <dir> discovers .test.jh recursively"

# ==========================================================================
# Section 4: jaiph test on non-existent file
# ==========================================================================

e2e::section "jaiph test on non-existent file"

set +e
missing_out="$(jaiph test "${TEST_DIR}/does_not_exist.test.jh" 2>&1)"
missing_exit=$?
set -e

if [[ ${missing_exit} -eq 0 ]]; then
  printf "%s\n" "${missing_out}" >&2
  e2e::fail "jaiph test on non-existent file should exit non-zero"
fi
# assert_contains: error message includes dynamic file path
e2e::assert_contains "${missing_out}" "no such file" \
  "jaiph test on non-existent file reports error"

e2e::pass "jaiph test on non-existent file fails gracefully"

# ==========================================================================
# Section 5: jaiph run on non-existent .jh file (already in 122, verify shorthand)
# ==========================================================================

e2e::section "shorthand with non-existent .jh routes to run and fails"

set +e
missing_jh_out="$(jaiph "${TEST_DIR}/ghost.jh" 2>&1)"
missing_jh_exit=$?
set -e

if [[ ${missing_jh_exit} -eq 0 ]]; then
  printf "%s\n" "${missing_jh_out}" >&2
  e2e::fail "shorthand with non-existent .jh should exit non-zero"
fi

e2e::pass "shorthand with non-existent .jh fails"
