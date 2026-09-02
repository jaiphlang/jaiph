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
#  - `export` on a nested declaration is E_PARSE;
#  - nested `const` / named `prompt` string templates interpolate enclosing
#    params and consts (`${…}`), including triple-quoted bodies;
#  - a `const` is sequential (not hoisted): using its name before its
#    declaration — in `${…}` interpolation, a bare call argument, or from a
#    nested def body that closes over a later `const` — is E_VALIDATE, while a
#    `const` used after its declaration interpolates at runtime;
#  - a nested decl inside an `if` / `else` / `for` / `catch` / `recover` body is
#    block-scoped to that body: the taken branch runs it, but naming it after the
#    branch is E_VALIDATE, and a shadow inside a branch does not leak past it.

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

e2e::section "nested const templates interpolate enclosing params/consts (quoted and triple-quoted)"

e2e::file "nested_const_tpl.jh" <<'EOF'
export def main() {
  const who = "world"
  const greeting = "hello ${who}"
  const note = """
    note for ${who}
  """
  def inner(name) {
    const msg = "${greeting}-${name}"
    return msg
  }
  const h = run inner("bob")
  return "${h}|${note}"
}
EOF

tpl_out="$(e2e::run "nested_const_tpl.jh")"
e2e::expect_stdout "${tpl_out}" <<'EOF'

Jaiph: Running nested_const_tpl.jh

def main
  ▸ def inner (name="bob")
  ✓ def inner (<time>)

✓ PASS def main (<time>)

hello world-bob|note for world
EOF

e2e::section "nested named prompt interpolates enclosing const + own param (quoted and triple-quoted)"

AGENT="${TEST_DIR}/echo-agent.sh"
cat > "${AGENT}" <<'AGENT_EOF'
#!/usr/bin/env bash
cat
AGENT_EOF
chmod 755 "${AGENT}"

e2e::file "nested_prompt_tpl.jh" <<'EOF'
export def main() {
  const who = "Ada"
  prompt describe(x) = "Tell ${who} about ${x}"
  prompt describe_block(x) = """
    Block ${who} ${x}
  """
  const r = prompt describe("today")
  const b = prompt describe_block("now")
  return "${r}|${b}"
}
EOF

prompt_out="$(JAIPH_AGENT_BACKEND=cursor JAIPH_AGENT_COMMAND="${AGENT}" \
  e2e::run "nested_prompt_tpl.jh")"
# assert_contains: the agent-command tree line is path-normalized and the
# transported body may still carry source quotes, so full-tree equality is
# not feasible here.
e2e::assert_contains "${prompt_out}" "Tell Ada about today" \
  "nested prompt interpolates enclosing const and own param"
e2e::assert_contains "${prompt_out}" "Block Ada now" \
  "nested triple-quoted prompt interpolates enclosing const and own param"

e2e::section "a const declared before its use interpolates at runtime"

e2e::file "seq_ok.jh" <<'EOF'
export def main() {
  const later = "ok"
  log "${later}"
}
EOF

seq_out="$(e2e::run "seq_ok.jh")"
e2e::expect_stdout "${seq_out}" <<'EOF'

Jaiph: Running seq_ok.jh

def main
  ℹ ok

✓ PASS def main (<time>)
EOF

e2e::section "using a const before its declaration is E_VALIDATE (interpolation)"

e2e::file "seq_interp.jh" <<'EOF'
export def main() {
  log "${later}"
  const later = "ok"
}
EOF

seq_interp_out=""
if seq_interp_out="$(e2e::run "seq_interp.jh" 2>&1)"; then
  e2e::fail "sequential const: interpolating a const before its declaration must be rejected"
fi
e2e::assert_contains "${seq_interp_out}" "E_VALIDATE" "sequential const: interpolation rejected with E_VALIDATE"
e2e::assert_contains "${seq_interp_out}" 'unknown identifier "later"' \
  "sequential const: interpolation names the not-yet-declared const"

