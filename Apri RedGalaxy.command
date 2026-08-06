#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
BASTION_PATH="$PROJECT_DIR/dist/RedGalaxy Bastion.app"
NATIVE_PATH="$PROJECT_DIR/dist/RedGalaxy Native.app"

bastion_host_ok() {
  local app="$1"
  [[ -d "$app" ]] || return 1
  [[ -x "$app/Contents/MacOS/redgalaxy-bastion-host" ]] && return 0
  [[ -x "$app/Contents/MacOS/redgalaxy-native-host" ]] && return 0
  return 1
}

if bastion_host_ok "$BASTION_PATH"; then
  open "$BASTION_PATH"
  exit 0
fi

if [[ -d "$NATIVE_PATH" ]]; then
  open "$NATIVE_PATH"
  exit 0
fi

echo "RedGalaxy Bastion.app non trovato in dist/. Costruisci con: BASTION_BRAND=redgalaxy ./tools/build_redgalaxy_story_dmg.sh" >&2
exit 1
