#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "step_output_contract"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

E2E_MOCK_BIN="${ROOT_DIR}/e2e/bin"
chmod 755 "${E2E_MOCK_BIN}/cursor-agent"
export PATH="${E2E_MOCK_BIN}:${PATH}"

# ===================================================================
e2e::section "shell: captures full stdout, stdout/stderr to artifacts"
# ===================================================================

e2e::file "contract_shell.jh" <<'EOF'
workflow default {
  out = echo "shell-value"
  echo "stdout-log"
  echo "stderr-log" >&2
  echo "captured=$out"
}
EOF
rm -rf "${TEST_DIR}/runs_shell"

JAIPH_RUNS_DIR="runs_shell" e2e::run "contract_shell.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_shell" "contract_shell.jh")"

shopt -s nullglob
out_files=( "${run_dir}"*default.out )
shopt -u nullglob
[[ ${#out_files[@]} -ge 1 ]] || e2e::fail "expected at least one .out artifact"
out_content="$(<"${out_files[0]}")"

e2e::assert_contains "${out_content}" "captured=shell-value" "shell capture = full stdout"
e2e::assert_contains "${out_content}" "stdout-log" "shell stdout in artifacts"

shopt -s nullglob
err_files=( "${run_dir}"*default.err )
shopt -u nullglob
if [[ ${#err_files[@]} -ge 1 ]]; then
  err_content="$(<"${err_files[0]}")"
  e2e::assert_contains "${err_content}" "stderr-log" "shell stderr in artifacts"
fi
e2e::pass "shell step output contract"

# ===================================================================
e2e::section "ensure rule: captures return value only, stdout to artifacts"
# ===================================================================

e2e::file "contract_ensure.jh" <<'EOF'
rule compute {
  echo "rule-stdout-goes-to-artifacts"
  return "${arg1}-processed"
}
workflow default {
  val = ensure compute "input"
  echo "captured=$val"
}
EOF
rm -rf "${TEST_DIR}/runs_ensure"

JAIPH_RUNS_DIR="runs_ensure" e2e::run "contract_ensure.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_ensure" "contract_ensure.jh")"

# Rule stdout goes to rule .out artifact
shopt -s nullglob
rule_outs=( "${run_dir}"*compute.out )
shopt -u nullglob
[[ ${#rule_outs[@]} -ge 1 ]] || e2e::fail "expected rule .out artifact"
rule_out_content="$(<"${rule_outs[0]}")"
e2e::assert_contains "${rule_out_content}" "rule-stdout-goes-to-artifacts" "rule stdout in artifact"

# Capture variable gets only return value
shopt -s nullglob
wf_outs=( "${run_dir}"*default.out )
shopt -u nullglob
[[ ${#wf_outs[@]} -ge 1 ]] || e2e::fail "expected workflow .out artifact"
wf_out_content="$(<"${wf_outs[0]}")"
e2e::assert_contains "${wf_out_content}" "captured=input-processed" "ensure capture = return value only"
if [[ "${wf_out_content}" == *"rule-stdout-goes-to-artifacts"* ]]; then
  e2e::fail "rule stdout must NOT leak into capture variable"
fi
e2e::pass "ensure rule output contract"

# ===================================================================
e2e::section "run workflow: captures return value only, stdout to artifacts"
# ===================================================================

e2e::file "contract_run.jh" <<'EOF'
workflow greeter {
  echo "workflow-stdout-goes-to-artifacts"
  return "hello-from-workflow"
}
workflow default {
  val = run greeter
  echo "captured=$val"
}
EOF
rm -rf "${TEST_DIR}/runs_run"

JAIPH_RUNS_DIR="runs_run" e2e::run "contract_run.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_run" "contract_run.jh")"

# Workflow stdout goes to greeter .out artifact
shopt -s nullglob
greeter_outs=( "${run_dir}"*greeter.out )
shopt -u nullglob
[[ ${#greeter_outs[@]} -ge 1 ]] || e2e::fail "expected greeter .out artifact"
greeter_out="$(<"${greeter_outs[0]}")"
e2e::assert_contains "${greeter_out}" "workflow-stdout-goes-to-artifacts" "workflow stdout in artifact"

# Capture variable gets only return value
shopt -s nullglob
wf_outs=( "${run_dir}"*default.out )
shopt -u nullglob
[[ ${#wf_outs[@]} -ge 1 ]] || e2e::fail "expected default .out artifact"
default_out="$(<"${wf_outs[0]}")"
e2e::assert_contains "${default_out}" "captured=hello-from-workflow" "run capture = return value only"
if [[ "${default_out}" == *"workflow-stdout-goes-to-artifacts"* ]]; then
  e2e::fail "workflow stdout must NOT leak into capture variable"
fi
e2e::pass "run workflow output contract"

# ===================================================================
e2e::section "function call: captures return value only, stdout to artifacts"
# ===================================================================

e2e::file "contract_fn.jh" <<'EOF'
script compute_hash() {
  echo "fn-stdout-goes-to-artifacts"
  return "hash-abc123"
}
workflow default {
  val = run compute_hash
  echo "captured=$val"
}
EOF
rm -rf "${TEST_DIR}/runs_fn"

JAIPH_RUNS_DIR="runs_fn" e2e::run "contract_fn.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_fn" "contract_fn.jh")"

shopt -s nullglob
wf_outs=( "${run_dir}"*default.out )
shopt -u nullglob
[[ ${#wf_outs[@]} -ge 1 ]] || e2e::fail "expected default .out artifact"
default_out="$(<"${wf_outs[0]}")"
e2e::assert_contains "${default_out}" "captured=hash-abc123" "function capture = return value only"
if [[ "${default_out}" == *"fn-stdout-goes-to-artifacts"* ]]; then
  e2e::fail "function stdout must NOT leak into capture variable"
fi
e2e::pass "function call output contract"

# ===================================================================
e2e::section "prompt: captures final answer, transcript to artifacts"
# ===================================================================

e2e::file "contract_prompt.jh" <<'EOF'
workflow default {
  answer = prompt "What is 2+2?"
  echo "captured=$answer"
}
EOF
rm -rf "${TEST_DIR}/runs_prompt"

JAIPH_RUNS_DIR="runs_prompt" e2e::run "contract_prompt.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_prompt" "contract_prompt.jh")"

# Prompt artifact exists
shopt -s nullglob
prompt_outs=( "${run_dir}"*jaiph__prompt.out )
shopt -u nullglob
[[ ${#prompt_outs[@]} -ge 1 ]] || e2e::fail "expected prompt .out artifact"
e2e::pass "prompt transcript in artifacts"

# Capture variable gets final answer (mock cursor-agent echoes the prompt text)
shopt -s nullglob
wf_outs=( "${run_dir}"*default.out )
shopt -u nullglob
[[ ${#wf_outs[@]} -ge 1 ]] || e2e::fail "expected default .out artifact"
default_out="$(<"${wf_outs[0]}")"
e2e::assert_contains "${default_out}" "captured=" "prompt capture produces a value"
e2e::pass "prompt output contract"

# ===================================================================
e2e::section "log/logerr: no value, messages as events"
# ===================================================================

e2e::file "contract_log.jh" <<'EOF'
workflow default {
  log "info-message"
  logerr "error-message"
  echo "done"
}
EOF
rm -rf "${TEST_DIR}/runs_log"

JAIPH_RUNS_DIR="runs_log" e2e::run "contract_log.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_log" "contract_log.jh")"

shopt -s nullglob
wf_outs=( "${run_dir}"*default.out )
shopt -u nullglob
[[ ${#wf_outs[@]} -ge 1 ]] || e2e::fail "expected default .out artifact"
wf_out="$(<"${wf_outs[0]}")"
e2e::assert_contains "${wf_out}" "info-message" "log message in .out artifact"
e2e::assert_contains "${wf_out}" "done" "workflow stdout in .out artifact"

shopt -s nullglob
wf_errs=( "${run_dir}"*default.err )
shopt -u nullglob
if [[ ${#wf_errs[@]} -ge 1 ]]; then
  wf_err="$(<"${wf_errs[0]}")"
  e2e::assert_contains "${wf_err}" "error-message" "logerr message in .err artifact"
fi
e2e::pass "log/logerr output contract"
