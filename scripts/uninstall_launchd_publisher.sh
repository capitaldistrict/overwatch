#!/usr/bin/env bash
set -euo pipefail

LABEL="${OVERWATCH_PUBLISH_LABEL:-com.overwatch.publish_snapshot}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
launchctl remove "$LABEL" >/dev/null 2>&1 || true

if [ -f "$PLIST" ]; then
  rm "$PLIST"
fi

printf 'Uninstalled %s\n' "$LABEL"
