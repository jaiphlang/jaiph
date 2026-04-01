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
e2e::section "script: captures stdout, stderr to artifacts"
# ===================================================================

e2e::file "contract_shell.jh" <<'EOF'
script emit_value {
  echo "shell-value"
}
script emit_stdout {
  echo "stdout-log"
}
script emit_stderr {
  echo "stderr-log" >&2
}
script emit_captured {
  echo "captured=$1"
}
workflow default {
  out = run emit_value()
  run emit_stdout()
  run emit_stderr()
  run emit_captured("${out}")
}
EOF
rm -rf "${TEST_DIR}/runs_shell"

JAIPH_RUNS_DIR="runs_shell" e2e::run "contract_shell.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_shell" "contract_shell.jh")"

# Capture variable gets script stdout
shopt -s nullglob
cap_files=( "${run_dir}"/*emit_captured.out )
shopt -u nullglob
[[ ${#cap_files[@]} -ge 1 ]] || e2e::fail "expected emit_captured .out artifact"
cap_content="$(<"${cap_files[0]}")"
e2e::assert_contains "${cap_content}" "captured=shell-value" "script capture = full stdout"

# Script stdout goes to script .out artifact
shopt -s nullglob
stdout_files=( "${run_dir}"/*emit_stdout.out )
shopt -u nullglob
[[ ${#stdout_files[@]} -ge 1 ]] || e2e::fail "expected emit_stdout .out artifact"
stdout_content="$(<"${stdout_files[0]}")"
e2e::assert_contains "${stdout_content}" "stdout-log" "script stdout in artifacts"

# Script stderr goes to script .err artifact
shopt -s nullglob
err_files=( "${run_dir}"/*emit_stderr.err )
shopt -u nullglob
if [[ ${#err_files[@]} -ge 1 ]]; then
  err_content="$(<"${err_files[0]}")"
  e2e::assert_contains "${err_content}" "stderr-log" "script stderr in artifacts"
fi
e2e::pass "script step output contract"

# ===================================================================
e2e::section "ensure rule: captures return value only, stdout to artifacts"
# ===================================================================

e2e::file "contract_ensure.jh" <<'EOF'
script compute_echo {
  echo "rule-stdout-goes-to-artifacts"
}
rule compute {
  run compute_echo()
  return "${arg1}-processed"
}
script echo_captured_ensure {
  echo "captured=$1"
}
workflow default {
  val = ensure compute("input")
  run echo_captured_ensure("${val}")
}
EOF
rm -rf "${TEST_DIR}/runs_ensure"

JAIPH_RUNS_DIR="runs_ensure" e2e::run "contract_ensure.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_ensure" "contract_ensure.jh")"

# Rule's script stdout goes to script .out artifact
shopt -s nullglob
rule_script_outs=( "${run_dir}"/*compute_echo.out )
shopt -u nullglob
[[ ${#rule_script_outs[@]} -ge 1 ]] || e2e::fail "expected compute_echo .out artifact"
rule_script_content="$(<"${rule_script_outs[0]}")"
e2e::assert_equals "${rule_script_content}" "rule-stdout-goes-to-artifacts" "rule script stdout in artifact"

# Capture variable gets only return value
shopt -s nullglob
cap_outs=( "${run_dir}"/*echo_captured_ensure.out )
shopt -u nullglob
[[ ${#cap_outs[@]} -ge 1 ]] || e2e::fail "expected echo_captured_ensure .out artifact"
cap_content="$(<"${cap_outs[0]}")"
e2e::assert_equals "${cap_content}" "captured=input-processed" "ensure capture = return value only"
if [[ "${cap_content}" == *"rule-stdout-goes-to-artifacts"* ]]; then
  e2e::fail "rule stdout must NOT leak into capture variable"
fi
e2e::pass "ensure rule output contract"

# ===================================================================
e2e::section "run workflow: captures return value only, stdout to artifacts"
# ===================================================================

e2e::file "contract_run.jh" <<'EOF'
script greeter_impl {
  echo "workflow-stdout-goes-to-artifacts"
}
workflow greeter {
  run greeter_impl()
  return "hello-from-workflow"
}
script echo_captured_run {
  echo "captured=$1"
}
workflow default {
  val = run greeter()
  run echo_captured_run("${val}")
}
EOF
rm -rf "${TEST_DIR}/runs_run"

JAIPH_RUNS_DIR="runs_run" e2e::run "contract_run.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_run" "contract_run.jh")"

# Workflow's script stdout goes to script .out artifact
shopt -s nullglob
greeter_outs=( "${run_dir}"/*greeter_impl.out )
shopt -u nullglob
[[ ${#greeter_outs[@]} -ge 1 ]] || e2e::fail "expected greeter_impl .out artifact"
greeter_out="$(<"${greeter_outs[0]}")"
e2e::assert_equals "${greeter_out}" "workflow-stdout-goes-to-artifacts" "workflow script stdout in artifact"

# Capture variable gets only return value
shopt -s nullglob
cap_outs=( "${run_dir}"/*echo_captured_run.out )
shopt -u nullglob
[[ ${#cap_outs[@]} -ge 1 ]] || e2e::fail "expected echo_captured_run .out artifact"
cap_content="$(<"${cap_outs[0]}")"
e2e::assert_equals "${cap_content}" "captured=hello-from-workflow" "run capture = return value only"
if [[ "${cap_content}" == *"workflow-stdout-goes-to-artifacts"* ]]; then
  e2e::fail "workflow stdout must NOT leak into capture variable"
fi
e2e::pass "run workflow output contract"

# ===================================================================
e2e::section "function call: captures return value only, stderr to artifacts"
# ===================================================================

e2e::file "contract_fn.jh" <<'EOF'
script compute_hash {
  echo "fn-stderr-goes-to-artifacts" >&2
  echo "hash-abc123"
}
script echo_captured_fn {
  echo "captured=$1"
}
workflow default {
  val = run compute_hash()
  run echo_captured_fn("${val}")
}
EOF
rm -rf "${TEST_DIR}/runs_fn"

JAIPH_RUNS_DIR="runs_fn" e2e::run "contract_fn.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_fn" "contract_fn.jh")"

shopt -s nullglob
cap_outs=( "${run_dir}"/*echo_captured_fn.out )
shopt -u nullglob
[[ ${#cap_outs[@]} -ge 1 ]] || e2e::fail "expected echo_captured_fn .out artifact"
cap_content="$(<"${cap_outs[0]}")"
e2e::assert_equals "${cap_content}" "captured=hash-abc123" "function capture = stdout only"
if [[ "${cap_content}" == *"fn-stderr-goes-to-artifacts"* ]]; then
  e2e::fail "function stderr must NOT leak into capture variable"
fi
e2e::pass "function call output contract"

# ===================================================================
e2e::section "prompt: captures final answer, transcript to artifacts"
# ===================================================================

e2e::file "contract_prompt.jh" <<'EOF'
config {
  agent.backend = "cursor"
}
script echo_captured_prompt {
  echo "captured=$1"
}
workflow default {
  answer = prompt "What is 2+2?"
  run echo_captured_prompt("${answer}")
}
EOF
rm -rf "${TEST_DIR}/runs_prompt"

JAIPH_RUNS_DIR="runs_prompt" e2e::run "contract_prompt.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_prompt" "contract_prompt.jh")"

# Prompt artifact exists
shopt -s nullglob
prompt_outs=( "${run_dir}"/*prompt__prompt.out "${run_dir}"/*jaiph__prompt.out )
shopt -u nullglob
[[ ${#prompt_outs[@]} -ge 1 ]] || e2e::fail "expected prompt .out artifact"
e2e::pass "prompt transcript in artifacts"

# Capture variable gets final answer (mock cursor-agent echoes the prompt text)
shopt -s nullglob
cap_outs=( "${run_dir}"/*echo_captured_prompt.out )
shopt -u nullglob
[[ ${#cap_outs[@]} -ge 1 ]] || e2e::fail "expected echo_captured_prompt .out artifact"
cap_content="$(<"${cap_outs[0]}")"
# assert_contains: prompt capture value depends on mock cursor-agent output format (nondeterministic)
e2e::assert_contains "${cap_content}" "captured=" "prompt capture produces a value"
e2e::pass "prompt output contract"

# ===================================================================
e2e::section "log/logerr: messages to workflow artifacts"
# ===================================================================

e2e::file "contract_log.jh" <<'EOF'
script echo_done {
  echo "done"
}
workflow default {
  log "info-message"
  logerr "error-message"
  run echo_done()
}
EOF
rm -rf "${TEST_DIR}/runs_log"

JAIPH_RUNS_DIR="runs_log" e2e::run "contract_log.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_log" "contract_log.jh")"

shopt -s nullglob
wf_outs=( "${run_dir}"/*default.out )
shopt -u nullglob
[[ ${#wf_outs[@]} -ge 1 ]] || e2e::fail "expected default .out artifact"
wf_out="$(<"${wf_outs[0]}")"
e2e::assert_contains "${wf_out}" "info-message" "log message in .out artifact"

# Script stdout goes to script .out
shopt -s nullglob
done_outs=( "${run_dir}"/*echo_done.out )
shopt -u nullglob
[[ ${#done_outs[@]} -ge 1 ]] || e2e::fail "expected echo_done .out artifact"
done_content="$(<"${done_outs[0]}")"
e2e::assert_contains "${done_content}" "done" "script stdout in .out artifact"

shopt -s nullglob
wf_errs=( "${run_dir}"/*default.err )
shopt -u nullglob
if [[ ${#wf_errs[@]} -ge 1 ]]; then
  wf_err="$(<"${wf_errs[0]}")"
  # assert_contains: .err may include runtime-injected stderr alongside logerr text
  e2e::assert_contains "${wf_err}" "error-message" "logerr message in .err artifact"
fi
e2e::pass "log/logerr output contract"
