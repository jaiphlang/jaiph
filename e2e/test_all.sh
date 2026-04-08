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
  "e2e/tests/45_mock_workflow_rule_script.sh"
  "e2e/tests/50_cli_and_parse_guards.sh"
  "e2e/tests/60_ensure_conditionals.sh"
  "e2e/tests/61_ensure_recover.sh"
  "e2e/tests/65_fail_then_retry_pass.sh"
  "e2e/tests/70_run_artifacts.sh"
  "e2e/tests/71_loop_run_artifacts.sh"
  "e2e/tests/72_docker_run_artifacts.sh"
  "e2e/tests/73_docker_dockerfile_detection.sh"
  "e2e/tests/74_live_step_output.sh"
  "e2e/tests/78_lang_redesign_constructs.sh"
  "e2e/tests/79_workflow_fail_keyword.sh"
  "e2e/tests/80_cli_behavior.sh"
  "e2e/tests/81_tty_progress_tree.sh"
  "e2e/tests/82_sibling_parse_error.sh"
  "e2e/tests/85_infile_metadata.sh"
  "e2e/tests/86_metadata_scope_nested.sh"
  "e2e/tests/87_workflow_config.sh"
  "e2e/tests/88_run_summary_event_contract.sh"
  "e2e/tests/89_reporting_server.sh"
  "e2e/tests/90_script_steps.sh"
  "e2e/tests/91_inbox_dispatch.sh"
  "e2e/tests/91_top_level_local.sh"
  "e2e/tests/92_custom_shebang_polyglot.sh"
  "e2e/tests/92_log_logerr.sh"
  "e2e/tests/93_ensure_recover_payload.sh"
  "e2e/tests/93_inbox_stress.sh"
  "e2e/tests/94_parallel_shell_steps.sh"
  "e2e/tests/95_say_hello_failure_output.sh"
  "e2e/tests/97_async_managed_failure.sh"
  "e2e/tests/97_step_output_contract.sh"
  "e2e/tests/98_ensure_recover_value.sh"
  "e2e/tests/99_managed_call_semantics.sh"
  "e2e/tests/100_ensure_recover_invalid.sh"
  "e2e/tests/100_format_command.sh"
  "e2e/tests/100_bare_identifier_args.sh"
  "e2e/tests/100_inline_capture_interpolation.sh"
  "e2e/tests/101_ensure_recover_output_contract.sh"
  "e2e/tests/101_script_isolation.sh"
  "e2e/tests/102_engineer_recover_contract.sh"
  "e2e/tests/103_run_dir_source_name.sh"
  "e2e/tests/104_run_async.sh"
  "e2e/tests/105_test_jh_verification.sh"
  "e2e/tests/106_dot_notation.sh"
  "e2e/tests/107_return_managed_call.sh"
  "e2e/tests/110_examples.sh"
  "e2e/tests/111_inline_script.sh"
  "e2e/tests/112_interpreter_tags.sh"
  "e2e/tests/113_match_expression.sh"
  "e2e/tests/114_if_else_chains.sh"
  "e2e/tests/115_custom_agent_command.sh"
  "e2e/tests/116_cross_file_import.sh"
  "e2e/tests/117_double_dash_passthrough.sh"
  "e2e/tests/118_import_not_found.sh"
  "e2e/tests/119_lib_import.sh"
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
