#!/usr/bin/env bash
set -euo pipefail

ROOT="${PROPDATA_ROOT:-/path/to/parent-workspace}"
REPO="${OVERWATCH_REPO:-$ROOT/overwatch}"
SOURCE="${ADSB_SOURCE:-$ROOT/adsb_receiver_json/aircraft.json}"
OUTPUT_DIR="${ADSB_OUTPUT_DIR:-$ROOT/adsb_data}"
VIEWER_ADSB_DIR="${OVERWATCH_ADSB_DIR:-$REPO/public/adsb}"
LIVE_HISTORY_MINUTES="${LIVE_HISTORY_MINUTES:-120}"
BASE_PATH_VALUE="${BASE_PATH:-/overwatch/}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
NPM_BIN="${NPM_BIN:-npm}"
GIT_BIN="${GIT_BIN:-/usr/bin/git}"
LOG_DIR="$OUTPUT_DIR/logs"
LOCK_DIR="${OVERWATCH_PUBLISH_LOCK:-/tmp/overwatch-publish.lock}"

usage() {
  printf 'Usage: %s [--dry-run]\n' "$0"
}

DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

mkdir -p "$LOG_DIR" "$VIEWER_ADSB_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  printf '[overwatch-publish] another publish is already running; exiting\n'
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

if [ ! -f "$SOURCE" ]; then
  printf '[overwatch-publish] ADS-B source not found: %s\n' "$SOURCE" >&2
  exit 1
fi

if [ ! -d "$REPO/.git" ]; then
  printf '[overwatch-publish] not a git repo: %s\n' "$REPO" >&2
  exit 1
fi

printf '[overwatch-publish] collecting ADS-B snapshot from %s\n' "$SOURCE"
cd "$ROOT"
"$PYTHON_BIN" adsb_collector.py \
  --source "$SOURCE" \
  --output-dir "$OUTPUT_DIR" \
  --once \
  --viewer-public-dir "$VIEWER_ADSB_DIR" \
  --live-history-minutes "$LIVE_HISTORY_MINUTES"

printf '[overwatch-publish] building GitHub Pages docs with BASE_PATH=%s\n' "$BASE_PATH_VALUE"
cd "$REPO"
BASE_PATH="$BASE_PATH_VALUE" "$NPM_BIN" run build

"$GIT_BIN" add public/adsb docs
if "$GIT_BIN" diff --cached --quiet -- public/adsb docs; then
  printf '[overwatch-publish] no snapshot changes to publish\n'
  exit 0
fi

commit_message="Update ADS-B snapshot $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '[overwatch-publish] dry run; staged changes are ready but not committed\n'
  "$GIT_BIN" status --short
  exit 0
fi

"$GIT_BIN" commit -m "$commit_message" -- public/adsb docs
"$GIT_BIN" push origin main
printf '[overwatch-publish] pushed snapshot commit\n'
