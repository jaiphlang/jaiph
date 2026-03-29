#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "inbox_dispatch"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Basic send + route"

# Given
e2e::file "basic_inbox.jh" <<'EOF'
channel greetings

script emit_hello() {
  echo "hello from sender"
}
workflow sender {
  greetings <- run emit_hello
}

script write_received() {
  echo "$1" > received.txt
}
workflow receiver {
  run write_received "${arg1}"
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

script emit_payload() {
  echo "data-payload"
}
workflow producer {
  results <- run emit_payload
}

script write_consumer_a() {
  echo "A got: $1" > consumer_a.txt
}
workflow consumer_a {
  run write_consumer_a "${arg1}"
}

script write_consumer_b() {
  echo "B got: $1" > consumer_b.txt
}
workflow consumer_b {
  run write_consumer_b "${arg1}"
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

script emit_dropped() {
  echo "dropped"
}
workflow sender {
  unknown_channel <- run emit_dropped
}

script never_called_impl() {
  echo "never called" > dummy.txt
}
workflow dummy {
  run never_called_impl
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

script emit_inbox_content() {
  echo "inbox-content-check"
}
workflow writer {
  audit <- run emit_inbox_content
}

script write_audited() {
  echo "$1" > audited.txt
}
workflow auditor {
  run write_audited "${arg1}"
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

script emit_findings() {
  echo "Found 3 issues in auth module"
}
workflow scanner {
  findings <- run emit_findings
}

script emit_summary() {
  echo "Summary: $1"
}
workflow analyst {
  report <- run emit_summary "${arg1}"
}

script print_reviewed() {
  echo "[reviewed] $1"
}
workflow reviewer {
  run print_reviewed "${arg1}"
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
e2e::assert_contains "${display_out}" "workflow default" "display workflow ran"
e2e::assert_contains "${display_out}" "workflow analyst" "analyst dispatch is visible"
e2e::assert_contains "${display_out}" "workflow reviewer" "reviewer dispatch is visible"
e2e::assert_contains "${display_out}" "✓ PASS workflow default" "display workflow succeeds"
e2e::expect_out_files "display_inbox.jh" 7
e2e::expect_file "*script__print_reviewed.out" <<'EOF'
[reviewed] Summary: Found 3 issues in auth module
EOF

e2e::section "Receiver positional args: \$1=message, \$2=channel, \$3=sender"

# Given
e2e::file "receiver_args.jh" <<'EOF'
channel events

script emit_payload() {
  echo "payload-data"
}
workflow producer {
  events <- run emit_payload
}

script write_receiver_args() {
  echo "msg=$1" > args.txt
  echo "channel=$2" >> args.txt
  echo "sender=$3" >> args.txt
}
workflow consumer {
  run write_receiver_args "${arg1}" "${arg2}" "${arg3}"
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

e2e::section "Parallel dispatch: multi-target route executes all targets"

# Given
e2e::file "parallel_multi.jh" <<'EOF'
config {
  run.inbox_parallel = true
}

channel results

script emit_parallel_payload() {
  echo "parallel-payload"
}
workflow producer {
  results <- run emit_parallel_payload
}

script write_consumer_a_par() {
  echo "A got: $1" > consumer_a_par.txt
}
workflow consumer_a {
  run write_consumer_a_par "${arg1}"
}

script write_consumer_b_par() {
  echo "B got: $1" > consumer_b_par.txt
}
workflow consumer_b {
  run write_consumer_b_par "${arg1}"
}

workflow default {
  run producer
  results -> consumer_a, consumer_b
}
EOF

# When
e2e::run "parallel_multi.jh" >/dev/null

# Then
e2e::assert_file_exists "${TEST_DIR}/consumer_a_par.txt" "parallel: consumer_a was dispatched"
e2e::assert_contains "$(cat "${TEST_DIR}/consumer_a_par.txt")" "A got: parallel-payload" "parallel: consumer_a receives message"
e2e::assert_file_exists "${TEST_DIR}/consumer_b_par.txt" "parallel: consumer_b was dispatched"
e2e::assert_contains "$(cat "${TEST_DIR}/consumer_b_par.txt")" "B got: parallel-payload" "parallel: consumer_b receives message"

e2e::section "Parallel dispatch: no duplicate/skipped sequence IDs under concurrent sends"

# Given — two workflows each send to the same inbox; parallel dispatch exercises lock paths
e2e::file "parallel_seq.jh" <<'EOF'
config {
  run.inbox_parallel = true
}

channel data

script emit_from_a() {
  echo "from-a"
}
workflow sender_a {
  data <- run emit_from_a
}

script emit_from_b() {
  echo "from-b"
}
workflow sender_b {
  data <- run emit_from_b
}

script append_sink_log() {
  echo "$1" >> sink_log.txt
}
workflow sink {
  run append_sink_log "${arg1}"
}

workflow default {
  run sender_a
  run sender_b
  data -> sink
}
EOF

# When
e2e::run "parallel_seq.jh" >/dev/null

# Then — exactly 2 messages sent, seq 001 and 002 must both exist
seq_run_dir="$(e2e::run_dir "parallel_seq.jh")"
inbox_dir="${seq_run_dir}/inbox"
if [[ ! -d "${inbox_dir}" ]]; then
  e2e::fail "inbox directory not found"
fi
e2e::assert_file_exists "${inbox_dir}/001-data.txt" "seq 001 exists"
e2e::assert_file_exists "${inbox_dir}/002-data.txt" "seq 002 exists"
# Verify sink received both messages (2 lines)
e2e::assert_file_exists "${TEST_DIR}/sink_log.txt" "sink log exists"
sink_lines="$(wc -l < "${TEST_DIR}/sink_log.txt" | tr -d ' ')"
if [[ "$sink_lines" -ne 2 ]]; then
  e2e::fail "expected 2 sink invocations, got ${sink_lines}"
fi
e2e::pass "parallel: no duplicate/skipped sequences — exactly 2 dispatches"

e2e::section "Parallel dispatch: failed target causes workflow failure"

# Given
e2e::file "parallel_fail.jh" <<'EOF'
config {
  run.inbox_parallel = true
}

channel ch

script emit_msg() {
  echo "msg"
}
workflow producer {
  ch <- run emit_msg
}

script fail_target_impl() {
  exit 1
}
workflow bad_target {
  run fail_target_impl
}

script write_good_par() {
  echo "ok" > good_par.txt
}
workflow good_target {
  run write_good_par
}

workflow default {
  run producer
  ch -> good_target, bad_target
}
EOF

# When
par_fail_exit=0
e2e::run "parallel_fail.jh" >/dev/null 2>/dev/null || par_fail_exit=$?

# Then
if [[ "$par_fail_exit" -eq 0 ]]; then
  e2e::fail "parallel: expected non-zero exit when a target fails"
fi
e2e::pass "parallel: failed target propagates failure to owning workflow"

e2e::section "Parallel dispatch: run summary valid under concurrent activity"

# Given
e2e::file "parallel_summary.jh" <<'EOF'
config {
  run.inbox_parallel = true
}

channel events

script emit_e1() {
  echo "e1"
}
workflow sender {
  events <- run emit_e1
}

script handle_a_impl() {
  echo "handled-a"
}
workflow handler_a {
  run handle_a_impl
}

script handle_b_impl() {
  echo "handled-b"
}
workflow handler_b {
  run handle_b_impl
}

workflow default {
  run sender
  events -> handler_a, handler_b
}
EOF

# When
e2e::run "parallel_summary.jh" >/dev/null

# Then — each STEP_END line must be valid JSON (no corruption from concurrent appends)
run_dir="$(e2e::run_dir "parallel_summary.jh")"
summary="${run_dir}/run_summary.jsonl"
e2e::assert_file_exists "$summary" "run_summary.jsonl exists"
invalid_lines=0
while IFS= read -r line; do
  if ! printf '%s' "$line" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    invalid_lines=$(( invalid_lines + 1 ))
  fi
done < "$summary"
if [[ "$invalid_lines" -gt 0 ]]; then
  e2e::fail "run_summary.jsonl has ${invalid_lines} invalid JSON lines"
fi
e2e::pass "parallel: run_summary.jsonl is valid under concurrent writes"

e2e::section "Parallel dispatch via JAIPH_INBOX_PARALLEL env var"

# Given — same workflow as basic multi-target, but parallel enabled via env
e2e::file "env_parallel.jh" <<'EOF'
channel results

script emit_env_parallel() {
  echo "env-parallel"
}
workflow producer {
  results <- run emit_env_parallel
}

script write_env_a() {
  echo "A: $1" > env_a.txt
}
workflow consumer_a {
  run write_env_a "${arg1}"
}

script write_env_b() {
  echo "B: $1" > env_b.txt
}
workflow consumer_b {
  run write_env_b "${arg1}"
}

workflow default {
  run producer
  results -> consumer_a, consumer_b
}
EOF

# When
JAIPH_INBOX_PARALLEL=true e2e::run "env_parallel.jh" >/dev/null

# Then
e2e::assert_file_exists "${TEST_DIR}/env_a.txt" "env parallel: consumer_a dispatched"
e2e::assert_file_exists "${TEST_DIR}/env_b.txt" "env parallel: consumer_b dispatched"
e2e::pass "parallel mode activatable via JAIPH_INBOX_PARALLEL env var"
