#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "for_string_lines"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "for line in string iterates lines"

e2e::file "for_lines.jh" <<'EOF'
workflow default() {
  const paths = """
docs/a.md
docs/b.md
"""
  for path in paths {
    log "${path}"
  }
  log "done"
}
EOF

out="$(e2e::run "for_lines.jh")"
grep -q "docs/a.md" <<<"${out}" || {
  echo "${out}" >&2
  exit 1
}
grep -q "docs/b.md" <<<"${out}" || {
  echo "${out}" >&2
  exit 1
}
grep -q "done" <<<"${out}" || {
  echo "${out}" >&2
  exit 1
}
e2e::pass "for … in … runs body per line"

e2e::section "for line in string skips only trailing empty segment"

e2e::file "for_lines_trim_nl.jh" <<'EOF'
workflow default() {
  const paths = """
one
two
"""
  for line in paths {
    log ">>${line}<<"
  }
}
EOF

out2="$(e2e::run "for_lines_trim_nl.jh")"
grep -q ">>one<<" <<<"${out2}" || exit 1
grep -q ">>two<<" <<<"${out2}" || exit 1
# No third empty iteration from final newline
if grep -q '>><<' <<<"${out2}"; then
  echo "unexpected empty line iteration:${out2}" >&2
  exit 1
fi
e2e::pass "final newline does not yield empty line"

e2e::section "for … in … with empty line in middle"

e2e::file "for_lines_interior_blank.jh" <<'EOF'
workflow default() {
  const paths = """
x

y
"""
  for line in paths {
    if line == "" {
      log "(empty)"
    }
    if line != "" {
      log "${line}"
    }
  }
}
EOF

out3="$(e2e::run "for_lines_interior_blank.jh")"
grep -q "ℹ x" <<<"${out3}" || {
  echo "${out3}" >&2
  exit 1
}
grep -q "ℹ (empty)" <<<"${out3}" || {
  echo "${out3}" >&2
  exit 1
}
grep -q "ℹ y" <<<"${out3}" || {
  echo "${out3}" >&2
  exit 1
}
e2e::pass "interior empty line is still iterated"
