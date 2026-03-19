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
e2e::file "basic_inbox.jh" <<'EOF'
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
e2e::run "basic_inbox.jh" >/dev/null

# Then
e2e::assert_file_exists "${TEST_DIR}/received.txt" "receiver was invoked by inbox dispatch"
e2e::assert_contains "$(cat "${TEST_DIR}/received.txt")" "hello from sender" "receiver gets message content via inbox route"

e2e::section "Multi-target route"

# Given
e2e::file "multi_target.jh" <<'EOF'
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
e2e::run "multi_target.jh" >/dev/null

# Then
e2e::assert_file_exists "${TEST_DIR}/consumer_a.txt" "consumer_a was dispatched"
e2e::assert_contains "$(cat "${TEST_DIR}/consumer_a.txt")" "A got: data-payload" "consumer_a receives dispatched message"
e2e::assert_file_exists "${TEST_DIR}/consumer_b.txt" "consumer_b was dispatched"
e2e::assert_contains "$(cat "${TEST_DIR}/consumer_b.txt")" "B got: data-payload" "consumer_b receives dispatched message"

e2e::section "Silent drop on unregistered channel"

# Given
e2e::file "unrouted_drop.jh" <<'EOF'
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
drop_stderr="$(mktemp)"
e2e::run "unrouted_drop.jh" >/dev/null 2>"${drop_stderr}" || true
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
e2e::file "inbox_file.jh" <<'EOF'
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
e2e::run "inbox_file.jh" >/dev/null

# Then
inbox_file="$(find "${TEST_DIR}/.jaiph/runs" -path '*/inbox/001-audit.txt' 2>/dev/null | head -1)"
if [[ -z "${inbox_file}" ]]; then
  e2e::fail "001-audit.txt not found in any inbox directory"
fi
e2e::assert_file_exists "${inbox_file}" "inbox file 001-audit.txt exists after send"
e2e::assert_contains "$(cat "${inbox_file}")" "inbox-content-check" "inbox file contains sent message"

e2e::section "Dispatched step CLI output shows channel and message"

# Given
e2e::file "display_inbox.jh" <<'EOF'
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
display_out="$(e2e::run "display_inbox.jh" 2>/dev/null)"

# Then
e2e::expect_stdout "${display_out}" <<'EOF'

Jaiph: Running display_inbox.jh

workflow default
  ▸ workflow scanner
  ✓ <time>
  ▸ workflow analyst (findings, "Found 3 issues in auth module")
  ✓ <time>
  ▸ workflow reviewer (report, "Summary: Found 3 issues in auth ...")
  ✓ <time>
    [reviewed] Summary: Found 3 issues in auth module
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "display_inbox.jh" 1
e2e::expect_file "*display_inbox__reviewer.out" <<'EOF'
[reviewed] Summary: Found 3 issues in auth module
EOF
