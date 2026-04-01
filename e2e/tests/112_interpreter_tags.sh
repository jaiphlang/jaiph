#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

HAS_PYTHON3=0
HAS_NODE=0
command -v python3 >/dev/null 2>&1 && HAS_PYTHON3=1
command -v node >/dev/null 2>&1 && HAS_NODE=1

# ---------- script:node ----------

e2e::section "Interpreter tag: script:node"

if [[ "${HAS_NODE}" -eq 0 ]]; then
  e2e::fail "node not in PATH — cannot run script:node e2e"
else
  e2e::prepare_test_env "interpreter_tag_node"

  e2e::file "tag_node.jh" <<'EOF'
script:node greet {
  process.stdout.write("hello-from-node\n");
}

script plain_bash {
  echo bash-ok
}

workflow default {
  run greet()
  run plain_bash()
}
EOF

  run_out="$(e2e::run "tag_node.jh")"
  e2e::expect_stdout "${run_out}" <<'EOF'

Jaiph: Running tag_node.jh

workflow default
  ▸ script greet
  ✓ script greet (<time>)
  ▸ script plain_bash
  ✓ script plain_bash (<time>)
✓ PASS workflow default (<time>)
EOF

  e2e::expect_out_files "tag_node.jh" 3

  e2e::pass "script:node runs end-to-end"
fi

# ---------- script:python3 ----------

e2e::section "Interpreter tag: script:python3"

if [[ "${HAS_PYTHON3}" -eq 0 ]]; then
  e2e::fail "python3 not in PATH — cannot run script:python3 e2e"
else
  e2e::prepare_test_env "interpreter_tag_python3"

  e2e::file "tag_python.jh" <<'EOF'
script:python3 py_greet {
  import sys
  sys.stdout.write("hello-from-python\n")
  sys.exit(0)
}

workflow default {
  run py_greet()
}
EOF

  run_out="$(e2e::run "tag_python.jh")"
  e2e::expect_stdout "${run_out}" <<'EOF'

Jaiph: Running tag_python.jh

workflow default
  ▸ script py_greet
  ✓ script py_greet (<time>)
✓ PASS workflow default (<time>)
EOF

  e2e::expect_out_files "tag_python.jh" 2

  e2e::pass "script:python3 runs end-to-end"
fi

# ---------- unknown tag: compile error ----------

e2e::section "Interpreter tag: unknown tag rejected"

e2e::prepare_test_env "interpreter_tag_unknown"

e2e::file "bad_tag.jh" <<'EOF'
script:golang my_script {
  body
}

workflow default {
  run my_script()
}
EOF

if run_out="$(e2e::run "bad_tag.jh" 2>&1)"; then
  e2e::fail "expected compile error for unknown tag, but run succeeded"
else
  # nondeterministic: error includes absolute file path prefix which varies
  e2e::assert_contains "${run_out}" 'unknown interpreter tag "script:golang"' "unknown tag produces actionable error"
  e2e::assert_contains "${run_out}" "supported tags:" "error lists valid tags"
fi

# ---------- script:node with manual shebang: compile error ----------

e2e::section "Interpreter tag: duplicate shebang rejected"

e2e::prepare_test_env "interpreter_tag_dup_shebang"

e2e::file "dup_shebang.jh" <<'EOF'
script:node my_script {
  #!/usr/bin/env node
  console.log("hi");
}

workflow default {
  run my_script()
}
EOF

if run_out="$(e2e::run "dup_shebang.jh" 2>&1)"; then
  e2e::fail "expected compile error for duplicate shebang, but run succeeded"
else
  # nondeterministic: error includes absolute file path prefix which varies
  e2e::assert_contains "${run_out}" 'script:node already sets the shebang' "duplicate shebang produces actionable error"
fi
