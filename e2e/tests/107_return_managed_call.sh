#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "return_managed_call"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "return run: direct return of workflow result"

# Given
e2e::file "return_run.jh" <<'EOF'
script greet = `echo "hello-direct"`

def helper() {
  return run greet()
}

export def main() {
  const r = run helper()
  log "got: ${r}"
}
EOF

# When
return_run_out="$(e2e::run "return_run.jh")"

# Then
e2e::expect_stdout "${return_run_out}" <<'EOF'

Jaiph: Running return_run.jh

export def main
  ▸ def helper
  ·   ▸ script greet
  ·   ✓ script greet (<time>)
  ✓ def helper(<time>)
  ℹ got: hello-direct
✓ PASS export def main (<time>)
EOF

e2e::expect_out "return_run.jh" "greet" "hello-direct"

e2e::section "return ensure: direct return of rule result"

# Given
e2e::file "return_ensure.jh" <<'EOF'
script check_impl = `echo "rule-ok"`

def check() {
  return run check_impl()
}

export def main() {
  const r = run check()
  log "got: ${r}"
}
EOF

# When
return_ensure_out="$(e2e::run "return_ensure.jh")"

# Then
e2e::expect_stdout "${return_ensure_out}" <<'EOF'

Jaiph: Running return_ensure.jh

export def main
  ▸ def check
  ·   ▸ script check_impl
  ·   ✓ script check_impl (<time>)
  ✓ def check(<time>)
  ℹ got: rule-ok
✓ PASS export def main (<time>)
EOF

e2e::expect_out "return_ensure.jh" "check_impl" "rule-ok"

e2e::section "return run with args"

# Given
e2e::file "return_run_args.jh" <<'EOF'
script echo_arg = `echo "$1"`

def helper() {
  return run echo_arg("passed-arg")
}

export def main() {
  const r = run helper()
  log "got: ${r}"
}
EOF

# When
return_run_args_out="$(e2e::run "return_run_args.jh")"

# Then
e2e::expect_stdout "${return_run_args_out}" <<'EOF'

Jaiph: Running return_run_args.jh

export def main
  ▸ def helper
  ·   ▸ script echo_arg (1="passed-arg")
  ·   ✓ script echo_arg (<time>)
  ✓ def helper(<time>)
  ℹ got: passed-arg
✓ PASS export def main (<time>)
EOF

e2e::expect_out "return_run_args.jh" "echo_arg" "passed-arg"

e2e::section "return run in rule"

# Given
e2e::file "return_ensure_rule.jh" <<'EOF'
def inner() {
  return "inner-val"
}

def outer() {
  return run inner()
}

export def main() {
  const r = run outer()
  log "got: ${r}"
}
EOF

# When
return_ensure_rule_out="$(e2e::run "return_ensure_rule.jh")"

# Then
e2e::expect_stdout "${return_ensure_rule_out}" <<'EOF'

Jaiph: Running return_ensure_rule.jh

export def main
  ▸ def outer
  ·   ▸ def inner
  ·   ✓ def inner(<time>)
  ✓ def outer(<time>)
  ℹ got: inner-val
✓ PASS export def main (<time>)
EOF

e2e::section "return run with unknown ref fails at compile time"

# Given
e2e::file "return_run_unknown.jh" <<'EOF'
export def main() {
  return run nonexistent()
}
EOF

# When/Then
if jaiph run "${TEST_DIR}/return_run_unknown.jh" >/dev/null 2>&1; then
  e2e::fail "expected compile-time failure for unknown run ref"
fi
e2e::pass "return run with unknown ref rejected"
