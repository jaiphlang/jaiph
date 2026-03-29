#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "custom_shebang_polyglot"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Custom shebang script: build output and jaiph run"

if ! command -v python3 >/dev/null 2>&1; then
  e2e::skip "python3 not in PATH — cannot run polyglot shebang e2e"
  exit 0
fi

# Given — Python entrypoint script + bash script (default shebang)
e2e::file "polyglot.jh" <<'EOF'
script py_echo_ok() {
  #!/usr/bin/env python3
  import sys
  sys.stdout.write("polyglot-ok\n")
  sys.exit(0)
}

script bash_marker() {
  echo bash-script-ran
}

workflow default {
  run py_echo_ok
  run bash_marker
}
EOF

# When / Then — end-to-end run (full tree: banner, both script steps, PASS)
run_out="$(e2e::run "polyglot.jh")"
e2e::expect_stdout "${run_out}" <<'EOF'

Jaiph: Running polyglot.jh

workflow default
  ▸ script py_echo_ok
  ✓ script py_echo_ok (<time>)
  ▸ script bash_marker
  ✓ script bash_marker (<time>)
✓ PASS workflow default (<time>)
EOF

# Script steps are external processes; each run_step captures a .out artifact.
e2e::expect_out_files "polyglot.jh" 3

e2e::pass "custom shebang python3 script runs via JAIPH_SCRIPTS end-to-end"
