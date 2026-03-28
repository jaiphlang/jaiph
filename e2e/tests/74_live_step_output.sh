#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "live_step_output"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "non-prompt step .out/.err files grow live during execution"

# Given: a workflow with a script-backed step that writes output incrementally
e2e::file "live_out.jh" <<'WORKFLOW'
script slow_writer_impl() {
  echo "line-1"
  echo "err-1" >&2
  sleep 0.3
  echo "line-2"
  echo "err-2" >&2
  sleep 0.3
  echo "line-3"
  echo "err-3" >&2
}
rule slow_writer {
  run slow_writer_impl
}

workflow default {
  ensure slow_writer
}
WORKFLOW

rm -rf "${TEST_DIR}/live_runs"

# Build first, then run in background
jaiph build "${TEST_DIR}/live_out.jh" >/dev/null

# When: run the workflow in the background, poll .out/.err files mid-execution
run_err="$(mktemp)"
JAIPH_RUNS_DIR="${TEST_DIR}/live_runs" jaiph run "${TEST_DIR}/live_out.jh" 2>"${run_err}" &
run_pid=$!

# Wait for the run dir and .out/.err files to appear (up to 5s)
out_file=""
err_file=""
for _ in $(seq 1 50); do
  sleep 0.1
  shopt -s nullglob
  out_candidates=( "${TEST_DIR}/live_runs/"*/*"live_out.jh/"*slow_writer_impl.out )
  err_candidates=( "${TEST_DIR}/live_runs/"*/*"live_out.jh/"*slow_writer_impl.err )
  shopt -u nullglob
  if [[ ${#out_candidates[@]} -ge 1 && ${#err_candidates[@]} -ge 1 ]]; then
    out_file="${out_candidates[0]}"
    err_file="${err_candidates[0]}"
    break
  fi
done

# Sample while process is still running to prove live writes.
sleep 0.2
if ! kill -0 "$run_pid" 2>/dev/null; then
  e2e::fail "run finished before live sample; increase slow_writer duration"
fi

mid_out_size=""
mid_err_size=""
if [[ -n "$out_file" && -f "$out_file" ]]; then
  mid_out_size="$(wc -c < "$out_file")"
fi
if [[ -n "$err_file" && -f "$err_file" ]]; then
  mid_err_size="$(wc -c < "$err_file")"
fi

# Wait for the background run to finish
wait "$run_pid" || true
rm -f "${run_err}"

# Then: files existed during execution with partial content
if [[ -z "$out_file" || -z "$err_file" ]]; then
  e2e::fail "out/err files never appeared during execution"
fi

if [[ -z "$mid_out_size" || "$mid_out_size" -eq 0 ]]; then
  e2e::fail "out file was empty when sampled mid-execution (mid_out_size=${mid_out_size:-<empty>})"
fi
if [[ -z "$mid_err_size" || "$mid_err_size" -eq 0 ]]; then
  e2e::fail "err file was empty when sampled mid-execution (mid_err_size=${mid_err_size:-<empty>})"
fi

final_out_size="$(wc -c < "$out_file")"
if [[ "$final_out_size" -gt "$mid_out_size" ]]; then
  e2e::pass "out file grew live: mid=${mid_out_size}B final=${final_out_size}B"
elif [[ "$final_out_size" -eq "$mid_out_size" && "$final_out_size" -gt 0 ]]; then
  # All output may have flushed by the time we sampled — still valid if file existed live
  e2e::pass "out file was live-written (sampled ${mid_out_size}B, final ${final_out_size}B)"
else
  e2e::fail "out file did not grow (mid=${mid_out_size}B final=${final_out_size}B)"
fi

final_err_size="$(wc -c < "$err_file")"
if [[ "$final_err_size" -gt "$mid_err_size" ]]; then
  e2e::pass "err file grew live: mid=${mid_err_size}B final=${final_err_size}B"
elif [[ "$final_err_size" -eq "$mid_err_size" && "$final_err_size" -gt 0 ]]; then
  e2e::pass "err file was live-written (sampled ${mid_err_size}B, final ${final_err_size}B)"
else
  e2e::fail "err file did not grow (mid=${mid_err_size}B final=${final_err_size}B)"
fi

# Also verify final content is correct
final_content="$(<"$out_file")"
e2e::assert_contains "${final_content}" "line-1" "final output contains line-1"
e2e::assert_contains "${final_content}" "line-2" "final output contains line-2"
e2e::assert_contains "${final_content}" "line-3" "final output contains line-3"
final_err_content="$(<"$err_file")"
e2e::assert_contains "${final_err_content}" "err-1" "final error contains err-1"
e2e::assert_contains "${final_err_content}" "err-2" "final error contains err-2"
e2e::assert_contains "${final_err_content}" "err-3" "final error contains err-3"
