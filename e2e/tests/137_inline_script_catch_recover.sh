#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "inline_script_catch_recover"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "inline script catch: failing body, catch body runs once with merged output"
# ---------------------------------------------------------------------------

e2e::file "inline_catch.jh" <<'EOF'
workflow default() {
  run `echo "bad" 1>&2; exit 3`() catch (err) {
    log "caught: ${err}"
  }
}
EOF

catch_out="$(e2e::run "inline_catch.jh")"

# assert_contains: inline script hash name is content-dependent and not predictable in heredoc
e2e::assert_contains "${catch_out}" "script __inline_" "tree shows inline script step"
e2e::assert_contains "${catch_out}" "caught: bad" "catch body ran once with merged stdout+stderr bound"
e2e::assert_contains "${catch_out}" "PASS workflow default" "catch absorbed the failure"

e2e::pass "inline script catch: single-shot recovery"

# ---------------------------------------------------------------------------
e2e::section "inline script recover: retries until counter-file repair makes it pass"
# ---------------------------------------------------------------------------

COUNTER="${TEST_DIR}/inline_recover_counter"
rm -f "${COUNTER}" "${COUNTER}.done"

e2e::file "inline_recover.jh" <<EOF
workflow default() {
  run \`test -f "${COUNTER}.done"\`() recover(err) {
    run \`\`\`
count=\$(cat "${COUNTER}" 2>/dev/null || echo 0)
count=\$((count+1))
echo "\${count}" > "${COUNTER}"
if [ "\${count}" -ge 2 ]; then touch "${COUNTER}.done"; fi
\`\`\`()
  }
}
EOF

recover_out="$(e2e::run "inline_recover.jh")"

e2e::assert_file_exists "${COUNTER}.done" "recover body created the repair marker"
counter_value="$(cat "${COUNTER}")"
e2e::assert_equals "${counter_value}" "2" "recover ran exactly twice before the inline check passed"
e2e::assert_contains "${recover_out}" "PASS workflow default" "workflow passes after recover retries"

e2e::pass "inline script recover: retry loop with counter-file repair"

# ---------------------------------------------------------------------------
e2e::section "inline script catch in rule body"
# ---------------------------------------------------------------------------

e2e::file "inline_catch_rule.jh" <<'EOF'
script noop = `true`
rule gate() {
  run `exit 5`() catch (err) {
    run noop()
  }
}
workflow default() {
  ensure gate()
}
EOF

rule_out="$(e2e::run "inline_catch_rule.jh")"
e2e::assert_contains "${rule_out}" "PASS workflow default" "rule with inline-script catch passes"

e2e::pass "inline script catch in rule body"
