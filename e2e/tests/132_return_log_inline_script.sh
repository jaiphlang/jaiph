#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "return_log_inline_script"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "return run inline script zero-arg"
# ---------------------------------------------------------------------------

e2e::file "return_inline.jh" <<'EOF'
def helper() {
  return `echo inline-return-ok`()
}

export def main() {
  const r = helper()
  log "got: ${r}"
}
EOF

return_inline_out="$(e2e::run "return_inline.jh")"

# assert_contains: inline script hash name is content-dependent and not predictable in heredoc
e2e::assert_contains "${return_inline_out}" "script __inline_" "tree shows inline script step"
e2e::assert_contains "${return_inline_out}" "got: inline-return-ok" "return run inline script returns correct value"
e2e::assert_contains "${return_inline_out}" "PASS def main" "workflow passes"

e2e::pass "return run inline script zero-arg"

# ---------------------------------------------------------------------------
e2e::section "return run inline script with args"
# ---------------------------------------------------------------------------

e2e::file "return_inline_args.jh" <<'EOF'
def helper() {
  return `echo $1`("inline-arg-val")
}

export def main() {
  const r = helper()
  log "got: ${r}"
}
EOF

return_inline_args_out="$(e2e::run "return_inline_args.jh")"

# assert_contains: inline script hash name is content-dependent and not predictable in heredoc
e2e::assert_contains "${return_inline_args_out}" "got: inline-arg-val" "return run inline script with args returns correct value"
e2e::assert_contains "${return_inline_args_out}" "PASS def main" "workflow passes"

e2e::pass "return run inline script with args"

# ---------------------------------------------------------------------------
e2e::section "log run inline script zero-arg"
# ---------------------------------------------------------------------------

e2e::file "log_inline.jh" <<'EOF'
export def main() {
  log `echo log-inline-ok`()
}
EOF

log_inline_out="$(e2e::run "log_inline.jh")"

# assert_contains: inline script hash name is content-dependent and not predictable in heredoc
e2e::assert_contains "${log_inline_out}" "script __inline_" "tree shows inline script step"
e2e::assert_contains "${log_inline_out}" "log-inline-ok" "log run inline script outputs correct message"
e2e::assert_contains "${log_inline_out}" "PASS def main" "workflow passes"

e2e::pass "log run inline script zero-arg"

# ---------------------------------------------------------------------------
e2e::section "log run inline script with args"
# ---------------------------------------------------------------------------

e2e::file "log_inline_args.jh" <<'EOF'
export def main() {
  log `echo $1`("log-arg-val")
}
EOF

log_inline_args_out="$(e2e::run "log_inline_args.jh")"

# assert_contains: inline script hash name is content-dependent and not predictable in heredoc
e2e::assert_contains "${log_inline_args_out}" "log-arg-val" "log run inline script with args outputs correct message"
e2e::assert_contains "${log_inline_args_out}" "PASS def main" "workflow passes"

e2e::pass "log run inline script with args"