e2e::section "using a const before its declaration is E_VALIDATE (bare call argument)"

e2e::file "seq_arg.jh" <<'EOF'
export def main() {
  run consumer(later)
  const later = "ok"
}
def consumer(v) {
  return "${v}"
}
EOF

seq_arg_out=""
if seq_arg_out="$(e2e::run "seq_arg.jh" 2>&1)"; then
  e2e::fail "sequential const: a bare arg naming a const before its declaration must be rejected"
fi
e2e::assert_contains "${seq_arg_out}" "E_VALIDATE" "sequential const: bare arg rejected with E_VALIDATE"
e2e::assert_contains "${seq_arg_out}" 'unknown identifier "later"' \
  "sequential const: bare arg names the not-yet-declared const"

e2e::section "a nested def body referencing a later enclosing const is E_VALIDATE"

e2e::file "seq_nested.jh" <<'EOF'
export def main() {
  def helper() {
    return "${later}"
  }
  const x = run helper()
  const later = "hi"
  return x
}
EOF

seq_nested_out=""
if seq_nested_out="$(e2e::run "seq_nested.jh" 2>&1)"; then
  e2e::fail "sequential const: a nested def closing over a later const must be rejected"
fi
e2e::assert_contains "${seq_nested_out}" "E_VALIDATE" "sequential const: nested-def forward const rejected with E_VALIDATE"
e2e::assert_contains "${seq_nested_out}" 'unknown identifier "later"' \
  "sequential const: nested-def message names the forward const"

e2e::section "in-branch nested decls are block-scoped to the declaring body"

# A nested script declared inside the taken `if` body runs and its return is the
# def result; the return-value artifact is compared in full.
e2e::file "branch_if.jh" <<'EOF'
export def main(flag) {
  if flag == "y" {
    script s = `printf YES`
    return run s()
  }
  return "none"
}
EOF

e2e::run "branch_if.jh" y >/dev/null
e2e::expect_run_file "branch_if.jh" "return_value.txt" "YES"

# The taken `else` body runs its own nested script.
e2e::file "branch_else.jh" <<'EOF'
export def main(flag) {
  if flag == "y" {
    script s = `printf YES`
    return run s()
  } else {
    script t = `printf NO`
    return run t()
  }
}
EOF

e2e::run "branch_else.jh" n >/dev/null
e2e::expect_run_file "branch_else.jh" "return_value.txt" "NO"

# A name declared only inside a branch is out of scope after it: E_VALIDATE.
# assert_contains: the diagnostic embeds an absolute path + line:col that vary.
e2e::file "branch_miss.jh" <<'EOF'
export def main(flag) {
  if flag == "y" {
    script s = `echo YES`
  }
  return run s()
}
EOF

branch_miss_out=""
if branch_miss_out="$(e2e::run "branch_miss.jh" y 2>&1)"; then
  e2e::fail "in-branch: a name declared only inside a branch must be rejected after it"
fi
e2e::assert_contains "${branch_miss_out}" "E_VALIDATE" "in-branch: post-branch use rejected with E_VALIDATE"
e2e::assert_contains "${branch_miss_out}" 'unknown local def or script reference "s"' \
  "in-branch: message names the out-of-scope local"

# A branch that shadows the module `s` does not leak: after the `if`, the module
# `s` runs again.
e2e::file "branch_shadow.jh" <<'EOF'
script s = `printf OUTER`
export def main(flag) {
  if flag == "y" {
    script s = `printf INNER`
    const inner = run s()
    log "inner=${inner}"
  }
  return run s()
}
EOF

e2e::run "branch_shadow.jh" y >/dev/null
e2e::expect_run_file "branch_shadow.jh" "return_value.txt" "OUTER"

e2e::pass "nested declaration closure, shadowing, argv, use pre-flight, isolation, export, string templates, sequential const visibility, and in-branch block scoping hold"
