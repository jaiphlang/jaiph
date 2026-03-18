set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../jaiph_stdlib.sh"

tools::security::scan_passes::impl() {
  echo "Security scan placeholder here"
}

tools::security::scan_passes() {
  jaiph::run_step tools::security::scan_passes rule jaiph::execute_readonly tools::security::scan_passes::impl
}
