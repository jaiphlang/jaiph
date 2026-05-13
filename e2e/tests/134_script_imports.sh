#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

HAS_PYTHON3=0
command -v python3 >/dev/null 2>&1 && HAS_PYTHON3=1

# ---------------------------------------------------------------------------
e2e::section "import script: shell script via run"
# ---------------------------------------------------------------------------

e2e::prepare_test_env "script_import_shell"

e2e::file "greet.sh" <<'EOF'
#!/usr/bin/env bash
echo "hello from imported shell"
EOF
chmod +x "${JAIPH_E2E_TEST_DIR}/greet.sh"

e2e::file "main_shell.jh" <<'EOF'
import script "./greet.sh" as greet

workflow default() {
  run greet()
}
EOF

shell_out="$(e2e::run "main_shell.jh")"

e2e::expect_stdout "${shell_out}" <<'EOF'

Jaiph: Running main_shell.jh

workflow default
  ▸ script greet
  ✓ script greet (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out "main_shell.jh" "greet" "hello from imported shell"

e2e::pass "import script: shell script via run"

# ---------------------------------------------------------------------------
e2e::section "import script: capture stdout into const"
# ---------------------------------------------------------------------------

e2e::prepare_test_env "script_import_capture"

e2e::file "emit.sh" <<'EOF'
#!/usr/bin/env bash
echo "captured-from-shell"
EOF
chmod +x "${JAIPH_E2E_TEST_DIR}/emit.sh"

e2e::file "main_capture.jh" <<'EOF'
import script "./emit.sh" as emit

script consume = `echo "consumed: $1"`

workflow default() {
  const val = run emit()
  run consume(val)
}
EOF

cap_out="$(e2e::run "main_capture.jh")"

e2e::expect_stdout "${cap_out}" <<'EOF'

Jaiph: Running main_capture.jh

workflow default
  ▸ script emit
  ✓ script emit (<time>)
  ▸ script consume (1="captured-from-shell")
  ✓ script consume (<time>)

✓ PASS workflow default (<time>)
EOF

e2e::expect_out "main_capture.jh" "consume" "consumed: captured-from-shell"

e2e::pass "import script: capture stdout into const"

# ---------------------------------------------------------------------------
e2e::section "import script: missing file fails at compile time"
# ---------------------------------------------------------------------------

e2e::prepare_test_env "script_import_missing"

e2e::file "main_missing.jh" <<'EOF'
import script "./does_not_exist.py" as ghost

workflow default() {
  run ghost()
}
EOF

if run_out="$(e2e::run "main_missing.jh" 2>&1)"; then
  e2e::fail "expected compile error for missing script import, but run succeeded"
else
  # nondeterministic: error includes absolute file path prefix which varies
  e2e::assert_contains "${run_out}" 'resolves to missing file' "missing script import produces E_IMPORT_NOT_FOUND"
fi

# ---------------------------------------------------------------------------
e2e::section "import script: python script with shebang"
# ---------------------------------------------------------------------------

if [[ "${HAS_PYTHON3}" -eq 0 ]]; then
  e2e::skip "python3 not in PATH — skipping python import test"
else
  e2e::prepare_test_env "script_import_python"

  e2e::file "queue.py" <<'EOF'
#!/usr/bin/env python3
import sys
sys.stdout.write("hello-from-imported-python\n")
EOF

  e2e::file "main_python.jh" <<'EOF'
import script "./queue.py" as queue

workflow default() {
  run queue()
}
EOF

  py_out="$(e2e::run "main_python.jh")"

  e2e::expect_stdout "${py_out}" <<'EOF'

Jaiph: Running main_python.jh

workflow default
  ▸ script queue
  ✓ script queue (<time>)
✓ PASS workflow default (<time>)
EOF

  e2e::expect_out "main_python.jh" "queue" "hello-from-imported-python"

  e2e::pass "import script: python script with shebang"
fi
