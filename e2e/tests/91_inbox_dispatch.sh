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
channel greetings

workflow sender {
  greetings <- echo "hello from sender"
}

workflow receiver {
  echo "$1" > received.txt
}

workflow default {
  run sender
  greetings -> receiver
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
channel results

workflow producer {
  results <- echo "data-payload"
}

workflow consumer_a {
  echo "A got: $1" > consumer_a.txt
}

workflow consumer_b {
  echo "B got: $1" > consumer_b.txt
}

workflow default {
  run producer
  results -> consumer_a, consumer_b
}
EOF

# When
e2e::run "multi_target.jh" >/dev/null

# Then
e2e::assert_file_exists "${TEST_DIR}/consumer_a.txt" "consumer_a was dispatched"
e2e::assert_contains "$(cat "${TEST_DIR}/consumer_a.txt")" "A got: data-payload" "consumer_a receives dispatched message"
e2e::assert_file_exists "${TEST_DIR}/consumer_b.txt" "consumer_b was dispatched"
e2e::assert_contains "$(cat "${TEST_DIR}/consumer_b.txt")" "B got: data-payload" "consumer_b receives dispatched message"

e2e::section "Undefined channel fails validation"

# Given
e2e::file "undefined_channel.jh" <<'EOF'
channel some_channel

workflow sender {
  unknown_channel <- echo "dropped"
}

workflow dummy {
  echo "never called" > dummy.txt
}

workflow default {
  run sender
  some_channel -> dummy
}
EOF

# When
drop_stderr="$(mktemp)"
set +e
e2e::run "undefined_channel.jh" >/dev/null 2>"${drop_stderr}"
drop_exit=$?
set -e
drop_err="$(cat "${drop_stderr}")"
rm -f "${drop_stderr}"

# Then
if [[ ${drop_exit} -eq 0 ]]; then
  e2e::fail "undefined channel should fail validation"
fi
e2e::assert_contains "${drop_err}" 'Channel "unknown_channel" is not defined' "undefined channel error is explicit"

e2e::section "Inbox file written"

# Given
e2e::file "inbox_file.jh" <<'EOF'
channel audit

workflow writer {
  audit <- echo "inbox-content-check"
}

workflow auditor {
  echo "$1" > audited.txt
}

workflow default {
  run writer
  audit -> auditor
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

e2e::section "Dispatched step CLI output shows \$1,\$2,\$3 via standard positional param display"

# Given
e2e::file "display_inbox.jh" <<'EOF'
channel findings
channel report

workflow scanner {
  findings <- echo "Found 3 issues in auth module"
}

workflow analyst {
  report <- echo "Summary: $1"
}

workflow reviewer {
  echo "[reviewed] $1"
}

workflow default {
  run scanner
  findings -> analyst
  report -> reviewer
}
EOF

# When
display_out="$(e2e::run "display_inbox.jh" 2>/dev/null)"

# Then
e2e::expect_stdout "${display_out}" <<'EOF'

Jaiph: Running display_inbox.jh

workflow default
  ▸ workflow scanner
  ✓ workflow scanner (<time>)
  ▸ workflow analyst (1="Found 3 issues in auth module", 2="findings", 3="scanner")
  ✓ workflow analyst (<time>)
  ▸ workflow reviewer (1="Summary: Found 3 issues in auth ...", 2="report", 3="analyst")
  ✓ workflow reviewer (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "display_inbox.jh" 1
e2e::expect_file "*display_inbox__reviewer.out" <<'EOF'
[reviewed] Summary: Found 3 issues in auth module
EOF

e2e::section "Receiver positional args: \$1=message, \$2=channel, \$3=sender"

# Given
e2e::file "receiver_args.jh" <<'EOF'
workflow producer {
  events <- echo "payload-data"
}

workflow consumer {
  echo "msg=$1" > args.txt
  echo "channel=$2" >> args.txt
  echo "sender=$3" >> args.txt
}

workflow default {
  run producer
  events -> consumer
}
EOF

# When
e2e::run "receiver_args.jh" >/dev/null

# Then
e2e::assert_file_exists "${TEST_DIR}/args.txt" "receiver wrote args file"
e2e::assert_contains "$(cat "${TEST_DIR}/args.txt")" "msg=payload-data" "receiver \$1 is message payload"
e2e::assert_contains "$(cat "${TEST_DIR}/args.txt")" "channel=events" "receiver \$2 is channel name"
e2e::assert_contains "$(cat "${TEST_DIR}/args.txt")" "sender=producer" "receiver \$3 is sender workflow name"
