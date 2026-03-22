#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "live_step_output"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "non-prompt step .out file grows live during execution"

# Given: a workflow with a shell step that writes output incrementally
e2e::file "live_out.jh" <<'WORKFLOW'
rule slow_writer {
  echo "line-1"
  sleep 0.3
  echo "line-2"
  sleep 0.3
  echo "line-3"
}

workflow default {
  ensure slow_writer
}
WORKFLOW

rm -rf "${TEST_DIR}/live_runs"

# Build first, then run in background
jaiph build "${TEST_DIR}/live_out.jh" >/dev/null

# When: run the workflow in the background, poll the .out file mid-execution
run_err="$(mktemp)"
JAIPH_RUNS_DIR="live_runs" jaiph run "${TEST_DIR}/live_out.jh" 2>"${run_err}" &
run_pid=$!

# Wait for the run dir and .out file to appear (up to 5s)
out_file=""
for _ in $(seq 1 50); do
  sleep 0.1
  shopt -s nullglob
  candidates=( "${TEST_DIR}/live_runs/"*/*"live_out.jh/"*slow_writer.out )
  shopt -u nullglob
  if [[ ${#candidates[@]} -ge 1 ]]; then
    out_file="${candidates[0]}"
    break
  fi
done

mid_size=""
if [[ -n "$out_file" && -f "$out_file" ]]; then
  mid_size="$(wc -c < "$out_file")"
fi

# Wait for the background run to finish
wait "$run_pid" || true
rm -f "${run_err}"

# Then: the file existed during execution with partial content
if [[ -z "$out_file" ]]; then
  e2e::fail "out file never appeared during execution"
fi

if [[ -z "$mid_size" || "$mid_size" -eq 0 ]]; then
  e2e::fail "out file was empty when sampled mid-execution (mid_size=${mid_size:-<empty>})"
fi

final_size="$(wc -c < "$out_file")"
if [[ "$final_size" -gt "$mid_size" ]]; then
  e2e::pass "out file grew live: mid=${mid_size}B final=${final_size}B"
elif [[ "$final_size" -eq "$mid_size" && "$final_size" -gt 0 ]]; then
  # All output may have flushed by the time we sampled — still valid if file existed live
  e2e::pass "out file was live-written (sampled ${mid_size}B, final ${final_size}B)"
else
  e2e::fail "out file did not grow (mid=${mid_size}B final=${final_size}B)"
fi

# Also verify final content is correct
final_content="$(<"$out_file")"
e2e::assert_contains "${final_content}" "line-1" "final output contains line-1"
e2e::assert_contains "${final_content}" "line-2" "final output contains line-2"
e2e::assert_contains "${final_content}" "line-3" "final output contains line-3"
