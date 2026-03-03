set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../jaiph_stdlib.sh"

tools::security::rule::scan_passes::impl() {
  echo "Security scan placeholder here"
}

tools::security::rule::scan_passes() {
  jaiph__run_step tools::security::rule::scan_passes jaiph__execute_readonly tools::security::rule::scan_passes::impl
}
