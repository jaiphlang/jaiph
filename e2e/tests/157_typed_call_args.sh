#!/usr/bin/env bash

# Call arguments reach the runtime as typed values: one argv element per Arg,
# so an empty-string literal is its own argument and a literal's bytes (spaces,
# quotes, commas, ')', '${…}') are not re-tokenised. Regression for the
# argsToRuntimeString round-trip that dropped `show("", "b")`'s empty first arg.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "typed_call_args"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Each argument is printed on its own line wrapped in brackets, so argument
# count and byte content are both visible in the step's .out artifact.
SHOW_SCRIPT='script show = '\''printf "[%s]\n" "$@"'\'''

# Read the single `show` script step's aggregated stdout for a run.
show_out() {
  local file="$1"
  local run_dir
  run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_args" "${file}")"
  shopt -s nullglob
  local outs=( "${run_dir}"*script__show.out )
  shopt -u nullglob
  [[ ${#outs[@]} -eq 1 ]] || e2e::fail "expected one show .out for ${file}, got ${#outs[@]}"
  cat "${outs[0]}"
}

rm -rf "${TEST_DIR}/runs_args"

e2e::section "empty-string literal is delivered as its own argument"

e2e::file "empty_literal.jh" <<EOF
${SHOW_SCRIPT}

export def main() {
  show("", "b")
}
EOF
JAIPH_RUNS_DIR="runs_args" e2e::run "empty_literal.jh" >/dev/null
e2e::expect_stdout "$(show_out empty_literal.jh)" <<'EOF'
[]
[b]
EOF
e2e::pass 'show("", "b") delivers two arguments, the first empty'

e2e::section "empty const arg behaves identically to empty literal"

e2e::file "empty_const.jh" <<EOF
${SHOW_SCRIPT}

export def main() {
  const e = ""
  show(e, "b")
}
EOF
JAIPH_RUNS_DIR="runs_args" e2e::run "empty_const.jh" >/dev/null
e2e::expect_stdout "$(show_out empty_const.jh)" <<'EOF'
[]
[b]
EOF
e2e::pass 'show(e, "b") with empty const also delivers two arguments'

e2e::section "literal bytes arrive byte-exact (spaces, quotes, commas, ')', \${…})"

e2e::file "byte_exact.jh" <<EOF
${SHOW_SCRIPT}

export def main() {
  const w = "world"
  show("a b", "c,d", "e)f", "q\\"r", "hi \${w}")
}
EOF
JAIPH_RUNS_DIR="runs_args" e2e::run "byte_exact.jh" >/dev/null
e2e::expect_stdout "$(show_out byte_exact.jh)" <<'EOF'
[a b]
[c,d]
[e)f]
[q"r]
[hi world]
EOF
e2e::pass "each literal arrives as one byte-exact argument"

e2e::section "nested call argument still resolves to one argument"

e2e::file "nested_call.jh" <<EOF
${SHOW_SCRIPT}
script up = 'printf "%s" "\$1" | tr a-z A-Z'

export def main() {
  show(up("hi"), "z")
}
EOF
JAIPH_RUNS_DIR="runs_args" e2e::run "nested_call.jh" >/dev/null
e2e::expect_stdout "$(show_out nested_call.jh)" <<'EOF'
[HI]
[z]
EOF
e2e::pass "nested call argument delivers its captured output as one argument"
