#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "install_command"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Bare repo + one commit with lib.jh (local git identity: CI/Docker often have no global user.*)
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
    git config user.email "e2e@jaiph.local"
    git config user.name "jaiph-e2e"
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
  echo "file://${repo_dir}"
}

repo_url="$(create_local_lib "mylib")"

# ── Project A: install, --force, restore from lockfile ───────────────────────

e2e::section "jaiph install (clone, lockfile, --force, restore)"

proj_a="${TEST_DIR}/a"
mkdir -p "${proj_a}"
(cd "${proj_a}" && e2e::git_init)

out="$(cd "${proj_a}" && jaiph install "${repo_url}" 2>&1)"
# assert_contains: success line includes ANSI color codes
e2e::assert_contains "${out}" "Installed mylib" "install reports success"
e2e::assert_file_exists "${proj_a}/.jaiph/libs/mylib/lib.jh" "cloned lib.jh at workspace root"
e2e::assert_file_exists "${proj_a}/.jaiph/libs.lock" "lockfile written"

lock="$(cat "${proj_a}/.jaiph/libs.lock")"
# assert_contains: JSON pretty-print whitespace may differ by platform
e2e::assert_contains "${lock}" '"mylib"' "lockfile names the lib"

force_out="$(cd "${proj_a}" && jaiph install --force "${repo_url}" 2>&1)"
# assert_contains: success line includes ANSI color codes
e2e::assert_contains "${force_out}" "Installed mylib" "--force re-clone reports success"

restore_out="$(cd "${proj_a}" && jaiph install 2>&1)"
# assert_contains: header plus ANSI; full transcript is environment-specific
e2e::assert_contains "${restore_out}" "Restoring" "no-args install uses lockfile"

e2e::pass "install workflow (clone, lockfile, --force, restore)"

# ── No lockfile / empty deps ─────────────────────────────────────────────────

e2e::section "jaiph install with no lockfile"

proj_b="${TEST_DIR}/b"
mkdir -p "${proj_b}"
(cd "${proj_b}" && e2e::git_init)

empty_out="$(cd "${proj_b}" && jaiph install 2>&1)"
# assert_contains: we only assert the user-visible diagnostic line
e2e::assert_contains "${empty_out}" "No libs in lockfile" "reports empty deps"
e2e::pass "no-args with missing lockfile"

# ── Invalid URL ────────────────────────────────────────────────────────────────

e2e::section "jaiph install rejects bad URL"

proj_c="${TEST_DIR}/c"
mkdir -p "${proj_c}"
(cd "${proj_c}" && e2e::git_init)

bad_exit=0
(cd "${proj_c}" && jaiph install "/nonexistent/path/to/repo.git" >/dev/null 2>&1) || bad_exit=$?
e2e::assert_equals "${bad_exit}" "1" "bad URL exits 1"
e2e::pass "invalid URL fails"
