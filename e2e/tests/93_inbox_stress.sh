#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "inbox_stress"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
# Helper: assert that a file has exactly N lines.
# ---------------------------------------------------------------------------
assert_line_count() {
  local file="$1"
  local expected="$2"
  local label="$3"
  if [[ ! -f "$file" ]]; then
    e2e::fail "${label} (file missing: ${file})"
  fi
  local actual
  actual="$(wc -l < "$file" | tr -d ' ')"
  if [[ "$actual" -ne "$expected" ]]; then
    printf "Expected %d lines, got %d in %s\n" "$expected" "$actual" "$file" >&2
    e2e::fail "${label}"
  fi
  e2e::pass "${label}"
}

# Helper: assert that a file has exactly N unique lines.
assert_unique_line_count() {
  local file="$1"
  local expected="$2"
  local label="$3"
  if [[ ! -f "$file" ]]; then
    e2e::fail "${label} (file missing: ${file})"
  fi
  local actual
  actual="$(sort -u "$file" | wc -l | tr -d ' ')"
  if [[ "$actual" -ne "$expected" ]]; then
    printf "Expected %d unique lines, got %d in %s\n" "$expected" "$actual" "$file" >&2
    e2e::fail "${label}"
  fi
  e2e::pass "${label}"
}

# Helper: assert all JSON lines in a JSONL file are valid.
assert_valid_jsonl() {
  local file="$1"
  local label="$2"
  if [[ ! -f "$file" ]]; then
    e2e::fail "${label} (file missing: ${file})"
  fi
  local invalid=0
  while IFS= read -r line; do
    if ! printf '%s' "$line" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
      invalid=$(( invalid + 1 ))
    fi
  done < "$file"
  if [[ "$invalid" -gt 0 ]]; then
    e2e::fail "${label} (${invalid} invalid JSON lines)"
  fi
  e2e::pass "${label}"
}

# ===========================================================================
e2e::section "High-volume send: 10 senders, sequence IDs gapless and unique"
# ===========================================================================

# 10 workflows each send one message to the same channel.
# Under parallel dispatch, all 10 sends race through the lock.
# We assert: exactly 10 inbox files (001..010), no gaps, no duplicates.

e2e::file "stress_highvol.jh" <<'EOF'
config {
  run.inbox_parallel = true
}

channel data

workflow s1() {
  data <- echo "m1"
}

workflow s2() {
  data <- echo "m2"
}

workflow s3() {
  data <- echo "m3"
}

workflow s4() {
  data <- echo "m4"
}

workflow s5() {
  data <- echo "m5"
}

workflow s6() {
  data <- echo "m6"
}

workflow s7() {
  data <- echo "m7"
}

workflow s8() {
  data <- echo "m8"
}

workflow s9() {
  data <- echo "m9"
}

workflow s10() {
  data <- echo "m10"
}

workflow sink() {
  echo "${arg1}" >> sink_all.txt
}

workflow default() {
  run s1
  run s2
  run s3
  run s4
  run s5
  run s6
  run s7
  run s8
  run s9
  run s10
  data -> sink
}
EOF

e2e::run "stress_highvol.jh" >/dev/null

hv_run_dir="$(e2e::run_dir "stress_highvol.jh")"
hv_inbox="${hv_run_dir}/inbox"

# Assert all 10 sequence IDs exist (001..010)
for i in $(seq 1 10); do
  padded=$(printf '%03d' "$i")
  e2e::assert_file_exists "${hv_inbox}/${padded}-data.txt" "seq ${padded} exists"
done

# Assert sink received exactly 10 messages (no loss, no duplication)
assert_line_count "${TEST_DIR}/sink_all.txt" 10 "sink received exactly 10 messages"
assert_unique_line_count "${TEST_DIR}/sink_all.txt" 10 "all 10 sink messages are unique"

# Assert run_summary.jsonl is valid
assert_valid_jsonl "${hv_run_dir}/run_summary.jsonl" "high-volume: run_summary.jsonl valid"

