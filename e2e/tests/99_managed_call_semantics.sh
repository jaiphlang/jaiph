#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "managed_call_semantics"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "run script: stdout capture and step artifacts"

e2e::file "run_fn_ok.jh" <<'EOF'
script give {
  echo "log-to-artifacts"
  echo "captured-value"
}

script print_capture {
  echo "out=x=$1"
}

workflow default {
  x = run give()
  run print_capture("$x")
}
EOF

rm -rf "${TEST_DIR}/runs_mc"
JAIPH_RUNS_DIR="runs_mc" e2e::run "run_fn_ok.jh" >/dev/null

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_mc" "run_fn_ok.jh")"
shopt -s nullglob
wf_outs=( "${run_dir}"*default.out )
shopt -u nullglob
[[ ${#wf_outs[@]} -ge 1 ]] || e2e::fail "expected default .out for run_fn_ok"

shopt -s nullglob
fn_log_file=""
for f in "${run_dir}"/*.out; do
  [[ "$f" == *default.out ]] && continue
  if grep -q "log-to-artifacts" "$f" 2>/dev/null; then
    fn_log_file="$f"
    break
  fi
done
shopt -u nullglob
[[ -n "$fn_log_file" ]] || e2e::fail "expected a non-default step .out containing function stdout"
# assert_contains: script .out aggregates all stdout lines; exact multi-line content depends on capture semantics
e2e::assert_contains "$(<"$fn_log_file")" "log-to-artifacts" "function stdout in step artifact"

e2e::pass "run script success path"

e2e::section "compiler rejects direct function call in workflow"

e2e::file "direct_fn.jh" <<'EOF'
script f {
  return "x"
}
workflow default {
  f
}
EOF

if jaiph run "${TEST_DIR}/direct_fn.jh" >/dev/null 2>&1; then
  e2e::fail "expected run to fail on direct function call"
fi
e2e::pass "direct function invocation rejected"

e2e::section "compiler rejects Jaiph function inside command substitution"

e2e::file "sub_fn.jh" <<'EOF'
script f {
  return "x"
}
workflow default {
  x="$(f)"
}
EOF

if jaiph run "${TEST_DIR}/sub_fn.jh" >/dev/null 2>&1; then
  e2e::fail "expected run to fail on \$(f)"
fi
e2e::pass "command substitution with Jaiph function rejected"

e2e::section "ensure and run workflows still build"

e2e::file "ensure_run_smoke.jh" <<'EOF'
script ok_impl {
  true
}

rule ok {
  run ok_impl()
}
workflow child {
  ensure ok()
}
workflow default {
  ensure ok()
  run child()
}
EOF

smoke_out="$(jaiph run "${TEST_DIR}/ensure_run_smoke.jh" 2>&1)"
e2e::pass "ensure and run regression smoke"
