#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "parallel_shell_steps"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"
unset JAIPH_STDLIB

# ---------------------------------------------------------------------------
e2e::section "Basic background jobs with wait"
# ---------------------------------------------------------------------------

e2e::file "bg_basic.jh" <<'EOF'
workflow default {
  echo "before" > before.txt
  sleep 0.05 && echo "job1" > job1.txt &
  sleep 0.05 && echo "job2" > job2.txt &
  wait
  echo "after" > after.txt
}
EOF

e2e::run "bg_basic.jh" >/dev/null

e2e::assert_file_exists "${TEST_DIR}/before.txt" "before.txt created before background jobs"
e2e::assert_file_exists "${TEST_DIR}/job1.txt"   "job1.txt created by background process"
e2e::assert_file_exists "${TEST_DIR}/job2.txt"   "job2.txt created by background process"
e2e::assert_file_exists "${TEST_DIR}/after.txt"   "after.txt created after wait"
e2e::assert_contains "$(cat "${TEST_DIR}/job1.txt")" "job1" "job1 output correct"
e2e::assert_contains "$(cat "${TEST_DIR}/job2.txt")" "job2" "job2 output correct"

# ---------------------------------------------------------------------------
e2e::section "Failure propagation with wait \$pid"
# ---------------------------------------------------------------------------

e2e::file "bg_fail_pid.jh" <<'EOF'
workflow default {
  false & pid=$!
  wait $pid || exit $?
}
EOF

fail_exit=0
e2e::run "bg_fail_pid.jh" >/dev/null 2>/dev/null || fail_exit=$?

if [[ "$fail_exit" -eq 0 ]]; then
  e2e::fail "expected non-zero exit when background job fails and wait \$pid is used"
fi
e2e::pass "wait \$pid propagates background job failure to step exit status"

# ---------------------------------------------------------------------------
e2e::section "Bare wait succeeds even when background job fails (bash semantics)"
# ---------------------------------------------------------------------------

e2e::file "bg_bare_wait.jh" <<'EOF'
workflow default {
  false &
  true &
  wait
  echo "reached" > reached.txt
}
EOF

e2e::run "bg_bare_wait.jh" >/dev/null 2>/dev/null

e2e::assert_file_exists "${TEST_DIR}/reached.txt" "bare wait returns 0 even with failed bg job"

# ---------------------------------------------------------------------------
e2e::section "Concurrent stdout captured in step artifact"
# ---------------------------------------------------------------------------

e2e::file "bg_output.jh" <<'EOF'
workflow default {
  for i in $(seq 1 5); do echo "A-$i"; done &
  for i in $(seq 1 5); do echo "B-$i"; done &
  wait
}
EOF

e2e::run "bg_output.jh" >/dev/null

run_dir="$(e2e::run_dir "bg_output.jh")"
shopt -s nullglob
out_files=( "${run_dir}"*bg_output__default.out )
shopt -u nullglob

if [[ ${#out_files[@]} -ne 1 ]]; then
  e2e::fail "expected 1 .out file for default workflow, got ${#out_files[@]}"
fi

out_content="$(<"${out_files[0]}")"
# All 10 lines should appear (5 from each background job)
line_count="$(echo "$out_content" | wc -l | tr -d ' ')"
if [[ "$line_count" -lt 10 ]]; then
  e2e::fail "expected at least 10 lines in output, got ${line_count}"
fi
e2e::assert_contains "$out_content" "A-1" "output contains A-1"
e2e::assert_contains "$out_content" "B-5" "output contains B-5"
e2e::pass "concurrent stdout from background jobs captured in .out artifact"

# ---------------------------------------------------------------------------
e2e::section "Run summary valid after parallel shell step"
# ---------------------------------------------------------------------------

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
e2e::pass "run_summary.jsonl valid after concurrent shell step"

# ---------------------------------------------------------------------------
e2e::section "STEP_START and STEP_END events emitted correctly"
# ---------------------------------------------------------------------------

# Count STEP_END entries — should have at least one (the default workflow)
end_count="$(grep -c '"type":"STEP_END"' "$summary" || true)"
if [[ "$end_count" -lt 1 ]]; then
  e2e::fail "expected at least 1 STEP_END in summary, got ${end_count}"
fi
e2e::pass "STEP_END events present in run_summary.jsonl"

# Verify the workflow step completed with status 0
last_status="$(python3 -c "
import json, sys
for line in open('${summary}'):
    ev = json.loads(line)
    if ev.get('type') == 'STEP_END' and 'default' in ev.get('func',''):
        print(ev['status'])
" | tail -1)"
if [[ "$last_status" != "0" ]]; then
  e2e::fail "expected default workflow STEP_END status=0, got ${last_status}"
fi
e2e::pass "workflow STEP_END status is 0 after successful parallel shell step"

# ---------------------------------------------------------------------------
e2e::section "Background jobs with inbox send do not corrupt state"
# ---------------------------------------------------------------------------

e2e::file "bg_inbox.jh" <<'EOF'
channel ch

workflow sender {
  ch <- echo "msg1"
  ch <- echo "msg2"
  ch <- echo "msg3"
}

workflow handler {
  echo "handled: $1" >> handled_log.txt
}

workflow default {
  run sender
  ch -> handler
}
EOF

e2e::run "bg_inbox.jh" >/dev/null

e2e::assert_file_exists "${TEST_DIR}/handled_log.txt" "handler invoked for inbox messages"
handler_lines="$(wc -l < "${TEST_DIR}/handled_log.txt" | tr -d ' ')"
if [[ "$handler_lines" -ne 3 ]]; then
  e2e::fail "expected 3 handler invocations, got ${handler_lines}"
fi
e2e::pass "inbox dispatch intact alongside shell steps"

# Check inbox seq file for correctness
bg_inbox_dir="$(e2e::run_dir "bg_inbox.jh")"
inbox_seq="${bg_inbox_dir}/inbox/.seq"
if [[ -f "$inbox_seq" ]]; then
  seq_val="$(<"$inbox_seq")"
  if [[ "$seq_val" != "3" ]]; then
    e2e::fail "expected inbox .seq=3, got ${seq_val}"
  fi
  e2e::pass "inbox sequence counter correct after workflow with shell steps"
else
  e2e::fail "inbox .seq file not found"
fi

# ---------------------------------------------------------------------------
e2e::section "Multiple wait pattern with explicit PID tracking"
# ---------------------------------------------------------------------------

e2e::file "bg_multi_pid.jh" <<'EOF'
workflow default {
  sleep 0.05 && echo "first" > first.txt & pid1=$!
  sleep 0.05 && echo "second" > second.txt & pid2=$!
  wait $pid1
  wait $pid2
  echo "done" > done.txt
}
EOF

e2e::run "bg_multi_pid.jh" >/dev/null

e2e::assert_file_exists "${TEST_DIR}/first.txt"  "first.txt created by pid-tracked bg job"
e2e::assert_file_exists "${TEST_DIR}/second.txt" "second.txt created by pid-tracked bg job"
e2e::assert_file_exists "${TEST_DIR}/done.txt"   "done.txt created after explicit wait \$pid1 \$pid2"
