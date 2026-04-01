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
workflow default {
  const msg = "hello-world"
  log "${msg}"
}
EOF

out="$(e2e::run "const_string.jh")"
e2e::assert_contains "${out}" "hello-world" "const string value logged"

# ---------------------------------------------------------------------------
e2e::section "const with run capture"

e2e::file "const_run.jh" <<'EOF'
script greet = "echo \"hi from fn\""

workflow default {
  const val = run greet()
  log "${val}"
}
EOF

out="$(e2e::run "const_run.jh")"
e2e::assert_contains "${out}" "hi from fn" "const captured run stdout value"

# ---------------------------------------------------------------------------
e2e::section "const with ensure capture"

e2e::file "const_ensure.jh" <<'EOF'
rule always_pass {
  return "rule-val"
}

workflow default {
  const r = ensure always_pass()
  log "${r}"
}
EOF

out="$(e2e::run "const_ensure.jh")"
e2e::assert_contains "${out}" "rule-val" "const captured ensure return value"

# ---------------------------------------------------------------------------
e2e::section "const rejects command substitution"

e2e::file "const_bad_subst.jh" <<'EOF'
workflow default {
  const x = "$(echo bad)"
  log "${x}"
}
EOF

set +e
bad_out="$(e2e::run "const_bad_subst.jh" 2>&1)"
bad_code=$?
set -e

[[ ${bad_code} -ne 0 ]] || e2e::fail "const with \$(...) should fail to build"
e2e::assert_contains "${bad_out}" 'command substitution' "error mentions command substitution"

# ---------------------------------------------------------------------------
# wait step
# ---------------------------------------------------------------------------
e2e::section "wait step joins async run"

e2e::file "wait_step.jh" <<'EOF'
script write_marker = "echo \"waited\" > waited.txt"

workflow bg_job {
  run write_marker()
}

workflow default {
  run async bg_job()
  log "wait-done"
}
EOF

out="$(e2e::run "wait_step.jh")"
e2e::assert_contains "${out}" "wait-done" "wait step completed"
e2e::assert_file_exists "${TEST_DIR}/waited.txt" "async job wrote marker file"

# ---------------------------------------------------------------------------
# brace-style if
# ---------------------------------------------------------------------------
e2e::section "brace if with ensure (positive)"

e2e::file "brace_if_ensure.jh" <<'EOF'
script always_ok_impl = "true"
rule always_ok {
  run always_ok_impl()
}

workflow default {
  if ensure always_ok() {
    log "then-branch"
  }
}
EOF

out="$(e2e::run "brace_if_ensure.jh")"
e2e::assert_contains "${out}" "then-branch" "brace if ensure then-branch ran"

# ---------------------------------------------------------------------------
e2e::section "brace if not ensure (negated)"

e2e::file "brace_if_not.jh" <<'EOF'
script always_fail_impl = "false"
rule always_fail {
  run always_fail_impl()
}

workflow default {
  if not ensure always_fail() {
    log "negated-branch"
  }
}
EOF

out="$(e2e::run "brace_if_not.jh")"
e2e::assert_contains "${out}" "negated-branch" "brace if not ensure ran"

# ---------------------------------------------------------------------------
e2e::section "brace if with run + else"

e2e::file "brace_if_run_else.jh" <<'EOF'
script returns_false = "return 1"

workflow default {
  if run returns_false() {
    log "should-not-run"
  }
  else {
    log "else-branch-ok"
  }
}
EOF

out="$(e2e::run "brace_if_run_else.jh")"
e2e::assert_contains "${out}" "else-branch-ok" "brace if run else-branch ran"
if echo "${out}" | grep -q "should-not-run"; then
  e2e::fail "then-branch should not have run"
fi
e2e::pass "then-branch correctly skipped"

# ---------------------------------------------------------------------------
e2e::section "brace if with else if chain"

e2e::file "brace_if_chain.jh" <<'EOF'
script always_fail_impl = "false"
rule always_fail {
  run always_fail_impl()
}

script returns_ok = "true"

workflow default {
  if ensure always_fail() {
    log "first"
  }
  else if run returns_ok() {
    log "second-branch"
  }
  else {
    log "third"
  }
}
EOF

out="$(e2e::run "brace_if_chain.jh")"
e2e::assert_contains "${out}" "second-branch" "else if chain selected correct branch"

# ---------------------------------------------------------------------------
# structured rules: run + if + fail inside rules
# ---------------------------------------------------------------------------
e2e::section "structured rule with run and fail"

e2e::file "structured_rule.jh" <<'EOF'
script check_ok = "return 0"

rule require_name {
  if not run check_ok() {
    fail "name is required"
  }
}

workflow default {
  ensure require_name()
  log "passed"
}
EOF

out="$(e2e::run "structured_rule.jh")"
e2e::assert_contains "${out}" "passed" "structured rule passed with valid arg"

# ---------------------------------------------------------------------------
e2e::section "structured rule fails correctly"

e2e::file "structured_rule_fail.jh" <<'EOF'
script check_fail = "return 1"

rule require_name {
  if not run check_fail() {
    fail "name is required"
  }
}

workflow default {
  ensure require_name()
}
EOF

set +e
out="$(e2e::run "structured_rule_fail.jh" 2>&1)"
code=$?
set -e

[[ ${code} -ne 0 ]] || e2e::fail "structured rule should have failed"
e2e::assert_contains "${out}" "Workflow execution failed." "structured rule failure is reported"

# ---------------------------------------------------------------------------
e2e::section "run targeting workflow inside rule is rejected"

e2e::file "run_wf_in_rule.jh" <<'EOF'
workflow helper {
  log "nope"
}

rule bad {
  run helper()
}

workflow default {
  ensure bad()
}
EOF

set +e
out="$(e2e::run "run_wf_in_rule.jh" 2>&1)"
code=$?
set -e

[[ ${code} -ne 0 ]] || e2e::fail "run workflow inside rule should be rejected"
e2e::assert_contains "${out}" "script" "error guides toward script"

# ---------------------------------------------------------------------------
# module-level const
# ---------------------------------------------------------------------------
e2e::section "module-level const"

e2e::file "module_const.jh" <<'EOF'
const greeting = "module-const-works"

workflow default {
  log "${greeting}"
}
EOF

out="$(e2e::run "module_const.jh")"
e2e::assert_contains "${out}" "module-const-works" "module-level const accessible"
