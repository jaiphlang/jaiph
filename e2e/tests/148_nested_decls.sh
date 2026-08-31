#!/usr/bin/env bash

# Contract: nested (def-local) declarations — `script`, `def`, named `prompt`,
# and `const` inside a def body.
#  - a nested `def` is interpreted in-process and closes over the enclosing
#    def's params/consts (lexical scope);
#  - a nested `script foo` shadows a module-level `script foo` (the nested body
#    runs), and a nested script receives argv ($1) — it does not close over the
#    enclosing binding;
#  - a nested script's `use KEY` participates in the same `--env` pre-flight as
#    a module-level `use` (E_ENV_MISSING when ungranted);
#  - a name declared only inside one def is not reachable from another def
#    (E_VALIDATE);
#  - `export` on a nested declaration is E_PARSE.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "nested_decls"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

unset UE_TOKEN || true

e2e::section "nested def closes over the enclosing scope; nested script shadows + takes argv"

e2e::file "nd.jh" <<'EOF'
script greet = `printf MODULE`
export def main() {
  const who = "world"
  script greet = `printf "NESTED:$1"`
  def inner(name) {
    return "inner-sees-${who}-${name}"
  }
  const a = run inner("bob")
  const b = run greet(who)
  return "${a} ${b}"
}
EOF

nd_out="$(e2e::run "nd.jh")"
e2e::expect_stdout "${nd_out}" <<'EOF'

Jaiph: Running nd.jh

def main
  ▸ def inner (name="bob")
  ✓ def inner (<time>)
  ▸ script greet (1="world")
  ✓ script greet (<time>)

✓ PASS def main (<time>)

inner-sees-world-bob NESTED:world
EOF

e2e::section "a nested script use KEY without --env fails the same pre-flight as a module use"

e2e::file "nested_use.jh" <<'EOF'
export def main() {
  script show_impl use UE_TOKEN = `echo "UE_TOKEN=[${UE_TOKEN:-<unset>}]"`
  const t = run show_impl()
  return "${t}"
}
EOF

missing_out=""
if missing_out="$(UE_TOKEN=host-secret e2e::run "nested_use.jh" 2>&1)"; then
  e2e::fail "nested use: run should abort when a use key was not granted with --env"
fi
# assert_contains: the pre-flight error names the varying key + file path and the
# run never starts, so there is no banner/tree to compare in full.
e2e::assert_contains "${missing_out}" "E_ENV_MISSING" "nested use: ungranted key aborts pre-flight"
e2e::assert_contains "${missing_out}" "uses UE_TOKEN" "nested use: E_ENV_MISSING names the requested key"
e2e::assert_contains "${missing_out}" "--env UE_TOKEN" "nested use: E_ENV_MISSING names the missing grant"

granted_out="$(UE_TOKEN=host-secret e2e::run "nested_use.jh" --env UE_TOKEN)"
e2e::expect_stdout "${granted_out}" <<'EOF'

Jaiph: Running nested_use.jh

def main
  ▸ script show_impl
  ✓ script show_impl (<time>)
✓ PASS def main (<time>)

UE_TOKEN=[host-secret]
EOF

e2e::section "a nested name is not reachable from another def (E_VALIDATE)"

e2e::file "cross_def.jh" <<'EOF'
export def main() {
  script nested_helper = `echo hi`
  run other()
}
def other() {
  run nested_helper()
}
EOF

cross_out=""
if cross_out="$(e2e::run "cross_def.jh" 2>&1)"; then
  e2e::fail "cross-def: another def must not reach a sibling def's nested name"
fi
e2e::assert_contains "${cross_out}" "E_VALIDATE" "cross-def: rejected with E_VALIDATE"
e2e::assert_contains "${cross_out}" 'unknown local def or script reference "nested_helper"' \
  "cross-def: message names the unreachable nested target"

e2e::section "export on a nested declaration is E_PARSE"

e2e::file "nested_export.jh" <<'EOF'
export def main() {
  export script foo = `echo hi`
  run foo()
}
EOF

export_out=""
if export_out="$(e2e::run "nested_export.jh" 2>&1)"; then
  e2e::fail "nested export: export on a nested declaration should be rejected"
fi
e2e::assert_contains "${export_out}" "E_PARSE" "nested export: rejected with E_PARSE"
e2e::assert_contains "${export_out}" "nested script declarations cannot be exported" \
  "nested export: message steers to dropping export"

e2e::pass "nested declaration closure, shadowing, argv, use pre-flight, isolation, and export rules hold"
