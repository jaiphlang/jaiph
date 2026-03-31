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
script greet {
  echo "hello-direct"
}

workflow helper {
  return run greet()
}

workflow default {
  const r = run helper()
  log "got: ${r}"
}
EOF

# When
return_run_out="$(e2e::run "return_run.jh")"

# Then
e2e::expect_stdout "${return_run_out}" <<'EOF'

Jaiph: Running return_run.jh

workflow default
  ▸ workflow helper
  ·   ▸ script greet
  ·   ✓ script greet (<time>)
  ✓ workflow helper (<time>)
  ℹ got: hello-direct
✓ PASS workflow default (<time>)
EOF

e2e::expect_out "return_run.jh" "greet" "hello-direct"

e2e::section "return ensure: direct return of rule result"

# Given
e2e::file "return_ensure.jh" <<'EOF'
script check_impl {
  echo "rule-ok"
}

rule check {
  return run check_impl()
}

workflow default {
  const r = ensure check()
  log "got: ${r}"
}
EOF

# When
return_ensure_out="$(e2e::run "return_ensure.jh")"

# Then
e2e::expect_stdout "${return_ensure_out}" <<'EOF'

Jaiph: Running return_ensure.jh

workflow default
  ▸ rule check
  ·   ▸ script check_impl
  ·   ✓ script check_impl (<time>)
  ✓ rule check (<time>)
  ℹ got: rule-ok
✓ PASS workflow default (<time>)
EOF

e2e::expect_out "return_ensure.jh" "check_impl" "rule-ok"

e2e::section "return run with args"

# Given
e2e::file "return_run_args.jh" <<'EOF'
script echo_arg {
  echo "$1"
}

workflow helper {
  return run echo_arg("passed-arg")
}

workflow default {
  const r = run helper()
  log "got: ${r}"
}
EOF

# When
return_run_args_out="$(e2e::run "return_run_args.jh")"

# Then
e2e::expect_stdout "${return_run_args_out}" <<'EOF'

Jaiph: Running return_run_args.jh

workflow default
  ▸ workflow helper
  ·   ▸ script echo_arg (1="passed-arg")
  ·   ✓ script echo_arg (<time>)
  ✓ workflow helper (<time>)
  ℹ got: passed-arg
✓ PASS workflow default (<time>)
EOF

e2e::expect_out "return_run_args.jh" "echo_arg" "passed-arg"

e2e::section "return ensure in rule"

# Given
e2e::file "return_ensure_rule.jh" <<'EOF'
rule inner {
  return "inner-val"
}

rule outer {
  return ensure inner()
}

workflow default {
  const r = ensure outer()
  log "got: ${r}"
}
EOF

# When
return_ensure_rule_out="$(e2e::run "return_ensure_rule.jh")"

# Then
e2e::expect_stdout "${return_ensure_rule_out}" <<'EOF'

Jaiph: Running return_ensure_rule.jh

workflow default
  ▸ rule outer
  ·   ▸ rule inner
  ·   ✓ rule inner (<time>)
  ✓ rule outer (<time>)
  ℹ got: inner-val
✓ PASS workflow default (<time>)
EOF

e2e::section "return run with unknown ref fails at compile time"

# Given
e2e::file "return_run_unknown.jh" <<'EOF'
workflow default {
  return run nonexistent()
}
EOF

# When/Then
if jaiph run "${TEST_DIR}/return_run_unknown.jh" >/dev/null 2>&1; then
  e2e::fail "expected compile-time failure for unknown run ref"
fi
e2e::pass "return run with unknown ref rejected"
