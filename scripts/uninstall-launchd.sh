#!/bin/bash
set -euo pipefail

TARGET_PLIST="/Users/kdnsna/Library/LaunchAgents/com.kdnsna.daily-tech-digest.plist"
CURRENT_USER_ID="$(/usr/bin/id -u)"

if [[ -e "${TARGET_PLIST}" ]]; then
  /bin/launchctl bootout "gui/${CURRENT_USER_ID}" "${TARGET_PLIST}" 2>/dev/null || true
  /bin/rm -f -- "${TARGET_PLIST}"
fi

/bin/echo "LaunchAgent 已卸载；项目、日报、日志和微信登录状态均未删除。"
