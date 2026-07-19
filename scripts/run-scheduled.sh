#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && /bin/pwd -P)"
NODE22="/opt/homebrew/opt/node@22/bin/node"

cd "${PROJECT_ROOT}"
exec "${NODE22}" "${PROJECT_ROOT}/dist/src/cli/observer.js" \
  --project-root "${PROJECT_ROOT}" \
  --job "daily-tech-digest"
