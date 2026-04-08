#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "lib_import"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "lib import: resolve from .jaiph/libs/"
# ---------------------------------------------------------------------------

# Given — a lib installed under .jaiph/libs/mylib/ with an exported script
mkdir -p "${TEST_DIR}/.jaiph/libs/mylib"
cat > "${TEST_DIR}/.jaiph/libs/mylib/greet.jh" <<'EOF'
export script hello = `echo "hello from lib"`

export workflow say_hello() {
  run hello()
}
EOF

# And a main file that imports from the lib
e2e::file "main_lib.jh" <<'EOF'
import "mylib/greet" as greet

workflow default() {
  run greet.hello()
}
EOF

# When
main_out="$(e2e::run "main_lib.jh")"

# Then — CLI tree output
e2e::expect_stdout "${main_out}" <<'EOF'

Jaiph: Running main_lib.jh

workflow default
  ▸ script greet.hello
  ✓ script greet.hello (<time>)

✓ PASS workflow default (<time>)
EOF

# Then — run artifacts
e2e::expect_out "main_lib.jh" "greet.hello" "hello from lib"

e2e::pass "lib import: resolve from .jaiph/libs/"

# ---------------------------------------------------------------------------
e2e::section "lib import: exported workflow from lib"
# ---------------------------------------------------------------------------

e2e::file "main_lib_wf.jh" <<'EOF'
import "mylib/greet" as greet

workflow default() {
  run greet.say_hello()
}
EOF

# When
wf_out="$(e2e::run "main_lib_wf.jh")"

# Then
e2e::expect_stdout "${wf_out}" <<'EOF'

Jaiph: Running main_lib_wf.jh

workflow default
  ▸ workflow say_hello
  ·   ▸ script hello
  ·   ✓ script hello (<time>)
  ✓ workflow say_hello (<time>)

✓ PASS workflow default (<time>)
EOF

e2e::pass "lib import: exported workflow from lib"

# ---------------------------------------------------------------------------
e2e::section "lib import: relative imports still work"
# ---------------------------------------------------------------------------

# Given — a relative import (should resolve before lib fallback)
e2e::file "local_lib.jh" <<'EOF'
export script local_msg = `echo "local module"`
workflow dummy() {
  log "ok"
}
EOF

e2e::file "main_relative.jh" <<'EOF'
import "local_lib" as loc

workflow default() {
  run loc.local_msg()
}
EOF

# When
rel_out="$(e2e::run "main_relative.jh")"

# Then
e2e::expect_stdout "${rel_out}" <<'EOF'

Jaiph: Running main_relative.jh

workflow default
  ▸ script loc.local_msg
  ✓ script loc.local_msg (<time>)

✓ PASS workflow default (<time>)
EOF

e2e::pass "lib import: relative imports still work"

# ---------------------------------------------------------------------------
e2e::section "export script: parse and format round-trip"
# ---------------------------------------------------------------------------

# Given — a file with export script
e2e::file "export_script.jh" <<'EOF'
export script greet = `echo "hi"`

workflow default() {
  run greet()
}
EOF

# When — parse + run succeeds
es_out="$(e2e::run "export_script.jh")"

# Then
e2e::expect_out "export_script.jh" "greet" "hi"

e2e::pass "export script: parse and format round-trip"
