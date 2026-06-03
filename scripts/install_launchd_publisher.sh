#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${OVERWATCH_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ROOT="${PROPDATA_ROOT:-$(cd "$REPO/.." && pwd)}"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3)}"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"
GIT_BIN="${GIT_BIN:-$(command -v git)}"
PUBLISHER="$REPO/scripts/publish_snapshot.py"
LABEL="${OVERWATCH_PUBLISH_LABEL:-com.overwatch.publish_snapshot}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL="${1:-300}"
DOMAIN="gui/$(id -u)"
LOG_DIR="$ROOT/adsb_data/logs"

usage() {
  printf 'Usage: %s [60|90|300|seconds]\n' "$0"
}

case "$INTERVAL" in
  ''|*[!0-9]*)
    usage >&2
    exit 2
    ;;
esac

if [ "$INTERVAL" -lt 60 ]; then
  printf 'Publish interval must be at least 60 seconds.\n' >&2
  exit 2
fi

if [ ! -f "$PUBLISHER" ]; then
  printf 'Publisher script was not found: %s\n' "$PUBLISHER" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
launchctl remove "$LABEL" >/dev/null 2>&1 || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON_BIN</string>
    <string>$PUBLISHER</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PROPDATA_ROOT</key>
    <string>$ROOT</string>
    <key>OVERWATCH_REPO</key>
    <string>$REPO</string>
    <key>PYTHON_BIN</key>
    <string>$PYTHON_BIN</string>
    <key>NPM_BIN</key>
    <string>$NPM_BIN</string>
    <key>GIT_BIN</key>
    <string>$GIT_BIN</string>
  </dict>
  <key>StartInterval</key>
  <integer>$INTERVAL</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/overwatch_publisher.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/overwatch_publisher.launchd.err.log</string>
</dict>
</plist>
EOF

launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

printf 'Installed %s at %s seconds.\n' "$LABEL" "$INTERVAL"
printf 'plist: %s\n' "$PLIST"
printf 'logs: %s/overwatch_publisher.launchd.log\n' "$LOG_DIR"
