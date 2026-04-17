#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_live_step_output"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Gate on Docker availability — skip gracefully when Docker is not installed.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker live step output (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping Docker live artifact test"
  exit 0
fi

e2e::section "docker step .out/.err files grow live during execution"

e2e::file "live_out_docker.jh" <<'WORKFLOW'
script slow_writer_impl = ```
echo "line-1"
echo "err-1" >&2
sleep 1
echo "line-2"
echo "err-2" >&2
sleep 1
echo "line-3"
echo "err-3" >&2
```
rule slow_writer() {
  run slow_writer_impl()
}

workflow default() {
  ensure slow_writer()
}
WORKFLOW

run_err="$(mktemp)"
JAIPH_DOCKER_ENABLED=true jaiph run "${TEST_DIR}/live_out_docker.jh" 2>"${run_err}" &
run_pid=$!

out_file=""
err_file=""
for _ in $(seq 1 50); do
  sleep 0.1
  shopt -s nullglob
  out_candidates=( "${TEST_DIR}/.jaiph/runs/"*/*"live_out_docker.jh/"*slow_writer_impl.out )
  err_candidates=( "${TEST_DIR}/.jaiph/runs/"*/*"live_out_docker.jh/"*slow_writer_impl.err )
  shopt -u nullglob
  if [[ ${#out_candidates[@]} -ge 1 && ${#err_candidates[@]} -ge 1 ]]; then
    out_file="${out_candidates[0]}"
    err_file="${err_candidates[0]}"
    break
  fi
done

sleep 1
if ! kill -0 "$run_pid" 2>/dev/null; then
  e2e::fail "docker run finished before live sample; increase slow_writer duration"
fi

mid_out_size=""
mid_err_size=""
if [[ -n "$out_file" && -f "$out_file" ]]; then
  mid_out_size="$(wc -c < "$out_file")"
fi
if [[ -n "$err_file" && -f "$err_file" ]]; then
  mid_err_size="$(wc -c < "$err_file")"
fi

wait "$run_pid" || true
rm -f "${run_err}"

if [[ -z "$out_file" || -z "$err_file" ]]; then
  e2e::fail "docker out/err files never appeared during execution"
fi

if [[ -z "$mid_out_size" || "$mid_out_size" -eq 0 ]]; then
  e2e::fail "docker out file was empty when sampled mid-execution (mid_out_size=${mid_out_size:-<empty>})"
fi
if [[ -z "$mid_err_size" || "$mid_err_size" -eq 0 ]]; then
  e2e::fail "docker err file was empty when sampled mid-execution (mid_err_size=${mid_err_size:-<empty>})"
fi

final_out_size="$(wc -c < "$out_file")"
if [[ "$final_out_size" -gt "$mid_out_size" ]]; then
  e2e::pass "docker out file grew live: mid=${mid_out_size}B final=${final_out_size}B"
elif [[ "$final_out_size" -eq "$mid_out_size" && "$final_out_size" -gt 0 ]]; then
  e2e::pass "docker out file was live-written (sampled ${mid_out_size}B, final ${final_out_size}B)"
else
  e2e::fail "docker out file did not grow (mid=${mid_out_size}B final=${final_out_size}B)"
fi

final_err_size="$(wc -c < "$err_file")"
if [[ "$final_err_size" -gt "$mid_err_size" ]]; then
  e2e::pass "docker err file grew live: mid=${mid_err_size}B final=${final_err_size}B"
elif [[ "$final_err_size" -eq "$mid_err_size" && "$final_err_size" -gt 0 ]]; then
  e2e::pass "docker err file was live-written (sampled ${mid_err_size}B, final ${final_err_size}B)"
else
  e2e::fail "docker err file did not grow (mid=${mid_err_size}B final=${final_err_size}B)"
fi

final_content="$(<"$out_file")"
expected_out="$(printf 'line-1\nline-2\nline-3')"
e2e::assert_equals "${final_content}" "${expected_out}" "docker final .out content"

final_err_content="$(<"$err_file")"
expected_err="$(printf 'err-1\nerr-2\nerr-3')"
e2e::assert_equals "${final_err_content}" "${expected_err}" "docker final .err content"