# ===========================================================================
e2e::section "Fan-out correctness: 3 messages x 3 targets = 9 invocations"
# ===========================================================================

e2e::file "stress_fanout.jh" <<'EOF'
config {
  run.inbox_parallel = true
}

channel ch

workflow producer_a() {
  ch <- echo "pa"
}

workflow producer_b() {
  ch <- echo "pb"
}

workflow producer_c() {
  ch <- echo "pc"
}

workflow target_x() {
  echo "x:${arg1}" >> fanout_log.txt
}

workflow target_y() {
  echo "y:${arg1}" >> fanout_log.txt
}

workflow target_z() {
  echo "z:${arg1}" >> fanout_log.txt
}

workflow default() {
  run producer_a
  run producer_b
  run producer_c
  ch -> target_x, target_y, target_z
}
EOF

e2e::run "stress_fanout.jh" >/dev/null

# 3 messages x 3 targets = 9 invocations
e2e::assert_file_exists "${TEST_DIR}/fanout_log.txt" "fanout log exists"
assert_line_count "${TEST_DIR}/fanout_log.txt" 9 "fan-out: 3 msgs x 3 targets = 9 lines"

# Each target prefix (x:, y:, z:) must appear exactly 3 times
for prefix in "x:" "y:" "z:"; do
  count="$(grep -c "^${prefix}" "${TEST_DIR}/fanout_log.txt" || true)"
  if [[ "$count" -ne 3 ]]; then
    printf "Expected 3 lines with prefix '%s', got %s\n" "$prefix" "$count" >&2
    e2e::fail "fan-out: target prefix ${prefix} count"
  fi
  e2e::pass "fan-out: target ${prefix} invoked 3 times"
done

# Each message (pa, pb, pc) must appear exactly 3 times (once per target)
for msg in "pa" "pb" "pc"; do
  count="$(grep -c "${msg}" "${TEST_DIR}/fanout_log.txt" || true)"
  if [[ "$count" -ne 3 ]]; then
    printf "Expected 3 lines with msg '%s', got %s\n" "$msg" "$count" >&2
    e2e::fail "fan-out: msg ${msg} count"
  fi
  e2e::pass "fan-out: msg ${msg} delivered to all 3 targets"
done

fo_run_dir="$(e2e::run_dir "stress_fanout.jh")"
assert_valid_jsonl "${fo_run_dir}/run_summary.jsonl" "fan-out: run_summary.jsonl valid"

# ===========================================================================
e2e::section "Nested dispatch: dispatched workflow sends further messages"
# ===========================================================================

# Chain: sender -> processor (via ch_raw) -> sink (via ch_processed)
# Verifies reentrancy: a dispatched workflow can itself send to inbox.

e2e::file "stress_nested.jh" <<'EOF'
config {
  run.inbox_parallel = true
}

channel ch_raw
channel ch_processed

workflow sender() {
  ch_raw <- echo "raw-data"
}

workflow processor() {
  ch_processed <- echo "processed:${arg1}"
}

workflow sink() {
  echo "${arg1}" > nested_result.txt
}

workflow default() {
  run sender
  ch_raw -> processor
  ch_processed -> sink
}
EOF

e2e::run "stress_nested.jh" >/dev/null

e2e::assert_file_exists "${TEST_DIR}/nested_result.txt" "nested: sink received message"
e2e::assert_equals "$(cat "${TEST_DIR}/nested_result.txt")" "processed:raw-data" "nested: message passed through processing chain"

nd_run_dir="$(e2e::run_dir "stress_nested.jh")"
nd_inbox="${nd_run_dir}/inbox"
# Must have 2 inbox files: one for ch_raw, one for ch_processed
e2e::assert_file_exists "${nd_inbox}/001-ch_raw.txt" "nested: ch_raw inbox file"
e2e::assert_file_exists "${nd_inbox}/002-ch_processed.txt" "nested: ch_processed inbox file"

# ===========================================================================
e2e::section "Failure aggregation: multiple failing targets"
# ===========================================================================

