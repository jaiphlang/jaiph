#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "prompt_returns_run_capture"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Typed prompt + run capture (no prompt noise in command substitution)"

cp "${ROOT_DIR}/e2e/prompt_returns_run_capture.jh" "${TEST_DIR}/prompt_returns_run_capture.jh"
cp "${ROOT_DIR}/e2e/prompt_returns_run_capture.test.jh" "${TEST_DIR}/prompt_returns_run_capture.test.jh"

out="$(jaiph test "${TEST_DIR}/prompt_returns_run_capture.test.jh" 2>&1)" || {
  printf "%s\n" "${out}" >&2
  e2e::fail "prompt_returns_run_capture.test.jh should pass"
}

if [[ "${out}" != *"passed"* ]] && [[ "${out}" != *"PASS"* ]]; then
  printf "%s\n" "${out}" >&2
  e2e::fail "prompt_returns_run_capture.test.jh should report pass"
fi

e2e::pass "prompt_returns_run_capture.test.jh passes"
