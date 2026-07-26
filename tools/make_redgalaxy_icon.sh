#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SOURCE_PNG="${1:-$PROJECT_DIR/artifacts/redgalaxy-native-web/redgalaxy.png}"
ICONSET_DIR="${2:-$PROJECT_DIR/dist/build/RedGalaxy.iconset}"
OUTPUT_ICNS="${3:-$PROJECT_DIR/dist/build/RedGalaxy.icns}"

[[ -f "$SOURCE_PNG" ]] || {
  echo "Missing logo PNG: $SOURCE_PNG" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need sips
need iconutil

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR" "$(dirname "$OUTPUT_ICNS")"

make_icon() {
  local size="$1"
  local name="$2"
  sips -z "$size" "$size" "$SOURCE_PNG" --out "$ICONSET_DIR/$name" >/dev/null
}

make_icon 16 icon_16x16.png
cp "$ICONSET_DIR/icon_16x16.png" "$ICONSET_DIR/icon_16x16@2x.png"
sips -z 32 32 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null

make_icon 32 icon_32x32.png
cp "$ICONSET_DIR/icon_32x32.png" "$ICONSET_DIR/icon_32x32@2x.png"
sips -z 64 64 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null

make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
sips -z 1024 1024 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_ICNS"
echo "Created icon: $OUTPUT_ICNS"
