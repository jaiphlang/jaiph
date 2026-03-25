#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "managed_call_semantics"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "run function: return capture and step artifacts"

e2e::file "run_fn_ok.jh" <<'EOF'
script give() {
  echo "log-to-artifacts"
  return "captured-value"
}

workflow default {
  x = run give
  echo "out=x=$x"
}
EOF

rm -rf "${TEST_DIR}/runs_mc"
JAIPH_RUNS_DIR="runs_mc" e2e::run "run_fn_ok.jh" >/dev/null

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_mc" "run_fn_ok.jh")"
shopt -s nullglob
wf_outs=( "${run_dir}"*default.out )
shopt -u nullglob
[[ ${#wf_outs[@]} -ge 1 ]] || e2e::fail "expected default .out for run_fn_ok"
default_out="$(<"${wf_outs[0]}")"
e2e::assert_contains "${default_out}" "out=x=captured-value" "run function assigns explicit return only"

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
e2e::assert_contains "$(<"$fn_log_file")" "log-to-artifacts" "function stdout in step artifact"

e2e::pass "run function success path"

e2e::section "compiler rejects direct function call in workflow"

e2e::file "direct_fn.jh" <<'EOF'
script f() {
  return "x"
}
workflow default {
  f
}
EOF

if jaiph build "${TEST_DIR}/direct_fn.jh" >/dev/null 2>&1; then
  e2e::fail "expected build to fail on direct function call"
fi
e2e::pass "direct function invocation rejected"

e2e::section "compiler rejects Jaiph function inside command substitution"

e2e::file "sub_fn.jh" <<'EOF'
script f() {
  return "x"
}
workflow default {
  x="$(f)"
}
EOF

if jaiph build "${TEST_DIR}/sub_fn.jh" >/dev/null 2>&1; then
  e2e::fail "expected build to fail on \$(f)"
fi
e2e::pass "command substitution with Jaiph function rejected"

e2e::section "ensure and run workflows still build"

e2e::file "ensure_run_smoke.jh" <<'EOF'
rule ok {
  true
}
workflow child {
  ensure ok
}
workflow default {
  ensure ok
  run child
}
EOF

jaiph build "${TEST_DIR}/ensure_run_smoke.jh" >/dev/null
e2e::pass "ensure and run regression smoke"
