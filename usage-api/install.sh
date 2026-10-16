#!/bin/bash
# 把本机 AI 用量 API 装成登录后自动运行的后台服务（launchd），并显示专属密钥；
# 另装一个每 1 小时把工作台发布到公开网站（GitHub Pages）的定时任务。
# 卸载：bash install.sh --uninstall
set -euo pipefail
LABEL=com.claude-quota-ring.usage-api
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PUB_LABEL=com.claude-quota-ring.publish
PUB_PLIST="$HOME/Library/LaunchAgents/$PUB_LABEL.plist"
SERVER="$(cd "$(dirname "$0")" && pwd)/server.py"
PUBLISH="$(cd "$(dirname "$0")" && pwd)/publish.py"
PY="$(command -v python3)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/$PUB_LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$PUB_PLIST"
  echo "已卸载（用量数据仍保留在 ~/Library/Application Support/ai-usage/）"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$SERVER</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ai-usage-api.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
curl -fsS http://127.0.0.1:8787/health >/dev/null && echo "已启动：http://127.0.0.1:8787/ （工作台）"

cat > "$PUB_PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$PUB_LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$PUBLISH</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ai-usage-publish.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ai-usage-publish.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$PUB_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PUB_PLIST"
echo "公开网站每 1 小时更新：https://wzp42406-eng.github.io/ai-workbench/"
echo "专属密钥：$("$PY" "$SERVER" --key)"
