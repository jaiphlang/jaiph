#!/usr/bin/env bash

# Contract: a string literal means the same text in every context. The value
#   q "x" \d
# is written once as a single-line string ("q \"x\" \d": `\"` is the only
# escape, the backslash in `\d` stays) and once as a `"""` block (written as
# is), then passed through every place a string can go: local and top-level
# const, return, match arm, call argument, send, and stdin. A script appends
# exactly the bytes it receives to out.txt, and the file must match byte for
# byte. Before the string-model fix, `"""` values leaked their internal
# escaping (`q \"x\" \\d`) and `\"` in a call argument lost its quotes.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::section "string values are identical in every context"
e2e::prepare_test_env "string_values"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::file "values.jh" <<'EOF'
const top1 = "q \"x\" \d"
const top3 = """
q "x" \d
"""

channel box -> receive

script put = '''
  printf '%s=[%s]\n' "$1" "$2" >> "$JAIPH_WORKSPACE/out.txt"
'''

script put_stdin = '''
  printf '%s=[%s]\n' "$1" "$(cat)" >> "$JAIPH_WORKSPACE/out.txt"
'''

def ret1() {
  return "q \"x\" \d"
}

def ret3() {
  return """
    q "x" \d
  """
}

def receive(message) {
  put("send", message)
}

export def main() {
  const c1 = "q \"x\" \d"
  put("const1", c1)
  const c3 = """
    q "x" \d
  """
  put("const3", c3)
  put("top1", top1)
  put("top3", top3)
  const r1 = ret1()
  put("return1", r1)
  const r3 = ret3()
  put("return3", r3)
  const k = "go"
  const m1 = match k {
    "go" => "q \"x\" \d"
    _ => "no"
  }
  put("match1", m1)
  const m3 = match k {
    "go" => """
      q "x" \d
    """
    _ => "no"
  }
  put("match3", m3)
  put("arg1", "q \"x\" \d")
  put("arg3", """
    q "x" \d
  """)
  stdin "q \"x\" \d" -> put_stdin("stdin1")
  send "q \"x\" \d" -> box
}
EOF

e2e::run "values.jh" >/dev/null
expected='const1=[q "x" \d]
const3=[q "x" \d]
top1=[q "x" \d]
top3=[q "x" \d]
return1=[q "x" \d]
return3=[q "x" \d]
match1=[q "x" \d]
match3=[q "x" \d]
arg1=[q "x" \d]
arg3=[q "x" \d]
stdin1=[q "x" \d]
send=[q "x" \d]'
e2e::assert_equals "$(<"${TEST_DIR}/out.txt")" "${expected}" "every context receives exactly: q \"x\" \\d"
e2e::pass "string values are identical in every context"
