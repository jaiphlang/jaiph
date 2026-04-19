#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "run_recover_loop"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "recover: success on first attempt skips repair block"

# Given
e2e::file "recover_ok.jh" <<'EOF'
script ok_impl = `echo "first-try"`

workflow fragile() {
  run ok_impl()
}

workflow default() {
  run fragile() recover(err) {
    log "should not run"
  }
}
EOF

# When
out="$(e2e::run "recover_ok.jh" 2>&1)"

# Then — repair block never runs
e2e::expect_stdout "${out}" <<'EOF'

Jaiph: Running recover_ok.jh

workflow default
  ▸ workflow fragile
  ·   ▸ script ok_impl
  ·   ✓ script ok_impl (<time>)
  ✓ workflow fragile (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "recover: success on first attempt skips repair block"

e2e::section "recover: repair loop retries until success"
rm -f "${TEST_DIR}/attempt_counter.txt"

# Given — fragile fails twice then succeeds on third attempt
e2e::file "recover_retry.jh" <<'EOF'
script fragile_impl = ```
count=0
if [ -f attempt_counter.txt ]; then
  count=$(cat attempt_counter.txt)
fi
count=$((count + 1))
echo "$count" > attempt_counter.txt
if [ "$count" -lt 3 ]; then
  echo "failing attempt $count" >&2
  exit 1
fi
echo "success on attempt $count"
```

script repair_impl = `echo "repairing"`

workflow fragile() {
  run fragile_impl()
}

workflow repair() {
  run repair_impl()
}

workflow default() {
  run fragile() recover(err) {
    run repair()
  }
}
EOF

# When
out_retry="$(e2e::run "recover_retry.jh" 2>&1)"

# Then — counter shows 3 attempts (two failures + one success)
e2e::assert_equals "$(cat "${TEST_DIR}/attempt_counter.txt")" "3" "fragile ran 3 times"
e2e::assert_contains "${out_retry}" "PASS" "workflow passes after retries"
e2e::pass "recover: repair loop retries until success"

e2e::section "recover: retry limit exhaustion fails the step"
rm -f "${TEST_DIR}/exhaust_counter.txt"

# Given — always fails, limit set to 2
e2e::file "recover_exhaust.jh" <<'EOF'
config {
  run.recover_limit = 2
}

script always_fail_impl = ```
count=0
if [ -f exhaust_counter.txt ]; then
  count=$(cat exhaust_counter.txt)
fi
count=$((count + 1))
echo "$count" > exhaust_counter.txt
echo "attempt $count failed" >&2
exit 1
```

script repair_impl2 = `echo "repairing"`

workflow always_fail() {
  run always_fail_impl()
}

workflow repair() {
  run repair_impl2()
}

workflow default() {
  run always_fail() recover(err) {
    run repair()
  }
}
EOF

# When
set +e
out_exhaust="$(e2e::run "recover_exhaust.jh" 2>&1)"
exit_exhaust=$?
set -e

# Then — exits 1 after exactly 2 attempts (recover_limit = 2)
e2e::assert_equals "${exit_exhaust}" "1" "jaiph run exits 1 when retry limit exhausted"
e2e::assert_equals "$(cat "${TEST_DIR}/exhaust_counter.txt")" "2" "fragile ran exactly 2 times (limit)"
e2e::pass "recover: retry limit exhaustion fails the step"

e2e::section "recover: config override changes retry limit"
rm -f "${TEST_DIR}/limit_counter.txt"

# Given — limit set to 4
e2e::file "recover_limit.jh" <<'EOF'
config {
  run.recover_limit = 4
}

script flaky_impl = ```
count=0
if [ -f limit_counter.txt ]; then
  count=$(cat limit_counter.txt)
fi
count=$((count + 1))
echo "$count" > limit_counter.txt
if [ "$count" -lt 4 ]; then
  echo "failing" >&2
  exit 1
fi
echo "ok"
```

script fix_impl = `echo "fixing"`

workflow flaky() {
  run flaky_impl()
}

workflow fix() {
  run fix_impl()
}

workflow default() {
  run flaky() recover(err) {
    run fix()
  }
}
EOF

# When
out_limit="$(e2e::run "recover_limit.jh" 2>&1)"

# Then — 4 attempts needed (3 failures + 1 success), all within limit of 4
e2e::assert_equals "$(cat "${TEST_DIR}/limit_counter.txt")" "4" "fragile ran 4 times (custom limit)"
e2e::assert_contains "${out_limit}" "PASS" "workflow passes within custom limit"
e2e::pass "recover: config override changes retry limit"
