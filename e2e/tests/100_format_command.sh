#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "format_command"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# -------------------------------------------------------------------
e2e::section "jaiph format rewrites in place"

e2e::file "messy.jh" <<'EOF'
workflow    default   {
  log "hello"
}
EOF

jaiph format "${TEST_DIR}/messy.jh"

formatted="$(cat "${TEST_DIR}/messy.jh")"
e2e::assert_equals "${formatted}" 'workflow default {
  log "hello"
}' "format rewrites in place"

# -------------------------------------------------------------------
e2e::section "jaiph format is idempotent"

jaiph format "${TEST_DIR}/messy.jh"

formatted2="$(cat "${TEST_DIR}/messy.jh")"
e2e::assert_equals "${formatted2}" 'workflow default {
  log "hello"
}' "format is idempotent"

# -------------------------------------------------------------------
e2e::section "jaiph format --check exits 0 when already formatted"

check_exit=0
jaiph format --check "${TEST_DIR}/messy.jh" 2>/dev/null || check_exit=$?

e2e::assert_equals "${check_exit}" "0" "--check exits 0 for formatted file"

# -------------------------------------------------------------------
e2e::section "jaiph format --check exits 1 when changes needed"

e2e::file "unformatted.jh" <<'EOF'
workflow    default   {
  log "hello"
}
EOF

check_exit2=0
jaiph format --check "${TEST_DIR}/unformatted.jh" 2>/dev/null || check_exit2=$?

e2e::assert_equals "${check_exit2}" "1" "--check exits 1 for unformatted file"

# Verify --check did not modify the file
unformatted_after="$(cat "${TEST_DIR}/unformatted.jh")"
e2e::assert_equals "${unformatted_after}" 'workflow    default   {
  log "hello"
}' "--check does not modify file"

# -------------------------------------------------------------------
e2e::section "jaiph format --indent changes indent level"

e2e::file "indent4.jh" <<'EOF'
workflow default {
  log "hello"
}
EOF

jaiph format --indent 4 "${TEST_DIR}/indent4.jh"

indent4="$(cat "${TEST_DIR}/indent4.jh")"
e2e::assert_equals "${indent4}" 'workflow default {
    log "hello"
}' "format --indent 4 uses 4 spaces"

# -------------------------------------------------------------------
e2e::section "jaiph format rejects non-.jh files"

e2e::file "bad.txt" <<'EOF'
hello
EOF

bad_exit=0
jaiph format "${TEST_DIR}/bad.txt" 2>/dev/null || bad_exit=$?

e2e::assert_equals "${bad_exit}" "1" "rejects non-.jh files"

# -------------------------------------------------------------------
e2e::section "jaiph format fails on parse error"

e2e::file "broken.jh" <<'EOF'
this is not valid jaiph
EOF

parse_exit=0
jaiph format "${TEST_DIR}/broken.jh" 2>/dev/null || parse_exit=$?

e2e::assert_equals "${parse_exit}" "1" "fails on parse error"

# -------------------------------------------------------------------
e2e::section "jaiph format preserves shebang"

e2e::file "shebang.jh" <<'EOF'
#!/usr/bin/env jaiph

workflow default {
  log "hello"
}
EOF

jaiph format "${TEST_DIR}/shebang.jh"

shebang_out="$(cat "${TEST_DIR}/shebang.jh")"
e2e::assert_equals "${shebang_out}" '#!/usr/bin/env jaiph

workflow default {
  log "hello"
}' "preserves shebang"

# -------------------------------------------------------------------
e2e::section "jaiph format with no args prints usage"

no_args_exit=0
jaiph format 2>/dev/null || no_args_exit=$?

e2e::assert_equals "${no_args_exit}" "1" "no args exits 1"
