#!/usr/bin/env bash
set -euo pipefail

ROOT="${PROPDATA_ROOT:-/path/to/parent-workspace}"
REPO="${OVERWATCH_REPO:-$ROOT/overwatch}"
SCRIPT="$REPO/scripts/publish_snapshot.sh"
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

if [ ! -x "$SCRIPT" ]; then
  printf 'Publisher script is not executable: %s\n' "$SCRIPT" >&2
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
    <string>/bin/bash</string>
    <string>$SCRIPT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO</string>
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
