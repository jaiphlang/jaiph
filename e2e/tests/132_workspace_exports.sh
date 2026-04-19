#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "workspace_exports"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Install workspace stdlib into the test workspace's .jaiph/libs/
mkdir -p "${TEST_DIR}/.jaiph/libs/jaiphlang"
cp "${ROOT_DIR}/.jaiph/libs/jaiphlang/workspace.jh" "${TEST_DIR}/.jaiph/libs/jaiphlang/workspace.jh"
cp "${ROOT_DIR}/.jaiph/libs/jaiphlang/workspace.sh" "${TEST_DIR}/.jaiph/libs/jaiphlang/workspace.sh"

# ---------------------------------------------------------------------------
# workspace.export_patch: creates patch and returns path
# ---------------------------------------------------------------------------

e2e::section "workspace.export_patch creates patch at run dir"

(
  cd "${TEST_DIR}"
  e2e::git_init

  e2e::file "patch_basic.jh" <<'EOF'
import "jaiphlang/workspace" as workspace

script make_change = `echo "new-content" > patched_file.txt`

workflow default() {
  run make_change()
  const path = run workspace.export_patch("candidate.patch")
  log "${path}"
}
EOF

  out="$(e2e::run "patch_basic.jh" 2>&1)"

  # The log output should contain the absolute patch path
  # nondeterministic path — check key elements
  e2e::assert_contains "$out" "candidate.patch" "log shows patch filename"
  e2e::pass "workspace.export_patch creates patch and returns path"

  # Verify the patch file exists in the run dir
  dir="$(e2e::run_dir "patch_basic.jh")"
  [[ -f "${dir}candidate.patch" ]] || e2e::fail "candidate.patch should exist in run dir"
  e2e::pass "candidate.patch exists in run dir"

  # Verify patch content references the changed file
  patch_content="$(<"${dir}candidate.patch")"
  e2e::assert_contains "$patch_content" "patched_file.txt" "patch references changed file"
)

# ---------------------------------------------------------------------------
# workspace.export_patch: excludes .jaiph/ from the patch
# ---------------------------------------------------------------------------

e2e::section "workspace.export_patch excludes .jaiph/ from diff"

(
  cd "${TEST_DIR}"
  e2e::git_init

  e2e::file "patch_exclude.jh" <<'EOF'
import "jaiphlang/workspace" as workspace

script make_changes = ```
echo "code change" > real_code.txt
mkdir -p .jaiph
echo "run artifact" > .jaiph/should_not_appear.txt
```

workflow default() {
  run make_changes()
  const path = run workspace.export_patch("exclusion_test.patch")
  log "${path}"
}
EOF

  e2e::run "patch_exclude.jh" >/dev/null 2>&1

  dir="$(e2e::run_dir "patch_exclude.jh")"
  [[ -f "${dir}exclusion_test.patch" ]] || e2e::fail "exclusion_test.patch should exist"

  patch_content="$(<"${dir}exclusion_test.patch")"

  e2e::assert_contains "$patch_content" "real_code.txt" "patch includes non-.jaiph changes"

  # The patch should not contain a diff hunk for .jaiph/should_not_appear.txt.
  # The string may appear inside the jh file's script body — that's fine;
  # we check for the git diff path header which would start with "diff --git a/.jaiph/".
  if echo "$patch_content" | grep -q '^diff --git a/\.jaiph/'; then
    e2e::fail ".jaiph/ diff hunks must not appear in the exported patch"
  fi
  e2e::pass ".jaiph/ excluded from export_patch"
)

# ---------------------------------------------------------------------------
# workspace.export: copies a file and returns path
# ---------------------------------------------------------------------------

e2e::section "workspace.export copies file to run dir"

(
  cd "${TEST_DIR}"

  e2e::file "export_file.jh" <<'EOF'
import "jaiphlang/workspace" as workspace

script create_report = `echo '{"result":"ok"}' > report.json`

workflow default() {
  run create_report()
  const path = run workspace.export("report.json", "exported_report.json")
  log "${path}"
}
EOF

  out="$(e2e::run "export_file.jh" 2>&1)"

  # nondeterministic path — check key elements
  e2e::assert_contains "$out" "exported_report.json" "log shows exported filename"
  e2e::pass "workspace.export returns path"

  dir="$(e2e::run_dir "export_file.jh")"
  [[ -f "${dir}exported_report.json" ]] || e2e::fail "exported file should exist in run dir"

  content="$(<"${dir}exported_report.json")"
  e2e::assert_contains "$content" '"result":"ok"' "exported file has correct content"
)

