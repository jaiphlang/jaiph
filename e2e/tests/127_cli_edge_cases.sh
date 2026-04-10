#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "cli_edge_cases"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. jaiph format --indent with non-integer value ────────────────────────

e2e::section "format --indent with non-integer value"

e2e::file "simple.jh" <<'EOF'
workflow default() {
  log "hello"
}
EOF

indent_err="$(mktemp)"
if jaiph format --indent abc "${TEST_DIR}/simple.jh" 2>"${indent_err}"; then
  rm -f "${indent_err}"
  e2e::fail "format --indent abc should fail"
fi
indent_msg="$(cat "${indent_err}")"
rm -f "${indent_err}"

# assert_contains: error message is a static string but exact wording may evolve
e2e::assert_contains "${indent_msg}" "positive integer" "format --indent abc reports error"

# ── 2. jaiph format --indent with no value ─────────────────────────────────

e2e::section "format --indent with no value"

indent_none_err="$(mktemp)"
if jaiph format --indent 2>"${indent_none_err}"; then
  rm -f "${indent_none_err}"
  e2e::fail "format --indent (no value) should fail"
fi
indent_none_msg="$(cat "${indent_none_err}")"
rm -f "${indent_none_err}"

# assert_contains: error message is a static string but exact wording may evolve
e2e::assert_contains "${indent_none_msg}" "positive integer" "format --indent with no value reports error"

# ── 3. jaiph format on unreadable file ─────────────────────────────────────

e2e::section "format on unreadable file"

e2e::file "unreadable.jh" <<'EOF'
workflow default() {
  log "hello"
}
EOF
chmod 000 "${TEST_DIR}/unreadable.jh"

unread_err="$(mktemp)"
if jaiph format "${TEST_DIR}/unreadable.jh" 2>"${unread_err}"; then
  rm -f "${unread_err}"
  chmod 644 "${TEST_DIR}/unreadable.jh"
  e2e::fail "format should fail on unreadable file"
fi
unread_msg="$(cat "${unread_err}")"
rm -f "${unread_err}"
chmod 644 "${TEST_DIR}/unreadable.jh"

# assert_contains: error message includes dynamic path
e2e::assert_contains "${unread_msg}" "cannot read file" "format reports unreadable file"

# ── 4. jaiph compile --workspace with no value ─────────────────────────────

e2e::section "compile --workspace with no value"

ws_err="$(mktemp)"
if jaiph compile --workspace 2>"${ws_err}"; then
  rm -f "${ws_err}"
  e2e::fail "compile --workspace with no value should fail"
fi
ws_msg="$(cat "${ws_err}")"
rm -f "${ws_err}"

# assert_contains: usage message is multiline and includes dynamic help text
e2e::assert_contains "${ws_msg}" "Usage" "compile --workspace with no value shows usage"

# ── 5. jaiph compile on empty directory ────────────────────────────────────

e2e::section "compile on empty directory"

mkdir -p "${TEST_DIR}/empty_dir"

# Empty directory has no .jh files, so compile should succeed (nothing to validate)
jaiph compile "${TEST_DIR}/empty_dir"
e2e::pass "compile on empty directory exits 0"

# ── 6. jaiph compile --json on parse error ─────────────────────────────────

e2e::section "compile --json on parse error"

e2e::file "parse_bad.jh" <<'EOF'
workflow default() {
  log "unterminated
}
EOF

json_parse_out="$(jaiph compile --json "${TEST_DIR}/parse_bad.jh" 2>/dev/null || true)"

# assert_contains: JSON output includes dynamic file paths and positions
e2e::assert_contains "${json_parse_out}" "E_PARSE" "compile --json on parse error includes E_PARSE"

# ── 7. jaiph compile rejects non-.jh file ──────────────────────────────────

e2e::section "compile rejects non-.jh file"

e2e::file "readme.md" <<'EOF'
# Not a Jaiph file
EOF

nonjh_err="$(mktemp)"
if jaiph compile "${TEST_DIR}/readme.md" 2>"${nonjh_err}"; then
  rm -f "${nonjh_err}"
  e2e::fail "compile should reject non-.jh file"
fi
nonjh_msg="$(cat "${nonjh_err}")"
rm -f "${nonjh_err}"

# assert_contains: error message includes dynamic file name
e2e::assert_contains "${nonjh_msg}" "compile expects .jh" "compile rejects non-.jh file"

# ── 8. jaiph format --check on multiple files, some need formatting ────────

e2e::section "format --check with mixed files"

e2e::file "clean.jh" <<'EOF'
workflow default() {
  log "hello"
}
EOF

e2e::file "dirty.jh" <<'EOF'
workflow    default()   {
  log "hello"
}
EOF

check_exit=0
jaiph format --check "${TEST_DIR}/clean.jh" "${TEST_DIR}/dirty.jh" 2>/dev/null || check_exit=$?
e2e::assert_equals "${check_exit}" "1" "format --check exits 1 when any file needs formatting"

# ── 9. jaiph compile with no arguments ─────────────────────────────────────

e2e::section "compile with no arguments"

compile_no_args_err="$(mktemp)"
if jaiph compile 2>"${compile_no_args_err}"; then
  rm -f "${compile_no_args_err}"
  e2e::fail "compile with no arguments should fail"
fi
compile_no_args_msg="$(cat "${compile_no_args_err}")"
rm -f "${compile_no_args_err}"

# assert_contains: usage output is multiline with dynamic content
e2e::assert_contains "${compile_no_args_msg}" "Usage" "compile with no args shows usage"

# ── 10. jaiph format with no arguments ─────────────────────────────────────

e2e::section "format with no arguments"

fmt_no_args_err="$(mktemp)"
if jaiph format 2>"${fmt_no_args_err}"; then
  rm -f "${fmt_no_args_err}"
  e2e::fail "format with no arguments should fail"
fi
fmt_no_args_msg="$(cat "${fmt_no_args_err}")"
rm -f "${fmt_no_args_err}"

# assert_contains: usage output is multiline
e2e::assert_contains "${fmt_no_args_msg}" "Usage" "format with no args shows usage"
