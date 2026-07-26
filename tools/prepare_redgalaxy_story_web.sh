#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SRC_WEB="$PROJECT_DIR/artifacts/redgalaxy-native-web"
DST_WEB="$PROJECT_DIR/artifacts/redgalaxy-story-web"
STORY_DIR="$SCRIPT_DIR/story"
PATCHER="$SCRIPT_DIR/apply_bastion_patches.py"

[[ -f "$SRC_WEB/index.html" ]] || {
  echo "Missing source web assets: $SRC_WEB/index.html" >&2
  echo "Run native-web extraction first (redgalaxy-mac-runner update-native or serve-web)." >&2
  exit 1
}

[[ -f "$PATCHER" ]] || {
  echo "Missing Bastion patcher: $PATCHER" >&2
  exit 1
}

python3 "$PATCHER" --game-src "$SRC_WEB" --story-src "$STORY_DIR" --out "$DST_WEB"
echo "Prepared story web root: $DST_WEB"
