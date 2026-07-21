#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && /bin/pwd -P)"
NODE_EXECUTABLE="${NODE_EXECUTABLE:-$(command -v node)}"
NPM_EXECUTABLE="${NPM_EXECUTABLE:-$(command -v npm)}"
cd "${PROJECT_ROOT}"

"${NPM_EXECUTABLE}" ci
"${NPM_EXECUTABLE}" run test
"${NPM_EXECUTABLE}" run typecheck
"${NPM_EXECUTABLE}" run build

/bin/echo "贡献者依赖、测试与构建已完成（Node ${NODE_EXECUTABLE}）。"