# Two targets fail, one succeeds. Verify workflow fails and the successful
# target still ran (all targets in a parallel batch complete before exit).

e2e::file "stress_failagg.jh" <<'EOF'
config {
  run.inbox_parallel = true
}

channel ch

workflow producer() {
  ch <- echo "msg"
}

workflow fail_a() {
  echo "a ran" > fail_a_ran.txt
  exit 1
}

workflow fail_b() {
  echo "b ran" > fail_b_ran.txt
  exit 1
}

workflow good() {
  echo "ok" > fail_good_ran.txt
}

workflow default() {
  run producer
  ch -> fail_a, fail_b, good
}
EOF

fail_exit=0
e2e::run "stress_failagg.jh" >/dev/null 2>/dev/null || fail_exit=$?

if [[ "$fail_exit" -eq 0 ]]; then
  e2e::fail "failure aggregation: expected non-zero exit"
fi
e2e::pass "failure aggregation: workflow exited non-zero"

# The good target should still have run (parallel waits for all)
e2e::assert_file_exists "${TEST_DIR}/fail_good_ran.txt" "failure aggregation: good target completed"

# ===========================================================================
e2e::section "Concurrent artifact integrity: inbox + summary under load"
# ===========================================================================

# 5 senders x 2 targets in parallel — check inbox files, queue, and summary.

e2e::file "stress_artifacts.jh" <<'EOF'
config {
  run.inbox_parallel = true
}

channel ev

workflow s1() {
  ev <- echo "e1"
}

workflow s2() {
  ev <- echo "e2"
}

workflow s3() {
  ev <- echo "e3"
}

workflow s4() {
  ev <- echo "e4"
}

workflow s5() {
  ev <- echo "e5"
}

workflow t1() {
  echo "t1:${arg1}" >> artifact_log.txt
}

workflow t2() {
  echo "t2:${arg1}" >> artifact_log.txt
}

workflow default() {
  run s1
  run s2
  run s3
  run s4
  run s5
  ev -> t1, t2
}
EOF

e2e::run "stress_artifacts.jh" >/dev/null

art_run_dir="$(e2e::run_dir "stress_artifacts.jh")"
art_inbox="${art_run_dir}/inbox"

# 5 inbox files (001..005)
for i in $(seq 1 5); do
  padded=$(printf '%03d' "$i")
  e2e::assert_file_exists "${art_inbox}/${padded}-ev.txt" "artifacts: inbox ${padded}-ev.txt"
done

# Queue file must have exactly 5 entries
assert_line_count "${art_inbox}/.queue" 5 "artifacts: queue has 5 entries"

# Dispatch log: 5 msgs x 2 targets = 10 lines
assert_line_count "${TEST_DIR}/artifact_log.txt" 10 "artifacts: 5x2=10 dispatch invocations"

# Summary is valid JSONL
assert_valid_jsonl "${art_run_dir}/run_summary.jsonl" "artifacts: run_summary.jsonl valid"

# Sequence counter file ends at 5
seq_val="$(cat "${art_inbox}/.seq")"
if [[ "$seq_val" -ne 5 ]]; then
  printf "Expected .seq=5, got %s\n" "$seq_val" >&2
  e2e::fail "artifacts: inbox .seq counter"
fi
e2e::pass "artifacts: inbox .seq counter = 5"

# ===========================================================================
e2e::section "Soak run: 5 iterations of fan-out scenario prove stability"
# ===========================================================================

# Repeat the same parallel fan-out scenario multiple times.
# Each iteration uses a fresh build+run via e2e::run.
# Detects heisenbugs that only manifest under repeated execution.

SOAK_ITERATIONS=5

e2e::file "stress_soak.jh" <<'EOF'
config {
  run.inbox_parallel = true
}

channel ch

workflow s1() {
  ch <- echo "i1"
}

workflow s2() {
  ch <- echo "i2"
}

workflow s3() {
  ch <- echo "i3"
}

