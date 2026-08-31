#!/usr/bin/env bash

# Contract: script env is sterile. A script sees only process basics and the
# JAIPH_* script contract keys; a host key crosses only when the script's
# declaration requests it with `use` AND the operator grants it with --env.
# `jaiph run` pre-flights every `use` key in the import graph (E_ENV_MISSING
# when ungranted, even if the host has the value); `jaiph test` does not
# pre-flight — an ungranted key is simply absent in the spawn. `trusted_envs`
# is gone: it is the unknown-config-key parse error.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "script_use_env"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Never inherit a real UE_TOKEN from the invoking shell.
unset UE_TOKEN || true

e2e::section "sterile — a script with no use never sees a host key"

e2e::file "sterile_show.jh" <<'EOF'
script show_impl = `echo "UE_TOKEN=[${UE_TOKEN:-<unset>}]"`
export def main() {
  const t = run show_impl()
  return "${t}"
}
EOF

sterile_out="$(UE_TOKEN=host-secret e2e::run "sterile_show.jh")"
e2e::expect_stdout "${sterile_out}" <<'EOF'

Jaiph: Running sterile_show.jh

def main
  ▸ script show_impl
  ✓ script show_impl (<time>)
✓ PASS def main (<time>)

UE_TOKEN=[<unset>]
EOF

e2e::section "use + --env KEY — the granted host value reaches the script"

e2e::file "use_show.jh" <<'EOF'
script show_impl use UE_TOKEN = `echo "UE_TOKEN=[${UE_TOKEN:-<unset>}]"`
export def main() {
  const t = run show_impl()
  return "${t}"
}
EOF

granted_out="$(UE_TOKEN=host-secret e2e::run "use_show.jh" --env UE_TOKEN)"
e2e::expect_stdout "${granted_out}" <<'EOF'

Jaiph: Running use_show.jh

def main
  ▸ script show_impl
  ✓ script show_impl (<time>)
✓ PASS def main (<time>)

UE_TOKEN=[host-secret]
EOF

e2e::section "use + --env KEY=VALUE — the explicit value overrides the host value"

override_out="$(UE_TOKEN=host-secret e2e::run "use_show.jh" --env UE_TOKEN=cli-wins)"
e2e::expect_stdout "${override_out}" <<'EOF'

Jaiph: Running use_show.jh

def main
  ▸ script show_impl
  ✓ script show_impl (<time>)
✓ PASS def main (<time>)

UE_TOKEN=[cli-wins]
EOF

e2e::section "use without --env fails pre-flight even when the host has the value"

missing_out=""
if missing_out="$(UE_TOKEN=host-secret e2e::run "use_show.jh" 2>&1)"; then
  e2e::fail "use: run should abort when a use key was not granted with --env"
fi
# assert_contains: the error names the varying key and file path; the run
# never starts, so there is no banner/tree to compare in full.
e2e::assert_contains "${missing_out}" "E_ENV_MISSING" "use: ungranted use key aborts with E_ENV_MISSING"
e2e::assert_contains "${missing_out}" "uses UE_TOKEN" "use: E_ENV_MISSING names the requested key"
e2e::assert_contains "${missing_out}" "--env UE_TOKEN" "use: E_ENV_MISSING names the missing grant"

e2e::section "no def-level leak — a callee's script without use stays sterile despite the grant"

e2e::file "use_sub.jh" <<'EOF'
script main_show use UE_TOKEN = `echo "MAIN=[${UE_TOKEN:-<unset>}]"`
script sub_show = `echo "SUB=[${UE_TOKEN:-<unset>}]"`
def sub() {
  const s = run sub_show()
  return "${s}"
}
export def main() {
  const m = run main_show()
  const s = run sub()
  return "${m} ${s}"
}
EOF

sub_out="$(UE_TOKEN=host-secret e2e::run "use_sub.jh" --env UE_TOKEN)"
e2e::expect_stdout "${sub_out}" <<'EOF'

Jaiph: Running use_sub.jh

def main
  ▸ script main_show
  ✓ script main_show (<time>)
  ▸ def sub
  ·   ▸ script sub_show
  ·   ✓ script sub_show (<time>)
  ✓ def sub (<time>)
✓ PASS def main (<time>)

MAIN=[host-secret] SUB=[<unset>]
EOF

e2e::section "jaiph test does not pre-flight use keys (exit 0 without --env)"

e2e::file "use_lane.test.jh" <<'EOF'
script show_impl use UE_TOKEN = `echo "UE_TOKEN=[${UE_TOKEN:-<unset>}]"`
export def main() {
  const t = run show_impl()
  return "${t}"
}
test "use key absent without --env grant" {
  const r = run main()
  expect_contain r "UE_TOKEN=[<unset>]"
}
EOF

UE_TOKEN=host-secret jaiph test "${TEST_DIR}/use_lane.test.jh" \
  || e2e::fail "jaiph test must not hard-fail pre-flight for an ungranted use key"

e2e::section "reserved keys in use are rejected at parse time"

e2e::file "use_reserved.jh" <<'EOF'
script bad use JAIPH_WORKSPACE = `echo never`
export def main() {
  run bad()
}
EOF

reserved_out=""
if reserved_out="$(e2e::run "use_reserved.jh" 2>&1)"; then
  e2e::fail "use: reserved key should be rejected"
fi
# assert_contains: only the reserved-key rejection is contract; the parse-error
# prefix carries a varying absolute path.
e2e::assert_contains "${reserved_out}" 'E_ENV_RESERVED use cannot request reserved key "JAIPH_WORKSPACE"' \
  "use: reserved key rejected"

e2e::section "trusted_envs is removed — unknown config key"

e2e::file "trusted_removed.jh" <<'EOF'
config {
  trusted_envs = "UE_TOKEN"
}
export def main() {
  log "never runs"
}
EOF

removed_out=""
if removed_out="$(e2e::run "trusted_removed.jh" 2>&1)"; then
  e2e::fail "trusted_envs: removed config key should be rejected"
fi
# assert_contains: the parse-error prefix carries a varying absolute path.
e2e::assert_contains "${removed_out}" "unknown config key: trusted_envs" \
  "trusted_envs: removed key is the unknown-config-key error"
