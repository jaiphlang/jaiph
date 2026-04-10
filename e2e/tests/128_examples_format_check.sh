#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "examples_format_check"
EXAMPLES_DIR="${ROOT_DIR}/examples"

e2e::section "examples/ — jaiph format --check on every *.jh and *.test.jh"

shopt -s nullglob
example_files=( "${EXAMPLES_DIR}"/*.jh "${EXAMPLES_DIR}"/*.test.jh )

if [[ ${#example_files[@]} -eq 0 ]]; then
  e2e::fail "no example .jh files under examples/"
fi

for f in "${example_files[@]}"; do
  if ! jaiph format --check "$f"; then
    e2e::fail "example file not canonically formatted: ${f} (run: jaiph format \"${f}\")"
  fi
done

e2e::pass "all example *.jh and *.test.jh match jaiph format"
