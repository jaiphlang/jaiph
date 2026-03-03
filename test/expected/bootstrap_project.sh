set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/jaiph_stdlib.sh"

bootstrap_project::workflow::nodejs::impl() {
  echo "Sorry, I cannot setup nodejs yet"
  exit 1
}

bootstrap_project::workflow::nodejs() {
  jaiph__run_step bootstrap_project::workflow::nodejs bootstrap_project::workflow::nodejs::impl "$@"
}
