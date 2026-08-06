#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
APP_PATH="$PROJECT_DIR/dist/RedUniverse.app"
BASTION_PATH="$PROJECT_DIR/dist/RedUniverse Bastion.app"

host_ok() {
  local app="$1"
  [[ -d "$app" ]] || return 1
  [[ -x "$app/Contents/MacOS/reduniverse-bastion-host" ]] && return 0
  [[ -x "$app/Contents/MacOS/redgalaxy-native-host" ]] && return 0
  return 1
}

if host_ok "$APP_PATH"; then
  open "$APP_PATH"
  exit 0
fi

if host_ok "$BASTION_PATH"; then
  open "$BASTION_PATH"
  exit 0
fi

exec "$PROJECT_DIR/bin/redgalaxy-mac-runner" native-web-foreground
