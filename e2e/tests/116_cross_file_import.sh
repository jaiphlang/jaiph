#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "cross_file_import"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "cross-file import: run exported workflow"
# ---------------------------------------------------------------------------

# Given — a library module with an exported workflow and a main file that imports it
e2e::file "lib.jh" <<'EOF'
script greet_impl = `echo "hello from lib"`

export def greet() {
  run greet_impl()
}
EOF

e2e::file "main_wf.jh" <<'EOF'
import "lib.jh" as lib

export def main() {
  run lib.greet()
}
EOF

# When
main_out="$(e2e::run "main_wf.jh")"

# Then — CLI tree output
e2e::expect_stdout "${main_out}" <<'EOF'

Jaiph: Running main_wf.jh

def main
  ▸ def greet
  ·   ▸ script greet_impl
  ·   ✓ script greet_impl (<time>)
  ✓ def greet (<time>)

✓ PASS def main (<time>)
EOF

# Then — run artifacts
e2e::expect_out "main_wf.jh" "greet_impl" "hello from lib"

e2e::pass "cross-file import: run exported workflow"

# ---------------------------------------------------------------------------
e2e::section "cross-file import: run exported script"
# ---------------------------------------------------------------------------

# Given
e2e::file "scriptlib.jh" <<'EOF'
export script echo_msg = `echo "script-lib-msg"`
def dummy() {
  log "ok"
}
EOF

e2e::file "main_script.jh" <<'EOF'
import "scriptlib.jh" as slib

export def main() {
  run slib.echo_msg()
}
EOF

# When
script_out="$(e2e::run "main_script.jh")"

# Then — CLI tree output
e2e::expect_stdout "${script_out}" <<'EOF'

Jaiph: Running main_script.jh

def main
  ▸ script slib.echo_msg
  ✓ script slib.echo_msg (<time>)

✓ PASS def main (<time>)
EOF

# Then — run artifacts
e2e::expect_out "main_script.jh" "slib.echo_msg" "script-lib-msg"

e2e::pass "cross-file import: run exported script"

# ---------------------------------------------------------------------------
e2e::section "cross-file import: run exported rule"
# ---------------------------------------------------------------------------

# Given
e2e::file "rulelib.jh" <<'EOF'
script check_impl = `true`
export def passes() {
  run check_impl()
}
EOF

e2e::file "main_rule.jh" <<'EOF'
import "rulelib.jh" as rlib

export def main() {
  run rlib.passes()
  log "rule passed"
}
EOF

# When
rule_out="$(e2e::run "main_rule.jh")"

# Then — CLI tree output
e2e::expect_stdout "${rule_out}" <<'EOF'

Jaiph: Running main_rule.jh

def main
  ▸ def passes
  ·   ▸ script check_impl
  ·   ✓ script check_impl (<time>)
  ✓ def passes (<time>)
  ℹ rule passed

✓ PASS def main (<time>)
EOF

e2e::pass "cross-file import: run exported rule"

# ---------------------------------------------------------------------------
e2e::section "cross-file import: capture from exported script"
# ---------------------------------------------------------------------------

# Given
e2e::file "caplib.jh" <<'EOF'
export script get_value = `echo "captured-value"`
def dummy() {
  log "ok"
}
EOF

e2e::file "main_capture.jh" <<'EOF'
import "caplib.jh" as clib

script show = `echo "got: $1"`

export def main() {
  const val = run clib.get_value()
  run show(val)
}
EOF

# When
cap_out="$(e2e::run "main_capture.jh")"

# Then — run artifacts
e2e::expect_out "main_capture.jh" "show" "got: captured-value"

e2e::pass "cross-file import: capture from exported script"