workflow t1() {
  echo "t1:${arg1}" >> soak_log.txt
}

workflow t2() {
  echo "t2:${arg1}" >> soak_log.txt
}

workflow default() {
  run s1
  run s2
  run s3
  ch -> t1, t2
}
EOF

for iter in $(seq 1 $SOAK_ITERATIONS); do
  # Clear per-iteration state
  rm -f "${TEST_DIR}/soak_log.txt"
  # Remove previous run dirs for this file to avoid run_dir ambiguity
  find "${TEST_DIR}/.jaiph/runs" -type d -name '*stress_soak*' -exec rm -rf {} + 2>/dev/null || true

  e2e::run "stress_soak.jh" >/dev/null

  # 3 msgs x 2 targets = 6
  soak_lines="$(wc -l < "${TEST_DIR}/soak_log.txt" | tr -d ' ')"
  if [[ "$soak_lines" -ne 6 ]]; then
    printf "Soak iteration %d: expected 6 lines, got %s\n" "$iter" "$soak_lines" >&2
    e2e::fail "soak iteration ${iter}: dispatch count"
  fi

  soak_run_dir="$(e2e::run_dir "stress_soak.jh")"
  # Validate summary integrity each iteration
  invalid=0
  while IFS= read -r line; do
    if ! printf '%s' "$line" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
      invalid=$(( invalid + 1 ))
    fi
  done < "${soak_run_dir}/run_summary.jsonl"
  if [[ "$invalid" -gt 0 ]]; then
    e2e::fail "soak iteration ${iter}: invalid JSONL"
  fi

  # Inbox sequence integrity
  soak_inbox="${soak_run_dir}/inbox"
  for s in 1 2 3; do
    padded=$(printf '%03d' "$s")
    if [[ ! -f "${soak_inbox}/${padded}-ch.txt" ]]; then
      e2e::fail "soak iteration ${iter}: missing inbox ${padded}-ch.txt"
    fi
  done
done

e2e::pass "soak: all ${SOAK_ITERATIONS} iterations passed — dispatch counts, JSONL validity, sequence integrity"

# ===========================================================================
e2e::section "Sequential mode: same high-volume scenario produces identical results"
# ===========================================================================

# Run the 10-sender scenario in sequential mode and verify same invariants.
# This confirms sequential path is not regressed by parallel-mode changes.

e2e::file "stress_seq_mode.jh" <<'EOF'
channel data

workflow s1() {
  data <- echo "m1"
}

workflow s2() {
  data <- echo "m2"
}

workflow s3() {
  data <- echo "m3"
}

workflow s4() {
  data <- echo "m4"
}

workflow s5() {
  data <- echo "m5"
}

workflow s6() {
  data <- echo "m6"
}

workflow s7() {
  data <- echo "m7"
}

workflow s8() {
  data <- echo "m8"
}

workflow s9() {
  data <- echo "m9"
}

workflow s10() {
  data <- echo "m10"
}

workflow sink() {
  echo "${arg1}" >> seq_sink_all.txt
}

workflow default() {
  run s1
  run s2
  run s3
  run s4
  run s5
  run s6
  run s7
  run s8
  run s9
  run s10
  data -> sink
}
EOF

e2e::run "stress_seq_mode.jh" >/dev/null

seq_run_dir="$(e2e::run_dir "stress_seq_mode.jh")"
seq_inbox="${seq_run_dir}/inbox"

for i in $(seq 1 10); do
  padded=$(printf '%03d' "$i")
  e2e::assert_file_exists "${seq_inbox}/${padded}-data.txt" "seq mode: seq ${padded} exists"
done

assert_line_count "${TEST_DIR}/seq_sink_all.txt" 10 "seq mode: sink received exactly 10 messages"
assert_unique_line_count "${TEST_DIR}/seq_sink_all.txt" 10 "seq mode: all 10 messages unique"
assert_valid_jsonl "${seq_run_dir}/run_summary.jsonl" "seq mode: run_summary.jsonl valid"
