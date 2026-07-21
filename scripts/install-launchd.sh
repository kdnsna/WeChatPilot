#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && /bin/pwd -P)"
NODE_EXECUTABLE="${NODE_EXECUTABLE:-$(command -v node)}"

if [[ "$#" -ne 1 || "$1" != "--confirm-load" ]]; then
  /bin/echo "未加载：请在完成手动验收后显式传入 --confirm-load。" >&2
  exit 2
fi

cd "${PROJECT_ROOT}"
exec "${NODE_EXECUTABLE}" --import tsx src/cli/wechatpilot.ts schedule install --project-root "${PROJECT_ROOT}"
