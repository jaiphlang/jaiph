# Runtime: read-only sandbox execution (unshare fallback and Linux mount namespace).
# Sourced by jaiph_stdlib.sh. Depends on core (jaiph__die) and prompt (jaiph::prompt).

jaiph::execute_readonly() {
  local func_name="$1"
  shift || true
  if [[ -z "$func_name" ]]; then
    jaiph__die "jaiph::execute_readonly requires a function name"
    return 1
  fi
  if ! declare -f "$func_name" >/dev/null 2>&1; then
    jaiph__die "unknown function: $func_name"
    return 1
  fi
  # Rules execute in child shells for readonly isolation.
  # Export all functions so rule bodies can call local helpers/shims.
  local exported_fn
  while IFS= read -r exported_fn; do
    export -f "$exported_fn" >/dev/null 2>&1 || true
  done < <(compgen -A function)
  export -f "$func_name"
  export -f jaiph__die
  export -f jaiph::prompt
  if ! command -v unshare >/dev/null 2>&1 || ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1 || ! unshare -m true >/dev/null 2>&1; then
    # Best-effort fallback for environments without Linux mount namespace tooling (e.g. macOS).
    # Execute in a child shell so "exit" inside a rule does not terminate the parent runner.
    bash -c '
      func_name="$1"
      shift || true
      "$func_name" "$@"
    ' _ "$func_name" "$@"
    return $?
  fi
  sudo env JAIPH_PRECEDING_FILES="$JAIPH_PRECEDING_FILES" JAIPH_EMIT_JS="$JAIPH_EMIT_JS" unshare -m bash -c '
    mount --make-rprivate /
    mount -o remount,ro /
    func_name="$1"
    shift || true
    "$func_name" "$@"
  ' _ "$func_name" "$@"
}
