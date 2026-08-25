#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "if_statement"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. if == triggers on exact match ────────────────────────────────────────

e2e::section "if == triggers on exact match"

e2e::file "if_eq.jh" <<'EOF'
export def main(param) {
  if param == "" {
    fail "param was not provided"
  }
  log "param is ${param}"
}
EOF

e2e::expect_fail "if_eq.jh"
e2e::pass "if == empty string triggers fail"

eq_out="$(e2e::run "if_eq.jh" "hello")"
e2e::expect_stdout "${eq_out}" <<'EOF'

Jaiph: Running if_eq.jh

def main (param="hello")
  ℹ param is hello

✓ PASS def main (<time>)
EOF
e2e::pass "if == non-match skips body"

# ── 2. if != skips on exact match ───────────────────────────────────────────

e2e::section "if != skips on exact match"

e2e::file "if_neq.jh" <<'EOF'
export def main(mode) {
  if mode != "production" {
    log "non-production mode: ${mode}"
  }
  log "done"
}
EOF

neq_out="$(e2e::run "if_neq.jh" "staging")"
e2e::expect_stdout "${neq_out}" <<'EOF'

Jaiph: Running if_neq.jh

def main (mode="staging")
  ℹ non-production mode: staging
  ℹ done

✓ PASS def main (<time>)
EOF
e2e::pass "if != triggers when values differ"

neq_prod_out="$(e2e::run "if_neq.jh" "production")"
e2e::expect_stdout "${neq_prod_out}" <<'EOF'

Jaiph: Running if_neq.jh

def main (mode="production")
  ℹ done

✓ PASS def main (<time>)
EOF
e2e::pass "if != skips when values match"

# ── 3. if =~ regex match ────────────────────────────────────────────────────

e2e::section "if =~ regex match"

e2e::file "if_regex.jh" <<'EOF'
export def main(name) {
  if name =~ /^feat-/ {
    log "feature branch detected"
  }
  log "branch: ${name}"
}
EOF

regex_out="$(e2e::run "if_regex.jh" "feat-login")"
e2e::expect_stdout "${regex_out}" <<'EOF'

Jaiph: Running if_regex.jh

def main (name="feat-login")
  ℹ feature branch detected
  ℹ branch: feat-login

✓ PASS def main (<time>)
EOF
e2e::pass "if =~ triggers on regex match"

regex_skip_out="$(e2e::run "if_regex.jh" "main")"
e2e::expect_stdout "${regex_skip_out}" <<'EOF'

Jaiph: Running if_regex.jh

def main (name="main")
  ℹ branch: main

✓ PASS def main (<time>)
EOF
e2e::pass "if =~ skips on regex non-match"

# ── 4. if !~ regex non-match ────────────────────────────────────────────────

e2e::section "if !~ regex non-match"

e2e::file "if_not_regex.jh" <<'EOF'
export def main(branch) {
  if branch !~ /^(main|master)$/ {
    log "not a release branch"
  }
  log "branch: ${branch}"
}
EOF

notregex_out="$(e2e::run "if_not_regex.jh" "feat-x")"
e2e::expect_stdout "${notregex_out}" <<'EOF'

Jaiph: Running if_not_regex.jh

def main (branch="feat-x")
  ℹ not a release branch
  ℹ branch: feat-x

✓ PASS def main (<time>)
EOF
e2e::pass "if !~ triggers when regex does not match"

notregex_main_out="$(e2e::run "if_not_regex.jh" "main")"
e2e::expect_stdout "${notregex_main_out}" <<'EOF'

Jaiph: Running if_not_regex.jh

def main (branch="main")
  ℹ branch: main

✓ PASS def main (<time>)
EOF
e2e::pass "if !~ skips when regex matches"

# ── 5. if with fail aborts the workflow ─────────────────────────────────────

e2e::section "if with fail aborts workflow"

e2e::file "if_fail.jh" <<'EOF'
export def main(input) {
  if input == "" {
    fail "input is required"
  }
  log "processing ${input}"
}
EOF

e2e::expect_fail "if_fail.jh"
# nondeterministic: run dir path contains timestamp
fail_out="$(e2e::run "if_fail.jh" 2>&1 || true)"
e2e::assert_contains "${fail_out}" "FAIL def main" "fail output shows FAIL"
e2e::pass "if + fail aborts workflow"

ok_out="$(e2e::run "if_fail.jh" "data")"
e2e::expect_stdout "${ok_out}" <<'EOF'

Jaiph: Running if_fail.jh

def main (input="data")
  ℹ processing data

✓ PASS def main (<time>)
EOF
e2e::pass "if condition false → body skipped, workflow continues"

# ── 6. if with return exits early ───────────────────────────────────────────

e2e::section "if with early return"

e2e::file "if_return.jh" <<'EOF'
export def main(skip) {
  if skip == "yes" {
    log "skipping"
    return ""
  }
  log "not skipping"
}
EOF

ret_skip_out="$(e2e::run "if_return.jh" "yes")"
e2e::expect_stdout "${ret_skip_out}" <<'EOF'

Jaiph: Running if_return.jh

def main (skip="yes")
  ℹ skipping

✓ PASS def main (<time>)
EOF
e2e::pass "if body return exits workflow early"

ret_no_out="$(e2e::run "if_return.jh" "no")"
e2e::expect_stdout "${ret_no_out}" <<'EOF'

Jaiph: Running if_return.jh

def main (skip="no")
  ℹ not skipping

✓ PASS def main (<time>)
EOF
e2e::pass "if body not taken → workflow continues"

# ── 7. if in rules ─────────────────────────────────────────────────────────

e2e::section "if in rules"

e2e::file "if_rule.jh" <<'EOF'
def validate(input) {
  if input == "" {
    fail "input must not be empty"
  }
  log "input ok: ${input}"
}

export def main(val) {
  run validate(val)
  log "validated"
}
EOF

e2e::expect_fail "if_rule.jh"
e2e::pass "if in rule triggers fail on empty"

rule_ok_out="$(e2e::run "if_rule.jh" "data")"
e2e::expect_stdout "${rule_ok_out}" <<'EOF'

Jaiph: Running if_rule.jh

def main (val="data")
  ▸ def validate (input="data")
  ·   ℹ input ok: data
  ✓ def validate (<time>)
  ℹ validated

✓ PASS def main (<time>)
EOF
e2e::pass "if in rule skips body when condition is false"
