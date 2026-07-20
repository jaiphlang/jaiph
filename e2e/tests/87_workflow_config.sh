#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "workflow_config"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
# Section 1: Scoping — workflow A's config is NOT visible to workflow B
# ---------------------------------------------------------------------------
e2e::section "workflow config scoping: setting in A is not visible in B"

SCOPE_LOG="${TEST_DIR}/scope.log"
export JAIPH_SCOPE_LOG="${SCOPE_LOG}"

e2e::file "scope_test.jh" <<'EOF'
config {
  agent.backend = "cursor"
}

script log_scope_backend = `printf '%s:%s\n' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_SCOPE_LOG"`

workflow first() {
  config {
    agent.backend = "claude"
  }
  run log_scope_backend("first")
}

workflow second() {
  run log_scope_backend("second")
}

workflow default() {
  run first()
  run second()
}
EOF

unset JAIPH_AGENT_BACKEND 2>/dev/null || true
jaiph run "${TEST_DIR}/scope_test.jh" >/dev/null

actual="$(cat "${SCOPE_LOG}")"
expected="$(printf '%s\n' 'first:claude' 'second:cursor')"
e2e::assert_equals "${actual}" "${expected}" \
  "workflow first sees claude; workflow second sees cursor (module default)"

# ---------------------------------------------------------------------------
# Section 2: Overriding — workflow config overrides module config
# ---------------------------------------------------------------------------
e2e::section "workflow config overrides module config"

OVERRIDE_LOG="${TEST_DIR}/override.log"
export JAIPH_OVERRIDE_LOG="${OVERRIDE_LOG}"

e2e::file "override_test.jh" <<'EOF'
config {
  agent.model = "module-model"
  agent.backend = "cursor"
}

script log_rule_config = ```
printf 'rule_model:%s\n' "$JAIPH_AGENT_MODEL" >> "$JAIPH_OVERRIDE_LOG"
printf 'rule_backend:%s\n' "$JAIPH_AGENT_BACKEND" >> "$JAIPH_OVERRIDE_LOG"
```

rule check_config() {
  run log_rule_config()
}

workflow with_override() {
  config {
    agent.model = "workflow-model"
  }
  ensure check_config()
}

workflow without_override() {
  ensure check_config()
}

workflow default() {
  run with_override()
  run without_override()
}
EOF

unset JAIPH_AGENT_MODEL 2>/dev/null || true
unset JAIPH_AGENT_BACKEND 2>/dev/null || true
jaiph run "${TEST_DIR}/override_test.jh" >/dev/null

actual="$(cat "${OVERRIDE_LOG}")"
expected="$(printf '%s\n' \
  'rule_model:' \
  'rule_backend:cursor' \
  'rule_model:' \
  'rule_backend:cursor')"
e2e::assert_equals "${actual}" "${expected}" \
  "config agent.model does not set JAIPH_AGENT_MODEL for rules/scripts; backend still scoped via env"

# ---------------------------------------------------------------------------
# Section 3: Interaction — nested cross-module run applies callee module
# config and restores caller scope after
# ---------------------------------------------------------------------------
e2e::section "cross-module run applies callee module config; caller scope restored"

NESTED_LOG="${TEST_DIR}/nested.log"
export JAIPH_NESTED_LOG="${NESTED_LOG}"

e2e::file "child_module.jh" <<'EOF'
config {
  agent.backend = "cursor"
}

script log_nested_backend = `printf '%s:%s\n' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_NESTED_LOG"`

workflow default() {
  run log_nested_backend("child_backend")
}
EOF

e2e::file "parent_nested.jh" <<'EOF'
import "child_module.jh" as child

config {
  agent.backend = "cursor"
}

script log_nested_backend = `printf '%s:%s\n' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_NESTED_LOG"`

workflow caller() {
  config {
    agent.backend = "claude"
  }
  run log_nested_backend("parent_before")
  run child.default()
  run log_nested_backend("parent_after")
}

workflow default() {
  run caller()
}
EOF

