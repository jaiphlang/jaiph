#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "install_command"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── Helper: create a local bare git repo with a .jh file ──────────────────────

create_local_lib() {
  local name="$1"
  local repo_dir="${TEST_DIR}/repos/${name}.git"
  local work_dir="${TEST_DIR}/repos/${name}_work"

  mkdir -p "${repo_dir}" "${work_dir}"
  git init --bare "${repo_dir}" >/dev/null 2>&1
  git -C "${repo_dir}" symbolic-ref HEAD refs/heads/main
  git init "${work_dir}" >/dev/null 2>&1
  (
    cd "${work_dir}"
    git checkout -b main >/dev/null 2>&1 || true
    git remote add origin "${repo_dir}"
    cat > lib.jh <<'JHEOF'
export workflow greet() {
  log "hello from lib"
}
JHEOF
    git add lib.jh
    git commit -m "initial" >/dev/null 2>&1
    git push origin main >/dev/null 2>&1
  )
  # file:// protocol ensures --depth 1 works via smart transport on all platforms
  echo "file://${repo_dir}"
}

# ── 1. Install a local library ────────────────────────────────────────────────

e2e::section "jaiph install with local repo"

repo_path="$(create_local_lib "mylib")"

# Run install from a project directory
project_dir="${TEST_DIR}/project1"
mkdir -p "${project_dir}"
(cd "${project_dir}" && e2e::git_init)

install_out="$(cd "${project_dir}" && jaiph install "${repo_path}" 2>&1)"

# assert_contains: output includes ANSI codes and path which varies per machine
e2e::assert_contains "${install_out}" "Installed mylib" "install reports success"

# Verify the library was cloned (deriveLibName strips .git suffix)
e2e::assert_file_exists "${project_dir}/.jaiph/libs/mylib/lib.jh" "library file exists"

# Verify lockfile was created
e2e::assert_file_exists "${project_dir}/.jaiph/libs.lock" "lockfile exists"

lock_content="$(cat "${project_dir}/.jaiph/libs.lock")"
# assert_contains: lockfile JSON structure varies by platform whitespace
e2e::assert_contains "${lock_content}" '"mylib"' "lockfile contains lib name"

e2e::pass "install creates library and lockfile"

# ── 2. Install with --force re-clones ────────────────────────────────────────

e2e::section "jaiph install --force re-clones"

force_out="$(cd "${project_dir}" && jaiph install --force "${repo_path}" 2>&1)"
# assert_contains: output includes ANSI codes
e2e::assert_contains "${force_out}" "Installed mylib" "force install reports success"
e2e::pass "install --force re-clones existing library"

# ── 3. Install without args skips already installed ───────────────────────────

e2e::section "jaiph install (no args) restores from lockfile"

# The library already exists from step 1, so restore should skip it
restore_out="$(cd "${project_dir}" && jaiph install 2>&1)"
# assert_contains: output includes ANSI codes and "already exists" or "Restoring"
e2e::assert_contains "${restore_out}" "Restoring" "restore from lockfile shows header"
e2e::pass "install with no args restores from lockfile"

# ── 4. Install without args on empty lockfile ────────────────────────────────

e2e::section "jaiph install (no args) with empty lockfile"

project_dir2="${TEST_DIR}/project2"
mkdir -p "${project_dir2}"
(cd "${project_dir2}" && e2e::git_init)

empty_out="$(cd "${project_dir2}" && jaiph install 2>&1)"
e2e::assert_contains "${empty_out}" "No libs in lockfile" "empty lockfile reports no libs"
e2e::pass "install with no args and no lockfile shows message"

# ── 5. Install with invalid URL fails ────────────────────────────────────────

e2e::section "jaiph install with invalid URL fails"

project_dir3="${TEST_DIR}/project3"
mkdir -p "${project_dir3}"
(cd "${project_dir3}" && e2e::git_init)

bad_exit=0
cd "${project_dir3}" && jaiph install "/nonexistent/path/to/repo.git" >/dev/null 2>&1 || bad_exit=$?
e2e::assert_equals "${bad_exit}" "1" "install with bad URL exits 1"
e2e::pass "install with invalid URL exits with error"
