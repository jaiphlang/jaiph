#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "lang_redesign_constructs"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
# const declarations
# ---------------------------------------------------------------------------
e2e::section "const with string value"

e2e::file "const_string.jh" <<'EOF'
export def main() {
  const msg = "hello-world"
  log "${msg}"
}
EOF

out="$(e2e::run "const_string.jh")"

e2e::expect_stdout "${out}" <<'EXPECTED'

Jaiph: Running const_string.jh

export def main
  ℹ hello-world

✓ PASS export def main (<time>)
EXPECTED

# ---------------------------------------------------------------------------
e2e::section "const with run capture"

e2e::file "const_run.jh" <<'EOF'
script greet = `echo "hi from fn"`

export def main() {
  const val = run greet()
  log "${val}"
}
EOF

out="$(e2e::run "const_run.jh")"

e2e::expect_stdout "${out}" <<'EXPECTED'

Jaiph: Running const_run.jh

export def main
  ▸ script greet
  ✓ script greet (<time>)
  ℹ hi from fn

✓ PASS export def main (<time>)
EXPECTED

# ---------------------------------------------------------------------------
e2e::section "const with run capture"

e2e::file "const_ensure.jh" <<'EOF'
def always_pass() {
  return "rule-val"
}

export def main() {
  const r = run always_pass()
  log "${r}"
}
EOF

out="$(e2e::run "const_ensure.jh")"

e2e::expect_stdout "${out}" <<'EXPECTED'

Jaiph: Running const_ensure.jh

export def main
  ▸ def always_pass
  ✓ def always_pass(<time>)
  ℹ rule-val

✓ PASS export def main (<time>)
EXPECTED

# ---------------------------------------------------------------------------
e2e::section "const rejects command substitution"

e2e::file "const_bad_subst.jh" <<'EOF'
export def main() {
  const x = "$(echo bad)"
  log "${x}"
}
EOF

set +e
bad_out="$(e2e::run "const_bad_subst.jh" 2>&1)"
bad_code=$?
set -e

[[ ${bad_code} -ne 0 ]] || e2e::fail "const with \$(...) should fail to build"
# assert_contains: compile error includes absolute source path which varies per invocation
e2e::assert_contains "${bad_out}" 'command substitution' "error mentions command substitution"

# ---------------------------------------------------------------------------
# wait step
# ---------------------------------------------------------------------------
e2e::section "wait step joins async run"

e2e::file "wait_step.jh" <<'EOF'
script write_marker = `echo "waited" > waited.txt`

def bg_job() {
  run write_marker()
}

export def main() {
  run async bg_job()
  log "wait-done"
}
EOF

out="$(e2e::run "wait_step.jh")"

e2e::expect_stdout "${out}" <<'EXPECTED'

Jaiph: Running wait_step.jh

export def main
 ₁▸ def bg_job
 ₁·   ▸ script write_marker
  ℹ wait-done
 ₁·   ✓ script write_marker (<time>)
 ₁✓ def bg_job(<time>)

✓ PASS export def main (<time>)
EXPECTED
e2e::assert_file_exists "${TEST_DIR}/waited.txt" "async job wrote marker file"

# ---------------------------------------------------------------------------
# run ... catch
# ---------------------------------------------------------------------------
e2e::section "run with catch on failure"

e2e::file "ensure_recover.jh" <<'EOF'
script always_fail_impl = `false`
def always_fail() {
  run always_fail_impl()
}

export def main() {
  run always_fail() catch (err) {
    log "recovered"
  }
  log "continued"
}
EOF

out="$(e2e::run "ensure_recover.jh")"

e2e::expect_stdout "${out}" <<'EXPECTED'

Jaiph: Running ensure_recover.jh

export def main
  ▸ def always_fail
  ·   ▸ script always_fail_impl
  ·   ✗ script always_fail_impl (<time>)
  ✗ def always_fail(<time>)
  ℹ recovered
  ℹ continued

✓ PASS export def main (<time>)
EXPECTED

# ---------------------------------------------------------------------------
e2e::section "run with catch on failure"

e2e::file "run_recover.jh" <<'EOF'
script returns_false = `return 1`

export def main() {
  run returns_false() catch (err) {
    log "else-branch-ok"
  }
}
EOF

out="$(e2e::run "run_recover.jh")"

e2e::expect_stdout "${out}" <<'EXPECTED'

Jaiph: Running run_recover.jh

export def main
  ▸ script returns_false
  ✗ script returns_false (<time>)
  ℹ else-branch-ok

✓ PASS export def main (<time>)
EXPECTED

# ---------------------------------------------------------------------------
# structured rules: run ... catch + fail inside rules
# ---------------------------------------------------------------------------
e2e::section "structured rule with run catch and fail"

e2e::file "structured_rule.jh" <<'EOF'
script check_ok = `return 0`

def require_name() {
  run check_ok() catch (err) {
    fail "name is required"
  }
}

export def main() {
  run require_name()
  log "passed"
}
EOF

out="$(e2e::run "structured_rule.jh")"

e2e::expect_stdout "${out}" <<'EXPECTED'

Jaiph: Running structured_rule.jh

export def main
  ▸ def require_name
  ·   ▸ script check_ok
  ·   ✓ script check_ok (<time>)
  ✓ def require_name(<time>)
  ℹ passed

✓ PASS export def main (<time>)
EXPECTED

# ---------------------------------------------------------------------------
e2e::section "structured rule fails correctly"

e2e::file "structured_rule_fail.jh" <<'EOF'
script check_fail = `return 1`

def require_name() {
  run check_fail() catch (err) {
    fail "name is required"
  }
}

export def main() {
  run require_name()
}
EOF

set +e
out="$(e2e::run "structured_rule_fail.jh" 2>&1)"
code=$?
set -e

[[ ${code} -ne 0 ]] || e2e::fail "structured rule should have failed"
# Detailed failure excerpts suppress the generic summary line (resolveFailureDetails).
e2e::assert_contains "${out}" "FAIL export def main" "structured rule failure footer"
e2e::assert_contains "${out}" "name is required" "fail() output surfaces under failed step"

# ---------------------------------------------------------------------------
e2e::section "run targeting workflow inside rule is rejected"

e2e::file "run_wf_in_rule.jh" <<'EOF'
def helper() {
  log "nope"
}

def bad() {
  run helper()
}

export def main() {
  run bad()
}
EOF

set +e
out="$(e2e::run "run_wf_in_rule.jh" 2>&1)"
code=$?
set -e

[[ ${code} -ne 0 ]] || e2e::fail "run workflow inside rule should be rejected"
# assert_contains: runtime validation error includes absolute source path which varies per invocation
e2e::assert_contains "${out}" "script" "error guides toward script"

# ---------------------------------------------------------------------------
# module-level const
# ---------------------------------------------------------------------------
e2e::section "module-level const"

e2e::file "module_const.jh" <<'EOF'
const greeting = "module-const-works"

export def main() {
  log "${greeting}"
}
EOF

out="$(e2e::run "module_const.jh")"

e2e::expect_stdout "${out}" <<'EXPECTED'

Jaiph: Running module_const.jh

export def main
  ℹ module-const-works

✓ PASS export def main (<time>)
EXPECTED
