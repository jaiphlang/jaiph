set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/jaiph_stdlib.sh"

bootstrap_project__workflow_nodejs__impl() {
  echo "Sorry, I cannot setup nodejs yet"
  exit 1
}

bootstrap_project__workflow_nodejs() {
  jaiph__run_step bootstrap_project__workflow_nodejs bootstrap_project__workflow_nodejs__impl "$@"
}