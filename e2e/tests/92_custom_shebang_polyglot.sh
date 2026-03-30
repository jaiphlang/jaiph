#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

HAS_PYTHON3=0
HAS_NODE=0
command -v python3 >/dev/null 2>&1 && HAS_PYTHON3=1
command -v node >/dev/null 2>&1 && HAS_NODE=1

# ---------- Python3 shebang ----------

e2e::section "Custom shebang script: Python3 polyglot"

if [[ "${HAS_PYTHON3}" -eq 0 ]]; then
  # Tests needs to be strict here.
  e2e::fail "python3 not in PATH — cannot run Python polyglot shebang e2e"
else
  e2e::prepare_test_env "custom_shebang_polyglot_py"
  TEST_DIR="${JAIPH_E2E_TEST_DIR}"

  e2e::file "polyglot.jh" <<'EOF'
script py_echo_ok {
  #!/usr/bin/env python3
  import sys
  sys.stdout.write("polyglot-ok\n")
  sys.exit(0)
}

script bash_marker {
  echo bash-script-ran
}

workflow default {
  run py_echo_ok()
  run bash_marker()
}
EOF

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

  e2e::expect_out_files "polyglot.jh" 3

  e2e::pass "custom shebang python3 script runs via JAIPH_SCRIPTS end-to-end"
fi

# ---------- Node shebang ----------

e2e::section "Custom shebang script: Node polyglot"

if [[ "${HAS_NODE}" -eq 0 ]]; then
  # Tests needs to be strict here.
  e2e::fail "node not in PATH — cannot run Node polyglot shebang e2e"
else
  e2e::prepare_test_env "custom_shebang_polyglot_node"
  TEST_DIR="${JAIPH_E2E_TEST_DIR}"

  e2e::file "polyglot_node.jh" <<'EOF'
script node_echo_ok {
  #!/usr/bin/env node
  process.stdout.write("node-polyglot-ok\n");
  process.exit(0);
}

script bash_marker {
  echo bash-script-ran
}

workflow default {
  run node_echo_ok()
  run bash_marker()
}
EOF

  run_out="$(e2e::run "polyglot_node.jh")"
  e2e::expect_stdout "${run_out}" <<'EOF'

Jaiph: Running polyglot_node.jh

workflow default
  ▸ script node_echo_ok
  ✓ script node_echo_ok (<time>)
  ▸ script bash_marker
  ✓ script bash_marker (<time>)
✓ PASS workflow default (<time>)
EOF

  e2e::expect_out_files "polyglot_node.jh" 3

  e2e::pass "custom shebang node script runs via JAIPH_SCRIPTS end-to-end"
fi
