#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
APP_PATH="$PROJECT_DIR/dist/RedGalaxy Native.app"

if [[ -d "$APP_PATH" ]]; then
  if [[ -x "$APP_PATH/Contents/MacOS/redgalaxy-native-host" ]]; then
    open "$APP_PATH"
    exit 0
  fi
fi

exec "$PROJECT_DIR/bin/redgalaxy-mac-runner" serve-web-foreground
