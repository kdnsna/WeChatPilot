#!/bin/bash
set -euo pipefail

PROJECT_ROOT="/Users/kdnsna/Documents/微信 chat"
NODE22="/opt/homebrew/opt/node@22/bin/node"

cd "${PROJECT_ROOT}"
exec "${NODE22}" "${PROJECT_ROOT}/dist/src/cli/observer.js" \
  --project-root "${PROJECT_ROOT}" \
  --job "daily-tech-digest"
