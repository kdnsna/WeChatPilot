#!/bin/bash
set -euo pipefail

PROJECT_ROOT="/Users/kdnsna/Documents/微信 chat"
SOURCE_PLIST="${PROJECT_ROOT}/launchd/com.kdnsna.daily-tech-digest.plist"
TARGET_PLIST="/Users/kdnsna/Library/LaunchAgents/com.kdnsna.daily-tech-digest.plist"
NODE22="/opt/homebrew/opt/node@22/bin/node"
NPM_CLI="/opt/homebrew/opt/node@22/lib/node_modules/npm/bin/npm-cli.js"

if [[ "$#" -ne 1 || "$1" != "--confirm-load" ]]; then
  /bin/echo "未加载：请在完成手动验收后显式传入 --confirm-load。" >&2
  exit 2
fi

/usr/bin/plutil -lint "${SOURCE_PLIST}"
cd "${PROJECT_ROOT}"
"${NODE22}" "${NPM_CLI}" run build
/usr/bin/install -d -m 700 "/Users/kdnsna/Library/LaunchAgents"
/usr/bin/install -d -m 700 "${PROJECT_ROOT}/logs"
/usr/bin/install -m 600 "${SOURCE_PLIST}" "${TARGET_PLIST}"

CURRENT_USER_ID="$(/usr/bin/id -u)"
/bin/launchctl bootstrap "gui/${CURRENT_USER_ID}" "${TARGET_PLIST}"
/bin/echo "LaunchAgent 已加载：com.kdnsna.daily-tech-digest"
