#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "graph_command"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"
EXAMPLES_DIR="${ROOT_DIR}/examples"

# Copy every example (and its imports) into an isolated workspace so we can
# assert that `jaiph graph` is side-effect free: nothing runs.
cp "${EXAMPLES_DIR}"/*.jh "${TEST_DIR}/"

e2e::section "jaiph graph on each examples/*.jh — flowchart, exit 0, deterministic, no side effects"

for src in "${TEST_DIR}"/*.jh; do
  name="$(basename "${src}")"
  # graph rejects *.test.jh (not a runnable entry); those are covered separately.
  case "${name}" in
    *.test.jh) continue ;;
  esac

  # When — graph the file twice.
  set +e
  out1="$(jaiph graph "${src}")"
  graph_exit=$?
  out2="$(jaiph graph "${src}")"
  set -e

  # Then — exit 0, starts with the Mermaid header, byte-identical across runs.
  e2e::assert_equals "${graph_exit}" "0" "${name}: graph exits 0"

  first_line="$(printf "%s\n" "${out1}" | head -n 1)"
  e2e::assert_equals "${first_line}" "flowchart TD" "${name}: output starts with flowchart TD"

  e2e::assert_equals "${out1}" "${out2}" "${name}: output is byte-identical across two runs"
done

e2e::section "jaiph graph writes no run artifacts and emits no scripts"

# No run directory and no emitted scripts/ anywhere under the workspace.
if [[ -d "${TEST_DIR}/.jaiph/runs" ]]; then
  e2e::fail "jaiph graph must not create .jaiph/runs"
fi

scripts_dirs="$(find "${TEST_DIR}" -type d -name scripts 2>/dev/null || true)"
if [[ -n "${scripts_dirs}" ]]; then
  printf "%s\n" "${scripts_dirs}" >&2
  e2e::fail "jaiph graph must not emit a scripts/ directory"
fi

e2e::pass "jaiph graph produced no run artifacts and no scripts"

e2e::section "jaiph graph --def and missing-def error"

e2e::file "two.jh" <<'EOF'
export def main() {
  helper()
}
def helper() {
  log "hi"
}
EOF

helper_out="$(jaiph graph --def helper "${TEST_DIR}/two.jh")"
if ! printf "%s\n" "${helper_out}" | grep -q 'subgraph sg1 \["def helper"\]'; then
  printf "%s\n" "${helper_out}" >&2
  e2e::fail "--def helper should graph the helper def"
fi
e2e::pass "--def selects a non-exported def"

missing_exit=0
missing_err="$(jaiph graph --def nope "${TEST_DIR}/two.jh" 2>&1 >/dev/null)" || missing_exit=$?
e2e::assert_equals "${missing_exit}" "1" "missing def exits 1"
if ! printf "%s\n" "${missing_err}" | grep -q "Available defs: main, helper"; then
  printf "%s\n" "${missing_err}" >&2
  e2e::fail "missing-def error should list available defs"
fi
e2e::pass "missing def lists available defs"
