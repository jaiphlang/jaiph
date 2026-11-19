#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "match_arm_execution"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. match arm with fail aborts the workflow ─────────────────────────────

e2e::section "match arm fail aborts workflow"

e2e::file "match_fail.jh" <<'EOF'
script safe_name = '''
printf '%s\n' "$1" | tr '/:' '--'
'''

export def main(name_param) {
  const name = match name_param {
    "" => fail "usage: provide a name"
    _ => safe_name(name_param)
  }
  log name
}
EOF

e2e::expect_fail "match_fail.jh"
e2e::pass "match arm fail exits non-zero"

# Capture output to verify no fake log line
fail_out="$(e2e::run "match_fail.jh" 2>&1 || true)"
# nondeterministic: run dir path contains timestamp
e2e::assert_contains "${fail_out}" "FAIL def main" "fail output shows FAIL"

# The output must NOT contain a log line masquerading as the fail message
if echo "${fail_out}" | grep -q 'ℹ fail'; then
  e2e::fail "output should not contain fake log of fail body"
fi
e2e::pass "no fake log line for fail arm"

# ── 2. match arm with run executes the script ──────────────────────────────

e2e::section "match arm run executes script"

e2e::file "match_run.jh" <<'EOF'
script safe_name = '''
printf '%s\n' "$1" | tr '/:' '--'
'''

export def main(name_param) {
  const name = match name_param {
    "" => fail "usage: provide a name"
    _ => safe_name(name_param)
  }
  log name
}
EOF

run_out="$(e2e::run "match_run.jh" "some/name")"

e2e::expect_stdout "${run_out}" <<'EOF'

Jaiph: Running match_run.jh

def main (name_param="some/name")
  ▸ script safe_name (1="some/name")
  ✓ script safe_name (<time>)
  ℹ some-name

✓ PASS def main (<time>)
EOF

e2e::expect_out "match_run.jh" "safe_name" "some-name"
e2e::pass "match arm run executes script and captures value"

# ── 3. call arm argument with a literal ")" runs the script (not the regex) ──
# Regression: a prior runtime regex `[^)]*` cut the argument at the first ")",
# so the script never ran. The tokenizer-based arg parser keeps `p)q` whole.

e2e::section "match arm call keeps a literal ) inside a string argument"

e2e::file "match_paren.jh" <<'EOF'
script echoit = 'printf "%s" "$1"'

export def main() {
  const x = "a"
  const r = match x {
    "a" => echoit("p)q")
    _ => "d"
  }
  log r
}
EOF

e2e::run "match_paren.jh" >/dev/null
e2e::expect_out "match_paren.jh" "echoit" "p)q"
e2e::pass "call arm passes p)q verbatim and runs the script"

# ── 4. call arm preserves a comma inside a quoted argument ───────────────────
# Regression: a space-joined arg round trip dropped the comma, so the first
# argument arrived as `x y` instead of `x, y`.

e2e::section "match arm call keeps a comma inside a quoted argument"

e2e::file "match_comma.jh" <<'EOF'
script first_arg = 'printf "%s" "$1"'

export def main() {
  const x = "a"
  const r = match x {
    "a" => first_arg("x, y", "z")
    _ => "d"
  }
  log r
}
EOF

e2e::run "match_comma.jh" >/dev/null
e2e::expect_out "match_comma.jh" "first_arg" "x, y"
e2e::pass "call arm passes x, y as a single argument"