# ---------------------------------------------------------------------------
# workspace.apply_patch: applies a patch to the workspace
# ---------------------------------------------------------------------------

e2e::section "workspace.apply_patch applies patch to workspace"

(
  cd "${TEST_DIR}"
  e2e::git_init

  # Create a tracked file, commit the jh file too, then modify and export a patch.
  # Without isolation, we revert between export and apply.
  echo "original-content" > tracked_apply.txt

  e2e::file "apply_basic.jh" <<'EOF'
import "jaiphlang/workspace" as workspace

script modify_file = `echo "branch-content" > tracked_apply.txt`
script revert_file = `git checkout -- tracked_apply.txt`
script read_file = `cat tracked_apply.txt`

workflow default() {
  run modify_file()
  const patch_path = run workspace.export_patch("to_apply.patch")
  run revert_file()
  run workspace.apply_patch("${patch_path}")
  const content = run read_file()
  log "${content}"
}
EOF

  # Commit all files so export_patch only captures tracked changes
  git add -A && git commit -m "setup" >/dev/null 2>&1

  out="$(e2e::run "apply_basic.jh" 2>&1)"

  e2e::assert_contains "$out" "branch-content" "applied file content visible after apply"
  e2e::pass "workspace.apply_patch applies successfully"
)

# ---------------------------------------------------------------------------
# workspace.apply_patch: failure path — conflicting patch
# ---------------------------------------------------------------------------

e2e::section "workspace.apply_patch fails on conflicting patch"

(
  cd "${TEST_DIR}"
  e2e::git_init

  # Create a tracked file, commit, modify + export, then create conflicting commit
  echo "base" > conflict.txt
  git add conflict.txt && git commit -m "base" >/dev/null 2>&1

  e2e::file "apply_fail.jh" <<'EOF'
import "jaiphlang/workspace" as workspace

script make_change = `echo "branch-A" > conflict.txt`
script revert_and_conflict = `git checkout -- conflict.txt && echo "branch-B" > conflict.txt && git add conflict.txt && git commit -m "conflicting"`

workflow default() {
  run make_change()
  const patch_path = run workspace.export_patch("conflict.patch")
  run revert_and_conflict()
  run workspace.apply_patch("${patch_path}")
}
EOF

  # Commit all files so export_patch only captures tracked changes
  git add -A && git commit -m "setup" >/dev/null 2>&1

  set +e
  out="$(e2e::run "apply_fail.jh" 2>&1)"
  exit_code=$?
  set -e

  e2e::assert_equals "$exit_code" "1" "apply_patch exits 1 on conflict"
  e2e::pass "workspace.apply_patch fails on conflicting patch"
)

# ---------------------------------------------------------------------------
# Candidate / join / apply shape: sequential candidates with export/join/apply
# (Without Docker isolation, branches share the workspace. This test uses
# sequential candidates that each produce a patch, then joins and applies.)
# ---------------------------------------------------------------------------

e2e::section "candidate join apply pattern"

(
  cd "${TEST_DIR}"
  e2e::git_init

  # Create a tracked file so changes produce a clean diff
  echo "original" > target.txt
  git add target.txt && git commit -m "base" >/dev/null 2>&1

  e2e::file "candidate_pattern.jh" <<'EOF'
import "jaiphlang/workspace" as workspace

script implement_surgical = `echo "surgical-fix" > target.txt`
script revert_target = `git checkout -- target.txt`

workflow implement_candidate(patch_name) {
  run implement_surgical()
  const path = run workspace.export_patch(patch_name)
  run revert_target()
  return "${path}"
}

# Simple join: pick the first candidate
workflow join_pick(p1) {
  return "${p1}"
}

workflow default() {
  const b1 = run implement_candidate("candidate_surgical.patch")
  const final = run join_pick("${b1}")
  run workspace.apply_patch("${final}")
}
EOF

  # Commit all files so export_patch only captures tracked changes
  git add -A && git commit -m "setup" >/dev/null 2>&1

  out="$(e2e::run "candidate_pattern.jh" 2>&1)"

  # nondeterministic progress output — check key phrases
  e2e::assert_contains "$out" "PASS" "candidate pattern completes successfully"

  # The surgical candidate was selected and applied
  if [[ -f "${TEST_DIR}/target.txt" ]]; then
    content="$(<"${TEST_DIR}/target.txt")"
    e2e::assert_equals "$content" "surgical-fix" "surgical candidate was applied"
  else
    e2e::fail "target.txt should exist after apply"
  fi
  e2e::pass "candidate join apply pattern works"
)
