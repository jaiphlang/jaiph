#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "inbox_dispatch"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"
# Ensure the e2e-installed stdlib is used, not a system-wide override.
unset JAIPH_STDLIB

e2e::section "Basic send + route"
# Given
cat > "${TEST_DIR}/basic_inbox.jh" <<'EOF'
workflow sender {
  echo "hello from sender" -> greetings
}

workflow receiver {
  echo "$1" > received.txt
}

workflow default {
  run sender
  on greetings -> receiver
}
EOF

# When
jaiph build "${TEST_DIR}/basic_inbox.jh"
jaiph run "${TEST_DIR}/basic_inbox.jh" >/dev/null

# Then
e2e::assert_file_exists "${TEST_DIR}/received.txt" "receiver was invoked by inbox dispatch"
e2e::assert_contains "$(cat "${TEST_DIR}/received.txt")" "hello from sender" "receiver gets message content via inbox route"

e2e::section "Multi-target route"
# Given
cat > "${TEST_DIR}/multi_target.jh" <<'EOF'
workflow producer {
  echo "data-payload" -> results
}

workflow consumer_a {
  echo "A got: $1" > consumer_a.txt
}

workflow consumer_b {
  echo "B got: $1" > consumer_b.txt
}

workflow default {
  run producer
  on results -> consumer_a, consumer_b
}
EOF

# When
jaiph build "${TEST_DIR}/multi_target.jh"
jaiph run "${TEST_DIR}/multi_target.jh" >/dev/null

# Then
e2e::assert_file_exists "${TEST_DIR}/consumer_a.txt" "consumer_a was dispatched"
e2e::assert_contains "$(cat "${TEST_DIR}/consumer_a.txt")" "A got: data-payload" "consumer_a receives dispatched message"
e2e::assert_file_exists "${TEST_DIR}/consumer_b.txt" "consumer_b was dispatched"
e2e::assert_contains "$(cat "${TEST_DIR}/consumer_b.txt")" "B got: data-payload" "consumer_b receives dispatched message"

e2e::section "Silent drop on unregistered channel"
# Given: a workflow that sends to an unrouted channel while having at least one
# route registered (so that inbox_init / drain_queue are emitted by the transpiler).
cat > "${TEST_DIR}/unrouted_drop.jh" <<'EOF'
workflow sender {
  echo "dropped" -> unknown_channel
}

workflow dummy {
  echo "never called" > dummy.txt
}

workflow default {
  run sender
  on some_channel -> dummy
}
EOF

# When
jaiph build "${TEST_DIR}/unrouted_drop.jh"
drop_stderr="$(mktemp)"
jaiph run "${TEST_DIR}/unrouted_drop.jh" >/dev/null 2>"${drop_stderr}" || true
drop_exit=$?
drop_err="$(cat "${drop_stderr}")"
rm -f "${drop_stderr}"

# Then
if [[ ${drop_exit} -ne 0 ]]; then
  printf "Expected exit 0 but got %d\nstderr: %s\n" "${drop_exit}" "${drop_err}" >&2
  e2e::fail "unrouted channel send should exit 0"
fi
e2e::pass "unrouted channel send exits 0 (silent drop)"
if [[ -f "${TEST_DIR}/dummy.txt" ]]; then
  e2e::fail "dummy workflow should not have been called"
fi
e2e::pass "unrouted channel does not dispatch to other routes"

e2e::section "Inbox file written"
# Given
cat > "${TEST_DIR}/inbox_file.jh" <<'EOF'
workflow writer {
  echo "inbox-content-check" -> audit
}

workflow auditor {
  echo "$1" > audited.txt
}

workflow default {
  run writer
  on audit -> auditor
}
EOF

# When
jaiph build "${TEST_DIR}/inbox_file.jh"
jaiph run "${TEST_DIR}/inbox_file.jh" >/dev/null

# Then: find 001-audit.txt in any inbox directory under .jaiph/runs
inbox_file="$(find "${TEST_DIR}/.jaiph/runs" -path '*/inbox/001-audit.txt' 2>/dev/null | head -1)"
if [[ -z "${inbox_file}" ]]; then
  e2e::fail "001-audit.txt not found in any inbox directory"
fi
e2e::assert_file_exists "${inbox_file}" "inbox file 001-audit.txt exists after send"
e2e::assert_contains "$(cat "${inbox_file}")" "inbox-content-check" "inbox file contains sent message"

e2e::section "Dispatched step CLI output shows channel and message"
# Given
cat > "${TEST_DIR}/display_inbox.jh" <<'EOF'
workflow scanner {
  echo "Found 3 issues in auth module" -> findings
}

workflow analyst {
  echo "Summary: $1" -> report
}

workflow reviewer {
  echo "[reviewed] $1"
}

workflow default {
  run scanner
  on findings -> analyst
  on report -> reviewer
}
EOF

# When
jaiph build "${TEST_DIR}/display_inbox.jh"
display_out="$(jaiph run "${TEST_DIR}/display_inbox.jh" 2>/dev/null)"
normalized="$(e2e::normalize_output "${display_out}")"

# Then: full tree output for dispatched steps
expected_display=$(printf '%s\n' \
  '' \
  'Jaiph: Running display_inbox.jh' \
  '' \
  'workflow default' \
  '  ▸ workflow scanner' \
  '  ✓ <time>' \
  '  ▸ workflow analyst (findings, "Found 3 issues in auth module")' \
  '  ✓ <time>' \
  '  ▸ workflow reviewer (report, "Summary: Found 3 issues in auth ...")' \
  '  ✓ <time>' \
  '    [reviewed] Summary: Found 3 issues in auth module' \
  '✓ PASS workflow default (<time>)')
expected_display="${expected_display%$'\n'}"
e2e::assert_output_equals "${display_out}" "${expected_display}" "dispatched step tree output with channels and stdout"
