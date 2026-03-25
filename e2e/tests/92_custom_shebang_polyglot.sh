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

# When — build writes module + scripts with +x
jaiph build "${TEST_DIR}/polyglot.jh" >/dev/null

expected_module="${TEST_DIR}/polyglot.sh"
expected_py="${TEST_DIR}/scripts/py_echo_ok"
expected_bash="${TEST_DIR}/scripts/bash_marker"

e2e::assert_file_exists "${expected_module}" "built module polyglot.sh exists"
e2e::assert_file_exists "${expected_py}" "built scripts/py_echo_ok exists"
e2e::assert_file_exists "${expected_bash}" "built scripts/bash_marker exists"

e2e::assert_file_executable "${expected_module}" "module .sh is executable"
e2e::assert_file_executable "${expected_py}" "python script is executable"
e2e::assert_file_executable "${expected_bash}" "bash script is executable"

py_first="$(head -n 1 "${expected_py}")"
e2e::assert_equals "${py_first}" "#!/usr/bin/env python3" "python script shebang line"

bash_first="$(head -n 1 "${expected_bash}")"
e2e::assert_equals "${bash_first}" "#!/usr/bin/env bash" "default bash shebang when omitted in source"

e2e::assert_contains "$(<"${expected_py}")" "import sys" "python body preserved in script file"
e2e::assert_contains "$(<"${expected_bash}")" "bash-script-ran" "bash script body emitted"

e2e::assert_contains "$(<"${expected_module}")" 'export JAIPH_SCRIPTS=' "module exports JAIPH_SCRIPTS"
e2e::assert_contains "$(<"${expected_module}")" '"$JAIPH_SCRIPTS/py_echo_ok"' "module invokes python script by path"

# When / Then — end-to-end run (full tree: banner, both script steps, PASS)
run_out="$(e2e::run "polyglot.jh")"
e2e::expect_stdout "${run_out}" <<'EOF'

Jaiph: Running polyglot.jh

workflow default
  ▸ script py_echo_ok (1="<script-path>")
  ✓ script py_echo_ok (<time>)
  ▸ script bash_marker (1="<script-path>")
  ✓ script bash_marker (<time>)
✓ PASS workflow default (<time>)
EOF

# Script steps are external processes; each run_step captures a .out artifact.
e2e::expect_out_files "polyglot.jh" 2

e2e::pass "custom shebang python3 script runs via JAIPH_SCRIPTS end-to-end"
