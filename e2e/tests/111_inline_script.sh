#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "inline_script"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "basic inline script execution"
# ---------------------------------------------------------------------------

e2e::file "inline_basic.jh" <<'EOF'
workflow default() {
  run `echo inline-ok`()
}
EOF

basic_out="$(e2e::run "inline_basic.jh")"

# hash-based name is deterministic but hard to predict in heredoc; check structure
# nondeterministic: inline script name contains content hash
e2e::assert_contains "${basic_out}" "script __inline_" "tree shows inline script step"
# assert_contains: output includes dynamic timing and inline script hash name
e2e::assert_contains "${basic_out}" "PASS workflow default" "workflow passes"

# Verify artifact content
rm -rf "${TEST_DIR}/runs_basic"
JAIPH_RUNS_DIR="runs_basic" e2e::run "inline_basic.jh" >/dev/null

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_basic" "inline_basic.jh")"
shopt -s nullglob
out_files=( "${run_dir}"*__inline_*.out )
shopt -u nullglob
[[ ${#out_files[@]} -ge 1 ]] || e2e::fail "expected inline script .out artifact"
inline_out="$(<"${out_files[0]}")"
e2e::assert_equals "${inline_out}" "inline-ok" "inline script produces correct output"

e2e::pass "basic inline script execution"

# ---------------------------------------------------------------------------
e2e::section "inline script with arguments"
# ---------------------------------------------------------------------------

e2e::file "inline_args.jh" <<'EOF'
workflow default() {
  run `echo $1-$2`("hello", "world")
}
EOF

rm -rf "${TEST_DIR}/runs_args"
JAIPH_RUNS_DIR="runs_args" e2e::run "inline_args.jh" >/dev/null

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_args" "inline_args.jh")"
shopt -s nullglob
args_files=( "${run_dir}"*__inline_*.out )
shopt -u nullglob
[[ ${#args_files[@]} -ge 1 ]] || e2e::fail "expected inline script .out artifact"
args_out="$(<"${args_files[0]}")"
e2e::assert_equals "${args_out}" "hello-world" "inline script receives arguments"

e2e::pass "inline script with arguments"

# ---------------------------------------------------------------------------
e2e::section "inline script capture form"
# ---------------------------------------------------------------------------

e2e::file "inline_capture.jh" <<'EOF'
script show = ```
echo "got: $1"
```

workflow default() {
  const x = run `echo captured-value`()
  run show(x)
}
EOF

rm -rf "${TEST_DIR}/runs_capture"
JAIPH_RUNS_DIR="runs_capture" e2e::run "inline_capture.jh" >/dev/null

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_capture" "inline_capture.jh")"
shopt -s nullglob
show_files=( "${run_dir}"*script__show.out )
shopt -u nullglob
[[ ${#show_files[@]} -ge 1 ]] || e2e::fail "expected show .out artifact"
show_out="$(<"${show_files[0]}")"
e2e::assert_equals "${show_out}" "got: captured-value" "inline script capture available in subsequent step"

e2e::pass "inline script capture form"

# ---------------------------------------------------------------------------
e2e::section "const capture form"
# ---------------------------------------------------------------------------

e2e::file "inline_const.jh" <<'EOF'
script show_const = ```
echo "const: $1"
```

workflow default() {
  const val = run `echo const-value`()
  run show_const(val)
}
EOF

rm -rf "${TEST_DIR}/runs_const"
JAIPH_RUNS_DIR="runs_const" e2e::run "inline_const.jh" >/dev/null

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_const" "inline_const.jh")"
shopt -s nullglob
const_files=( "${run_dir}"*script__show_const.out )
shopt -u nullglob
[[ ${#const_files[@]} -ge 1 ]] || e2e::fail "expected show .out artifact"
const_out="$(<"${const_files[0]}")"
e2e::assert_equals "${const_out}" "const: const-value" "const capture with inline script"

e2e::pass "const capture form"

# ---------------------------------------------------------------------------
e2e::section "deterministic script artifacts"
# ---------------------------------------------------------------------------

# Run the same inline script twice — should produce same script file name
rm -rf "${TEST_DIR}/runs_determ1" "${TEST_DIR}/runs_determ2"
JAIPH_RUNS_DIR="runs_determ1" e2e::run "inline_basic.jh" >/dev/null
JAIPH_RUNS_DIR="runs_determ2" e2e::run "inline_basic.jh" >/dev/null

run_dir1="$(e2e::run_dir_at "${TEST_DIR}/runs_determ1" "inline_basic.jh")"
run_dir2="$(e2e::run_dir_at "${TEST_DIR}/runs_determ2" "inline_basic.jh")"
shopt -s nullglob
files1=( "${run_dir1}"*__inline_*.out )
files2=( "${run_dir2}"*__inline_*.out )
shopt -u nullglob
name1="$(basename "${files1[0]}")"
name2="$(basename "${files2[0]}")"
e2e::assert_equals "${name1}" "${name2}" "inline script artifact names are deterministic across runs"

e2e::pass "deterministic script artifacts"

# ---------------------------------------------------------------------------
e2e::section "inline script isolation (no parent scope)"
# ---------------------------------------------------------------------------

e2e::file "inline_iso.jh" <<'EOF'
const secret = "parent-secret"

workflow default() {
  run `echo "secret=${secret:-}"`()
}
EOF

rm -rf "${TEST_DIR}/runs_iso"
JAIPH_RUNS_DIR="runs_iso" e2e::run "inline_iso.jh" >/dev/null

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_iso" "inline_iso.jh")"
shopt -s nullglob
iso_files=( "${run_dir}"*__inline_*.out )
shopt -u nullglob
[[ ${#iso_files[@]} -ge 1 ]] || e2e::fail "expected inline script .out artifact"
iso_out="$(<"${iso_files[0]}")"
e2e::assert_equals "${iso_out}" "secret=" "inline script cannot access parent scope"

e2e::pass "inline script isolation"
