#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "artifacts_lib"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "artifacts lib: save and save_patch"
# ---------------------------------------------------------------------------

# Set up a git repo so save_patch works
cd "${TEST_DIR}"
e2e::git_init
git config user.email "test@test.com"
git config user.name "test"

# Install the jaiphlang lib into the test workspace
mkdir -p "${TEST_DIR}/.jaiph/libs/jaiphlang"
cp "${ROOT_DIR}/.jaiph/libs/jaiphlang/artifacts.jh" "${TEST_DIR}/.jaiph/libs/jaiphlang/artifacts.jh"
cp "${ROOT_DIR}/.jaiph/libs/jaiphlang/artifacts.sh" "${TEST_DIR}/.jaiph/libs/jaiphlang/artifacts.sh"
chmod +x "${TEST_DIR}/.jaiph/libs/jaiphlang/artifacts.sh"

# Create a source file to save as an artifact
printf 'build-output-content' > "${TEST_DIR}/build_output.txt"

# Create uncommitted changes for save_patch
printf 'new-file-content\n' > "${TEST_DIR}/tracked.txt"
git add tracked.txt
git commit -m "initial" --quiet
printf 'modified-content\n' > "${TEST_DIR}/tracked.txt"

# Create .jaiph/some-state to verify it's excluded from the patch
mkdir -p "${TEST_DIR}/.jaiph"
printf 'runtime-state\n' > "${TEST_DIR}/.jaiph/some_state.txt"

# Create the workflow
e2e::file "artifacts_e2e.jh" <<'EOF'
import "jaiphlang/artifacts" as artifacts

workflow default() {
  const save_path = run artifacts.save("./build_output.txt", "saved-output.txt")
  log save_path
  const patch_path = run artifacts.save_patch("workspace.patch")
  log patch_path
}
EOF

# When
artifacts_out="$(e2e::run "artifacts_e2e.jh")"

# Then — CLI tree output
# assert_contains: log lines include absolute run-dir paths that vary per invocation;
# param values include file paths that vary per environment
e2e::assert_contains "${artifacts_out}" "workflow default" "output contains workflow default"
e2e::assert_contains "${artifacts_out}" "workflow save" "output contains workflow save"
e2e::assert_contains "${artifacts_out}" "workflow save_patch" "output contains workflow save_patch"
e2e::assert_contains "${artifacts_out}" "PASS" "output contains PASS"

# Then — artifacts exist on host
run_dir="$(e2e::run_dir "artifacts_e2e.jh")"
artifacts_dir="${run_dir}artifacts"

e2e::assert_file_exists "${artifacts_dir}/saved-output.txt" "saved artifact exists"
saved_content="$(<"${artifacts_dir}/saved-output.txt")"
e2e::assert_equals "${saved_content}" "build-output-content" "saved artifact content matches source"

e2e::assert_file_exists "${artifacts_dir}/workspace.patch" "patch artifact exists"
patch_content="$(<"${artifacts_dir}/workspace.patch")"
# assert_contains: patch content includes git diff headers with hashes that vary
e2e::assert_contains "${patch_content}" "modified-content" "patch contains workspace changes"

# Verify .jaiph/ is excluded from the patch
if [[ "${patch_content}" == *".jaiph/"* ]]; then
  e2e::fail "patch should exclude .jaiph/ paths"
fi
e2e::pass "patch excludes .jaiph/ paths"

# ---------------------------------------------------------------------------
e2e::section "artifacts lib: apply_patch"
# ---------------------------------------------------------------------------

# Reset the tracked file to original content
printf 'new-file-content\n' > "${TEST_DIR}/tracked.txt"

# Apply the previously saved patch
e2e::file "apply_patch_e2e.jh" <<EOF
import "jaiphlang/artifacts" as artifacts

workflow default() {
  run artifacts.apply_patch("${artifacts_dir}/workspace.patch")
}
EOF

apply_out="$(e2e::run "apply_patch_e2e.jh")"

# Then — the patch was applied
applied_content="$(<"${TEST_DIR}/tracked.txt")"
e2e::assert_equals "${applied_content}" "modified-content" "patch applied successfully"

# ---------------------------------------------------------------------------
e2e::section "artifacts lib: apply_patch fails on bad patch"
# ---------------------------------------------------------------------------

printf 'not-a-valid-patch\n' > "${TEST_DIR}/bad.patch"

e2e::file "bad_patch_e2e.jh" <<EOF
import "jaiphlang/artifacts" as artifacts

workflow default() {
  run artifacts.apply_patch("${TEST_DIR}/bad.patch")
}
EOF

if e2e::run "bad_patch_e2e.jh" >/dev/null 2>&1; then
  e2e::fail "apply_patch should fail on invalid patch"
fi
e2e::pass "apply_patch fails on invalid patch"

# ---------------------------------------------------------------------------
e2e::section "artifacts lib: save_patch on clean workspace"
# ---------------------------------------------------------------------------

cd "${TEST_DIR}"
git checkout -- tracked.txt 2>/dev/null || git restore tracked.txt 2>/dev/null || true
# Clean untracked files but preserve .jaiph/ (contains the lib we need)
git clean -fd --exclude=.jaiph 2>/dev/null || true

# Create the workflow file after clean, then commit so workspace is clean
e2e::file "clean_patch_e2e.jh" <<'EOF'
import "jaiphlang/artifacts" as artifacts

workflow default() {
  const patch_path = run artifacts.save_patch("clean.patch")
  log patch_path
}
EOF

git add clean_patch_e2e.jh
git commit -m "add clean test" --quiet

e2e::run "clean_patch_e2e.jh" >/dev/null

clean_run_dir="$(e2e::run_dir "clean_patch_e2e.jh")"
clean_patch="${clean_run_dir}artifacts/clean.patch"
e2e::assert_file_exists "${clean_patch}" "clean patch file exists"
clean_patch_content="$(<"${clean_patch}")"
e2e::assert_equals "${clean_patch_content}" "" "clean workspace produces empty patch"
