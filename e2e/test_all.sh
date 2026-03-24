#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

TEST_SCRIPTS=(
  "e2e/tests/00_install_and_init.sh"
  "e2e/tests/05_jaiph_use_pinned_version.sh"
  "e2e/tests/10_basic_workflows.sh"
  "e2e/tests/20_rule_and_prompt.sh"
  "e2e/tests/22_assign_capture.sh"
  "e2e/tests/23_prompt_returns_run_capture.sh"
  "e2e/tests/30_filesystem_side_effects.sh"
  "e2e/tests/40_nested_and_native_tests.sh"
  "e2e/tests/45_mock_workflow_rule_function.sh"
  "e2e/tests/50_cli_and_parse_guards.sh"
  "e2e/tests/60_ensure_conditionals.sh"
  "e2e/tests/61_ensure_recover.sh"
  "e2e/tests/65_fail_then_retry_pass.sh"
  "e2e/tests/70_run_artifacts.sh"
  "e2e/tests/71_loop_run_artifacts.sh"
  "e2e/tests/72_docker_run_artifacts.sh"
  "e2e/tests/73_docker_dockerfile_detection.sh"
  "e2e/tests/74_live_step_output.sh"
  "e2e/tests/80_cli_behavior.sh"
  "e2e/tests/81_tty_progress_tree.sh"
  "e2e/tests/85_infile_metadata.sh"
  "e2e/tests/86_metadata_scope_nested.sh"
  "e2e/tests/88_run_summary_event_contract.sh"
  "e2e/tests/90_function_steps.sh"
  "e2e/tests/91_inbox_dispatch.sh"
  "e2e/tests/91_top_level_local.sh"
  "e2e/tests/92_log_logerr.sh"
  "e2e/tests/94_parallel_shell_steps.sh"
  "e2e/tests/95_say_hello_failure_output.sh"
  "e2e/tests/96_run_stdout_redirect.sh"
  "e2e/tests/99_managed_call_semantics.sh"
)

PASS_COUNT=0
FAIL_COUNT=0

e2e::section "Suite setup"
e2e::prepare_shared_context
e2e::ensure_local_install
e2e::pass "shared install and workspace prepared"

for script in "${TEST_SCRIPTS[@]}"; do
  script_path="${ROOT_DIR}/${script}"
  script_name="$(basename "${script}" .sh)"
  test_dir="${JAIPH_E2E_WORK_DIR}/${script_name}"
  rm -rf "${test_dir}"
  mkdir -p "${test_dir}"

  e2e::section "Running ${script_name}"
  if JAIPH_E2E_SKIP_INSTALL=1 \
    JAIPH_E2E_TMP_DIR="${JAIPH_E2E_TMP_DIR:-}" \
    JAIPH_E2E_BIN_DIR="${JAIPH_E2E_BIN_DIR}" \
    JAIPH_E2E_WORK_DIR="${JAIPH_E2E_WORK_DIR}" \
    JAIPH_E2E_TEST_DIR="${test_dir}" \
    bash "${script_path}"; then
    PASS_COUNT=$((PASS_COUNT + 1))
    e2e::pass "${script_name}"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    e2e::fail "${script_name}"
  fi
done

e2e::section "Summary"
printf "  Passed scripts: %s\n" "${PASS_COUNT}"
printf "  Failed scripts: %s\n" "${FAIL_COUNT}"
printf "All e2e scripts completed successfully.\n"
