#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "repo_workflows_check"
WORKFLOWS_DIR="${ROOT_DIR}/.jaiph"

shopt -s nullglob
workflow_files=( "${WORKFLOWS_DIR}"/*.jh )
workflow_tests=( "${WORKFLOWS_DIR}"/*.test.jh )

if [[ ${#workflow_files[@]} -eq 0 ]]; then
  e2e::fail "no workflow .jh files under .jaiph/"
fi

e2e::section ".jaiph/ — jaiph format --check on every *.jh"

# Given the repository's own agent workflows
# When each is checked against the canonical format
for f in "${workflow_files[@]}"; do
  if ! jaiph format --check "$f"; then
    e2e::fail "workflow not canonically formatted: ${f} (run: jaiph format \"${f}\")"
  fi
done

# Then every file matches
e2e::pass "all .jaiph/*.jh match jaiph format"

e2e::section ".jaiph/ — jaiph compile on every *.jh"

# When each workflow is compiled
for f in "${workflow_files[@]}"; do
  if ! jaiph compile "$f" >/dev/null; then
    e2e::fail "workflow does not compile: ${f}"
  fi
done

# Then every file compiles
e2e::pass "all .jaiph/*.jh compile"

e2e::section ".jaiph/ — jaiph test on every *.test.jh"

# Given the workflow tests (all prompts and side effects are mocked)
# When each test file runs from the repository root
cd "${ROOT_DIR}"
for t in "${workflow_tests[@]}"; do
  if ! test_out="$(jaiph test "$t" 2>&1)"; then
    printf '%s\n' "${test_out}" >&2
    e2e::fail "workflow test failed: ${t}"
  fi
done

# Then every test passes
e2e::pass "all .jaiph/*.test.jh pass"
