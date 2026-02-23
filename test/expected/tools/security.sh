set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../jaiph_stdlib.sh"

tools__security__rule_scan_passes__impl() {
  echo "Security scan placeholder here"
}

tools__security__rule_scan_passes() {
  jaiph__run_step tools__security__rule_scan_passes jaiph__execute_readonly tools__security__rule_scan_passes__impl
}