unset JAIPH_AGENT_BACKEND 2>/dev/null || true
jaiph run "${TEST_DIR}/parent_nested.jh" >/dev/null

actual="$(cat "${NESTED_LOG}")"
expected="$(printf '%s\n' \
  'parent_before:claude' \
  'child_backend:claude' \
  'parent_after:claude')"
e2e::assert_equals "${actual}" "${expected}" \
  "imported module cannot override agent.backend; child inherits caller env; caller scope restored after"

# ---------------------------------------------------------------------------
# Section 4: Env variable still wins over workflow config
# ---------------------------------------------------------------------------
e2e::section "env variable overrides workflow config"

ENV_LOG="${TEST_DIR}/env.log"
export JAIPH_ENV_LOG="${ENV_LOG}"

e2e::file "env_wins.jh" <<'EOF'
script log_env_backend = `printf 'backend:%s\n' "$JAIPH_AGENT_BACKEND" >> "$JAIPH_ENV_LOG"`

workflow default() {
  config {
    agent.backend = "claude"
  }
  run log_env_backend()
}
EOF

export JAIPH_AGENT_BACKEND="cursor"
jaiph run "${TEST_DIR}/env_wins.jh" >/dev/null
unset JAIPH_AGENT_BACKEND

actual="$(cat "${ENV_LOG}")"
e2e::assert_equals "${actual}" "backend:cursor" \
  "env variable wins over workflow config (_LOCKED behavior preserved)"

# ---------------------------------------------------------------------------
# Section 5: Sibling isolation — both siblings have explicit different metadata
# ---------------------------------------------------------------------------
e2e::section "sibling workflows with different metadata do not bleed"

SIBLING_LOG="${TEST_DIR}/sibling.log"
export JAIPH_SIBLING_LOG="${SIBLING_LOG}"

e2e::file "sibling_isolation.jh" <<'EOF'
config {
  agent.model = "module-model"
  agent.backend = "cursor"
}

script log_sibling_env = `printf '%s:model=%s,backend=%s\n' "$1" "$JAIPH_AGENT_MODEL" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_SIBLING_LOG"`

workflow alpha() {
  config {
    agent.model = "alpha-model"
    agent.backend = "claude"
  }
  run log_sibling_env("alpha")
}

workflow beta() {
  config {
    agent.model = "beta-model"
  }
  run log_sibling_env("beta")
}

workflow default() {
  run alpha()
  run beta()
}
EOF

unset JAIPH_AGENT_MODEL 2>/dev/null || true
unset JAIPH_AGENT_BACKEND 2>/dev/null || true
jaiph run "${TEST_DIR}/sibling_isolation.jh" >/dev/null

actual="$(cat "${SIBLING_LOG}")"
expected="$(printf '%s\n' 'alpha:model=,backend=claude' 'beta:model=,backend=cursor')"
e2e::assert_equals "${actual}" "${expected}" \
  "alpha sees its own backend; beta sees module default backend; config model stays out of JAIPH_AGENT_MODEL"

# ---------------------------------------------------------------------------
# Section 6: Workflow config interpolation from workflow parameters
# ---------------------------------------------------------------------------
e2e::section "workflow config model stays prompt-scoped (not JAIPH_AGENT_MODEL env)"

PARAM_LOG="${TEST_DIR}/param.log"
export JAIPH_PARAM_LOG="${PARAM_LOG}"

e2e::file "param_config.jh" <<'EOF'
script log_model = `printf 'model:%s\n' "$JAIPH_AGENT_MODEL" >> "$JAIPH_PARAM_LOG"`

workflow implement(model) {
  config {
    agent.model = model
  }
  run log_model()
}

workflow default() {
  run implement("param-model")
}
EOF

unset JAIPH_AGENT_MODEL 2>/dev/null || true
jaiph run "${TEST_DIR}/param_config.jh" >/dev/null

actual="$(cat "${PARAM_LOG}")"
e2e::assert_equals "${actual}" "model:" \
  "workflow config agent.model does not populate JAIPH_AGENT_MODEL for scripts"
