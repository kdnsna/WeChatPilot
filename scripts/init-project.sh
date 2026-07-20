#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && /bin/pwd -P)"
NODE22="/opt/homebrew/opt/node@22/bin/node"
NPM22="/opt/homebrew/opt/node@22/lib/node_modules/npm/bin/npm-cli.js"

export PATH="/opt/homebrew/opt/node@22/bin:/usr/bin:/bin"
cd "${PROJECT_ROOT}"

"${NODE22}" "${NPM22}" ci
"${NODE22}" "${NPM22}" --prefix "${PROJECT_ROOT}/vendor/cli-in-wechat" ci
"${NODE22}" "${NPM22}" run vendor:build
"${NODE22}" "${NPM22}" run test
"${NODE22}" "${NPM22}" run typecheck
"${NODE22}" "${NPM22}" run build

/bin/echo "项目依赖、vendor、测试与构建已完成（Node ${NODE22}）。"
