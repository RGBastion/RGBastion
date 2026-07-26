#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SOURCE_PNG="${1:-$PROJECT_DIR/artifacts/redgalaxy-native-web/redgalaxy.png}"
OUTPUT_PNG="${2:-$PROJECT_DIR/dist/build/dmg-background.png}"

[[ -f "$SOURCE_PNG" ]] || {
  echo "Missing logo PNG: $SOURCE_PNG" >&2
  exit 1
}

command -v sips >/dev/null 2>&1 || {
  echo "Missing required command: sips" >&2
  exit 1
}

mkdir -p "$(dirname "$OUTPUT_PNG")"
cp "$SOURCE_PNG" "$OUTPUT_PNG"
sips -z 400 660 "$OUTPUT_PNG" >/dev/null
echo "Created DMG background: $OUTPUT_PNG"
