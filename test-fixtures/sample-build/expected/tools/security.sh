set -euo pipefail
export JAIPH_SCRIPTS="${JAIPH_SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)}"

tools::security::scan_passes::impl() {
  echo "Security scan placeholder here"
}

tools::security::scan_passes() {
  jaiph::run_step tools::security::scan_passes rule jaiph::execute_readonly tools::security::scan_passes::impl
}
